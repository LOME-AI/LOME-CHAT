import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { getPath } from 'hono/utils/url';
import { ERROR_CODES } from '@hushbox/shared';
import { trialRoomName } from '@hushbox/realtime/protocol';
import { evictUserFromRooms } from '@hushbox/realtime/user-rooms';
import { applyPipeline } from './middleware/pipeline.js';
import { defineSliceManifest, routeClass } from './middleware/pipeline-manifest.js';
import { markPipelineHandler, readPipelineVariable } from './middleware/pipeline-markers.js';
import { cors } from './middleware/cors.js';
import { csrfProtection } from './middleware/csrf.js';
import { securityHeaders } from './middleware/security-headers.js';
import { requestBodyLimit } from './middleware/body-limit.js';
import { versionCheck } from './middleware/version-check.js';
import { requestLog } from './middleware/request-log.js';
import {
  rateLimitByAdminActor,
  rateLimitByCaller,
  rateLimitByIp,
} from './middleware/rate-limit.js';
import { createErrorResponse } from './lib/errors/index.js';
import { createConsoleTelemetry } from './lib/telemetry/index.js';
import { createAccountManifest, createAccountStores } from './slices/account/index.js';
import {
  adminAuditSearchRateLimit,
  adminCustomer360RateLimit,
  adminOperations,
  adminSqlPanelRateLimit,
  createAdminAuditReads,
  createAdminManifest,
  createAdminOpEngine,
  createAdminOpRegistry,
  createAdminReadSurface,
  createAdminStores,
  createSqlPanel,
} from './slices/admin/index.js';
import {
  createAnnouncementsManifest,
  createAnnouncementsStores,
} from './slices/announcements/index.js';
import {
  checkSessionRevocation,
  createIdentityManifest,
  createIdentityStores,
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  verifyEmailIpRateLimit,
} from './slices/identity/index.js';
import {
  LINK_CREDENTIAL_HEADER,
  createConversationsManifest,
  createConversationsStores,
  createMembershipRevoker,
  publicShareReadRateLimit,
  shareCreateRateLimit,
} from './slices/conversations/index.js';
import {
  captureContentStorageKeysWithinTx,
  createChatManifest,
  createForkMessageDeleter,
  detachMessageSendersWithinTx,
} from './slices/chat/index.js';
import {
  MEDIA_RECLAIM_USER_JOB_TYPE,
  createMediaManifest,
  createMediaReclaimUserJob,
  createR2StorageFromEnv,
} from './slices/media/index.js';
import {
  createBillingManifest,
  createBillingStores,
  createPaymentProviderFromEnv,
  createPaymentVerifyJobRegistration,
  readBalance,
  readUsageBreakdown,
} from './slices/billing/index.js';
import { createModelsManifest } from './slices/models/index.js';
import {
  createDeviceTokenStore,
  createNotificationsManifest,
} from './slices/notifications/index.js';
import { createAppJobRegistry, enqueueWithinTx, wakeJobDispatcher } from './lib/jobs/index.js';
import { createRoadmapManifest } from './platform/roadmap/routes.js';
import { createUpdatesManifest } from './platform/updates/routes.js';
import { createDevManifest } from './platform/dev/routes.js';
import { REALTIME_REDIS_KEYS } from './lib/redis/define-key.js';
import { createAppAccountDeletedEmailPort } from './adapters/account-deleted-email.js';
import { createAppPasswordChangedEmailPort } from './adapters/password-changed-email.js';
import { createAppVerificationEmailPort } from './adapters/verification-email.js';
import { createConversationRoomRealtime } from './adapters/realtime-broadcast.js';
import { createChatMessagePushNotify } from './adapters/push-notify.js';
import { createAppChargebackLockEmailPort } from './adapters/chargeback-lock-email.js';
import { createAdminCrossSliceReads } from './adapters/admin-read-bindings.js';
import { createAdminOpDeps } from './adapters/admin-op-bindings.js';
import { createAppWelcomeEmailPort } from './adapters/welcome-email.js';
import { createAppTwoFactorEnabledEmailPort } from './adapters/two-factor-enabled-email.js';
import { createAppTwoFactorDisabledEmailPort } from './adapters/two-factor-disabled-email.js';
import { createAppLoginLockoutEmailPort } from './adapters/login-lockout-email.js';
import { createAppAdminOpNotifier } from './adapters/admin-op-notification-email.js';
import { createPresignReaders } from './adapters/presign-readers.js';
import { createLinkResolutionAdapter } from './adapters/link-resolution.js';
import {
  createAppAccountDefensePort,
  createSessionRevokeEnqueueRegistration,
  createWebhookVerifierFromEnv,
  wakeSessionRevokeDispatcher,
  wakePaymentVerifyDispatcher,
} from './adapters/billing-bindings.js';
import type { JobDispatcherEnv } from './adapters/billing-bindings.js';
import type { AdminOperationsDeps } from './slices/admin/index.js';
import type { ConversationRoomEnv } from './adapters/realtime-broadcast.js';
import type { Redis } from '@upstash/redis';
import type { AppEnv } from './lib/context/index.js';

