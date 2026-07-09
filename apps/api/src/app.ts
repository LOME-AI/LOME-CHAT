import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { ERROR_CODES } from '@hushbox/shared';
import { trialRoomName } from '@hushbox/realtime/protocol';
import { applyPipeline } from './middleware/pipeline.js';
import { defineSliceManifest, routeClass } from './middleware/pipeline-manifest.js';
import { markPipelineHandler, readPipelineVariable } from './middleware/pipeline-markers.js';
import { createErrorResponse } from './lib/errors/index.js';
import { createConsoleTelemetry } from './lib/telemetry/index.js';
import { createAccountManifest, createAccountStores } from './slices/account/index.js';
import {
  createAnnouncementsManifest,
  createAnnouncementsStores,
} from './slices/announcements/index.js';
import {
  checkSessionRevocation,
  createIdentityManifest,
  createIdentityStores,
} from './slices/identity/index.js';
import {
  createConversationsManifest,
  createConversationsStores,
  createMembershipRevoker,
} from './slices/conversations/index.js';
import { createChatManifest, createForkMessageDeleter } from './slices/chat/index.js';
import {
  createBillingManifest,
  createBillingStores,
  createPaymentProviderFromEnv,
  createPaymentVerifyJobRegistration,
} from './slices/billing/index.js';
import {
  createDeviceTokenStore,
  createNotificationsManifest,
} from './slices/notifications/index.js';
import { createAppJobRegistry } from './lib/jobs/index.js';
import { createAppPasswordChangedEmailPort } from './adapters/password-changed-email.js';
import { createAppVerificationEmailPort } from './adapters/verification-email.js';
import { createConversationRoomRealtime } from './adapters/realtime-broadcast.js';
import { createAppAccountLockedEmailPort } from './adapters/account-locked-email.js';
import { createAppWelcomeEmailPort } from './adapters/welcome-email.js';
import { createAppTwoFactorEnabledEmailPort } from './adapters/two-factor-enabled-email.js';
import { createAppTwoFactorDisabledEmailPort } from './adapters/two-factor-disabled-email.js';
import { createAppLoginLockoutEmailPort } from './adapters/login-lockout-email.js';
import {
  createDeferredAccountDefense,
  createWebhookVerifierFromEnv,
  wakePaymentVerifyDispatcher,
} from './adapters/billing-bindings.js';
import type { AppEnv } from './lib/context/index.js';

/** Skeleton liveness route — also the living example of the manifest contract. */
const healthManifest = defineSliceManifest({
  basePath: '/health',
  routes: new Hono<AppEnv>().get('/', routeClass('public'), (c) => c.json({ status: 'ok' })),
});

