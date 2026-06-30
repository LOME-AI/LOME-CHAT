import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  callerUserId,
  conversationIdParamSchema,
  createConversation,
  createConversationBodySchema,
  createConversationOutcomeSchema,
  createErrorResponse,
  deleteConversation,
  deleteConversationOutcomeSchema,
  evictPrincipals,
  getConversation,
  idempotent,
  isIdempotencyConflict,
  isRefusal,
  listConversations,
  listConversationsQuerySchema,
  readIdempotencyKey,
  refusalToWire,
  runMutation,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { z } from 'zod';
import type { Redis } from '@upstash/redis';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type {
  ConversationsStoresFactory,
  DomainError,
  DomainErrorCode,
  MembershipRevoker,
  Outcome,
  RealtimeBroadcast,
} from './domain/index.js';

export interface ConversationsRouteDeps {
  /** Bound per call site to the pipeline's `c.var.db` or a byKey transaction. */
  readonly stores: ConversationsStoresFactory;
  /** Membership-cache invalidation over the pipeline's `c.var.redis`. */
  readonly revoker: (redis: Redis) => MembershipRevoker;
  /** ConversationRoom DO client; a port double in tests (infra edge). */
  readonly realtime: (env: AppEnv['Bindings']) => RealtimeBroadcast;
}

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

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  if (isIdempotencyConflict(error)) {
    return c.json(createErrorResponse(error.wireCode), 409);
  }
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

/** Success payloads pass through; refusals answer their mapped wire error. */
function respondOutcome<S extends object>(
  c: Context<AppEnv>,
  outcome: Outcome<S>,
  respond: (success: S) => Response
): Response {
  if (isRefusal(outcome)) {
    const wire = refusalToWire(outcome);
    return c.json(createErrorResponse(wire.code, wire.details), wire.status);
  }
  return respond(outcome);
}

/**
 * zValidator hook: malformed input answers the uniform `{code}` body. The
 * context is typed with hono's base `Env` because the hook's `E` is not
 * inferred from the route chain — `AppEnv` here would fail contravariance.
 */
function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/** The pipeline enforced the header before the handler ran; absence is a defect. */
function requiredIdempotencyKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  if (key === undefined) {
    throw new Error('conversations: idempotency key missing after the pipeline stage');
  }
  return key;
}

interface ByKeyRoute<T> {
  readonly c: Context<AppEnv>;
  /** The validated request identity (body and/or params) for the body hash. */
  readonly body: unknown;
  readonly responseSchema: z.ZodType<T>;
  readonly execute: Parameters<typeof idempotent.byKey<T>>[0]['execute'];
}

/** One byKey envelope per mutating route: scope, body hash, claim, execute. */
function runByKey<T>(route: ByKeyRoute<T>): ReturnType<typeof idempotent.byKey<T>> {
  const { c } = route;
  return runMutation(() =>
    idempotent.byKey({
      db: c.var.db,
      scope: {
        userId: callerUserId(c.var.principal),
        route: c.req.routePath,
        key: requiredIdempotencyKey(c),
      },
      body: route.body,
      executorId: crypto.randomUUID(),
      responseSchema: route.responseSchema,
      execute: route.execute,
    })
  );
}

/** Post-commit eviction; failures are logged, never unwound (cache TTL recovers). */
async function evictAfterCommit(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string,
  principalIds: readonly string[]
): Promise<void> {
  const evicted = await evictPrincipals(
    { revoker: deps.revoker(c.var.redis), realtime: deps.realtime(c.env) },
    conversationId,
    principalIds
  );
  if (evicted.isErr()) {
    c.var.logger.warn('conversation eviction incomplete', {
      conversationId,
      errorCode: evicted.error.code,
    });
  }
}

export function createConversationsManifest(
  deps: ConversationsRouteDeps
): ReturnType<typeof defineSliceManifest<'/conversations', Hono<AppEnv>>> {
  return defineSliceManifest({
    basePath: '/conversations',
    routes: new Hono<AppEnv>()
      .post(
        '/',
        routeClass('session'),
        zValidator('json', createConversationBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body,
            responseSchema: createConversationOutcomeSchema,
            execute: (tx) => createConversation(deps.stores(tx), { callerUserId: caller, ...body }),
          });
          return result.match(
            (outcome) => respondOutcome(c, outcome, (success) => c.json(success, 200)),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/',
        routeClass('session'),
        zValidator('query', listConversationsQuerySchema, rejectInvalid),
        async (c) => {
          const { cursor, limit } = c.req.valid('query');
          const result = await listConversations(deps.stores(c.var.db), {
            callerUserId: callerUserId(c.var.principal),
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/:conversationId',
        routeClass('session'),
        zValidator('param', conversationIdParamSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await getConversation(deps.stores(c.var.db), {
            conversationId,
            callerUserId: callerUserId(c.var.principal),
          });
          return result.match(
            (outcome) => respondOutcome(c, outcome, (success) => c.json(success, 200)),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .delete(
        '/:conversationId',
        routeClass('session'),
        zValidator('param', conversationIdParamSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId },
            responseSchema: deleteConversationOutcomeSchema,
            execute: (tx) =>
              deleteConversation(deps.stores(tx), { conversationId, callerUserId: caller }),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            await evictAfterCommit(deps, c, conversationId, result.value.evicteePrincipalIds);
          }
          return result.match(
            (outcome) =>
              respondOutcome(c, outcome, () => c.json({ deleted: true as const }, 200)),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