/**
 * Session-revocation eviction (ARCHITECTURE §15): the PROMPTNESS layer that
 * closes a revoked user's live sockets by fanning out over their Redis
 * active-room set — SMEMBERS of the DO-maintained set, then the ConversationRoom
 * DO client's `evict` per room. Built per request because both are
 * request-scoped. Best-effort and total: neither a set-read failure nor a
 * per-room evict failure ever throws or aborts the others, so eviction never
 * fails or blocks the revoke — a socket this fan-out misses (an expired set
 * entry, a failed evict) is cut at its next broadcast by the fail-closed
 * broadcast-time session-liveness check. Structurally the identity slice's
 * `EvictUserPort`.
 *
 * The pure fan-out is `@hushbox/realtime`'s `evictUserFromRooms`, imported from
 * the barrel-free `./user-rooms` subpath: the realtime BARREL value-imports the
 * `cloudflare:workers` DO runtime (unloadable in the node-environment test
 * project), but the `user-rooms` module is pure, so `app.ts` stays loadable.
 */
export function createEvictUserPort(
  redis: Redis,
  env: AppEnv['Bindings']
): { evictUser(userId: string): Promise<void> } {
  // Realtime is a BEST-EFFORT subsystem (ARCHITECTURE §15): push-eviction is
  // only the PROMPTNESS layer; the guarantee is the fail-closed broadcast-time
  // session-liveness check. A missing CONVERSATION_ROOM binding must therefore
  // degrade to a no-op port here rather than throw. This port is constructed as
  // a handler argument on critical auth routes (logout, 2FA-enable,
  // password-change, recovery, deletion) OUTSIDE their best-effort swallow, so
  // eagerly calling the throwing `createConversationRoomRealtime` would 500 a
  // route that must always be able to revoke a session. `evictUserBestEffort`
  // treats an unreachable fan-out identically, so revocation (the security-
  // critical sessionActive delete + passwordChangedAt watermark) still runs;
  // only the socket-close promptness is lost. The throw stays fatal for chat
  // broadcast — realtime's PRIMARY consumer — where a missing binding is a
  // genuine misconfiguration that must fail loud.
  // `Bindings` is structurally assignable to `ConversationRoomEnv` (the same
  // widening the `createConversationRoomRealtime(env)` call below relies on),
  // which is where the optional binding is declared.
  const realtimeEnv: ConversationRoomEnv = env;
  if (realtimeEnv.CONVERSATION_ROOM === undefined) {
    return { evictUser: (): Promise<void> => Promise.resolve() };
  }
  const realtime = createConversationRoomRealtime(env);
  return {
    evictUser: (userId: string): Promise<void> =>
      evictUserFromRooms(userId, {
        // The set only ever holds conversationId strings (the DO SADDs them).
        listRooms: async (id) => {
          const rooms = await redis.smembers(REALTIME_REDIS_KEYS.userActiveRooms.buildKey(id));
          return rooms.map(String);
        },
        // `evict` returns a Result (never throws for a domain error); the
        // fan-out's per-room try/catch guards only an unexpected throw, keeping
        // each room's eviction independent of the others.
        evictRoom: async (conversationId, id) => {
          await realtime.evict(conversationId, id);
        },
      }),
  };
}

