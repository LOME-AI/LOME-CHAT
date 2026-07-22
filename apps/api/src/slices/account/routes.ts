import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  callerUserId,
  clearInstructions,
  createErrorResponse,
  domainWireCode,
  getAccessibilityPreferences,
  getInstructions,
  idempotencyExempt,
  idempotent,
  putAccessibilityPreferencesBodySchema,
  putInstructionsBodySchema,
  runMutation,
  saveAccessibilityPreferences,
  saveInstructions,
  searchInvitableUsers,
  searchUsersQuerySchema,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { AccountStoresFactory, DomainError, DomainErrorCode } from './domain/index.js';

export interface AccountRouteDeps {
  /** Constructed per request from the pipeline's `c.var.db`. */
  readonly stores: AccountStoresFactory;
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
  return c.json(createErrorResponse(domainWireCode(error)), STATUS_BY_DOMAIN_CODE[error.code]);
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

/**
 * The account slice's HTTP surface. Every route is `session`-class; the
 * mutating routes are `naturally-idempotent` (a repeat converges on the same
 * end state through `idempotent.byUpsert`/`byTransition` below), so no
 * `Idempotency-Key` header is demanded of settings-sync clients.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createAccountManifest(deps: AccountRouteDeps) {
  return defineSliceManifest({
    basePath: '/account',
    routes: new Hono<AppEnv>()
      .get(
        '/users/search',
        routeClass('session'),
        zValidator('query', searchUsersQuerySchema, rejectInvalid),
        async (c) => {
          const { q, conversationId, limit } = c.req.valid('query');
          const result = await searchInvitableUsers(deps.stores(c.var.db).users, {
            query: q,
            conversationId,
            callerUserId: callerUserId(c.var.principal),
            ...(limit === undefined ? {} : { limit }),
          });
          return result.match(
            (found) => c.json({ users: found }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get('/instructions', routeClass('session'), async (c) => {
        const result = await getInstructions(
          deps.stores(c.var.db).instructions,
          callerUserId(c.var.principal)
        );
        return result.match(
          (state) => c.json(state, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .put(
        '/instructions',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', putInstructionsBodySchema, rejectInvalid),
        async (c) => {
          const { instructions } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              saveInstructions(
                deps.stores(c.var.db).instructions,
                callerUserId(c.var.principal),
                instructions
              )
            )
          );
          return result.match(
            (saved) => c.json(saved, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .delete(
        '/instructions',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byTransition(
              clearInstructions(deps.stores(c.var.db).instructions, callerUserId(c.var.principal))
            )
          );
          return result.match(
            (cleared) => c.json(cleared, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get('/preferences/accessibility', routeClass('session'), async (c) => {
        const result = await getAccessibilityPreferences(
          deps.stores(c.var.db).preferences,
          callerUserId(c.var.principal)
        );
        return result.match(
          (state) => c.json(state, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .put(
        '/preferences/accessibility',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', putAccessibilityPreferencesBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              saveAccessibilityPreferences(
                deps.stores(c.var.db).preferences,
                callerUserId(c.var.principal),
                body
              )
            )
          );
          return result.match(
            (outcome) => c.json(outcome, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
