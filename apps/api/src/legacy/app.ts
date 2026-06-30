import { Hono } from 'hono';
import {
  cors,
  devOnly,
  errorHandler,
  envMiddleware,
  platformMiddleware,
  dbMiddleware,
  redisMiddleware,
  sessionMiddleware,
  aiClientMiddleware,
  mediaStorageMiddleware,
  helcimMiddleware,
  ironSessionMiddleware,
  csrfProtection,
  securityHeaders,
  versionCheck,
  requestLog,
} from './middleware/index.js';
import {
  healthRoute,
  chatRoute,
  devRoute,
  conversationsRoute,
  keysRoute,
  membersRoute,
  linksRoute,
  messageSharesRoute,
  publicSharesRoute,
  mediaRoute,
  trialChatRoute,
  modelsRoute,
  roadmapRoute,
  billingRoute,
  webhooksRoute,
  opaqueAuthRoute,
  deleteAccountRoute,
  websocketRoute,
  budgetsRoute,
  usersRoute,
  forksRoute,
  deviceTokensRoute,
  tokenLoginRoute,
  updatesRoute,
  usageRoute,
  userPreferencesRoute,
} from './routes/index.js';
import type { AppEnv } from './types.js';

export type { Bindings } from './types.js';

export function createApp() {
  const base = new Hono<AppEnv>();

  base.use('*', cors());
  base.use('*', securityHeaders());
  base.use('*', platformMiddleware());
  base.use('*', envMiddleware());
  base.use('*', requestLog());
  base.use('*', versionCheck());
  base.onError(errorHandler);

  base.use('/api/auth/*', csrfProtection());
  base.use('/api/auth/*', dbMiddleware());
  base.use('/api/auth/*', redisMiddleware());
  base.use('/api/auth/*', ironSessionMiddleware());

  // Highest-stakes mutating route — enforce sessionActive + passwordChangedAt
  // revocation, same envelope as /api/conversations/*. Other /api/auth/* routes
  // intentionally skip sessionMiddleware because they run during pending-2FA;
  // delete-account rejects pending-2FA in its preflight so the mount is safe.
  base.use('/api/auth/delete-account/*', sessionMiddleware());

  base.use('/api/conversations/*', csrfProtection());
  base.use('/api/conversations/*', dbMiddleware());
  base.use('/api/conversations/*', redisMiddleware());
  base.use('/api/conversations/*', ironSessionMiddleware());
  base.use('/api/conversations/*', sessionMiddleware());

  base.use('/api/members/*', csrfProtection());
  base.use('/api/members/*', dbMiddleware());
  base.use('/api/members/*', redisMiddleware());
  base.use('/api/members/*', ironSessionMiddleware());
  base.use('/api/members/*', sessionMiddleware());

  base.use('/api/links/*', csrfProtection());
  base.use('/api/links/*', dbMiddleware());
  base.use('/api/links/*', redisMiddleware());
  base.use('/api/links/*', ironSessionMiddleware());
  base.use('/api/links/*', sessionMiddleware());

  base.use('/api/budgets/*', csrfProtection());
  base.use('/api/budgets/*', dbMiddleware());
  base.use('/api/budgets/*', redisMiddleware());
  base.use('/api/budgets/*', ironSessionMiddleware());
  base.use('/api/budgets/*', sessionMiddleware());

  base.use('/api/shares/*', dbMiddleware());
  // The public share endpoint is unauthenticated but rate-limited by IP via the
  // shareGetIpRateLimit registry entry, so it needs Redis access. Mount AFTER
  // dbMiddleware so the redis client is available alongside the DB client when
  // the route handler runs.
  base.use('/api/shares/*', redisMiddleware());
  base.use('/api/shares/*', mediaStorageMiddleware());

  base.use('/api/messages/*', csrfProtection());
  base.use('/api/messages/*', dbMiddleware());
  base.use('/api/messages/*', redisMiddleware());
  base.use('/api/messages/*', ironSessionMiddleware());
  base.use('/api/messages/*', sessionMiddleware());

  base.use('/api/media/*', csrfProtection());
  base.use('/api/media/*', dbMiddleware());
  base.use('/api/media/*', redisMiddleware());
  base.use('/api/media/*', ironSessionMiddleware());
  base.use('/api/media/*', sessionMiddleware());
  base.use('/api/media/*', mediaStorageMiddleware());

  base.use('/api/forks/*', csrfProtection());
  base.use('/api/forks/*', dbMiddleware());
  base.use('/api/forks/*', redisMiddleware());
  base.use('/api/forks/*', ironSessionMiddleware());
  base.use('/api/forks/*', sessionMiddleware());

  base.use('/api/keys/*', csrfProtection());
  base.use('/api/keys/*', dbMiddleware());
  base.use('/api/keys/*', redisMiddleware());
  base.use('/api/keys/*', ironSessionMiddleware());
  base.use('/api/keys/*', sessionMiddleware());

  base.use('/api/chat/*', csrfProtection());
  base.use('/api/chat/*', dbMiddleware());
  base.use('/api/chat/*', redisMiddleware());
  base.use('/api/chat/*', ironSessionMiddleware());
  base.use('/api/chat/*', sessionMiddleware());
  base.use('/api/chat/*', aiClientMiddleware());
  base.use('/api/chat/*', mediaStorageMiddleware());

  base.use('/api/trial/*', csrfProtection());
  base.use('/api/trial/*', dbMiddleware());
  base.use('/api/trial/*', redisMiddleware());
  base.use('/api/trial/*', aiClientMiddleware());
  base.use('/api/trial/*', mediaStorageMiddleware());

  base.use('/api/models/*', csrfProtection());
  base.use('/api/models/*', aiClientMiddleware());

  // /api/public/* is the namespace for unauthenticated, CDN-cacheable read
  // endpoints. CORS is wildcard for this prefix (see middleware/cors.ts) so
  // pages on any origin — including the Astro marketing site in dev, where
  // it runs on a different port — can fetch without an origin allowlist.
  // Mounts redisMiddleware because both the per-IP rate limiter and the
  // roadmap response cache need it; no DB, session, CSRF, or media-storage
  // belong here by construction.
  base.use('/api/public/*', redisMiddleware());

  base.use('/api/billing/*', csrfProtection());
  base.use('/api/billing/*', dbMiddleware());
  base.use('/api/billing/*', redisMiddleware());
  base.use('/api/billing/*', ironSessionMiddleware());
  base.use('/api/billing/*', sessionMiddleware());
  base.use('/api/billing/*', helcimMiddleware());

  base.use('/api/webhooks/*', dbMiddleware());

  base.use('/api/ws/*', dbMiddleware());
  base.use('/api/ws/*', redisMiddleware());
  base.use('/api/ws/*', ironSessionMiddleware());
  base.use('/api/ws/*', sessionMiddleware());

  base.use('/api/users/*', csrfProtection());
  base.use('/api/users/*', dbMiddleware());
  base.use('/api/users/*', redisMiddleware());
  base.use('/api/users/*', ironSessionMiddleware());
  base.use('/api/users/*', sessionMiddleware());

  base.use('/api/device-tokens/*', csrfProtection());
  base.use('/api/device-tokens/*', dbMiddleware());
  base.use('/api/device-tokens/*', redisMiddleware());
  base.use('/api/device-tokens/*', ironSessionMiddleware());
  base.use('/api/device-tokens/*', sessionMiddleware());

  base.use('/api/usage/*', csrfProtection());
  base.use('/api/usage/*', dbMiddleware());
  base.use('/api/usage/*', redisMiddleware());
  base.use('/api/usage/*', ironSessionMiddleware());
  base.use('/api/usage/*', sessionMiddleware());

  base.use('/api/user-preferences/*', csrfProtection());
  base.use('/api/user-preferences/*', dbMiddleware());
  base.use('/api/user-preferences/*', redisMiddleware());
  base.use('/api/user-preferences/*', ironSessionMiddleware());
  base.use('/api/user-preferences/*', sessionMiddleware());

  base.use('/api/dev/*', csrfProtection());
  base.use('/api/dev/*', devOnly());
  base.use('/api/dev/*', dbMiddleware());
  base.use('/api/dev/*', redisMiddleware());
  base.use('/api/dev/*', aiClientMiddleware());

  const app = base
    .route('/api/health', healthRoute)
    .route('/api/auth', opaqueAuthRoute)
    .route('/api/auth/delete-account', deleteAccountRoute)
    .route('/api/conversations', conversationsRoute)
    .route('/api/members', membersRoute)
    .route('/api/links', linksRoute)
    .route('/api/messages', messageSharesRoute)
    .route('/api/shares', publicSharesRoute)
    .route('/api/media', mediaRoute)
    .route('/api/keys', keysRoute)
    .route('/api/chat', chatRoute)
    .route('/api/forks', forksRoute)
    .route('/api/trial', trialChatRoute)
    .route('/api/models', modelsRoute)
    .route('/api/public/roadmap', roadmapRoute)
    .route('/api/billing', billingRoute)
    .route('/api/webhooks', webhooksRoute)
    .route('/api/ws', websocketRoute)
    .route('/api/budgets', budgetsRoute)
    .route('/api/users', usersRoute)
    .route('/api/device-tokens', deviceTokensRoute)
    .route('/api/auth/token-login', tokenLoginRoute)
    .route('/api/updates', updatesRoute)
    .route('/api/usage', usageRoute)
    .route('/api/user-preferences', userPreferencesRoute)
    .route('/api/dev', devRoute);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