/** Skeleton liveness route — also the living example of the manifest contract. */
const healthManifest = defineSliceManifest({
  basePath: '/health',
  routes: new Hono<AppEnv>().get('/', routeClass('public'), (c) => c.json({ status: 'ok' })),
});

// Slice deps are per-request store factories: the manifests construct stores
// from the pipeline's `c.var.db` on each request, so module-level manifest
// construction holds no connection state.
const accountManifest = createAccountManifest({ stores: createAccountStores });
// The admin ops registry: constructing it runs the Iron Law gate at module
// load over the full v1 op set — a durable mutation without its registered
// inverse fails the boot, so an irreversible admin operation cannot exist at
// runtime. The ops' slice deps are resolved per engine construction below.
const adminOpRegistry = createAdminOpRegistry<AdminOperationsDeps>([...adminOperations]);
const adminStores = createAdminStores();
// Key-row fence identity (`claimedBy`) for admin executes: per Worker
// instance, an identity rather than state — a restarted isolate claiming
// under a fresh id is exactly what the lease/fence machinery expects.
// Minted lazily on first use: workerd forbids generating random values at
// module scope (boot fails with "Disallowed operation called within global
// scope"), so the id cannot be a top-level const.
let adminExecutorId: string | undefined;
const getAdminExecutorId = (): string => (adminExecutorId ??= `admin-http-${crypto.randomUUID()}`);
const adminManifest = createAdminManifest({
  listOps: () => adminOpRegistry.list(),
  // Deliberately NO `hooks`: `afterAudit` is the audit-atomicity battery's
  // test seam, and production wiring must keep it unreachable — the engine
  // here is composed hookless, and route deps expose no way to add one.
  engine: (db, logger) =>
    createAdminOpEngine({
      db,
      registry: adminOpRegistry,
      stores: adminStores,
      telemetry: logger,
      // Per-request slice deps for the op bodies (billing within-tx writes,
      // identity stores, the session-revoke enqueue registry, conversations'
      // share writes, the DO nudges); the shared billingStores instance and
      // the evict-user factory are composed here, everything else resolves
      // from the request context inside the binding.
      opDeps: createAdminOpDeps(db, billingStores, createEvictUserPort),
      executorId: getAdminExecutorId(),
      // Best-effort mutation notification to every allowlisted admin
      // (telemetry, never a control): resolved per notice from the request
      // context, guarded by the engine's own capture.
      onExecuted: createAppAdminOpNotifier(),
    }),
  // The bespoke read surface (Customer-360, dashboard, jobs queue, audit
  // search, SQL panel): identity/billing panels compose those slices'
  // published surfaces; conversations/jobs reads come through the app-level
  // cross-slice binding; the SQL panel opens its SECOND, SELECT-only
  // connection from the env registry entry (fail-fast when unset).
  reads: ({ db, env, isDev }) => {
    const panelUrl = env.ADMIN_SQL_PANEL_DATABASE_URL;
    if (panelUrl === undefined || panelUrl === '') {
      throw new Error('admin reads: ADMIN_SQL_PANEL_DATABASE_URL is not configured');
    }
    return createAdminReadSurface({
      db,
      stores: adminStores,
      auditReads: createAdminAuditReads(),
      crossSlice: createAdminCrossSliceReads(db),
      identity: createIdentityStores(db).users,
      billing: {
        balance: (userId, now) => readBalance(billingStores, db, userId, now),
        ledgerHistory: (userId, window) =>
          billingStores.readLedgerHistory(db, { userId, ...window }),
        usage: (userId) => readUsageBreakdown(billingStores, db, { userId, limit: 20 }),
      },
      sqlPanel: createSqlPanel({ url: panelUrl, isDev }),
      clock: { now: (): Date => new Date() },
    });
  },
});
const announcementsManifest = createAnnouncementsManifest({ stores: createAnnouncementsStores });
// Zero-dep like the platform manifests: the catalog read composes c.var DI
// (db + logger) per request.
const modelsManifest = createModelsManifest();
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
  // Closes a revoked user's live sockets on logout, 2FA-login rotation,
  // password change, recovery reset, and account deletion (ARCHITECTURE §15).
  evictUser: createEvictUserPort,
  accountDeletedEmailPort: createAppAccountDeletedEmailPort(),
  // The deletion executor's cross-slice purge: chat's published content
  // helpers plus the media-reclaim enqueue. Composed HERE because identity may
  // import neither the chat nor the media barrel (both already import
  // identity; a barrel cycle is lint-banned). The registry is enqueue-only —
  // the reclaim handler runs in the dispatcher DO with its own registry — but
  // reuses the real registration so schema/lease/shard stay single-sourced.
  deletionPurge: (env, db) => ({
    captureContentStorageKeysWithinTx,
    detachMessageSendersWithinTx,
    enqueueMediaReclaimWithinTx: async (tx, args) => {
      await enqueueWithinTx(
        tx,
        createAppJobRegistry([
          createMediaReclaimUserJob({ storage: createR2StorageFromEnv(env, db) }),
        ]),
        { type: MEDIA_RECLAIM_USER_JOB_TYPE, payload: args }
      );
    },
  }),
  // The lossy post-commit nudge for the reclaim job's bulk shard; absent
  // binding (local dev / tests without the DO) is a no-op — the dispatcher's
  // perpetual alarm is the delivery guarantee.
  wakeReclaimDispatcher: async (env: JobDispatcherEnv): Promise<void> => {
    const namespace = env.JOB_DISPATCHER;
    if (namespace === undefined) return;
    await wakeJobDispatcher(namespace, 'bulk');
  },
});
const conversationsManifest = createConversationsManifest({
  stores: createConversationsStores,
  // The owner-facing budget surface composes billing's member-cap write and the
  // display reads through the shared stores instance (same published surface as
  // the chat turn and settlement — single-writer of `member_budgets`).
  billing: billingStores,
  revoker: createMembershipRevoker,
  realtime: createConversationRoomRealtime,
  // Chat is the single writer of `messages`; a fork deletion composes its
  // deleter to remove the orphaned branch atomically with the fork row.
  deleteForkMessages: createForkMessageDeleter,
  // Shared-link credential resolution (identity's port over conversations'
  // shared-link store); liveness enforced lazily at read, same as media below.
  linkResolution: (db) => createLinkResolutionAdapter(db),
});
const mediaManifest = createMediaManifest({
  // Presign readers span chat-owned content_items/messages AND conversations-owned
  // epochs — composed here at the root because no single slice may query across
  // that boundary (single-writer-per-table). Media's domain runs authorization on
  // the reader set without ever touching another slice's tables.
  readers: createPresignReaders,
  // R2 config bound from env; the per-request db threads through for CI evidence.
  storage: createR2StorageFromEnv,
  // Same shared-link resolution the member/share presign paths gate on.
  linkResolution: (db) => createLinkResolutionAdapter(db),
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
      // The webhook's dispute path enqueues session.revoke.v1 inside the
      // clawback settlement transaction; without its registration here the
      // enqueue throws "unregistered job type", rolls the clawback back, and
      // 503-loops Helcim's redelivery. Enqueue reads only the schema/lease/shard
      // (the handler runs in the dispatcher DO's own registry).
      createSessionRevokeEnqueueRegistration(env),
    ]),
  // Chargeback auto-defense over identity's published within-tx lock: the
  // account lock commits in the webhook's clawback SettlementTx (session
  // revocation is the must-happen session.revoke.v1 job it also enqueues).
  accountDefense: createAppAccountDefensePort(),
  accountLockedEmail: createAppChargebackLockEmailPort(),
  wakeDispatcher: wakePaymentVerifyDispatcher,
  // The revoke job rides the `bulk` shard, so its post-commit nudge is separate
  // from the pre-claim's `default`-shard nudge above.
  wakeBulkDispatcher: wakeSessionRevokeDispatcher,
});
// Platform routes (roadmap proxy, OTA updates, the dev tooling family):
// zero-dep manifests — they compose published slice surfaces and c.var DI
// per request, so module-level construction holds no state.
const roadmapManifest = createRoadmapManifest();
const updatesManifest = createUpdatesManifest();
const devManifest = createDevManifest();
const chatManifest = createChatManifest({
  conversations: createConversationsStores,
  billing: billingStores,
  // The turn streams over the same ConversationRoom DO conversations broadcasts
  // through — one binding, not a second.
  realtime: createConversationRoomRealtime,
  trialRoomName,
  // Same shared-link resolution the conversations/media manifests gate on: the
  // guest-send path resolves the link principal through it.
  linkResolution: (db) => createLinkResolutionAdapter(db),
  // The runless user-only send's best-effort push side-band — the same
  // `createMessagePushNotify` wiring the ConversationRoom uses for AI turns,
  // bound per request from the route's env + db (push config, membership,
  // device tokens). Absent-and-non-muted members are notified; present, muted,
  // and the sender are suppressed downstream.
  notifyNewMessage: createChatMessagePushNotify,
});

