import { Hono } from 'hono';
import { routePath } from 'hono/route';
import { zValidator } from '@hono/zod-validator';
import { ERROR_CODES, submitFeedbackBodySchema } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  callerUserId,
  createErrorResponse,
  idempotent,
  isFeedbackDuplicate,
  isIdempotencyConflict,
  readIdempotencyKey,
  runMutation,
  submitFeedback,
  submitFeedbackResponseSchema,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { DomainError, DomainErrorCode, FeedbackStoresFactory } from './domain/index.js';

export interface FeedbackRouteDeps {
  /** Bound per call to the pipeline's `c.var.db` or the byKey transaction. */
  readonly stores: FeedbackStoresFactory;
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

/**
 * Submit failures answer the feedback-specific `FEEDBACK_SUBMIT_FAILED` wire
 * code (a friendly "couldn't send" message) at the domain error's status; an
 * idempotency-key conflict keeps its specific 409 wire code so a retried key
 * with a different body is diagnosable, and a same-body resubmit inside the
 * dedup window answers the specific `FEEDBACK_DUPLICATE` 409.
 */
function respondSubmitError(c: Context<AppEnv>, error: DomainError): Response {
  if (isIdempotencyConflict(error)) {
    return c.json(createErrorResponse(error.wireCode), 409);
  }
  if (isFeedbackDuplicate(error)) {
    return c.json(createErrorResponse(ERROR_CODES.FEEDBACK_DUPLICATE), 409);
  }
  return c.json(
    createErrorResponse(ERROR_CODES.FEEDBACK_SUBMIT_FAILED),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

/**
 * zValidator hook: malformed input answers the uniform `{code}` body. The
 * context is typed with hono's base `Env` because the hook's `E` is not inferred
 * from the route chain — `AppEnv` here would fail contravariance.
 */
function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/**
 * The pipeline enforced the header before the handler ran; absence is a
 * composition defect, not a client error. Exported so the defect arm stays
 * executable in tests.
 */
export function requiredIdempotencyKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  if (key === undefined) {
    throw new Error('feedback: idempotency key missing after the pipeline stage');
  }
  return key;
}

/**
 * The feedback slice's HTTP surface: a single session-class submit endpoint. It
 * dedups with `idempotent.byKey` (at-most-once) because submission is NOT
 * naturally idempotent — a repeat without a key would file a second note.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route schema
 * from `AppType` (the typed client goes blind to this slice). The route mounts
 * at `/` under the `/feedback` base so it resolves as `client.feedback.$post`.
 */
export function createFeedbackManifest(deps: FeedbackRouteDeps) {
  return defineSliceManifest({
    basePath: '/feedback',
    routes: new Hono<AppEnv>().post(
      '/',
      routeClass('session'),
      zValidator('json', submitFeedbackBodySchema, rejectInvalid),
      async (c) => {
        const body = c.req.valid('json');
        const userId = callerUserId(c.var.principal);
        const result = await runMutation(() =>
          idempotent.byKey({
            db: c.var.db,
            scope: { userId, route: routePath(c), key: requiredIdempotencyKey(c) },
            body,
            executorId: crypto.randomUUID(),
            responseSchema: submitFeedbackResponseSchema,
            execute: (tx) => submitFeedback(deps.stores(tx), userId, body),
          })
        );
        return result.match(
          (submitted) => c.json(submitted, 200),
          (error) => respondSubmitError(c, error)
        );
      }
    ),
  });
}
