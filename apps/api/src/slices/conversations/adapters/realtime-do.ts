import { z } from 'zod';
import { ERROR_CODES } from '@hushbox/shared';
import { unavailableError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import type { BroadcastReceipt, RealtimeEvent, RunStartBody } from '@hushbox/realtime';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RealtimeBroadcast, RunStartOutcome } from '../ports/realtime.js';

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

const concurrentRunResponseSchema = z.object({
  code: z.literal(ERROR_CODES.CONCURRENT_RUN),
});

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

export function createRealtimeBroadcast(namespace: DurableObjectNamespace): RealtimeBroadcast {
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
          return parseBody(response, concurrentRunResponseSchema).map(
            (body): RunStartOutcome => ({ started: false, code: body.code })
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
  };
}