/**
 * Production routes the admin hostname's API traffic to this Worker under an
 * `/api/*` path (`admin.hushbox.ai/api/*` in wrangler.toml), and the admin SPA
 * always calls relative `/api/admin/...` — but the admin slice mounts at
 * `/admin`. This routing-path hook strips exactly the `/api` prefix off
 * `/api/admin/...` requests BEFORE Hono routes them, so dev and prod share one
 * canonical mapping and the pipeline, rate limits, and authorizer all see the
 * final `/admin/...` path. No new auth surface: the alias reaches only the
 * fail-closed `admin` route class (JWT verified on every request). Scoped to
 * the exact `/api/admin/` prefix by design — no general `/api` rewriter, no
 * hostname keying (deploy config owns hostnames; the path is deterministic in
 * every mode). Only routing is rewritten; `c.req.url` keeps the original URL.
 */
export function adminApiAliasPath(request: Request): string {
  const path = getPath(request);
  return path.startsWith('/api/admin/') ? path.slice('/api'.length) : path;
}

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
  const root = new Hono<AppEnv>({ getPath: adminApiAliasPath });
  // AsyncLocalStorage-backed request-context storage (nodejs_compat on
  // Workers): composition-root adapters bound as STATIC slice deps (the
  // identity email port) resolve their per-request infra through it at call
  // time. Marked pipeline-owned so the authorizer does not count this
  // wildcard as a matched undeclared handler and default-deny everything.
  root.use('*', markPipelineHandler(contextStorage()));
  // Edge middleware ahead of the pipeline, in the legacy global order:
  // cors → security-headers → request-log → version-check, then CSRF on
  // state-changing methods only. All are marked pipeline-owned so the
  // authorizer still 404s unknown paths instead of default-denying them.
  // CORS must lead: it answers preflights before any auth stage could
  // reject an OPTIONS request.
  root.use('*', markPipelineHandler(cors()));
  root.use('*', markPipelineHandler(securityHeaders()));
  // Reject oversized bodies at the edge, before any handler buffers or parses
  // them (413, uniform `{code}`). Mounted after security-headers/CORS so the
  // rejection still carries them; ahead of the pipeline so a hostile body never
  // reaches auth or a route. Marked pipeline-owned so the authorizer does not
  // treat this wildcard as a matched undeclared handler.
  root.use('*', markPipelineHandler(requestBodyLimit()));
  root.use('*', markPipelineHandler(requestLog()));
  root.use('*', markPipelineHandler(versionCheck()));
  root.use('*', markPipelineHandler(csrfProtection()));
  // Session liveness is enforced app-wide: the identity slice's revocation
  // check runs on every cookie-bearing request, so a logged-out or
  // password-staled session degrades to `none` before authorization — the
  // production configuration `assertRevocationWiredInProduction` expects.
  const base = applyPipeline(root, { session: { revocation: checkSessionRevocation } })
    // Per-IP abuse throttles on the unauthenticated auth surfaces, and the
    // per-caller cap on shared-message creation, mount here, not in the slice
    // manifests: their registry entries live in the slice ADAPTERS (routes may
    // not import adapters), so the composition root binds the barrel-published
    // entries to the edge enforcer at the mounted paths. Each is paired with a
    // per-user/email/token limiter inside the domain flow (legacy dual-limited
    // these surfaces). Exact-path mounts — `/verify-email` never captures
    // `/verify-email/resend`.
    .use('/auth/login/init', markPipelineHandler(rateLimitByIp(loginIpRateLimit)))
    .use('/auth/register/init', markPipelineHandler(rateLimitByIp(registerIpRateLimit)))
    .use('/auth/recovery/reset/init', markPipelineHandler(rateLimitByIp(recoveryResetIpRateLimit)))
    .use(
      '/auth/recovery/get-wrapped-key',
      markPipelineHandler(rateLimitByIp(recoveryGetKeyIpRateLimit))
    )
    .use('/auth/verify-email', markPipelineHandler(rateLimitByIp(verifyEmailIpRateLimit)))
    .use('/auth/verify-email/resend', markPipelineHandler(rateLimitByIp(resendVerifyIpRateLimit)))
    // Admin read-volume caps (Charter #12): per hashed admin actor on the
    // sensitive read surfaces — 360 loads, audit search, the SQL panel.
    .use(
      '/admin/users/overview',
      markPipelineHandler(rateLimitByAdminActor(adminCustomer360RateLimit))
    )
    .use('/admin/audit', markPipelineHandler(rateLimitByAdminActor(adminAuditSearchRateLimit)))
    .use('/admin/sql', markPipelineHandler(rateLimitByAdminActor(adminSqlPanelRateLimit)))
    // Shared-message creation, per authenticated caller (a full principal keys
    // by userId; the credential header is inert on this session-class route).
    // The sibling `/links` create shares its path with the GET link-list, so a
    // method-agnostic `.use` mount there would wrongly throttle reads; legacy
    // likewise capped only message-share creation.
    .use(
      '/conversations/:conversationId/shares',
      markPipelineHandler(
        rateLimitByCaller(shareCreateRateLimit, { credentialHeader: LINK_CREDENTIAL_HEADER })
      )
    )
    // The public share read's per-IP cap, mounted at the REAL read path
    // (`/conversations/shared/message/:shareId`); the `:conversationId` route
    // never collides with the static `shared/message` prefix.
    .use(
      '/conversations/shared/message/:shareId',
      markPipelineHandler(rateLimitByIp(publicShareReadRateLimit))
    )
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
    .route(adminManifest.basePath, adminManifest.routes)
    .route(announcementsManifest.basePath, announcementsManifest.routes)
    .route(identityManifest.basePath, identityManifest.routes)
    .route(conversationsManifest.basePath, conversationsManifest.routes)
    .route(chatManifest.basePath, chatManifest.routes)
    .route(billingManifest.basePath, billingManifest.routes)
    .route(mediaManifest.basePath, mediaManifest.routes)
    .route(modelsManifest.basePath, modelsManifest.routes)
    .route(notificationsManifest.basePath, notificationsManifest.routes)
    .route(roadmapManifest.basePath, roadmapManifest.routes)
    .route(updatesManifest.basePath, updatesManifest.routes)
    .route(devManifest.basePath, devManifest.routes);
  return app;
}

export type AppType = ReturnType<typeof createApp>;
