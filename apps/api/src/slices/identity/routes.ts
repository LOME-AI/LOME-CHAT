import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { match } from 'ts-pattern';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES, toBase64 } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  billingTokenLogin,
  billingTokenLoginBodySchema,
  changePasswordFinishBodySchema,
  changePasswordInitBodySchema,
  createDeleteAccountFinishFlow,
  createDisable2faFinishFlow,
  createErrorResponse,
  createLoginFinishFlow,
  createPasswordChangeFinishFlow,
  createRecoveryResetFinishFlow,
  createRegisterFinishFlow,
  createTotpVerifySetupFlow,
  deleteAccountFinishBodySchema,
  deleteAccountInitBodySchema,
  destroySessionCookie,
  disable2faFinishBodySchema,
  disable2faInitBodySchema,
  duplicateFreshHandshakeDefect,
  getRecoveryWrappedKey,
  idempotencyExempt,
  idempotent,
  loginFinishBodySchema,
  loginInitBodySchema,
  okAsync,
  recoveryGetKeyBodySchema,
  recoveryResetFinishBodySchema,
  recoveryResetInitBodySchema,
  recoverySaveBodySchema,
  registerFinishBodySchema,
  registerInitBodySchema,
  requireOpaqueMasterSecret,
  resendVerification,
  resendVerificationBodySchema,
  resolveMe,
  revokeSession,
  runMutation,
  saveRecoveryKey,
  startDeleteAccount,
  startDisable2fa,
  startLogin,
  startPasswordChange,
  startRecoveryReset,
  startRegistration,
  startTotpSetup,
  totpCodeBodySchema,
  verifyEmailBodySchema,
  verifyEmailToken,
  verifyLogin2fa,
} from './domain/index.js';
import type { ErrorCode } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv, SessionClaims } from '../../middleware/pipeline-manifest.js';
import type {
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  AccountLockedEmailPort,
  BillingStores,
  DomainError,
  DomainErrorCode,
  IdentityStoresFactory,
  IdentityUserRecord,
  IdentityUsersStore,
  OpaqueFinishFlow,
  PasswordChangedEmailPort,
  RedisClient,
  ResultAsync,
  TwoFactorDisabledEmailPort,
  TwoFactorEnabledEmailPort,
  VerificationEmailPort,
  WelcomeEmailPort,
} from './domain/index.js';

