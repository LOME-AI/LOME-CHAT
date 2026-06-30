import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { match } from 'ts-pattern';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES, toBase64 } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  completeRegistration,
  consumePendingRegistration,
  createErrorResponse,
  destroySessionCookie,
  finishLogin,
  idempotencyExempt,
  idempotent,
  issueSession,
  loginFinishBodySchema,
  loginInitBodySchema,
  registerFinishBodySchema,
  registerInitBodySchema,
  requireOpaqueMasterSecret,
  revokeSession,
  runMutation,
  startLogin,
  startRegistration,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { DomainError, DomainErrorCode, IdentityStoresFactory } from './domain/index.js';

export interface IdentityRouteDeps {
  /** Constructed per request from the pipeline's `c.var.db`. */
  readonly stores: IdentityStoresFactory;
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
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
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

function rateLimitedResponse(c: Context<AppEnv>, retryAfterSeconds: number): Response {
  return c.json(createErrorResponse(ERROR_CODES.RATE_LIMITED, { retryAfterSeconds }), 429);
}

/**
 * The identity slice's HTTP surface. The OPAQUE rounds are
 * `opaque-protocol`-exempt from the Idempotency-Key header: the Redis
 * challenge state is the dedup — a retry restarts the handshake harmlessly.
 */
export function createIdentityManifest(
  deps: IdentityRouteDeps
): ReturnType<typeof defineSliceManifest<'/auth', Hono<AppEnv>>> {
  return defineSliceManifest({
    basePath: '/auth',
    routes: new Hono<AppEnv>()
      .post(
        '/register/init',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', registerInitBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await startRegistration({
            store: deps.stores(c.var.db).users,
            redis: c.var.redis,
            masterSecret: requireOpaqueMasterSecret(c.env),
            email: body.email,
            username: body.username,
            registrationRequest: body.registrationRequest,
            now: Date.now(),
          });
          return result.match(
            (outcome) =>
              match(outcome)
                .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
                .with({ kind: 'started' }, (o) =>
                  c.json(
                    {
                      registrationResponse: o.registrationResponse,
                      registerSessionId: o.registerSessionId,
                    },
                    200
                  )
                )
                .exhaustive(),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/register/finish',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', registerFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const consumed = await consumePendingRegistration({
            redis: c.var.redis,
            email: body.email,
            registerSessionId: body.registerSessionId,
          });
          if (consumed.isErr()) return respondDomainError(c, consumed.error);
          return match(consumed.value)
            .with({ kind: 'no-pending' }, () =>
              c.json(createErrorResponse(ERROR_CODES.NO_PENDING_REGISTRATION), 400)
            )
            .with({ kind: 'existing' }, () =>
              // Enumeration safety: identical success shape with a throwaway
              // id when the email is already registered.
              c.json({ success: true as const, userId: crypto.randomUUID() }, 201)
            )
            .with({ kind: 'pending' }, async (pending) => {
              const inserted = await runMutation(() =>
                idempotent.byUpsert(() =>
                  completeRegistration({
                    store: deps.stores(c.var.db).users,
                    pending,
                    registrationRecord: body.registrationRecord,
                    accountPublicKey: body.accountPublicKey,
                    passwordWrappedPrivateKey: body.passwordWrappedPrivateKey,
                    recoveryWrappedPrivateKey: body.recoveryWrappedPrivateKey,
                  })
                )
              );
              return inserted.match(
                (outcome) =>
                  match(outcome)
                    .with({ kind: 'created' }, (o) =>
                      c.json({ success: true as const, userId: o.userId }, 201)
                    )
                    .with({ kind: 'email-taken' }, () =>
                      c.json(createErrorResponse(ERROR_CODES.EMAIL_TAKEN), 409)
                    )
                    .with({ kind: 'username-taken' }, () =>
                      c.json(createErrorResponse(ERROR_CODES.USERNAME_TAKEN), 409)
                    )
                    .exhaustive(),
                (error) => respondDomainError(c, error)
              );
            })
            .exhaustive();
        }
      )
      .post(
        '/login/init',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', loginInitBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await startLogin({
            store: deps.stores(c.var.db).users,
            redis: c.var.redis,
            masterSecret: requireOpaqueMasterSecret(c.env),
            identifier: body.identifier,
            ke1: body.ke1,
            now: Date.now(),
          });
          return result.match(
            (outcome) =>
              match(outcome)
                .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
                .with({ kind: 'started' }, (o) =>
                  c.json({ ke2: o.ke2, loginSessionId: o.loginSessionId }, 200)
                )
                .exhaustive(),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/login/finish',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', loginFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await finishLogin({
            store: deps.stores(c.var.db).users,
            redis: c.var.redis,
            masterSecret: requireOpaqueMasterSecret(c.env),
            identifier: body.identifier,
            ke3: body.ke3,
            loginSessionId: body.loginSessionId,
          });
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-pending' }, () =>
              c.json(createErrorResponse(ERROR_CODES.NO_PENDING_LOGIN), 400)
            )
            .with({ kind: 'auth-failed' }, () =>
              c.json(createErrorResponse(ERROR_CODES.AUTH_FAILED), 401)
            )
            .with({ kind: 'locked' }, () =>
              c.json(createErrorResponse(ERROR_CODES.ACCOUNT_LOCKED), 403)
            )
            .with({ kind: 'success' }, async ({ user }) => {
              const issued = await issueSession({
                request: c.req.raw,
                response: c.res,
                redis: c.var.redis,
                secret: c.var.bindings.IRON_SESSION_SECRET,
                isProduction: c.var.envUtils.isProduction,
                userId: user.id,
                kind: user.totpEnabled ? 'pending-2fa' : 'full',
                now: Date.now(),
              });
              if (issued.isErr()) return respondDomainError(c, issued.error);
              if (user.totpEnabled) {
                return c.json({ requires2FA: true as const, userId: user.id }, 200);
              }
              return c.json(
                {
                  success: true as const,
                  userId: user.id,
                  email: user.email,
                  passwordWrappedPrivateKey: toBase64(user.passwordWrappedPrivateKey),
                },
                200
              );
            })
            .exhaustive();
        }
      )
      // pending-2fa class: the auth-flow surface — a mid-2FA (or billing-only)
      // session must be able to log out. Repeating converges on the same end
      // state (no active session), hence naturally-idempotent.
      .post(
        '/logout',
        routeClass('pending-2fa'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const principal = c.var.principal;
          if (principal.kind !== 'none') {
            const revoked = await revokeSession(c.var.redis, principal.claims);
            if (revoked.isErr()) return respondDomainError(c, revoked.error);
          }
          await destroySessionCookie({
            request: c.req.raw,
            response: c.res,
            secret: c.var.bindings.IRON_SESSION_SECRET,
            isProduction: c.var.envUtils.isProduction,
          });
          return c.json({ success: true as const }, 200);
        }
      ),
  });
}
