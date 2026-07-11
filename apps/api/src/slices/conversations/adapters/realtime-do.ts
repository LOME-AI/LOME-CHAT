import { z } from 'zod';
import { errorCodeSchema } from '@hushbox/shared';
import { unavailableError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import type { BroadcastReceipt, RealtimeEvent, RunStartBody } from '@hushbox/realtime';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RealtimeBroadcast, RunStartOutcome, UpgradePrincipal } from '../ports/realtime.js';

/**
 * The minimal slice of the Cloudflare Durable Object namespace binding this
 * adapter uses — a named-instance lookup that returns a `fetch`-able stub.
 * Declared locally (the legacy `types.ts` pattern) so the type resolves in
 * DOM-lib consumers that type-check this source (the web typed client) without
 * dragging the full `@cloudflare/workers-types` ambient globals into them.
 */
export interface ConversationRoomNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/**
 * RealtimeBroadcast adapter: the typed client for the ConversationRoom DO's
 * HTTP surface (/broadcast, /evict, /presence, /run/start, /run/stop).
 * Responses are Zod-validated at this seam so contract drift surfaces as a
 * typed unavailable error, never a downstream shape mismatch. No retries:
 * broadcast fan-out is not idempotent at the frame level, and run-start
 * retry semantics belong to the idempotency-key referee, not the transport.
 */

const broadcastReceiptSchema = z.object({
  delivered: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  evicted: z.number().int().nonnegative(),
});

const evictResponseSchema = z.object({ closed: z.number().int().nonnegative() });

const presenceResponseSchema = z.object({ userIds: z.array(z.string()) });

const runStartedResponseSchema = z.object({
  runId: z.string().min(1),
  deadlineAt: z.number(),
});

// Every refusal class rides the same 409 body shape ({code}): the one-run
// block, the referee's reused-key-different-body conflict, and the synchronous
// admission refusals (INSUFFICIENT_ADMISSION, ADMISSION_UNAVAILABLE,
// TRIAL_CAPACITY_REACHED, ...). The registry schema gates the body (a
// non-registry code is contract drift -> unavailable); the chat route's status
// map assigns the HTTP status per code.
const runStartConflictSchema = z.object({
  code: errorCodeSchema,
});

// The DO answers a settled/duplicate key with 200: `replay` carries the stored
// turn response verbatim; `attach` signals a live run the client rejoins over
// the socket. Parsing these (rather than treating any non-201 as a transport
// failure) is what stops a settled re-POST from surfacing as a 503.
const runReplayOrAttachSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('replay'), response: z.unknown() }),
  z.object({ outcome: z.literal('attach') }),
]);

const runStopResponseSchema = z.object({ stopped: z.boolean() });

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseBody<T>(response: Response, schema: z.ZodType<T>): ResultAsync<T, DomainError> {
  return fromPromise(response.json(), (cause) =>
    unavailableError('conversation room returned a malformed body', cause)
  ).andThen((body) => {
    const parsed = schema.safeParse(body);
    return parsed.success
      ? okAsync(parsed.data)
      : errAsync(unavailableError('conversation room response failed validation', parsed.error));
  });
}

function expectOk<T>(schema: z.ZodType<T>): (response: Response) => ResultAsync<T, DomainError> {
  return (response) =>
    response.ok
      ? parseBody(response, schema)
      : errAsync(unavailableError(`conversation room answered status ${String(response.status)}`));
}

export function createRealtimeBroadcast(namespace: ConversationRoomNamespace): RealtimeBroadcast {
  function roomFetch(
    conversationId: string,
    path: string,
    init?: RequestInit
  ): ResultAsync<Response, DomainError> {
    const stub = namespace.get(namespace.idFromName(conversationId));
    return fromPromise(
      Promise.resolve(stub.fetch(`https://conversation-room${path}`, init)),
      (cause) => unavailableError('conversation room unreachable', cause)
    );
  }

  return {
    broadcast(
      conversationId: string,
      event: RealtimeEvent
    ): ResultAsync<BroadcastReceipt, DomainError> {
      return roomFetch(conversationId, '/broadcast', postJson(event)).andThen(
        expectOk(broadcastReceiptSchema)
      );
    },

    evict(conversationId: string, principalId: string): ResultAsync<number, DomainError> {
      return roomFetch(conversationId, '/evict', postJson({ principalId }))
        .andThen(expectOk(evictResponseSchema))
        .map((body) => body.closed);
    },

    presence(conversationId: string): ResultAsync<readonly string[], DomainError> {
      return roomFetch(conversationId, '/presence')
        .andThen(expectOk(presenceResponseSchema))
        .map((body) => body.userIds);
    },

    startRun(
      conversationId: string,
      request: RunStartBody
    ): ResultAsync<RunStartOutcome, DomainError> {
      return roomFetch(conversationId, '/run/start', postJson(request)).andThen((response) => {
        if (response.status === 409) {
          return parseBody(response, runStartConflictSchema).map(
            (body): RunStartOutcome => ({ started: false, code: body.code })
          );
        }
        if (response.status === 200) {
          return parseBody(response, runReplayOrAttachSchema).map(
            (body): RunStartOutcome =>
              body.outcome === 'replay'
                ? { outcome: 'replay', response: body.response }
                : { outcome: 'attach' }
          );
        }
        if (response.status !== 201) {
          return errAsync<RunStartOutcome, DomainError>(
            unavailableError(`conversation room answered status ${String(response.status)}`)
          );
        }
        return parseBody(response, runStartedResponseSchema).map(
          (receipt): RunStartOutcome => ({ started: true, ...receipt })
        );
      });
    },

    stopRun(conversationId: string): ResultAsync<boolean, DomainError> {
      return roomFetch(conversationId, '/run/stop', postJson({ reason: 'user-stop' }))
        .andThen(expectOk(runStopResponseSchema))
        .map((body) => body.stopped);
    },

    upgrade(
      conversationId: string,
      principal: UpgradePrincipal,
      headers: Headers
    ): ResultAsync<Response, DomainError> {
      const params = new URLSearchParams({
        principalId: principal.principalId,
        conversationId,
        isGuest: String(principal.isGuest),
      });
      if (principal.displayName !== undefined) {
        params.set('displayName', principal.displayName);
      }
      // The authorizing session snapshot (a real user only) rides the DO query
      // params so the broadcast-time session-liveness check can validate the
      // socket. Absent for guests and trial principals.
      if (principal.session !== undefined) {
        params.set('sessionId', principal.session.id);
        params.set('sessionCreatedAt', String(principal.session.createdAt));
      }
      // The DO's 101 (with the client-side socket) passes straight back through
      // roomFetch — the worker route returns it untouched so the socket reaches
      // the client. The forwarded headers carry the `Upgrade: websocket` the
      // runtime needs to complete the handshake.
      return roomFetch(conversationId, `/websocket?${params.toString()}`, {
        method: 'GET',
        headers,
      });
    },
  };
}