export interface IdentityRouteDeps {
  /** Constructed per request from the pipeline's `c.var.db`. */
  readonly stores: IdentityStoresFactory;
  /**
   * Verification-email sender, bound at the composition root to an adapter
   * over the notifications slice's template + EmailSender (see ports/email.ts).
   */
  readonly emailPort: VerificationEmailPort;
  /**
   * Password-changed security notification, bound the same way; dispatched
   * best-effort after either credential-rotation flow commits.
   */
  readonly passwordChangedEmailPort: PasswordChangedEmailPort;
  /**
   * Billing's single-writer stores, composed inside register-finish's
   * settlement to provision the new user's wallets + welcome credit atomically
   * with the account INSERT (billing's published within-tx surface).
   */
  readonly billingStores: BillingStores;
  /** Welcome-credit email, sent best-effort when registration grants the credit. */
  readonly welcomeEmailPort: WelcomeEmailPort;
  /** TOTP-enabled / -disabled security notifications, dispatched best-effort. */
  readonly twoFactorEnabledEmailPort: TwoFactorEnabledEmailPort;
  readonly twoFactorDisabledEmailPort: TwoFactorDisabledEmailPort;
  /** Login-lockout security notification, dispatched best-effort on the trip. */
  readonly accountLockedEmailPort: AccountLockedEmailPort;
  /**
   * Builds the session-revocation eviction port from request-scoped infra (the
   * Redis active-room reader + the ConversationRoom DO client). Threaded into
   * every session-revocation and credential-rotation flow so a revoked user's
   * live sockets are closed best-effort (ARCHITECTURE §15). Structurally the
   * identity slice's `EvictUserPort`; typed inline so the route layer needs no
   * ports import.
   */
  readonly evictUser: (
    redis: RedisClient,
    env: AppEnv['Bindings']
  ) => { evictUser(userId: string): Promise<void> };
  /**
   * Account-deleted confirmation, bound like the other email ports; sent
   * best-effort after the deletion transaction commits.
   */
  readonly accountDeletedEmailPort: AccountDeletedEmailPort;
  /**
   * The deletion executor's cross-slice purge surface (chat's content helpers
   * + the media-reclaim enqueue), bound at the composition root: identity may
   * not import the chat or media barrels — both already import identity, and
   * a barrel cycle is lint-banned. Built per request (the reclaim enqueue's
   * registry needs env + db).
   */
  readonly deletionPurge: (env: AppEnv['Bindings'], db: Database) => AccountDeletionPurge;
  /**
   * The lossy post-commit nudge for the deletion's media-reclaim enqueue (the
   * `bulk` shard), fired via `waitUntil` after the deletion commits — never
   * inside it. Optional: absent binding (local dev / tests without the DO) is
   * a no-op; the dispatcher's perpetual alarm is the delivery guarantee.
   */
  readonly wakeReclaimDispatcher?: (env: AppEnv['Bindings']) => Promise<void> | void;
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

function tooManyAttemptsResponse(c: Context<AppEnv>, retryAfterSeconds: number): Response {
  return c.json(createErrorResponse(ERROR_CODES.TOO_MANY_ATTEMPTS, { retryAfterSeconds }), 429);
}

/** One-line error arm for the ts-pattern matches below. */
function errorJson(c: Context<AppEnv>, code: ErrorCode, status: ContentfulStatusCode): Response {
  return c.json(createErrorResponse(code), status);
}

/** The full-login success payload: the wrapped key rides back for client-side unwrap. */
function loginSuccessBody(user: IdentityUserRecord): {
  success: true;
  userId: string;
  email: string;
  passwordWrappedPrivateKey: string;
} {
  return {
    success: true as const,
    userId: user.id,
    email: user.email,
    passwordWrappedPrivateKey: toBase64(user.passwordWrappedPrivateKey),
  };
}

/**
 * The claims of a `session`-class route (a full principal is guaranteed by the
 * authorizer). A non-full principal here is a pipeline-composition defect.
 */
export function fullClaims(c: Context<AppEnv>): SessionClaims {
  const principal = c.var.principal;
  if (principal.kind !== 'full') {
    throw new Error('identity: session-class route reached without a full principal');
  }
  return principal.claims;
}

/**
 * The infra trio every OPAQUE-family domain call draws from the request
 * context. Calls that need no master secret simply ignore the extra key.
 */
function opaqueDeps(
  c: Context<AppEnv>,
  deps: IdentityRouteDeps
): { redis: RedisClient; store: IdentityUsersStore; masterSecret: string } {
  return {
    redis: c.var.redis,
    store: deps.stores(c.var.db).users,
    masterSecret: requireOpaqueMasterSecret(c.env),
  };
}

/**
 * `byEventId` params for an init round: the handshake id is minted server-side
 * inside `execute` (a fresh uuid per request), so the claim trivially wins and
 * a duplicate delivery is a defect. Finish rounds pass their flow (whose
 * atomic consume IS the claim) to `idempotent.byEventId` directly; the
 * wrapper call itself stays inline at every route seam (arch-rule contract).
 */
function freshHandshake<T>(execute: () => ResultAsync<T, DomainError>): OpaqueFinishFlow<T> {
  return {
    claim: () => okAsync<boolean, DomainError>(true),
    execute,
    onDuplicate: duplicateFreshHandshakeDefect,
  };
}

/**
 * The identity slice's HTTP surface. The OPAQUE rounds are
 * `opaque-protocol`-exempt from the Idempotency-Key header: the Redis
 * challenge state is the dedup — a retry restarts the handshake harmlessly.
 *
 * No return annotation: the chained route schema must flow through
 * `defineSliceManifest`'s generic so `AppType` (and the typed client) carry
 * this slice's routes after mounting.
 */
export function createIdentityManifest(deps: IdentityRouteDeps) {
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
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startRegistration({
                  ...opaqueDeps(c, deps),
                  email: body.email,
                  username: body.username,
                  registrationRequest: body.registrationRequest,
                  now: Date.now(),
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
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
            .exhaustive();
        }
      )
      .post(
        '/register/finish',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', registerFinishBodySchema, rejectInvalid),
        async (c) => {
          const flow = createRegisterFinishFlow({
            ...opaqueDeps(c, deps),
            db: c.var.db,
            billingStores: deps.billingStores,
            verificationStore: deps.stores(c.var.db).verification,
            welcomeEmail: deps.welcomeEmailPort,
            verificationEmail: deps.emailPort,
            now: Date.now(),
            ...c.req.valid('json'),
          });
          const outcome = await runMutation(() => idempotent.byEventId(flow));
          if (outcome.isErr()) return respondDomainError(c, outcome.error);
          return match(outcome.value)
            .with({ kind: 'no-pending' }, () =>
              errorJson(c, ERROR_CODES.NO_PENDING_REGISTRATION, 400)
            )
            .with({ kind: 'existing' }, () =>
              // Enumeration safety: identical success shape with a throwaway
              // id when the email is already registered.
              c.json({ success: true as const, userId: crypto.randomUUID() }, 201)
            )
            .with({ kind: 'created' }, (o) =>
              c.json({ success: true as const, userId: o.userId }, 201)
            )
            .with({ kind: 'email-taken' }, () => errorJson(c, ERROR_CODES.EMAIL_TAKEN, 409))
            .with({ kind: 'username-taken' }, () => errorJson(c, ERROR_CODES.USERNAME_TAKEN, 409))
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
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startLogin({
                  ...opaqueDeps(c, deps),
                  accountLockedEmail: deps.accountLockedEmailPort,
                  identifier: body.identifier,
                  ke1: body.ke1,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
            .with({ kind: 'started' }, (o) =>
              c.json({ ke2: o.ke2, loginSessionId: o.loginSessionId }, 200)
            )
            .exhaustive();
        }
      )
      .post(
        '/login/finish',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', loginFinishBodySchema, rejectInvalid),
        async (c) => {
          const flow = createLoginFinishFlow({
            ...opaqueDeps(c, deps),
            request: c.req.raw,
            response: c.res,
            secret: c.var.bindings.IRON_SESSION_SECRET,
            isProduction: c.var.envUtils.isProduction,
            now: Date.now(),
            ...c.req.valid('json'),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-pending' }, () => errorJson(c, ERROR_CODES.NO_PENDING_LOGIN, 400))
            .with({ kind: 'auth-failed' }, () => errorJson(c, ERROR_CODES.AUTH_FAILED, 401))
            .with({ kind: 'locked' }, () => errorJson(c, ERROR_CODES.ACCOUNT_LOCKED, 403))
            .with({ kind: 'email-not-verified' }, () =>
              errorJson(c, ERROR_CODES.EMAIL_NOT_VERIFIED, 401)
            )
            .with({ kind: 'logged-in', requires2FA: true }, ({ user }) =>
              c.json({ requires2FA: true as const, userId: user.id }, 200)
            )
            .with({ kind: 'logged-in', requires2FA: false }, ({ user }) =>
              c.json(loginSuccessBody(user), 200)
            )
            .exhaustive();
        }
      )
      // pending-2fa class: the auth-flow surface — a mid-2FA (or billing-only)
      // session must be able to log out. Repeating converges on the same end
      // state (no active session), hence naturally-idempotent: Redis DEL is
      // the single converging statement `idempotent.byUpsert` declares.
      .post(
        '/logout',
        routeClass('pending-2fa'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const principal = c.var.principal;
          // link-guest, trial-session, and admin-actor carry no session
          // claims (and the authorizer denies them this route anyway); every
          // other non-none kind holds a revocable one.
          if (
            principal.kind !== 'none' &&
            principal.kind !== 'link-guest' &&
            principal.kind !== 'trial-session' &&
            principal.kind !== 'admin-actor'
          ) {
            const revoked = await runMutation(() =>
              idempotent.byUpsert(() =>
                revokeSession(c.var.redis, principal.claims, deps.evictUser(c.var.redis, c.env))
              )
            );
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
      )
      // 2FA enrollment: setup mints a fresh secret (server-minted event id, so
      // the first delivery wins by construction); verify confirms the first
      // code and flips totpEnabled. Both are the `opaque-protocol` 2FA family.
      .post(
        '/2fa/setup',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startTotpSetup({
                  ...opaqueDeps(c, deps),
                  userId: fullClaims(c).userId,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'already-enabled' }, () =>
              errorJson(c, ERROR_CODES.TOTP_ALREADY_ENABLED, 400)
            )
            .with({ kind: 'started' }, (o) => c.json({ totpUri: o.totpUri, secret: o.secret }, 200))
            .exhaustive();
        }
      )
      .post(
        '/2fa/verify',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', totpCodeBodySchema, rejectInvalid),
        async (c) => {
          const flow = createTotpVerifySetupFlow({
            ...opaqueDeps(c, deps),
            enabledEmail: deps.twoFactorEnabledEmailPort,
            userId: fullClaims(c).userId,
            code: c.req.valid('json').code,
            now: new Date(),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-pending' }, () => errorJson(c, ERROR_CODES.NO_PENDING_2FA_SETUP, 400))
            .with({ kind: 'invalid-code' }, () => errorJson(c, ERROR_CODES.INVALID_TOTP_CODE, 400))
            .with({ kind: 'already-enabled' }, () =>
              errorJson(c, ERROR_CODES.TOTP_ALREADY_ENABLED, 400)
            )
            .with({ kind: 'enabled' }, () => c.json({ success: true as const }, 200))
            .exhaustive();
        }
      )
      // Login 2FA: promotes a pending-2fa session to full. A wrong code answers
      // the same invalid-code as an unenrolled attempt; the lockout throttles.
      .post(
        '/login/2fa/verify',
        routeClass('pending-2fa'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', totpCodeBodySchema, rejectInvalid),
        async (c) => {
          // The pending-2fa class deliberately admits every principal kind
          // (logout shares it), so a non-pending caller here is EXPECTED
          // client input — a graceful 401 (no live 2FA challenge; re-login),
          // never a thrown defect. Mirrors derivePrincipal degrading an
          // expired challenge to `none`.
          const principal = c.var.principal;
          if (principal.kind !== 'pending-2fa') {
            return errorJson(c, ERROR_CODES.UNAUTHORIZED, 401);
          }
          const claims = principal.claims;
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                verifyLogin2fa({
                  ...opaqueDeps(c, deps),
                  userId: claims.userId,
                  sessionId: claims.sessionId,
                  code: c.req.valid('json').code,
                  now: new Date(),
                  request: c.req.raw,
                  response: c.res,
                  secret: c.var.bindings.IRON_SESSION_SECRET,
                  isProduction: c.var.envUtils.isProduction,
                  evictUser: deps.evictUser(c.var.redis, c.env),
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'locked' }, (o) => tooManyAttemptsResponse(c, o.retryAfterSeconds))
            .with({ kind: 'not-configured' }, () => errorJson(c, ERROR_CODES.INTERNAL, 500))
            .with({ kind: 'invalid' }, () => errorJson(c, ERROR_CODES.INVALID_TOTP_CODE, 400))
            .with({ kind: 'promoted' }, ({ user }) => c.json(loginSuccessBody(user), 200))
            .exhaustive();
        }
      )
      // 2FA disable: step-up (password) AND a TOTP code both required.
      .post(
        '/2fa/disable/init',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', disable2faInitBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startDisable2fa({
                  ...opaqueDeps(c, deps),
                  userId: fullClaims(c).userId,
                  ke1: c.req.valid('json').ke1,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'not-enabled' }, () => errorJson(c, ERROR_CODES.TOTP_NOT_ENABLED, 400))
            .with({ kind: 'started' }, (o) =>
              c.json({ ke2: o.ke2, disable2FASessionId: o.disable2FASessionId }, 200)
            )
            .exhaustive();
        }
      )
      .post(
        '/2fa/disable/finish',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', disable2faFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const flow = createDisable2faFinishFlow({
            ...opaqueDeps(c, deps),
            disabledEmail: deps.twoFactorDisabledEmailPort,
            userId: fullClaims(c).userId,
            ke3: body.ke3,
            code: body.code,
            disable2FASessionId: body.disable2FASessionId,
            now: new Date(),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-step-up' }, () => errorJson(c, ERROR_CODES.NO_PENDING_STEP_UP, 400))
            .with({ kind: 'bad-proof' }, () => errorJson(c, ERROR_CODES.AUTH_FAILED, 401))
            .with({ kind: 'verified' }, ({ value }) =>
              match(value)
                .with({ kind: 'locked' }, (o) => tooManyAttemptsResponse(c, o.retryAfterSeconds))
                .with({ kind: 'not-configured' }, () => errorJson(c, ERROR_CODES.INTERNAL, 500))
                .with({ kind: 'invalid-code' }, () =>
                  errorJson(c, ERROR_CODES.INVALID_TOTP_CODE, 400)
                )
                .with({ kind: 'not-enabled' }, () =>
                  errorJson(c, ERROR_CODES.TOTP_NOT_ENABLED, 400)
                )
                .with({ kind: 'disabled' }, () => c.json({ success: true as const }, 200))
                .exhaustive()
            )
            .exhaustive();
        }
      )
      // Password change: step-up (old password) + a new OPAQUE registration;
      // the finish stamps the pw-changed watermark, staling prior sessions.
      .post(
        '/change-password/init',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', changePasswordInitBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startPasswordChange({
                  ...opaqueDeps(c, deps),
                  userId: fullClaims(c).userId,
                  ke1: body.ke1,
                  newRegistrationRequest: body.newRegistrationRequest,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return c.json(
            {
              ke2: result.value.ke2,
              newRegistrationResponse: result.value.newRegistrationResponse,
              changePasswordSessionId: result.value.changePasswordSessionId,
            },
            200
          );
        }
      )
      .post(
        '/change-password/finish',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', changePasswordFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const flow = createPasswordChangeFinishFlow({
            ...opaqueDeps(c, deps),
            emailPort: deps.passwordChangedEmailPort,
            logger: c.var.logger,
            userId: fullClaims(c).userId,
            ke3: body.ke3,
            changePasswordSessionId: body.changePasswordSessionId,
            newRegistrationRecord: body.newRegistrationRecord,
            newPasswordWrappedPrivateKey: body.newPasswordWrappedPrivateKey,
            now: Date.now(),
            evictUser: deps.evictUser(c.var.redis, c.env),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-step-up' }, () => errorJson(c, ERROR_CODES.NO_PENDING_STEP_UP, 400))
            .with({ kind: 'bad-proof' }, () => errorJson(c, ERROR_CODES.AUTH_FAILED, 401))
            .with({ kind: 'verified' }, () => c.json({ success: true as const }, 200))
            .exhaustive();
        }
      )
      // Recovery (public, enumeration-safe): get-wrapped-key returns the stored
      // recovery blob or a same-shape dummy; reset re-registers via the phrase
      // the client holds. Both are the `opaque-protocol` recovery family.
      .post(
        '/recovery/get-wrapped-key',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', recoveryGetKeyBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                getRecoveryWrappedKey({
                  ...opaqueDeps(c, deps),
                  identifier: c.req.valid('json').identifier,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
            .with({ kind: 'ok' }, (o) =>
              c.json({ recoveryWrappedPrivateKey: o.recoveryWrappedPrivateKey }, 200)
            )
            .exhaustive();
        }
      )
      .post(
        '/recovery/reset/init',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', recoveryResetInitBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startRecoveryReset({
                  ...opaqueDeps(c, deps),
                  identifier: body.identifier,
                  newRegistrationRequest: body.newRegistrationRequest,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
            .with({ kind: 'started' }, (o) =>
              c.json(
                {
                  newRegistrationResponse: o.newRegistrationResponse,
                  recoverySessionId: o.recoverySessionId,
                },
                200
              )
            )
            .exhaustive();
        }
      )
      .post(
        '/recovery/reset/finish',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', recoveryResetFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const flow = createRecoveryResetFinishFlow({
            ...opaqueDeps(c, deps),
            emailPort: deps.passwordChangedEmailPort,
            logger: c.var.logger,
            identifier: body.identifier,
            newRegistrationRecord: body.newRegistrationRecord,
            newPasswordWrappedPrivateKey: body.newPasswordWrappedPrivateKey,
            recoverySessionId: body.recoverySessionId,
            now: Date.now(),
            evictUser: deps.evictUser(c.var.redis, c.env),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-pending' }, () => errorJson(c, ERROR_CODES.NO_PENDING_RECOVERY, 400))
            .with({ kind: 'reset' }, () => c.json({ success: true as const }, 200))
            .exhaustive();
        }
      )
      // Billing-portal token login (public, mobile → web handoff). The token
      // IS the idempotency key: redemption converges on one deterministic
      // billing-only session, so the convergent write is `byUpsert`-shaped.
      // Unknown, expired, and orphaned tokens answer one uniform 401.
      //
      // Deliberately NOT rate limited — a standing exception to the
      // rate-limit-auth-endpoints rule: the credential is a server-minted
      // 122-bit-random uuid alive for 60 seconds (unguessable within the
      // window), a miss costs one Redis GET (no amplification), the pipeline
      // carries no client-IP key to limit on, and a global limiter would
      // hand attackers a self-DoS lever over legitimate handoffs.
      .post(
        '/token-login',
        routeClass('public'),
        idempotencyExempt('token-is-key'),
        zValidator('json', billingTokenLoginBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              billingTokenLogin({
                redis: c.var.redis,
                store: deps.stores(c.var.db).users,
                token: c.req.valid('json').token,
                request: c.req.raw,
                response: c.res,
                secret: c.var.bindings.IRON_SESSION_SECRET,
                isProduction: c.var.envUtils.isProduction,
                now: Date.now(),
              })
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'invalid' }, () => errorJson(c, ERROR_CODES.LOGIN_TOKEN_INVALID, 401))
            .with({ kind: 'logged-in' }, () => c.json({ success: true as const }, 200))
            .exhaustive();
        }
      )
      // Email verification (public). The token IS the idempotency key.
      .post(
        '/verify-email',
        routeClass('public'),
        idempotencyExempt('token-is-key'),
        zValidator('json', verifyEmailBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              verifyEmailToken({
                redis: c.var.redis,
                store: deps.stores(c.var.db).verification,
                token: c.req.valid('json').token,
                now: new Date(),
              })
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
            .with({ kind: 'verified' }, () => c.json({ success: true as const }, 200))
            .with({ kind: 'invalid' }, () =>
              errorJson(c, ERROR_CODES.INVALID_VERIFICATION_TOKEN, 400)
            )
            .exhaustive();
        }
      )
      .post(
        '/verify-email/resend',
        routeClass('public'),
        idempotencyExempt('token-is-key'),
        zValidator('json', resendVerificationBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              resendVerification({
                redis: c.var.redis,
                store: deps.stores(c.var.db).verification,
                emailPort: deps.emailPort,
                email: c.req.valid('json').email,
                now: Date.now(),
              })
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return (
            match(result.value)
              .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
              // Enumeration-safe: a known and an unknown address answer identically.
              .with({ kind: 'ok' }, () => c.json({ success: true as const }, 200))
              .exhaustive()
          );
        }
      )
      // Dev-only escape hatch: the email mock is instance-per-call, so local
      // signup is otherwise uncompletable. `dev-only` 404s in production.
      .get(
        '/verify-email/dev-link',
        routeClass('dev-only'),
        zValidator('query', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const token = await deps
            .stores(c.var.db)
            .verification.findLatestVerificationToken(
              c.req.valid('query').email.toLowerCase(),
              new Date()
            );
          if (token.isErr()) return respondDomainError(c, token.error);
          return c.json({ token: token.value }, 200);
        }
      )
      // Account-deletion request: step-up gated, with a deletion lockout.
      .post(
        '/account/delete/init',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', deleteAccountInitBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startDeleteAccount({
                  ...opaqueDeps(c, deps),
                  userId: fullClaims(c).userId,
                  ke1: c.req.valid('json').ke1,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return c.json(
            { ke2: result.value.ke2, deleteAccountSessionId: result.value.deleteAccountSessionId },
            200
          );
        }
      )
      .post(
        '/account/delete/finish',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', deleteAccountFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const flow = createDeleteAccountFinishFlow({
            ...opaqueDeps(c, deps),
            db: c.var.db,
            purge: deps.deletionPurge(c.env, c.var.db),
            accountDeletedEmail: deps.accountDeletedEmailPort,
            evictUser: deps.evictUser(c.var.redis, c.env),
            userId: fullClaims(c).userId,
            // Legacy parity: the anonymous forensic event records the request's
            // network fingerprint, never an identity.
            ipAddress: c.req.header('cf-connecting-ip') ?? null,
            userAgent: c.req.header('user-agent') ?? null,
            ke3: body.ke3,
            deleteAccountSessionId: body.deleteAccountSessionId,
            confirmationPhrase: body.confirmationPhrase,
            totpCode: body.totpCode,
            now: new Date(),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          const outcome = result.value;
          if (outcome.kind === 'deleted') {
            // Lossy post-commit nudge for the bulk-shard reclaim job; the
            // dispatcher's perpetual alarm is the delivery guarantee.
            if (deps.wakeReclaimDispatcher !== undefined) {
              c.executionCtx.waitUntil(Promise.resolve(deps.wakeReclaimDispatcher(c.env)));
            }
            // The account is gone; the cookie follows it (mirrors logout).
            await destroySessionCookie({
              request: c.req.raw,
              response: c.res,
              secret: c.var.bindings.IRON_SESSION_SECRET,
              isProduction: c.var.envUtils.isProduction,
            });
            return c.json({ success: true as const }, 200);
          }
          return (
            match(outcome)
              .with({ kind: 'no-step-up' }, () => errorJson(c, ERROR_CODES.NO_PENDING_STEP_UP, 400))
              .with({ kind: 'locked' }, (o) => tooManyAttemptsResponse(c, o.retryAfterSeconds))
              .with({ kind: 'bad-proof' }, () => errorJson(c, ERROR_CODES.AUTH_FAILED, 401))
              .with({ kind: 'invalid-phrase' }, () =>
                errorJson(c, ERROR_CODES.INVALID_CONFIRMATION_PHRASE, 400)
              )
              .with({ kind: 'totp-required' }, () =>
                errorJson(c, ERROR_CODES.TOTP_CODE_REQUIRED, 400)
              )
              .with({ kind: 'invalid-totp' }, () =>
                errorJson(c, ERROR_CODES.INVALID_TOTP_CODE, 400)
              )
              .with({ kind: 'totp-not-configured' }, () => errorJson(c, ERROR_CODES.INTERNAL, 500))
              // The vanished-user race: another finish deleted the row first.
              .with({ kind: 'not-found' }, () => errorJson(c, ERROR_CODES.NOT_FOUND, 404))
              .exhaustive()
          );
        }
      )
      // Bootstrap read: identity owns the profile + crypto-key fields. The
      // pipeline downgrades a revoked session before authorization, so no
      // explicit sessionActive recheck is needed (an intentional deviation from
      // legacy). customInstructionsEncrypted is the account slice's; the client
      // fetches it from /account/instructions separately (single-writer).
      .get('/me', routeClass('session'), async (c) => {
        const result = await resolveMe(deps.stores(c.var.db).users, fullClaims(c).userId);
        if (result.isErr()) return respondDomainError(c, result.error);
        return c.json(result.value, 200);
      })
      // Recovery-phrase acknowledgement: persists the client's recovery-wrapped
      // key and flips hasAcknowledgedPhrase. Naturally idempotent — the UPDATE
      // converges — so the header is exempt and the write rides byUpsert.
      .post(
        '/recovery/save',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', recoverySaveBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              saveRecoveryKey({
                store: deps.stores(c.var.db).users,
                userId: fullClaims(c).userId,
                recoveryWrappedPrivateKey: c.req.valid('json').recoveryWrappedPrivateKey,
              })
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return c.json({ success: true as const }, 200);
        }
      ),
  });
}