// Slice deps are per-request store factories: the manifests construct stores
// from the pipeline's `c.var.db` on each request, so module-level manifest
// construction holds no connection state.
const accountManifest = createAccountManifest({ stores: createAccountStores });
const announcementsManifest = createAnnouncementsManifest({ stores: createAnnouncementsStores });
const notificationsManifest = createNotificationsManifest({
  deviceTokenStore: createDeviceTokenStore,
});
// The email ports are the static (non-factory) slice deps: their adapters
// resolve env/db/logger per send through the context storage installed in
// `createApp()`, so this module-level construction still holds no state.
// One billing stores instance is shared by the billing manifest, the chat
// turn, and identity's registration provisioning: all compose the same
// admission/settlement writes, so they must read through the same published
// surface (the DB client is per-request `c.var.db`, which the store methods
// take as an argument — the stores object holds none).
const billingStores = createBillingStores();
const identityManifest = createIdentityManifest({
  stores: createIdentityStores,
  emailPort: createAppVerificationEmailPort(),
  passwordChangedEmailPort: createAppPasswordChangedEmailPort(),
  billingStores,
  welcomeEmailPort: createAppWelcomeEmailPort(),
  twoFactorEnabledEmailPort: createAppTwoFactorEnabledEmailPort(),
  twoFactorDisabledEmailPort: createAppTwoFactorDisabledEmailPort(),
  accountLockedEmailPort: createAppLoginLockoutEmailPort(),
});
const conversationsManifest = createConversationsManifest({
  stores: createConversationsStores,
  revoker: createMembershipRevoker,
  realtime: createConversationRoomRealtime,
  // Chat is the single writer of `messages`; a fork deletion composes its
  // deleter to remove the orphaned branch atomically with the fork row.
  deleteForkMessages: createForkMessageDeleter,
});
const billingManifest = createBillingManifest({
  stores: billingStores,
  paymentProvider: (env) => createPaymentProviderFromEnv(env),
  webhookVerifier: createWebhookVerifierFromEnv,
  // No module-scope DB exists here (env is per-request), so the enqueue registry
  // is built per request from `c.var.db`. The registration's DB is unused at
  // enqueue time (it only reads the registered schema/lease/shard); it feeds the
  // handler, which runs in the dispatcher DO, not this route.
  jobRegistry: (env, db) =>
    createAppJobRegistry([
      createPaymentVerifyJobRegistration({
        db,
        stores: billingStores,
        provider: createPaymentProviderFromEnv(env),
      }),
    ]),
  // Chargeback auto-defense is not wired yet (identity publishes no lock/revoke
  // barrel); the deferred port fails loud on the dispute-lock path only.
  accountDefense: createDeferredAccountDefense(),
  accountLockedEmail: createAppAccountLockedEmailPort(),
  wakeDispatcher: wakePaymentVerifyDispatcher,
});
const chatManifest = createChatManifest({
  conversations: createConversationsStores,
  billing: billingStores,
  // The turn streams over the same ConversationRoom DO conversations broadcasts
  // through — one binding, not a second.
  realtime: createConversationRoomRealtime,
  trialRoomName,
});

/**
 * The app assembly: one default-deny pipeline applied to everything mounted
 * under it, then the slice manifests at their real paths. Routes hold no
 * business logic here — this file only composes. Dev-only surfaces are not a
 * mount-time concern: the `dev-only` route class answers 404 in production.
 *
 * Error mapping is owned here (sub-routers must not install `onError`). Both
 * non-route outcomes answer the uniform `{code}` wire shape:
 * - `notFound` matches the authorizer's production-hidden dev-only denial
 *   byte-for-byte, so a probe cannot tell a hidden route from a missing one;
 * - `onError` answers a defect with a bare `{code: INTERNAL}` — internals go
 *   to telemetry only, never the wire. The fallback adapter covers defects
 *   thrown before the bindings stage installs the request logger (e.g. the
 *   missing-binding fail-fast).
 */
export function createApp() {
  const root = new Hono<AppEnv>();
  // AsyncLocalStorage-backed request-context storage (nodejs_compat on
  // Workers): composition-root adapters bound as STATIC slice deps (the
  // identity email port) resolve their per-request infra through it at call
  // time. Marked pipeline-owned so the authorizer does not count this
  // wildcard as a matched undeclared handler and default-deny everything.
  root.use('*', markPipelineHandler(contextStorage()));
  // Session liveness is enforced app-wide: the identity slice's revocation
  // check runs on every cookie-bearing request, so a logged-out or
  // password-staled session degrades to `none` before authorization — the
  // production configuration `assertRevocationWiredInProduction` expects.
  const base = applyPipeline(root, { session: { revocation: checkSessionRevocation } })
    .notFound((c) => c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404))
    .onError((error, c) => {
      const logger = readPipelineVariable(c, 'logger') ?? createConsoleTelemetry();
      logger.captureError(error, ERROR_CODES.INTERNAL);
      return c.json(createErrorResponse(ERROR_CODES.INTERNAL), 500);
    });
  // Slice manifests mount below, one chained `.route()` line per slice
  // (chaining — not a loop — keeps AppType inference for the typed client).
  const app = base
    .route(healthManifest.basePath, healthManifest.routes)
    .route(accountManifest.basePath, accountManifest.routes)
    .route(announcementsManifest.basePath, announcementsManifest.routes)
    .route(identityManifest.basePath, identityManifest.routes)
    .route(conversationsManifest.basePath, conversationsManifest.routes)
    .route(chatManifest.basePath, chatManifest.routes)
    .route(billingManifest.basePath, billingManifest.routes)
    .route(notificationsManifest.basePath, notificationsManifest.routes);
  return app;
}

export type AppType = ReturnType<typeof createApp>;
