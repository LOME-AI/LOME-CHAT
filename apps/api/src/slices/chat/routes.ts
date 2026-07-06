import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  CHAT_TURN_INPUT,
  buildTurnDefinition,
  callerUserId,
  createErrorResponse,
  hashCanonicalJson,
  readIdempotencyKey,
  resolveTurnContext,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { RunStartBody } from '@hushbox/realtime';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { ChatRouteDeps, DomainError, DomainErrorCode } from './domain/index.js';

const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

export const startTurnBodySchema = z.object({
  conversationId: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().min(1),
});

export const stopTurnBodySchema = z.object({
  conversationId: z.string().min(1),
});

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/**
 * The pipeline enforced the header before the handler ran (the chat turn is a
 * `run`-kind mutation whose referee is the conversation DO, so the route
 * requires the key and forwards it as the run key rather than claiming
 * itself). Absence here is a composition defect.
 */
function requiredRunKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  /* v8 ignore next 3 -- the idempotency-key middleware enforces the key on this mutating route before the handler runs; this guard is a defect-only invariant */
  if (key === undefined) {
    throw new Error('chat: idempotency key missing after the pipeline stage');
  }
  return key;
}

/**
 * The chat turn's HTTP surface. The route resolves the run identity (paying
 * wallet, current epoch), compiles the single-model turn, and hands the run to
 * the conversation DO — the DO owns the referee claim, deadline, streaming, and
 * settlement. No business logic settles here; the handler only composes.
 *
 * The return type is deliberately inferred so the route schema flows into
 * `AppType` (annotating `Hono<AppEnv>` erases it to `BlankSchema`).
 */
export function createChatManifest(deps: ChatRouteDeps) {
  return defineSliceManifest({
    basePath: '/chat',
    routes: new Hono<AppEnv>()
      .post(
        '/',
        routeClass('session'),
        zValidator('json', startTurnBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const runKey = requiredRunKey(c);

          const context = await resolveTurnContext(
            { conversations: deps.conversations, billing: deps.billing },
            c.var.db,
            { conversationId: body.conversationId, userId }
          );
          if (context.isErr()) return respondDomainError(c, context.error);

          const definition = await buildTurnDefinition(
            { db: c.var.db, telemetry: c.var.logger },
            body.model
          );
          if (definition.isErr()) return respondDomainError(c, definition.error);

          const bodyHash = await hashCanonicalJson({
            conversationId: body.conversationId,
            model: body.model,
            prompt: body.prompt,
          });
          const runStartBody: RunStartBody = {
            mode: 'paid',
            runKey,
            bodyHash,
            definition: definition.value,
            inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: body.prompt } },
            userId,
            senderId: userId,
            walletId: context.value.walletId,
            epochNumber: context.value.epochNumber,
          };

          const started = await deps.realtime(c.env).startRun(body.conversationId, runStartBody);
          return started.match(
            (outcome) => {
              // A settled/duplicate key replays the persisted turn response (never
              // a transport error); a still-live run tells the client to rejoin
              // its stream over the socket; otherwise a fresh run handle or 409.
              if ('outcome' in outcome) {
                return outcome.outcome === 'replay'
                  ? c.json(outcome.response as Record<string, unknown>, 200)
                  : c.json({ outcome: 'attach' as const }, 200);
              }
              return outcome.started
                ? c.json({ runId: outcome.runId, deadlineAt: outcome.deadlineAt }, 201)
                : c.json(createErrorResponse(outcome.code), 409);
            },
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Explicit user stop. Plain HTTP by design — a WS-blocked user must still
      // be able to abort a paid run — and membership-gated so no one can stop
      // another conversation's run. The DO settles and bills the partial; a
      // repeat is a no-op (`stopped:false` once the run is gone).
      .post(
        '/stop',
        routeClass('session'),
        zValidator('json', stopTurnBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const member = await deps
            .conversations(c.var.db)
            .members.activeByUser(conversationId, userId);
          if (member.isErr()) return respondDomainError(c, member.error);
          if (member.value === null) {
            return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
          }
          const stopped = await deps.realtime(c.env).stopRun(conversationId);
          return stopped.match(
            (didStop) => c.json({ stopped: didStop }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
