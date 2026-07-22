# HushBox Legacy Backend — Full Behavior Report

This document is a complete behavioral inventory of the decommissioned legacy backend (everything under `legacy/apps/api`, `legacy/packages/db`, `legacy/packages/realtime`, `legacy/scripts` — 374 TypeScript files). It records **what the legacy system did and what exact values it used** — dollar amounts, cushions, TTLs, timeouts, retry counts, rate limits, cache durations, byte limits, exact copy, enum values, status codes, header/cookie names, cron schedules, and env var names. It does not evaluate, critique, or compare against the new architecture; it is a historical record.

## Methodology

All 374 files were partitioned into 12 non-overlapping groups (see `legacy/LEGACY-FILE-INDEX.md` for the full file list), each read in full by a dedicated subagent. Agents were permitted to read beyond their assigned files anywhere under `legacy/` when a behavior required cross-file context (e.g. a shared constant, a caller in another slice) — those cross-reads are noted inline in each section where relevant. The 12 per-group reports (`legacy/reports/*.md`) are reproduced below verbatim, concatenated in slice order and organized under one table of contents; nothing has been summarized away or reworded from the source reports.

## A note on repeated constants

Some values are foundational enough that multiple groups independently rediscovered and documented them from different call sites (e.g. the paid-tier **50-cent reservation cushion** `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS`, the **`TRIAL_MESSAGE_LIMIT = 5`** daily trial cap, and the **`BILLING_MISMATCH_THRESHOLD_RATIO = 0.5`** evidence-recording threshold). These appear in more than one section below — each occurrence is left in place rather than deduplicated, since each documents that constant's effect at a different call site (billing reservation math vs. chat-turn admission vs. trial-chat route, etc.). Where sections disagree on a value or one flags a discrepancy, that discrepancy is preserved as originally reported (e.g. Group 7's noted mismatch between the welcome email's actual tagline and its own test's asserted tagline).

## Table of Contents

1. [Bootstrap, Middleware & Session/Step-up Auth](#01-bootstrap-middleware-sessionstep-up-auth)
2. [Identity Routes & Account Lifecycle](#02-identity-routes-account-lifecycle)
3. [Conversations, Membership, Forks, Links & Media](#03-conversations-membership-forks-links-media)
4. [Chat Turn Execution & Streaming](#04-chat-turn-execution-streaming)
5. [AI/Model Inference & Catalog](#05-aimodel-inference-catalog)
6. [Billing, Wallets, Ledger & Payments](#06-billing-wallets-ledger-payments)
7. [Notifications: Email & Push](#07-notifications-email-push)
8. [Internal Tooling: Linear, Roadmap, Prompt Builder](#08-internal-tooling-linear-roadmap-prompt-builder)
9. [Realtime & WebSocket](#09-realtime-websocket)
10. [DB Schema, Factories & Zod](#10-db-schema-factories-zod)
11. [Scripts, Seeding & Dev Tooling](#11-scripts-seeding-dev-tooling)
12. [Core Infra Utilities](#12-core-infra-utilities)

---

## 01. Bootstrap, Middleware & Session/Step-up Auth

### App bootstrap (`app.ts`)

`createApp()` builds one `Hono<AppEnv>` instance (`base`), applies global middleware to `'*'`, then mounts per-prefix middleware chains before attaching route modules and returning the composed `app`. `AppType = ReturnType<typeof createApp>` is exported for the RPC client.

#### Global middleware (applied to `'*'`, in order)

1. `cors()`
2. `securityHeaders()`
3. `platformMiddleware()`
4. `envMiddleware()`
5. `requestLog()`
6. `versionCheck()`
7. `base.onError(errorHandler)`

#### Per-prefix middleware chains

| Route prefix | Middleware (in mount order) |
|---|---|
| `/api/auth/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()` |
| `/api/auth/delete-account/*` | + `sessionMiddleware()` (additional mount layered on top of the `/api/auth/*` chain — the only `/api/auth/*` sub-route with session enforcement). Comment: "Highest-stakes mutating route — enforce sessionActive + passwordChangedAt revocation, same envelope as `/api/conversations/*`. Other `/api/auth/*` routes intentionally skip `sessionMiddleware` because they run during pending-2FA; delete-account rejects pending-2FA in its preflight so the mount is safe." |
| `/api/conversations/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()`, `sessionMiddleware()` |
| `/api/members/*` | same 5-step chain as conversations |
| `/api/links/*` | same 5-step chain |
| `/api/budgets/*` | same 5-step chain |
| `/api/shares/*` | `dbMiddleware()`, `redisMiddleware()` (mounted after db "so the redis client is available alongside the DB client"), `mediaStorageMiddleware()`. No CSRF/session/iron-session — public unauthenticated endpoint, rate-limited by IP via `shareGetIpRateLimit`. |
| `/api/messages/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()`, `sessionMiddleware()` |
| `/api/media/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()`, `sessionMiddleware()`, `mediaStorageMiddleware()` |
| `/api/forks/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()`, `sessionMiddleware()` |
| `/api/keys/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()`, `sessionMiddleware()` |
| `/api/chat/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()`, `sessionMiddleware()`, `aiClientMiddleware()`, `mediaStorageMiddleware()` |
| `/api/trial/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `aiClientMiddleware()`, `mediaStorageMiddleware()` — no iron-session/session middleware (unauthenticated trial flow) |
| `/api/models/*` | `csrfProtection()`, `aiClientMiddleware()` |
| `/api/public/*` | `redisMiddleware()` only — "no DB, session, CSRF, or media-storage belong here by construction" (per-IP rate limiter + roadmap cache both need Redis) |
| `/api/billing/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()`, `sessionMiddleware()`, `helcimMiddleware()` |
| `/api/webhooks/*` | `dbMiddleware()` only |
| `/api/ws/*` | `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()`, `sessionMiddleware()` |
| `/api/users/*` | `csrfProtection()`, `dbMiddleware()`, `redisMiddleware()`, `ironSessionMiddleware()`, `sessionMiddleware()` |
| `/api/device-tokens/*` | same 5-step chain |
| `/api/usage/*` | same 5-step chain |
| `/api/user-preferences/*` | same 5-step chain |
| `/api/dev/*` | `csrfProtection()`, `devOnly()`, `dbMiddleware()`, `redisMiddleware()`, `aiClientMiddleware()` (no session middleware; gated instead by `devOnly()`) |

Note: `/api/auth/token-login` is mounted separately as its own route (`.route('/api/auth/token-login', tokenLoginRoute)`) and is NOT covered by the `/api/auth/*` middleware `use()` calls in the same way as other sub-paths (Hono prefix matching still applies the `/api/auth/*` chain, but the route itself is also explicitly listed in `versionCheck`'s `SKIP_PREFIXES`).

#### Route mounting table (`.route(prefix, module)`)

```
/api/health              → healthRoute
/api/auth                → opaqueAuthRoute
/api/auth/delete-account → deleteAccountRoute
/api/conversations       → conversationsRoute
/api/members             → membersRoute
/api/links               → linksRoute
/api/messages             → messageSharesRoute
/api/shares              → publicSharesRoute
/api/media               → mediaRoute
/api/keys                → keysRoute
/api/chat                → chatRoute
/api/forks               → forksRoute
/api/trial               → trialChatRoute
/api/models              → modelsRoute
/api/public/roadmap      → roadmapRoute
/api/billing             → billingRoute
/api/webhooks            → webhooksRoute
/api/ws                  → websocketRoute
/api/budgets             → budgetsRoute
/api/users               → usersRoute
/api/device-tokens       → deviceTokensRoute
/api/auth/token-login    → tokenLoginRoute
/api/updates             → updatesRoute
/api/usage               → usageRoute
/api/user-preferences    → userPreferencesRoute
/api/dev                 → devRoute
```

`routes/index.ts` re-exports all of the above route modules from their individual files (one module per resource, e.g. `./health.js`, `./opaque-auth.js`, `./chat.js`, `./trial-chat.js`, etc.).

#### `app.test.ts` observed behaviors

- `GET /api/health` → 200, body `{ status: 'ok', timestamp: <ISO> }` (with fake timers at `2024-01-15T12:00:00.000Z`, timestamp echoes exactly that).
- Dev-mode request log line format: `[req] <ISO> GET /api/health 200 <ms>ms v=<version>`.
- Unauthenticated requests to `/api/conversations` (GET/POST/DELETE `:id`/PATCH `:id`), `/api/members/:id`, `/api/links/:id`, `POST /api/messages/share`, `POST /api/chat/stream` all return 401 with `{ code: 'NOT_AUTHENTICATED' }`.
- Security headers present on every response including CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- CSRF: `POST /api/conversations`, `POST /api/billing/payments`, `POST /api/chat/stream` all reject `Origin: https://evil.com` with 403 `{ code: 'CSRF_REJECTED' }` (with `FRONTEND_URL: http://localhost:5173`); GET requests bypass CSRF regardless of Origin.
- CORS: `Access-Control-Allow-Origin` echoes `FRONTEND_URL` exactly when it matches.
- Unknown routes → 404.
- `POST /api/trial/stream` with a valid body does not 500 (exercises trial chat + rate-limit middleware against a mocked Upstash pipeline response shape `[{ result: null }]` and a mocked AI Gateway response shape `{ data: [] }`).
- `GET /api/dev/personas` in development → 200 with `{ personas: [] }` shape (`Array.isArray`).

### CORS (`middleware/cors.ts`)

- `PUBLIC_NAMESPACE_PREFIX = '/api/public/'`: requests to any path under this prefix get `honoCors({ origin: '*' })` — wildcard origin, no credentials (any origin can fetch; no cookies ever sent since credentials aren't enabled).
- All other paths: allowed origin list built from `[c.env.FRONTEND_URL?, c.env.FRONTEND_PREVIEW_URL?, ...CAPACITOR_ORIGINS]`, with `credentials: true`.
- `CAPACITOR_ORIGINS = ['capacitor://localhost', 'http://localhost']` — always trusted, in every environment (dev and prod), for iOS/Android WebView.
- With no `FRONTEND_URL`/`FRONTEND_PREVIEW_URL` configured, non-Capacitor origins get no `Access-Control-Allow-Origin` header (silently rejected, not an explicit 403 — Hono's `cors()` just omits the header).
- Preflight `OPTIONS` requests return 204 with the appropriate `Access-Control-Allow-Origin`.
- `Access-Control-Allow-Credentials: true` is present for matched non-public origins; absent (null) under `/api/public/*`.

### CSRF protection (`middleware/csrf.ts`)

- `STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])` — only these are checked; GET/HEAD/OPTIONS pass through unconditionally.
- No `Origin` header on a state-changing request → allowed (treated as same-origin).
- `Origin` matching `CAPACITOR_ORIGINS = new Set(['capacitor://localhost', 'http://localhost'])` → always allowed.
- Otherwise, allowed origin set = `[FRONTEND_URL, FRONTEND_PREVIEW_URL].filter(non-null)`. If that list is empty (neither env var configured), the request is rejected — 403 `ERROR_CODE_CSRF_REJECTED` (`{ code: 'CSRF_REJECTED' }`).
- Origin comparison normalizes via `new URL(origin).origin` vs `new URL(allowedUrl).origin` — so trailing slashes and explicit default ports (`:443` for https, `:80` for http) are equivalent to no port. Non-default ports must match exactly.
- Malformed Origin header (fails `new URL()`) → 403 `CSRF_REJECTED`.
- Malformed `FRONTEND_URL` env value → 403 `CSRF_REJECTED` (fails to construct a comparison URL).
- Response status is always 403 on rejection.

### Security headers (`middleware/security.ts`)

Applied after `next()` (post-processing) to every response, unconditionally:

- `Content-Security-Policy` — directives joined with `; `:
  - `default-src 'self'`
  - `script-src 'self'`
  - `style-src 'self' 'unsafe-inline'` (comment: required for Tailwind CSS)
  - `img-src 'self' data: blob:`
  - `connect-src 'self'`
  - `frame-ancestors 'none'`
  - `base-uri 'self'`
  - `form-action 'self'`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer` (comment: "to prevent share link URL leakage")

### Platform detection (`middleware/platform.ts`)

- Reads header `X-HushBox-Platform`.
- Valid values come from `VALID_PLATFORMS` (shared package, not in this scope) — observed test values: `web`, `ios`, `android`, `android-direct`.
- Unknown/missing/empty header → defaults to `'web'`.
- Sets `c.var.platform`. Explicitly documented as client-provided and informational only — "Never trust it for security-critical decisions — use it for feature toggling (e.g. payment disabled on App Store builds) and analytics only."

### Version check / forced upgrade (`middleware/version-check.ts`)

- `SKIP_VERSIONS = new Set(['dev-local', 'test'])` — when the resolved server version is one of these, the check is skipped entirely regardless of client header.
- `SKIP_PREFIXES = ['/api/health', '/api/webhooks', '/api/auth/token-login', '/api/updates']` — requests to these path prefixes always bypass the version check.
- If the client sends no `X-App-Version` header, the check is skipped (assumed same-origin browser / non-versioned caller).
- Server version = `getVersionOverride() ?? c.env.APP_VERSION` (dev-only in-memory override takes priority). If neither is set, throws `Error('APP_VERSION environment variable is required')`.
- Mismatch → HTTP 426 (`Upgrade Required`) with body `{ code: 'UPGRADE_REQUIRED', currentVersion: <serverVersion> }`.
  - For `platform === 'web'`: no `updateUrl` field.
  - For any other platform (`ios`, `android`, `android-direct`): adds `updateUrl: /api/updates/download/${platform}/${serverVersion}`.
- Exact-match versions pass through.

#### Version override (`lib/version-override.ts`)

- Module-level singleton `versionOverride: string | null`, persists across requests only in long-lived Wrangler dev processes (resets on every cold start in production).
- `getVersionOverride()`, `setVersionOverride(version)`, `clearVersionOverride()`.
- Comment notes the mutator is only reachable via the dev-only `POST /api/dev/set-version` endpoint, so production never sets it.

### Request logging (`middleware/request-log.ts`)

- Dev-only: if `c.get('envUtils').isProduction`, skips logging entirely (calls `next()` and returns — no line emitted).
- Line format (via `console.log`):
  ```
  [req] <ISO-timestamp> <METHOD> <path> <status> <durationMs>ms v=<X-App-Version|none>
  ```
  Exact regex proven by test: `/^\[req\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z GET \/api\/ok 200 \d+ms v=local-mobile-test$/`.
- Logs `path` (not the full URL with query string) deliberately — comment: query strings can carry user-supplied content (recovery tokens, share IDs, search text) that shouldn't land in a captured artifact.
- `v=` field defaults to literal string `none` when `X-App-Version` header absent.
- Still logs even when the downstream handler throws and `onError` produces a 500 (duration/status reflect the error response).
- Comment: consumed downstream by `scripts/lib/extract-mobile-api-log.ts` via the `v=` field to separate APK traffic from sibling sessions sharing the same local API instance; wrangler dev's stdout tee captures the line into `apps/api/.wrangler-<port>.log`.

### Error handling (`middleware/error.ts`)

- `errorHandler: ErrorHandler`:
  - `HTTPException` instances → `err.getResponse()` (status/body as thrown).
  - Any other error → `500` with body `createErrorResponse(ERROR_CODE_INTERNAL)` → `{ code: 'INTERNAL' }`.

### Dev-only gating (`middleware/dev-only.ts`)

- `devOnly()` checks `createEnvUtilities(c.env).isDev`.
- Fail-closed: only an explicit development mode passes; production AND any unrecognized `NODE_ENV` value (e.g. `'staging'`) are both denied.
- Denial response: 404 with `{ code: 'NOT_FOUND' }` (`ERROR_CODE_NOT_FOUND`) — deliberately a 404 (route doesn't appear to exist) rather than 403.

### Environment / dependency-wiring middleware (`middleware/dependencies.ts`)

- `dbMiddleware()`: builds `createDb(dbConfig)`. In dev (`envUtils.isDev`), `dbConfig = { connectionString: c.env.DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG }`; otherwise `{ connectionString: c.env.DATABASE_URL }` only.
- `redisMiddleware()`: requires both `c.env.UPSTASH_REDIS_REST_URL` and `c.env.UPSTASH_REDIS_REST_TOKEN`; if either is missing, throws `Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required')` (surfaces as 500 via the error handler). Otherwise `c.set('redis', createRedisClient(url, token))`.
- `envMiddleware()`: `c.set('envUtils', createEnvUtilities(c.env ?? {}))`. Handles `c.env` being `undefined` in unit tests.
- `helcimMiddleware()`: `c.set('helcim', getHelcimClient(c.env, createEvidenceConfig(c)))`.
- `ironSessionMiddleware()`: thin re-export wrapper around `createIronSessionMiddleware()`.
- `mediaStorageMiddleware()`: `c.set('mediaStorage', getMediaStorage(c.env, createEvidenceConfig(c)))`. Relies on `db`/`envUtils` already being set by earlier prefix-scoped middleware.
- `aiClientMiddleware()`: `c.set('aiClient', getAIClient(c.env, { evidence, mockConfig }))`. Builds a `mockConfig` object (dev/E2E-only — production ignores these headers at the env fork inside `getAIClient`) from three headers:
  - `x-mock-classifier-resolution` → `mockConfig.classifierResolution` (raw string value, any non-`undefined` value passes through)
  - `x-mock-classifier-failure: 'true'` → `mockConfig.classifierFailure = true`
  - `x-mock-failing-models` → comma-split, trimmed, filtered for truthy entries → `mockConfig.failingModels: string[]` (only set if resulting array is non-empty)
  - `x-mock-classifier-delay-ms` → `Number.parseInt(header, 10)`; only set as `mockConfig.classifierDelayMs` if `Number.isFinite(parsed) && parsed > 0`.

#### `sessionMiddleware()` — the OPAQUE-auth session gate

Full logic:
1. Reads `sessionData` from context (set upstream by `ironSessionMiddleware`).
2. Computes `hasLinkKey` from header `x-link-public-key` OR query param `linkPublicKey` (WebSocket upgrades can't set custom headers, so link guests pass the key as a query param on WS connect).
3. If no `sessionData.userId`:
   - If `hasLinkKey` → passes through to `next()` with no `user` set (link-guest path continues downstream, typically into `requireLinkGuest`/`requirePrivilege`).
   - Else → 401 `{ code: 'NOT_AUTHENTICATED' }`.
4. Otherwise calls `validateSessionState(sessionData, redis, path)`:
   - Looks up `sessionActive` Redis key (`sessions:user:active:<userId>:<sessionId>`) — if absent → `{ code: ERROR_CODE_SESSION_REVOKED, status: 401 }` (`SESSION_REVOKED`).
   - Looks up `passwordChangedAt` Redis key (`auth:pw-changed:<userId>`) — if present AND `sessionData.createdAt < passwordChangedAt` → `{ code: ERROR_CODE_PASSWORD_CHANGED, status: 401 }` (`PASSWORD_CHANGED`).
   - If `sessionData.pending2FA`:
     - If `sessionData.pending2FAExpiresAt < Date.now()` → `{ code: ERROR_CODE_2FA_EXPIRED, status: 401 }` (`2FA_EXPIRED`).
     - Else → `{ code: ERROR_CODE_2FA_REQUIRED, status: 403 }` (`2FA_REQUIRED`).
   - If `sessionData.billingOnly` is true: request path must start with `/api/billing` or `/api/auth`, else `{ code: ERROR_CODE_BILLING_SESSION_RESTRICTED, status: 403 }` (`BILLING_SESSION_RESTRICTED`).
   - Else `null` (valid).
5. If `validateSessionState` returns a rejection:
   - Special case: if `hasLinkKey` is true AND the rejection code is NOT `2FA_REQUIRED`, falls back to link-guest path (`next()` without `user`) instead of failing — i.e. a revoked/expired/billing-restricted session with a link key present degrades gracefully to guest access. `2FA_REQUIRED` is the one rejection that never falls back — "user must complete 2FA" — always returns the 403 even with a link key.
   - Otherwise returns the JSON error with the mapped status.
6. If session state is valid: looks up the user row from `users` by `sessionData.userId` (fields: `id, email, username, emailVerified, totpEnabled, hasAcknowledgedPhrase, publicKey`).
   - If no user row found: falls back to link guest if `hasLinkKey`, else 404 `{ code: 'USER_NOT_FOUND' }` (`ERROR_CODE_USER_NOT_FOUND`).
   - Else sets `c.set('user', user)` and `c.set('session', sessionData)`, then `next()`.

### Iron-session cookie config (`lib/session.ts`, `middleware/iron-session.ts`)

- `SESSION_COOKIE_NAME = 'hushbox_session'`
- `SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30` = 2,592,000 seconds (30 days)
- `getSessionOptions(secret, isProduction)` returns:
  - `password: secret`
  - `cookieName: 'hushbox_session'`
  - `cookieOptions.httpOnly: true`
  - `cookieOptions.secure: isProduction` (`false` in dev, `true` in production)
  - `cookieOptions.sameSite: isProduction ? 'none' : 'lax'` (comment: `'none'` in production is "for Capacitor WebView compatibility")
  - `cookieOptions.maxAge: SESSION_MAX_AGE_SECONDS`
- `SessionData` shape: `{ sessionId, userId, email: string|null, username, emailVerified, totpEnabled, hasAcknowledgedPhrase, pending2FA, pending2FAExpiresAt, createdAt, billingOnly?: boolean }`. `billingOnly` comment: "When true, session is restricted to billing routes only (mobile → web handoff)."
- `ironSessionMiddleware` (`createIronSessionMiddleware`):
  - If `c.env.IRON_SESSION_SECRET` is not configured → `sessionData = null`, never calls `getIronSession`.
  - Else calls `getIronSession<SessionData>(c.req.raw, c.res, options)` with the options above.
  - Validity check `isValidSession`: object with a non-empty string `userId` — any other shape (including `null`/empty object/missing `userId`) → `sessionData = null`.

### Redis-key registry values relevant to session/step-up auth (`lib/redis-registry.ts` — read for cross-file context)

All keys defined via `defineKey`/`defineRateLimitKey` with a Zod schema, a TTL (seconds unless noted), and a `buildKey` template. Session/step-up-relevant entries:

| Registry key | Redis key template | TTL (seconds) | Schema |
|---|---|---|---|
| `opaquePendingChangePassword` | `opaque:change-pw:<sessionId>` | 300 (5 min) | `{ userId, expectedSerialized: number[] }` |
| `opaquePending2FADisable` | `opaque:2fa-disable:<sessionId>` | 300 (5 min) | `{ userId, expectedSerialized: number[] }` |
| `opaquePendingDeleteAccount` | `opaque:delete-account:<sessionId>` (pattern inferred from sibling keys; base `opaque:...:<sessionId>`) | 300 (5 min) | `{ userId, expectedSerialized: number[] }` |
| `opaquePendingRegistration` | `opaque:pending:<sessionId>` | 300 (5 min) | `{ email, username, userId, existing?: boolean }` |
| `opaquePendingLogin` | `opaque:login:<sessionId>` | 120 (2 min) | `{ identifier, userId: string\|null, expectedSerialized: number[] }` |
| `opaquePendingRecoveryReset` | (300s bucket, `opaque:...` family) | 300 (5 min) | — |
| `totpUsedCode` | `totp:used:<userId>:<code>` | 120 (2 min) | replay marker, value `'1'` |
| `totpPendingSetup` | — | 300 (5 min) | — |
| `sessionActive` | `sessions:user:active:<userId>:<sessionId>` | `SESSION_MAX_AGE_SECONDS` = 2,592,000 (30 days) | coerced string |
| `passwordChangedAt` | `auth:pw-changed:<userId>` | `SESSION_MAX_AGE_SECONDS` = 2,592,000 (30 days) | coerced number (epoch ms) |

Comment on the OPAQUE pending-state keying scheme: all OPAQUE handshake state (registration, login, change-password, 2FA-disable, delete-account, recovery-reset) is keyed by a server-issued UUID `sessionId`, not by the user's identifier/`userId` — the `identifier`/`userId` is instead stored inside the Redis value so the finish step can verify the caller's session matches. This is defense-in-depth against a stolen session token being used against a different account, and also avoids a documented prior race where two concurrent handshakes for the same user clobbered each other's `expected` value under identifier-keying.

Rate-limit and lockout keys visible in the registry (not directly exercised by this scope's files but read for context of `checkRateLimit`/`recordFailedAttempt`/`isLockedOut` in `lib/rate-limit.ts`):

| Registry key | TTL (s) | maxAttempts | windowSeconds |
|---|---|---|---|
| `loginUserRateLimit` | 900 | 5 | 900 |
| `loginIpRateLimit` | 900 | 20 | 900 |
| `registerEmailRateLimit` | 3600 | 3 | 3600 |
| `registerIpRateLimit` | 3600 | 10 | 3600 |
| `twoFactorUserRateLimit` | 900 | 10 | 900 |
| `deleteAccountUserRateLimit` | 3600 | 3 | 3600 |
| `recoveryUserRateLimit` | 3600 | 3 | 3600 |
| `recoveryIpRateLimit` | 3600 | 10 | 3600 |
| `recoveryGetKeyUserRateLimit` | 3600 | 3 | 3600 |
| `recoveryGetKeyIpRateLimit` | 3600 | 10 | 3600 |
| `verifyTokenRateLimit` | 3600 | 10 | 3600 |
| `verifyIpRateLimit` | 3600 | 30 | 3600 |
| `mediaDownloadUserRateLimit` | — | 60 | 60 |
| `shareGetIpRateLimit` | 60 | 30 | 60 |
| `shareCreateUserRateLimit` | 60 | 20 | 60 |
| `trialChatStreamIpRateLimit` | 60 | 20 | 60 |
| `roadmapIpRateLimit` | — | 30 | 60 |
| `chatStreamUserRateLimit` | — | 30 | 60 (confirmed by `rate-limit.routes.test.ts`: "per-user, 30/min") |

Lockout keys (`LOCKOUT_KEY_NAMES` in `lib/rate-limit.ts`): `loginLockout`, `twoFactorLockout`, `recoveryLockout`, `deleteAccountLockout`.

Other registry TTLs seen: `trialTokenUsage` / `trialIpUsage`: 86,400s (24h); `chatReservedBalance` / `groupMemberReserved` / `conversationReserved`: 180s; `billingLoginToken`: 60s; `roadmapCache`: 3600s (1h).

### Auth constants (`constants/auth.ts`)

- `EMAIL_VERIFY_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000` = 86,400,000 ms (24 hours).

### OPAQUE step-up (`lib/opaque-step-up.ts`)

Generic step-up re-authentication used for change-password, 2FA-disable, and delete-account flows. Shares one Redis schema shape (`{ userId, expectedSerialized }`) across the three key names via `OpaqueStepUpKeyName = 'opaquePendingChangePassword' | 'opaquePending2FADisable' | 'opaquePendingDeleteAccount'`.

- `startOpaqueStepUp(args)`:
  - Calls `opaqueStepUpInit({ masterSecret, opaqueRegistration, username, ke1 })` → `{ ke2, expectedSerialized }`.
  - Generates `sessionId = crypto.randomUUID()`.
  - Persists `{ userId, expectedSerialized }` under the given `redisKeyName` keyed by `sessionId`, with the registry-default TTL (300s / 5 min for all three step-up keys).
  - Returns `{ ke2, sessionId }`.
  - Concurrent starts for the same user produce distinct `sessionId`s and distinct Redis slots — no clobbering (verified by test).
- `finishOpaqueStepUp(args)`:
  - Looks up pending state by `sessionId`.
  - No entry → `{ ok: false, reason: 'no-pending' }`.
  - Entry present but `pending.userId !== args.userId` → deletes the entry and returns `{ ok: false, reason: 'session-mismatch' }` (defense against a stolen session token being replayed against a different account's step-up flow).
  - Calls `opaqueStepUpFinish({ ke3, expectedSerialized })`.
  - On crypto failure (`bad-proof` etc.) → returns the failure reason, does NOT delete the Redis entry (allows retry within the TTL).
  - On success → deletes the Redis entry and returns `{ ok: true }`.
- `FinishResult` reason union: `'no-pending' | 'bad-proof' | 'session-mismatch'` (plus whatever `opaqueStepUpFinish` itself can return).

### TOTP step-up + replay protection (`lib/totp-step-up.ts`)

- Shared internal helper `verifyWithReplayProtection` runs the replay check **before** the crypto verification, explicitly preserving "the prior inline implementation's timing profile" — reordering would change observable latency on the replay path (an intentional constant-behavior-order comment, not a timing-attack mitigation claim).
- Replay marker: Redis key `totp:used:<userId>:<code>` (registry key `totpUsedCode`), value `'1'`, TTL = registry default (120s / 2 min, confirmed by both step-up and setup-code tests referencing `REDIS_REGISTRY.totpUsedCode.ttl`).
- `verifyTotpStepUp(args)`: for already-enrolled users — reads the stored *encrypted* TOTP secret from the DB, decrypts, verifies.
  - Replay already used → `{ ok: false, reason: 'replay' }`, no crypto call, no new marker.
  - Bad code → `{ ok: false, reason: 'invalid-code' }`, no Redis write.
  - Corrupted ciphertext → `{ ok: false, reason: 'decrypt-failed' }`, no Redis write.
  - Valid → `{ ok: true }`, writes replay marker.
  - Accepts an optional `window` override forwarded directly to the crypto layer (test proves default window rejects a code generated 90 seconds prior — i.e. default window ⇒ 1 step — while `window: 3` accepts the same code 90s later, i.e. 3 steps of ~30s each ≈ 90s tolerance).
- `verifyTotpSetupCode(args)`: for one-shot initial enrollment confirmation — verifies against a *plaintext* secret held in Redis pending state (not yet written to the DB as ciphertext). Same replay-protection wrapper, narrower failure-reason type (`'invalid-code' | 'replay'` only — no `decrypt-failed` since there's no encrypted blob to fail on).
  - Replay → does not invoke the crypto layer at all (skips even attempting verification).

### Client IP extraction & hashing (`lib/client-ip.ts`)

- `hashIp(ip)`: SHA-256 hex digest (`createHash('sha256').update(ip).digest('hex')`) — deterministic, 64 hex characters.
- `getClientIp(c, fallback = 'unknown')`: header precedence, first match wins:
  1. `cf-connecting-ip` (exact value)
  2. `x-forwarded-for` — takes the first comma-separated entry, trimmed; empty first segment falls through
  3. `x-real-ip`
  4. `fallback` (default string literal `'unknown'`, caller can override, e.g. `'0.0.0.0'`)

### `getUser` helper (`lib/get-user.ts`)

- Narrows `c.get('user')` to non-null; throws `Error('requireAuth middleware missing')` if `user` is falsy. Documented as "Safe after `requireAuth()` or `requirePrivilege()` middleware."

### `safeExecutionCtx` (`lib/safe-execution-ctx.ts`)

- Wraps `c.executionCtx` access in try/catch, returning `undefined` if the getter throws (accessed outside the Workers runtime) or if the property itself is falsy/undefined.

### `safeJsonParse` (`lib/safe-json.ts`)

- `safeJsonParse<T>(response, context)`: awaits `response.json()`; on parse failure throws `Error("${context}: expected JSON but received unparseable body (HTTP ${status})")`. Exact message format verified for empty bodies, HTML bodies, and various status codes (403/502/503/504 all exercised in tests, all just interpolated into the message).

### `requireAuth` (`middleware/require-auth.ts`)

- No `user` on context → 401 `{ code: 'NOT_AUTHENTICATED' }`.
- User present → `c.set('callerId', user.id)`, then `next()`. `callerId` is the uniform principal identifier consumed downstream by rate limiters (works alongside `requirePrivilege`, which sets `callerId` to either `user.id` or the link guest's `linkId`).

### `requirePrivilege` (`middleware/require-privilege.ts`)

- `requirePrivilege(minLevel: MemberPrivilege, options?)`. `MemberPrivilege` ordering implied by `getPrivilegeLevel` (from `@hushbox/shared`, out of scope) — tests confirm the total order `read < write < admin < owner`.
- `options`:
  - `allowLinkGuest?: boolean` — falls back to link-guest resolution (header/query `x-link-public-key`) when no session user, or when a link key is present even with a session user (link key takes priority over the session for single-conversation requests).
  - `includeOwnerId?: boolean` — additionally queries the conversation owner and sets `c.set('conversationOwnerId', ownerId)`; only valid for single-conversation requests.
  - `resolve?: (c) => string[]` — defaults to reading the `:conversationId` route param as a single-element array; can be overridden for batch endpoints operating on multiple conversation IDs at once (via a custom header/body in the caller).
- No resolved conversation IDs → 400 `{ code: 'VALIDATION' }`.
- Unauthenticated + no link-guest fallback → 401 `{ code: 'NOT_AUTHENTICATED' }`.
- Unauthenticated + link key present but link/member not found → 401 (falls through — the plain `requireLinkGuest` middleware differentiates this from `requirePrivilege`, see below).
- Authenticated but missing membership in ANY requested conversation → all-or-nothing: 404 `{ code: 'CONVERSATION_NOT_FOUND' }` (single-conversation requests get one more chance at link-guest fallback before the 404).
- Membership present but privilege below `minLevel` in ANY conversation → 403 `{ code: 'PRIVILEGE_INSUFFICIENT' }`.
- Success: `c.set('callerId', user.id)` (or `linkId` for link guests) and `c.set('members', Map<conversationId, {id, privilege, visibleFromEpoch}>)`.
- Batch membership lookup query filters `conversationMembers` by `inArray(conversationId, ids)`, `eq(userId, user.id)`, `isNull(leftAt)` (excludes members who have left).
- Owner lookup query: `select userId from conversations where id = conversationId limit 1`; conversation not found during this step → 404 `{ code: 'CONVERSATION_NOT_FOUND' }`.

### `requireLinkGuest` (`middleware/require-link-guest.ts`)

Standalone middleware (distinct from `requirePrivilege`'s `allowLinkGuest` option) — always requires a link guest, never accepts a session user:

- No `x-link-public-key` header → 401 `{ code: 'UNAUTHORIZED' }`.
- Header present but `resolveLinkGuest` returns null:
  - If the route has no `:conversationId` param → 401 `{ code: 'UNAUTHORIZED' }`.
  - If it does have a `:conversationId` param → 404 `{ code: 'LINK_NOT_FOUND' }` (differentiates "no header at all" from "header present but link/member not found").
- Success: `c.set('linkGuest', { linkId, publicKey })` and `c.set('members', Map([[conversationId, { id, privilege, visibleFromEpoch }]]))`.
- Throws `Error('conversationId param required for requireLinkGuest')` if resolution succeeded but no `conversationId` param exists (defect guard — resolution can't succeed without one, since `resolveLinkGuest` itself requires the param).

### `resolveLinkGuest` / `resolveLinkGuestByKey` (`middleware/resolve-link-guest.ts`)

- `resolveLinkGuest(c)`: reads `x-link-public-key` header OR `linkPublicKey` query param, plus the `:conversationId` route param. Both required, else returns `null`.
  - Looks up the active shared link via `findActiveSharedLink(db, conversationId, linkPublicKeyBytes)` (helper defined elsewhere, `lib/db-helpers.js` — out of scope).
  - Looks up the conversation-member row for that link (`conversationMembers.linkId = sharedLink.id AND leftAt IS NULL`), `limit(1)`.
  - Returns `{ linkId, publicKey, displayName, member: { id, privilege, visibleFromEpoch } }` or `null` at any failed step.
- `resolveLinkGuestByKey(c)`: variant that does NOT require a `:conversationId` route param — resolves purely from the public key, for routes keyed by a different identifier (documented example: `/api/media/:contentItemId`). Looks up `sharedLinks` directly by `linkPublicKey` (documented as globally unique via the `shared_links_public_key_unique` index) and `isNull(revokedAt)`, then the member row the same way. Returns `{ linkId, publicKey, conversationId, member }` or `null`. The returned `conversationId` lets the caller scope downstream queries.

### `LINK_PUBLIC_KEY_HEADER` constant (`middleware/constants.ts`)

- `'x-link-public-key'` — lowercase per HTTP/2 convention.

### Rate-limit middleware (`middleware/rate-limit.ts`)

- `rateLimitByCaller(keyName)`: requires `c.get('callerId')` to already be set (by `requireAuth`/`requirePrivilege`); throws `Error('rateLimitByCaller requires callerId — mount requirePrivilege before middleware')` if missing (a 500, signaling a misconfigured route rather than a client error). On limit exceeded → 429 `{ code: 'RATE_LIMITED', details: { retryAfterSeconds } }`.
- `rateLimitByIp(keyName)`: derives `ipHash = hashIp(getClientIp(c))`, keys the limit by that hash. Same 429 shape on exceed.
- Both delegate to `checkRateLimit(redis, keyName, ...args)` from `lib/rate-limit.ts`.
- Test-proven concrete windows: `chatStreamUserRateLimit` blocks the 31st request within 60s (i.e. cap 30/60s), `shareGetIpRateLimit`/generic IP limiter in the unit test also uses a 30-request cap with a 60s window, `mediaDownloadUserRateLimit` blocks the 61st request in 60s (cap 60/60s), `shareCreateUserRateLimit` blocks the 21st request in 60s (cap 20/60s). Window reset is exact: advancing fake time by 61,000 ms re-admits the next request (i.e. the block is not permanent — a fresh window opens once `windowSeconds` has elapsed).
- Isolation confirmed: distinct IPs get independent windows (one IP's block never affects another).

#### `lib/rate-limit.ts` mechanism (read for context)

- `checkRateLimit`: reads count/`firstAttempt` from Redis (`rateLimitDataSchema = { count: number, firstAttempt: number }`); if `count >= maxAttempts` within the still-open window, denies with `retryAfterSeconds = ceil((windowExpiry - now) / 1000)`; else increments count and re-persists with a TTL override equal to the remaining window time.
- `recordFailedAttempt` / `isLockedOut` / `clearLockout`: a separate lockout mechanism layered on top of certain rate-limit keys (`LOCKOUT_KEY_NAMES = ['loginLockout', 'twoFactorLockout', 'recoveryLockout', 'deleteAccountLockout']`) — when the optional lockout key name is passed, exceeding the underlying rate limit also sets an explicit lockout marker (`{ lockoutTriggered: true }`) whose expiry is read back via `isLockedOut` as a raw epoch-ms value (`lockoutUntil`), producing its own `retryAfterSeconds`.
- `clearLockout` deletes both the lockout key and (optionally) the paired rate-limit key together — used on a subsequent successful auth to reset both.

### Scheduled/cron handler (`scheduled.ts`)

- `scheduledHandler(event, env, ctx)` — wired as the Worker's cron entry point; wrangler.toml (outside this scope's file list) documented via comment as running **daily at 3am UTC** (also matched by the test fixture's `cron: '0 3 * * *'`).
- Requires `env.DATABASE_URL`; throws `Error('DATABASE_URL is required for the scheduled handler')` if missing (no DB client is built, `runR2Gc` never invoked).
- Builds its own DB client (dev mode uses `LOCAL_NEON_DEV_CONFIG`, same dev/prod branching as `dbMiddleware`) and its own media storage client via `createMediaStorage(env)` — no Hono context available in a cron handler.
- Runs two independent maintenance tasks in sequence, each wrapped so a failure in the first does not prevent the second from running:
  1. `runR2Gc({ storage, db, now: Date.now(), evidence: { db, isCI } })` — logs result via `console.warn('r2-gc', stats)` on success, `console.error('r2-gc failed', error)` on failure.
  2. `purgeExpiredDeletionEvents(db, new Date())` — logs via `console.warn('account-deletion-events-purge', purgeStats)` / `console.error('account-deletion-events-purge failed', error)`.
- Error propagation: the **first** error encountered (R2 GC's, if it fails; else the purge's) is captured and re-thrown after both tasks have run, "so Cloudflare records the cron run as failed." If both fail, the R2-GC error is the one rethrown (first-error-wins), but both failures are still logged via `console.error`.
- Integration test confirms `purgeExpiredDeletionEvents` deletes `account_deletion_events` rows with `deletedAt` older than **90 days**, while keeping rows newer than 90 days (tested boundary: a row at 89 days old is kept, a row at 91 days old is purged; 90 days = `90 * 24 * 60 * 60 * 1000` ms threshold, i.e. retention window is 90 days).

### Bindings & context variables (`types.ts`)

#### `Bindings` (Cloudflare env vars referenced by this scope's code)

`DATABASE_URL` (required), `APP_VERSION` (required), `NODE_ENV?`, `CI?`, `E2E?`, `RESEND_API_KEY?`, `AI_GATEWAY_API_KEY?`, `PUBLIC_MODELS_URL?`, `HELCIM_API_TOKEN?`, `HELCIM_WEBHOOK_VERIFIER?`, `FCM_PROJECT_ID?`, `FCM_SERVICE_ACCOUNT_JSON?`, `FRONTEND_URL?`, `FRONTEND_PREVIEW_URL?`, `UPSTASH_REDIS_REST_URL?`, `UPSTASH_REDIS_REST_TOKEN?`, `OPAQUE_MASTER_SECRET?`, `IRON_SESSION_SECRET?`, `R2_S3_ENDPOINT?`, `R2_ACCESS_KEY_ID?`, `R2_SECRET_ACCESS_KEY?`, `R2_BUCKET_MEDIA?`, `CONVERSATION_ROOM?` (Durable Object namespace binding), `APP_BUILDS?` (R2 bucket binding).

Comments on the R2 fields: `R2_S3_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` are described as "full read/write scope, used by aws4fetch for all storage operations"; `R2_BUCKET_MEDIA` is "R2 bucket name for media. Used by the aws4fetch S3 client for all operations."

#### `Variables` (per-request context set by this scope's middleware)

`platform`, `db`, `redis`, `aiClient`, `mediaStorage`, `helcim`, `envUtils`, `user` (nullable shape: `{ id, email: string|null, username, emailVerified, totpEnabled, hasAcknowledgedPhrase, publicKey: Uint8Array }`), `members: Map<conversationId, {id, privilege, visibleFromEpoch}>`, `callerId`, `conversationOwnerId`, `linkGuest: { linkId, publicKey } | null`, `mediaCaller` (tagged union: `{ kind: 'user', userId, publicKey }` or `{ kind: 'link', linkId, publicKey }`, set by `requireMediaCaller()` — out of scope — for `/api/media/:id/download-url`, used for the epoch-gating check against `epoch_members`), `session: SessionData | null`, `sessionData: SessionData | null`.

`R2BucketBinding` and `DONamespaceBinding` are minimal locally-declared interface shapes (get/put/delete for R2; idFromName/get→fetch for the DO namespace) — deliberately narrow "to avoid leaking `@cloudflare/workers-types` globally."


---

## 02. Identity Routes & Account Lifecycle

Scope: `apps/api/src/legacy/routes/{delete-account,device-tokens,health,keys,opaque-auth,token-login,updates,user-preferences,users}.ts` (+ their tests), `apps/api/src/legacy/services/account-deletion/delete-user.ts`, `apps/api/src/legacy/services/keys/*`, `apps/api/src/legacy/services/users/user-search.ts`, plus supporting libs read for context: `lib/session.ts`, `lib/opaque-step-up.ts`, `lib/totp-step-up.ts`, `lib/rate-limit.ts`, `lib/redis-registry.ts`, `lib/client-ip.ts`, `lib/version-override.ts`, `constants/auth.ts`.

---

### Session mechanics (cross-cutting)

- Cookie name: `hushbox_session`.
- `SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30` — 30 days.
- Cookie options: `httpOnly: true`; `secure: isProduction`; `sameSite: isProduction ? 'none' : 'lax'`; `maxAge` = 30 days.
- Session payload (`SessionData`): `sessionId`, `userId`, `email`, `username`, `emailVerified`, `totpEnabled`, `hasAcknowledgedPhrase`, `pending2FA`, `pending2FAExpiresAt`, `createdAt`, optional `billingOnly` (true only for the mobile→web token-login handoff, restricting the session to billing routes).
- Server-side session liveness is tracked independently of the encrypted cookie via a Redis `sessionActive` key (`sessions:user:active:{userId}:{sessionId}`), TTL = 30 days (same as `SESSION_MAX_AGE_SECONDS`). `GET /me` re-checks this key and returns 401 `SESSION_REVOKED` if absent even when the cookie itself decrypts fine — this is how server-side session revocation (e.g. password change) takes effect without waiting for cookie expiry.
- `passwordChangedAt` Redis key, TTL = 30 days, is written on password change/reset (value = `Date.now()`); nothing in this scope reads it back (referenced as the session-revocation signal but consumption lives elsewhere).

---

### OPAQUE Registration (`POST /register/init`, `POST /register/finish`)

- `registerInitRequestSchema`: `email` (Zod email), `username` (min 1), `registrationRequest: number[]` (min 1).
- Requires `OPAQUE_MASTER_SECRET` and `FRONTEND_URL` configured, else 500 `SERVER_MISCONFIGURED`.
- Dual-key rate limit before any OPAQUE work: `registerEmailRateLimit` (max **3** attempts / **3600s** window, keyed by lowercased email) + `registerIpRateLimit` (max **10** attempts / **3600s** window, keyed by SHA-256 hash of client IP). Both must allow; on violation → 429 `RATE_LIMITED` with `retryAfterSeconds`.
- Anti-enumeration: always processes a real OPAQUE `registerInit` even if the email already exists — the existing-user case pre-generates a random `userId`, marks the pending Redis record `existing: true`, and the eventual `/finish` call returns success with a **fake** random `userId` (no DB insert, no wallet provisioning).
- Pending registration state key `opaquePendingRegistration`, keyed by a server-issued `registerSessionId` UUID (not by email) — TTL **300s** (5 min). Value: `{ email, username: normalizeUsername(username), userId, existing? }`.
- `POST /register/finish` schema: `email`, `registrationRecord: number[]` (min 1), `accountPublicKey`, `passwordWrappedPrivateKey`, `recoveryWrappedPrivateKey` (all base64 strings, min 1), `registerSessionId` (uuid).
- Defense-in-depth: if the pending record's stored email doesn't match the finish request's email, the pending key is deleted and `NO_PENDING_REGISTRATION` (400) is returned (a stolen `registerSessionId` cannot complete registration under a different email).
- On real (non-fake) completion: inserts a `users` row with `emailVerified: false`. Unique-constraint collisions are mapped: `users_username_unique` → `USERNAME_TAKEN` (409); `users_email_unique` → `EMAIL_TAKEN` (409); any other DB error is rethrown to the global handler (500).
- On successful insert: calls `ensureWalletsExist(db, newUser.id)` (wallet provisioning — owned by another slice, invoked here) **after** user creation and **before** clearing the pending Redis key.
- Email verification token: `crypto.randomUUID()`, expiry = `EMAIL_VERIFY_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000` (24 hours) stored as `emailVerifyExpires`.
- Verification URL built as `${FRONTEND_URL}/verify?token=${emailToken}`.
- Sends two emails (both best-effort — failures swallowed, do not block the 201 response): "Verify your email address" (verification link) and "Welcome to HushBox" (separate welcome email, sent after verification email).
- Success response: `201` with `{ success: true, userId }`.

---

### OPAQUE Login (`POST /login/init`, `POST /login/finish`, `POST /login/2fa/verify`)

- `loginInitRequestSchema`: `identifier` (string, min 1, max **254**), `ke1: number[]` (min 1).
- Identifier resolution: contains `@` → email lookup (lowercased); otherwise → username lookup (lowercased).
- Lockout check happens *before* rate-limit check: `isLockedOut(redis, 'loginLockout', userIdentifier)`. If locked → 429 `TOO_MANY_ATTEMPTS` with `retryAfterSeconds`.
- Rate-limit key resolution: userId if found in DB, else the lowercased identifier itself (prevents rate-limit bypass by supplying different unregistered identifiers each time).
- Dual rate limit: `loginUserRateLimit` (max **5** / **900s** window = 15 min) + `loginIpRateLimit` (max **20** / **900s** window). Violation → 429 `RATE_LIMITED`.
- Anti-enumeration: if the identifier doesn't match any user, a **fake OPAQUE registration record** is generated from the master secret (`createFakeRegistrationRecord`) and the AKE proceeds identically to a real user, returning a normal-looking `ke2`/`loginSessionId`.
- Pending login state key `opaquePendingLogin`, keyed by server-issued `loginSessionId` (UUID) — TTL **120s** (2 min). Value: `{ identifier (lowercased), userId (nullable), expectedSerialized }`. Per-handshake keying (not per-identifier) so concurrent login attempts for the same account don't clobber each other's OPAQUE `expected` state.
- `POST /login/finish` schema: `identifier` (min 1, max 254), `ke3: number[]` (min 1), `loginSessionId` (uuid).
- Handshake verification (`verifyOpaqueLoginHandshake`):
  - No pending record → 400 `NO_PENDING_LOGIN`.
  - Identifier mismatch vs. the pending record (defense-in-depth against a stolen `loginSessionId`) → deletes pending key, 401 `AUTH_FAILED`.
  - `authFinish` failure (bad proof) → deletes pending key, records a failed attempt on `loginUserRateLimit`/`loginLockout` (keyed by `pending.userId` if known, else the lowercased identifier), and if this attempt **triggers** the lockout, sends an "Your account has been temporarily locked" email (only when `pending.userId` is known — i.e. a real account, not the fake-record path) with `lockoutMinutes = Math.floor(REDIS_REGISTRY.loginLockout.ttl / 60)` = **15** minutes (900s / 60). Returns 401 `AUTH_FAILED`.
  - No `userId` on the pending record (fake-record path succeeded the proof, which shouldn't normally happen) → deletes pending key, 401 `AUTH_FAILED`.
- Post-handshake: user row not found → 401 `AUTH_FAILED`. Email present but not verified → deletes pending login key, 401 `EMAIL_NOT_VERIFIED` (no-email users skip this check entirely). Otherwise: deletes pending login key, clears `loginLockout` + `loginUserRateLimit` for the user (successful login resets the counters).
- New session issued: `session.sessionId = crypto.randomUUID()`, populated from the user row, `createdAt = Date.now()`.
- If `user.totpEnabled`: sets `pending2FA = true`, `pending2FAExpiresAt = Date.now() + PENDING_2FA_LOGIN_SECONDS * 1000` where **`PENDING_2FA_LOGIN_SECONDS = 5 * 60`** (5 minutes); saves session; writes `sessionActive` key; returns `200 { requires2FA: true, userId }` — no `passwordWrappedPrivateKey` is returned at this stage (client can't decrypt keys until 2FA passes).
- Else: `pending2FA = false`; saves; writes `sessionActive`; returns `200 { success: true, userId, email, passwordWrappedPrivateKey (base64) }`.
- `POST /login/2fa/verify` — `login2FAVerifyRequestSchema`: `code` (exactly 6 chars, regex `^\d{6}$`).
  - Requires `IRON_SESSION_SECRET` + `OPAQUE_MASTER_SECRET`, else 500 `SERVER_MISCONFIGURED`.
  - Session validation (`validatePending2FASession`): no `session.userId` → 401 `NOT_AUTHENTICATED`; `!session.pending2FA` → 400 `NO_PENDING_2FA`; `session.pending2FAExpiresAt < Date.now()` → destroys session, 401 `2FA_EXPIRED`.
  - Lockout check: `twoFactorLockout` — if locked, 429 `TOO_MANY_ATTEMPTS` with `retryAfterSeconds`.
  - Rate limit: `twoFactorUserRateLimit` — max **10** attempts / **900s** window (15 min). Violation → 429 `RATE_LIMITED`.
  - User row must have `totpSecretEncrypted`, else 500 `TOTP_NOT_CONFIGURED`.
  - TOTP verified via `verifyTotpStepUp` (replay-protected — see TOTP section). On failure: records failed attempt on `twoFactorUserRateLimit`/`twoFactorLockout`, returns 400 `INVALID_TOTP_CODE`; **critically, the session ID is NOT rotated and `session.save()` is not called on the failure path** — pinned by a dedicated test ("does NOT rotate session ID when TOTP verification fails").
  - On success: **session ID rotation** — deletes the old `sessionActive` entry, generates a new `sessionId` via `crypto.randomUUID()`, sets `pending2FA = false`, saves, writes the new `sessionActive` entry, clears the `twoFactorLockout`/`twoFactorUserRateLimit` counters. Returns `200 { success: true, passwordWrappedPrivateKey (base64), userId }`.

---

### `GET /me`, `POST /logout`

- `GET /me`: requires `sessionData.userId`, else 401 `NOT_AUTHENTICATED`. Re-validates `sessionActive` in Redis (keyed by `userId` + `sessionId`); absent → 401 `SESSION_REVOKED`. Single DB query fetches `id, email, username, emailVerified, totpEnabled, hasAcknowledgedPhrase, passwordWrappedPrivateKey, publicKey, customInstructionsEncrypted`; missing row → 404 `USER_NOT_FOUND`.
  - If `sessionData.pending2FA`: returns `200 { user, pending2FA: true }` — the crypto fields (`passwordWrappedPrivateKey`, `publicKey`, `customInstructionsEncrypted`) are **withheld** while 2FA is pending.
  - Else: returns `200 { user, passwordWrappedPrivateKey (base64), publicKey (base64), customInstructionsEncrypted (base64 or null) }`.
- `POST /logout`: requires `IRON_SESSION_SECRET`, else 500 `SERVER_MISCONFIGURED`. If no `sessionData.userId`, short-circuits to `200 { success: true }` (idempotent no-op — logging out an already-logged-out client is a success, not an error). Otherwise deletes the `sessionActive` Redis entry and destroys the iron-session cookie; always returns `200 { success: true }`.

---

### TOTP setup / verify / disable

- `POST /2fa/setup`: requires authenticated session (401 `NOT_AUTHENTICATED`), rejects if `sessionData.pending2FA` (401 `2FA_REQUIRED`), 500 `USER_NOT_FOUND` if user row missing, 400 `TOTP_ALREADY_ENABLED` if already on. Generates a fresh TOTP secret (`generateTotpSecret`) and `totpUri` via `generateTotpUri(user.email ?? user.username, secret)` — the URI issuer/label includes the literal string `"HushBox"` (asserted by test: `body.totpUri` contains `'otpauth://totp/'` and `'HushBox'`). Encrypts the secret with a key derived from `OPAQUE_MASTER_SECRET` (`deriveTotpEncryptionKey`) and stashes the pending setup in Redis key `totpPendingSetup` (keyed by `userId`), TTL **300s** (5 min), storing both the plaintext `secret` and the pre-encrypted blob. Returns `200 { totpUri, secret }` (plaintext secret returned to client for manual entry fallback).
- `POST /2fa/verify` — `twoFactorVerifyRequestSchema`: `code` (6 digits, regex `^\d{6}$`). Requires auth (401), rejects pending-2FA sessions (401 `2FA_REQUIRED`). Rate limit: `twoFactorUserRateLimit` (10 / 900s) — 429 on violation. 500 `USER_NOT_FOUND` if user missing. 400 `NO_PENDING_2FA_SETUP` if no pending Redis record. Verifies via `verifyTotpSetupCode` (replay-protected against the **plaintext** pending secret, distinct from `verifyTotpStepUp` which reads the already-DB-stored encrypted secret) — failure → 400 `INVALID_TOTP_CODE`. On success: writes the pre-encrypted blob + `totpEnabled: true` to the user row (idempotent `UPDATE`), deletes the pending Redis key, sends a "Two-factor authentication enabled" notification email (best-effort), returns `200 { success: true }`.
- `POST /2fa/disable/init` — `twoFactorDisableInitRequestSchema`: `ke1: number[]` (min 1). Requires `OPAQUE_MASTER_SECRET` + `FRONTEND_URL` (500 `SERVER_MISCONFIGURED`), authenticated session (401 `NOT_AUTHENTICATED`), rejects pending-2FA (401 `2FA_REQUIRED`), 500 `USER_NOT_FOUND`, 400 `TOTP_NOT_ENABLED` if not currently enabled. Starts an OPAQUE step-up handshake under `opaquePending2FADisable` key (TTL 300s, keyed by server-issued `sessionId`, credential identifier = `user.id`). Init failure (thrown) → 500 `DISABLE_2FA_INIT_FAILED`. Returns `200 { ke2, disable2FASessionId }`.
- `POST /2fa/disable/finish` — `twoFactorDisableFinishRequestSchema`: `ke3: number[]` (min 1), `code` (6-digit), `disable2FASessionId` (uuid). Requires config (500), auth (401). Rate limit: `twoFactorUserRateLimit` (10/900s, 429 on violation). Finishes the OPAQUE step-up; failure reasons mapped via `mapDisable2FAFinishError`: `bad-proof` → 401 `INCORRECT_PASSWORD`; `no-pending` **and** `session-mismatch` both collapse to 400 `NO_PENDING_DISABLE` (a stolen `disable2FASessionId` cannot distinguish "expired" from "wrong account" — enumeration defense). Then validates the user still has TOTP enabled+configured (`getUserWithTotpConfig`; 500 `USER_NOT_FOUND` / 400 `TOTP_NOT_ENABLED` / 500 `TOTP_NOT_CONFIGURED`). Verifies the submitted `code` via `verifyTotpStepUp` — failure → 400 `INVALID_TOTP_CODE`. On success: clears `totpSecretEncrypted` to `null` and `totpEnabled` to `false`, sends a "Two-factor authentication disabled" notification email (best-effort), returns `200 { success: true }`.
- **TOTP replay protection** (`lib/totp-step-up.ts`): both `verifyTotpStepUp` (login 2FA verify, 2FA disable) and `verifyTotpSetupCode` (initial enrollment) share `verifyWithReplayProtection`. Checks Redis key `totpUsedCode` (`totp:used:{userId}:{code}`, TTL **120s** = 2 minutes) **before** running the crypto verification — if the exact code was already consumed by this user, immediately fails with `reason: 'replay'` (the replay check intentionally runs before the crypto check to preserve a specific timing profile — the code comment marks this ordering as load-bearing, not reorderable). On successful crypto verification, marks the code as used for 120s.

---

### Email verification / resend

- `POST /verify-email` — `verifyEmailRequestSchema`: `token` (string, min 1). Rate limited by **IP only** (`verifyIpRateLimit`, max **30** / **3600s** — the code comment explains token-based rate limiting is ineffective since each invalid attempt uses a different token). Violation → 429 `RATE_LIMITED`.
  - Looks up a user by `emailVerifyToken === token AND emailVerifyExpires > now()`. No match (wrong or expired token) → 400 `INVALID_OR_EXPIRED_TOKEN`.
  - On match: sets `emailVerified: true`, clears `emailVerifyToken`/`emailVerifyExpires` to `null`. Returns `200 { success: true }`.
- `POST /resend-verification` — `resendVerificationRequestSchema`: `email` (Zod email). Dual rate limit: `resendVerifyEmailRateLimit` (max **1** / **60s** window — one resend per minute per email) + `resendVerifyIpRateLimit` (max **5** / **60s** window). Violation → 429 `RATE_LIMITED`.
  - Looks up an unverified user by lowercased email (`emailVerified = false`). **Anti-enumeration:** if no match, still returns `200 { success: true }` without sending anything.
  - On match: mints a new token, new `emailVerifyExpires = now + EMAIL_VERIFY_TOKEN_EXPIRY_MS` (24h), sends the same "Verify your email address" template (best-effort — swallowed on failure), returns `200 { success: true }`.

---

### Password change (authenticated, in-session)

- `POST /change-password/init` — `changePasswordInitRequestSchema`: `ke1: number[]` (min 1), `newRegistrationRequest: number[]` (min 1). Requires config (500 `SERVER_MISCONFIGURED`), authenticated session (401 `NOT_AUTHENTICATED`), 500 `USER_NOT_FOUND` if missing. Starts an OPAQUE step-up handshake under `opaquePendingChangePassword` (TTL 300s) to re-verify the *current* password, **and simultaneously** kicks off a fresh OPAQUE registration (`registerInit`) for the *new* password in the same request. Step-up init throw → 500 `CHANGE_PASSWORD_INIT_FAILED`. New-registration failure → 500 `CHANGE_PASSWORD_REG_FAILED`. Returns `200 { ke2, newRegistrationResponse, changePasswordSessionId }`.
- `POST /change-password/finish` — `changePasswordFinishRequestSchema`: `ke3: number[]` (min 1), `newRegistrationRecord: number[]` (min 1), `newPasswordWrappedPrivateKey` (base64 string), `changePasswordSessionId` (uuid). Requires config (500), auth (401). Finishes the step-up: `no-pending`/`session-mismatch` → 400 `NO_PENDING_CHANGE`; any other failure (bad proof) → 401 `INCORRECT_PASSWORD`. On success, atomically updates `opaqueRegistration` (new OPAQUE record) and `passwordWrappedPrivateKey` in one `UPDATE`. Writes `passwordChangedAt` Redis key (TTL 30 days, value = `Date.now()`) — the mechanism other session checks use to revoke sessions issued before a password change (consumption of this key is outside this file's scope). Sends "Your password was changed" notification email (best-effort). Returns `200 { success: true }`.

---

### Password recovery (unauthenticated — recovery-key flow)

- `POST /recovery/reset` — `recoveryResetRequestSchema`: `identifier` (min 1, max 254), `newRegistrationRequest: number[]` (min 1). Requires config (500). Dual rate limit: `recoveryUserRateLimit` (max **3** / **3600s**) + `recoveryIpRateLimit` (max **10** / **3600s**). Violation → 429 `RATE_LIMITED`.
  - Looks up the user by identifier to derive the OPAQUE credential identifier; if not found, uses a random UUID as the credential identifier (anti-enumeration — the `registerInit` proceeds identically either way). `registerInit` failure → 500 `REGISTRATION_FAILED`.
  - Pending state key `opaquePendingRecoveryReset`, keyed by server-issued `recoverySessionId` (UUID), TTL **300s** (5 min), value `{ identifier (lowercased) }`.
  - Returns `200 { newRegistrationResponse, recoverySessionId }`.
- `POST /recovery/reset/finish` — `recoveryResetFinishRequestSchema`: `identifier` (min 1, max 254), `newRegistrationRecord: number[]` (min 1), `newPasswordWrappedPrivateKey` (base64), `recoverySessionId` (uuid). No pending record, or stored identifier mismatch (defense-in-depth vs. a stolen `recoverySessionId`) → 400 `NO_PENDING_RECOVERY` (in the mismatch case the stale key is deleted first). If the user row can no longer be found by identifier at finish time → also 400 `NO_PENDING_RECOVERY` (same code — doesn't distinguish "expired" from "deleted account" to avoid leaking state). On success: atomically updates `opaqueRegistration` + `passwordWrappedPrivateKey`, deletes the pending key, writes `passwordChangedAt` (TTL 30 days), sends "Your password was reset" email (best-effort), returns `200 { success: true }`.
- `POST /recovery/get-wrapped-key` — `recoveryGetWrappedKeyRequestSchema`: `identifier` (min 1, max 254). Dual rate limit: `recoveryGetKeyUserRateLimit` (max **3** / **3600s**) + `recoveryGetKeyIpRateLimit` (max **10** / **3600s**). Violation → 429 `RATE_LIMITED`.
  - If found: returns `200 { recoveryWrappedPrivateKey: toBase64(user.recoveryWrappedPrivateKey) }`.
  - **Anti-enumeration / timing-safety:** if not found, still returns `200` with a dummy value — `toBase64(new Uint8Array(128))` (128 zero bytes) — rather than a 404, so the endpoint cannot be used to test whether an identifier exists.
- `POST /recovery/save` — `recoverySaveRequestSchema`: `recoveryWrappedPrivateKey` (base64 string, min 1). Requires auth (401 `NOT_AUTHENTICATED`), rejects pending-2FA (401 `2FA_REQUIRED`). Invalid base64 → 400 `INVALID_BASE64`. On success: writes `recoveryWrappedPrivateKey` and sets `hasAcknowledgedPhrase: true` (this is the endpoint that records the user has confirmed/backed up their 12-word recovery phrase). Returns `200 { success: true }`.

---

### Account deletion

#### `POST /delete-account/init`, `POST /delete-account/finish`

- Both routes share `preflight(c)`: requires `sessionData.userId` (401 `NOT_AUTHENTICATED`); rejects `pending2FA` sessions (403 `2FA_REQUIRED`); requires `OPAQUE_MASTER_SECRET` + `IRON_SESSION_SECRET` (500 `SERVER_MISCONFIGURED`). Then both check `deleteAccountLockout` (403 `DELETE_ACCOUNT_LOCKED` with `retryAfterSeconds` if locked).
- Validation caps: `MAX_CONFIRMATION_PHRASE_LENGTH = 200`; `MAX_KE_ARRAY_LENGTH = 1024` (applied to both `ke1` and `ke3` arrays, min 1 each). The confirmation-phrase length cap is enforced by the Zod schema *before* the handler runs, ahead of the phrase-content check (pinned by a test using deliberately-padded whitespace so a missing cap would otherwise pass the phrase check).
- `/init`: 500 `USER_NOT_FOUND` if the user row is gone. Starts the OPAQUE step-up under `opaquePendingDeleteAccount` (TTL 300s). Returns `200 { ke2, deleteAccountSessionId }`.
- `/finish` request body: `ke3` (≤1024), `totpCode?` (exactly 6 digits, regex `^\d{6}$`, optional), `confirmationPhrase` (≤200 chars), `deleteAccountSessionId` (uuid).
- **Gate order** (each pinned by a dedicated test):
  1. Preflight (auth / 2FA-pending / config).
  2. Lockout check.
  3. **Confirmation-phrase check runs before any crypto** ("cheap, server-state-free gate runs before crypto"): `confirmationPhrase.trim().toLowerCase()` must equal the exact literal `"delete my account"` (confirmed via test happy-path value; comparison is ASCII trim + lowercase only — no Unicode normalization, so homoglyphs do not match). Mismatch → 400 `INVALID_CONFIRMATION_PHRASE`, no OPAQUE call made.
  4. 500 `USER_NOT_FOUND` if user row missing.
  5. OPAQUE step-up finish (`opaquePendingDeleteAccount`): `no-pending`/`session-mismatch` → 400 `NO_PENDING_DELETE_ACCOUNT` (no rate-limit attempt consumed — expired/stolen session state isn't the user's fault). Bad proof → records a failed attempt (see lockout below); if that attempt itself triggers the lockout, returns 403 `DELETE_ACCOUNT_LOCKED` immediately (not the generic 400) with `retryAfterSeconds`; otherwise 400 `INCORRECT_PASSWORD`.
  6. TOTP gate (only if `user.totpEnabled`): missing `totpCode` or missing `totpSecretEncrypted` → 400 `TOTP_CODE_REQUIRED` **without** consuming a rate-limit attempt (a shape error, not an attack). Otherwise verifies via `verifyTotpStepUp`; failure records a failed attempt — same lockout-trigger-surfaces-immediately behavior as step 5 — otherwise 400 `INVALID_TOTP_CODE`.
  7. Runs the `deleteUser` saga (`runSagaSafely`). If it throws: logs via `console.error('delete-account saga failed', { userId, error })` and returns 500 `INTERNAL` — session is **not** destroyed. If the saga resolves `{ ok: false, reason: 'user-not-found' }` (concurrent delete already ran) it is still treated as success.
  8. On success (saga ok or user-not-found): destroys the iron-session, returns `204` with an empty body.
- **Lockout mechanics** (`deleteAccountUserRateLimit` + `deleteAccountLockout`): rate-limit config `maxAttempts: 3`, `windowSeconds: 3600` (1 hour); lockout TTL = `24 * 60 * 60` = **86400s (24 hours)**. The 3rd consecutive failure (across OPAQUE-proof failures and TOTP failures combined, since both call the same `recordDeleteAccountFailure` against the same rate-limit key) triggers the lockout and that very response carries `403 DELETE_ACCOUNT_LOCKED` with a positive `retryAfterSeconds` — the user does not need to retry once more to learn they're locked out.
- IP/User-Agent for the deletion audit event are read from `cf-connecting-ip` and `user-agent` request headers, defaulting to `null` if absent.

#### `deleteUser` saga (`services/account-deletion/delete-user.ts`)

- `R2_DELETE_BATCH_SIZE = 50` — R2 object deletes are fanned out in parallel batches of 50 (matches the pattern in the (out-of-scope) `r2-gc.ts` orphan sweep, staying under the Cloudflare Workers concurrent-subrequest ceiling).
- `DEFAULT_MAX_R2_DELETES = 900` — hard cap on R2 deletes performed synchronously inside one `/delete-account/finish` invocation. Rationale documented in-code: the Workers paid plan caps subrequests at 1000; 900 leaves headroom for the DB transaction, email send, and saga overhead. Any storage keys beyond the cap are **not** deleted here — they're left for the daily `runR2Gc` orphan sweep (out of scope, referenced only).
- `DeleteUserArgs` accepts an optional `maxR2Deletes` override (used by tests; defaults to 900 in production).
- **Transactional saga** (`runSaga`, one Postgres transaction) with three explicitly documented ordering invariants:
  1. `SELECT ... FOR UPDATE` on the target `users` row (this is also the mechanism that serializes concurrent delete attempts on the same account — confirmed by integration tests across both a single connection and two independent `Database` instances/connections: exactly one concurrent `deleteUser` call succeeds, the other returns `user-not-found`). Captures `user.email` and every distinct `content_items.storageKey` (via inner-joining `contentItems → messages → conversations` filtered to `conversations.userId = args.userId` and non-null `storageKey`) **before** the cascade deletes them.
  2. Sets `leftAt = args.now` on all of the user's still-active (`leftAt IS NULL`) `conversationMembers` rows for conversations they don't own — done *before* deleting the `users` row so the FK-cascade-to-null satisfies a `userId OR linkId OR leftAt` check constraint on that table (leaves a tombstone row: `userId=null`, `linkId=null`, `leftAt` set, confirmed by the integration test's `assertTombstoneRow`).
  3. Nulls `messages.senderId` for the user's messages inside conversations they don't own (a raw SQL subquery restricted to `conversations WHERE userId != args.userId`) — again *before* the user row disappears.
  4. Inserts one row into `accountDeletionEvents`: `{ deletedAt: args.now, ipAddress, userAgent }` — the permanent audit record.
  5. Deletes the `users` row — this cascades to owned `conversations` (and their `epochs`/`messages`/`content_items`/etc.), `projects`, and `deviceTokens` (all deleted outright), while `wallets`, `payments`, and `usageRecords` rows survive with `userId` set to `null` (pseudonymized financial retention, confirmed by the integration test which asserts these rows exist post-deletion with a null `userId`).
- Returns `{ found: false }` from the transaction if no user row matched `args.userId`, mapped to `{ ok: false, reason: 'user-not-found' }` — the caller (and the route) treats this as an idempotent success/no-op.
- **Post-transaction, best-effort side effects** (both happen only after the DB transaction has committed):
  1. `sendDeletionEmail`: skipped entirely if the captured email was `null` or empty. Subject: `"Your HushBox account has been deleted"`. Failures are caught and `console.warn('delete-user notification email failed', { error })` — never blocks the overall result.
  2. `deleteStorageObjects`: deletes up to `maxR2Deletes` of the captured storage keys, batched 50-at-a-time via `Promise.allSettled`. Per-key failures are individually logged (`console.warn('delete-user storage delete failed', { key, error })`) and otherwise ignored — one failed R2 delete does not fail the saga. If `keys.length > maxDeletes`, logs a summary warning (`total`, `deleted`, `deferred` counts) noting the remainder is deferred to GC.
  - Email is sent **before** the R2 cleanup loop, deliberately: the code comment explains the R2 loop can itself exhaust the Workers subrequest budget, so sending the "your account is gone" notification first guarantees the user is told even if cleanup later trips the cap.
- Overall `deleteUser` return type: `{ ok: true } | { ok: false, reason: 'user-not-found' }` — there is no failure return for storage/email failures; those are always absorbed.

---

### Device tokens (`POST /`, `DELETE /:token`)

- Both routes gated by `requireAuth()` middleware (out of scope, referenced only).
- `POST /`: body `{ token: string (min 1), platform: 'ios' | 'android' }` (Zod enum — only these two literal values accepted at this route; `updates.ts` separately supports an `android-direct` platform variant for OTA downloads, not device-token registration). Upserts via `onConflictDoUpdate` on `deviceTokens.token` (unique constraint) — a token re-registered by a different user reassigns `userId`/`platform`/`updatedAt` rather than erroring, making registration idempotent and handling device/token reuse across accounts. Returns `201 { registered: true }`.
- `DELETE /:token`: deletes the row matching both `token` **and** `userId` (so a user cannot delete another user's token even if they guess the token string). Returns `200 { deleted: true }` regardless of whether a row actually matched (no existence check).

---

### Health check (`GET /`)

- Returns `200 { status: 'ok', timestamp: new Date().toISOString() }`. No auth, no dependencies, no parameters.

---

### Keys & epoch rotation

#### Routes (`routes/keys.ts`)

- `POST /batch` — body `{ conversationIds: string[] (min 1, max 100) }`. Requires `user` (401 `NOT_AUTHENTICATED`). **Partial-success contract, always 200**: returns `{ keys: Record<conversationId, KeyChainResponse>, missing: string[] }` — ids the caller has no membership for land in `missing` rather than causing an all-or-nothing 404, specifically to avoid transient errors during WebSocket-driven membership/epoch changes on the frontend's conversation list. Unauthorized ids never appear in `keys` (enforced by the underlying batch query filtering on the caller's public key).
- `GET /:conversationId` — gated by `requirePrivilege('read', { allowLinkGuest: true })` (out of scope middleware). Accepts either an authenticated user's `publicKey` or a `linkGuest`'s `publicKey`. No public key resolvable, or no key chain found → 404 `CONVERSATION_NOT_FOUND`.
- `GET /:conversationId/member-keys` — gated by `requirePrivilege('read')` (**not** `admin`), deliberately: a non-owner leave triggers a client-side epoch rotation, which needs every active member's public key to re-wrap the new epoch key, so locking this to admin-level would block regular members from leaving. Response fields (`memberId`, `userId`, `linkId`, `publicKey` base64, `privilege`, `visibleFromEpoch`) are treated as non-sensitive — every field except `publicKey` is already visible elsewhere to read-level members, and public keys are public crypto material by design. Requires active membership (`verifyMembership`) — non-member → 404 `CONVERSATION_NOT_FOUND`.
- Serialization: `wrap`, `confirmationHash`, `chainLink` are all base64-encoded (`toBase64`) in every response. Observed byte lengths from fixtures/tests: `wrap` = 48 bytes, `confirmationHash` = 32 bytes, `chainLink` = 64 bytes.

#### Service (`services/keys/keys.ts`)

- `getKeyChain(db, conversationId, userPublicKey)`: joins `epochMembers` (filtered to the caller's public key) with `epochs` for the conversation, ordered by `epochNumber` ascending; if zero wraps found, returns `null` (non-member). Separately fetches all `epochs` rows with a non-null `chainLink` for the conversation. Fetches `conversations.currentEpoch`. Delegates to `assembleKeyChain`.
- `assembleKeyChain` visibility filtering: `visibleFromEpoch = min(all of the caller's wraps' visibleFromEpoch)`; `filteredWraps = wraps where epochNumber >= visibleFromEpoch`; `filteredChainLinks = chainLinks where epochNumber > visibleFromEpoch` (strict `>` — the chain link *at* the visibility boundary epoch connects backward past the boundary and is excluded, confirmed by multiple tests, e.g. "excludes wraps for epochs before visibleFromEpoch" and "filters chain links by visibleFromEpoch"). Returns `null` if there are no wraps or `currentEpoch` is undefined.
- `getKeyChainBatch(db, conversationIds, userPublicKey)`: same logic across many conversations in exactly **3** DB queries total (wraps, chain links, conversations — each `inArray`'d over all requested ids) rather than N×3 — explicitly documented as an N+1 avoidance. Conversations with zero matching wraps for the caller are simply omitted from the returned `Map`.
- `getMemberKeys(db, conversationId)`: unions active (`leftAt IS NULL`) user members (joined to `users.publicKey`) and active link members (joined to `sharedLinks.linkPublicKey`), sorted ascending by `joinedAt`.
- `verifyMembership(db, conversationId, userId)`: returns the active (`leftAt IS NULL`) `conversationMembers` row for that user/conversation, or `null`.
- `submitRotation(tx, params)` — atomic epoch rotation (invoked from within a caller's existing transaction, e.g. `saveChatTurn`, elsewhere in the codebase; also exercised directly in this scope's tests):
  1. **Optimistic concurrency guard**: `UPDATE conversations SET currentEpoch = expectedEpoch+1, updatedAt=now() WHERE id=? AND currentEpoch=expectedEpoch`. Zero rows affected → re-reads the actual `currentEpoch` and throws `StaleEpochError(currentEpoch)` (message: `` `Stale epoch: expected rotation from epoch ${currentEpoch}` ``).
  2. Inserts the new `epochs` row (`epochNumber = expectedEpoch+1`, `epochPublicKey`, `confirmationHash`, `chainLink`); insert failure (no returned row) throws a generic `Error('Failed to insert new epoch')`.
  3. Re-derives the **authoritative** `visibleFromEpoch` per member from `conversationMembers`/`sharedLinks` (server-side, not trusting whatever the client's `memberWraps` payload implies) for every currently-active user and link member.
  4. `validateWrapSet`: the set of public keys in the caller-supplied `memberWraps` must exactly match the set of currently-active member public keys (size and membership both checked) — any mismatch (extra keys or missing keys) throws `WrapSetMismatchError(expectedCount, providedCount)` (message: `` `Wrap set mismatch: expected ${expectedCount} members, got ${providedCount}` ``).
  5. Inserts new `epochMembers` rows for the new epoch using the server-derived `visibleFromEpoch` (not any client-supplied value) — an invariant violation (`visibleFromEpoch` missing for a key that passed `validateWrapSet`) throws `Error('invariant: visibility missing for member key')`.
  6. Deletes the **old** epoch's `epochMembers` rows entirely (old per-member wraps are not retained once superseded — confirmed by "deletes old epoch member wraps after rotation").
  7. Updates the conversation's `title` and `titleEpochNumber` to the new epoch atomically with the rotation.
  8. Returns `{ newEpochNumber, newEpochId }`.
- `handleRotationError(error, c)` — route-level error mapper: `StaleEpochError` → `409` with `createErrorResponse(ERROR_CODE_STALE_EPOCH, { currentEpoch })`; `WrapSetMismatchError` → `400 WRAP_SET_MISMATCH`; anything else is rethrown (surfaces as a 500 via the global handler).
- `toRotationParams(conversationId, rotation)`: pure conversion of a Zod-parsed, base64-string rotation payload into `SubmitRotationParams` with `Uint8Array` fields (no I/O, no validation beyond base64 decode).
- Real end-to-end crypto chain traversal is verified in the service test suite: unwrapping the latest epoch's wrap recovers that epoch's private key, and `traverseChainLink` walks backward through multiple rotations (epoch 3 → 2 → 1) to recover every prior epoch's key, each checked against its stored `confirmationHash` via `verifyEpochKeyConfirmation`.

---

### User preferences (accessibility sync)

- `GET /accessibility`: requires `user` (401 `UNAUTHORIZED`). Reads `accessibilityPreferences` (JSONB) + `accessibilityPreferencesUpdatedAt` for the user; 404 `USER_NOT_FOUND` if the session's user id no longer has a DB row (stale-session defense).
- `PUT /accessibility`: body validated by `accessibilityPreferencesSchema` (external, not read in this scope) plus an ISO-8601 `updatedAt` timestamp.
- **Sync model — Last-Write-Wins via companion timestamp column**, explicitly documented as the strategy so multiple devices converge without coordination: client-side localStorage remains the source of truth locally, and authenticated users additionally push settings to the DB.
- Enforcement is layered three ways per an accessibility design doc referenced in comments: (1) wire — `zValidator` rejects malformed requests pre-handler; (2) storage — Drizzle's `.$type<>()` narrows the column's TS type; (3) read — a defensive `parse()` on read fills missing/legacy keys with schema defaults so older stored blobs survive schema migrations.
- The update itself is an **atomic conditional `UPDATE ... WHERE accessibilityPreferencesUpdatedAt <= incomingTs`** (note `lte`, i.e. `<=` not `<`): a client timestamp strictly newer than the DB row updates it; a timestamp **equal** to the DB row is also accepted as a no-op-content but `accepted: true` write (explicitly called out as the CODE-RULES idempotency/safe-retry guarantee — replaying the exact same PUT twice is not an error); a client timestamp **older** than the DB row is rejected (`result.length === 0` → `accepted: false`), and the DB row is left untouched.
- Response: `200 { accepted: boolean }` for `PUT`; `200 { preferences, updatedAt }` for `GET`.

---

### User search & custom instructions

- `POST /search` (`usersRoute`) — body `{ query: string (min 1, max 50), excludeConversationId?: string, limit?: number (int, 1–20) }`. Requires `user` (401 `UNAUTHORIZED`). Delegates to `searchUsers`.
- `searchUsers(db, query, requesterId, options)` (`services/users/user-search.ts`):
  - `MAX_LIMIT = 20`; effective limit = `min(options.limit ?? MAX_LIMIT, MAX_LIMIT)` (caller-supplied limits above 20 are silently clamped at the service layer, in addition to the route's own Zod `max(20)`).
  - Query normalized via `normalizeUsername(query)` (external helper — collapses spaces, etc., per test "normalizes query spaces before searching": `'John Smith'` becomes usable as `'john_smith%'`), matched case-insensitively via `ILIKE '<normalized>%'` (prefix match only) against `users.username`.
  - Always excludes the requesting user (`ne(users.id, requesterId)`).
  - Two query shapes: with `excludeConversationId` provided, left-joins `conversationMembers` (scoped to that conversation, `leftAt IS NULL`) and filters to `conversationMembers.id IS NULL` (i.e. excludes anyone currently an active member of that conversation); without it, a plain filtered `SELECT`.
  - Results ordered by `users.username` ascending (deterministic — the code comment notes this was added after e2e flakiness from unordered Postgres scan order when multiple rows shared a prefix).
  - Returns `{ id, username, publicKey: base64 }[]`.
- `PATCH /custom-instructions` — body `{ customInstructionsEncrypted: string | null }`. Requires `user` (401 `UNAUTHORIZED`). Non-null value must be valid base64 (`fromBase64`) or 400 `INVALID_BASE64`. Writes the decoded `Uint8Array` (or `null` to clear) to `users.customInstructionsEncrypted`. Returns `200 { success: true }`.

---

### OTA updates / app version (`updates.ts`)

- `GET /current`: returns `200 { version }` where `version = getVersionOverride() ?? c.env.APP_VERSION`. The override is a **module-level, in-memory** variable (`lib/version-override.ts`) — persists across requests only within a single long-lived process (e.g. local `wrangler dev`); resets to `null` on every cold start in production Workers. The setter is exposed only via a dev-only route (`POST /api/dev/set-version`, out of scope) so the override path is never reachable in production.
- `GET /download/:platform/:version` — `platform` validated against the shared `MOBILE_PLATFORMS` enum (values confirmed by test: `ios`, `android`, `android-direct` all valid/200; `web` and arbitrary strings are rejected with 400 — `MOBILE_PLATFORMS` itself is a shared-package constant outside this scope's files). `version` — any non-empty string.
- Looks up `builds/${platform}/${version}.zip` in the `APP_BUILDS` R2 bucket binding. Missing binding, or missing object → 404 `BUILD_NOT_FOUND`.
- On hit: streams the R2 object body directly as the response with headers `content-type: application/zip`, `content-length: <object.size>`, `cache-control: public, max-age=86400, immutable` (**86400 seconds = 24 hours**, immutable — build artifacts for a given version+platform never change in place).

---

### Token login (mobile → web billing handoff) (`token-login.ts`)

- `POST /` — body `{ token: uuid }`. **Fail-fast ordering is load-bearing and pinned by a dedicated test**: checks `IRON_SESSION_SECRET` presence *before* any Redis or DB I/O — a misconfigured deployment must 500 immediately rather than waste a Redis read + DB query first.
- Looks up the token in Redis key `billingLoginToken` (`billing:login-token:{token}`, TTL **60s**). Not found → 401 `LOGIN_TOKEN_INVALID`.
- **The token is deliberately never deleted after use** ("Token expires via TTL (60s) — no immediate delete"), making the endpoint safe to call more than once inside the 60s window — explicitly to tolerate React StrictMode double-invocation, page reloads, and network retries, all succeeding idempotently within the TTL.
- Looks up the user by `tokenData.userId`; missing → 401 `LOGIN_TOKEN_INVALID` (same code as an invalid token — doesn't distinguish stale-token-with-deleted-user from a garbage token).
- **Deterministic session ID derivation**: `sessionId = SHA-256(token)`, taking the first 16 bytes of the digest and formatting them as a UUID (`8-4-4-4-12` hex groups). This means repeated redemptions of the same token within the TTL window always produce the *same* `sessionId` — no orphaned `sessionActive` Redis entries accumulate from retries (pinned by "retries produce the same sessionActive key" test).
- Sets `session.billingOnly = true` on the resulting session (restricting it to billing routes elsewhere in the app — enforcement itself is out of scope) alongside the standard session fields (`pending2FA` forced `false`, `pending2FAExpiresAt: 0`).
- Writes the `sessionActive` Redis key exactly as other login flows do. Returns `200 { success: true }` with the session cookie set.

---

### Redis key registry — values relevant to this scope

| Key name | TTL | Rate-limit config (maxAttempts / windowSeconds) | Notes |
|---|---|---|---|
| `loginUserRateLimit` | 900s | 5 / 900 | keyed by userId or lowercased identifier |
| `loginIpRateLimit` | 900s | 20 / 900 | keyed by SHA-256(ip) |
| `registerEmailRateLimit` | 3600s | 3 / 3600 | |
| `registerIpRateLimit` | 3600s | 10 / 3600 | |
| `twoFactorUserRateLimit` | 900s | 10 / 900 | shared across 2FA login-verify, setup-verify, disable-finish |
| `deleteAccountUserRateLimit` | 3600s | 3 / 3600 | shared by OPAQUE-proof and TOTP failures on delete-account |
| `recoveryUserRateLimit` | 3600s | 3 / 3600 | |
| `recoveryIpRateLimit` | 3600s | 10 / 3600 | |
| `recoveryGetKeyUserRateLimit` | 3600s | 3 / 3600 | |
| `recoveryGetKeyIpRateLimit` | 3600s | 10 / 3600 | |
| `verifyTokenRateLimit` | 3600s | 10 / 3600 | defined but verify-email route only actually rate-limits by IP |
| `verifyIpRateLimit` | 3600s | 30 / 3600 | |
| `resendVerifyEmailRateLimit` | 60s | 1 / 60 | |
| `resendVerifyIpRateLimit` | 60s | 5 / 60 | |
| `loginLockout` | 900s (15 min) | — (lockout key) | |
| `twoFactorLockout` | 900s (15 min) | — | |
| `recoveryLockout` | 3600s (1h) | — | defined in registry; not observed triggered in read routes |
| `deleteAccountLockout` | 86400s (24h) | — | |
| `opaquePendingRegistration` | 300s | — | keyed by server-issued `registerSessionId` |
| `opaquePendingLogin` | 120s | — | keyed by server-issued `loginSessionId` |
| `opaquePendingChangePassword` | 300s | — | |
| `opaquePending2FADisable` | 300s | — | |
| `opaquePendingDeleteAccount` | 300s | — | |
| `opaquePendingRecoveryReset` | 300s | — | |
| `totpPendingSetup` | 300s | — | keyed by userId |
| `totpUsedCode` | 120s | — | replay guard, keyed by userId+code |
| `billingLoginToken` | 60s | — | never explicitly deleted post-use |
| `sessionActive` | 2,592,000s (30 days, = `SESSION_MAX_AGE_SECONDS`) | — | |
| `passwordChangedAt` | 2,592,000s (30 days) | — | |

**Rate-limit algorithm** (`checkRateLimit` / `recordFailedAttempt`): fixed-window counter, not sliding — a stored `{count, firstAttempt}` resets to `count=1` the moment `now > firstAttempt + windowSeconds*1000`; otherwise `count` increments. `checkDualRateLimit` requires **both** the user-keyed and IP-keyed limiters to allow (checks user first, short-circuits on failure); its `remaining` is `min(userRemaining, ipRemaining)`. Lockout is a **separate** key from the rate-limit counter: `recordFailedAttempt` triggers a lockout write (`lockoutUntil = Date.now() + lockoutTtl*1000`, stored as a string, TTL = the lockout entry's own `ttl`) once `count >= maxAttempts` on the *paired* rate-limit key — the same failed-attempt call increments the counter and (on the threshold-crossing call) sets the lockout in one pass.

---

### Other constants observed

- `EMAIL_VERIFY_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000` (24 hours) — used for both initial registration verification tokens and resend-verification tokens.
- `PENDING_2FA_LOGIN_SECONDS = 5 * 60` (5 minutes) — window during which a `requires2FA` session must complete `/login/2fa/verify` before `2FA_EXPIRED`.
- Delete-account confirmation phrase (exact, case-insensitive/trim-only match): `"delete my account"`.
- `MAX_CONFIRMATION_PHRASE_LENGTH = 200`, `MAX_KE_ARRAY_LENGTH = 1024` (delete-account route).
- `R2_DELETE_BATCH_SIZE = 50`, `DEFAULT_MAX_R2_DELETES = 900` (account deletion storage cleanup).
- OTA build download cache header: `public, max-age=86400, immutable` (24 hours).
- `searchUsers` `MAX_LIMIT = 20`.
- TOTP code format everywhere in this scope: exactly 6 characters, regex `^\d{6}$`.


---

## 03. Conversations, Membership, Forks, Links & Media

Route mount points (from `app.ts`): `/api/conversations` (conversationsRoute), `/api/members`
(membersRoute), `/api/links` (linksRoute), `/api/messages` (messageSharesRoute — `POST /share`),
`/api/shares` (publicSharesRoute — `GET /:shareId`), `/api/media` (mediaRoute), `/api/forks`
(forksRoute).

### Conversations

#### List conversations — `GET /api/conversations`

- Requires authentication (`requireAuth()`); returns `401 NOT_AUTHENTICATED` otherwise.
- Query params: `cursor` (string, optional), `limit` (coerced int, `min(1).max(100)`, optional).
- Pagination defaults: `DEFAULT_PAGE_LIMIT = 50`, `MAX_PAGE_LIMIT = 100`. Effective limit is
  `Math.min(options.limit ?? 50, 100)`.
- Cursor format: JSON payload of `{ updatedAt: ISO string, id: string }` (base64/opaque string
  handled by `parseCursor`); an unparseable cursor returns an empty page (`rows: []`,
  `nextCursor: null`) rather than erroring.
- Ordering: conversations sorted by `updatedAt DESC`, tie-broken by `id DESC`; cursor condition is
  `(updatedAt, id) < (cursorDate, cursorId)`.
- Only conversations where the caller has an active membership row (`conversationMembers.userId =
  userId AND leftAt IS NULL`) are returned — includes both owned and shared/member conversations.
- Each row includes: conversation fields, `accepted` (`acceptedAt !== null`), `invitedByUsername`,
  `privilege`, `muted` (defaults `false`), `pinned` (defaults `false`).
- Response envelope: `{ conversations: [...], nextCursor }`, HTTP 200.

#### Get single conversation — `GET /api/conversations/:conversationId`

- `requirePrivilege('read', { allowLinkGuest: true })` — accepts session users and link guests.
- Uses the caller's `visibleFromEpoch` (resolved by the privilege middleware) to filter messages:
  `visibleFromEpoch <= 1` returns all messages; otherwise only `messages.epochNumber >=
  visibleFromEpoch`.
- Returns `404 CONVERSATION_NOT_FOUND` if the conversation doesn't exist or the caller isn't
  authorized to see it (blind 404 — no distinction between "doesn't exist" and "not a member").
  An ex-member (`leftAt` set) also gets 404.
- Response includes: `conversation`, `messages` (with nested `contentItems`), `forks`, `accepted`,
  `invitedByUsername`, `callerId`, `privilege`. HTTP 200.
- For link guests (`userId` not supplied), `getConversationForMember` synthesizes `acceptedAt =
  new Date()` (current time) and `invitedByUsername = null` rather than reading a membership row.

#### Create/get conversation — `POST /api/conversations`

- `requireAuth()` required.
- Body: `id`, optional `title` (base64, decoded via `fromBase64`), `epochPublicKey`
  (base64→bytes), `confirmationHash` (base64→bytes), `memberWrap` (base64→bytes). Missing epoch
  fields → `400`.
- Idempotent-by-ID: if `id` already exists and belongs to the same user, the existing conversation
  and its messages are returned with `isNew: false`, HTTP `200` — even if the request body's title
  differs (original title is preserved, new title ignored).
- If `id` exists but belongs to a **different** user, returns `404 CONVERSATION_NOT_FOUND` (never
  discloses cross-user ID collisions).
- On creation (`isNew: true`), atomically in one transaction:
  1. Inserts the `conversations` row (uses `INSERT ... ON CONFLICT DO UPDATE (id = EXCLUDED.id)`
     — a no-op update — to get row-level locking + `xmax` to distinguish new vs. existing without
     a separate SELECT).
  2. If no title provided, stores `new Uint8Array(0)` (empty bytes) — decodes to `''` in the API
     response.
  3. Creates epoch #1 (`epochNumber: 1`, `chainLink: null`) with the supplied
     `epochPublicKey`/`confirmationHash`.
  4. Creates one `epochMembers` row for the creator (`visibleFromEpoch: 1`).
  5. Creates one `conversationMembers` row: `privilege: 'owner'`, `visibleFromEpoch: 1`,
     `acceptedAt: new Date()` (auto-accepted), `invitedByUserId: null`.
- Concurrent identical creation requests: exactly one succeeds with `isNew: true`; the other
  returns the same row with `isNew: false` (pinned by test: `handles concurrent creation of same
  conversation ID`); only one epoch/epoch-member set is created.
- Response on create: `conversation`, `messages: []`, `forks: []`, `isNew: true`,
  `accepted: true` (const), `invitedByUsername: null` — HTTP `201`. On idempotent replay: HTTP
  `200`, existing `forks` fetched and included, `messages` populated from DB.

#### Update conversation title — `PATCH /api/conversations/:conversationId`

- `requirePrivilege('owner')` — only the owner may update.
- Body: `title` (base64, non-empty — empty string → `400`), `titleEpochNumber`.
- Atomic conditional `UPDATE ... WHERE id = ? AND user_id = ?` — cross-user update attempts return
  `404 CONVERSATION_NOT_FOUND` (never a 403, to avoid disclosing existence to non-owners).
- Also bumps `updatedAt`.
- Response: `conversation`, `accepted: true` (const — only owner reaches this path), 200.

#### Delete conversation — `DELETE /api/conversations/:conversationId`

- `requirePrivilege('owner')`.
- Atomic conditional `DELETE ... WHERE id = ? AND user_id = ?`; returns `404
  CONVERSATION_NOT_FOUND` if not found or not owned.
- Cascades (via FK constraints) to `messages`, `content_items` (via messages), `epochs`,
  `epoch_members`, `conversation_members`, `conversation_forks`.
- Response: `{ deleted: true }`, 200.

#### Owner leave (from members route) also deletes the conversation

- `POST /api/members/:conversationId/leave`: if the requester is the owner, the entire
  conversation row is deleted (cascade handles cleanup) and **no key rotation occurs** — response
  `{ deleted: true }`, 200. Non-owner leave always requires a `rotation` payload (`400
  ROTATION_REQUIRED` if omitted, since the owner always remains and access must be revoked).

#### Response serialization details

- `title` is base64-encoded ciphertext (`toBase64`), never plaintext.
- `wrappedContentKey` on each message is base64-encoded.
- `senderType` and `contentType` are re-validated server-side via Zod (`senderTypeSchema.parse`,
  `contentTypeSchema.parse`) even though a DB CHECK constraint already enforces the value set —
  documented as "fail loud if a rogue row slips through."
- Content item fields exposed in the conversation/message view (unlike the public-share view,
  which strips generation metadata): `id`, `contentType`, `position`, `encryptedBlob` (base64 or
  null), `storageKey`, `mimeType`, `sizeBytes`, `width`, `height`, `durationMs`, `modelName`,
  `cost`, `isSmartModel`.

### Forks

Constant: `MAX_FORKS_PER_CONVERSATION = 5` (from `@hushbox/shared`).

#### Create fork — `POST /api/forks/:conversationId`

- `requirePrivilege('write')`.
- Body: `id` (client-supplied fork ID, UUID), `fromMessageId`, optional `name`.
- **Idempotent on `id`**: if a fork with the given `id` already exists, returns the current fork
  list with `isNew: false`, HTTP `200` (no error, no duplicate creation).
- **First fork in a conversation**: creates *two* records atomically — a `"Main"` fork whose
  `tipMessageId` is the conversation's latest message by `sequenceNumber DESC` (or `null` if no
  messages), and the requested fork whose `tipMessageId = fromMessageId`. The `Main` fork's
  `createdAt` is set to `now`, the new fork's to `now + 1ms` (ensures deterministic ordering when
  both are inserted in the same statement).
- **Subsequent forks**: creates only the one new fork record.
- Auto-naming: if `name` is omitted, the next name is computed by scanning existing fork names
  matching `/^Fork (\d+)$/`, taking the max matched number, and using `Fork {max+1}` (e.g. first
  auto-named fork after "Main" is `"Fork 1"`, next `"Fork 2"`, etc. — independent of deletions,
  since it scans current names each time).
- Duplicate name (case-sensitive exact match against `(conversation_id, name)` unique constraint,
  including the literal string `"Main"`) → `ForkError` with code `FORK_NAME_TAKEN`, mapped to HTTP
  `409`.
- Reaching `MAX_FORKS_PER_CONVERSATION` (5) existing fork rows → `ForkError` code
  `FORK_LIMIT_REACHED`, mapped to HTTP `400`, with message `"Maximum of 5 forks per conversation
  reached"`. (Count check happens before insert; e.g. after "Main" + "Fork 1" through "Fork 4"
  = 5 rows, the 6th create attempt is rejected.)
- On successful creation of a brand-new fork, broadcasts realtime event `fork:created` with
  `{ forkId, conversationId, name, tipMessageId }` (only when `result.isNew` is true and the new
  fork was actually found in the returned list).
- Response: `{ forks: ForkRecord[], isNew }`, HTTP `201` (new) or `200` (idempotent replay).
- A conversation owner with only a `conversationMembers` row (no separate solo-conversation
  special-casing) can create forks; a non-member/non-owner on such a conversation is rejected
  (403/404 via `requirePrivilege`).

#### Rename fork — `PATCH /api/forks/:conversationId/:forkId`

- `requirePrivilege('write')`.
- Body: `{ name }`.
- Atomic `UPDATE ... WHERE id = ? AND conversation_id = ?`; unique-violation on
  `(conversation_id, name)` → `ForkError` `FORK_NAME_TAKEN` → HTTP `409` (e.g. renaming a
  non-Main fork to `"Main"` collides and is rejected).
- Renaming to the same name is a no-op (UPDATE sets identical value, succeeds).
- Broadcasts `fork:renamed` `{ forkId, conversationId, name }`.
- Response: `{ renamed: true }`, 200.

#### Delete fork — `DELETE /api/forks/:conversationId/:forkId`

- `requirePrivilege('write')`.
- **Idempotent**: deleting an already-deleted (or never-existing) fork ID returns the current
  remaining-forks list with HTTP `200` (not a 404).
- Deletion algorithm ("exclusive messages"):
  1. Compute the deleted fork's ancestor chain — walk `tipMessageId` → `parentMessageId` →
     ... → `null`, collecting every visited message ID into a `Set`.
  2. Compute the union of ancestor chains for every *other* remaining fork.
  3. "Exclusive" messages are those in the deleted fork's chain but absent from every other fork's
     chain — these messages are hard-deleted (`DELETE FROM messages WHERE id IN (...)`).
  4. The fork row itself is deleted.
  5. **If exactly one fork remains after deletion**, the conversation reverts to "linear mode": ALL
     remaining fork records (including that lone survivor, typically `"Main"`) are deleted,
     leaving zero fork rows and `remainingForks: []`.
- Broadcasts `fork:deleted` `{ forkId, conversationId }` (fired unconditionally, even on the
  idempotent-already-deleted path, since it's outside the idempotency branch in the route).
- Response: `{ remainingForks: [{id, name, tipMessageId}] }`, 200.

### Links (shared conversation invite links)

Constant: `MAX_CONVERSATION_MEMBERS = 100` (shared with the members/add path).

#### List links — `GET /api/links/:conversationId`

- `requirePrivilege('read', { allowLinkGuest: true })`.
- Returns only active (non-revoked) links, joined to `conversationMembers` for authoritative
  `privilege` (single source of truth is the member row, not a cached column on `sharedLinks`).
- Ordered by `createdAt DESC`.
- Each item: `id`, `linkPublicKey` (base64), `privilege`, `displayName`, `createdAt` (ISO string).

#### Create link — `POST /api/links/:conversationId`

- `requirePrivilege('admin')`.
- Body: `linkPublicKey` (base64), `memberWrap` (base64), `privilege` (string), `giveFullHistory`
  (boolean), optional `displayName` (`min(1).max(100)`), optional `rotation`. Zod `.refine`:
  `giveFullHistory || rotation !== undefined` must hold — i.e. `giveFullHistory: false` without a
  `rotation` payload is rejected at `400`.
- Looks up the current epoch (with a live member count via correlated subquery
  `SELECT count(*)::int FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL`).
  No epoch found → `404 EPOCH_NOT_FOUND`.
- Member-count gate: `memberCount >= MAX_CONVERSATION_MEMBERS (100)` → `400
  MEMBER_LIMIT_REACHED` (checked before creating the link).
- `visibleFromEpoch` resolution: `1` if `giveFullHistory`, else `rotation.expectedEpoch + 1`.
- Inside a transaction: locks the `conversations` row `FOR UPDATE`, re-checks the current epoch ID
  against the caller-supplied `currentEpochId` — mismatch (rotated between query and transaction)
  throws `StaleEpochError` → HTTP `409 STALE_EPOCH` with `details.currentEpoch`.
- Display name: if not provided, generated as `"Guest {N}"` where `N = (count of existing
  sharedLinks rows for the conversation) + 1` (not scoped to active-only — counts ever-created
  links, so a 3rd link created after 2 prior links, even revoked ones, becomes `"Guest 3"`).
- `sharedLinks` insert uses `ON CONFLICT (linkPublicKey) DO UPDATE SET id = shared_links.id`
  (effective no-op update) — idempotent on duplicate `linkPublicKey`, returns the existing row's
  ID.
- `conversationMembers` insert uses `ON CONFLICT (conversationId, linkId) WHERE leftAt IS NULL DO
  UPDATE SET id = ...` similarly idempotent.
- If `rotation` is supplied, `submitRotation` runs instead of a direct `epochMembers` insert
  (mutually exclusive with the plain-wrap insert path — "no history" links always trigger
  rotation).
- On success with `rotation`, broadcasts `rotation:complete` `{ conversationId, newEpochNumber:
  rotation.expectedEpoch + 1 }`.
- Response: `{ linkId, memberId }`, HTTP `201`.
- `displayName` validation: empty string or non-string → `400`.

#### Revoke link — `POST /api/links/:conversationId/revoke`

- `requirePrivilege('admin')`.
- Body: `{ linkId, rotation }` (rotation always required — omission → `400`).
- Atomic idempotent claim: `UPDATE sharedLinks SET revokedAt = now() WHERE id = ? AND
  conversationId = ? AND revokedAt IS NULL RETURNING id`. Zero rows (not found or already revoked)
  → `{ revoked: false, memberId: null }` → route returns `404 LINK_NOT_FOUND`.
- If the link's `conversationMembers` row is found active, sets its `leftAt = now()`.
- Always runs `submitRotation` after the link/member updates (rotates the epoch to revoke crypto
  access) — `StaleEpochError` → `409 STALE_EPOCH`; `WrapSetMismatchError` → `400
  WRAP_SET_MISMATCH`.
- Broadcasts `member:removed` (if a member row existed) then `rotation:complete` with
  `newEpochNumber: rotation.expectedEpoch + 1`.
- Response: `{ revoked: true }`, 200.

#### Change link privilege — `PATCH /api/links/:conversationId/:linkId/privilege`

- `requirePrivilege('admin')`.
- Body: `{ privilege: 'read' | 'write' }` — note `'admin'` and `'owner'` are explicitly rejected by
  the enum (`z.enum(['read', 'write'])`); attempting either returns `400`.
- No key rotation on privilege change — "privilege changes don't revoke access."
- Link not found / already revoked → `changed: false` → route `404 LINK_NOT_FOUND`.
- Updates `conversationMembers.privilege` (authoritative store) keyed by `linkId`.
- On success, broadcasts `member:privilege-changed` `{ conversationId, memberId, privilege }`
  (only if a member row existed).
- Response: `{ changed: true }`, 200.

#### Rename link (admin) — `PATCH /api/links/:conversationId/:linkId/name`

- `requirePrivilege('admin')`.
- Body: `{ displayName }` (`min(1).max(100)` — empty or >100 chars → `400`).
- Existence check (`sharedLinks.id = ? AND revokedAt IS NULL`) → `404 LINK_NOT_FOUND` if absent.
- Direct `UPDATE sharedLinks SET displayName = ?`.
- Response: `{ success: true }`, 200.

#### Rename own display name (link-guest self-service) — `PATCH /api/links/:conversationId/my-name`

- `requireLinkGuest()` (not `requirePrivilege` — link guests self-serve here, no admin needed).
- Body: `{ displayName }` (`min(1).max(100)`).
- Updates the caller's own `sharedLinks.displayName` keyed by `linkGuest.linkId` from the
  resolved session — no existence check needed (guest resolution middleware already verified it).
- Response: `{ success: true }`, 200.

### Members

Constants: `MAX_CONVERSATION_MEMBERS = 100`.

Privilege ordering (`packages/shared/src/utils/privileges.ts`, numeric levels):
`read = 0`, `write = 1`, `admin = 2`, `owner = 3`.

- `canRemoveMember(actor, target)`: actor must be `>= admin` (level 2) AND strictly higher level
  than target. (Admin cannot remove another admin; only owner can remove an admin.)
- `canAddMembers(privilege)` / `canManageLinks(privilege)`: `>= admin` (level 2).
- `canSendMessages(privilege)`: `>= write` (level 1).
- `canChangePrivilege(actor, targetCurrent, newPrivilege)`: actor must be `>= admin`; both the
  target's current privilege level and the new privilege level must be strictly lower than the
  actor's level (an admin cannot promote someone to admin or higher — only an owner can grant
  admin).
- `isOwner(privilege)`: `privilege === 'owner'`.

#### List members — `GET /api/members/:conversationId`

- `requirePrivilege('read', { allowLinkGuest: true })`.
- Returns only active members (`leftAt IS NULL`), left-joined to `users` (username) and
  `sharedLinks` (displayName for link members).
- `userId` in the response resolves to `r.userId ?? r.linkId ?? r.id` (falls back through link ID
  to the member row's own ID if both are somehow null); `username` resolves to `r.username ??
  r.linkDisplayName ?? 'Unknown'`.
- Fields per member: `id`, `userId`, `linkId`, `username`, `privilege`, `visibleFromEpoch`,
  `joinedAt` (ISO string).

#### Add member — `POST /api/members/:conversationId/add`

- `requirePrivilege('admin')`.
- Body: `userId`, `privilege` (`memberPrivilegeSchema`), `giveFullHistory` (boolean), optional
  `wrap`, optional `rotation`. Zod `.refine`: `giveFullHistory ? wrap !== undefined : rotation !==
  undefined`.
- Target user lookup by ID → `404 NOT_FOUND` if missing.
- Conversation+epoch lookup → `404 CONVERSATION_NOT_FOUND` if missing.
- Member-count gate: `memberCount >= 100` → `400 MEMBER_LIMIT_REACHED`.
- `visibleFromEpoch = giveFullHistory ? 1 : (rotation?.expectedEpoch ?? 0) + 1`.
- Insertion uses `INSERT ... ON CONFLICT (conversationId, userId) WHERE leftAt IS NULL DO NOTHING`
  — atomic duplicate detection; a `null` return (0 rows) means "already an active member" → HTTP
  `409 ALREADY_MEMBER`.
- With `giveFullHistory`: inserts one `epochMembers` row directly (`wrap` required — throws an
  invariant error if missing, defense-in-depth since Zod already enforces it).
- Without full history: calls `submitRotation` (throws if `rotation` missing — same
  defense-in-depth invariant).
- New member is inserted with `acceptedAt: null` (pending invite state — must later `PATCH
  .../accept`), `invitedByUserId` set to the inviter.
- On success (full history): no `rotation:complete` broadcast, only `member:added` (implied via
  `broadcastMemberAdded`, not fully quoted but confirmed by tests: "does not broadcast
  rotation:complete adding full history"). On success without history: broadcasts
  `rotation:complete` in addition.
- Response: `{ member: { id, userId, username, privilege, visibleFromEpoch, joinedAt } }`, HTTP
  `201`.
- `StaleEpochError` / `WrapSetMismatchError` from `submitRotation` map to `409 STALE_EPOCH` /
  `400 WRAP_SET_MISMATCH` respectively (via `handleRotationError`).

#### Remove member — `POST /api/members/:conversationId/remove`

- `requirePrivilege('admin')`.
- Body: `{ memberId, rotation }` (rotation always required for remove).
- Target member lookup via `findActiveMember` → `404 MEMBER_NOT_FOUND` if not an active member.
- Cannot remove self → `400 CANNOT_REMOVE_SELF`.
- Cannot remove the owner → `403 CANNOT_REMOVE_OWNER` (checked via `isOwner(targetMember.privilege)`,
  independent of the requester's own privilege level).
- Requester privilege check via `canRemoveMember` → `403 PRIVILEGE_INSUFFICIENT` if the requester
  isn't strictly senior to the target (e.g. admin cannot remove admin; write-privilege user can
  never remove anyone).
- Transaction: sets `leftAt = now()` on the target's `conversationMembers` row, then
  `submitRotation`.
- Broadcasts `member:removed` `{ conversationId, memberId, userId? }` then `rotation:complete`
  `{ conversationId, newEpochNumber: rotation.expectedEpoch + 1 }`.
- Response: `{ removed: true }`, 200.

#### Change member privilege — `PATCH /api/members/:conversationId/privilege`

- `requirePrivilege('admin')`.
- Body: `{ memberId, privilege }`.
- Target lookup via `findActiveMember` → `404 MEMBER_NOT_FOUND`.
- Cannot change own privilege → `403 CANNOT_CHANGE_OWN_PRIVILEGE`.
- `canChangePrivilege` gate → `403 PRIVILEGE_INSUFFICIENT` otherwise (e.g. an admin cannot promote
  a member to `admin`).
- No key rotation involved (privilege changes don't affect crypto access).
- Broadcasts `member:privilege-changed` `{ conversationId, memberId, privilege }`.
- Response: `{ updated: true, memberId, privilege }`, 200.

#### Leave conversation — `POST /api/members/:conversationId/leave`

- `requirePrivilege('read')`.
- Body: `{ rotation? }`.
- Owner leaving: deletes the entire conversation (cascade cleanup), **no rotation** — response
  `{ deleted: true }`, 200.
- Non-owner leaving: `rotation` is mandatory — missing → `400 ROTATION_REQUIRED`. Sets `leftAt` on
  own membership row, runs `submitRotation`.
- Broadcasts `member:removed` then presumably `rotation:complete` (pattern consistent with
  remove); response `{ left: true }`, 200.
- `StaleEpochError` on leave → `409 STALE_EPOCH`.

#### Mute — `PATCH /api/members/:conversationId/mute`

- `requirePrivilege('read')`.
- Body: `{ muted: boolean }` — missing field → `400`.
- Direct `UPDATE conversationMembers SET muted = ? WHERE conversationId = ? AND userId = ? AND
  leftAt IS NULL` (self-only, no target member param).
- Response: `{ muted }`, 200. No broadcast.

#### Pin — `PATCH /api/members/:conversationId/pin`

- `requirePrivilege('read')`.
- Body: `{ pinned: boolean }` — missing field → `400`.
- Same self-only atomic update pattern as mute, on the `pinned` column.
- Response: `{ pinned }`, 200. No broadcast.

#### Decline invite — `POST /api/members/:conversationId/decline`

- `requirePrivilege('read')`.
- For **pending** invites only (`acceptedAt IS NULL`); accepted members must use `/leave`.
- Atomic `UPDATE ... WHERE id = requesterMember.id AND acceptedAt IS NULL AND leftAt IS NULL
  RETURNING id` — 0 rows affected (already accepted) → `400 VALIDATION` and **no broadcast**.
- On success: sets `leftAt = now()`, broadcasts `member:removed` `{ conversationId, memberId,
  userId }`.
- Response: `{ declined: true }`, 200.
- Caller cannot decline on another user's behalf — id is always scoped to the session-derived
  `requesterMember.id`.

#### Accept invite — `PATCH /api/members/:conversationId/accept`

- `requirePrivilege('read')`.
- Idempotent: atomic `UPDATE ... SET acceptedAt = now() WHERE conversationId = ? AND userId = ?
  AND leftAt IS NULL` — already-accepted members simply get `acceptedAt` overwritten again
  (still `200`, since there's no conditional guard on `acceptedAt IS NULL` here, unlike decline).
- Response: `{ accepted: true }`, 200.

### Epoch Key Rotation (`services/keys/keys.ts`)

Central mechanism triggered by member add-without-history, member remove, non-owner leave, and
link revoke.

- `StaleEpochError`: thrown when the caller's `expectedEpoch` no longer matches
  `conversations.currentEpoch` (concurrent rotation already advanced it). Carries
  `currentEpoch` (the actual value) — surfaced as HTTP `409` with code `STALE_EPOCH` and
  `details: { currentEpoch }`.
- `WrapSetMismatchError`: thrown when the client-submitted `memberWraps` don't exactly match the
  server's authoritative set of active members' public keys (extra or missing wraps). Carries
  `expectedCount` and `providedCount` — surfaced as HTTP `400` code `WRAP_SET_MISMATCH`.
- `submitRotation(tx, params)` steps, all inside one transaction/CTE-equivalent:
  1. **First-write-wins concurrency guard**: `UPDATE conversations SET currentEpoch =
     expectedEpoch+1, updatedAt = now() WHERE id = ? AND currentEpoch = expectedEpoch RETURNING
     currentEpoch`. Zero rows updated → re-reads current epoch and throws `StaleEpochError`
     (pinned by test: two concurrent `submitRotation` calls with the same `expectedEpoch` — one
     succeeds, the other rejects with `StaleEpochError`; final `currentEpoch` reflects only the
     winner).
  2. Inserts a new `epochs` row: `epochNumber = expectedEpoch + 1`, plus the caller-supplied
     `epochPublicKey`, `confirmationHash`, `chainLink`.
  3. Re-reads authoritative `visibleFromEpoch` per member from `conversationMembers` (joined to
     `users` for user members, `sharedLinks` for link members) — **never trusts the client's
     `visibleFromEpoch`** for the wrap rows it writes.
  4. `validateWrapSet`: expected key set = all currently-active members' public keys; provided
     key set = `memberWraps` public keys. Any mismatch (size or membership) → `WrapSetMismatchError`.
  5. Inserts new `epochMembers` rows for the new epoch, using the **server-computed**
     `visibleFromEpoch` (not the client-provided value) for each row.
  6. **Deletes the old epoch's `epochMembers` rows entirely** — old epoch key wraps are destroyed
     for all members, forcing the crypto-level access to be exactly what the new epoch's wraps
     grant (this is *the* mechanism that revokes access on remove/leave/revoke).
  7. Updates `conversations.title` and `titleEpochNumber` to the caller-supplied `encryptedTitle`
     re-encrypted for the new epoch (every rotation re-encrypts the title so it stays readable
     without a chain-link hop for current members).
- `chainLink`: each epoch row can carry a `chainLink` (encrypted link to the previous epoch's
  private key) so members who were visible starting at an earlier epoch can traverse forward
  through the chain to derive keys for epochs before their own `visibleFromEpoch` was granted —
  but NOT epochs before their granted `visibleFromEpoch` (no-history members structurally cannot
  derive pre-join epoch keys even via chain-link traversal — pinned by tests
  `no-history auth user cannot derive previous epoch key via chain links` and the link-guest
  equivalent).
- `getKeyChain` / `getKeyChainBatch`: returns each member's set of `wraps` (their own epoch wraps,
  filtered to `epochNumber >= visibleFromEpoch`) and `chainLinks` (all chain-link rows with
  `epochNumber > visibleFromEpoch`) plus `currentEpoch`. Batch version does 3 total queries
  (not N×3) for multiple conversations.
- Link revocation and non-owner member removal both flow through the identical `submitRotation`
  mechanism as adding a member without history — one shared rotation primitive for all
  access-revoking operations.

### Message Shares (`/api/messages/share`, `/api/shares/:shareId`)

#### Create share — `POST /api/messages/share`

- `requireAuth()`.
- Rate limit: `shareCreateUserRateLimit` — **20 requests / 60s window** per user (Redis key
  `share:create:user:ratelimit:{userId}`, TTL 60s).
- Body: `{ messageId, wrappedShareKey }` (base64-encoded wrap of the message's content key under a
  fresh `shareSecret`-derived key; the `shareSecret` itself lives only in the client URL fragment,
  never sent to the server).
- Message existence pre-check (cheap, outside the transaction) → `404 MESSAGE_NOT_FOUND` if
  missing (distinguishes not-found from forbidden).
- Inside one transaction: `SELECT ... FOR SHARE` locks the caller's active membership row for the
  message's conversation for the transaction duration — closes a check-then-act race where a
  concurrent member-removal could otherwise slip in between the membership check and the insert.
  No active membership → `403 SHARE_FORBIDDEN` with `details: { messageId }`.
- On success, inserts a `sharedMessages` row: `{ messageId, wrappedContentKey: <decoded bytes> }`.
- Response: `{ shareId }`, HTTP `201`.

#### Public share fetch — `GET /api/shares/:shareId`

- No authentication required.
- Rate limit: `shareGetIpRateLimit` — **30 requests / 60s window** per IP (Redis key
  `share:get:ip:ratelimit:{ipHash}`, TTL 60s) — explicitly framed as scraping/scanning throttle.
- Share lookup by ID → `404 SHARE_NOT_FOUND` if missing.
- Fetches all `content_items` for the shared message, ordered by `position ASC`.
- **Serialization strips sensitive fields present in the internal view**: `modelName`, `cost`,
  `isSmartModel`, and the internal `storageKey` are never included in the public response —
  "share recipients see content, not generation metadata."
- For media content types (`image`, `audio`, `video`) with a non-null `storageKey`, mints a
  presigned `downloadUrl` + `expiresAt` per item via `mediaStorage.mintDownloadUrl`; text items get
  `downloadUrl: null, expiresAt: null` without ever calling the storage layer.
- Defense-in-depth mime validation: re-parses `item.mimeType` against `ALLOWED_MEDIA_MIME_TYPES`
  at read time (the write path already enforces this) — a disallowed/legacy mime type on a stored
  row causes the whole request to fail with `500 STORAGE_READ_FAILED` (not silently included).
- A presigned-URL minting failure (any item) → `500 STORAGE_READ_FAILED`, logged via
  `console.error('Presigned URL mint failed for share', { shareId, messageId, itemCount, error })`.
- Response fields: `shareId`, `messageId`, `wrappedShareKey` (base64), `contentItems[]`,
  `createdAt` (ISO). Each content item: `id`, `contentType`, `position`, `encryptedBlob` (base64
  or null), `mimeType`, `sizeBytes`, `width`, `height`, `durationMs`, `downloadUrl`, `expiresAt`.

### Media

Constants: `MEDIA_DOWNLOAD_URL_TTL_SECONDS = 300` (5 minutes), `MAX_MEDIA_OBJECT_BYTES =
250_000_000` (250 MB), `ALLOWED_MEDIA_MIME_TYPES` = `['image/png', 'image/jpeg', 'image/webp',
'audio/mpeg', 'audio/wav', 'audio/ogg', 'video/mp4', 'video/webm']`.

#### Download URL minting — `GET /api/media/:contentItemId/download-url`

- Custom auth middleware (`requireMediaCaller`) admits **either** a session user or a link guest
  (resolved via the `x-link-public-key` header through `resolveLinkGuestByKey`). Neither present →
  `401 NOT_AUTHENTICATED`. A link-guest header that doesn't resolve to any active link → `401`.
- Rate limit: `mediaDownloadUserRateLimit` — **60 requests / 60s window** per caller (user ID or
  `link:{linkId}`), Redis key `media:download:user:ratelimit:{callerId}`, TTL 60s — framed as
  "minting is cheap but a flood could DoS the signing path (R2 SigV4)."
- Authorization query joins: `content_items → messages → conversation_members (active, caller's
  identity) → epochs (by conversationId+epochNumber) → epoch_members (epochId + caller's public
  key)`. **Both** conversation membership AND epoch-membership for the *specific epoch the message
  belongs to* are required — closes a gap where a late-joiner with only conversation-level access
  could mint download URLs for ciphertext from epochs before they joined (they can't decrypt it,
  but could exfiltrate the encrypted blob). Non-epoch-members get the same blind `404` as
  non-existent content (`404 CONTENT_ITEM_NOT_FOUND`) — no distinction disclosed.
- `contentType` must be one of `image`/`audio`/`video` AND `storageKey` must be non-null; text
  items (or any item with `storageKey: null`) → `400 CONTENT_ITEM_NOT_MEDIA`.
- On success: `mediaStorage.mintDownloadUrl({ key: storageKey })` → `{ downloadUrl, expiresAt }`,
  HTTP `200`.
- Mint failure (storage error) → `500 STORAGE_READ_FAILED` (no logging observed in this specific
  route, unlike the public-shares route).

### Object Storage (`services/storage`) — MediaStorage abstraction

Single S3-compatible codepath (`aws4fetch`) — MinIO in dev/CI, Cloudflare R2 in production,
differing only by env config. No multipart upload; single-PUT only.

#### Configuration

- Required env vars (fail-fast, all five checked, empty-string also rejected): `R2_S3_ENDPOINT`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_MEDIA`. Missing/empty any one → throws
  synchronously at construction with the specific var name in the message (e.g.
  `/R2_ACCESS_KEY_ID/`).
- `AwsClient` constructed with `{ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }`.
- Object key URL-encoding is **per-segment** (split on `/`, `encodeURIComponent` each segment,
  rejoin with literal `/`) — preserves path structure while escaping special characters within
  segments (e.g. `media/conv id/foo&bar.enc` → `media/conv%20id/foo%26bar.enc`, slashes
  untouched).
- Presigned URLs use query-string signing (`X-Amz-Expires=<ttl>`) via `aws.sign(url, { method:
  'GET', aws: { signQuery: true } })`.

#### `put(key, bytes, contentType)`

- Guards `bytes.byteLength > MAX_MEDIA_OBJECT_BYTES (250_000_000)` **before** issuing any network
  call — throws `StorageWriteError` synchronously; exactly `250_000_000` bytes is accepted.
- Issues `PUT {endpoint}/{bucket}/{encoded key}` with `Content-Type` header and raw body.
- Non-OK response or network failure → wraps as `StorageWriteError` (cause preserved).

#### `delete(key)`

- Issues `DELETE {endpoint}/{bucket}/{key}`.
- **204 is treated as success for both existing and missing keys** — R2/MinIO never return 404 on
  delete, so idempotent-delete semantics rely on 204/2xx always meaning success; any non-OK
  response (e.g. 500) → `StorageWriteError`.

#### `mintDownloadUrl({ key, expiresInSec? })`

- Default TTL: `MEDIA_DOWNLOAD_URL_TTL_SECONDS = 300` seconds (5 min) if `expiresInSec` omitted.
- Returns `{ url, expiresAt }` where `expiresAt` is an ISO-8601 string computed as `now +
  ttl*1000`.
- Signing failure → `StorageReadError`.

#### `list(prefix, { cursor?, limit? })`

- Default limit: `DEFAULT_LIST_LIMIT = 1000` (S3 `list-type=2`, `max-keys`, optional
  `continuation-token`).
- Hand-rolled XML parser for `ListObjectsV2` response (no XML library dependency):
  - Extracts `<Contents>` blocks: `Key`, `LastModified`, `Size`.
  - Tag matching tolerates an optional namespace prefix (e.g. `<s3:Contents>`,
    `<s3:Key>`) and self-closing tags (`<IsTruncated/>` parses as empty string / not-truncated).
  - Decodes exactly five named XML entities: `&amp;` `&lt;` `&gt;` `&quot;` `&apos;`. Numeric
    character references (`&#NN;`, `&#xHH;`) are explicitly not handled (S3 doesn't emit them).
    Raw Unicode (e.g. emoji) and literal `%`/`+` pass through undecoded, as S3 doesn't
    entity-encode them.
  - A `Contents` block with a non-numeric or missing `Size` is **skipped** (not aborted) with a
    `console.warn('parseListObjectsV2Response: skipping non-numeric Size', { key, sizeRaw })`.
  - `nextCursor` is present only when `<IsTruncated>true</IsTruncated>` and a
    `NextContinuationToken` is found.
- Non-OK response → `StorageReadError`.

#### Evidence recording

- Optional `EvidenceConfig` (`{ db, isCI }`) — when supplied, every successful `put`/`delete`/
  `mintDownloadUrl`/`list` call records `SERVICE_NAMES.R2_STORAGE` evidence via
  `recordServiceEvidence(db, isCI, SERVICE_NAMES.R2_STORAGE)`. `recordServiceEvidence` itself
  gates on `isCI === true` internally, so passing evidence config in production is a no-op.
  Evidence is **not** recorded on failed operations (verified for a failed PUT).

### R2 Garbage Collection (daily cron — `services/gc/r2-gc.ts`)

- `DEFAULT_PREFIX = 'media/'`, `DEFAULT_CUTOFF_MS = 24 * 60 * 60 * 1000` (24 hours),
  `DEFAULT_BATCH_SIZE = 1000` (objects per `list` page).
- `GC_DELETE_BATCH_SIZE = 50` — deletes are chunked into groups of 50 and fanned out in parallel
  per chunk via `Promise.allSettled` (explicitly documented as staying under Cloudflare Workers'
  concurrent-fetch cap per invocation while avoiding a fully-sequential await that would blow the
  CPU budget at scale). A single chunk's rejection does not abort the rest of that chunk or
  subsequent chunks.
- `MAX_GC_RUNTIME_MS = 25_000` (25 seconds) — soft runtime budget; the Workers `cpu_ms` ceiling is
  documented as 30s, so the run bails with headroom to record evidence/stats. Checked at the top
  of each pagination loop iteration (before issuing the next `list` call), not mid-page. On bail:
  `console.warn('r2-gc bailing early due to MAX_GC_RUNTIME_MS', { scanned, deleted, durationMs })`
  and `partialCompletion: true` in the returned stats.
- Cutoff semantics: **strict inequality** — `now - uploaded.getTime() > cutoffMs`. An object
  exactly 24h old (not "more than" 24h) is treated as still-recent and NOT deleted (pinned by
  test: "uses cutoff exactly at the 24h boundary as still-recent").
- The 24h cutoff is explicitly to protect in-flight uploads whose DB transaction hasn't committed
  yet.
- Orphan detection: batches eligible (age-qualified) object keys and looks them up via `IN (...)`
  against `content_items.storage_key`; any key with no matching row is an orphan.
- Individual delete failures are logged (`console.error('r2-gc delete failed', { key, error })`)
  and do not abort the run; a failure during `list` (pagination) propagates and aborts the whole
  run.
- Returned stats: `{ scanned, orphansFound, deleted, bytesReclaimed, durationMs,
  partialCompletion }`.
- Evidence: optional `EvidenceConfig`; on completion (success or partial), records
  `SERVICE_NAMES.R2_GC` with the full stats payload including `partialCompletion` "so dashboards
  can flag pile-ups."

### Error codes observed in this scope (HTTP status mapping)

| Code | Status | Context |
|---|---|---|
| `NOT_AUTHENTICATED` | 401 | Missing/invalid session or link-guest identity |
| `CONVERSATION_NOT_FOUND` | 404 | Missing, not a member, ex-member, or cross-user access attempt |
| `EPOCH_NOT_FOUND` | 404 | No current epoch row for a conversation |
| `MEMBER_LIMIT_REACHED` | 400 | `memberCount >= MAX_CONVERSATION_MEMBERS (100)` |
| `PRIVILEGE_INSUFFICIENT` | 403 | Below required privilege level for the action |
| `STALE_EPOCH` | 409 | `expectedEpoch` mismatch during rotation; `details.currentEpoch` |
| `WRAP_SET_MISMATCH` | 400 | Client wrap set doesn't match server's active-member set |
| `LINK_NOT_FOUND` | 404 | Link missing or already revoked |
| `MEMBER_NOT_FOUND` | 404 | Target `conversationMembers` row not active |
| `ALREADY_MEMBER` | 409 | Add-member hit the active-uniqueness conflict |
| `CANNOT_CHANGE_OWN_PRIVILEGE` | 403 | Self-target on privilege change |
| `CANNOT_REMOVE_OWNER` | 403 | Target is the owner |
| `CANNOT_REMOVE_SELF` | 400 | Self-target on remove |
| `ROTATION_REQUIRED` | 400 | Non-owner leave without a rotation payload |
| `VALIDATION` | 400 | Generic validation failure (e.g. decline on an already-accepted member) |
| `UNAUTHORIZED` | 401 | Session user missing where required (mute/pin routes) |
| `FORK_NAME_TAKEN` | 409 | Fork name collides with an existing name in the conversation |
| `FORK_LIMIT_REACHED` | 400 | At `MAX_FORKS_PER_CONVERSATION (5)` |
| `MESSAGE_NOT_FOUND` | 404 | Share-create target message missing |
| `SHARE_FORBIDDEN` | 403 | Not an active conversation member at share-create time; `details.messageId` |
| `SHARE_NOT_FOUND` | 404 | Public share ID missing |
| `STORAGE_READ_FAILED` | 500 | Presigned URL mint or storage read failure |
| `CONTENT_ITEM_NOT_FOUND` | 404 | Media item missing or caller lacks epoch/conversation access (blind) |
| `CONTENT_ITEM_NOT_MEDIA` | 400 | Content item is text or has no `storageKey` |
| `INTERNAL` | 500 | Share insert returned no row (defensive fallback) |

### Rate limits in this scope

| Key | Window | Max attempts | Scope |
|---|---|---|---|
| `mediaDownloadUserRateLimit` | 60s | 60 | Per caller (user ID or `link:{linkId}`) |
| `shareGetIpRateLimit` | 60s | 30 | Per IP hash |
| `shareCreateUserRateLimit` | 60s | 20 | Per user ID |

### Header / identity conventions

- Link-guest identity is carried via the `x-link-public-key` request header (base64-encoded
  public key), resolved server-side to an active `sharedLinks` + `conversationMembers` pair.
- All binary payloads (public keys, wraps, hashes, ciphertext) cross the API boundary as
  base64 strings, decoded server-side via `fromBase64`/`toBase64` from `@hushbox/shared`.


---

## 04. Chat Turn Execution & Streaming

This report documents the legacy chat-turn engine: request validation and routing (`routes/chat.ts`, `routes/trial-chat.ts`), billing resolution and reservation math, the pre-inference stage chain (Smart Model classification), the SSE streaming/broadcast layer, the media generation pipeline (image/video/audio), and the message-tree persistence layer underneath `saveChatTurn`.

---

### 1. Media generation pipeline (image / video / audio)

A single shared orchestrator (`executeMediaPipeline`, in `lib/media-pipeline.ts`) drove image, video, and audio generation. It fanned out per-model inference, collected generated bytes, encrypted with the conversation's epoch key, stored ciphertext in R2, computed exact post-flight costs, persisted via `saveChatTurn`, attached presigned URLs to the SSE `done` event, and broadcast completion. Modality-specific behavior (request shape, pricing, fallback error message) plugged in via a `MediaModalityStrategy` descriptor (see §2); the orchestrator itself was modality-agnostic beyond a `mediaType` discriminator restricted to `'image' | 'audio' | 'video'`.

#### 1.1 SSE event sequence emitted by the media pipeline

1. `start` — carries `userMessageId` and the list of `{ modelId, assistantMessageId }` pairs for the batch.
2. `model:media:start` — one per model, emitted **before** the gateway call so the UI can swap "Loading…" for "Generating…" ahead of a long wait. Carries `modelId`, `assistantMessageId`, `mediaType`, and a **placeholder** `mimeType` of `application/octet-stream` (the real mime arrives later, attached to the persisted content item in `done`).
3. (video only) `model:media:progress` — synthetic progress percentage events (see §1.2).
4. `model:done` / `model:error` per model, from the underlying stream collector (§3).
5. `done` — final event once billing/persistence succeeds, carrying attached download URLs.
6. `error` — one of `EMPTY_MEDIA_RESULT`, `UNKNOWN_MIME_TYPE`, `STORAGE_WRITE_FAILED`, or `BILLING_ERROR` (exact string values below) when the batch fails as a whole.

#### 1.2 SSE keep-alive

While the media pipeline stream is open, a `setInterval` fires every `KEEPALIVE_INTERVAL_MS` (= **30,000 ms** / 30s) writing the raw SSE comment line `:keep-alive\n\n` directly to the stream. Per the SSE spec, lines beginning with `:` are comments dropped by `EventSource` consumers, but the bytes still reach the underlying `ReadableStream` reader, which is what the client's `readWithTimeout` watches — so this heartbeat exists purely to reset a client-side stream timeout during long-running video generations. Write failures during keep-alive are swallowed; the next typed write via `writeIfConnected` is what surfaces disconnection through the writer's `onAbort` callback. The keep-alive timer is always cleared in the `finally` block.

#### 1.3 Video synthetic progress sweep

Video generation (not image or audio) drives a synthetic 0→95% progress bar via `startVideoProgressTimer`, keyed off an **expected duration** estimate rather than any real signal from the gateway:

- **`VIDEO_GENERATION_MULTIPLIER = 8`** — the requested video `durationSeconds` is multiplied by 8 (then ×1000 for ms) to estimate total gateway generation wall-clock time. Comment states AI Gateway video providers run "roughly 5–10x real-time"; 8 was chosen as "a safe midpoint."
- **`VIDEO_DEFAULT_REQUESTED_SECONDS = 5`** — used when the request omits `durationSeconds`, so `expectedMs = 5 × 8 × 1000 = 40,000 ms` by default.
- **`MAX_PROGRESS_PERCENT = 95`** — the sweep never reaches 100%; 100% is implied only by the `model:done` event.
- **`PROGRESS_PERCENT_STEP = 10`** — the sweep advances in 10-percentage-point increments. `stepCount = floor(95/10) = 9`.
- Sweep cadence: `sweepIntervalMs = max(1, floor(expectedDurationMs / stepCount))` — e.g. for the 40,000 ms default, `floor(40000/9) ≈ 4444 ms` between emissions.
- Once the sweep reaches 95%, it switches to a heartbeat: **`PROGRESS_HEARTBEAT_INTERVAL_MS = 5000`** (5s) — re-emits `percent: 95` every 5 seconds until the gateway call returns.
- The progress event is emitted **once per model in the batch** on every tick, not just for the primary model.
- The timer is explicitly stopped right before billing runs (so `model:done` implies the jump to 100%), and defensively stopped again in the `finally` block.
- Image and audio never start this timer — comment: they're "fast enough that the placeholder UI is sufficient" / "audio is similarly short."
- Confirmed separately: media generation has **no pipeline-side deadline/timeout** — a `chat.test.ts` regression test injects a 500ms artificial delay into the mock video stream and asserts the pipeline awaits it in full rather than cutting it off (comment: "the 15-min case is the same code path — platform `fetch` has no default timeout").

#### 1.4 Mime-type validation and defaults

- **`ALLOWED_MEDIA_MIME_TYPES`** enum: `image/png`, `image/jpeg`, `image/webp`, `audio/mpeg`, `audio/wav`, `audio/ogg`, `video/mp4`, `video/webm`. Chosen to match exactly what the AI Gateway mock/real clients produce.
- **`DEFAULT_MIME_TYPE_BY_MODALITY`**: `image` → `image/png`, `video` → `video/mp4`, `audio` → `audio/mpeg`. Used when the gateway result omits a mime type (observed for TTS results): `mimeType ?? defaultMimeType(pricing.kind)`.
- Before encrypting/storing, if the gateway returned bytes with a mime type present but **not** in `ALLOWED_MEDIA_MIME_TYPES`, the pipeline throws and the row is never persisted — surfaces as SSE `error` with code **`UNKNOWN_MIME_TYPE`**, message `Disallowed mime type from gateway: {mimeType}`.

#### 1.5 Storage & encryption per media item

- Storage key format: `` media/{conversationId}/{assistantMsgId}/{contentItemId}.enc `` (`contentItemId` is a fresh `crypto.randomUUID()`).
- Encryption: `beginMessageEnvelope(epochPublicKey)` derives a per-message `contentKey` + `wrappedContentKey`; `encryptBinaryWithContentKey` encrypts the raw media bytes into `ciphertext`.
- The epoch is read live from the `conversations` table (`currentEpoch` column) immediately before encryption; if the conversation row is missing entirely, the code falls back to **epoch 1** (`conv?.currentEpoch ?? 1`).
- R2 `put` is wrapped so a rejected write surfaces as SSE `error` with code **`STORAGE_WRITE_FAILED`** (message = the underlying error's message, or `String(cause)` if not an `Error`); the write is never retried inline.
- After a successful `put`, a presigned download URL is minted via `mediaStorage.mintDownloadUrl({ key, expiresInSec: MEDIA_DOWNLOAD_URL_TTL_SECONDS })`. `MEDIA_DOWNLOAD_URL_TTL_SECONDS = 300` (5 minutes).
- `content_items.sizeBytes` records the **ciphertext** length (post-encryption), not the plaintext media byte length.
- `content_items.cost` is stored as a fixed 8-decimal-place string via `totalCost.toFixed(8)` (e.g. `'0.04600000'`, `'0.10000000'`, `'0.04500000'`).

#### 1.6 Per-modality pricing (`MediaPersistPricing`)

- **Image**: `{ kind: 'image', perImage: number }` — a flat per-image dollar price looked up per model from `ImageBillingValidationSuccess.perImageByModel` (a `Map<modelId, price>`); billed at the *actual selected model's* price, not a worst-case/max across the batch. Integration test: `google/imagen-4`, total cost `$0.046` (`'0.04600000'`).
- **Video**: `{ kind: 'video', perSecond, durationSeconds, resolution }` — priced per **requested** second (not measured) at a per-model rate. Integration test: `google/veo-3.1-fast-generate-001`, `720p`, total cost `$0.10` (`'0.10000000'`).
- **Audio**: `{ kind: 'audio', perSecond, durationSeconds }` — unlike video, `durationSeconds` is derived from the **actual generated** `result.durationMs` (TTS duration is determined by synthesis output, not requested up front): `(result.durationMs ?? 0) / 1000`; a missing duration falls back to 0 seconds, yielding "storage-only" cost. Integration test: `openai/tts-1`, 3000ms duration, `$0.015/sec` rate → total `$0.045` (`'0.04500000'`, comment: "3 seconds × $0.015/sec from MOCK_MODELS audio entry").
- `ImageBillingValidationSuccess` / `VideoBillingValidationSuccess` / `AudioBillingValidationSuccess` each carry `worstCaseCents` (the upper-bound reservation) and an optional `groupBudget`. Video carries the fixed requested `durationSeconds`/`resolution`; audio carries `maxDurationSeconds` (the worst-case reservation ceiling the user picked, not the actual generated length).

#### 1.7 Group billing context propagation

`buildGroupBillingContext(memberContext, groupBudget)` returns `{ memberId: memberContext.memberId }` only when **both** `memberContext` and `groupBudget` are defined (a non-owner member whose spend was reserved against a group/conversation budget); otherwise `undefined`. Shared by all three media pipelines and (per its doc comment) mirrors the analogous rule in the text pipeline.

#### 1.8 Failure handling paths (SSE error codes)

- **All models fail with an error** → surfaces the *first* classified error's code (see §5 for the classification table: `RATE_LIMITED`, `CONTENT_POLICY`, `INFERENCE_FAILED`, etc.).
- **All models "succeed" but return zero bytes / no error** → SSE `error` with code **`EMPTY_MEDIA_RESULT`**, message = the pipeline's configured `noContentErrorMessage` (`'No image generated'`, `'No video generated'`, `'No audio generated'` — see §2). Distinguished from a hard model failure so the UI can show "model produced nothing, try rephrasing" rather than "model failed."
- **Partial success**: only successful models (`error === null && mediaBytes !== undefined && mediaBytes.length > 0`) are encrypted/stored/persisted; failed ones are silently absent — no top-level error when at least one model succeeds.
- **`saveChatTurn` / billing failure** (handler returns `null`) → SSE `error` with code **`BILLING_ERROR`**, message `'Failed to save message'`.
- In every path, `releaseReservation()` runs in the `finally` block exactly once regardless of outcome.
- `fresh-send` tree actions broadcast a `message:new` realtime event (`messageId`, `conversationId`, `senderType: 'user'`, `senderId`, `content: prompt`) only **after** `saveChatTurn` has committed, to avoid a race where another viewer's refetch could run before the transaction commits.

---

### 2. Modality strategies (`lib/modality-strategies.ts`)

A `getStrategy(modality)` dispatcher (with per-modality function overloads for type narrowing) returns one of four strategy descriptors used to build inference requests and per-model pricing:

- **`textStrategy`** (`modality: 'text'`) — `buildRequest` composes `{ modality: 'text', model, messages, webSearchEnabled?, maxOutputTokens? }`, conditionally spreading `webSearchEnabled`/`maxOutputTokens` only when defined. Carries no `pricingFor`/`noContentErrorMessage` — those live in `stream-pipeline.ts` because text has a bespoke pipeline (Smart Model classification, multi-stage pre-inference, token broadcasting) with "no analogue in image/video/audio."
- **`imageStrategy`** — `buildRequest` composes `{ modality: 'image', model, prompt, aspectRatio? }`. `pricingFor` throws `` invariant: perImageByModel missing entry for {modelId} `` if the model is absent from the map (a defect condition). `noContentErrorMessage = 'No image generated'`.
- **`videoStrategy`** — `buildRequest` composes `{ modality: 'video', model, prompt, durationSeconds: billing.durationSeconds, resolution: billing.resolution, aspectRatio: extras.aspectRatio }` — `aspectRatio` is **required** for video (unlike image, where it's optional); duration/resolution come from resolved billing, not raw extras. `pricingFor` throws `` invariant: perSecondByModel missing entry for {modelId} `` on a missing entry. `noContentErrorMessage = 'No video generated'`.
- **`audioStrategy`** — `buildRequest` composes `{ modality: 'audio', model, prompt, format, voice? }`; `format` is the three-value enum `'mp3' | 'wav' | 'ogg'`, `voice` optional. `pricingFor` derives `durationSeconds` from the actual result. `noContentErrorMessage = 'No audio generated'`.
- `getStrategy` hits an `assertNever(modality)` default branch for any value outside the four-member `Modality` union — throws at runtime, pinned by a dedicated unit test.
- `ImageBuildExtras = { prompt, aspectRatio?: ImageAspectRatio }`; `VideoBuildExtras = { prompt, aspectRatio: VideoAspectRatio }` (required); `AudioBuildExtras = { prompt, format, voice? }`.

---

### 3. Multi-model stream collection (`lib/multi-stream.ts`)

Two parallel collector families — one for text token streams, one for media streams — both built on "consume N independent `InferenceStream`s in parallel via `Promise.all`, write model-tagged SSE events as events arrive, never let one model's failure abort the others."

**Text collection (`collectMultiModelStreams` / `collectSingleSlot`)**:
- Per slot, folds `InferenceEvent`s: a `text-delta` with non-empty `content` triggers `writer.writeModelToken({ modelId, content })` and accumulates into `state.content`; **empty-string deltas are skipped entirely** (no SSE write, no accumulation).
- A `finish` event with `providerMetadata?.generationId` present captures that id — used post-hoc to fetch exact billed cost.
- On success: `writer.writeModelDone({ modelId, assistantMessageId })`.
- On error (coerced to `Error('Unknown error')` if not already an `Error`): if `emitErrorEvent` (default **true**) is set, writes `writer.writeModelError({ modelId, message: error.message, code: classifyStreamErrorCode(error) })`; the regenerate route sets `emitErrorEvent: false` so it can write its own top-level `error` event and stay silent per-model.
- **Broadcast batching** via optional `onTokenBatch(modelId, content)`: content is buffered and flushed only once `Date.now() - lastFlushTime >= batchIntervalMs`; default **`DEFAULT_BATCH_INTERVAL_MS = 100 ms`** (comment: "mirrors stream-pipeline's BATCH_INTERVAL_MS", which is the same literal `100` re-declared in `stream-pipeline.ts` as `export const BATCH_INTERVAL_MS = 100`). Any remaining buffered content is always flushed once at the end of the stream (success or error path).
- Multiple model streams are consumed **concurrently**; an empty `entries` array returns an empty result `Map`.

**Media collection (`collectMultiMediaModelStreams` / `collectSingleMediaModelEvents`)**:
- Expected sequence per stream: `media-start` → `media-done` → `finish`.
- `media-start` triggers `writer.writeModelMediaStart({ modelId, assistantMessageId, mediaType, mimeType })` — the *real* early-start relay from the gateway client, distinct from the pipeline-level placeholder `model:media:start` emitted before the stream is even opened (§1.1).
- `media-done` captures `mediaBytes`, `mimeType`, `width`, `height`, `durationMs` (no SSE write on this event itself).
- `finish` captures `generationId`.
- On success: `writer.writeModelDone(...)`. On failure: `writer.writeModelError({ modelId, message, code: classifyStreamErrorCode(error) })` — media collection **always** emits the error event (no `emitErrorEvent` opt-out, unlike text).

---

### 4. Pre-inference pipeline (`lib/pre-inference/*`)

A `PreInferenceStage` is a per-slot processing step run before the main inference call. Each stage declares `id: StageId`, `reserveCents(): number` (worst-case cents it may incur, 0 for pure transforms), and `run(args): Promise<PreInferenceOutcome>` (`{ ok: true, transformation, billing } | { ok: false, errorCode }`).

#### 4.1 Stage resolution (`resolveStagesForSlot`, `stage-resolver.ts`)

Single source of truth for "which stages apply for which (modality, selection) combination." Today only one condition attaches a stage:

- `modality === 'text' && selectedModelId === SMART_MODEL_ID && smartModelResolution !== undefined` → returns `[createSmartModelStage(smartModelResolution)]`.
- Every other combination (explicit text model selection, any image/audio/video selection, or Smart Model selected but no `smartModelResolution` prepared — meaning billing couldn't afford even the cheapest eligible model + classifier overhead, and the request was already denied 402 upstream) → returns `[]` (empty chain).
- Comment: future stages listed as candidates for this same slot-attachment point — "prompt enhancer for image, history compressor for very long text conversations, aspect inferer, safety pre-check, search distiller" — none implemented.

#### 4.2 Pre-inference executor (`executePreInferenceChain`, `executor.ts`)

Runs a chain of stages **sequentially**, not in parallel:
- Each stage receives `upstream`: the cumulative `InferenceTransformation` merged from all earlier stages in the same chain (read-only; the executor does the merging via `{ ...merged, ...outcome.transformation }` after each stage).
- On the **first** stage returning `ok: false`, the executor stops immediately and returns `{ ok: false, errorCode }` — later stages never run.
- On full success: returns `{ ok: true, transformation, billings, stagesRun }` — `billings` collects only the stages whose outcome carried a non-null `billing` breadcrumb; `stagesRun` records every stage id that completed successfully **regardless of whether it produced a billing entry** (documented distinction: a fallback-to-cheapest Smart Model classification "ran" semantically for UI purposes like `derivedIsSmartModel` even with no bill).
- An empty `stages` array returns `{ ok: true, transformation: {}, billings: [], stagesRun: [] }`.
- The `assistantMessageId` is forwarded unchanged to every stage in the chain.

#### 4.3 Smart Model classification stage (`smart-model-stage.ts`)

`createSmartModelStage(config)` builds a stage with `id: 'smart-model'`, `reserveCents: () => config.classifierWorstCaseCents`.

**Config shape** (`SmartModelStageConfig`): `classifierModelId` (cheapest eligible text model), `eligibleInferenceIds` (pre-filtered by tier + budget), `classifierWorstCaseCents`, `modelMetadataById` (name+description lookup for prompt/SSE), `conversationContext` (`TruncationInput` — most recent user + assistant message).

**Execution flow** (`runSmartModelStage`):
1. Emits `writer.writeStageStart({ stageId: 'smart-model', assistantMessageId })` first, unconditionally.
2. **Single-eligible short-circuit**: if `eligibleInferenceIds.length === 1`, skips the classifier call entirely ("no billing, no waste") and resolves directly to that one id. Still emits `stage:start` and `stage:done`.
3. Otherwise, builds a classifier `TextRequest`: `{ modality: 'text', model: classifierModelId, messages: buildClassifierMessages({ truncatedContext: truncateForClassifier(conversationContext), eligibleModels: [{id, description}] }), maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP }`. The system-prompt message contains the literal marker string `` [HUSHBOX_CLASSIFIER] `` (asserted directly in a test).
4. Consumes the classifier's `InferenceStream`, accumulating `text-delta` content and capturing `generationId` from `finish`.
5. **Classifier throws** (network/provider error) → logs via `console.error('Smart Model classifier failed', error)`, falls back to `classifierModelId` (the cheapest eligible model) with **`billing: null`** (a call that threw produced no `generationId`, so nothing is billed for it) and `fallbackOccurred: true`.
6. **Classifier completes but produced a `generationId`** → builds a `PreInferenceBilling` breadcrumb (`{ stageId: 'smart-model', modelId: classifierModelId, generationId, inputContent: joined classifier messages, outputContent: raw classifier text }`) **regardless of whether the output was usable** — "the call cost something whether or not the output was usable."
7. `resolveClassifierOutput(outputText, eligibleInferenceIds)` parses the classifier's raw text into one of the eligible ids, or `null` if unparseable/invalid → in that case `fallbackOccurred = true` and the fallback id (`classifierModelId`) is used instead.
8. `resolveOk` emits `writer.writeStageDone({ assistantMessageId, payload: { stageId: 'smart-model', resolvedModelId, resolvedModelName, ...(fallbackOccurred && { fallbackOccurred: true }) } })` — `fallbackOccurred` is only included in the payload when `true` (never explicit `false`).
9. Returns `{ ok: true, transformation: { resolvedModelId }, billing }`. The Smart Model stage never returns `ok: false` — every failure mode degrades to the fallback model rather than aborting the slot ("we still pay for the failed classifier attempt when one was made; we degrade gracefully rather than aborting the slot").
10. `resolvedModelName` looks up `config.modelMetadataById.get(resolvedId)?.name`, falling back to the raw `resolvedId` string if metadata is missing.

---

### 5. SSE stream handler & error classification (`lib/stream-handler.ts`, `lib/classify-stream-error.ts`)

#### 5.1 SSE event writer (`createSSEEventWriter`)

Wraps a raw SSE stream in a typed writer (`SSEEventWriter`) with connection tracking:
- `writeIfConnected(event, data)`: no-ops if already disconnected; on write failure (thrown from the underlying `stream.writeSSE`), sets `connected = false` and swallows the error — no propagation.
- Every event name is a literal string sent as the SSE `event:` field: `start`, `token` (note: NOT `model:token` at the wire level — the writer method is named `writeModelToken` but emits event name `'token'`), `model:media:start`, `model:media:progress`, `error`, `model:done`, `model:error`, `done`, `stage:start`, `stage:done`, `stage:error`.
- `writeDone`: sets an internal `doneWritten` flag to `true` whenever the writer was still connected at the moment `writeDone` was **attempted** — regardless of whether the underlying wire write itself subsequently throws (which flips `connected` separately). This flag is the semantic "we got far enough to call writeDone, so we're past the success boundary" marker, independent of actual delivery success.
- `isDoneWritten()` stays `false` if `writeDone` no-oped because the writer was already disconnected before being called.
- `writeDone(data?)` defaults to writing `{}` as the payload when no data is supplied.

#### 5.2 Structural exception handling (`handleStreamException`)

The top-level catch used by every `streamSSE` pipeline callback. Behavior branches on `writer.isDoneWritten()`:
- **Pre-`done`** (turn never reached success): calls `writeStreamErrorFromException`, which logs full error diagnostics server-side via `extractErrorDiagnostics` (walks the cause chain, omits user-data fields like prompts/headers/secrets) as a single JSON line, then writes an SSE `error` event with `code: ERROR_CODE_STREAM_ERROR` (= `'STREAM_ERROR'`) and `message` = the error's `.message` or the literal fallback string `'Stream processing failed'` if the thrown value isn't an `Error`.
- **Post-`done`** (turn already reported success — cost, envelopes, sequences all sent to the client): logs `console.error('sse stream: uncaught exception after done event was already written', err)` and returns **without** writing another SSE event — "writing another `event: error` would flip the client's perception from 'message saved' to 'chat stream failed' even though the assistant message persisted and billing settled." This branch specifically catches synchronous throws from fire-and-forget side effects (push notifications, analytics) that run after persistence.

#### 5.3 `classifyStreamErrorCode` — error → code mapping and precedence

Checked in this exact order (first match wins; confirmed by dedicated precedence tests — e.g. "context length wins over rate limit message even when both apply," "fork tip wins over content policy"):

1. Non-`Error` thrown value → `ERROR_CODE_STREAM_ERROR` (`'STREAM_ERROR'`).
2. `error.message.includes('context length')` → `ERROR_CODE_CONTEXT_LENGTH_EXCEEDED` (`'CONTEXT_LENGTH_EXCEEDED'`).
3. `error.name === 'ForkTipConflictError'` → `ERROR_CODE_FORK_TIP_CONFLICT` (`'FORK_TIP_CONFLICT'`).
4. `isUniqueViolation(error)` (message text match OR `cause.code === '23505'`, the Postgres unique-violation SQLSTATE) → `ERROR_CODE_DUPLICATE_MESSAGE` (`'DUPLICATE_MESSAGE'`).
5. Rate limit: HTTP `status === 429`, OR message includes `'rate limit'`, OR message includes `'429'` → `ERROR_CODE_RATE_LIMITED` (`'RATE_LIMITED'`). Status is extracted from `error.status`, `error.statusCode`, or `error.response.status`, first numeric hit wins.
6. Content policy: message includes any of `'content policy'`, `'safety'`, `'moderation'`, `'harmful'` (all lowercased before matching) → `ERROR_CODE_CONTENT_POLICY` (`'CONTENT_POLICY'`).
7. Provider billing: HTTP status `401`, `402`, or `403`, OR message includes `'insufficient credits'` → `ERROR_CODE_PROVIDER_BILLING` (`'PROVIDER_BILLING'`).
8. Network error: `error.name === 'AbortError'`, OR `error instanceof TypeError` with message including `'fetch failed'`, OR (fallback for shims that rethrow as plain `Error`) message includes `'fetch failed'` → `ERROR_CODE_NETWORK_ERROR` (`'NETWORK_ERROR'`).
9. AI SDK error: `error.name` starts with `'AI_'` (e.g. `AI_APICallError`, `AI_RetryError`) OR equals `'AISDKError'` → `ERROR_CODE_INFERENCE_FAILED` (`'INFERENCE_FAILED'`).
10. Fallback (plain, non-SDK `Error` matching none of the above) → `ERROR_CODE_STREAM_ERROR` (`'STREAM_ERROR'`).

---

### 6. Text streaming pipeline orchestration (`lib/stream-pipeline.ts`)

The shared streaming pipeline used by both authenticated chat and link-guest endpoints — owns billing resolution/reservation, SSE multi-model fan-out, pricing/broadcasting/cost-computation utilities.

#### 6.1 Constants

- **`BATCH_INTERVAL_MS = 100`** (exported) — the broadcast token-batching interval used by `withBroadcast` (mirrors the same constant duplicated in `multi-stream.ts`'s `DEFAULT_BATCH_INTERVAL_MS`).
- Default model `context_length` fallback when a model isn't found in the gateway catalog: **`128_000`** tokens (`lookupModelPricing`).

#### 6.2 `lookupModelPricing`

Looks up a model's fee-inclusive per-token prices from the raw gateway catalog: `inputPricePerToken = applyFees(parseTokenPrice(modelInfo.pricing.prompt))`, same for output/`completion`. Returns `0`/`0`/`128_000` (context length) defaults when the model id isn't found in the catalog at all (rather than throwing).

#### 6.3 `computeWorstCaseCents`

Worst-case cost reservation in cents = `(estimatedInputCost + maxOutputTokens × outputCostPerToken) × 100`. Comment: no `Math.ceil` needed because `floor()` inside `calculateBudget` already guarantees `worstCaseCents ≤ availableCents`; Redis `INCRBYFLOAT` handles floats natively so no integer-cents rounding is forced here.

#### 6.4 Web-search worst-case reservation (`resolveWebSearchCost`)

- Returns `0` when `webSearchEnabled` is `false`.
- When enabled, returns `worstCaseSearchCost()` = `applyFees(MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL)`.
- **`MAX_SEARCH_TOOL_CALLS = 10`**, **`SEARCH_COST_PER_CALL = $0.005`**, fee rate `0.15` (15%) → locked worst-case dollar amount **≈ `$0.0575`** per request (`10 × 0.005 = 0.05`; `0.05 × 1.15 = 0.0575`), pinned exactly by a dedicated test.
- This reservation is **per-request**, not per-model: `buildCostManifest` multiplies by `modelCount` internally elsewhere in the pipeline, so `resolveWebSearchCost` must return the bare (unmultiplied) value — doubling the multiplication here would inflate the reservation to N² × base for N selected models. A regression test in `chat.test.ts` ("reserves web-search cost N × base, not N² × base") drives 2 selected models with `webSearchEnabled: true` vs `false` and asserts the delta equals exactly `2 × worstCaseSearchCost()` in cents, and explicitly asserts it is NOT `4 ×` (the squared bug).

#### 6.5 Broadcast token batching (`withBroadcast`)

Wraps an `InferenceStream` to fire batched token-content broadcasts to other conversation members over WebSocket, passing all events through unchanged otherwise:
- Only `text-delta` events accumulate into a `tokenBuffer`; other event kinds pass through silently without touching the buffer.
- Flush condition: `Date.now() - lastBroadcastTime >= BATCH_INTERVAL_MS` (100ms) — same cadence rule as `multi-stream.ts`'s per-slot batching.
- The buffer is always flushed one final time when the underlying stream reports `done` (even if the 100ms window hasn't elapsed), so trailing content is never lost.
- `modelName` and `senderId` are optionally included in the broadcast payload only when defined (undefined omits the field entirely rather than serializing `null`).

#### 6.6 `handleBillingResult`

- Registers `billingPromise.catch(() => null)` with `c.executionCtx.waitUntil(...)` so a Cloudflare Worker keeps running the settlement even if the response has already been sent to the client; wrapped in a `try/catch` because `executionCtx` is unavailable outside the Workers runtime (e.g. local dev/test).
- Awaits and returns the billing result; on rejection, logs a single structured JSON line (`event: 'billing_failed'`, `messageId`, `userId`, `senderId`, `model`, `generationId`, `error`, `timestamp: new Date().toISOString()`) and returns `null` rather than throwing — callers treat `null` as "write a BILLING_ERROR SSE event."

#### 6.7 `broadcastAndFinish` / `finalizeTurn`

- Broadcasts a `message:complete` realtime event (`messageId`, `conversationId`, `sequenceNumber: aiSequence`, `epochNumber`, optional `modelName`) fire-and-forget, THEN writes the SSE `done` event with `userMessageId`, `assistantMessageId`, optional `userSequence`, `aiSequence`, `epochNumber`, `cost`, optional serialized `userEnvelope`, and `models: [...]` (one `DoneModelEntry` per assistant result, each with `wrappedContentKey` base64-encoded and its `contentItems` serialized — text items carry `encryptedBlob` base64, media items carry storage metadata plus a `downloadUrl` where applicable).
- `finalizeTurn` (shared by text and media pipelines) additionally: broadcasts one more `message:complete` per **non-primary** successful model in a multi-model batch (skipping the primary, which already broadcast via `broadcastAndFinish`); computes the set of currently-active conversation user ids and dispatches a push notification (title `'New Message'`, body `'You new message'` — this literal string, unmodified, is what's sent) fire-and-forget to those users.
- The broadcast model name is deliberately the **resolved** model id (e.g. the concrete model Smart Model routed to), never the user-facing slot id `'smart-model'` — "group members [should see] which model produced the response, not the user-facing slot id."

#### 6.8 Smart Model resolution for billing (`buildSmartModelResolution`)

Pure function computing "what would this payer route Smart Model to?" — shared verbatim by both the authenticated billing path and the trial-chat path so neither diverges:
- Filters the model pool to `modality === 'text' && !isSmartModel`, then calls `buildEligibleModels` (from `@hushbox/shared`) with the payer's tier, balance, free allowance, and prompt character count.
- Returns `null` when the payer can't afford even the cheapest eligible model plus classifier overhead — the caller returns a 402 `ERROR_CODE_INSUFFICIENT_BALANCE` response (`currentBalance` formatted as `(cents/100).toFixed(2)`).
- On success, returns `{ classifierModelId, eligibleInferenceIds, classifierWorstCaseCents, modelMetadataById }` — `modelMetadataById` is built by looking up each eligible id in the raw gateway catalog for `{ name, description }`.
- **Pricing override** (`applySmartModelPricingOverride` / `computeMaxEligibleFees`): for budget purposes, the Smart Model slot reserves against the **most expensive** eligible model's input/output fee rates (`maxInputFee`, `maxOutputFee` computed by scanning all eligible pool models) — "reserves worst-case eligible model budget to absorb whichever model the classifier picks." The context length used for the reservation math is the Smart Model catalog entry's own declared context length, not any eligible model's.
- Trial-chat mirrors this exact override logic in its own `smartModelPricing` helper.

#### 6.9 Budget & worst-case computation (`computeBudgetAndWorstCase`)

Wraps `calculateBudget` (external, from `@hushbox/shared`) plus max-tokens capping plus the final worst-case reservation. The **stage reservation** (Smart Model classifier cost today) is pre-deducted inside `calculateBudget` via `preReservedCents` so the main inference's token sizing already accounts for it, then added back to the **final** reservation total so the sum reflects the full call (classifier + main inference).

#### 6.10 `resolveAndReserveBilling` (text)

1. Fetches raw gateway models, prices every selected model.
2. Computes `webSearchCostDollars` via `resolveWebSearchCost` — **not** multiplied again for model count (see §6.4).
3. Builds a `costManifest` and derives `estimatedMinimumCostCents` from it, used to decide the funding source (`decideFundingSource`).
4. Computes the effective payer balance (capped by conversation/member group budgets for group billing).
5. Resolves Smart Model eligibility/pricing if applicable.
6. Reserves budget in Redis and returns `BillingValidationSuccess` (`worstCaseCents`, optional `groupBudget`, `billingUserId`, optional `smartModelResolution`) or a `BillingValidationFailure` carrying the pre-built error `Response`.
7. **402-balance-cushion behavior** (asserted at the `chat.ts` route level, backed by `billing-reservation.ts`, owned by the billing group but directly observable through this pipeline): a request is still allowed through when the post-reservation effective balance is negative but **within a 50-cent cushion** — e.g. balance $10.00 (1000 cents), reservation totals 1040 cents → `finalEffective = 1000 - 1040 = -40` cents, which is `> -50` cents, so the request succeeds (200). A reservation that would push the effective balance **below** `-50` cents (e.g. total reservation of 99999 against a 1000-cent balance) is denied 402 with `ERROR_CODE_BALANCE_RESERVED`.

#### 6.11 `resolveAndReserveImageBilling` / `resolveAndReserveVideoBilling` / `resolveAndReserveAudioBilling`

- All three funnel through the same `resolveAndReserveMediaBilling` pre-reservation gate (thin wrapper over `reserveMediaBilling` in `billing-reservation.ts`) before adding modality-specific fields.
- **Image**: worst-case cents computed from the exact per-model `perImageByModel` prices (no separate exact-cents helper needed beyond the map itself).
- **Video**: `exactCents = computeVideoExactCents([...perSecondByModel.values()], durationSeconds)` — worst-case scales **linearly** with `durationSeconds` (a test drives durations 2s vs 8s for the same per-second price and asserts the 8s reservation is exactly `4×` the 2s reservation, i.e. proportional to duration, `toBeCloseTo(short × 4, 5)`).
- **Audio**: `worstCaseCents = computeAudioWorstCaseCents([...perSecondByModel.values()], maxDurationSeconds)` — reserved against the **worst-case ceiling** `maxDurationSeconds` (comment: "audio duration isn't known ahead of text — we can't compute exact pre-flight cost, [so we] reserve against `maxDurationSeconds` [and] rebill actual generated duration"); post-flight billing then charges the model's actual `perSecond × actualDurationMs/1000` once generation completes (§1.6). A test likewise confirms this scales linearly with `maxDurationSeconds`.

#### 6.12 Post-inference exact-cost computation for text slots (`buildSlotPersistInput`)

- If a stream produced content but **no `generationId`** (e.g. a partial/failed stream that still emitted some text) → cost falls back to **`0`**, `isEstimated: false`.
- If the slot ran pre-inference stages with billing breadcrumbs (`meta.preInferenceBillings.length > 0`) → uses `buildStagedPersistInput` (total = main + Σ stage costs, fees + storage included), then calls `recordBillingMismatchIfExceeded({ estimateUsd: slotEstimateUsd, actualUsd: persisted.cost, evidence })` — non-blocking, never throws, records an ops evidence row only when `|actual − estimate| / estimate` exceeds a configurable threshold (default **`BILLING_MISMATCH_THRESHOLD_RATIO = 0.5`**, i.e. 50% relative deviation — owned by the billing service layer, `services/billing/cost-calculator.ts`, but wired into every slot's post-inference persistence here). Special case: `estimateUsd === 0` with non-zero actual is treated as an unbounded/always-exceeds deviation (nothing to divide by); both zero is a no-op.
- Otherwise (no stages) → calls `calculateMessageCost` (exact gateway-lookup cost by `generationId`) and runs the same mismatch check.
- `inputTokens`/`outputTokens` for persistence are always derived via `estimateTokenCount` (character-based estimate) applied to the actual input content and full generated content — **not** the gateway's own reported token counts.

#### 6.13 `runStreamingTurn` orchestration sequence

1. `writeStart` with the full model→assistantMessageId map.
2. `runPreInferenceForSlots` — runs each model's pre-inference chain **independently** (per-slot, not globally sequential across slots — the per-slot chain itself is sequential per §4.2, but different slots' chains are not shown to be awaited together here beyond the per-slot map building). A slot whose chain fails (`chainResult.ok === false`) writes `model:error` with the chain's `errorCode` and message `'Pre-inference stage failed'`, and that slot is **excluded** from the stream-entries list — its sibling slots are unaffected.
3. If **every** slot failed pre-inference (`streamEntries.length === 0`) → writes a top-level `error` with message `'All slots failed pre-inference'` and code `ERROR_CODE_CLASSIFIER_FAILED`.
4. Otherwise, builds per-slot `TextRequest`s from the resolved model id (post pre-inference), wraps each stream in `withBroadcast`, and collects via `collectMultiModelStreams`.
5. If **no** model produced non-empty content with no error → `writeFirstStreamError` (fallback message `'No content generated'`, classified via `classifyStreamErrorCode`).
6. Otherwise persists via `saveChatTurn`; on billing failure writes `error` with message `'Failed save message'` (sic — the literal string in code, not "Failed to save message" as used elsewhere in the media pipeline) and code `ERROR_CODE_BILLING_ERROR`.
7. On success, calls `finalizeTurn` (§6.7), passing a `resolveBroadcastModelName` closure that maps each user-facing slot id to its **resolved** model id from `slotMetadataByModelId`.

#### 6.14 `derivedIsSmartModel`

`stagesRun.includes('smart-model')` — purely a membership check on the executor's `stagesRun` list (§4.2), independent of whether a billing breadcrumb was produced. This is what drives the "Smart" chip on a persisted message even when the classifier call itself failed and fell back with no bill.

#### 6.15 Top-level `executeStreamPipeline` broadcast-before-stream ordering

For `fresh-send` tree actions specifically, a `message:new` broadcast (containing the **prompt content**) fires fire-and-forget **before** `streamSSE` even begins iterating — this is distinct from the media pipeline's `message:new`, which fires only after persistence (§1.8). The doc comment notes this ordering exists so other viewers see the optimistic user message promptly; edits/regenerates don't re-broadcast `message:new` since the message tree already reflects the edit via `message:complete` on completion.

---

### 7. Chat routes (`routes/chat.ts`)

Three endpoints on the `chatRoute` Hono sub-app, all mounted under a conversation-scoped path:

#### 7.1 `POST /:conversationId/stream`

- Validates `conversationId` param (`z.object({ conversationId: z.string().min(1) })`) and body against `streamChatRequestSchema`.
- Requires `requirePrivilege('write', { allowLinkGuest: true, includeOwnerId: true })` and is rate-limited via `rateLimitByCaller('chatStreamUserRateLimit')` (the limiter's config itself lives in middleware, out of this scope's files, but its **name** — `chatStreamUserRateLimit` — is the identifier applied here).
- **Gate order** (`validateStreamRequestGates`, run before any billing resolution):
  1. `validateLastMessageIsFromUser(messagesForInference)` false → `400 LAST_MESSAGE_NOT_USER`.
  2. Media modality (`image`/`video`/`audio`) requested by a link-guest → `403 MEDIA_TRIAL_BLOCKED` (link guests can never request media generation).
  3. `modality === 'audio' && !FEATURE_FLAGS.AUDIO_ENABLED` → `503 AUDIO_DISABLED` (comment: "right code: request well-formed; feature temporarily off — will return when gateway adds speech support").
  4. `enforceTierLock` — only applies when billing is **direct** (`!linkGuest && callerId === ownerId`; group-member billing skips this because the owner's tier governs access via the existing group-billing path): if the caller's tier can't access premium and any selected model is in the premium set → `403 MODEL_TIER_LOCKED` with `{ modelId: lockedModel }` (the *first* matching locked model found by iterating `models`).
- After gates pass, resolves a `BillingContext` (owner-direct vs group-member vs link-guest — via `resolveUserBillingContext` / `resolveGuestBillingContext`), then dispatches to one of four per-modality branch handlers via `dispatchModalityRequest`.
- **Media branch shared skeleton** (`runMediaBranch`, used by image/video/audio): (1) run the modality-specific model lookup — reject on `notFound` (`400 MODEL_NOT_FOUND` with `{ models: notFound }`), `mismatches` (`400 MODALITY_MISMATCH` with `{ invalidModels: mismatches }`), or (for video only) `unsupportedResolutions` (`400 UNSUPPORTED_RESOLUTION` with `{ invalidModels, resolution }`); (2) reserve modality billing — reject on failure; (3) resolve the release-on-failure callback and dispatch to the pipeline.
- **Video-specific extra gate**: per-model discrete-duration check via `getSupportedVideoDurations(modelId)` — a model whose declared supported durations set doesn't include the requested `durationSeconds` → `400 UNSUPPORTED_DURATION` with `{ invalidModels, durationSeconds }`. Models with **no** declared duration data (`undefined`) are allowed through — comment: "newer catalog entries [that haven't] pinned [duration data] yet; gateway [is] then authoritative" — Veo entries always have this data today so the escape hatch doesn't fire in practice.
- **Release-on-failure resolution** (`resolveReleaseReservation`): if a `groupBudget` reservation exists → releases via `releaseGroupBudget`; else if a `user` context exists → releases the personal budget via `releaseBudget(redis, user.id, worstCaseCents)`; else → a no-op release function.

#### 7.2 `POST /:conversationId/message`

- User-only message save — **no AI call, no billing**. Used "in group chats when the AI toggle is off."
- Resolves `parentMessageId` via `resolveParentMessageId`, then `saveUserOnlyMessage` inside its own transaction.
- Concurrency/idempotency handling on save failure: `ForkTipConflictError` → `409 FORK_TIP_CONFLICT`; `isUniqueViolation(error)` (retry hitting the same `messageId`, or a concurrent writer racing the same (conversation, sequence) pair) → `409 DUPLICATE_MESSAGE`; any other error rethrows.
- On success: broadcasts `message:new` (no `content` field — comment/test: "broadcasts message:new without content field in user-only route," distinguishing it from the AI-turn `message:new` which does carry content), fire-and-forget dispatches a push notification (`title: 'New Message'`, `body: 'You new message'`), and returns `200 { messageId, sequenceNumber, epochNumber }` as plain JSON (not SSE).

#### 7.3 `POST /:conversationId/regenerate`

- Validates body against `regenerateRequestSchema`; `action` must be one of the schema's allowed values (invalid action → `400`).
- Gates (`validateRegenerateGates`) mirror the stream-route's gates **except the premium tier lock is skipped** — comment: "user already chose model when the original message was sent, so re-blocking on tier would [be] surprising." Text modality still requires `validateLastMessageIsFromUser` → `400 LAST_MESSAGE_NOT_USER` if violated.
- `runRegenerateGates` additionally resolves the fork-tip message id (`resolveForkTipMessageId`) when a `forkId` is supplied, by reading `conversationForks.tipMessageId`; returns `null` (distinct from `undefined`) if the fork row doesn't exist at all.
- Builds a `TreeAction` of kind `'edit'` or `'regenerate'` (`buildRegenerateTreeAction`) from the wire `action` value — both wire actions `'retry'` and `'regenerate'` map to the **same** `TreeAction.kind === 'regenerate'` (documented as "functionally identical on the server").
- Successful requests stream an SSE response (`content-type: text/event-stream`) exactly like `/stream`.
- A persistence failure after the model already streamed successfully surfaces as an SSE `error` event mid-stream rather than an HTTP-level failure (the response has already committed to `200`/SSE by that point).

#### 7.4 Response/status-code summary observed across the route's test suite

`401` unauthenticated (`NOT_AUTHENTICATED`) · `400` missing/invalid body fields, `LAST_MESSAGE_NOT_USER`, `MODEL_NOT_FOUND`, `MODALITY_MISMATCH`, `UNSUPPORTED_DURATION`, `UNSUPPORTED_RESOLUTION` · `402` `INSUFFICIENT_BALANCE` / `ERROR_CODE_BALANCE_RESERVED` (billing denial) · `403` `MODEL_TIER_LOCKED`, `MEDIA_TRIAL_BLOCKED`, member with read-only privilege · `404` conversation not found / belongs to another user · `409` `FORK_TIP_CONFLICT`, `DUPLICATE_MESSAGE`, `BILLING_MISMATCH` (client-declared `fundingSource` disagrees with the server's resolved decision — response includes `details.serverFundingSource`) · `503` `AUDIO_DISABLED`.

---

### 8. Trial chat route (`routes/trial-chat.ts`)

`POST /stream` — the unauthenticated trial flow, one route, no auth required.

- Rate-limited via `rateLimitByIp('trialChatStreamIpRateLimit')` (limiter config lives in middleware, out of scope; name recorded here).
- **Defense-in-depth gate**: if the request body sets `webSearchEnabled: true`, the route rejects with `403 FEATURE_REQUIRES_AUTH` **before** any other validation — comment: "trial users have no reserved budget for the search tool cap, so [we] reject hand-crafted requests [that try to] enable it [even though] the frontend already gates trial users [from ever sending this]."
- `validateTrialRequest`: checks the trial usage quota first (`consumeTrialMessage`, owned by the billing slice — observed via `trial-usage.ts`/`.test.ts`: `TRIAL_MESSAGE_LIMIT` appears to be **5 messages** based on test fixtures where a 5th message is allowed [`canSend: true`, `messageCount: 5`] and a 6th is denied [`canSend: false`, `messageCount: 6`], tracked per hashed-IP and reset at UTC midnight via `secondsUntilNextUtcMidnight`); then checks premium model access (`checkTrialModelAccess` → `403 PREMIUM_REQUIRES_ACCOUNT` if the selected model is in the premium set); then, for Smart Model selections, delegates to `validateTrialSmartModel` (same `buildSmartModelResolution` used by the authenticated path, §6.8) — otherwise computes a per-model budget via `calculateTrialBudget`.
- `calculateTrialBudget`: prompt character count = `buildSystemPrompt([]).length` (empty-instruction system prompt — trial users get no custom instructions) plus the sum of all message content lengths. Calls `calculateBudget({ tier: 'trial', balanceCents: 0, freeAllowanceCents: 0, ... })` and `resolveBilling({ tier: 'trial', balanceCents: 0, freeAllowanceCents: 0, isPremiumModel: false, estimatedMinimumCostCents })` — `isPremiumModel` is hardcoded `false` here because premium is already gated separately by `checkTrialModelAccess`. If `resolveBilling` returns `fundingSource: 'denied'` → `402 TRIAL_MESSAGE_TOO_EXPENSIVE`.
- `estimatedMinimumCostCents` is computed with `Math.ceil` (unlike the authenticated pipeline's analogous calc, which does not ceil — see §6.3's comment about `floor()` already bounding it; the trial path ceils explicitly instead).
- **Smart Model resolution for trial**: `validateTrialSmartModel` calls `buildSmartModelResolution` exactly as the authenticated path does, then prices the reservation via `smartModelPricing` — the max-fee-across-eligible-models override (§6.8) mirrored verbatim.
- **Model resolution inside the stream** (`resolveTrialModel`): if the selection wasn't Smart Model, returns the model id unchanged. If it was, runs the **exact same** `resolveStagesForSlot` + `executePreInferenceChain` pair the authenticated path runs, emitting the same `stage:start`/`stage:done` SSE events on the trial stream's own writer.
- Streaming: writes `start` with a single `{ modelId: model, assistantMessageId }` entry (trial supports only one model per request — no multi-model fan-out), builds the prompt via `buildPrompt({ modelId: resolvedModelId, supportedCapabilities: [] })`, builds AI messages, and streams a single-model inference.
- Errors during the trial stream fall back to `ERROR_CODE_STREAM_ERROR` (imported but the specific catch-branch logic wasn't further distinguished beyond the standard classification already covered in §5.3, which trial-chat also imports indirectly through the shared pipeline helpers).
- Notably, **trial chat performs no persistence** — there is no `saveChatTurn` call anywhere in this route; the turn is billed against the trial quota counter only, never written to the message tree.

---

### 9. Chat service layer (`services/chat/*`)

#### 9.1 Validation (`validation.ts`)

- `validateLastMessageIsFromUser(messages)`: returns `false` for an empty array; otherwise `messages.at(-1)?.role === 'user'`.
- `buildAIMessages(systemPrompt, messages)`: prepends `{ role: 'system', content: systemPrompt }` to the mapped `{ role, content }` list — always exactly one system message at index 0, regardless of whether the input already contained one.

#### 9.2 Max tokens (`max-tokens.ts` — re-exports `computeSafeMaxTokens` from `@hushbox/shared`)

Behavior pinned by this scope's tests: given `{ budgetMaxTokens, modelContextLength, estimatedInputTokens }`:
- If `budgetMaxTokens >= (modelContextLength - estimatedInputTokens)` (the budget meets or exceeds the remaining context room) → returns **`undefined`** (omit the `max_tokens` param entirely rather than sending a value that could exceed what the model can accept).
- Otherwise → returns `budgetMaxTokens` **verbatim**, with no headroom/safety-margin reduction applied (`10_000` in → `10_000` out; `10_001` in → `10_001` out; `100` in → `100` out; `0` in → `0` out).
- Negative remaining context (estimated input tokens alone exceed the model's context length, e.g. `estimatedInputTokens: 200_000` against `modelContextLength: 128_000`) still correctly falls into the "budget exceeds remaining" branch and returns `undefined`, since any positive/zero budget is `>` a negative remaining-context value.

#### 9.3 Regeneration guard (`regeneration-guard.ts` — `canRegenerate`)

Determines whether a user is allowed to regenerate/retry from a given target message:
- **Solo chats** (zero active — `leftAt IS NULL` — conversation members returned by the membership query): always returns `true` unconditionally, no chain walk performed.
- **Group chats**: resolves the effective "tip" message — the caller-supplied `forkTipMessageId` if given, else the message with the highest `sequenceNumber` in the conversation (`resolveTipMessageId`). If no tip is resolvable, or the tip **is** the target, returns `true` trivially.
- Otherwise walks the parent-chain from tip back to (but excluding) the target message (`checkChainForOtherUsers`), and returns `false` the moment it encounters a message where `senderType === 'user' && senderId !== null && senderId !== requestingUserId` — i.e. **any** other user's message sent between the target and the current tip blocks regeneration. Assistant messages in the chain never block. The walk includes cycle protection (a `visited` set; breaks if a node repeats) and stops early if a referenced parent id isn't found in the loaded message map.

#### 9.4 Tree actions (`tree-action.ts`)

`TreeAction` is a discriminated union with exactly three `kind` values, both server actions sharing one persistence path:
- **`fresh-send`**: `{ userMessage: {id, content}, parentMessageId }` — a brand-new user message plus its assistant reply/replies.
- **`regenerate`**: `{ anchorUserMessageId, replaceAssistantId?, forkId?, forkTipMessageId? }` — covers **both** wire actions `retry` and `regenerate` (documented as "functionally identical on the server"). `replaceAssistantId` unset → retry-all: every assistant descendant of the anchor is deleted and new assistants are created under the anchor. `replaceAssistantId` set → regenerate-one: only that single assistant message is deleted, surviving siblings are untouched, and the new assistant(s) inherit the same anchor parent. Both the multi-model "retry on failed tile" flow and the per-tile "Regenerate" button flow through the `replaceAssistantId`-set branch.
- **`edit`**: `{ anchorUserMessageId, newUserMessage: {id, content}, forkId?, forkTipMessageId? }` — replaces the user message content and cascades deletion of everything downstream.

Key behaviors:
- `treeActionUserMessageId(action)`: the id the turn is keyed off — `fresh-send` → `userMessage.id`; `regenerate` → `anchorUserMessageId`; `edit` → `newUserMessage.id`.
- `treeActionShouldAdvanceForkTip(action)`: `true` for `fresh-send`/`edit`/retry-all (whole lineage moves forward). For `regenerate` with `replaceAssistantId` set, `true` **only if** the replaced assistant **was** the current fork tip; otherwise `false` — "unconditional advancement here used to silently clobber the tip onto the just-inserted replacement, breaking fork lineage" (an explicitly documented prior bug this logic fixes).
- `lockAndValidateForkTip`: locks the fork row with `SELECT ... FOR UPDATE` and compares the row's current `tipMessageId` against the caller's expectation; a mismatch throws `ForkTipConflictError` — this is how two concurrent regenerate requests against the same fork serialize: the second sees the first's already-committed tip and gets the conflict. **Threads through `null`** as the expected tip (not the raw `forkTipMessageId` caller value) for the downstream optimistic `updateForkTip` call, because by that point the `ON DELETE SET NULL` FK cascade from the deletion has already nulled the tip within the same transaction.
- `applyFreshSend`: validates `parentMessageId` (via `validateParentMessageId`), returns the assistant parent = the new user message id, `forkTipExpectedMessageId = parentMessageId`.
- `applyRegenerate` (`replaceAssistantId` set): deletes exactly that one message row (scoped by id + conversationId), no cascade walk.
- `applyRegenerate` (retry-all, no `replaceAssistantId`): calls `deleteMessagesAfterAnchor` for everything after the anchor (see §9.5), scoped to the fork chain if `forkTipMessageId` given.
- `applyEdit`: loads the target's `parentMessageId` first; the deletion anchor is the target's **parent** (or, if the target has no parent — i.e. it's the conversation's first message — the target itself is used as the anchor and then explicitly deleted afterward, since `deleteMessagesAfterAnchor` only deletes messages strictly **after** the anchor).

#### 9.5 Message deletion (`message-deletion.ts` — `deleteMessagesAfterAnchor`)

Two paths, chosen by whether `forkTipMessageId` is supplied:
- **Linear path** (no fork): looks up the anchor's `sequenceNumber`, then deletes every message in the conversation with `sequenceNumber > anchor.sequenceNumber` in one `DELETE ... WHERE` (`gt`), returning the deleted ids. If the anchor doesn't exist, returns `{ deletedIds: [] }` (no-op, not an error) — this is also what makes the function **idempotent**: re-running after a prior deletion (anchor already deleted or already the tip) returns an empty result.
- **Fork path**: loads every message in the conversation, walks the parent chain from `forkTipMessageId` back to (excluding) the anchor to build a candidate set (`collectCandidates`, with cycle protection identical in shape to the regeneration-guard walk), then filters to only candidates with **no children outside the candidate set** (`findExclusiveCandidates`) — a candidate message that has a child belonging to a *different*, still-live fork/branch is preserved rather than deleted, since deleting it would orphan content that another lineage still depends on. Only the exclusive subset is actually deleted (`inArray` bulk delete). If `forkTipMessageId === anchorMessageId`, or the candidate set is empty, or the exclusive set is empty, returns `{ deletedIds: [] }`.

#### 9.6 Message helpers (`message-helpers.ts`)

- `validateParentMessageId`: `null` parent is only valid when the conversation has **zero** existing messages (checked via a `LIMIT 1` existence query) — otherwise throws `InvalidParentMessageError(ERROR_CODE_INVALID_PARENT_MESSAGE, ...)`. A non-null parent must reference an existing message row scoped to the same `conversationId`, or the same error is thrown with a different message.
- `assignSequenceNumbers(tx, conversationId, count)`: atomically increments `conversations.nextSequence` by `count` in a single `UPDATE ... RETURNING`, computing `baseSeq = nextSequence - count` so the caller gets a contiguous block `[baseSeq, baseSeq+1, ..., baseSeq+count-1]` — `count` is `1` for a user-only message, `2`+ for a full chat turn (1 user + N assistants). Throws `Error('Conversation not found')` if the conversation row doesn't exist.
- `fetchEpochPublicKey`: throws `Error('Epoch not found')` if no matching `(conversationId, epochNumber)` row exists — never silently defaults.
- `insertEnvelopeTextMessage`: generates a fresh content key via `beginMessageEnvelope(epochPublicKey)`, encrypts the plaintext under it, inserts one `messages` row and one `content_items` row (`contentType: 'text'`, `position: 0`), then **discards the content key from memory** (never stored/returned beyond the encryption call) — only `wrappedContentKey` and the encrypted blob leave the function.
- `insertEnvelopeMediaMessage`: accepts **either** a pre-created `wrappedContentKey` (media pipeline already encrypted bytes externally before calling persistence) **or** an `epochPublicKey` to derive a fresh envelope — exactly one of the two must be supplied, or the function throws `Error('Either wrappedContentKey or epochPublicKey must be provided')`.
- `resolveParentMessageId`: with a `forkId`, returns that fork's `tipMessageId` (or `null` if the fork has none); without one, returns the conversation's latest message by `sequenceNumber` descending, or `null` for an empty conversation (first message).
- `updateForkTip`: **conditional UPDATE** — `WHERE conversationForks.id = forkId AND tipMessageId {= expected | IS NULL}`. If the fork row doesn't exist at all, this is a silent no-op (preserves prior behavior — "no fork = nothing to update"). If the fork exists but the conditional `WHERE` affects zero rows (a concurrent writer already advanced the tip), throws `ForkTipConflictError`.
- `ForkTipConflictError` message format: `` fork tip conflict: fork {forkId} expected tip {expectedTipMessageId ?? 'null'} but actual tip differs ``.

#### 9.7 `saveChatTurn` / `saveUserOnlyMessage` (`message-persistence.ts`)

- **`saveUserOnlyMessage`**: single transaction — validate parent, assign 1 sequence number, fetch epoch key, insert the text envelope with `senderType: 'user'`, and (if `forkId` supplied) advance the fork tip using the resolved `parentMessageId` as the expected-prior-tip guard. No wallet charge, no usage records, no LLM completions — "free."
- **`saveChatTurn`** — the full atomic turn-persistence path, one DB transaction, any step failing rolls everything back:
  1. Resolves the effective `TreeAction` (either passed directly, or synthesized from legacy flat fields as a `fresh-send`).
  2. Normalizes `assistantMessages` (either passed directly for multi-model, or synthesized as a single-entry array from legacy flat fields).
  3. `logNegativeCosts`: for every assistant message with `cost < 0`, logs a structured JSON line (`event: 'negative_cost_detected'`, `totalCost`, `costAmount`, `conversationId`, `model`, `userId`) — logged only, never blocks persistence.
  4. Mints **one `batchId`** (`crypto.randomUUID()`) shared by every message persisted in this call (new user message if any, plus every assistant) — used downstream by an unspecified "fork-filter" (outside this scope) to distinguish a genuine multi-model fan-out batch from a retry-with-fork-preserved orphan sharing the same parent but a different batch.
  5. `applyTreeAction` runs first inside the transaction (handles deletion/validation per action kind).
  6. `assignSequenceNumbers` for the total count (user message insert, if any, counts as 1, plus one per assistant message).
  7. Inserts the user message envelope first (if the tree action produced one), consuming sequence index 0.
  8. `persistAllAssistants` — loops each assistant message in order, dispatching to `persistTextAssistant` or `persistMediaAssistant` based on `modality`.
  9. If `forkId` is set **and** `treeActionShouldAdvanceForkTip(treeAction)` is `true`, advances the fork tip to the **last** assistant message's id (`assistantMsgs.at(-1)`), using the tree-action's computed `forkTipExpectedMessageId` as the optimistic-concurrency guard.
  10. Returns a `SaveChatTurnResult` summarizing the first assistant result's `aiSequence`/`cost`/`usageRecordId` at the top level (legacy single-model callers read these directly) plus the full `assistantResults` array.
- **`persistTextAssistant`** cost math: `stageCostDollars = Σ preInferenceBillings[].costDollars`; `totalCostDollars = msg.cost + stageCostDollars`; `content_items.cost` is written as `totalCostDollars.toFixed(8)` (the **combined** total shown to the user), while the assistant's **main** `usage_records` row is charged separately at `msg.cost.toFixed(8)` (main inference only) via `chargeAndTrackUsage`, and **each** pre-inference stage billing gets its **own** separate `usage_records` row (same `assistantMessageId` as `sourceId`, its own `modelId`/tokens/`isEstimated`) — so a Smart-Model-routed message produces at minimum two `usage_records` rows (classifier stage + main inference) sharing one content item, confirmed by integration test values: classifier row cost `'0.00050000'`, main inference row cost `'0.00300000'`, combined `content_items.cost` = `'0.00350000'`.
- **`persistMediaAssistant`**: accepts either a pre-supplied `wrappedContentKey` (bytes already encrypted upstream by the media pipeline) or an `epochPublicKey` to derive a fresh one; charges via `chargeAndTrackMediaUsage` (media-specific charge function, forwarding `mediaType`, optional `imageCount`/`durationMs`/`resolution`).
- All costs across both assistant kinds are formatted with **`.toFixed(8)`** (8 decimal places) at every DB-persisted `cost` field — confirmed by every observed integration-test cost string (`'0.00136000'`, `'0.05000000'`, `'0.00000000'`, `'0.00100000'`, etc.).
- Group billing: `applyGroupSpending` is a no-op when `groupBillingContext` is `undefined`; when present, calls `updateGroupSpending(tx, { conversationId, memberId, costDollars: cost })` once per charge (main charge and, for text, each stage charge separately).

---

### 10. Cross-cutting billing/reservation values surfaced through this scope

These constants live in the billing slice proper but are directly exercised and asserted through the chat pipeline's own test suites, so they're recorded here for completeness (not exhaustively documented — that is the billing group's scope):

- **50-cent negative-balance cushion**: a chat-stream request is admitted even when the post-reservation effective balance goes negative, as long as it stays `> -50` cents; a reservation pushing it to `≤ -50` cents (or effectively unaffordable, e.g. reservation total `99999` against a `1000`-cent balance) is denied `402 ERROR_CODE_BALANCE_RESERVED`.
- **`BILLING_MISMATCH_THRESHOLD_RATIO = 0.5`** (50%) — the relative-deviation threshold between a slot's pre-flight reservation estimate and its post-flight actual cost above which a non-blocking `BILLING_MISMATCH` evidence row is recorded (CI-only persistence gate; production runs the comparison but never writes the row).
- **`TRIAL_MESSAGE_LIMIT`** — inferred as **5** messages per rolling UTC day, tracked per hashed client IP, from trial-usage test fixtures (`messageCount: 5` → `canSend: true`; `messageCount: 6` → `canSend: false`), reset at UTC midnight (`secondsUntilNextUtcMidnight`).


---

## 05. AI/Model Inference & Catalog

This report covers the legacy AI inference client abstraction (`apps/api/src/legacy/services/ai/`), its real (Vercel AI Gateway) and mock implementations, the model catalog mapping/view layers, the `/models` HTTP route, the HTTP cassette record/replay system used for CI integration tests, and the E2E-pinned model catalog fixture.

### 1. AIClient abstraction and environment selection

`getAIClient(env, options)` (`services/ai/index.ts`) is the single factory for obtaining an `AIClient`, branching on `createEnvUtilities(env)`:

- **`isLocalDev || isE2E` → mock client.** Returns a fresh, stateless `createMockAIClient(...)` per call — no module cache, no cross-request bleed. When `isE2E` is true, the mock is additionally configured with `useFixtureCatalog: true`, which pins `listRawModels()` to the committed `E2E_MODEL_CATALOG` array instead of live-fetching the public `/v1/models` endpoint.
- **Otherwise (CI integration / production) → real client.** Calls `createRealAIClient` with credentials from `requireInferenceConfig(env)` and `requireCatalogConfig(env)`. If `AI_GATEWAY_API_KEY` is missing, construction throws with the exact message `AI_GATEWAY_API_KEY required` — verified for `NODE_ENV: 'production'`, `NODE_ENV: 'development', CI: 'true'`, and (notably) `NODE_ENV: 'test'` — plain vitest mode (`NODE_ENV=test` without any dev/E2E/CI flag) is **not** treated as local dev and also throws this error.
- A local dev environment with `AI_GATEWAY_API_KEY` present still returns the **mock** client — presence of the key never overrides the environment branch.

#### Mock dev-affordance delays (`buildMockConfig`)

Only active when `isDevServer` is true (never under vitest, E2E, CI, or production); per-request `x-mock-*` header overrides always win over these defaults:

| Constant | Value | Purpose |
|---|---|---|
| `LOCAL_DEV_TEXT_DELAY_MS` | `60` | Inter-chunk delay for the echo-typewriter effect |
| `LOCAL_DEV_MEDIA_DELAY_MS` | `3000` | Delay between `media-start` and `media-done` so the "Generating…" placeholder animation is visible |
| `LOCAL_DEV_CLASSIFIER_DELAY_MS` | `1000` | Delay before the Smart Model classifier's first token so the "Choosing the best model…" indicator paints |

All three default to `0` outside a real dev server.

#### AIClientOptions

`AIClientOptions` accepts an optional `evidence: EvidenceConfig` (records `SERVICE_NAMES.AI_GATEWAY` evidence on the real client after each successful gateway call, for `verify:evidence` in CI), an optional `mockConfig: MockAIClientConfig`, and an optional `fetch` override (used by the cassette layer in CI integration tests).

### 2. Mock AI client (`mock.ts`)

#### Classifier stream

- Detects a classifier request via `isClassifierRequest`: true iff the request has a `system` message whose content starts with `CLASSIFIER_SYSTEM_PROMPT_MARKER`.
- `DEFAULT_CLASSIFIER_RESOLUTION = 'anthropic/claude-haiku-4.5'` — the model id the classifier "picks" by default, chosen deliberately cheap so it lands in the integration harness's top-N eligible set (harness sorts candidates by ascending cost).
- `DEFAULT_CLASSIFIER_DELAY_MS = 1000` — default delay before the first classifier event, so "stage:start" and "stage:done" land in separate render ticks. Configurable per test/request via `classifierDelayMs`, floored at `0` via `Math.max(0, …)`.
- The classifier stream emits the resolved model id one character at a time as `text-delta` events, then a `finish` event with `providerMetadata.generationId` and `usage.{inputTokens,outputTokens}`, where both token counts equal `Math.ceil(resolvedModelId.length / CHARS_PER_TOKEN_STANDARD)`.
- `classifierFailure: true` config makes the stream reject with `Error('Classifier unavailable (test)')`, after the same configured delay.

#### Text (echo) stream

- Non-classifier text requests return a deterministic echo: `` `Echo:\n${lastUserMessageText}\n\n` + '```json\n{\n  "ok": true\n}\n```' ``. If there is no user message, the substituted content is the literal string `'No message'`.
- The echo content is chunked into `text-delta` events using `Intl.Segmenter` grapheme segmentation (never splitting a multi-byte emoji cluster) in groups of `STREAM_CHUNK_CHARS = 24` graphemes per delta.
- `inputTokens = Math.ceil(promptCharacters / CHARS_PER_TOKEN_STANDARD)`; `outputTokens = Math.ceil(echoContent.length / CHARS_PER_TOKEN_STANDARD)`.
- `textDelayMs` (default `0`, floored at `0`) sleeps between successive `text-delta` yields (not before the first).

#### Media (image/video/audio) mock streams

Canned bytes are real CC0 sample media (source: samplelib.com) decoded from base64 fixtures in `mock-fixtures/`:

| Constant | Value |
|---|---|
| `TEST_IMAGE_MIME` | `image/jpeg` |
| `TEST_AUDIO_MIME` | `audio/mpeg` |
| `TEST_VIDEO_MIME` | `video/webm` |
| `TEST_IMAGE_WIDTH` × `TEST_IMAGE_HEIGHT` | `400` × `300` |
| `TEST_VIDEO_WIDTH` × `TEST_VIDEO_HEIGHT` | `320` × `180` |
| `TEST_AUDIO_DURATION_MS` | `3000` |
| `TEST_VIDEO_DURATION_MS` | `3000` |

- Canned image bytes begin with the JPEG SOI marker `0xFF 0xD8 0xFF` (asserted directly in `mock.test.ts`).
- `mockMediaDimensions(aspectRatio, fallback)`: when an `aspectRatio` like `"16:9"` is requested, dimensions are recomputed so the longer side equals `MOCK_MEDIA_LONG_SIDE = 1024` px, preserving the requested ratio (e.g. `9:16` produces height `1024` and a scaled width); an invalid or missing ratio falls back to the fixture's native dimensions.
- Event sequence for image/video/audio: `media-start` → `media-done` → `finish`. For `buildMediaStream`, when `delayMs > 0`, the wait happens once, immediately after `media-start` (index 1) and before `media-done` — `media-start` itself always yields immediately.
- Video mock validates `durationSeconds` against `getSupportedVideoDurations(model)`: if the requested duration isn't in the supported list, the stream rejects (on first `next()`) with the exact real-Gateway wire message:
  `` Video generation failed: Unsupported output video duration ${duration} seconds, supported durations are [${supported.join(',')}] for feature text_to_video. ``
- Audio mock has no duration/format validation; it always succeeds.
- `mock-gen-` generation ids: the classifier/text stream mints ids via a monotonic counter as `` `mock-gen-${Date.now()}-${seq}` `` (registered in a module-level `generationRegistry` Map so cross-instance `getGenerationStats` lookups still resolve); image/video/audio streams mint a simpler, unregistered `` `mock-gen-${Date.now()}` `` id (not tracked in the registry — `getGenerationStats` is only meaningful for text/classifier generations).

#### Failing models / virtual Smart Model id

- `config.failingModels` is a set of model ids; any stream request for a listed id rejects immediately with `` Error(`Model ${request.model} is unavailable`) `` — before entering the modality switch and before being recorded to history.
- A stream request for the literal `SMART_MODEL_ID` (the virtual "smart-model" catalog entry) rejects with `` Error(`Model '${SMART_MODEL_ID}' not found`) ``, mirroring the real Gateway's response for an unrecognized model — this guards against any caller forwarding the unresolved virtual id straight to inference instead of first resolving it via the classifier.

#### Recorded request history (`zdrEnforced`)

Every successfully-dispatched request (post failing-model / smart-model checks) is deep-cloned via `structuredClone` and stored with an added `zdrEnforced: true` flag — mock traffic never talks to a real gateway so ZDR is moot in practice, but the flag lets tests assert on it uniformly across mock and real paths. `getRequestHistory()` returns a defensive shallow copy (`[...history]`); `clearHistory()` empties it.

#### `getGenerationStats` (mock cost lookup)

- Looks up the generation record by id in the module-level registry; throws `` `Unknown mock generationId: ${id} (no record in mock instance — did you cross client instances, or call getGenerationStats with a forged id?)` `` if not found.
- Resolves the model via `this.getModel(record.modelId)`; throws `` `Mock cost lookup: model ${modelId} has non-token pricing kind (${kind}); getGenerationStats is only valid for text generations` `` if pricing kind ≠ `'token'`.
- Throws `` `Mock cost lookup: model ${modelId} has no usable per-token pricing (inputPerToken=${x}, outputPerToken=${y})` `` if either price is `<= 0` — deliberately surfaces a catalog/mock pricing mismatch rather than silently returning `$0`.
- Otherwise: `costUsd = inputTokens * inputPerToken + outputTokens * outputPerToken`.

#### Catalog fetch

- `listRawModels()` fetches `DEFAULT_PUBLIC_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models'` via the shared `fetchModels` helper, unless `useFixtureCatalog: true` (E2E) is set, in which case it returns `structuredClone` copies of every entry in `E2E_MODEL_CATALOG` (defensive copy — mutating the caller's array never affects the fixture).

### 3. Real AI client (`real.ts`) — Vercel AI Gateway integration

The legacy real client is built on the **Vercel AI Gateway SDK** (`createGateway`, `streamText`, `generateImage`, `experimental_generateVideo`, `gatewayTools`, `stepCountIs` — all imported from the `ai` package).

#### ZDR enforcement

Every SDK call (`streamText`, `generateImage`, `experimental_generateVideo`) is issued with `providerOptions: ZDR_PROVIDER_OPTIONS`, an exact-shape constant `{ gateway: { zeroDataRetention: true } }`. A dedicated regression test (`real.test.ts`) collects every SDK call made across all three modalities in one run and asserts each one's `providerOptions` deep-equals this shape — no per-call override, no missing field.

#### Text streaming

- System message (if any) is passed as `system`; non-system messages are mapped — assistant messages coerce non-string content to plain text (`{ role: 'assistant', content: text }`); everything else passes through as `{ role: 'user', content }`.
- `maxOutputTokens` passes straight through as the AI SDK v6 option name (no renaming).
- Image content parts convert `{ type: 'image', data, mimeType }` → SDK v6 `ImagePart` shape `{ type: 'image', image: data, mediaType: mimeType }` — the SDK field is `mediaType`, not `mimeType`; a hardcoded regression test pins this because a revert to `mimeType` would silently break image inputs.
- **Web search:** when `request.webSearchEnabled === true`, `tools: { perplexitySearch: gatewayTools.tools.perplexitySearch() }` is attached along with `stopWhen: stepCountIs(MAX_SEARCH_TOOL_CALLS)`. Test assertions pin `MAX_SEARCH_TOOL_CALLS = 10`. When `webSearchEnabled` is false or omitted, no `tools`/`stopWhen` are set at all.
- **Stream part handling (`fullStream`):**
  - `text-delta` parts with non-empty text yield `{ kind: 'text-delta', content }` and set `sawText = true`.
  - `error` parts throw immediately (`asInferenceError`) — preserves an `Error` instance's `name`/`status` (e.g. a `503` provider error), coerces a string payload into an `Error`, and falls back to `new Error('Inference stream error')` for anything else.
  - `tool-error` parts are held (not thrown immediately) — a failed tool call is not necessarily fatal if the model recovers on a later step (`stopWhen` loop). The last tool error is only rethrown if the turn ends with no visible text.
  - **Empty-turn guard (`throwForEmptyTurn`):** if no text was produced: a held tool error is thrown; else if `finishReason === 'length'`, treated as a valid billable truncation (finish event still yields, carrying `generationId` + `usage`) rather than an error; else throws `` `Model returned no text (finishReason: ${finishReason ?? 'unknown'})` ``. If the finish reason is `'tool-calls'` with no text, the message matches `/no text.*tool-calls/i`.
- **Gateway metadata schema drift guard:** the finish event's `providerMetadata.gateway.generationId` is parsed via a Zod schema (`gatewayProviderMetaSchema`, a `looseObject`). If the `gateway` namespace is present but `generationId` is missing/renamed, this throws exactly `'Gateway generation metadata schema drift — generationId missing'` — deliberately fails loud rather than silently returning `undefined` and corrupting cost lookups downstream.

#### Image generation

- Calls `generateImage({ model: gateway.imageModel(id), prompt, aspectRatio?, size?, n?, providerOptions })`.
- `imageProviderOptions(modelId)`: for Imagen-4 family models, adds `google: { sampleImageSize }` alongside the base ZDR options, where `sampleImageSize` comes from `getImagenSampleSize(modelId)`. Verified sizes: `'1K'` for `google/imagen-4.0-fast-generate-001`, `'2K'` for `google/imagen-4.0-generate-001` and `google/imagen-4.0-ultra-generate-001`; omitted entirely (no `google` key) for non-Imagen-4 models (e.g. plain `google/imagen-4`).
- Throws `'Empty image generation result'` if `result.images` is empty.
- Reads `file.uint8Array` and `file.mediaType` (not `mimeType`) from the SDK's `GeneratedFile` — a pinned regression test confirms the code does not fall back to a default when `mediaType` is the only field present.
- Yields `media-start` → `media-done` → `finish` (finish carries only gateway metadata, no usage).

#### Video generation

- Calls `experimental_generateVideo({ model: gateway.video(id), prompt, aspectRatio?, resolution?, providerOptions })` — resolves the model via `gateway.video(...)`, explicitly **not** `gateway.videoModel(...)`.
- `resolution` is typed by the SDK as `${number}x${number}` but Veo accepts shorthand strings (`'720p'`, `'1080p'`, `'4k'`) passed through verbatim via an `as unknown` cast.
- Throws `'Empty video generation result'` if `result.videos` is empty (mirrors the image path).

#### Audio generation

`streamAudioRequest` always rejects with `'Audio output not yet supported by AI Gateway'` — dead-coded behind a feature flag elsewhere; the AI SDK path for `streamText`/`generateImage`/`generateVideo` has no audio-output equivalent wired up.

#### Error diagnostics (SDK parse-failure chain)

A dedicated test class documents the exact error-cause chain the Vercel AI Gateway SDK produces on a malformed JSON response, and that `extractErrorDiagnostics` walks it fully:

`AI_GatewayResponseError` (outer, `'Gateway request failed'`) → cause `AI_APICallError` (`'Invalid JSON response'`, carries `statusCode`, `url`, `responseBody`) → cause `AI_JSONParseError` (`` `JSON parsing failed: Text: ${rawBody}. Error message: ...` ``, carries `text`) → cause native `SyntaxError` (V8's `"Expected property name or '}' in JSON at position 4 (line 2 column 3)"`-style message). `extractErrorDiagnostics(caught).layers` returns exactly 4 layers with names `['AI_GatewayResponseError', 'AI_APICallError', 'AI_JSONParseError', 'SyntaxError']`; the raw response body is preserved verbatim in at least one layer's `bodyPreview`, and the `AI_APICallError` layer carries the original `statusCode` (`200` in the pinned example — a malformed-but-200 response) and `url` (e.g. `https://ai-gateway.vercel.sh/v3/ai/image-model`).

#### `getGenerationStats` — retry/backoff for eventual consistency

The AI Gateway batches usage events to per-region Redis after a streaming response closes, so `GET /v1/generation?id=…` (via `gateway.getGenerationInfo`) can `404` in a brief window right after generation completes. The SDK does no retry of its own, so `real.ts` implements one:

- `GATEWAY_LOOKUP_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000]` — 5 possible retries (6 total attempts), summing to a **15.5s** worst-case budget.
- `isRetryableGatewayError(error)`: matches only on `error.statusCode` (never response body) — retryable codes are exactly `404`, `408`, `429`, and any `>= 500`. Any other status, or a missing/non-numeric status code (except `undefined`, which is treated as retryable), is not retried.
- On the **first** retryable failure per call, exactly one `console.warn('[ai-gateway] getGenerationInfo retryable failure, retrying', { generationId, statusCode })` is emitted (subsequent retries on the same call are silent).
- On final exhaustion (all 6 attempts fail), the original thrown error object (with its `statusCode`/`responseBody` properties intact) propagates unmodified to the caller.
- Retry state is per-call: concurrent `getGenerationStats` calls have independent budgets and do not block each other; each fresh call starts a new budget regardless of a prior call's outcome.
- `costUsd` is read from `info.totalCost` on the gateway's response, with no fee/markup applied at this layer (fees are applied later via `applyFees`).
- Evidence recording (`recordServiceEvidence(db, isCI, SERVICE_NAMES.AI_GATEWAY)`) fires only after a **successful** stream's first event or a successful `getGenerationStats` call, and only when an `evidence` config with `isCI: true` was supplied; it is never invoked when `evidence` is omitted or `isCI: false`, and never invoked while retries are still exhausting (i.e., not invoked on total failure).

### 4. Model mapping (`model-mapping.ts`) — RawModel → ModelInfo

`rawModelToModelInfo(raw)` is the single source both `real.ts` and `mock.ts` use to translate a gateway-shaped `RawModel` into the internal `ModelInfo` shape (kept in its own module specifically so `mock.ts` never has to transitively load the AI SDK).

- **Provider extraction:** `raw.id.split('/')[0]`; falls back to the literal string `'unknown'` only when the id is empty (a slash-less id like `'no-slash-id'` returns the whole id as provider, not `'unknown'`).
- **Fee contract:** every `ModelInfo.pricing.*` price field is fee-inclusive — `applyFees(...)` is applied exactly once, here, so no downstream billing code re-applies fees regardless of which model view the price came from.
- **Text pricing:** `{ kind: 'token', inputPerToken: applyFees(parseTokenPrice(prompt)), outputPerToken: applyFees(parseTokenPrice(completion)), webSearchPerCall? }`. `webSearchPerCall` is deliberately left **raw** (fees are applied later, at billing time, via `applyFees(webSearchCost)`), and is omitted entirely when the raw catalog has no `web_search` price.
- **Image pricing:** `{ kind: 'image', perImage }` — `applyFees(parseTokenPrice(per_image))`, or `0` when `per_image` is undefined in the raw catalog.
- **Video pricing:** `{ kind: 'video', perSecondByResolution }` — every entry in `per_second_by_resolution` fee-adjusted via `applyFees(parseTokenPrice(price))`; an empty object when the raw field is absent.
- **Audio pricing:** hardcoded `{ kind: 'audio', perSecond: 0 }` regardless of any raw price — audio pricing extraction is explicitly deferred (the public `/v1/models` endpoint carries no audio entries to model the field name against, and `ZDR_AUDIO_MODEL_IDS` is `[] as const`). A three-step TODO comment documents the exact extension path once the Gateway ships ZDR audio.
- `capabilities: []` is always empty at this layer (capability derivation lives in `model-view.ts`'s `getModelFeatures`, not here). `isZdr` is computed via `isZdrModel(raw.id, raw.modality)`.

### 5. Model views (`model-view.ts`) — per-modality typed catalog

`buildModelViewsForModality(rawModels, modality)` funnels raw catalog rows through `processModels` (ZDR filtering, price-floor, age, premium detection all applied exactly once), excludes the synthetic Smart Model entry (`isSmartModel !== true`), filters to the requested modality, and maps to a discriminated `ModelView` union (`TextModelView | ImageModelView | VideoModelView | AudioModelView`).

- **Fee contract** (same as `model-mapping.ts`): every price field on a `ModelView` is fee-inclusive, passed through unchanged from `Model.pricePer*`.
- **`BaseModelView`** fields: `id, name, provider, description, isPremium, features (ModelFeatureId[]), created?`.
- **`TextModelView`** adds `contextLength, inputPerToken, outputPerToken`.
- **`ImageModelView`** adds `perImage`, and optionally `supportedAspectRatios` + `imagenSampleSize` — populated only for Imagen-4-family models (derived from `getImagenSampleSize(id)` being defined). Imagen-4's `supportedAspectRatios` is the full `IMAGE_ASPECT_RATIOS` constant, pinned by test to `['1:1', '4:3', '3:4', '16:9', '9:16']`.
- **`VideoModelView`** adds `perSecondByResolution`, and optionally `supportedAspectRatios`, `supportedResolutions`, `supportedDurationsSeconds` from the shared capability tables — omitted entirely (not defaulted) for a model the capability tables don't cover.
- **`AudioModelView`** adds `perSecond`.
- **Feature detection example (from tests):** a text model with no special `supportedParameters` still includes `'vision'` in `features`; a model whose `supportedParameters` includes `'tools'` gets both `'python-execution'` and `'javascript-execution'`.

### 6. `/models` HTTP route (`routes/models.ts`)

- `GET /` (mounted under `/models`) calls `getProcessedCatalog(c)` and returns `200` with body validated against `modelsListResponseSchema = { models: Model[], premiumModelIds: string[] }` (Zod-parsed before serialization — a schema violation throws rather than serving malformed data).
- The route reads the catalog exclusively via `c.var.aiClient.listRawModels()` — never touches `AI_GATEWAY_API_KEY` or any env var directly (pinned by a test that sets `c.env = {}` with `aiClient` stubbed and confirms a `200`).
- In production mode with `AI_GATEWAY_API_KEY` missing, the full middleware chain (`aiClientMiddleware` → `getAIClient`) causes a `500`.
- Response filters out non-ZDR models entirely (a `fake/non-zdr-model` fixture entry is asserted absent from `data.models`).

### 7. HTTP cassette record/replay system (`cassette/`)

Used to make CI integration tests hit the real AI Gateway exactly once (record) and replay deterministically thereafter, without incurring repeated real cost.

#### Canonical request hashing (`canonical-request.ts`)

- `RequestDescriptor = { method, pathAndQuery, headers (allowlisted only), body (canonicalized) }`.
- **Header allowlist** (`HEADER_ALLOWLIST`) — only these 4 headers ever enter the hash: `content-type`, `accept`, `ai-model-id`, `ai-language-model-streaming`. Everything else (notably `authorization`, `user-agent`, `ai-gateway-protocol-version`, `ai-language-model-specification-version`, `x-request-id`, `traceparent`, `ai-o11y-deployment-id`) is stripped before hashing — pinned by explicit tests.
- **Query string** is sorted deterministically by key (`URLSearchParams` entries sorted via `localeCompare`, then URL-encoded and joined with `&`).
- **Special-case path:** `GET /v1/generation?id=...` (the `getGenerationInfo` endpoint) strips its query entirely before hashing, because the `id` is minted by the gateway at generation time and is non-deterministic across record/replay runs — two lookups for different ids hash identically and replay returns the most recent matching recording.
- **Body canonicalization:** for `application/json` bodies, keys are recursively sorted (`canonicalJsonValue`) and `undefined`-valued keys are stripped before `JSON.stringify`; malformed JSON falls back to a raw hex dump (`` `hex:${bytesToHex(...)}` ``) so it still hashes deterministically; non-JSON bodies always hash as raw hex; an empty body hashes as an empty string.
- **Hash:** `sha256(JSON.stringify({ method, pathAndQuery, headers (sorted), body }))`, truncated to the **first 16 hex characters** (8 bytes) — chosen because a single CI run produces roughly ~20 recordings, at which cardinality the collision probability is ~10⁻¹⁸. Header key insertion order does not affect the hash (headers are re-sorted before hashing).

#### Cassette store (`cassette-store.ts`)

- `AI_RECORDING_VERSION = 'v1'` — cassettes live at `.ai-cassettes/{AI_RECORDING_VERSION}/{hash}.json`. `CASSETTE_ROOT = path.resolve(process.cwd(), '../../.ai-cassettes')`. CI restores/saves this directory via `actions/cache@v4`; it's `.gitignore`d locally.
- `Cassette` schema (Zod): `{ version: number (int, min 1), exchanges: Array<{ status: number (int), statusText: string, headers: Record<string,string>, chunks: string[] (base64) }>, recordedAt: string, recordedFromSha?: string }`.
- `chunks` holds base64-encoded response body chunks in order — multiple for a streaming SSE response, a single entry for a non-streamed response.
- **Write is atomic:** writes to a same-directory temp file (`${finalPath}.tmp-${pid}-${Date.now()}`), fsyncs it (`openSync`/`closeSync` round-trip to flush the OS write buffer), then `renameSync`s into place — an interrupted write never leaves a corrupted final file (a crashed write leaves only an orphaned `.tmp-*` file, invisible to `read`).
- **Read is defensive:** returns `undefined` (never throws) on a missing file, an unreadable file, invalid JSON, or a payload failing the Zod schema.
- Comment documents 4 explicit conditions for bumping `AI_RECORDING_VERSION`: (1) the serialized schema changes, (2) the hash key changes (e.g. header allowlist edited), (3) provider behavior changed and all current recordings should be invalidated, (4) test prompts changed and a clean re-record is wanted.

#### Recording fetch interceptor (`recording-fetch.ts`)

`createCassetteFetch({ store, realFetch })` wraps a fetch-shaped function with hit/miss semantics:

- **Hit** (cassette exists for the computed hash): replays synthetically from the first stored exchange — never calls `realFetch`. (Per the sequence-of-exchanges design, one logical operation maps to one cassette entry in practice, so only `exchanges[0]` is ever read; an empty-exchanges cassette is treated as a miss.)
- **Miss + success** (`status < 400`): passes the real response through to the caller **and** records it. The response body is `tee()`d so the caller's consumption doesn't starve the recording branch; the recording branch drains in the background and writes the cassette once fully drained. `content-encoding` is stripped from recorded headers (the SDK's response parser handles decoding above this layer; recording the encoded bytes would double-encode on replay).
- **Miss + error** (`status >= 400`, i.e. any 4xx/5xx): passes through, **does not record** — a failed gateway call bills nothing, so re-running it live is free, whereas caching it would replay a stale transient failure (auth/plan/rate-limit/server error, e.g. a 403 `ZdrUnauthorized`) forever.
- **Network failure / thrown error:** passes the error through unmodified, does not record.
- Recorded cassette entry, when `GITHUB_SHA` is present in `process.env` (a raw CI-only read, not routed through `envConfig`), stamps `recordedFromSha`.
- The AI SDK's URL-fallback media download path (providers that return `type: 'url'` rather than inline base64) is captured naturally: the first fetch records the gateway response containing the URL; the SDK's follow-up `defaultDownload(url)` call is a separate request that hashes to (and records under) its own separate cassette entry — no special multi-exchange logic is needed at this layer.

### 8. E2E-pinned model catalog fixture (`e2e-catalog.fixture.ts`)

`E2E_MODEL_CATALOG` is a committed, deterministic snapshot of `RawModel[]` served by the mock client's `listRawModels()` whenever `useFixtureCatalog: true` (i.e., in E2E). Generated by running a real `/v1/models` snapshot through the same production transform the live path uses (`publicModelEntrySchema` → `toRawModel`), so shape and pricing cannot diverge from production; a separate CI "live-catalog-drift" watchdog independently re-asserts the live catalog still matches this fixture's shape/ZDR allow-list. The file carries a "do not hand-edit" comment.

**Composition:** 283 total entries — **226 text**, **30 image**, **27 video**, **0 audio** (audio genuinely absent, consistent with audio generation being unimplemented in `real.ts`).

**Provider breakdown (by id prefix, all 283 entries):** openai 48, alibaba 33, google 28, mistral 18, xai 13, zai 13, anthropic 12, bytedance 12, voyage 12, bfl 10, meta 9, deepseek 8, klingai 8, minimax 8, recraft 8, moonshotai 6, amazon 5, cohere 5, nvidia 5, xiaomi 4, arcee-ai 3, perplexity 3, inception 2, kwaipilot 2, meituan 2, morph 2, stepfun 2, interfaze 1, prodia 1.

**Image models (30, full id/name list):** `bfl/flux-2-flex` (FLUX.2 [flex]), `bfl/flux-2-klein-4b` (FLUX.2 [klein] 4B), `bfl/flux-2-klein-9b` (FLUX.2 [klein] 9B), `bfl/flux-2-max` (FLUX.2 [max]), `bfl/flux-2-pro` (FLUX.2 [pro]), `bfl/flux-kontext-max` (FLUX.1 Kontext Max), `bfl/flux-kontext-pro` (FLUX.1 Kontext Pro), `bfl/flux-pro-1.0-fill` (FLUX.1 Fill [pro]), `bfl/flux-pro-1.1` (FLUX1.1 [pro]), `bfl/flux-pro-1.1-ultra` (FLUX1.1 [pro] Ultra), `bytedance/seedream-4.0`, `bytedance/seedream-4.5`, `bytedance/seedream-5.0-lite`, `google/imagen-4.0-fast-generate-001` (Imagen 4 Fast), `google/imagen-4.0-generate-001` (Imagen 4), `google/imagen-4.0-ultra-generate-001` (Imagen 4 Ultra), `openai/gpt-image-1`, `openai/gpt-image-1-mini`, `openai/gpt-image-1.5`, `openai/gpt-image-2`, `prodia/flux-fast-schnell` (Flux Schnell), `recraft/recraft-v2` through `recraft/recraft-v4.1-utility-pro` (8 Recraft variants), `xai/grok-imagine-image` (Grok).

**Video models (27, full id/name list):** `alibaba/wan-v2.5-t2v-preview`, `alibaba/wan-v2.6-i2v`, `alibaba/wan-v2.6-i2v-flash`, `alibaba/wan-v2.6-r2v`, `alibaba/wan-v2.6-r2v-flash`, `alibaba/wan-v2.6-t2v`, `bytedance/seedance-2.0`, `bytedance/seedance-2.0-fast`, `bytedance/seedance-v1.0-lite-i2v`, `bytedance/seedance-v1.0-lite-t2v`, `bytedance/seedance-v1.0-pro`, `bytedance/seedance-v1.0-pro-fast`, `bytedance/seedance-v1.5-pro`, `google/veo-3.0-fast-generate-001`, `google/veo-3.0-generate-001`, `google/veo-3.1-fast-generate-001`, `google/veo-3.1-generate-001`, `klingai/kling-v2.5-turbo-i2v`, `klingai/kling-v2.5-turbo-t2v`, `klingai/kling-v2.6-i2v`, `klingai/kling-v2.6-motion-control` (and 6 further klingai/minimax/other video entries rounding out the 27).

**Representative pricing entries (exact, as stored):**
- `openai/gpt-5` (text): `context_length: 400_000`; `pricing.prompt: '0.000000625'`, `pricing.completion: '0.000005'`; `created: 1_754_006_400`.
- `alibaba/qwen-3-14b` (text): `context_length: 40_960`; `pricing.prompt: '0.00000012'`, `pricing.completion: '0.00000024'`; `created: 1_743_465_600`.
- `google/imagen-4.0-generate-001` (image): `context_length: 480`; `pricing.per_image: '0.04'`; `input_modalities/output_modalities: ['image']`.
- `google/veo-3.1-generate-001` (video): `context_length: 0`; `pricing.per_second_by_resolution: { '720p': '0.4', '1080p': '0.4', '4k': '0.6' }`; description states 8-second 720p/1080p/4k output with native audio.

### 9. Test infrastructure — capability-driven picking and bounds

#### Cheapest test-model picker (`test-model-picker.ts`)

Selects the cheapest **paid, non-premium** model per modality against the live/fixture catalog so integration tests never accidentally burn credit on a premium model, and never select a (model, param) combination the gateway would reject:

- `MAX_TEST_TOKEN_PRICE_FEE_INCLUSIVE = 0.000_01` ($0.00001/token, fee-inclusive)
- `MAX_TEST_IMAGE_PRICE_FEE_INCLUSIVE = 0.05` ($0.05/image, fee-inclusive)
- `MAX_TEST_VIDEO_PRICE_PER_SECOND_FEE_INCLUSIVE = 0.2` ($0.20/sec, fee-inclusive)
- Text: filters to non-premium, priced (`>0`) models, sorts by `inputPerToken + outputPerToken` ascending, prefers the cheapest **within** threshold but falls back to the globally cheapest paid non-premium model if none clears the threshold (never throws just because everything is expensive — only throws `'No paid non-premium text model available.'` if the candidate set is empty). Selected text params: fixed `maxOutputTokens: 2048`.
- Image: requires capability data (`supportedAspectRatios` present and non-empty) and `0 < perImage <= MAX_TEST_IMAGE_PRICE_FEE_INCLUSIVE`; throws `'No image model with capability data found within MAX_TEST_IMAGE_PRICE_FEE_INCLUSIVE.'` otherwise. Uses the model's first supported aspect ratio.
- Video: scores every (model, resolution) combination by **total call cost** = `pricePerSecond × minDuration` (not price-per-second alone) — a pricier-per-second model with a shorter minimum duration can win; e.g. a 4s-minimum model at $0.10/s ($0.40 total) beats a 5s-minimum model at the same rate ($0.50 total). Requires `supportedResolutions`, `supportedDurationsSeconds`, and non-empty `supportedAspectRatios`; throws `'No video model with capability data found within MAX_TEST_VIDEO_PRICE_PER_SECOND_FEE_INCLUSIVE.'` if no candidate qualifies. Selection is cached per modality (`cachedSpecs: Map<Modality, TestModelSpec>`); `clearTestModelCache()` resets it. `audio` always throws `'Audio integration tests are not in scope.'`.

#### Integration client wiring (`integration-setup.ts`)

- `setupIntegrationClient()` delegates to production `getAIClient` (no parallel env-branching logic). Local dev → mock client, `db: null`. Otherwise builds a real `Database` via `createDb` against `DATABASE_URL` (throws a specific message if unset: `'DATABASE_URL is required for AI integration tests in CI — envConfig (mode ciVitest) sets it; verify the env-generation step ran.'`).
- The HTTP cassette layer engages **only** when `isCiVitest = isCI && !isE2E` — the vitest CI integration job gets cassette-wrapped fetch; the E2E job never reaches this code path (it uses the mock client's built-in E2E branch).

#### Media byte validation (`media-assertions.ts`)

`assertValidMediaBytes(bytes, allowedMimeTypes, sizeBounds)` — hand-rolled magic-byte sniffing (no dependency):

| Format | Signature (hex) |
|---|---|
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| JPEG | `FF D8 FF` |
| WebP | RIFF container (`52 49 46 46` ... `57 45 42 50` at offset 8) |
| MP4 | `ftyp` box signature |
| WebM | (detected as `video/webm`) |

Throws with size in the message if `byteLength < min` or `> max`; throws `'Unable to detect media format by byte signature.'` if no signature matches; throws including the detected mime and the allowed list if the detected mime isn't in `allowedMimeTypes`.

#### Integration test operational parameters

| Suite | Timeout | Notes |
|---|---|---|
| `billing.integration.test.ts` (text cost) | `TEXT_TIMEOUT_MS = 30_000` | `SANITY_TEXT_MAX_USD = 0.01` — asserts a real single-turn text generation costs strictly between `$0` and `$0.01`; `FEE_MATH_PRECISION = 12` decimal places for `applyFees` equality checks |
| `image-generation.integration.test.ts` | `IMAGE_TIMEOUT_MS = 60_000` | One live image generation shared (in `beforeAll`) across every assertion in the file — deliberately generates exactly once |
| `video-generation.integration.test.ts` | `VIDEO_TIMEOUT_MS = 300_000` | One live video generation shared across the whole file; comment states **the AI Gateway caps video generation to one request per minute for account balances below $100** — two concurrent live video calls would race for that slot and one would 429, so this is enforced as a hard single-call-per-suite-run rule, not just an optimization. Media bounds asserted: `min: 16, max: 50_000_000` bytes, allowed mimes `['video/mp4', 'video/webm']` |
| `real.integration.test.ts` | `TEXT_TIMEOUT_MS = 30_000` | `MIN_DISTINCT_PROVIDERS = 2` — asserts the live catalog spans at least 2 distinct providers |
| `smart-model.integration.test.ts` | `CLASSIFIER_TIMEOUT_MS` (used at `60_000` call sites) | Exercises the full Smart Model classifier → resolved-model → billing → persistence pipeline against a real or mock client |

### 10. Smart Model integration behavior (as exercised against the AIClient)

- The classifier model is chosen as the **cheapest** model in the harness's sorted-by-cost candidate set (`sorted[0]`); the eligible list passed to the classifier prompt is a slice of that same sorted list, sized by the caller (tests exercise slices of 2 and 3).
- `resolveClassifierOutput(classifierText, eligibleIds)` resolves the classifier's raw text output to one of the eligible ids, or `null` if it can't be resolved to any.
- Both the classifier call and the resolved-model inference call each produce their own billable `getGenerationStats` cost (`> 0`), and each is persisted as its own `usage_records` row of `type: 'llm_completion'` with `isEstimated: false` (never a production-style dev estimate) — a full turn with Smart Model persists **exactly 2** `usage_records` rows linked to the same assistant `content_items` row, whose `cost` equals the summed cost of those 2 rows within `1e-6` tolerance.
- **Insufficient-balance short-circuit:** `buildEligibleModels({ textModels, premiumIds, payerTier: 'free', payerBalanceCents: 0, payerFreeAllowanceCents: 0, promptCharacterCount: 200 })` returns `null` when the payer's balance can't cover even the classifier's worst-case overhead — the pipeline must short-circuit to `ERROR_CODE_INSUFFICIENT_BALANCE` (`'INSUFFICIENT_BALANCE'`) **before any AI call is made**; verified both that `eligibility === null` and that this produces **zero** `usage_records` rows for the user.
- **Throw-fallback path:** when the classifier's resolution path throws/fails-over, the outcome resolves to a fallback model id with `outcome.billing === null` — persistence in that case writes only the single inference `usage_records` row (not 2), `content_items.isSmartModel` is still `true`, and `content_items.modelName` stores the *resolved* (fallback) model id, never the literal `'smart-model'` string, and `content_items.cost` equals just the inference cost (no separate classifier-stage cost added).

### 11. Cross-cutting constants referenced throughout

These are imported from the shared package rather than defined in this scope, but their concrete values are pinned by tests within this scope and are load-bearing for AI dispatch behavior documented above:

- `ZDR_PROVIDER_OPTIONS = { gateway: { zeroDataRetention: true } }` — set on every real SDK call (text/image/video).
- `MAX_SEARCH_TOOL_CALLS = 10` — caps the web-search tool-call loop via `stepCountIs(10)`.
- `SMART_MODEL_ID = 'smart-model'` (virtual catalog id, rejected by both mock and real dispatch paths as "not found").
- `CLASSIFIER_SYSTEM_PROMPT_MARKER` — a string prefix on the system-message content that both the real dispatch path and the mock use to detect a classifier request.


---

## 06. Billing, Wallets, Ledger & Payments

Scope: `apps/api/src/legacy/lib/billing-reservation.{ts,test.ts}`,
`apps/api/src/legacy/lib/billing-types.ts`,
`apps/api/src/legacy/lib/speculative-balance.{ts,test.ts}`,
`apps/api/src/legacy/routes/{billing,budgets,usage,webhooks}.{ts,test.ts}`,
`apps/api/src/legacy/services/billing/*`, `apps/api/src/legacy/services/helcim/*`, plus
supporting context read from `apps/api/src/legacy/lib/redis-registry.ts` (Redis key TTLs) and
`apps/api/src/legacy/lib/speculative-balance.ts`.

Several numeric constants used by this scope (`getCushionCents`, `FREE_ALLOWANCE_DOLLARS`,
`TRIAL_MESSAGE_LIMIT`, `WELCOME_CREDIT_BALANCE`, `PAYMENT_EXPIRATION_MS`,
`STORAGE_COST_PER_CHARACTER`, `applyFees`, `BILLING_MISMATCH_THRESHOLD_RATIO`'s consumers) are
imported from `@hushbox/shared`, whose source is outside `legacy/`. Where the exact value is
pinned by an in-scope test assertion, it is reported as a concrete value with a note on how it
was evidenced; where only a bound is evidenced, that bound is reported instead of a guess.

---

### Wallets: types, priority, and provisioning

Every user has up to two wallets, distinguished by `wallets.type`:

- `purchased` — priority `0`, funded by card payments. Created with an opening balance of
  `WELCOME_CREDIT_BALANCE`, evidenced by test assertion as the exact dollar string
  `'0.20000000'` (i.e. $0.20).
- `free_tier` — priority `1`, the renewing daily allowance. Created with opening balance
  `FREE_ALLOWANCE_DOLLARS`, evidenced by test assertion as the exact dollar string
  `'0.05000000'` (i.e. $0.05).

`ensureWalletsExist(db, userId)` is the single wallet-provisioning entry point:

- Inserts both wallets via `ON CONFLICT DO NOTHING` targeting `[wallets.userId, wallets.type]`
  — idempotent, safe to call repeatedly (e.g. inside retry loops).
- A `welcome_credit` ledger entry is written **only** when the `RETURNING` clause on the wallet
  insert actually returns a row (i.e. the wallet was newly created this call) — an
  already-existing wallet produces no duplicate ledger entry.
- Both ledger entries use `entryType: 'welcome_credit'`, with `amount` and `balanceAfter` both
  set to the wallet's opening balance, and `sourceWalletId` set to the new wallet's own id.
- A fully-fresh user causes exactly 4 inserts: 2 wallet inserts + 2 ledger-entry inserts
  (evidenced by test).

Wallet balances are stored as dollar strings in `numeric(20,8)` Postgres columns (8 decimal
places of precision, e.g. `'110.00000000'`).

---

### Balance checking & tier resolution (`services/billing/balance.ts`)

`checkUserBalance(db, userId)`:

- Sums all `purchased`-type wallet balances into `purchasedBalance`.
- Reads the single `free_tier` wallet balance separately.
- `hasBalance = purchasedBalance > 0 || freeAllowanceCents > 0` — a `0` or negative purchased
  balance with zero free allowance yields `hasBalance: false`. A negative purchased balance
  (e.g. `'-5.00000000'`) is legal and still reported as `currentBalance`, but does not count
  toward `hasBalance`.
- Triggers lazy free-tier renewal as a side effect (see below) before computing the result.
- Dollars → cents conversion for the free allowance is `freeAllowanceDollars * 100` — no
  rounding, fractional cents are preserved exactly (e.g. `'0.03000000'` dollars → `3` cents
  exactly; evidenced by test).

`getUserTierInfo(db, userId | null)`:

- `userId === null` short-circuits to `getUserTier(null)` (the trial/guest resolution path in
  shared code) without any DB query.
- A user with zero wallet rows resolves via `getUserTier({ balanceCents: 0,
freeAllowanceCents: 0 })`.
- `balanceCents = purchasedBalance * 100` and `freeAllowanceCents = freeAllowanceDollars * 100`
  — same no-rounding, fractional-cent-preserving conversion as above.
- Confirmed conversions via test: `$10` purchased → `1000` cents (`tier: 'paid'`,
  `canAccessPremium: true`); `$5 + $3` across two purchased wallets → `800` cents; `$0.20` →
  `20` cents.

#### Free-tier lazy renewal (`maybeRenewFreeAllowance`)

- Looks up the most recent `ledgerEntries.createdAt` for the free-tier wallet, restricted to
  `entryType IN ('renewal', 'welcome_credit')` — both entry types count as "already renewed
  today," so a wallet that just received its initial `welcome_credit` today is **not** also
  renewal-topped-up the same day (evidenced by test: a `welcome_credit` entry from today
  suppresses renewal even with zero `renewal` rows).
- Renewal fires when `needsResetBeforeMidnight(lastRenewalAt)` returns true (i.e. the last
  renewal/welcome-credit event predates the most recent UTC-midnight boundary).
- The renewal write is one atomic transaction: `UPDATE wallets SET balance =
FREE_ALLOWANCE_DOLLARS WHERE id = ? AND type = 'free_tier' AND balance <
FREE_ALLOWANCE_DOLLARS`, then (only if that update affected a row) `INSERT INTO
ledger_entries`.
- The `WHERE balance < FREE_ALLOWANCE_DOLLARS` clause **is** the idempotency/race guard: if two
  concurrent requests both observe a stale balance and race to renew, only the first `UPDATE`
  affects a row; the second affects 0 rows and silently no-ops (no ledger entry, no error).
- The ledger entry's `amount` is the delta actually added: `FREE_ALLOWANCE_DOLLARS -
currentBalanceDollars`, computed to 8 decimal places (`.toFixed(8)`), `entryType: 'renewal'`,
  `sourceWalletId` = the free-tier wallet's own id.
- Return value is always `FREE_ALLOWANCE_DOLLARS` parsed as a float when renewal fires;
  otherwise the unchanged current balance.

---

### Speculative balance reservation (Redis) — `lib/speculative-balance.ts`

A pre-settlement Redis hold system, separate from the durable Postgres ledger. All values are
cents (numbers), stored via `redisIncrByFloat` (atomic Lua-backed increment) and read via
`redisGet`.

Three Redis key families, all with **TTL = 180 seconds** (`ttl: 180` in the registry, i.e. a
reservation self-expires 3 minutes after last write if never released):

| Registry key | Redis key pattern | Purpose |
|---|---|---|
| `chatReservedBalance` | `chat:reserved:${userId}` | Per-user personal reservation total (also doubles as the payer's total under group billing) |
| `groupMemberReserved` | `chat:group-reserved:${conversationId}:${memberId}` | Per-member-per-conversation reservation total |
| `conversationReserved` | `chat:conversation-reserved:${conversationId}` | Per-conversation aggregate reservation total |

Operations:

- `getReservedTotal(redis, userId)` → reads `chatReservedBalance`, defaults to `0` when unset.
- `reserveBudget(redis, userId, costCents)` → `+costCents` on `chatReservedBalance`, returns the
  new running total.
- `releaseBudget(redis, userId, costCents)` → `-costCents` on the same key (release is simply a
  negative increment, no floor-at-zero clamp is applied in this function).
- `reserveGroupBudget(redis, { conversationId, memberId, payerId, costCents })` → three
  sequential atomic increments, in this exact order: (1) `groupMemberReserved` for
  `(conversationId, memberId)`, (2) `conversationReserved` for `conversationId`, (3)
  `chatReservedBalance` for `payerId` (the **same key** a personal reservation would use — a
  guest's group spend and the owner's own personal spend accumulate on one shared counter,
  evidenced by test: owner's personal reserve of 5 followed by a guest's group reserve of 3
  yields a payer total of 8).
- `releaseGroupBudget` mirrors the three increments with negated amounts, same key order.
- `getGroupReservedTotals(redis, conversationId, memberId, payerId)` reads all three keys in
  parallel via `Promise.all`, each defaulting to `0`.

---

### Billing reservation gate (`lib/billing-reservation.ts`)

The common post-decision reservation step shared by text and media billing pipelines.

#### Funding-source decision (`decideFundingSource`)

- Calls `resolveBilling(billingResult.input)` (pure shared logic) after stamping
  `billingResult.input.estimatedMinimumCostCents = worstCaseCents`.
- `fundingSource === 'denied'` → invokes the caller-supplied `handleBillingDenial`, which builds
  a **402** response.
- Client-declared `clientFundingSource` disagreeing with the server-resolved funding source →
  **409** response with error code `BILLING_MISMATCH`, body includes
  `serverFundingSource`.
- `isGroupBilling` is `true` only when the resolved funding source is `'owner_balance'` **and**
  `billingResult.input.group !== undefined`.
- `payerTier` is the group owner's tier when group billing, else the requesting user's own
  tier.

#### Reservation + cushion guard — personal path (`reservePersonalBudgetWithGuard`)

1. `reserveBudget(redis, userId, worstCaseCents)` — reserves optimistically first (increments
   before checking), returning the new cumulative reserved total for that user.
2. `availableCents` = `rawFreeAllowanceCents` if `fundingSource === 'free_allowance'`, else
   `rawUserBalanceCents` (the pre-reservation DB balance, not Redis-adjusted).
3. `finalEffective = availableCents - newTotalReserved`.
4. **Cushion check:** if `finalEffective < -cushionCents` (i.e. overshoot exceeds the cushion),
   the reservation is rolled back via `releaseBudget(redis, userId, worstCaseCents)` and a
   **402** `BALANCE_RESERVED` response is returned. Otherwise the reservation stands.
5. `cushionCents = getCushionCents(payerTier)` — a per-tier cushion in cents. The exact
   per-tier table lives in `@hushbox/shared` (outside this scope), but the **paid tier value is
   pinned by in-scope tests as 50 cents**:
   - "TOCTOU guard: rolls back when post-reservation balance below cushion" — a reservation
     overshooting balance by far more than 50 cents fails and is rolled back.
   - "paid tier cushion absorbs small overshoot" — reservation `100_010` cents against balance
     `100_000` cents (a 10-cent overshoot) **succeeds**, with the comment explicitly stating
     this is "within paid 50c cushion."

#### Reservation + cushion guard — group path (`reserveGroupBudgetWithGuard`)

1. Builds a `GroupBudgetReservation { conversationId, memberId, payerId: ownerId, costCents }`.
2. Calls `reserveGroupBudget` (the three-key atomic increment described above).
3. Throws (hard invariant error, not a typed failure) if `billingResult.groupBudgetContext` is
   missing — `'invariant: groupBudgetContext required for group billing'`.
4. Recomputes `postReservationEffective` via `effectiveBudgetCents` across three dimensions:
   conversation-remaining, member-remaining, owner-remaining — each computed as
   `budgetDollars*100 - spentDollars*100 - reservedTotal` for that dimension.
5. Same cushion check as the personal path: `< -cushionCents` → rollback via
   `releaseGroupBudget` and **402** `BALANCE_RESERVED`; a full rollback failure test confirms
   exactly 3 forward reservation calls + 3 release calls = 6 total `redis.eval` calls on
   failure.
6. On success, `billingUserId` in the result is the **owner's** id, not the acting member's id.

#### Orchestrator (`reserveMediaBilling`)

- Runs `decideFundingSource` first; on failure, short-circuits with that failure.
- Routes to `reserveGroupBudgetWithGuard` only when **both** `decision.isGroupBilling` is true
  **and** the caller supplied `memberContext` **and** `conversationId`; otherwise falls back to
  `reservePersonalBudgetWithGuard` even if the billing decision nominally resolved to group
  billing (evidenced by test: "falls back personal reservation when group context advertised
  but memberContext missing").

---

### Billing input assembly (`services/billing/resolve.ts`)

`buildBillingInput` (authenticated personal/member path):

- Runs `getUserTierInfo`, `getReservedTotal`, and the processed-model-catalog promise
  concurrently via `Promise.all` (the catalog promise is passed in pre-started so its network
  fetch, if any, overlaps with the DB/Redis calls).
- `isPremiumModel = models.some(m => premiumIds.includes(m))`.
- `adjustedBalanceCents = balanceCents - reservedCents`; `adjustedFreeAllowanceCents =
freeAllowanceCents - reservedCents` — **both** balance and free-allowance are reduced by the
  *same* reserved-cents figure (there is only one Redis reservation counter per user, shared
  across funding sources); this can drive `freeAllowanceCents` negative even for a paid user
  whose free-tier wallet is unused (evidenced by test: paid user with 0 free allowance and 200
  reserved cents ends up with `freeAllowanceCents: -200`).
- `estimatedMinimumCostCents` starts at `0` in the returned input — the caller sets it later
  after tier-aware computation.
- Group path additionally fetches owner tier info, group Redis reservation totals, and
  conversation budgets in parallel, then computes `input.group.effectiveCents` via
  `effectiveBudgetCents`, and `input.group.ownerBalanceCents = ownerTierInfo.balanceCents -
reserved.payerTotal`.
- The returned `groupBudgetContext.ownerBalanceCents` deliberately stays **raw** (unadjusted by
  Redis reservations) — it exists specifically to feed the post-reservation race guard in
  `billing-reservation.ts`, which needs the pre-reservation baseline.
- `getUserTierInfo` is called exactly twice on the group path: once for the acting user, once
  for the conversation owner.

`buildGuestBillingInput` (link-guest path, no personal wallet):

- Skips `getReservedTotal` entirely (guests have no personal reservation key) — confirmed by
  test ("does not call getReservedTotal").
- `tier: 'guest'`, `balanceCents: 0`, `freeAllowanceCents: 0` unconditionally.
- `getUserTierInfo` is called exactly once (for the owner only).
- Otherwise mirrors the group-path assembly logic in `buildBillingInput` (owner tier, group
  reserved totals, conversation budgets, `effectiveCents`).

Both builders default a member's `memberBudget` to `'0.00'` and `memberSpent` to `'0'` when no
`member_budgets` row exists for that member (a LEFT-JOIN miss).

---

### Conversation & member budgets (`services/billing/budgets.ts`)

`getConversationBudgets(db, conversationId)`:

- Returns raw dollar strings straight from the DB, no unit conversion inside this function.
- `conversationBudget` defaults to `'0.00'` when the conversation row query returns nothing.
- `totalSpent` defaults to `'0'` when no `conversation_spending` row exists.
- Each member row's `budget` defaults to `'0.00'` and `spent` to `'0'` on a LEFT JOIN miss (no
  `member_budgets` row for that member).
- Sub-cent spending precision (8 decimal places, e.g. `'0.00037360'`) survives round-trip
  unmodified (evidenced by test).

`updateMemberBudget(db, memberId, budgetCents)`:

- Converts cents → dollar string with exactly 2 decimal places: `(budgetCents /
100).toFixed(2)`. `1050` cents → `'10.50'`; `0` → `'0.00'`; `999_999` cents → `'9999.99'`.
- Upserts via `INSERT ... ON CONFLICT (memberId) DO UPDATE`.

`updateConversationBudget(db, conversationId, budgetCents)` — identical cents→dollars
(`.toFixed(2)`) conversion, plain `UPDATE` (no upsert, the conversation row always exists).

`updateGroupSpending(db, { conversationId, memberId, costDollars })` — called inside the same
transaction as `chargeForUsage()`. Two `INSERT ... ON CONFLICT DO UPDATE` upserts run in this
order: (1) `conversation_spending` incremented by `costDollars` (`totalSpent = totalSpent +
costDollars::numeric`), (2) `member_budgets.spent` incremented by the same amount.

`computeGroupRemaining(...)` — pure function, three dimensions, each **dollars×100 minus
Redis-reserved cents**:

```
conversationRemainingCents = conversationBudget*100 - conversationSpent*100 - reserved.conversationTotal
memberRemainingCents        = memberBudget*100        - memberSpent*100        - reserved.memberTotal
ownerRemainingCents         = ownerBalanceCents                                 - reserved.payerTotal
```

All three can go negative when overspent/over-reserved (evidenced by test: conversation budget
$1.00, spent $0.80, 50 cents reserved → `-30` cents remaining). Sub-cent spending precision is
preserved through the multiplication (e.g. `$10.00 - 0.0003736*100 = 999.96264` cents,
evidenced via `toBeCloseTo` assertion to 4 decimal places).

---

### Cost calculation (`services/billing/cost-calculator.ts`)

#### Gateway-cost resolution with estimate fallback

`resolveGatewayCostOrEstimate`:

- Primary path: `aiClient.getGenerationStats(generationId)` returns the gateway's raw
  (pre-fee) `costUsd`, tagged `wasEstimated: false`. This raw cost already reflects any
  web-search calls, cache discounts, or tier pricing bundled by the gateway — no double-billing
  of search cost on top.
- Fallback path (gateway lookup throws / exhausts retries): looks up the model's catalog
  pricing via `aiClient.getModel(modelId)`. If `model.pricing.kind !== 'token'` (i.e. an
  image/video/audio model), the original gateway error is **re-thrown**, not swallowed — media
  billing is documented as never reaching this function in production; this is a defensive
  guard against a future refactor routing media here.
- Token-priced fallback: `modelCostUsd = estimateTokenCount(input) * pricing.inputPerToken +
estimateTokenCount(output) * pricing.outputPerToken`. Catalog per-token prices are
  **fee-inclusive already** (per the `pricingFromRawModel` contract), so this estimate must
  **not** be re-wrapped in `applyFees` — the fallback total is already final.
- On fallback, logs a single `console.error` call whose first argument stringifies to contain
  the literal substring `'billing'`, carrying `{ generationId, modelId, modelCostUsd,
gatewayErrorStatus }`.
- If the fallback catalog lookup (`getModel`) itself throws, that error propagates (not the
  original gateway error) — no further fallback beyond the token estimate.

#### Cost finalization

- Storage cost: `(inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER` — driven by
  character counts held in memory, applied exactly once, always at the "main" attribution level
  (never per pre-inference stage).
- Success path (`wasEstimated: false`): `totalDollars = applyFees(rawGatewayCostUsd) +
storageCost`.
- Fallback path (`wasEstimated: true`): `totalDollars = feeInclusiveEstimate + storageCost` (no
  second `applyFees` wrap, since the estimate is already fee-inclusive).
- Zero-cost + zero-length content on both success and estimate paths returns `0`.

#### `BILLING_MISMATCH_THRESHOLD_RATIO = 0.5`

Exported literal constant, defined directly in this scope's file
(`services/billing/cost-calculator.ts`) — **50% relative deviation** is the default tolerance.

`recordBillingMismatchIfExceeded({ estimateUsd, actualUsd, evidence?, thresholdRatio? })`:

- No-op (never records, never throws) when `evidence === undefined`.
- No-op when both `estimateUsd` and `actualUsd` are exactly `0`.
- When `estimateUsd === 0` and `actualUsd !== 0`: treated as unconditionally exceeding
  (unbounded relative deviation, `deviation` reported as `null`).
- Otherwise: `deviation = |actualUsd - estimateUsd| / estimateUsd`; exceeds when `deviation >
threshold` (threshold defaults to `BILLING_MISMATCH_THRESHOLD_RATIO` = `0.5`, i.e. actual must
  differ from estimate by more than 50% to be recorded). A +10% deviation does **not** trigger a
  record (evidenced by test).
- On exceed, calls `recordServiceEvidence(evidence.db, evidence.isCI, SERVICE_NAMES.BILLING_MISMATCH,
{ estimateUsd, actualUsd, deviation })`. `recordServiceEvidence` itself gates the actual DB
  write on `isCI === true` — so in production the comparison always runs but a row is never
  persisted.

#### Multi-stage cost attribution (`calculateMessageCostWithStages`)

- Runs the main-inference resolution and every pre-inference stage's resolution concurrently
  via a single `Promise.all` (evidenced by test: all stage "start" events precede any "end"
  event even though the main call is deliberately the slowest).
- Each stage's `costDollars` is computed independently: `wasEstimated ? gatewayCostUsd :
applyFees(gatewayCostUsd)`. One stage falling back to the token estimate does not affect
  sibling stages or the main resolution.
- Storage cost is attributed **entirely to the main cost**, never split across stages — stages
  carry no storage component at all.
- Invariant asserted by tests across all combinations (all-exact, all-estimated, mixed):
  `totalDollars === mainCostDollars + Σ stageBreakdown[i].costDollars`.
- Per-stage model-id lookups use each stage's **own** `modelId` for the fallback catalog price,
  never the main model's id.
- A non-token-priced model failing gateway lookup during stage resolution re-throws (same
  guard as the single-message path).

---

### Trial usage (anonymous message quota) — `services/billing/trial-usage.ts`

`consumeTrialMessage(redis, trialToken, ipHash)` — atomic increment-then-check, eliminating a
check-then-act race:

- `ttl = secondsUntilNextUtcMidnight()` — the Redis TTL set on first increment is dynamic,
  expiring at the next UTC midnight (not a fixed window). (Note: the static Redis-registry
  entries for `trialTokenUsage`/`trialIpUsage` declare a schema-level `ttl: 86_400` — 24
  hours — as their nominal default, but the actual TTL applied at write time by this function
  is the dynamic until-midnight value, which is ≤ 86,400 s.)
- Redis keys: `trial:token:${trialToken}` and `trial:ip:${ipHash}`.
- `trialToken === null` → only the IP key is incremented (dual-identity anti-evasion is
  impossible without a token; falls back to IP-only limiting).
- Non-null token → **both** token and IP keys are incremented in parallel; `messageCount =
Math.max(tokenCount, ipCount)` — the higher of the two counters governs, so a user who clears
  localStorage but keeps the same IP is still capped by the IP counter, and vice versa.
- TTL (`redis.expire`) is set **only** when `incr` returns exactly `1` (i.e. only on the key's
  first creation this window) — subsequent increments do not touch the TTL.
- `canSend = messageCount <= TRIAL_MESSAGE_LIMIT`. **`TRIAL_MESSAGE_LIMIT = 5`**, evidenced
  precisely by test: the 5th message (`incr` returns `5`) still has `canSend: true`; the 6th
  message (`incr` returns `6`) has `canSend: false`.
- Redis errors from `incr` are propagated, never swallowed.

---

### Transaction writer — charging & crediting (`services/billing/transaction-writer.ts`)

#### Crediting (deposits)

`creditWalletAndCreateLedger` (shared helper) — updates the `purchased` wallet's balance and
inserts a ledger entry with `entryType: 'deposit'`, `sourceWalletId` = the credited wallet's
own id. Throws `'Failed to create ledger entry'` if the insert unexpectedly returns no row.

`processWebhookCredit(db, { helcimTransactionId })`:

- Single atomic claim: `UPDATE payments SET status='completed', webhookReceivedAt=now() WHERE
helcimTransactionId = ? AND status = 'awaiting_webhook'`. If 0 rows affected (already
  processed, or never existed), returns `null` — this is the idempotency mechanism, not a
  separate check-then-act.
- Throws `'Payment has no associated user'` if the claimed payment row has a null `userId`.
- Entire operation (claim + wallet credit + ledger insert) runs inside one `db.transaction`.

`creditUserBalance(db, { userId, amount, paymentId, transactionDetails?, webhookReceivedAt?
})`:

- Atomic claim restricted to `payments.status IN ('pending', 'awaiting_webhook')` — explicitly
  **excludes** `failed`/`refunded`/`completed` payments from being re-claimed.
- `buildPaymentUpdate` conditionally merges `helcimTransactionId`, `cardType`, `cardLastFour`
  into the update payload only when present in `transactionDetails`.
- Returns `null` (not an error) when the claim affects 0 rows (already-processed, idempotent).
- Throws `'Failed to update wallet balance'` if the wallet update returns no row.

#### Charging (usage debits)

`chargeWalletForUsageRecord` (shared by `chargeForUsage` and `chargeForMediaGeneration`) — the
central wallet-priority-walk:

1. Selects all of the user's wallets ordered by `wallets.priority` ascending (i.e. `purchased`
   priority `0` before `free_tier` priority `1`).
2. Walks wallets in that order, attempting an atomic conditional debit on each (`UPDATE ...
WHERE balance >= cost`-style guard, via the wallet's own row) until one succeeds.
3. If **no** wallet has sufficient balance (including the case of zero wallets existing),
   throws `'Insufficient balance'` and — before throwing — marks the `usage_records` row
   `status: 'failed'`.
4. On success, writes a ledger entry (`entryType` implied `usage_charge` context) and marks the
   `usage_records` row `status: 'completed', completedAt: now()`.

`chargeForUsage(db, params)`:

- Validates `cost` via `validateCost`: must parse as a non-negative number; a negative or
  `NaN` string throws `` `Invalid cost: "${cost}" — expected a non-negative numeric string` ``.
- Entirely one `db.transaction`: insert `usage_records` (`type: 'llm_completion'`, `status:
'pending'`, carries `isEstimated`) → insert `llm_completions` detail row → wallet-priority
  charge → ledger entry → mark usage record completed.
- `isEstimated` defaults to `false`; set `true` only when the caller's cost came from the
  gateway-lookup-exhausted token estimate fallback, persisted onto `usage_records.is_estimated`
  for downstream dashboard/CI drift detection.
- `cachedTokens` defaults to `0` when not supplied.

`chargeForMediaGeneration(db, params)` — same wallet-walk and transaction-atomicity pattern,
but inserts a `media_generations` detail row (with optional `imageCount`, `durationMs`,
`resolution` fields spread in only when defined) instead of `llm_completions`, and does not
carry an `isEstimated` flag. Rejects negative cost with the same `'Invalid cost'` message.

---

### Helcim payment processing (`services/helcim/*`)

#### Real client (`helcim.ts`)

- `HELCIM_API_URL = 'https://api.helcim.com/v2/payment/purchase'`.
- Constructor validation, each with a distinct thrown message:
  - Empty `apiToken` → `'Helcim API token is not configured'`.
  - Whitespace-only `apiToken` → `'Helcim API token is empty'`.
  - `apiToken.length < 10` → `'Helcim API token appears invalid (too short)'`.
  - Empty `webhookVerifier` → `'Helcim webhook verifier is not configured'`.
  - Whitespace-only `webhookVerifier` → `'Helcim webhook verifier is empty'`.
- Request headers sent to Helcim: `api-token`, `Content-Type: application/json`, `accept:
application/json`, and **`idempotency-key` set to the internal `paymentId`** — Helcim-side
  idempotency is keyed off HushBox's own payment row id.
- Request body: `{ amount: parseFloat(amount), currency: 'USD', ipAddress, customerCode,
cardData: { cardToken } }`.
- Approved response: `status: 'approved'`, `transactionId` stringified from Helcim's numeric
  id (or `null`), `cardType`, `cardLastFour` = last 4 chars of Helcim's returned card number.
- A response with `response.ok && data.approvalCode` present is the sole "approved" condition;
  anything else (including a non-throwing `ok: false`) resolves to `status: 'declined'` with
  `errorMessage` from `responseMessage`, else joined Helcim `errors` messages, else the literal
  fallback string `'Payment declined'`. `debugInfo` on decline carries `{ httpStatus,
responseBody }`.
- A malformed (non-JSON) response body throws (not returns) a descriptive error via
  `safeJsonParse`: `` `Helcim payment: expected JSON but received unparseable body (HTTP
${status})` ``.
- Evidence recording: `recordServiceEvidence(..., SERVICE_NAMES.HELCIM)` fires **only** on the
  approved branch, **only** when a `config.evidence` object was supplied to the client
  constructor. Declined payments never record evidence, regardless of `isCI`. When `evidence`
  is omitted entirely, the DB is never touched even if poisoned (test asserts a throwing mock DB
  is never invoked).

#### Webhook signature verification

`verifyWebhookSignatureAsync({ webhookVerifier, payload, signatureHeader, timestamp, webhookId
})` delegates to `verifyHmacSha256Webhook` (in `@hushbox/crypto`, outside this scope).
Behaviorally evidenced in-scope:

- Signature header format is versioned: valid signatures match `/^v1,.+$/`.
- The header supports a **multi-signature, space-separated list** where only one entry needs to
  match — evidenced by test: a header of `v0,invalidSignature <validSig>` still verifies `true`.
- Invalid base64 in the signature, or an invalid verifier, both resolve to `false` (never
  throw).

#### Client selection (`getHelcimClient`, `index.ts`)

- Local dev (`isLocalDev`): always returns the mock client, **even if real
  `HELCIM_API_TOKEN`/credentials are also present** in the environment — mock always wins in
  local dev. Requires `env.API_URL` and `env.HELCIM_WEBHOOK_VERIFIER`; missing either throws
  `'API_URL and HELCIM_WEBHOOK_VERIFIER required for local dev'`. Mock client is constructed
  with `webhookUrl: ${API_URL}${WEBHOOK_PAYMENT_PATH}`.
- CI/production: requires both `env.HELCIM_API_TOKEN` and `env.HELCIM_WEBHOOK_VERIFIER`;
  missing either throws `'HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in
CI/production'`. An `evidence` config is forwarded to the real client only when supplied.

#### Mock client (`mock.ts`)

- Default canned response: `{ status: 'approved', transactionId: 'mock-txn-<uuid>', cardType:
'Visa', cardLastFour: '9990' }`.
- Every `processPayment` call generates a **fresh** `mock-txn-<uuid>` transaction id on the
  approved path — even if `setNextResponse` was used to inject a custom approved response with
  its own `transactionId`, that supplied id is discarded and replaced with a new random one
  (evidenced by test: "Transaction ID is always uniquely generated").
- `setNextResponse` persists across multiple subsequent calls (not consumed after one use) —
  evidenced by test sending two payments after one `setNextResponse(declined)` call and both
  coming back declined.
- On an approved response only, schedules a mock webhook via `scheduleMockWebhook`; declined
  responses never schedule a webhook.
- `getProcessedPayments()` returns a defensive copy (`!==` the internal array reference, but
  `toEqual` the same contents).

#### Mock webhook delivery (`mock-webhook.ts`)

- `WEBHOOK_PAYMENT_PATH = '/api/webhooks/payment'`.
- `MOCK_WEBHOOK_DELAY_MS = 1000` — default fire-and-forget delivery delay, overridable per call
  via `delayMs`.
- Webhook payload: `{ type: 'cardTransaction', id: transactionId }`.
- Signed headers sent: `webhook-signature` (HMAC-SHA256, `v1,`-prefixed per
  `signHmacSha256Webhook`), `webhook-timestamp` (Unix seconds as string), `webhook-id`
  (`mock-webhook-<uuid>`).
- Delivery failures (non-`ok` response, or thrown fetch error) are caught and logged via
  `console.error`, never thrown — this is genuinely fire-and-forget.

---

### Payments HTTP routes (`routes/billing.ts`)

All routes under `/billing` require authentication (`requireAuth()` applied to `'*'`); every
unauthenticated request returns **401**.

- `POST /billing/login-link` — generates a `crypto.randomUUID()` token, stores `{ userId }` in
  Redis under the `billingLoginToken` key with a **60-second TTL** (`ex: 60`, confirmed both by
  the registry entry and by the route test's exact `redis.set` assertion), used to bridge
  mobile-app → web billing flows. Returns `{ token }`, **200**.
- `GET /billing/balance` — returns `{ balance: currentBalance, freeAllowanceCents }` via
  `checkUserBalance`, **200**.
- `GET /billing/transactions` — paginated ledger history. Supports `type` filter (matches
  `ledgerEntries.entryType` exactly, e.g. `deposit`, `usage_charge`), cursor-based pagination
  (`cursor` = an ISO timestamp, filters `createdAt < cursor`), and offset-based pagination
  (`offset`). Fetches `limit + 1` rows to detect `hasMore`; `nextCursor` is the `createdAt` of
  the last row within the page when more rows exist, else `null`. Every response row hard-codes
  `model: null, inputCharacters: null, outputCharacters: null, deductionSource: null` — these
  fields are not populated from ledger data in this route's shape.
- `POST /billing/payments` — creates a `payments` row with `status: 'pending'`. When
  `idempotencyKey` is supplied, uses `INSERT ... ON CONFLICT (userId, idempotencyKey) DO
NOTHING`, falling back to a `SELECT` of the existing row when the insert is a no-op — a
  repeated call with the same key returns the **same** `paymentId`/`amount` (evidenced by
  test). Returns **201** with `{ paymentId, amount }`, or **500**
  `PAYMENT_CREATE_FAILED` if somehow no payment could be found or created.
- `POST /billing/payments/:id/process` — the card-charge initiation:
  - **404** `PAYMENT_NOT_FOUND` if the payment doesn't exist for this user.
  - **400** `PAYMENT_ALREADY_PROCESSED` if `payment.status !== 'pending'`.
  - **Expiration:** `ageMs = now - payment.createdAt`; if `ageMs > PAYMENT_EXPIRATION_MS`, the
    payment is atomically flipped to `status: 'failed', errorMessage: 'Payment expired'`
    (guarded by `WHERE status = 'pending'`, so a webhook that completed it first is never
    clobbered) and returns **400** `PAYMENT_EXPIRED`. The exact millisecond threshold is
    defined in `@hushbox/shared` (outside this scope); an in-scope test demonstrates a payment
    created **31 minutes** prior is treated as expired, bounding the threshold at ≤ 31 minutes.
  - Client IP resolution order for the Helcim charge: `cf-connecting-ip` header, else first
    entry of `x-forwarded-for` (comma-split), else fallback default `'0.0.0.0'` (evidenced by
    test for all three cases).
  - On Helcim `approved` with a `transactionId`: atomically flips the payment to
    `status: 'awaiting_webhook'` (guarded by `WHERE status = 'pending'`), storing
    `helcimTransactionId`, `cardType`, `cardLastFour`. Returns **200** `{ status: 'processing',
helcimTransactionId }`.
  - `approved` but `transactionId` missing → **500** `PAYMENT_MISSING_TRANSACTION_ID`.
  - If the atomic `awaiting_webhook` update affects 0 rows (raced by a concurrent process) →
    **400** `PAYMENT_ALREADY_PROCESSED`.
  - On Helcim `declined`: flips to `status: 'failed'` (guarded by `WHERE status = 'pending'`,
    so it cannot overwrite a payment already completed by a race-won webhook — evidenced by
    test "does not overwrite completed payment with failed status") with `errorMessage`, and
    returns **400** `PAYMENT_DECLINED` with `result.debugInfo` as the error details payload.
- `GET /billing/payments/:id` — status polling. **404** if not found for this user. `completed`
  status additionally returns fresh `newBalance` via `checkUserBalance`. `failed` status
  returns `errorMessage`. Otherwise returns the raw `status` (`pending` / `awaiting_webhook`).

---

### Payment webhooks (`routes/webhooks.ts`)

`POST /webhooks/payment` — **no auth middleware**; authenticated purely via HMAC signature.

- Calls `recordServiceEvidence(db, isCI, SERVICE_NAMES.HOOKDECK)` unconditionally at entry (the
  webhook relay/proxy itself, distinct from the Helcim payment-processing evidence).
- Signature headers read: `webhook-signature`, `webhook-timestamp`, `webhook-id`.
- **Production fail-closed:** if `isProduction && !HELCIM_WEBHOOK_VERIFIER`, returns **500**
  `WEBHOOK_VERIFIER_MISSING` before any body processing.
- If a verifier **and** all three signature headers are present, verifies the signature; an
  invalid signature returns **401** with error code `UNAUTHORIZED` (message field
  `INVALID_SIGNATURE`). If the verifier is configured but headers are absent, verification is
  silently skipped (non-production paths / certain local flows).
- Body is parsed via a permissive custom parser: `type` must be a string (else defaults to
  `''`), `id` is read from either `id` or `transactionId` (numeric ids get `String()`-coerced).
  Malformed (non-parseable) JSON → **400** `INVALID_JSON`.
- Only `event.type === 'cardTransaction'` triggers payment processing; every other event type
  (e.g. `refund`) is accepted and acknowledged without side effects.
- **Atomic-claim-first strategy** (`handleCardTransaction`): attempts
  `processWebhookCredit` immediately; only on a `null` result does it do a read-only
  status check to distinguish "already completed" (short-circuits **200**, no further work)
  from "not found yet."
- **Retry loop** (`processWithRetry`), engaged only when the transaction isn't found on the
  first atomic claim attempt (handles webhook arriving before the payment record exists, or
  arriving out of order):
  - `maxRetries = isCI ? 3 : 15`.
  - `retryDelay = isCI ? 500 : 1000` **milliseconds**, applied as a flat delay before each
    attempt (not exponential backoff).
  - Worst-case wall time: CI ≈ `3 × 500ms = 1.5s`; non-CI (local/production) ≈ `15 × 1000ms =
15s` (the associated route test allows up to 60s to observe the exhausted-retries 500 path).
  - Each retry attempt re-tries the atomic claim first, then falls back to a status check for
    `completed` (covers a concurrent success winning mid-retry).
  - If all retries exhaust with no success: **CI** treats this as `handled: true` (silently
    accepted, no error surfaced) whereas **non-CI** returns `{ handled: false,
shouldReturnError: true }`, which the route turns into **500** `PAYMENT_NOT_FOUND`.
- Always returns **200** `{ received: true }` except for the specific failure paths enumerated
  above (missing verifier, bad signature, invalid JSON, or exhausted non-CI retries on an
  unknown `cardTransaction`).
- Idempotency end-to-end: sending the identical webhook payload twice results in exactly one
  balance credit (evidenced by integration test comparing before/after balances).

---

### Usage analytics routes (`routes/usage.ts`)

All routes under `/usage` require authentication.

- `GET /usage/summary` — aggregates `usage_records` joined to `llm_completions` over a
  `[startDate T00:00:00.000Z, endDate T23:59:59.999Z]` inclusive UTC day range. Returns
  `{ totalSpent, messageCount, totalInputTokens, totalOutputTokens, totalCachedTokens }`, with
  an all-zero/`'0'` default shape (`EMPTY_SUMMARY`) merged under any partial DB result (covers
  the "no rows matched" case cleanly). Filters are always scoped to `usageRecords.userId` (no
  cross-user leakage, evidenced by test).
- `GET /usage/spending-over-time` — buckets by `date_trunc(granularity, createdAt)` where
  `granularity` is Zod-restricted to `'day' | 'week'`, grouped additionally by
  `llmCompletions.model`, ordered ascending by period. Supports an optional exact-match `model`
  filter.
- `GET /usage/cost-by-model` *(implied by test file, handler body not fully captured in read
  window but behavior evidenced by test)* — returns per-model total cost, descending by total.
- `GET /usage/spending-by-conversation` — groups by `usageRecords.sourceId` restricted to
  `sourceType = 'conversation'` and `status = 'completed'`, ordered descending by summed cost,
  `LIMIT query.limit`.
- `GET /usage/balance-history` — reads `ledgerEntries` joined to `wallets`, scoped to the
  requesting user's wallets, ordered ascending by `createdAt`, `LIMIT query.limit`. Returns
  `{ createdAt, balanceAfter, entryType, amount }` rows.
- `GET /usage/models` — `SELECT DISTINCT` on `llmCompletions.model` restricted to the user's
  own usage records; returns `{ models: string[] }`, empty array for a user with no usage.

---

### Conversation/member budget HTTP routes (`routes/budgets.ts`)

- `GET /:conversationId` — requires `read` privilege (guests-via-link allowed:
  `requirePrivilege('read', { allowLinkGuest: true })`). **404** `CONVERSATION_NOT_FOUND` if the
  owning conversation row can't be resolved. Response shape:
  `{ conversationBudget, totalSpent, memberBudgets, effectiveDollars, ownerTier,
ownerBalanceDollars, memberBudgetDollars }`.
  - The **conversation owner is filtered out** of the returned `memberBudgets` array — the
    owner funds all budgets and has no personal spending cap to display (evidenced by test:
    an owner row present in the raw DB result never appears in the response's
    `memberBudgets`).
  - `effectiveDollars = effectiveBudgetCents(groupRemaining) / 100`; can be negative (e.g. an
    owner balance drained below zero by outstanding reservations resolves to a negative
    `effectiveDollars`, evidenced by test producing exactly `-0.5`).
  - `memberBudgetDollars` is specifically the **requesting member's own** budget, `0` if they
    have no budget row.
- `PATCH /:conversationId/member/:memberId` — requires `admin` privilege. Body:
  `{ budgetCents: number, int, min 0 }` — negative values rejected with **400** at the
  validation layer (before reaching the handler). Delegates straight to `updateMemberBudget`.
  Returns `{ updated: true }`, **200**.
- `PATCH /:conversationId/budget` — requires `owner` privilege (stricter than the member-budget
  route's `admin`). Same `budgetCents` schema (non-negative int; `null`/missing → **400**).
  Delegates to `updateConversationBudget`. Returns `{ updated: true }`, **200**.
- Both PATCH routes return **403** `PRIVILEGE_INSUFFICIENT` when the requester's privilege is
  below the required threshold (`write` fails against `admin`-gated; `admin` fails against
  `owner`-gated), and **404** `CONVERSATION_NOT_FOUND` when the requester isn't a member at
  all.

---

### Cross-cutting numeric constants summary

| Constant | Value | Where evidenced |
|---|---|---|
| `WELCOME_CREDIT_BALANCE` | `'0.20000000'` ($0.20) | `wallet-provisioning.test.ts` exact assertion |
| `FREE_ALLOWANCE_DOLLARS` | `'0.05000000'` ($0.05) | `wallet-provisioning.test.ts` exact assertion |
| `TRIAL_MESSAGE_LIMIT` | `5` | `trial-usage.test.ts` (5th message allowed, 6th denied) |
| Paid-tier reservation cushion (`getCushionCents('paid')`) | `50` cents | `billing-reservation.test.ts` comments + overshoot-boundary assertions |
| `BILLING_MISMATCH_THRESHOLD_RATIO` | `0.5` (50%) | Literal constant in `cost-calculator.ts` |
| Redis reservation key TTL (`chatReservedBalance`, `groupMemberReserved`, `conversationReserved`) | `180` seconds | `redis-registry.ts` |
| `billingLoginToken` Redis TTL | `60` seconds | `redis-registry.ts` + route test exact assertion |
| Trial usage key nominal TTL (`trialTokenUsage`, `trialIpUsage`) | `86_400` seconds (24h) registry default; actual applied TTL is dynamic seconds-until-next-UTC-midnight | `redis-registry.ts` + `trial-usage.ts` |
| Payment expiration window | ≤ 31 minutes (exact `PAYMENT_EXPIRATION_MS` defined outside scope) | `billing.test.ts` (31-minutes-old payment rejected as expired) |
| Helcim webhook retry count | CI: `3`; non-CI: `15` | `webhooks.ts` literal |
| Helcim webhook retry delay | CI: `500` ms; non-CI: `1000` ms (flat, not exponential) | `webhooks.ts` literal |
| Mock webhook delivery delay | `1000` ms default (`MOCK_WEBHOOK_DELAY_MS`) | `mock-webhook.ts` literal |
| Helcim API token minimum length | `10` characters | `helcim.ts` literal validation |
| Wallet priority | `purchased = 0`, `free_tier = 1` | `wallet-provisioning.ts` literal |
| Wallet balance column precision | `numeric(20,8)` — 8 decimal places | Test fixtures throughout (e.g. `'110.00000000'`) |
| Budget dollar-string precision (member/conversation budgets) | 2 decimal places (`.toFixed(2)`) | `budgets.ts` literal |


---

## 07. Notifications: Email & Push

### Email client abstraction

`EmailOptions` (`legacy/apps/api/src/legacy/services/email/types.ts`): `{ to: string; subject: string; html: string; text?: string; from?: string }`. `SentEmail` is a type alias for `EmailOptions`. `EmailClient` interface exposes `sendEmail(options): Promise<void>`. `MockEmailClient extends EmailClient` and additionally exposes `getSentEmails(): SentEmail[]` and `clearSentEmails(): void`.

#### Client selection (`factory.ts`)

`getEmailClient(env)` branches on `createEnvUtilities(env)`:

- `isLocalDev || isCI` → `createConsoleEmailClient()`.
- otherwise (production) → requires `env.RESEND_API_KEY`; if absent, throws `Error('RESEND_API_KEY required in production')`. If present, returns `createResendEmailClient(env.RESEND_API_KEY)`.

#### Console client (`console.ts`)

Dev-mode client. On `sendEmail`, logs to `console.log`, in order:

1. `=== Email Sent ===`
2. `To: ${options.to}`
3. `Subject: ${options.subject}`
4. `From: ${options.from}` (only if `options.from` is set)
5. `--- HTML Content ---`
6. the full `options.html`
7. `==================`

It then runs the regex `/href="([^"]*verify-email[^"]*)"/` against the HTML. If it matches, it additionally logs:

```
🔗 Verification link (click or copy):
<the matched URL>
```

(Note: this regex looks for `verify-email` in the href, which matches the console-client's own dev-detection heuristic; it is independent of the actual verification templates, which link to `/verify?token=...` rather than `/verify-email`.) Always resolves (`Promise.resolve()`); never throws.

#### Mock client (`mock.ts`)

Test-only client. `sendEmail` pushes a shallow copy of the options into an in-memory array and resolves. `getSentEmails()` returns a shallow copy of the array (`[...sentEmails]`, so callers do not get a live reference). `clearSentEmails()` truncates the array in place (`sentEmails.length = 0`).

#### Resend client (`resend.ts`)

- `DEFAULT_FROM = 'HushBox <noreply@mail.hushbox.ai>'`
- `RESEND_API_URL = 'https://api.resend.com/emails'`
- `sendEmail` issues `POST https://api.resend.com/emails` with headers `Authorization: Bearer ${apiKey}` and `Content-Type: application/json`.
- Body JSON: `{ from: options.from ?? DEFAULT_FROM, to, subject, html, ...(text && { text }) }` — the `text` field is omitted entirely (not sent as `undefined`) when `options.text` is not provided.
- On a non-OK response, parses the body via `safeJsonParse<ResendErrorResponse>(response, 'Resend email')` and throws `Error(\`Failed to send email: ${error.message}\`)`. If the error body is not valid JSON, `safeJsonParse` produces a message of the form `Resend email: expected JSON but received unparseable body (HTTP ${status})` (confirmed by test with HTTP 502 → `Resend email: expected JSON but received unparseable body (HTTP 502)`).
- Network-level fetch rejections propagate unmodified (e.g. a raw `Error('Network error')`).

#### `index.ts` barrel

Re-exports: `EmailClient`, `EmailOptions`, `MockEmailClient`, `SentEmail` (types), `createMockEmailClient`, `createConsoleEmailClient`, `createResendEmailClient`, `getEmailClient`.

### Email template system

#### Base HTML wrapper (`templates/base.ts`)

Color tokens (`COLORS`, exported):

- `background: '#0a0a0a'`
- `card: '#171717'`
- `textPrimary: '#fafafa'`
- `textSecondary: '#a1a1aa'`
- `accent: '#ec4755'`
- `border: '#27272a'`

`wrapInBaseTemplate(content)` produces a full HTML document:

- `<meta name="color-scheme" content="dark">` — dark-mode-only email.
- `<title>HushBox</title>`
- Loads Google Font `Merriweather` at weight 700 via `https://fonts.googleapis.com/css2?family=Merriweather:wght@700&display=swap`.
- Body font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`.
- Outer table `width="600"` (`max-width: 600px`), centered, `padding: 40px 20px` on the outer cell.
- Header: wordmark `Hush` (color `textPrimary`) + `Box` (color `accent`, i.e. `#ec4755`) at `font-size: 24px; font-weight: 700; letter-spacing: 2px;` in the Merriweather/Georgia serif stack, bottom-bordered (`1px solid ${border}`), `padding: 20px 0`.
- Content card: `background-color: ${card}` (`#171717`), `border-radius: 12px`, `border: 1px solid ${border}`, inner padding `40px`; the caller-supplied `content` is interpolated directly (unescaped — templates are responsible for escaping user data before this point).
- Footer (top-bordered `1px solid ${border}`, `padding: 20px 0`, centered, `font-size: 12px`, color `textSecondary`):
  - Line 1: `© 2026 LOME-AI LLC` (rendered via `&copy;`)
  - Line 2: `Questions? hello@hushbox.ai` where `hello@hushbox.ai` is a `mailto:` link styled with `color: ${accent}` (`#ec4755`) and `text-decoration: none`.

#### Template builder (`templates/builder.ts`)

`escapeHtml(string)` replaces, in order: `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&#39;`.

`defineEmailTemplate({ schema, prepare, html, text })` returns a function `(params) => EmailContent`:

1. Validates `params` against the Zod `schema` (throws Zod's validation error on failure).
2. Runs `prepare(validated)` to produce a flat `Record<string,string>` of placeholder values.
3. Placeholder syntax is `{{key}}` (regex `/\{\{(\w+)\}\}/g`). Any placeholder in the template string with no matching key in `values` throws `Error(\`Missing template placeholder: {{${key}}}\`)`.
4. `html` output = `wrapInBaseTemplate(replacePlaceholders(html, values, escape=true))` — placeholder values ARE HTML-escaped.
5. `text` output = `replacePlaceholders(text, values, escape=false)` — placeholder values are NOT escaped (plain text).

#### Templates barrel (`templates/index.ts`)

Exports `EmailContent` type, `defineEmailTemplate`, `escapeHtml`, and the seven templates: `verificationEmail`, `passwordChangedEmail`, `twoFactorEnabledEmail`, `twoFactorDisabledEmail`, `accountLockedEmail`, `accountDeletedEmail`, `welcomeEmail`.

Common greeting logic across every template that accepts an optional `userName`: `params.userName ? \`Hi ${userName},\` : 'Hi,'`.

Every template's plain-text body opens with a bare `HushBox` line and ends with the shared footer block:

```
---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
```

---

#### Verification email (`templates/verification.ts`)

Schema: `{ userName?: string; verificationUrl: string; expiresInHours?: number }`. `DEFAULT_EXPIRES_IN_HOURS = 24`.

- Subject line used by callers: **`Verify your email address`** (both at registration and at the resend-verification-email endpoint in `opaque-auth.ts`).
- HTML heading: **`Welcome to HushBox`**.
- Greeting: `{{greeting}}` (`Hi {name},` / `Hi,`).
- Body copy: `Please verify your email address get started.` (verbatim text as written in source, including the missing "to" before "get started").
- CTA button label: **`Verify Email`**, styled as a solid button with `background-color: ${accent}` (`#ec4755`), white text, `border-radius: 8px`, `padding: 16px 32px`.
- Expiration copy interpolates `{{expiresInHours}}` (defaults to `24`) — asserted by tests to render e.g. `24 hours` or, when `expiresInHours: 48` is passed, `48 hours`.
- Link target: `{{verificationUrl}}`.

Trigger sites (`opaque-auth.ts`):
- On successful registration completion — sent together with, immediately followed by, the welcome email (both wrapped in one `try/catch` that swallows failures so a broken email send never blocks registration).
- On the resend-verification endpoint (rate-limited via `resendVerifyEmailRateLimit` + `resendVerifyIpRateLimit` dual rate limit; look-up is by `email` + `emailVerified = false`; a non-existent/non-matching user still returns `{ success: true }` — no existence leak). Both call sites build the verification URL as `${FRONTEND_URL}/verify?token=${emailToken}` and set the DB row's `emailVerifyExpires` to `Date.now() + EMAIL_VERIFY_TOKEN_EXPIRY_MS`.
- `EMAIL_VERIFY_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000` (86,400,000 ms = 24 hours) — the constant matches the template's default `expiresInHours` of 24, though the template itself is never passed `expiresInHours` explicitly by the two production call sites (only the dev preview route passes `expiresInHours: 24` explicitly).
- `emailToken` is `crypto.randomUUID()`.

#### Password changed email (`templates/password-changed.ts`)

Schema: `{ userName?: string }`.

- HTML heading: **`Password Changed`**.
- Body: `Your password was just changed. All other sessions have been signed out.`
- Secondary line: `If this was you, no action is needed.`
- Security-warning line (font-size 12px in HTML): `If you didn't change your password, your account may be compromised. Contact us immediately at security@hushbox.ai`, where `security@hushbox.ai` is a `mailto:` link styled `color: ${accent}` (`#ec4755`).

Trigger sites and subject lines (both use this same template, different subjects):
- Change-password flow (`/change-password/init` → confirm) — subject **`Your password was changed`**. Also sets Redis `passwordChangedAt` for the user (session revocation signal) before sending.
- Recovery reset flow (`/recovery/reset`) — subject **`Your password was reset`**. Also sets Redis `passwordChangedAt`.

#### Two-factor enabled email (`templates/two-factor-enabled.ts`)

Schema: `{ userName?: string }`.

- HTML heading: **`Two-Factor Authentication Enabled`**.
- Body: `Two-factor authentication has been enabled on your account. You'll need your authenticator app to sign in from now on.`
- Security line: `If you didn't enable this, contact us immediately at security@hushbox.ai` (mailto, accent color).
- Subject line at trigger site: **`Two-factor authentication enabled`**.
- Trigger: after TOTP setup completes (`totpSecretEncrypted` set + `totpEnabled = true`), immediately followed by deleting the Redis `totpPendingSetup` key for the user.

#### Two-factor disabled email (`templates/two-factor-disabled.ts`)

Schema: `{ userName?: string }`.

- HTML heading: **`Two-Factor Authentication Disabled`**.
- Body: `Two-factor authentication has been removed from your account. Your account is now protected by password only.`
- Recommendation line: `We recommend re-enabling 2FA in your account settings for maximum security.`
- Security line: `If you didn't disable this, contact us immediately at security@hushbox.ai` (mailto, accent color).
- Subject line at trigger site: **`Two-factor authentication disabled`**.
- Trigger: after TOTP disable completes (`totpSecretEncrypted = null`, `totpEnabled = false`) via `/2fa/disable/init` confirm flow.

#### Account locked email (`templates/account-locked.ts`)

Schema: `{ userName?: string; lockoutMinutes: number }` (required, no default).

- HTML heading: **`Account Temporarily Locked`**.
- Body: `Your HushBox account has been temporarily locked due to multiple failed sign-in attempts.`
- Duration line: `You can try again in {{lockoutMinutes}} minutes.`
- Closing line: `If this wasn't you, someone may be trying to access your account. We recommend changing your password when the lockout expires.`
- Subject line at trigger site: **`Your account has been temporarily locked`**.

Trigger (in `opaque-auth.ts`, on a failed-login helper): fires only when `failureResult.lockoutTriggered` is true (i.e. the account just crossed into lockout) AND a `pendingUserId` is resolvable. `lockoutDurationMinutes = Math.floor(REDIS_REGISTRY.loginLockout.ttl / 60)`. Registry values (`legacy/apps/api/src/legacy/lib/redis-registry.ts`):
- `loginUserRateLimit`: `ttl: 900` seconds, `rateLimitConfig: { maxAttempts: 5, windowSeconds: 900 }` — the failed-attempt counter that trips lockout after the 5th failure within a 900-second (15-minute) window.
- `loginLockout`: `ttl: 900` seconds — so `lockoutDurationMinutes` = 15, matching the templates' and dev-preview's example value of `lockoutMinutes: 15`.

#### Account deleted email (`templates/account-deleted.ts`)

Schema: `{}` (empty — "Generic by design — the user record is gone by the time this sends," per the source comment).

- HTML heading: **`Account Permanently Deleted`**.
- Body: `Your HushBox account has been permanently deleted. All conversations, messages, projects, and stored media have been removed from our servers.`
- Retention line: `Financial records (payments, wallet ledger entries, usage history) are retained for audit and tax purposes, with your account identifier removed.`
- Security line: `If this wasn't you, your account may have been compromised. Contact us immediately at security@hushbox.ai` (mailto, accent color).
- Subject line at trigger site: **`Your HushBox account has been deleted`**.

Trigger (`legacy/apps/api/src/legacy/services/account-deletion/delete-user.ts`, `sendDeletionEmail`): called with the recipient's raw email string captured before deletion; if `recipient` is `null` or empty, the function returns without sending (no-op). The send is wrapped in `try/catch` — a failure logs `console.warn('delete-user notification email failed', { error })` and does not fail the deletion.

#### Welcome email (`templates/welcome.ts`)

Schema: `{ userName?: string }`.

- HTML heading: **`Welcome to HushBox`**.
- Tagline (source-of-truth from the `.ts` file): `One interface. Every AI model. Private.` — Note: the co-located test file (`welcome.test.ts`) asserts a different string, `One interface. Every feature. Private.`, in four separate assertions; the actual template source under test literally renders `Every AI model.`, not `Every feature.` — this is a verbatim discrepancy between the shipped template copy and its own test file.
- Billing section heading: `How Billing Works`.
- Billing intro: `HushBox is pay-as-you-go. No subscriptions, no recurring charges. Add credits when you need them — they never expire.` (HTML uses `&mdash;`; text uses a plain hyphen `-`).
- Fee-rate sentence: `We charge a transparent {totalFeePercent} fee on AI model usage:` where `totalFeePercent = formatFeePercent(TOTAL_FEE_RATE)` (both imported from `@hushbox/shared`; exact numeric rate not defined in this scope's files).
- Fee breakdown: one row/bullet per entry in `FEE_CATEGORIES` (imported from `@hushbox/shared`), each rendered as `${formatFeePercent(category.rate)} — ${category.shortLabel}` (HTML: bullet `&#8226;` + `&mdash;`; text: `  - {percent} - {shortLabel}`). Zero-rate categories in `ALL_FEE_CATEGORIES` are excluded from `FEE_CATEGORIES` and thus never rendered (confirmed by test: no zero-rate category's `shortLabel` appears in output).
- "Adding Credits" section heading: `Adding Credits`; copy: `Visit the Billing page to add credits with any card. Your credits never expire and are ready to use across all models.`
- "For Mobile App Users" section heading: `For Mobile App Users`; copy (HTML uses curly quotes `&ldquo;`/`&rdquo;` and `&mdash;`; text uses straight quotes and a hyphen): `Tap "Manage Balance Online" to add credits through our website. We route you to the web to avoid passing high in-app processing fees on to you — keeping your costs low.`
- Subject line at trigger site: **`Welcome to HushBox`**.
- Trigger: sent immediately after the verification email on successful registration completion, inside the same `try/catch` (a failure does not block registration).
- `userName` value is HTML-escaped by the shared builder (confirmed by test: `<script>alert("xss")</script>` as `userName` renders as `&lt;script&gt;` in HTML, not raw `<script>`).

### Dev-only email preview route (`routes/dev.ts`)

`GET /emails` returns `{ templates: [...] }`, one entry per `EMAIL_TEMPLATES` array item: `{ name, label, html }`. Fixed preview entries (all rendered with sample data, `userName: 'Alice'` except where noted):

| `name` | `label` | Render params |
|---|---|---|
| `verification` | `Email Verification` | `{ verificationUrl: 'https://hushbox.ai/verify?token=sample-token-abc123', userName: 'Alice', expiresInHours: 24 }` |
| `password-changed` | `Password Changed` | `{ userName: 'Alice' }` |
| `two-factor-enabled` | `Two-Factor Enabled` | `{ userName: 'Alice' }` |
| `two-factor-disabled` | `Two-Factor Disabled` | `{ userName: 'Alice' }` |
| `account-locked` | `Account Locked` | `{ userName: 'Alice', lockoutMinutes: 15 }` |
| `welcome` | `Welcome` | `{ userName: 'Alice' }` |

(`account-deleted` is not in this preview list.)

---

### Push notification client abstraction

`PushNotification` (`legacy/apps/api/src/legacy/services/push/types.ts`): `{ tokens: string[]; title: string; body: string; data?: Record<string, string> }`. `PushResult`: `{ successCount: number; failureCount: number }`. `PushClient` interface: `send(notification): Promise<PushResult>`. `MockPushClient extends PushClient` adds `getSentNotifications(): PushNotification[]` and `clearSentNotifications(): void`.

#### Client selection (`factory.ts`)

`getPushClient(env)`:

- `isLocalDev || isCI` → `createConsolePushClient()`.
- otherwise (production) → requires both `env.FCM_PROJECT_ID` and `env.FCM_SERVICE_ACCOUNT_JSON`; if either is missing, throws `Error('FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON required in production')`. Otherwise returns `createFcmPushClient(projectId, serviceAccountJson)`.

#### Console client (`console.ts`)

Dev client. On `send`, logs to `console.log`:

1. `=== Push Notification ===`
2. `Title: ${notification.title}`
3. `Body: ${notification.body}`
4. `Tokens: ${notification.tokens.length} recipients`
5. `Data: ${JSON.stringify(notification.data)}` (only if `data` is present)
6. `========================`

Returns `{ successCount: notification.tokens.length, failureCount: 0 }` unconditionally (never actually validates tokens).

#### Mock client (`mock.ts`)

Records a shallow copy of each sent notification. `send` returns `{ successCount: notification.tokens.length, failureCount: 0 }`. `getSentNotifications()` returns a shallow array copy (distinct array identity each call, but equal contents). `clearSentNotifications()` truncates in place.

#### FCM client (`fcm.ts`)

Constants:
- `FCM_SEND_URL = 'https://fcm.googleapis.com/v1/projects'`
- `GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'`
- `FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'`
- `TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000` (5 minutes)
- `JWT_LIFETIME_SECONDS = 3600` (1 hour)

Service-account JSON parsing (`parseServiceAccountConfig`) requires a non-empty string `client_email` field and a non-empty string `private_key` field; missing either throws `Error('Service account JSON missing required field: client_email')` or `'...private_key'` respectively.

OAuth (Google service-account JWT-bearer flow), `getAccessToken`:
- Signs a JWT: header `{ alg: 'RS256', typ: 'JWT' }`; payload `{ iss: clientEmail, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + JWT_LIFETIME_SECONDS }` (so the JWT's own lifetime is exactly 3600 seconds = 1 hour).
- Private key imported as PKCS8 `RSASSA-PKCS1-v1_5` / SHA-256, non-extractable (`extractable: false`), usage `['sign']`.
- `POST https://oauth2.googleapis.com/token`, `Content-Type: application/x-www-form-urlencoded`, body `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={jwt}`.
- Non-OK response throws `Error(\`OAuth token exchange failed: HTTP ${status}\`)`.
- On success, caches `{ token: access_token, expiresAt: Date.now() + expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS }` in a **module-level variable** (`tokenCache`), described in-source as "persists across requests in Workers isolate." With a typical Google `expires_in` of 3600s, effective cache TTL ≈ 3600s − 300s = 3300s (55 minutes) — confirmed by test: token reused at +54 minutes, re-minted after +56 minutes.
- `_resetTokenCache()` is an exported test-only helper that nulls the cache.

Send (`send`):
- If `tokens.length === 0`, short-circuits to `{ successCount: 0, failureCount: 0 }` with no network calls at all (not even the OAuth token exchange).
- Otherwise fetches (or reuses cached) OAuth token once, then issues **one FCM HTTP request per token** (not a single multicast batch call) via `Promise.allSettled`, `POST ${FCM_SEND_URL}/${projectId}/messages:send`.
- Per-token request body: `{ message: { token, notification: { title, body }, ...(data !== undefined && { data }) } }`.
- Headers: `Authorization: Bearer ${accessToken}`, `Content-Type: application/json`.
- A non-OK per-token response throws inside that token's promise (`Error(\`FCM send failed for token ${token}: HTTP ${status}\`)`), which `Promise.allSettled` catches; the aggregate result increments `failureCount`. A single token's failure never aborts the batch or throws out of `send`.
- Final result: `{ successCount, failureCount }` tallied from the settled results.

#### `index.ts` barrel

Re-exports `PushClient`, `PushNotification`, `PushResult`, `MockPushClient` (types), `createMockPushClient`, `createConsolePushClient`, `createFcmPushClient`, `getPushClient`, `sendPushForNewMessage` (from `trigger.js`), `dispatchPushNotification` (from `dispatch.js`).

#### Trigger — new message push (`trigger.ts`)

`sendPushForNewMessage({ db, pushClient, conversationId, senderUserId, title, body, activeUserIds? })`:

1. Queries `conversationMembers` for rows where `conversationId` matches, `leftAt IS NULL` (still an active member), and `userId != senderUserId` (never notify the sender).
2. Builds a recipient list, excluding: members with `muted = true`, members with `userId === null`, and — if `activeUserIds` is supplied — any member whose id is in that set (these users are viewing the conversation live via WebSocket and would otherwise double-notify). Passing `undefined` for `activeUserIds` is equivalent to no filtering (confirmed by test).
3. If the recipient list is empty, returns early (no DB query for tokens, no push call).
4. Queries `deviceTokens` for `userId IN (recipientUserIds)`, collects the raw `token` strings.
5. If no tokens found, returns early (no push call).
6. Calls `pushClient.send({ tokens: tokenStrings, title, body, data: { conversationId } })` — the `data` payload always carries exactly one field, `conversationId`.
7. The entire function body is wrapped in `try/catch`; any error (query failure or `pushClient.send` rejection) is silently swallowed — the doc comment states this is deliberately "best-effort," never propagated to the caller.

#### Dispatch — fire-and-forget wrapper (`dispatch.ts`)

`dispatchPushNotification({ env, db, conversationId, senderUserId, title, body, activeUserIds, executionCtx?, deps? })`:

- `deps` defaults to the real `getPushClient` and `sendPushForNewMessage` — present only so tests can inject mocks instead of module-namespace spying.
- Wraps the async body — `getPushClient(env)` construction followed by `sendPushForNewMessage(...)` — in `fireAndForget(promise, 'send push notifications for AI response', executionCtx)`. Deliberately defers `getPushClient(env)` construction into the async body so a synchronous throw (e.g. missing FCM credentials in production) is caught by `fireAndForget`'s handling rather than escaping into the calling SSE pipeline that is actively streaming the assistant turn to the user.
- On a synchronous `getPushClient` throw, `fireAndForget` logs `console.error('[fire-and-forget] send push notifications for AI response:', error)` and `sendPushForNewMessage` is never invoked.
- If `executionCtx.waitUntil` is provided, it is invoked once (Workers execution-context extension so the fire-and-forget promise can complete after the response is returned).
- `activeUserIds` is passed straight through to `sendPushForNewMessage` unmodified.

Together, `dispatch.ts` + `trigger.ts` implement: on a new AI assistant message in a conversation, every unmuted, still-a-member, non-sender, non-actively-connected recipient with at least one registered device token receives a push with the message's `title`/`body` and `data.conversationId`, entirely best-effort and never able to fail or delay the chat response itself.


---

## 08. Internal Tooling: Linear, Roadmap, Prompt Builder

### Public roadmap route (`routes/roadmap.ts`)

- Route: `GET /api/public/roadmap` (mounted under `/api/public/roadmap` in the test app; the route itself is registered at `/`), a Hono sub-app with no authentication.
- Only `GET` is wired; a `POST` to the same path returns `404` (no route match, not a 405).
- Middleware chain: `rateLimitByIp('roadmapIpRateLimit')` runs before the handler.
- Team key is hardcoded: `const TEAM_KEY = 'HUS'`.
- On success: builds the roadmap via `buildRoadmap(linear, cache)`, sets header `Cache-Control: public, s-maxage=300` (`CDN_MAX_AGE_SECONDS = 300`), and returns the response JSON with HTTP `200`.
- On any thrown error from `buildRoadmap` (Linear unreachable, schema mismatch, etc.): returns HTTP `503` with body `createErrorResponse(ERROR_CODE_SERVICE_UNAVAILABLE)`. There is no stale-data fallback — documented in-code as "if it's down, it doesn't work."
- Client is selected per-request via `getLinearClient(c.env)`.
- Cache is a fresh `RoadmapCache` instance per request, constructed as `new RoadmapCache(redis, TEAM_KEY)`.

#### Per-IP rate limiting (`roadmapIpRateLimit`, defined in `lib/redis-registry.ts`)

- Registry key `roadmapIpRateLimit`: `ttl: 60` (seconds), `rateLimitConfig: { maxAttempts: 30, windowSeconds: 60 }` — i.e. **30 requests per 60 seconds per IP**.
- Redis key format: `` roadmap:ip:ratelimit:${ipHash} `` — the raw IP is hashed (`hashIp`) before being used as the key, never stored raw.
- Enforcement lives in the shared `rateLimitByIp` middleware (`middleware/rate-limit.ts`): on rejection, responds `429` with `createErrorResponse(ERROR_CODE_RATE_LIMITED, { retryAfterSeconds })`.
- Test-observed behavior: looping requests from a single IP eventually returns `429`; the error body's `code` is `ERROR_CODE_RATE_LIMITED` (both confirmed within 35 and within 50 iterations respectively in the two rate-limit tests).
- `rateLimitByIp` is the per-IP variant used because the roadmap route has no authenticated principal (public endpoint); it is documented as intended for unauthenticated endpoints where IP is the only identity, e.g. this route and public share lookup.

### Linear client selection (`services/linear/index.ts`)

- `getLinearClient(env)` decides mock vs. real based on `createEnvUtilities(env)`:
  - `isLocalDev || isE2E` → returns `createMockLinearClient()` (no API key needed).
  - Otherwise, requires `env.LINEAR_API_KEY_READ` to be a non-empty string; if missing or empty, throws `Error('LINEAR_API_KEY_READ required outside dev / E2E')` (fail-fast, no fallback).
  - Otherwise returns `createRealLinearClient(env.LINEAR_API_KEY_READ)`.
- Environment-mode observed test matrix:
  - No env vars at all (`{}`) → mock client (local dev default).
  - `{ E2E: 'true' }` → mock client.
  - `{ NODE_ENV: 'test' }` → **throws** (vitest/"test" mode is explicitly not treated as dev — comment: "vitest mode no longer treated as dev").
  - `{ NODE_ENV: 'production' }` with no key → throws.
  - `{ CI: 'true' }` with no key → throws.
  - `{ NODE_ENV: 'production', LINEAR_API_KEY_READ: '' }` → throws (empty string treated as absent).
  - `{ NODE_ENV: 'production', LINEAR_API_KEY_READ: 'fake-key-...' }` → returns the real client.
- The module re-exports the internal types (`LinearClient`, `LinearIssue`, `LinearIssueStateType`, `LinearProject`, `LinearProjectStateType`, `LinearRelation`, `LinearRelationKind`, `LinearRoadmapData`) and `LinearApiError` from `real.ts`.

### Internal Linear data contract (`services/linear/types.ts`)

- `LinearClient.fetchRoadmap(teamKey: string): Promise<LinearRoadmapData>` — the sole method; returns `{ projects, issues }` as two separate readonly arrays (mirroring that the real GraphQL API exposes them as separate queries).
- `LinearProjectStateType` enum: `'started' | 'planned' | 'completed' | 'paused' | 'backlog'`.
- `LinearProject` shape: `{ id, name, color, stateType }` — no description, no url, no dates.
- `LinearIssueStateType` enum: `'unstarted' | 'started' | 'completed' | 'backlog'` (note: no `'paused'` for issues, unlike projects).
- `LinearIssue` shape: `{ id, title, stateName, stateType, labelNames: readonly string[], parentId: string | null, projectId: string | null, relations: readonly LinearRelation[] }`.
- `LinearRelationKind` enum (internal type): `'blocks' | 'blocked_by'` only.
- `LinearRelation` shape: `{ type, relatedIssueId }`.
- Explicit documented exclusions from this internal type, described as deliberately never captured anywhere in the pipeline: `description`, `assignee`, `creator`, `comments`, customer data, `urls`, `dueDate`, `estimate`, `priority`, `identifier`. The comment frames the narrow type itself as "the first wall against accidental leaks," with the public `RoadmapResponseSchema` as "the second."

### Mock Linear client (`services/linear/mock.ts` + `mock-fixtures/roadmap.ts`)

- `createMockLinearClient()` returns a stateless client whose `fetchRoadmap(_teamKey)` always resolves the same fixture object regardless of the team key argument passed (verified: `HUS` and `OTHER` both yield the identical result via `toEqual`).
- Used whenever `getLinearClient` resolves to dev/E2E mode.

#### Fixture content (`MOCK_PROJECTS` / `MOCK_ISSUES`)

Four projects:

| id | name | color | stateType |
|---|---|---|---|
| `mock-proj-prompts` | Custom system prompts | `#ec4755` | `started` |
| `mock-proj-groups` | Group chats | `#3b82f6` | `started` |
| `mock-proj-voice` | Voice messages | `#8b5cf6` | `planned` |
| `mock-proj-search` | Search v2 | `#10b981` | `completed` |

Eleven issues, exact ids/titles/states/labels/hierarchy:

- **Custom system prompts** project:
  - `mock-iss-prompts-presets` — "Save and reuse prompt presets", state "In Progress"/`started`, `type:feature`, `parentId: null`.
  - `mock-iss-prompts-presets-list` — "Preset list UI", "In Progress"/`started`, `type:feature`, `parentId: mock-iss-prompts-presets`.
  - `mock-iss-prompts-presets-apply` — "Apply preset to new conversation", "Todo"/`unstarted`, `type:feature`, `parentId: mock-iss-prompts-presets`.
  - `mock-iss-prompts-fix-delete` — "Fix preset deletion not clearing local state", "In Review"/`started`, `type:bug`, `parentId: mock-iss-prompts-presets`.
- **Group chats** project:
  - `mock-iss-groups-presence` — "Group chat presence indicators", "In Progress"/`started`, `type:feature`, `parentId: null`.
  - `mock-iss-groups-typing` — "Typing indicators", "Todo"/`unstarted`, `type:feature`, `parentId: mock-iss-groups-presence`, `relations: [{ type: 'blocked_by', relatedIssueId: 'mock-iss-voice-sync' }]` (the fixture's cross-project dependency: this issue lives in `mock-proj-groups` but is blocked by an issue in `mock-proj-voice`).
  - `mock-iss-groups-avatars` — "Online member avatars", "Todo"/`unstarted`, `type:feature`, `parentId: mock-iss-groups-presence`.
  - `mock-iss-groups-invite-bug` — "Fix invite link expiry race", "Todo"/`unstarted`, `type:bug`, `parentId: null`.
- **Voice messages** project:
  - `mock-iss-voice-record` — "Voice message recording in the browser", "Todo"/`unstarted`, `type:feature`, `parentId: null`.
  - `mock-iss-voice-sync` — "Real-time sync layer rewrite", "Backlog"/`backlog`, `type:feature`, `parentId: null`.
- **Search v2** project:
  - `mock-iss-search-cmdk` — "Command palette across all conversations", "Done"/`completed`, `type:feature`, `parentId: null`.
  - `mock-iss-search-highlight` — "Highlight matched text in results", "Done"/`completed`, `type:feature`, `parentId: mock-iss-search-cmdk`.
  - `mock-iss-search-fix-unicode` — "Fix Unicode normalization in search index", "Done"/`completed`, `type:bug`, `parentId: null`.
- **Orphan issue** (no project):
  - `mock-iss-orphan-notif` — "Push notification batching", "Todo"/`unstarted`, `type:feature`, `parentId: null`, `projectId: null`, `relations: [{ type: 'blocks', relatedIssueId: 'mock-iss-groups-typing' }]`.

- Every mock id is a stable string prefixed `mock-`, chosen deliberately so tests can pin them; the normalize pipeline replaces every id with an opaque SHA-256 prefix before the response leaves the worker.
- The fixture is committed as a TypeScript constant file (not JSON) so it bundles identically across Wrangler and Vitest with no loader configuration, matching a documented convention used elsewhere (`services/ai/mock-fixtures/README.md`).
- The file carries a `/* prettier-ignore */` directive at its top.

### Real Linear GraphQL client (`services/linear/real.ts`)

- Endpoint: `const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'`.
- Page size for issues: `const ISSUE_PAGE_SIZE = 100` (interpolated into the GraphQL query as `first: 100`).
- Team lookup uses the `teams(filter: { key: { eq: $teamKey } })` connection, not the (invalid) `team(key: ...)` argument — because Linear's `Query.team` only accepts a UUID `id`, not a team key.
- **Projects query** (`PublicRoadmapProjects`):
  - Filters `projects(filter: { status: { type: { neq: "canceled" } } })` — i.e. excludes only projects whose status type is exactly `"canceled"` (uses current `status { type }` field, explicitly not the deprecated `state` scalar/field).
  - Selects `id, name, color, status { type }`.
  - If no team matches the given key, `data.teams.nodes` is empty and `fetchProjects` returns `[]` (no error).
- **Issues query** (`PublicRoadmapIssues`):
  - Filter: `team: { key: { eq: $teamKey } }`, `state: { type: { nin: ["canceled", "triage"] } }`, and a label filter `labels: { and: [ { name: { in: ["type:feature", "type:bug"] } }, { name: { nin: ["area:infra"] } } ] }` — i.e. only issues carrying a `type:feature` or `type:bug` label AND not carrying an `area:infra` label, and never in `canceled` or `triage` state.
  - Selects `id, title, state { name type }, labels(first: 20) { nodes { name } }, parent { id }, project { id }, relations(first: 20) { nodes { type relatedIssue { id } } }` — label and relation sub-lists are each capped at `first: 20`.
  - Pagination: `pageInfo { hasNextPage endCursor }`; the client loops (`do...while`) requesting subsequent pages with `after: cursor` until `hasNextPage` is `false`, accumulating all issues across pages into one array.
- Relation mapping (`mapIssueNode`): only relations of type `'blocks'` or `'blocked_by'` with a non-null `relatedIssue` are kept; any other relation `type` returned by Linear (e.g. `'related'`, `'duplicate'`) is silently dropped. The Zod `relationKindSchema` on the wire accepts all four (`'blocks' | 'blocked_by' | 'related' | 'duplicate'`), but only the first two survive into the internal `LinearRelation` type.
- `parentId`/`projectId` default to `null` when Linear returns `null` for `parent`/`project` (via `node.parent?.id ?? null` / `node.project?.id ?? null`).
- HTTP request shape: `POST` to the GraphQL URL, headers `Content-Type: application/json` and `Authorization: <apiKey>` (the raw key, **no** `Bearer` prefix), body `{ query, variables }` as JSON.
- Error handling: any non-2xx response throws `LinearApiError`:
  - `LinearApiError(status, body)` — `status: number`, `body: string` (the full untruncated raw body, preserved on the `.body` property).
  - The `Error.message` is `` Linear API responded with status ${status}: ${truncated} ``, where `truncated` is the body cut to its first 500 characters plus a trailing `…` if the body exceeds 500 characters (`body.length > 500 ? \`${body.slice(0, 500)}…\` : body`). The `.body` property always carries the untruncated original.
  - `error.name = 'LinearApiError'`.
- Response validation: both `projectsResponseSchema` and `issuesResponseSchema` are Zod schemas; a response that doesn't conform (e.g. missing expected keys) throws on `.parse()`.
- Retry/timeout policy: none observed in this file — a single `fetch` call per page, no retry wrapper.

#### Real client integration test (`real.integration.test.ts`)

- Runs only under `CiVitest` mode: gated by `shouldRun = apiKey !== undefined && apiKey.length > 0 && !isLocalDev && !isE2E`.
- If running in CI (`isCI && !isE2E`) but `LINEAR_API_KEY_READ` is missing/empty, the test file throws eagerly at module load (not a silent skip) with message: `'LINEAR_API_KEY_READ is required in CI Vitest mode. Check envConfig + GitHub Secrets.'`.
- The one test case has an explicit Vitest timeout of `30_000` ms (30 s).
- Asserts against the live `HUS` team: `data.issues.length` must be `> 0`; validates the first issue's `id` (non-empty string), `title` (string), `stateType` is one of `['unstarted', 'started', 'completed', 'backlog']`, and `labelNames` is an array.
- On success, calls `recordServiceEvidence(db, isCI, SERVICE_NAMES.LINEAR, { projectCount, issueCount })` — this is the mechanism `pnpm verify:evidence --require=linear` checks in CI to confirm the real Linear integration path actually ran.
- Requires `DATABASE_URL` to be set in CI Vitest mode; throws if missing with a message pointing at env-generation.

### Roadmap normalization (`services/roadmap/normalize.ts`)

#### Constants and enums

- `TYPE_LABEL_FEATURE = 'type:feature'`, `TYPE_LABEL_BUG = 'type:bug'` — the two labels that gate whether an issue survives into the public roadmap.
- `PublicStatus` type: `'in_progress' | 'planned' | 'shipped'` (three-way public bucket, collapsing Linear's five/four-way internal state types).
- `ORPHAN_PROJECT_ID = 'orphan'` (pre-hash synthetic id, then hashed like every other id before reaching the wire).
- `ORPHAN_PROJECT_NAME = 'Other'`.
- `ORPHAN_PROJECT_COLOR = '#71717a'`.
- The synthetic orphan project, when constructed, is always given `stateType: 'planned'` before status roll-up runs.

#### Status bucketing (`bucketStatus`)

Maps a Linear `stateType` (project or issue) onto the three public statuses:
- `'started'` → `'in_progress'`
- `'completed'` → `'shipped'`
- anything else (`'planned'`, `'paused'`, `'backlog'`, `'unstarted'`) → `'planned'`

Confirmed by test for all five `LinearProjectStateType` values: `backlog→planned`, `completed→shipped`, `started→in_progress`, `paused→planned`, `planned→planned`.

#### Status roll-up precedence (`STATUS_RANK` / `maxStatus`)

- Numeric rank: `planned: 0`, `in_progress: 1`, `shipped: 2`.
- `maxStatus(a, b)` returns `a` if `STATUS_RANK[a] >= STATUS_RANK[b]`, else `b` — i.e. ties favor the first argument (self before children in the roll-up call order), and higher rank always wins.
- Roll-up order: subtasks are leaves (never rolled themselves, since depth is clamped to ≤1 before roll-up runs) → tasks roll up from their subtask children first → projects roll up from their (already-rolled) task children second. A project's final status is `max(own bucketed status, all its top-level tasks' post-roll-up statuses, transitively all subtask statuses)`.
- Confirmed behaviors: a `planned` project with an `in_progress` task becomes `in_progress`; a `planned` project with a `completed`/`shipped` task becomes `shipped`; an `in_progress` project with a shipped task becomes `shipped`; a `shipped` (`completed`) project stays `shipped` even if a child task is `unstarted`/`planned` (max, never downgrades); a `planned`/`unstarted` task with an `in_progress` subtask becomes `in_progress`, and that in turn rolls all the way up to the project.

#### Issue type extraction (`pickIssueType`)

- Checks `labelNames.includes('type:feature')` first → returns `'feature'`.
- Else checks `labelNames.includes('type:bug')` → returns `'bug'`.
- Else returns `null`.
- Note: an issue carrying both `type:feature` and `type:bug` labels would be typed `'feature'` (feature checked first) — not separately tested, but is the implemented precedence.
- Issues where `pickIssueType` returns `null` are filtered out entirely before any node is built (defensive: the GraphQL query already filters server-side to `type:feature`/`type:bug`, but the mock fixture — and any future caller — might not).

#### Depth clamping (`findDepth1Ancestor`)

- Linear allows arbitrary nesting depth; the pipeline clamps everything deeper than 2 levels (project → task → subtask) onto the depth-1 ancestor (the top-level task under the project).
- Walks the `parentId` chain upward from an issue until it finds an ancestor whose own `parentId` is `null` (or the ancestor is not present in the id map).
- Safety bound: `safetyDepth < 64` — the walk gives up after 64 hops even if the chain (pathologically) never terminates, preventing an infinite loop; at that point it returns whatever `cursor` currently points to (`cursor?.id ?? null`).
- Test-observed: a 4-level-deep chain (`task → sub → subsub → subsubsub`) — every node from `sub` downward (i.e. everything except the top-level `task` itself) is flattened to kind `'subtask'` with `parentId` pointing directly at `task`'s hashed id. There is no `'sub-subtask'` kind; the node-kind vocabulary is exactly `'project' | 'task' | 'subtask'`.

#### Project selection (`collectProjectsToRender`)

- Only emits project nodes for projects that have at least one surviving (type-labeled) issue attached (`usedProjectIds`, built by scanning `filteredIssues`). A project with zero surviving issues is omitted entirely from the response, even if it exists in Linear.
- If any surviving issue has `projectId === null`, the synthetic orphan project (`ORPHAN_PROJECT_ID`/`'Other'`/`#71717a`) is appended to the rendered project list.

#### Id hashing (`hashLinearId`)

- Algorithm: `crypto.subtle.digest('SHA-256', utf8(linearId))`, then takes the **first 6 bytes** of the digest and hex-encodes them (each byte as 2 lowercase hex chars, zero-padded) → a **12-character lowercase hex string**.
- Deterministic (same input → same output) and different inputs (with overwhelming probability) produce different outputs — both directly tested.
- Applied uniformly to every project id and every issue id before they reach a `NormalizedNode`; the orphan project's pre-hash id (`'orphan'`) is hashed the same way as any real Linear id, not special-cased in the hash function itself (only the *selection* of the orphan id is special-cased).
- Purpose stated in-code: prevents the raw Linear id (a workspace-scoped UUID) from leaking "ticket-numbering pace" onto the public API.

#### Node construction

- Project nodes: `{ id: hash, kind: 'project', parentId: null, title: project.name, status: bucketStatus(stateType), type: null, progress: { done: 0, total: 0 } }` (progress is a placeholder `0/0` at construction time; overwritten later by `attachProgress`).
- Issue nodes: `{ id: hash, kind: isSubtask ? 'subtask' : 'task', parentId: <project or depth-1-ancestor hash>, title: issue.title, status: bucketStatus(stateType), type: pickIssueType(labelNames) }` — issue nodes carry **no `progress` field at all** (not even a placeholder); `progress` is only ever set on `'project'`-kind nodes.
- A task/subtask whose `projectId` is `null` gets `projectId ?? ORPHAN_PROJECT_ID` before hash lookup, so it parents under the orphan project's hash (or the ancestor task, if it's a subtask under a top-level task that itself has no project — in that fallback the code falls back to `projectHash` if the ancestor's own hash isn't found).

#### Progress computation (`attachProgress`)

- Counts **only top-level tasks** (`kind === 'task'`) per parent project id; subtasks are never separately counted (avoids double-weighting a task that has subtasks — the visible progress fraction matches the top-level task bullet list).
- `total` increments for every top-level task under a project.
- `done` increments only when that task's (already rolled-up) `status === 'shipped'`.
- A project with zero top-level tasks would report `{ done: 0, total: 0 }`, though the code notes this is "impossible in practice" since such a project would already have been excluded upstream by `collectProjectsToRender` (no surviving issues → no project node at all).
- A task counts as "done" in the parent's progress specifically when its rolled-up status is `shipped` — including tasks that are themselves `unstarted`/`planned` but whose subtasks are all `completed`/`shipped` (roll-up already promoted the task to `shipped` before `attachProgress` runs).

#### Response-shape guarantees (test-confirmed)

- The normalized/public response never carries an `edges` property.
- No node (of any kind) ever carries `description`, `url`, `assignee`, or `dueDate` properties.
- Every node id on the wire matches `/^[0-9a-f]{12}$/` — always 12 lowercase hex chars, never containing a literal `-` and never containing the raw Linear id text.

### Roadmap Redis cache (`services/roadmap/cache.ts`)

- `ROADMAP_SCHEMA_VERSION = 'v2'` — baked into the cache key so a future response-shape change (bump to e.g. `'v3'`) causes old-version cache entries to simply miss and refill, rather than serving a shape mismatch to an isolate running new code.
- Registry entry `roadmapCache` (in `lib/redis-registry.ts`): `ttl: 60 * 60` (**1 hour**, i.e. 3600 seconds), key builder `` roadmap:${teamKey.toLowerCase()}:${schemaVersion} `` — the team key is **always lowercased** in the key (so `RoadmapCache(redis, 'HUS')` and `RoadmapCache(redis, 'hus')` read/write the same cache entry — confirmed by test).
- `RoadmapCache.get()` returns `RoadmapResponse | null` (null on cold cache / miss).
- `RoadmapCache.set(value)` writes through `redisSet`, which (per the registry `ttl`) issues the Redis `set` with options `{ ex: 60 * 60 }` (confirmed directly in `cache.test.ts`: `expect(setCall?.options).toEqual({ ex: 60 * 60 })`).
- Distinct team keys produce distinct cache entries — `RoadmapCache(redis, 'HUS')` and `RoadmapCache(redis, 'OTHER')` never see each other's cached value.
- No stale-on-error behavior: cache is read-through only; on an upstream Linear failure the pipeline never writes anything to cache (confirmed: after a failing `buildRoadmap`, `cache.get()` still returns `null`).

### Roadmap pipeline orchestration (`services/roadmap/pipeline.ts`)

- `TEAM_KEY = 'HUS'` (duplicated constant, same value as in `routes/roadmap.ts`).
- `buildRoadmap(linear, cache)`:
  1. `cache.get()` — if non-null, returns the cached value **untouched** (no re-validation, no re-fetch from Linear at all on a warm cache — confirmed by test: `fetchRoadmap` spy is never called on a warm-cache call).
  2. On cache miss: calls `linear.fetchRoadmap(TEAM_KEY)`, pipes the result through `normalizeRoadmap`, validates/parses the result through `roadmapResponseSchema.parse({ nodes: graph.nodes })`, writes it to cache via `cache.set(response)`, and returns it.
  3. Any thrown error from `linear.fetchRoadmap` propagates uncaught out of `buildRoadmap` — the pipeline does not catch or wrap it; the route handler (`routes/roadmap.ts`) is what converts the throw into the `503` response.
- Internal types (`services/roadmap/types.ts`): `NormalizedNode = RoadmapNode` (aliased from the public shared schema type) and `NormalizedGraph = { nodes: readonly NormalizedNode[] }` — there is no separate "internal-only" node shape; the pipeline builds directly into the public wire shape.

### Prompt builder (`services/prompt/builder.ts`, `types.ts`, `modules/*`)

#### `buildPrompt(options: PromptBuilderOptions): BuiltPrompt`

- `PromptBuilderOptions`: `{ modelId: string, supportedCapabilities: ModelFeatureId[], chatHistory?: AIMessage[], customInstructions?: string }`. Note `modelId` and `chatHistory` are accepted in the options type but are **not used** anywhere inside `buildPrompt`'s body (not read/referenced) — only `supportedCapabilities` and `customInstructions` are consumed.
- `BuiltPrompt`: `{ systemPrompt: string, tools: ToolDefinition[] }`.
- Registered tool modules, in fixed order: `TOOL_MODULES = [pythonModule, javascriptModule]` (Python listed before JavaScript in the array — this ordering determines the order `tools` are flattened into the output array when both capabilities are active, i.e. `execute_python` appears before `execute_javascript`).
- Module activation: `activeModules = TOOL_MODULES.filter(m => capabilitySet.has(m.capability))` — a module's tool definitions are included in the output **only if** its declared `capability` (a `ModelFeatureId`) is present in `options.supportedCapabilities`.
- `systemPrompt` is produced entirely by the external `buildSystemPrompt(options.supportedCapabilities, options.customInstructions)` function (defined outside this scope, in the shared package) — the prompt-builder module itself contributes no system-prompt text of its own; it only decides which tool *function* definitions to expose alongside whatever `buildSystemPrompt` returns.
- `tools = activeModules.flatMap(m => m.getTools())` — each active module's `getTools()` array is concatenated in module-registration order.

#### Test-observed base system prompt behavior (via `buildSystemPrompt`, exercised through `buildPrompt`)

- With `supportedCapabilities: []`: `systemPrompt` always contains the literal substrings `'HushBox'` and `'helpful'`.
- The base prompt embeds the current date: with the system clock mocked to `2025-01-15`, `systemPrompt` contains `'2025-01-15'`.
- With no capabilities, `tools` is `[]` and the prompt contains neither `'Python Code Execution'` nor `'JavaScript Code Execution'`.
- With `['python-execution']`: prompt contains `'Python Code Execution'` and `'execute_python'`.
- With `['javascript-execution']`: prompt contains `'JavaScript Code Execution'` and `'execute_javascript'`.
- With both capabilities: prompt contains `'HushBox'`, `'Python Code Execution'`, and `'JavaScript Code Execution'` all together; `tools` has length 2, containing both `execute_python` and `execute_javascript`.
- Module sections are joined with a double newline: the combined prompt matches `/HushBox[\s\S]*\n\n[\s\S]*Python/` when the python capability is active — i.e. there is a blank line separating the base ("HushBox…") section from a capability module's section.

#### `ToolModule` interface (`types.ts`)

```ts
export interface ToolModule {
  id: string;
  capability: ModelFeatureId;
  getTools(): ToolDefinition[];
}
```

- Comment on the interface: "System prompts are handled by `buildSystemPrompt` from `@hushbox/shared`" — i.e. by design, a `ToolModule` supplies only tool definitions, never prompt text of its own.

#### JavaScript tool module (`modules/javascript.ts`) — verbatim

```ts
import type { ToolDefinition } from '../../ai/index.js';
import type { ToolModule } from '../types.js';

export const javascriptModule: ToolModule = {
  id: 'javascript-execution',
  capability: 'javascript-execution',

  getTools(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'execute_javascript',
          description: 'Execute JavaScript code in a secure sandbox',
          parameters: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'JavaScript code to execute',
              },
            },
            required: ['code'],
          },
        },
      },
    ];
  },
};
```

- Exactly one tool: `execute_javascript`. Single parameter `code` (string, required). No other parameters (no `timeout`, no `language version`, no `stdin`).
- `id` and `capability` are both the literal string `'javascript-execution'` (same `ModelFeatureId` value used in both fields).

#### Python tool module (`modules/python.ts`) — verbatim

```ts
import type { ToolDefinition } from '../../ai/index.js';
import type { ToolModule } from '../types.js';

export const pythonModule: ToolModule = {
  id: 'python-execution',
  capability: 'python-execution',

  getTools(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'execute_python',
          description: 'Execute Python code in a secure sandbox',
          parameters: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Python code to execute',
              },
            },
            required: ['code'],
          },
        },
      },
    ];
  },
};
```

- Exactly one tool: `execute_python`. Same shape as the JavaScript module: single required string parameter `code`, description `'Execute Python code in a secure sandbox'`.
- `id` and `capability` are both the literal string `'python-execution'`.
- The two modules are structurally identical templates differing only in language name/id/tool-name/description text — there is no shared per-language config beyond capability id and tool name/description.

### Cross-cutting notes

- Public roadmap node id format (`/^[0-9a-f]{12}$/`, i.e. 12 lowercase hex characters — a 6-byte SHA-256 prefix) is the single opaque identifier scheme used for both Linear project ids and Linear issue ids on the public wire; the scheme is defined once in `normalize.ts` (`hashLinearId`) and reused by every node-building step, with no parallel/duplicate hashing logic elsewhere in this scope.
- The `roadmap` route, cache, and pipeline all independently declare `TEAM_KEY = 'HUS'` as a local constant in their own files (three separate literals, not imported from one shared constant, within the scope of the files reviewed here).


---

## 09. Realtime & WebSocket

Scope: `apps/api/src/legacy/lib/broadcast.ts` (+ test), `apps/api/src/legacy/routes/websocket.ts` (+ test), `packages/realtime/src/legacy_conversation-room.ts` (+ test), plus the directly-supporting files read for context (`apps/api/src/legacy/lib/fire-and-forget.ts`, `apps/api/src/legacy/middleware/resolve-link-guest.ts`, `apps/api/src/legacy/middleware/constants.ts`).

---

### 1. WebSocket upgrade route (`GET /:conversationId`)

Hono route registered at `websocketRoute`, mounted as a `GET` with a single path param `conversationId` validated via `zValidator('param', z.object({ conversationId: z.string() }))`.

#### 1.1 Authorization: two mutually exclusive paths

**Authenticated user path** (when `c.get('user')` is set):
- Queries `conversationMembers` for a row matching `conversationId = :conversationId AND userId = :user.id AND leftAt IS NULL`, selecting only `{ id, privilege }`, `.limit(1)`.
- If no row found → `404` with error code `CONVERSATION_NOT_FOUND` (`ERROR_CODE_CONVERSATION_NOT_FOUND`).
- On success, sets `userId` query param on the internal upgrade URL to `user.id`.

**Link-guest path** (when there is no authenticated user):
- Calls `resolveLinkGuest(c)`.
- If it resolves to `null` → `401` with error code `UNAUTHORIZED` (`ERROR_CODE_UNAUTHORIZED`).
- On success: sets `userId` query param to the link's `linkId`, sets `guest=true`, and if the shared link has a `displayName`, sets `name` to it.

`resolveLinkGuest` (middleware, `apps/api/src/legacy/middleware/resolve-link-guest.ts`):
- Reads the public key from header `x-link-public-key` (constant `LINK_PUBLIC_KEY_HEADER`) with fallback to the `linkPublicKey` query string param.
- Reads `conversationId` from the route param.
- Returns `null` immediately if either the key or `conversationId` is missing.
- Looks up the active shared link via `findActiveSharedLink(db, conversationId, linkPublicKeyBytes)`; returns `null` if not found.
- Looks up a `conversationMembers` row where `linkId = sharedLink.id AND leftAt IS NULL`, `.limit(1)`; returns `null` if not found.
- On success returns `{ linkId, publicKey, displayName, member: { id, privilege, visibleFromEpoch } }`.
- A sibling function `resolveLinkGuestByKey` (used elsewhere, not on this route) resolves purely by the public-key header/query without requiring a `conversationId` route param, querying `sharedLinks` by `linkPublicKey` with `revokedAt IS NULL`, and returns `conversationId` from the link row.

#### 1.2 Durable Object binding check

- After authorization, checks `c.env.CONVERSATION_ROOM`. If the binding is absent → `503` with error code `SERVICE_UNAVAILABLE` (`ERROR_CODE_SERVICE_UNAVAILABLE`).

#### 1.3 Forwarding to the Durable Object

- Builds the internal upgrade request URL starting from the literal `http://internal/websocket` (host is a dummy — the DO ignores it; an inline lint-disable comment for `sonarjs/no-clear-text-protocols` documents this).
- Resolves the DO id via `doBinding.idFromName(conversationId)` — i.e., the DO instance is keyed 1:1 by the raw `conversationId` string (deterministic room-per-conversation addressing).
- Gets the stub via `doBinding.get(id)`.
- Forwards a new `Request` built from the upgrade URL (carrying `userId`, and for guests `guest=true` + optional `name`, as query params) with `headers: c.req.raw.headers` — i.e., the original inbound request's full header set (including `Upgrade`, `Connection`, `Sec-WebSocket-Key`) is passed through verbatim to the DO's `fetch`.
- Returns the DO's response directly (the `101` upgrade response with the client `WebSocket` object) as the route's response.

#### 1.4 Error codes summary for this route

| Condition | HTTP status | error `code` |
|---|---|---|
| No authenticated user and no resolvable link guest | 401 | `UNAUTHORIZED` |
| Authenticated user has no active (`leftAt IS NULL`) membership row for the conversation | 404 | `CONVERSATION_NOT_FOUND` |
| `CONVERSATION_ROOM` DO binding missing from `env` | 503 | `SERVICE_UNAVAILABLE` |

---

### 2. `ConversationRoom` Durable Object (`packages/realtime/src/legacy_conversation-room.ts`)

A per-conversation broadcast hub built on the Durable Object Hibernation API (`DurableObject` base class from `cloudflare:workers`). One DO instance per conversation, addressed by `idFromName(conversationId)`.

#### 2.1 Routes handled by `fetch(request)`

| Path | Method | Handler |
|---|---|---|
| `/websocket` | any (upgrade) | `handleWebSocketUpgrade(url)` |
| `/broadcast` | `POST` | `handleBroadcast(request)` |
| `/presence` | `GET` | `handlePresenceQuery()` |
| anything else | any | `404` plain-text response body `"Not found"` |

Wrong-method requests to `/broadcast` (e.g. `GET`) or `/presence` (e.g. `POST`) fall through to the same `404` "Not found" response as unknown paths — there is no distinct `405`.

#### 2.2 Idle-keepalive heartbeat (constructor)

- On construction, registers exactly one auto-response pair via `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_HEARTBEAT_PING_MESSAGE, WS_HEARTBEAT_PONG_MESSAGE))`.
- The test suite pins the exact wire values: request payload `JSON.stringify({ type: 'ping' })` (i.e. the literal string `{"type":"ping"}`), response payload `JSON.stringify({ type: 'pong' })` (i.e. `{"type":"pong"}`).
- This registration is done exactly once per DO construction, unconditionally (not per-connection) — a room with zero connected clients still registers it, and a room with zero clients can still hibernate (registration itself carries no timer).
- Because the Workers runtime answers a byte-exact `{"type":"ping"}` message with `{"type":"pong"}` automatically, without invoking `webSocketMessage` at all, the ping never triggers hibernation wake-up and is never broadcast to peers as chat traffic via the normal message-forwarding path.
- Defense in depth: `webSocketMessage` itself also explicitly early-returns (no-op) if a string message exactly equals `WS_HEARTBEAT_PING_MESSAGE`, so even if a ping somehow bypassed the runtime auto-response and reached the handler, it still would not be forwarded to any other socket.

#### 2.3 WebSocket upgrade handling (`/websocket`)

- Creates a `WebSocketPair()`; `client` is returned to the caller, `server` is accepted server-side via `this.ctx.acceptWebSocket(server)` (hibernatable).
- Parses connection parameters from the upgrade URL's query string:
  - `guest` — `isGuest = url.searchParams.get('guest') === 'true'` (any other value, including absent, is `false`).
  - `userId` — `url.searchParams.get('userId')`; included in the attached metadata only if not `null`.
  - `name` — `url.searchParams.get('name')`, mapped to `displayName`; included only if not `null`.
- Builds a `ConnectionMeta` object: `{ userId?, displayName?, isGuest, connectedAt: Date.now() }` and attaches it to the server socket via `server.serializeAttachment(meta)` (Cloudflare's mechanism for surviving hibernation — no in-memory Map is used to track connections).
- Immediately calls `broadcastPresence()` (see §2.6) to notify all sockets, including the new one, of updated membership.
- Sends a `{"type":"ready"}` JSON message directly to the newly connected server socket, *after* the presence broadcast — i.e., a fresh connection receives exactly two messages in order: (1) the `presence:update` event, then (2) `{"type":"ready"}`. This `ready` signal exists specifically so callers/tests can await confirmation that server-side registration (accept + attachment + presence broadcast) is complete, instead of relying on a fixed timeout.
- Returns `new Response(null, { status: 101, webSocket: client })` — the standard Cloudflare Workers WebSocket-upgrade response shape.

#### 2.4 Broadcast handling (`POST /broadcast`)

- Parses the JSON request body as `event` (an arbitrary `RealtimeEvent`), re-serializes it once (`JSON.stringify(event)`), and sends that exact string to every socket returned by `this.ctx.getWebSockets()` — i.e., ALL connections in the room, with no exclusion of a "sender" (unlike `webSocketMessage`, see §2.5).
- Per-socket send is wrapped in `try { ws.send(message) } catch { try { ws.close(1011, 'Send failed') } catch { /* already closed */ } }` — a send failure triggers a close with WebSocket close code `1011` and reason string `"Send failed"`; if even the close throws, it is silently swallowed (already-closed socket).
- Responds `Response.json({ sent: sockets.length })` — `sent` is the total socket count at broadcast time (not the count of successful sends; a socket that failed to send and got closed is still counted in `sent`).

#### 2.5 Client-to-server message forwarding (`webSocketMessage`, hibernation handler)

- Ignores non-string messages outright (`typeof message !== 'string'` → return); binary/`ArrayBuffer` payloads are dropped without effect. Comment states "Only typing events are sent client-to-server."
- Ignores a message that is exactly `WS_HEARTBEAT_PING_MESSAGE` (the `{"type":"ping"}` heartbeat) — defense-in-depth no-op described in §2.2.
- Otherwise, forwards the raw string message verbatim to every OTHER connected socket (`this.ctx.getWebSockets()`, excluding the sending socket by reference identity `socket === ws`) — the sender itself never receives its own message echoed back.
- Same per-socket failure handling as broadcast: `try { socket.send(message) } catch { try close(1011, 'Send failed') catch {} }`.

#### 2.6 Presence tracking

**`handlePresenceQuery()` — `GET /presence`** (used by the API Worker at push-notification dispatch time, via `getActiveConversationUserIds`, to suppress notifications for users already viewing the conversation):
- Iterates `this.ctx.getWebSockets()`, calls `ws.deserializeAttachment()` on each to get its `ConnectionMeta`.
- Collects `meta.userId` into a `Set<string>` whenever it is defined — deduplicating multiple sockets for the same user, and omitting guest sockets (which have no `userId`) and any socket whose attachment is `null`/missing.
- Responds `Response.json({ userIds: [...userIds] })` (array from the Set, order not guaranteed).

**`broadcastPresence()` — internal, invoked on connect / close / error:**
- Rebuilds the full member list from `this.ctx.getWebSockets()` by deserializing each socket's attachment.
- For each socket with a non-null attachment, emits a `PresenceMember`: `{ userId?, displayName?, isGuest, connectedAt }` (fields present only if defined on the source `ConnectionMeta` — undefined fields are omitted from the object entirely via conditional spread, not present as `undefined`).
- Sockets with no attachment (`meta` falsy) are skipped entirely — they contribute no member entry.
- Builds a `PresenceUpdateEvent`: `{ type: 'presence:update', timestamp: Date.now(), conversationId: '', members }` — note `conversationId` is hardcoded to the empty string `''` in this event (the DO does not track/attach the actual conversation id to the presence payload).
- Serializes once and sends to every currently-connected socket (`this.ctx.getWebSockets()`), including sockets with no attachment (they still receive the presence update even though they don't appear as a member in it). Send failures here are caught and silently ignored (`catch { /* dead socket, ignore */ }`) — unlike `handleBroadcast`/`webSocketMessage`, a failed presence send does NOT trigger `ws.close(1011, ...)`.

#### 2.7 Connection close / error handling (hibernation handlers)

**`webSocketClose(ws, code, reason, wasClean)`:**
- Calls `ws.close(code, reason)` to complete the WebSocket close handshake, passing through the exact `code`/`reason` the peer closed with; wrapped in try/catch (swallows "already closed" errors silently).
- Always calls `broadcastPresence()` afterward, regardless of whether `ws.close()` succeeded — remaining connected sockets get an updated `presence:update` with the closed socket no longer present.
- The `wasClean` parameter is accepted but unused (prefixed `_wasClean`).

**`webSocketError(ws, error)`:**
- Closes the errored socket with a fixed close code `1011` and reason `"WebSocket error"` (not the incoming `code`/`reason` — there are none on this handler); wrapped in try/catch, swallows failures.
- Always calls `broadcastPresence()` afterward.
- The `error` parameter is accepted but unused (prefixed `_error`).

#### 2.8 Data shapes

**`ConnectionMeta`** (per-socket attachment, `serializeAttachment`/`deserializeAttachment`):
```
{ userId?: string; displayName?: string; isGuest: boolean; connectedAt: number }
```

**`PresenceMember`** (per-member entry in a presence event — structurally identical field set to `ConnectionMeta`):
```
{ userId?: string; displayName?: string; isGuest: boolean; connectedAt: number }
```

**`PresenceUpdateEvent`** (broadcast on every connect/close/error):
```
{ type: 'presence:update'; timestamp: number; conversationId: ''; members: PresenceMember[] }
```
(`conversationId` is always the literal empty string, per §2.6.)

**`{"type":"ready"}`** — sent once to a newly-upgraded socket immediately after the initial presence broadcast (§2.3).

**Heartbeat wire messages** (auto-response pair, §2.2):
- Ping (client→server): `{"type":"ping"}`
- Pong (server→client, auto-generated by the runtime): `{"type":"pong"}`

**Event examples observed from tests forwarded verbatim through `/broadcast` and `webSocketMessage`:**
- `{ type: 'typing:start', timestamp, conversationId, userId }`
- `{ type: 'typing:stop', timestamp, conversationId, userId }`
- `message:new` events (used in the API-side broadcast test) carrying `{ type: 'message:new', messageId, conversationId, senderType, senderId }` shaped fields via `createEvent('message:new', {...})`.

Both the DO's `/broadcast` handler and `webSocketMessage` treat the event/message payload opaquely — they never parse or validate its `type` or fields beyond the ping-string equality check; any JSON-stringifiable payload the API Worker sends is relayed as-is.

#### 2.9 WebSocket close codes used

| Code | Reason string | Emitted by | When |
|---|---|---|---|
| `1011` | `"Send failed"` | `handleBroadcast`, `webSocketMessage` | A `ws.send()` call throws (dead/closed socket) |
| `1011` | `"WebSocket error"` | `webSocketError` | The hibernation API reports a socket error |
| *(pass-through)* | *(pass-through)* | `webSocketClose` | Peer-initiated close; DO echoes the incoming `code`/`reason` back into `ws.close(code, reason)` to complete the handshake |

---

### 3. Broadcast helper library (`apps/api/src/legacy/lib/broadcast.ts`)

The API Worker's (non-DO) entry points for talking to a `ConversationRoom` DO.

#### 3.1 `broadcastToRoom(env, conversationId, event)`

- No-ops immediately, returning `{ sent: 0 }`, if `env?.CONVERSATION_ROOM` is falsy (covers both an undefined `env` and an `env` missing the binding — documented as the expected behavior for tests that don't set `c.env`).
- Otherwise resolves the DO id via `env.CONVERSATION_ROOM.idFromName(conversationId)`, gets the stub, and issues `stub.fetch(new Request('http://internal/broadcast', { method: 'POST', body: JSON.stringify(event) }))` (same dummy-host pattern as the websocket route, same lint-disable annotation).
- Parses and returns the DO's JSON response as `{ sent: number }`.
- Any rejection from `stub.fetch` (e.g., DO unavailable) propagates as a thrown/rejected promise — this function does not swallow errors itself.

#### 3.2 `broadcastFireAndForget(env, conversationId, event, executionCtx?)`

- Thin wrapper: calls `fireAndForget(broadcastToRoom(...), \`broadcast ${event.type} to ${conversationId}\`, executionCtx)`.
- Never throws synchronously regardless of whether the underlying broadcast succeeds or fails.
- On failure, `fireAndForget` logs via `console.error('[fire-and-forget] ' + errorContext + ':', error)` — for this call site the logged prefix is exactly `[fire-and-forget] broadcast ${event.type} to ${conversationId}:`.
- On success, nothing is logged.
- If `executionCtx` (a Cloudflare Workers execution context exposing `waitUntil`) is supplied, the handled promise is registered via `executionCtx.waitUntil(handled)` so the isolate is kept alive until the broadcast (and its error handling) completes; a throw from `waitUntil` itself (e.g., running outside the Workers runtime) is caught and ignored.

#### 3.3 `getActiveConversationUserIds(env, conversationId)`

Used at push-notification dispatch time to determine which users are already viewing a conversation via an open WebSocket, so as to suppress redundant push notifications for them (active-viewer suppression). Documented as best-effort: any failure path returns an empty `Set`, which is deliberately treated as "notify everyone" — the pre-feature fallback behavior, not a correctness requirement.

- Returns `new Set()` immediately if `env?.CONVERSATION_ROOM` is falsy.
- Otherwise: resolves the DO id via `idFromName(conversationId)`, gets the stub, issues `stub.fetch(new Request('http://internal/presence', { method: 'GET' }))`, all wrapped in try/catch.
- If the response is not `.ok`, logs `console.error(\`[presence:do-error] ${conversationId}: status ${response.status}\`)` and returns `new Set()`.
- If the fetch itself throws/rejects, logs `console.error(\`[presence:do-error] ${conversationId}:\`, error)` and returns `new Set()`.
- On success, parses `{ userIds: string[] }` from the JSON body and returns `new Set(body.userIds)`.

#### 3.4 Fire-and-forget utility (`apps/api/src/legacy/lib/fire-and-forget.ts`)

General-purpose helper used by broadcast (and documented as intended also for push notifications and background cleanup tasks):
- Wraps a promise in an IIFE that awaits it and on rejection logs `console.error(\`[fire-and-forget] ${errorContext}:\`, error)` — swallowing the error (never rethrows).
- If `executionCtx` is provided, registers the wrapped promise with `executionCtx.waitUntil(handled)`, itself wrapped in try/catch to tolerate `waitUntil` being unavailable outside the Workers runtime.
- The function returns `void` synchronously; callers never await it.

---

### 4. DO addressing / routing summary

- Every conversation maps to exactly one `ConversationRoom` DO instance, addressed via `namespace.idFromName(conversationId)` — the same derivation is used independently by the websocket upgrade route, `broadcastToRoom`, and `getActiveConversationUserIds`, so all three always resolve to the same DO instance for a given `conversationId`.
- All three entry points construct their internal request against the literal host `http://internal` and dispatch to a distinct path: `/websocket` (upgrade), `/broadcast` (`POST`), `/presence` (`GET`).


---

## 10. DB Schema, Factories & Zod

### Scope note: no raw Drizzle schema present in `legacy/`

Every factory and Zod file in this scope imports its row type from a path like
`../schema/users`, `../schema/conversations`, `../schema/legacy_projects`, etc., and
`legacy_client.ts` does `import * as schema from './schema/index'`. No `schema/` directory
exists anywhere under `legacy/packages/db/src` (confirmed by a recursive search of the
`legacy/` tree — zero directories named `schema`), and no `helpers.ts`/`helpers.js` file
(imported by several factories as `./helpers.js` for a `placeholderBytes()` helper) exists
either. Only the Fishery factories, the `legacy-zod` Zod-schema layer, `legacy_client.ts`,
and `legacy_account-deletion-events.ts` were carried into the quarantine tree — the raw
Drizzle table/column/enum definitions were not. Everything below about column existence,
nullability, defaults, and enum membership is therefore reconstructed from three kinds of
evidence: (a) the Fishery factory default values, (b) the `drizzle-zod`-derived
`insert*Schema`/`select*Schema` validators and their accompanying tests (which assert
specific accept/reject cases), and (c) two integration test files that exercise the real
database (`legacy_factories.integration.test.ts` and
`legacy_account-deletion-events.test.ts`), which pin actual Postgres behavior (CHECK
constraints, unique indexes, generated column defaults like `uuidv7()`).

---

### `users`

**Factory** (`legacy_user.ts`, `userFactory`):

| Field | Default value |
| --- | --- |
| `id` | `crypto.randomUUID()` |
| `email` | `faker.internet.email()` |
| `username` | `faker.internet.username()`, lowercased, every non-`[a-z0-9_]` char replaced with `_`, a leading non-`[a-z]` char replaced with `u`, sliced to 20 chars max, then `padEnd(3, '_')` |
| `createdAt` / `updatedAt` | `faker.date.recent()` (independently generated, may differ) |
| `emailVerified` | `false` |
| `emailVerifyToken` | `null` |
| `emailVerifyExpires` | `null` |
| `opaqueRegistration` | `placeholderBytes(64)` |
| `totpSecretEncrypted` | `null` |
| `totpEnabled` | `false` |
| `hasAcknowledgedPhrase` | `false` |
| `customInstructionsEncrypted` | `null` |
| `publicKey` | `placeholderBytes(32)` |
| `passwordWrappedPrivateKey` | `placeholderBytes(48)` |
| `recoveryWrappedPrivateKey` | `placeholderBytes(48)` |
| `accessibilityPreferences` | `ACCESSIBILITY_PREFERENCES_DEFAULTS` (imported from `@hushbox/shared`) |
| `accessibilityPreferencesUpdatedAt` | `faker.date.recent()` |

Test-pinned facts (`legacy_user.test.ts`): `id`/all UUID fields match `/^[0-9a-f-]{36}$/i`;
`email` contains `@`; the four bytea fields (`opaqueRegistration`, `publicKey`,
`passwordWrappedPrivateKey`, `recoveryWrappedPrivateKey`) are `Uint8Array` with
`publicKey.length === 32` exactly and the other three `> 0`; `buildList(3)` produces 3
unique ids.

**Zod** (`legacy-zod/index.ts`): `selectUserSchema` overrides `opaqueRegistration`,
`publicKey`, `passwordWrappedPrivateKey`, `recoveryWrappedPrivateKey` to
`z.instanceof(Uint8Array)` (non-nullable) — confirmed by test: passing `null` for any of
these four fields fails `safeParse`. `email` is nullable at the select layer (test: `email:
null` on an otherwise-complete row succeeds) and optional/omittable at the insert layer
(test: `insertUserSchema.safeParse({ username: 'test_user' })` succeeds with no `email`).
`username` is required on insert (test: omitting it fails). `insertUserSchema` has no
column overrides — plain `createInsertSchema(users)`.

---

### `wallets`

**Factory** (`legacy_wallet.ts`, `walletFactory`):

| Field | Default value |
| --- | --- |
| `id` | `crypto.randomUUID()` |
| `userId` | `crypto.randomUUID()` (test confirms it can be overridden to `null`) |
| `type` | `faker.helpers.arrayElement(['purchased', 'free_tier'])` |
| `balance` | `faker.number.float({ min: 0, max: 500, fractionDigits: 8 }).toFixed(8)` (numeric string, 8 decimal places) |
| `priority` | `faker.helpers.arrayElement([0, 1])` |
| `createdAt` | `faker.date.recent()` |

Test-pinned: `type` is one of `['purchased', 'free_tier']`; `balance` parses as a number.

**Zod**: `selectWalletSchema`/`insertWalletSchema` are plain `createSelectSchema`/
`createInsertSchema(wallets)` with no field overrides — `type` and `priority` are not
constrained to an enum at the Zod layer in the observed tests: `insertWalletSchema`
round-trip tests use `type: 'credit'` and `type: 'promotional'` (values the factory never
produces) and both succeed, alongside the factory's own `'purchased'`/`'free_tier'`. `type`
and `priority` are both required on insert (tests: omitting either fails). `userId` is
nullable at select (test: `userId: null` with `type: 'promotional', balance: '0'`
succeeds).

---

### `ledger_entries`

**Factory** (`legacy_ledger-entry.ts`, `ledgerEntryFactory`):

`entryType` defaults to `faker.helpers.arrayElement([...])` over exactly six values:
`'deposit'`, `'usage_charge'`, `'refund'`, `'adjustment'`, `'renewal'`, `'welcome_credit'`.

A fixed map (`ENTRY_TYPE_FK_MAP`) determines which single FK column is populated with a
fresh random UUID (the other two stay `null`), defaulting to `'sourceWalletId'` for any
unmapped type (unreachable in practice — all six enum values are mapped):

| `entryType` | FK populated |
| --- | --- |
| `deposit` | `paymentId` |
| `usage_charge` | `usageRecordId` |
| `refund` | `paymentId` |
| `adjustment` | `sourceWalletId` |
| `renewal` | `sourceWalletId` |
| `welcome_credit` | `sourceWalletId` |

Other fields: `id` / `walletId` = `crypto.randomUUID()`; `amount` =
`faker.number.float({ min: -100, max: 500, fractionDigits: 8 }).toFixed(8)` (can be
negative); `balanceAfter` = `faker.number.float({ min: 0, max: 1000, fractionDigits: 8
}).toFixed(8)`; `createdAt` = `faker.date.recent()`.

Test-pinned (`legacy_ledger-entry.test.ts`): exactly one of the three FK fields is non-null
per built row; `deposit` → `paymentId` set, others null; `usage_charge` → `usageRecordId`
set, others null; `renewal` → `sourceWalletId` set, others null; `amount`/`balanceAfter`
parse as numbers.

**Zod**: plain `createSelectSchema`/`createInsertSchema(ledgerEntries)`, no overrides.
`walletId` and `entryType` required on insert (tests confirm both rejections). No enum
restriction observed on `entryType` at the Zod layer — test round-trips use `'credit'` and
`'usage'` as accepted `entryType` values, neither of which is in the factory's six-value
set.

---

### `usage_records`

**Factory** (`legacy_usage-record.ts`, `usageRecordFactory`):

| Field | Default value |
| --- | --- |
| `id` | `crypto.randomUUID()` |
| `userId` | `crypto.randomUUID()` (overridable to `null`) |
| `type` | hardcoded literal `'llm_completion'` (not randomized) |
| `status` | `params.status ?? 'completed'` |
| `cost` | `faker.number.float({ min: 0.001, max: 5, fractionDigits: 8 }).toFixed(8)` |
| `isEstimated` | `false` |
| `sourceType` | hardcoded literal `'message'` |
| `sourceId` | `crypto.randomUUID()` |
| `createdAt` | `faker.date.recent()` (`now`) |
| `completedAt` | `status === 'completed' ? faker.date.recent({ refDate: now }) : null` |

Test-pinned status set: `['pending', 'completed', 'failed']`. `completedAt` is a `Date`
when `status: 'completed'`, `null` when `status: 'pending'`.

**Zod**: plain `createSelectSchema`/`createInsertSchema(usageRecords)`. `cost` and
`sourceType` required on insert (tests confirm rejections when omitted). `userId` nullable
at select layer.

---

### `llm_completions`

**Factory** (`legacy_llm-completion.ts`, `llmCompletionFactory`):

`MODELS` pool: `'openai/gpt-4o'`, `'openai/gpt-4o-mini'`, `'anthropic/claude-3.5-sonnet'`,
`'anthropic/claude-3-haiku'`, `'google/gemini-pro-1.5'`,
`'meta-llama/llama-3.1-70b-instruct'`. `PROVIDERS` fallback pool (used only if a chosen
model string has no `/`, which none of the above do): `'openai'`, `'anthropic'`,
`'google'`, `'meta-llama'`.

`model` = random pick from `MODELS`; `provider` = `model.split('/')[0]` (i.e. always
derived from the model string in practice). `id` / `usageRecordId` = random UUID;
`inputTokens` = `faker.number.int({ min: 10, max: 10_000 })`; `outputTokens` =
`faker.number.int({ min: 10, max: 5000 })`; `cachedTokens` =
`faker.helpers.arrayElement([0, 0, 0, faker.number.int({ min: 10, max: 1000 })])` — three
of the four array slots are the literal `0`, and the fourth is a pre-computed random int
in `[10, 1000]`, so `cachedTokens` is `0` on roughly 3 of 4 builds and a random 10–1000
value on the remaining 1 of 4 (the random int is evaluated on every build regardless of
whether that slot is the one picked, since the array is constructed eagerly).

Test-pinned: `inputTokens > 0`, `outputTokens > 0`, `cachedTokens >= 0`; `model` contains
`/`.

**Zod**: plain schemas, no overrides. `model` and `inputTokens` required on insert (tests
confirm rejections when omitted).

---

### `media_generations`

**Factory** (`legacy_media-generation.ts`, `mediaGenerationFactory`):

`mediaType` = `params.mediaType ?? faker.helpers.arrayElement(['image', 'video', 'audio'])`.

Model pools: `IMAGE_MODELS` = `'google/imagen-4'`, `'black-forest-labs/flux-1.1-pro'`;
`VIDEO_MODELS` = `'google/veo-3.1'`, `'bytedance/seedance-1-5-pro'`; `AUDIO_MODELS` =
`'openai/tts-1'`, `'elevenlabs/eleven-turbo'`.

Per-type field population:

- **image**: `model` random from `IMAGE_MODELS`; `imageCount = 1`; `durationMs = null`;
  `resolution = null`.
- **video**: `model` random from `VIDEO_MODELS`; `durationMs =
  faker.number.int({ min: 1000, max: 8000 })`; `resolution =
  faker.helpers.arrayElement(['720p', '1080p'])`; `imageCount = null`.
- **audio**: `model` random from `AUDIO_MODELS`; `durationMs =
  faker.number.int({ min: 1000, max: 60_000 })`; `imageCount = null`; `resolution = null`.

`provider` = `model.split('/')[0] ?? 'unknown'`. `id` / `usageRecordId` = random UUID.

Test-pinned (`legacy_media-generation.test.ts`): image → `imageCount: 1`, `durationMs:
null`, `resolution: null`; video → `imageCount: null`, `durationMs` a number, `resolution`
one of `['720p', '1080p']`; audio → `imageCount: null`, `durationMs` a number, `resolution:
null`.

**Integration test** (`legacy_factories.integration.test.ts`): a `mediaGenerationFactory`
row round-trips against a real `usage_records` FK (`usageRecordId`); confirms `imageCount:
1`, `durationMs: null`, `resolution: null` survive a DB round-trip for an image row built
with `usageRecordFactory.build({ ..., type: 'image_generation' })`.

**Zod**: plain schemas. `model` and `mediaType` required on insert.

---

### `payments`

**Factory** (`legacy_payment.ts`, `paymentFactory`):

`status` = `params.status ?? 'completed'`; `now` = `faker.date.recent()`; `isCompleted =
status === 'completed'`.

| Field | Default value |
| --- | --- |
| `id` | `crypto.randomUUID()` |
| `userId` | `crypto.randomUUID()` (overridable to `null`) |
| `amount` | `faker.number.float({ min: 10, max: 500, fractionDigits: 8 }).toFixed(8)` |
| `status` | as above |
| `idempotencyKey` | `null` (factory never sets a non-null default) |
| `helcimTransactionId` | `isCompleted ? faker.string.uuid() : null` |
| `cardType` | `isCompleted ? random from CARD_TYPES : null` |
| `cardLastFour` | `isCompleted ? faker.string.numeric(4) : null` |
| `errorMessage` | `status === 'failed' ? faker.lorem.sentence() : null` |
| `createdAt` / `updatedAt` | both `= now` |
| `webhookReceivedAt` | `isCompleted ? faker.date.recent({ refDate: now }) : null` |

`CARD_TYPES` pool: `'Visa'`, `'Mastercard'`, `'Amex'`, `'Discover'`.

Test-pinned status enum (`legacy_payment.test.ts`, `validStatuses`): `'pending'`,
`'awaiting_webhook'`, `'completed'`, `'failed'`, `'refunded'`. `cardLastFour` matches
`/^\d{4}$/` when completed. A `status: 'pending'` build has `helcimTransactionId`,
`cardType`, `cardLastFour`, `webhookReceivedAt` all `null`.

**Zod**: plain schemas. `amount` required on insert (test confirms rejection when
omitted); `userId` optional/nullable.

---

### `conversations`

**Factory** (`legacy_conversation.ts`, `conversationFactory`):

| Field | Default value |
| --- | --- |
| `id` / `userId` | `crypto.randomUUID()` |
| `title` | `placeholderBytes(32)` (encrypted title, `Uint8Array`) |
| `projectId` | `null` |
| `titleEpochNumber` | `1` |
| `currentEpoch` | `1` |
| `nextSequence` | `1` |
| `conversationBudget` | `'0.00'` |
| `createdAt` / `updatedAt` | `faker.date.recent()` |

Test-pinned (`legacy_conversation.test.ts`): `title` is a `Uint8Array`; the three
epoch/sequence fields all default to `1`; `projectId` defaults `null`;
`conversationBudget` defaults `'0.00'` exactly.

**Zod**: `selectConversationSchema`/`insertConversationSchema` override `title` to
`z.instanceof(Uint8Array)`. `userId` and `title` both required on insert (tests confirm
both rejections when omitted).

---

### `conversation_members`

**Factory** (`legacy_conversation-member.ts`, `conversationMemberFactory`):

| Field | Default value |
| --- | --- |
| `id` / `conversationId` / `userId` | `crypto.randomUUID()` |
| `linkId` | `null` |
| `privilege` | `faker.helpers.arrayElement(['read', 'write', 'admin', 'owner'])` |
| `visibleFromEpoch` | `1` |
| `joinedAt` / `acceptedAt` | `faker.date.recent()` (independently generated) |
| `leftAt` | `null` |
| `muted` / `pinned` | `false` |
| `invitedByUserId` | `null` |

Test-pinned: `privilege` ∈ `['read', 'write', 'admin', 'owner']`; `visibleFromEpoch >= 1`;
`leftAt` null by default; `acceptedAt` a `Date` by default (i.e. the factory models an
already-accepted member); `invitedByUserId` null by default. Overrides tested:
`acceptedAt: null` + `invitedByUserId: <uuid>` (unaccepted/invited member);
`userId: null` + `linkId: <uuid>` (link-based member, no user).

**Zod**: plain schemas. `conversationId` and `visibleFromEpoch` required on insert. A
member row may key on either `userId` or `linkId` (both accepted independently in insert
tests).

---

### `conversation_forks`

**Factory** (`legacy_conversation-fork.ts`, `conversationForkFactory`) — no dedicated test
file in scope:

| Field | Default value |
| --- | --- |
| `id` / `conversationId` | `crypto.randomUUID()` |
| `name` | `faker.helpers.arrayElement(['Main', 'Fork 1', 'Fork 2'])` |
| `tipMessageId` | `null` |
| `createdAt` | `faker.date.recent()` |

No Zod schema for this table appears in `legacy-zod/index.ts` (it exports schemas for
`conversationMembers`, `conversationSpending`, `conversations`, `epochMembers`, `epochs`,
etc., but never `conversationForks`).

---

### `epochs`

**Factory** (`legacy_epoch.ts`, `epochFactory`):

`epochNumber` = `params.epochNumber ?? 1`. `chainLink` = `epochNumber > 1 ?
placeholderBytes(64) : null` — i.e. epoch 1 never has a chain link, every later epoch gets
a 64-byte placeholder chain link.

| Field | Default value |
| --- | --- |
| `id` / `conversationId` | `crypto.randomUUID()` |
| `epochPublicKey` | `placeholderBytes(32)` |
| `confirmationHash` | `placeholderBytes(32)` |
| `createdAt` | `faker.date.recent()` |

Test-pinned: `epochPublicKey.length === 32`, `confirmationHash.length === 32`;
`epochNumber: 1` build → `chainLink: null`.

**Zod**: `epochPublicKey`, `confirmationHash` overridden to `z.instanceof(Uint8Array)`
(non-nullable); `chainLink` overridden to `z.instanceof(Uint8Array).nullable()`.
`epochPublicKey` and `confirmationHash` both required on insert.

---

### `epoch_members`

**Factory** (`legacy_epoch-member.ts`, `epochMemberFactory`):

| Field | Default value |
| --- | --- |
| `id` / `epochId` | `crypto.randomUUID()` |
| `memberPublicKey` | `placeholderBytes(32)` |
| `wrap` | `placeholderBytes(48)` |
| `visibleFromEpoch` | `1` |
| `createdAt` | `faker.date.recent()` |

Test-pinned: `memberPublicKey.length === 32`; `wrap.length > 0`.

**Zod**: `memberPublicKey`, `wrap` overridden to `z.instanceof(Uint8Array)`. Both required
on insert (tests confirm rejection when either is missing). The Zod insert/select tests for
this table exercise a `privilege: 'write'` field (e.g.
`insertEpochMemberSchema.safeParse({ epochId, memberPublicKey, wrap, privilege: 'write',
visibleFromEpoch: 1 })` succeeds) even though `epochMemberFactory`'s own defaults never set
a `privilege` field — the factory omits it entirely rather than defaulting it.

---

### `messages`

**Factory** (`legacy_message.ts`, `messageFactory`):

A module constant `WRAPPED_CONTENT_KEY_BYTES = 81` is commented as "Approximate
ECIES-wrapped content key size (1 version + 32 ephemeral pub + 32 content key + 16 tag)."

`senderType` = `params.senderType ?? faker.helpers.arrayElement(['user', 'ai'])`.

| Field | Default value |
| --- | --- |
| `id` / `conversationId` / `senderId` | `crypto.randomUUID()` (senderId always a UUID by default, even for `senderType: 'ai'` builds — the factory does not null it out) |
| `wrappedContentKey` | `placeholderBytes(81)` |
| `epochNumber` | `1` |
| `sequenceNumber` | `faker.number.int({ min: 1, max: 1000 })` |
| `parentMessageId` | `null` |
| `batchId` | `crypto.randomUUID()` |
| `createdAt` | `faker.date.recent()` |

Test-pinned: `senderType` ∈ `['user', 'ai']`; `wrappedContentKey.length > 0`;
`epochNumber === 1`; `sequenceNumber >= 1`; `senderId` matches UUID pattern;
`parentMessageId` null by default.

**Zod**: `wrappedContentKey` overridden to `z.instanceof(Uint8Array)`, required on insert.
`senderType` required on insert. Select-schema tests confirm an "AI message" row is valid
with `senderId: null` — so while the factory always fills `senderId`, the schema itself
permits a null `senderId` for AI-authored messages.

---

### `content_items`

**Factory** (`legacy_content-item.ts`):

Base `contentItemFactory` (a user-authored text item):

| Field | Default value |
| --- | --- |
| `id` / `messageId` | `crypto.randomUUID()` |
| `contentType` | `'text'` |
| `position` | `0` |
| `encryptedBlob` | `placeholderBytes(128)` |
| `storageKey` / `mimeType` / `sizeBytes` / `width` / `height` / `durationMs` / `modelName` / `cost` | `null` |
| `isSmartModel` | `false` |
| `createdAt` | `faker.date.recent()` |

`MEDIA_MODELS` pool (used by `aiTextContentItemFactory`, despite the name, for a *text*
item's `modelName`): `'google/imagen-4'`, `'google/veo-3.1'`,
`'anthropic/claude-sonnet-4.6'`.

- **`aiTextContentItemFactory`** = base `.params({ modelName: random from MEDIA_MODELS,
  cost: faker.number.float({ min: 0.0001, max: 0.05 }).toFixed(8) })` — still
  `contentType: 'text'`, still an inline `encryptedBlob`, `storageKey` stays `null`.
- **`imageContentItemFactory`** = base `.params({ contentType: 'image', encryptedBlob:
  null, storageKey: `media/${uuid}/${uuid}/${uuid}.enc`, mimeType: 'image/png', sizeBytes:
  faker.number.int({ min: 50_000, max: 5_000_000 }), width: 1024, height: 1024,
  durationMs: null, modelName: 'google/imagen-4', cost: faker.number.float({ min: 0.001,
  max: 0.1 }).toFixed(8) })`.
- **`audioContentItemFactory`** = base `.params({ contentType: 'audio', encryptedBlob:
  null, storageKey: <uuid template>, mimeType: 'audio/mpeg', sizeBytes:
  faker.number.int({ min: 10_000, max: 1_000_000 }), width: null, height: null,
  durationMs: faker.number.int({ min: 1000, max: 60_000 }), modelName: 'openai/tts-1',
  cost: faker.number.float({ min: 0.001, max: 0.05 }).toFixed(8) })`.
- **`videoContentItemFactory`** = base `.params({ contentType: 'video', encryptedBlob:
  null, storageKey: <uuid template>, mimeType: 'video/mp4', sizeBytes:
  faker.number.int({ min: 500_000, max: 50_000_000 }), width: 1920, height: 1080,
  durationMs: faker.number.int({ min: 1000, max: 8000 }), modelName: 'google/veo-3.1',
  cost: faker.number.float({ min: 0.05, max: 1 }).toFixed(8) })`.

Because Fishery's `.params()` argument object is evaluated once at module-definition time
(not per `.build()` call), the three media factories' template-literal `storageKey`
(`media/${crypto.randomUUID()}/...`) is fixed at import time — every default-built row
from, say, `imageContentItemFactory` shares the *same* `storageKey` unless the caller
overrides it per build. The integration test file works around this explicitly with its
own `uniqueStorageKey()` helper, whose comment states this is to avoid "the module-level
`crypto.randomUUID()` collision in `imageContentItemFactory.params`."

Test-pinned (`legacy_content-item.test.ts`): text default has `encryptedBlob` a
`Uint8Array`, `storageKey`/`mimeType`/`sizeBytes`/`width`/`height`/`durationMs`/
`modelName`/`cost` all `null`, `isSmartModel: false`; image has `encryptedBlob: null`,
`mimeType: 'image/png'`, `width: 1024`, `height: 1024`, `durationMs: null`; audio has
`mimeType: 'audio/mpeg'`, `width`/`height` null, `durationMs` a number; video has
`mimeType: 'video/mp4'`, `width: 1920`, `height: 1080`, `durationMs` a number.

**Zod** (`legacy-zod/index.ts`) — modeled as a hand-written discriminated union rather than
a plain `drizzle-zod` schema, with the comment: "Mirrors the
`content_items_type_consistency` CHECK constraint at the Zod boundary as a discriminated
union. Validation rejects mixed text + media payloads BEFORE they reach Postgres, so the
constraint stays a defense in depth instead of the only line of defense."

Shared insert base fields: `id?: string`, `messageId: string`, `position: number.int()
.nonnegative().default(0)`, `modelName?: string | null`, `cost?: string | null`,
`isSmartModel?: boolean`, `createdAt?: Date`.

- **Text branch** (`contentType: z.literal('text')`): `encryptedBlob:
  z.instanceof(Uint8Array)` (required); `storageKey`/`mimeType`/`sizeBytes`/`width`/
  `height`/`durationMs` all constrained to `undefined().or(null()).optional()` — i.e. may
  be omitted or explicitly `null`, but never a real value.
- **Media branch** (`contentType: z.enum(['image', 'audio', 'video'])`): `storageKey:
  string()`, `mimeType: string()`, `sizeBytes: number().int().nonnegative()` all required;
  `width`/`height`/`durationMs` optional nullable ints; `encryptedBlob` constrained to
  `undefined().or(null()).optional()`.

Zod-layer tests confirm: a text item with a `storageKey` set is rejected; a text item
missing `encryptedBlob` is rejected; an image item missing `storageKey` is rejected; an
audio item missing `mimeType` is rejected; a video item missing `sizeBytes` is rejected; a
media item that also carries `encryptedBlob` is rejected; an unknown `contentType`
(`'banana'`) is rejected.

**Integration-test-confirmed Postgres constraints** (real DB, not just Zod):

- **CHECK constraint `content_items_type_consistency`**: rejects (a) a `text` row with
  `storageKey` set, (b) an `image` row with `encryptedBlob` set, (c) an `image` row missing
  `storageKey`, `mimeType`, or `sizeBytes` (all three null simultaneously).
- **Partial unique index `content_items_storage_key_idx`**: rejects two rows sharing the
  same non-`NULL` `storageKey`; allows arbitrarily many `text` rows with `NULL`
  `storageKey` to coexist for the same `messageId` (confirmed with 3 concurrently-inserted
  rows at `position` 10/11/12, all with `storageKey: null`).
- A round-trip test (`legacy_factories.integration.test.ts`) shows a message's
  `wrappedContentKey` is a single per-message ECIES envelope (via `beginMessageEnvelope`/
  `openMessageEnvelope` from `@hushbox/crypto`) shared across every `content_items` row on
  that message — one text item's `encryptedBlob` and two image items are all encrypted
  under the same recovered `contentKey`; the two image rows carry `encryptedBlob: null` in
  the DB (their bytes live in R2, referenced only by `storageKey`), while the text row's
  `encryptedBlob` decrypts successfully with the key recovered from that one shared
  envelope.

---

### `projects` (`legacy_projects` schema)

**Factory** (`legacy_project.ts`, `projectFactory`):

| Field | Default value |
| --- | --- |
| `id` / `userId` | `crypto.randomUUID()` |
| `encryptedName` | `placeholderBytes(32)` |
| `encryptedDescription` | `faker.helpers.arrayElement([null, placeholderBytes(64)])` (roughly 50/50 null vs. a 64-byte blob per build) |
| `createdAt` / `updatedAt` | `faker.date.recent()` |

Test-pinned (`legacy_project.test.ts`): `encryptedName` a non-empty `Uint8Array`; across a
20-item `buildList`, both a null and a non-null `encryptedDescription` are observed to
occur (probabilistic assertion — `hasNull || hasValue` must be true).

**Zod**: the `legacy-zod/index.ts` file read in this scope does **not** export
`insertProjectSchema`/`selectProjectSchema` (no `projects`/`legacy_projects` import, no
`createInsertSchema`/`createSelectSchema` call for it anywhere in the 200-line file).
`legacy-zod/index.test.ts`, however, imports and exercises both `insertProjectSchema` and
`selectProjectSchema` from `./index` — asserting: insert accepts `{ userId,
encryptedName }`; insert accepts an additional `encryptedDescription`; insert rejects a
missing `encryptedName`; select accepts a complete row (`id`, `userId`, `encryptedName`,
`encryptedDescription: null`, `createdAt`, `updatedAt`). This is a direct discrepancy
between the two files as read from the quarantine tree: the test imports symbols the
index file, as captured here, does not define.

**Integration test**: `legacy_factories.integration.test.ts` inserts a `projectFactory`
row keyed to a real `userId` FK and asserts `proj.userId === user.id`.

---

### `shared_links`

**Factory** (`legacy_shared-link.ts`, `sharedLinkFactory`):

| Field | Default value |
| --- | --- |
| `id` / `conversationId` | `crypto.randomUUID()` |
| `linkPublicKey` | `placeholderBytes(32)` |
| `displayName` | `null` |
| `revokedAt` | `null` |
| `createdAt` | `faker.date.recent()` |

Test-pinned (`legacy_shared-link.test.ts`): `linkPublicKey.length === 32`; `revokedAt`
null by default (overridable to a `Date` for a revoked link); `displayName` null by default
(overridable to a string, e.g. `'Dave'`).

**Zod**: `linkPublicKey` overridden to `z.instanceof(Uint8Array)`, required on insert. The
`legacy-zod/index.test.ts` select-schema round-trip test for this table includes a
`privilege: 'read'` field on the row (`{ id, conversationId, linkPublicKey, privilege:
'read', displayName: null, revokedAt: null, createdAt }`) even though
`sharedLinkFactory`'s own defaults never set a `privilege` field.

---

### `shared_messages` (Zod-only in this scope; no Fishery factory present)

`legacy-zod/index.ts` exports `selectSharedMessageSchema`/`insertSharedMessageSchema`,
overriding `wrappedContentKey` to `z.instanceof(Uint8Array)`. Insert requires `messageId`
and `wrappedContentKey` (tests confirm both rejections when missing). A complete select row
observed in tests: `id`, `messageId`, `wrappedContentKey`, `createdAt` — no other fields
appear in the test fixtures for this table.

---

### `member_budgets` (Zod-only in this scope; no Fishery factory present)

`legacy-zod/index.ts` exports `selectMemberBudgetSchema`/`insertMemberBudgetSchema`, plain
(no overrides). Insert requires `memberId`; `budget` is optional on insert (test:
`insertMemberBudgetSchema.safeParse({ memberId })` succeeds with no `budget`, with the test
name noting "uses database default"). A complete select row observed in tests: `id`,
`memberId`, `budget: '50.00'`, `spent: '10.00000000'`, `createdAt`.

---

### `conversation_spending` (Zod-only in this scope; no Fishery factory present)

`legacy-zod/index.ts` exports `selectConversationSpendingSchema`/
`insertConversationSpendingSchema`, plain. Insert requires only `conversationId` (test:
`{ conversationId }` alone succeeds; `{}` alone fails). A complete select row observed in
tests: `id`, `conversationId`, `totalSpent: '25.50000000'`, `updatedAt`.

---

### `service_evidence` (Zod-only in this scope; no Fishery factory present)

`legacy-zod/index.ts` exports `selectServiceEvidenceSchema`/`insertServiceEvidenceSchema`,
plain, from a `serviceEvidence` import (`../schema/service-evidence`). Insert requires only
`service` (test: `{ service: 'ai-gateway' }` succeeds; `{}` fails). A complete select row
observed in tests: `id`, `service: 'ai-gateway'`, `details: { key: 'value' }` (a free-form
object field), `createdAt`.

---

### `account_deletion_events`

Not modeled by a Fishery factory in this scope, but its own dedicated module
(`legacy_account-deletion-events.ts`) plus a matching Zod export
(`selectAccountDeletionEventSchema`/`insertAccountDeletionEventSchema` in
`legacy-zod/index.ts`, plain, from `../schema/account-deletion-events`) and integration
test (`legacy_account-deletion-events.test.ts`) exist.

Column facts confirmed by the integration test against the real database:

- `id`: auto-generated, matches the **uuidv7** pattern specifically (test regex
  `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, i.e. version
  nibble `7`).
- `deletedAt`: defaults to "now" at insert time when omitted (test inserts `{}` and asserts
  `deletedAt` falls within a ±1000 ms window of the surrounding `before`/`after`
  timestamps); can also be set explicitly at insert.
- `ipAddress`: nullable, defaults `null` when omitted; round-trips an explicit value (test
  uses `'198.51.100.42'`).
- `userAgent`: nullable, defaults `null` when omitted; round-trips an explicit value (test
  uses `'Mozilla/5.0 (test)'`).

**`purgeExpiredDeletionEvents(db, now, retentionDays = 90)`** — the one function this
module exports:

- Computes `cutoff = now - retentionDays * 24 * 60 * 60 * 1000` ms.
- Deletes every row where `deletedAt < cutoff` (`drizzle-orm`'s `lt`) and returns `{
  purged: <count of deleted rows> }`.
- **Default `retentionDays` is exactly `90`.**
- The comparison is **strict less-than**: a row whose `deletedAt` is *exactly*
  `retentionDays` days old (down to the millisecond) is **not** purged (test: a row at
  precisely `now - 90 * DAY_MS` survives a call with default `retentionDays`); a row one
  millisecond older than the cutoff **is** purged (test: `now - 90 * DAY_MS - 1` is
  deleted).
- Honors a caller-supplied `retentionDays` (test: `retentionDays: 45` purges rows at 60 and
  100 days old, keeps a row at 30 days old).
- Against an empty table, returns `{ purged: 0 }`.
- Only deletes from `account_deletion_events` — a `users` row present alongside a purged
  deletion-event row is left untouched (explicit cross-table isolation test).

---

### `legacy-zod/index.ts` — exported types

Beyond the Zod schemas themselves, the file re-exports a `select`/`insert` TypeScript type
pair per table via `z.infer<...>` (or, for `users`/`conversations`/`messages`/
`contentItems`, `typeof <table>.$inferSelect` directly from the Drizzle table for the
`Select`-side type): `User`/`NewUser`, `Conversation`/`NewConversation`,
`Message`/`NewMessage`, `ContentItem`/`NewContentItem`, `Payment`/`NewPayment`,
`ServiceEvidence`/`NewServiceEvidence`, `Wallet`/`NewWallet`,
`UsageRecord`/`NewUsageRecord`, `LlmCompletion`/`NewLlmCompletion`,
`MediaGeneration`/`NewMediaGeneration`, `LedgerEntry`/`NewLedgerEntry`,
`SharedLink`/`NewSharedLink`, `ConversationMember`/`NewConversationMember`,
`Epoch`/`NewEpoch`, `EpochMember`/`NewEpochMember`, `SharedMessage`/`NewSharedMessage`,
`MemberBudget`/`NewMemberBudget`, `ConversationSpending`/`NewConversationSpending`,
`AccountDeletionEvent`/`NewAccountDeletionEvent`. No `Project`/`NewProject` type pair is
exported from this file, consistent with the missing `insertProjectSchema`/
`selectProjectSchema` noted above.

---

### `legacy_client.ts` — connection / pooling configuration

Built on `@neondatabase/serverless`'s `Pool` + `neonConfig`, `drizzle-orm/neon-serverless`,
and the `ws` WebSocket implementation. At module load, `neonConfig.webSocketConstructor =
ws` is set unconditionally.

**`NeonDevConfig`** interface fields: `wsProxy: (host, port) => string`,
`useSecureWebSocket: boolean`, `pipelineTLS: boolean`, `pipelineConnect: false |
'password'`.

**`LOCAL_NEON_DEV_CONFIG`** (the standard local-dev value):

- `wsProxy(host, port)` → `` `${host}:${port}/v1` `` — test-confirmed for both a string
  port (`'4444'` → `'localhost:4444/v1'`) and a numeric port (`4444` → same string).
- `useSecureWebSocket: false`
- `pipelineTLS: false`
- `pipelineConnect: false`

**`DbConfig`** interface: `connectionString: string`, `neonDev?: NeonDevConfig` (marked
"Development-only neon proxy settings. Omit in production.").

**`createDb(config)`**:

1. If `config.neonDev` is present, copies its four fields onto the singleton
   `neonConfig` object (`wsProxy`, `useSecureWebSocket`, `pipelineTLS`,
   `pipelineConnect`).
2. Constructs `new Pool({ connectionString: config.connectionString, max: 1 })` —
   test-confirmed exact call shape: `Pool` is invoked with `{ connectionString, max: 1 }`
   and nothing else.
3. Returns `drizzle(pool, { schema })`.

Test-confirmed behavior: **a brand-new `Pool` is constructed on every `createDb()` call —
no caching or connection reuse across calls** (three sequential `createDb()` calls with
identical args produce three separate `Pool` constructions). `max: 1` means each such pool
is capped to a single underlying connection.

**Exported types**: `Database = ReturnType<typeof createDb>`. `DatabaseClient = Pick<Database,
'select' | 'insert' | 'update' | 'delete' | 'transaction'>` — documented in-code as "works
for both `Database` and `PgTransaction`," letting helper functions accept either a
top-level `Database` or an in-flight transaction handle, including nested
`.transaction()` calls (Drizzle implements nested transactions as savepoints).

**Integration test** (`legacy_client.integration.test.ts`): confirms a real insert via
`createDb` populates `id`, `createdAt`, `updatedAt` automatically, and that a subsequent
`update(...).set({ username: ... })` round-trips.

---

### Fishery/faker conventions observed across the whole factory set

- Every money-shaped column (`wallets.balance`, `payments.amount`,
  `usage_records.cost`, `ledger_entries.amount`/`balanceAfter`, `content_items.cost`) is
  produced as a **string with exactly 8 decimal places** via
  `faker.number.float({ ...,  fractionDigits: 8 }).toFixed(8)`.
- Every bytea/ciphertext-shaped column uses a shared `placeholderBytes(n)` helper (not
  present in this quarantine tree — see the scope note above) with a fixed byte length per
  field: `users.opaqueRegistration` 64, `users.publicKey` 32,
  `users.passwordWrappedPrivateKey`/`recoveryWrappedPrivateKey` 48,
  `conversations.title` 32, `epochs.epochPublicKey`/`confirmationHash` 32,
  `epochs.chainLink` 64 (epoch > 1 only), `epoch_members.memberPublicKey` 32,
  `epoch_members.wrap` 48, `messages.wrappedContentKey` 81, `content_items.encryptedBlob`
  128 (text default only), `projects.encryptedName` 32, `projects.encryptedDescription`
  64 (when non-null), `shared_links.linkPublicKey` 32.
- Every table's `id` (and other FK-shaped fields) is `crypto.randomUUID()` at the
  factory layer, not a Fishery `sequence()` — no numeric/incrementing IDs appear anywhere
  in this scope's factories.
- `faker.date.recent()` is the universal timestamp default; several factories generate
  `createdAt`/`updatedAt` (or `now`/derived fields) as **independent** calls rather than
  sharing one value, except where a factory explicitly threads a shared `now` variable
  through related fields (`usage_records.createdAt`/`completedAt` via `refDate: now`;
  `payments.createdAt`/`updatedAt`/`webhookReceivedAt` via the same `now`).


---

## 11. Scripts, Seeding & Dev Tooling

This report documents the legacy `/dev/*` API route surface (`apps/api/src/legacy/routes/dev.ts`), its backing service layer (`apps/api/src/legacy/services/dev/dev.ts` + `index.ts` barrel), and the local database seed scripts (`scripts/legacy_seed.ts`, `scripts/legacy_seed-cache.ts`) including their test suites.

### 1. The `/dev/*` route surface

All routes are mounted on a Hono sub-app (`devRoute`) with no environment gate visible inside the file itself (route registration under the app's dev-only mount is handled elsewhere; this file contains only the endpoint bodies). Endpoints, methods, and exact status codes:

#### `GET /dev/personas`
- Query param `type`, Zod-validated as `z.enum(['test', 'dev']).optional()`; defaults to `'dev'` when absent.
- Calls `listDevPersonas(db, resolvedType)`, returns `{ personas }`, status 200 (Hono default).

#### `DELETE /dev/test-data`
- Calls `cleanupTestData(db)`, returns `{ success: true, deleted }` where `deleted = { conversations, messages }`, status 200.

#### `GET /dev/verify-token/:email`
- Param validated as `z.email()`.
- Looks up `users.emailVerifyToken` for the lower-cased email.
- If no user or `emailVerifyToken` is falsy: `createErrorResponse(ERROR_CODE_NOT_FOUND)` with status **404**.
- Otherwise returns `{ token }`, status 200.

#### `DELETE /dev/trial-usage`
- Calls `resetTrialUsage(redis)`; returns `{ success: true, deleted: result.deleted }`, status 200.

#### `DELETE /dev/auth-rate-limits`
- Calls `resetAuthRateLimits(redis)`; returns `{ success: true, deleted }`, status 200.

#### `DELETE /dev/usage-rate-limits`
- Calls `resetUsageRateLimits(redis)`; returns `{ success: true, deleted }`, status 200.

#### `DELETE /dev/totp-replay`
- Body validated as `{ email: z.email() }`.
- Calls `clearTotpReplay(db, redis, email)`.
- If the underlying error message contains the substring `'not found'`: returns `createErrorResponse(ERROR_CODE_NOT_FOUND)`, status **404**.
- Otherwise rethrows (other errors propagate as 500 via the app's error handling, not handled in this file).
- Success: `{ success: true, deleted }`, status 200.

#### `POST /dev/conversation`
- Body schema: `ownerEmail: z.email()`; optional `messages: { content: string; senderType: 'user'|'ai' }[]`; optional `aiTurn: { userContent: string; responseCount: number (int, min 1) }`.
- Fetches `rawModels` via `aiClient.listRawModels()` every call (live catalog, never hardcoded).
- **If `aiTurn` present** (multi-model fan-out path): picks `aiTurn.responseCount` models via `pickValueTextModels(rawModels, responseCount)`. Builds one AI response per model:
  - `content`: `` `Echo: ${aiTurn.userContent}` ``
  - `modelName`: the picked model id
  - `cost`: `((2 + index) / 1000).toFixed(8)` — i.e. distinct positive costs `0.00200000`, `0.00300000`, `0.00400000`, … for index 0, 1, 2, …
  - Calls `createDevMultiModelConversation(db, { ownerEmail, userContent, aiResponses })`.
  - Returns the result JSON, status **201**.
- **If `aiTurn` absent**: picks a single model via `pickValueTextModel(rawModels)` as `seedAiModel`, calls `createDevConversation(db, { ...body, seedAiModel })`. Returns result, status **201**.
- Missing `ownerEmail` or `responseCount < 1` → 400 (Zod validation).

#### `POST /dev/media-conversation`
- Route-scoped middleware: `mediaStorageMiddleware()` (only this route provisions R2/MinIO access).
- Body schema: `ownerEmail: z.email()`, `userContent: string`, `mediaType: z.enum(['image', 'video'])`.
- Resolves a model id via the same text-model picker (`pickValueTextModel(await aiClient.listRawModels())`) — there is no dedicated media-model picker.
- Calls `createDevMediaConversation(db, mediaStorage, { ownerEmail, userContent, mediaType, modelName: seedModel, cost: '0.01000000' })` — a **fixed** cost of `0.01000000`.
- Returns result, status **201**. Unknown `mediaType` → 400.

#### `POST /dev/group-chat`
- Body schema: `ownerEmail: z.email()`, `memberEmails: z.array(z.email()).min(1)`, optional `pendingMemberEmails: z.array(z.email())`, optional `messages: { senderEmail?: z.email(); content: string; senderType: 'user'|'ai' }[]`.
- Resolves `seedAiModel` via `pickValueTextModel(await aiClient.listRawModels())`.
- Calls `createDevGroupChat(db, { ...rest, seedAiModel, pendingMemberEmails?, messages? })`.
- Returns result, status **201**. Missing `ownerEmail` → 400.

#### `POST /dev/wallet-balance`
- Body schema: `email: z.email()`, `walletType: z.enum(['purchased', 'free_tier'])`, `balance: string`.
- Calls `setWalletBalance(db, params)`.
- On error containing `'not found'` (either "User not found" or "Wallet not found"): `createErrorResponse(ERROR_CODE_NOT_FOUND)`, status **404**.
- Success: `{ success: true, newBalance: result.newBalance }`, status 200.

#### `GET /dev/emails`
- No auth/env gate visible in this handler; synchronously renders `EMAIL_TEMPLATES` (see §2) and returns `{ templates: [{ name, label, html }, ...] }`, status 200.
- Exactly **6** templates are exposed (see §2 for exact names/labels).

#### `POST /dev/set-version`
- Body schema: `{ version: z.string().min(1) }`.
- Calls `setVersionOverride(version)` (module-level in-process override, not persisted to DB/Redis in this file).
- Returns `{ success: true, version }`, status **200** (explicit).
- Empty string or missing `version` → 400.
- Repeated calls overwrite the previous override (last write wins).

#### `POST /dev/expire-session`
- Reads `c.env.IRON_SESSION_SECRET`; if falsy, returns `createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED)`, status **500**.
- Otherwise builds an iron-session via `getIronSession` using `getSessionOptions(sessionSecret, isProduction)` (from `c.get('envUtils').isProduction`), then calls `session.destroy()`.
- Returns `{ success: true }`, status 200.

#### `GET /dev/llm-completions-count/:conversationId`
- Param validated `z.string().min(1)`.
- Counts rows: `llmCompletions` INNER JOIN `usageRecords` (on `usageRecords.id = llmCompletions.usageRecordId`) INNER JOIN `messages` (on `messages.id = usageRecords.sourceId`), filtered to `messages.conversationId = conversationId`.
- Returns `{ count: row?.count ?? 0 }`, status 200.
- Comment states this is used by Smart Model E2E tests to assert **2** completion rows (classifier + inference) for a single Smart Model send.

#### `GET /dev/message-payers/:conversationId`
- Param validated `z.string().min(1)`.
- Selects `messages.id` (as `messageId`), `usageRecords.userId` (as `payerId`), `messages.sequenceNumber`, from `messages` LEFT JOIN `usageRecords` (on `usageRecords.sourceId = messages.id AND usageRecords.sourceType = 'message'`), filtered to `messages.conversationId = conversationId AND messages.senderType = 'ai'`, ordered by `sequenceNumber`.
- Returns `{ payers: [{ messageId, payerId }, ...] }`, status 200.
- Comment: exists because `messages.payer_id` was dropped in a "wrap-once refactor"; payer now resolved from `usage_records.user_id`. Used by group-billing E2E tests to distinguish owner-funded vs. personal-fallthrough billing.

#### `GET /dev/conversation-cost/:conversationId`
- Param validated `z.string().min(1)`.
- Selects `coalesce(sum(usage_records.cost::numeric), 0)::text` from `usageRecords` INNER JOIN `messages` (on `messages.id = usageRecords.sourceId AND usageRecords.sourceType = 'message'`), filtered to `messages.conversationId = conversationId`.
- Returns `{ cost: row?.cost ?? '0' }` — the literal string `'0'` when no charged usage exists (confirmed by test), or the summed decimal string (e.g. `'0.00017768'`) otherwise.
- Comment: `conversation_spending` cannot be used for this because it stays at 0 for solo (non-group) conversations; INNER JOIN to `messages` scopes the total and drops deleted/regenerated tiles.

#### `POST /dev/revoke-message-share`
- Body schema: `{ shareId: z.string().min(1) }`.
- Deletes from `sharedMessages` where `id = shareId`.
- Returns `{ success: true, rowsAffected: result.rowCount ?? 0 }`, status 200.
- Comment: used by E2E to assert subsequent `/api/shares/:id` calls 404 after revocation.

### 2. Email template preview (`GET /dev/emails`)

Exactly 6 entries in `EMAIL_TEMPLATES`, each rendered with fixed sample data:

| `name` | `label` | Render call & sample data |
| --- | --- | --- |
| `verification` | Email Verification | `verificationEmail({ verificationUrl: 'https://hushbox.ai/verify?token=sample-token-abc123', userName: 'Alice', expiresInHours: 24 })` |
| `password-changed` | Password Changed | `passwordChangedEmail({ userName: 'Alice' })` |
| `two-factor-enabled` | Two-Factor Enabled | `twoFactorEnabledEmail({ userName: 'Alice' })` |
| `two-factor-disabled` | Two-Factor Disabled | `twoFactorDisabledEmail({ userName: 'Alice' })` |
| `account-locked` | Account Locked | `accountLockedEmail({ userName: 'Alice', lockoutMinutes: 15 })` |
| `welcome` | Welcome | `welcomeEmail({ userName: 'Alice' })` |

Each template's `.html` field is used directly; the route re-renders on every request (no caching).

### 3. Dev/test data-reset service behaviors (`services/dev/dev.ts`)

#### `listDevPersonas(db, type)`
- `type === 'test'` → filters `users.email LIKE '%@' || TEST_EMAIL_DOMAIN`; `type === 'dev'` → filters by `DEV_EMAIL_DOMAIN`.
- For each matched user, computes: `conversationCount` (count of `conversations` where `userId` matches), `messageCount` (count of `messages` INNER JOIN `conversations` where `conversations.userId` matches), `projectCount` (count of `projects` where `userId` matches).
- Computes `credits` via `checkUserBalance(db, user.id)`, formatted as `` `$${balanceNumber.toFixed(2)}` `` (e.g. `'$10.00'`, `'$0.00'`, `'$0.20'` for the welcome-credit default balance).
- Returns `email ?? ''` (dev personas are assumed to always have an email).

#### `cleanupTestData(db)`
- Finds all `users` with email LIKE `%@` + `TEST_EMAIL_DOMAIN`.
- If none, returns `{ conversations: 0, messages: 0 }` immediately (no queries against conversations/messages).
- Finds all `conversations` owned by those test users; if none, returns `{ conversations: 0, messages: 0 }`.
- Deletes `messages` where `conversationId IN (...)` first (FK ordering), then deletes `conversations` where `id IN (...)`.
- Returns `{ conversations: deletedConversations, messages: deletedMessages }` using each delete's `rowCount ?? 0`.

#### Redis reset behaviors — shared mechanics
- `RESET_SCAN_COUNT = 1000` — the `SCAN` hint passed to every reset operation. Comment states this is intentionally far above the production default because each SCAN round-trips through the Serverless Redis HTTP proxy, and under E2E parallel-worker saturation the round-trip count (not Redis CPU) is the cost; a count of 1000 collapses most keyspace traversals to 1–2 round-trips.
- `deleteRedisKeysByPrefixes(redis, prefixes)` iterates each prefix, `SCAN`-ing with `{ match: prefix, count: RESET_SCAN_COUNT }` until cursor returns `'0'`, calling `redis.del(...keys)` for every non-empty page, and summing `deleted` across all prefixes and pages.

#### `resetTrialUsage(redis)`
- Scans and deletes keys matching `trial:*` (single pattern, no discrete prefix list).
- Returns `{ deleted }`.

#### `resetAuthRateLimits(redis)`
- Deletes keys matching exactly these 10 prefixes:
  - `login:*:ratelimit:*`
  - `login:lockout:*`
  - `register:*:ratelimit:*`
  - `2fa:*:ratelimit:*`
  - `2fa:lockout:*`
  - `recovery:*:ratelimit:*`
  - `recovery:lockout:*`
  - `verify:*:ratelimit:*`
  - `resend-verify:*:ratelimit:*`
  - `totp:used:*`

#### `resetUsageRateLimits(redis)`
- Deletes keys matching exactly these 6 prefixes:
  - `chat:stream:user:ratelimit:*`
  - `media:download:user:ratelimit:*`
  - `share:create:user:ratelimit:*`
  - `chat:reserved:*`
  - `chat:group-reserved:*`
  - `chat:conversation-reserved:*`
- Comment: reservation prefixes (`chat:reserved:*`, `chat:group-reserved:*`, `chat:conversation-reserved:*`) are included so that after `setWalletBalance` sets an exact wallet value, no leftover speculative reservation (up to its **180-second TTL**) silently subtracts from the "available balance" view, which would desync the raw-balance UI from the reservation-adjusted billing path.
- Excludes IP-scoped and trial-scoped buckets deliberately, since some tests exercise those limits firing.

#### `clearTotpReplay(db, redis, email)`
- Looks up user by lower-cased email; throws `User not found: ${email}` if absent (route maps this to 404 via substring match on `'not found'`).
- Deletes keys matching `${REDIS_REGISTRY.totpUsedCode.buildKey(user.id, '')}*` — i.e. all `totp:used:{userId}:*` markers for that user, via `deleteRedisKeysByPrefixes`.
- Comment: lets a previously-accepted TOTP code be reused in a test without waiting out the real 30-second window, while leaving the actual replay check and crypto verification logic exercised as normal.

### 4. Dev conversation/data-seeding service behaviors (`services/dev/dev.ts`)

#### `createDevConversation(db, params)`
- Looks up user by `ownerEmail` (exact match, not lower-cased in this function); throws `User not found: ${ownerEmail}` if absent.
- Generates a fresh `conversationId` (`crypto.randomUUID()`) and a first epoch via `createFirstEpoch([user.publicKey], conversationId, 1)`.
- Calls `createOrGetConversation` (production service) to create the conversation row.
- If `params.messages` provided, iterates sequentially, chaining `parentMessageId` to the previous message:
  - `senderType: 'user'` → calls production `saveUserOnlyMessage(db, {...})` (not inside the dev-created transaction).
  - `senderType: 'ai'` → wraps in its own `db.transaction`: `assignSequenceNumbers(txDb, conversationId, 1)`, `fetchEpochPublicKey`, then `insertEnvelopeTextMessage` with `senderType: 'ai'`, `modelName: params.seedAiModel` (the resolved live-catalog model id from the route).
- Returns `{ conversationId: result.conversation.id }`.

#### `createDevMultiModelConversation(db, params)`
- Looks up user by `ownerEmail`; throws `User not found: ${ownerEmail}` if absent.
- Creates conversation via `createOrGetConversation`; throws `Failed to create conversation` if the result is falsy.
- Generates one shared `batchId` stamped on the user message **and every AI sibling** — mirrors production `saveChatTurn` so persisted rows are structurally identical (comment: "so fork-filter renders them as multi-model peers rather than splitting across fork branches").
- Inside one transaction: assigns `1 + aiResponses.length` sequence numbers; inserts the user message (`senderType: 'user'`, `parentMessageId: null`, first sequence); inserts one AI message per `aiResponses` entry, each with `parentMessageId` = the user message id, `modelName` = that response's resolved model id, `cost` = that response's cost string.
- Returns `{ conversationId: result.conversation.id }`.

#### `createDevMediaConversation(db, mediaStorage, params)`
- Looks up user by `ownerEmail`; throws `User not found: ${ownerEmail}` if absent.
- Creates conversation via `createOrGetConversation`; throws `Failed to create conversation` if falsy.
- Fixture bytes come from `DEV_MEDIA_FIXTURES[params.mediaType]`, sourced from the mock-gateway CC0 sample constants (`TEST_IMAGE_BYTES`/`TEST_IMAGE_MIME`/`TEST_IMAGE_WIDTH`/`TEST_IMAGE_HEIGHT` for image; `TEST_VIDEO_BYTES`/`TEST_VIDEO_MIME`/`TEST_VIDEO_WIDTH`/`TEST_VIDEO_HEIGHT`/`TEST_VIDEO_DURATION_MS` for video) — reusing real fixture bytes so the seeded turn decodes identically to a generated one across every browser.
- Storage key layout: `` `media/${conversationId}/${assistantMessageId}/${contentItemId}.enc` ``.
- One content key both wraps into the message (`beginMessageEnvelope`) and encrypts the stored bytes (`encryptBinaryWithContentKey`); the ciphertext is `mediaStorage.put(storageKey, ciphertext, 'application/octet-stream')`-uploaded **before** the DB transaction, so a later DB failure leaves an orphan the GC reclaims (not a partial/inconsistent DB row referencing missing bytes).
- Inside one transaction: assigns 2 sequence numbers, inserts the user text message, then inserts one AI media message with a single `mediaItems` entry: `contentType` (image/video), `position: 0`, `storageKey`, `mimeType`, `sizeBytes: ciphertext.byteLength`, `width`, `height`, `durationMs` (video only), `modelName: params.modelName`, `cost: params.cost`, `isSmartModel: false`.
- Returns `{ conversationId, assistantMessageId }`.

#### `createDevGroupChat(db, params)`
- Looks up all users by `[ownerEmail, ...memberEmails]`; throws `Owner not found: ${ownerEmail}` if owner missing, or `Member not found: ${email}` for the first missing member email.
- Orders users: owner first, then members in request order.
- Generates conversation id, epoch via `createFirstEpoch(publicKeys, conversationId, 1)`, epoch id.
- Inside one transaction:
  - Inserts `conversations` row with `title: encryptTextForEpoch(epochPublicKey, '')` (empty encrypted title).
  - Inserts one `epochs` row (`epochNumber: 1`, `chainLink: null`).
  - Inserts one `epochMembers` row per user: `privilege: index === 0 ? 'owner' : 'admin'`.
  - Inserts one `conversationMembers` row per user: same `owner`/`admin` privilege split; `acceptedAt` is stamped `new Date()` for everyone **except** members whose email is in `pendingMemberEmails` (owner, index 0, is *never* left pending regardless of that list; a null `user.email` is also treated as never-pending).
  - If `params.messages` provided (non-empty), calls `insertGroupChatMessages` (see below).
- Returns `{ conversationId, members: orderedUsers.map(u => ({ userId, username, email: email ?? '' })) }`.

##### `insertGroupChatMessages` helper
- Pre-generates one message id per message; chains `parentMessageId` sequentially (first message's parent is `null`).
- For each message: `senderId` is resolved from `orderedUsers` by matching `msg.senderEmail` **only** when `senderType === 'user'` and `senderEmail` is present; otherwise `senderId` stays `null`.
- `modelName: seedAiModel` is stamped only on `senderType === 'ai'` messages.
- After inserting all messages, updates `conversations.nextSequence = msgs.length + 1` so production `saveChatTurn` assigns non-overlapping sequence numbers afterward.

#### `setWalletBalance(db, params)`
- Looks up user by lower-cased `email`; throws `User not found: ${email}` if absent.
- Atomically `UPDATE`s the wallet row matching `(userId, type = params.walletType)` to `balance = params.balance`, using `.returning(...)`; throws `Wallet not found: ${walletType} for ${email}` if the update affected 0 rows.
- Inserts a `ledgerEntries` row: `entryType: 'adjustment'`, `amount: params.balance`, `balanceAfter: updated.balance`, `sourceWalletId: updated.id` (self-referential source).
- Returns `{ newBalance: updated.balance }`.

### 5. Local database seed script (`scripts/legacy_seed.ts`)

#### Safety gate
- `seed()` requires `process.env.DATABASE_URL`; if unset, loads `.env.development` via `dotenv`'s `config()`, then re-checks; throws `'DATABASE_URL is required'` if still missing.
- `isLocalDatabaseUrl(databaseUrl)` parses the URL's hostname and checks membership in `LOCAL_DATABASE_HOSTS = { 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0' }`. An unparseable URL is treated as **not** local (fail closed).
- If not local, `seed()` throws a message containing "Refusing" / "local" (exact wording: "Refusing to seed: DATABASE_URL does not point to a local database. This seed is for local-development only and must never run against a remote (production) database.").
- Comment explains the bracketed-IPv6 entry `'[::1]'` exists because `new URL('postgres://[::1]:5432/db').hostname` returns the bracketed literal `[::1]`, not the bare `::1`.

#### AI model resolution
- `loadSeedAiModel()` requires `process.env.PUBLIC_MODELS_URL`; throws if unset/empty.
- Fetches live models via `fetchModels({ publicModelsUrl })`, picks one via `pickValueTextModel(rawModels)`, stores as module-level `seedAiModelId`.
- `buildSeedMessageAndContentItem` throws an invariant error if called before `loadSeedAiModel()` has run.
- Every seeded AI-authored `content_items` row gets `modelName: seedAiModelId`; user-authored rows get `modelName: null`. Seeded `content_items.cost` is always `null` (seed messages carry no cost; only the persona usage-history rows carry cost — see §5.5).

#### 5.1 Deterministic UUIDs
- `seedUUID(name)`: a simple string hash (`(hash << 5) - hash + charCode`, masked) converted to a 12-hex-digit suffix, formatted as `00000000-0000-4000-8000-{12 hex digits}` — deterministic and stable across runs for the same input string (confirmed by test: same input → same UUID; different inputs → different UUIDs; matches UUID v4-shape regex).

#### 5.2 Random filler seed data — `SEED_CONFIG` / `generateSeedData()`
Exact constants:
```
SEED_CONFIG = {
  USER_COUNT: 5,
  PROJECTS_PER_USER: 2,
  CONVERSATIONS_PER_USER: 2,
  MESSAGES_PER_CONVERSATION: 5,
}
```
- Produces 5 users (`seed-user-1`…`seed-user-5`, emails `` `seed-user-${n}@${DEV_EMAIL_DOMAIN}` ``, usernames `seeduser1`…`seeduser5` — deliberately index-derived rather than the factory's random faker defaults, since `bulkUpsert` conflicts only on `id` and cannot absorb a colliding email/username).
- Each user gets exactly 2 projects (titled `Project 1`, `Project 2`, encrypted names).
- Each user gets exactly 2 conversations (titled `Seed Conversation 1`, `Seed Conversation 2`).
- Each conversation gets exactly 5 messages, alternating `senderType` starting with `'user'` (index 0 = user, 1 = ai, 2 = user, 3 = ai, 4 = user), content `` `Sample message ${n}` ``, chained via `parentMessageId`.
- One `epochs`/`epochMembers`/`conversationMembers` row per conversation (owner privilege, `visibleFromEpoch: 1`).
- Totals: 5 users, 10 projects, 10 conversations, 50 messages, 50 content items (1:1 with messages), 10 epochs, 10 epoch members, 10 conversation members.

#### 5.3 Dev personas — `DEV_PERSONAS` / `generatePersonaData()`
Exact persona definitions:
| name | displayName | emailVerified | hasSampleData | balance | conversationCount |
| --- | --- | --- | --- | --- | --- |
| `alice` | Sarah Chen | true | true | `10000.00000000` | 150 |
| `bob` | Marcus Johnson | true | false | `0.20000000` | 3 |
| `charlie` | Priya Patel | true | false | `0.00000000` | 3 (unused — see below) |

- Emails: `` `${name}@${DEV_EMAIL_DOMAIN}` ``. Usernames: `normalizeUsername(displayName)`.
- Each persona gets exactly **2 wallets**: `purchased` (priority 0, balance = persona's `balance`) and `free_tier` (priority 1, balance = `FREE_ALLOWANCE_DOLLARS`). Total: 6 wallets across the 3 dev personas.
- Each wallet gets a `welcome_credit`-type ledger entry seeded at creation (`${personaName}-welcome-purchased` / `${personaName}-welcome-free`), `amount = balanceAfter = wallet's balance`, `sourceWalletId` self-referential.
- **Only `alice`** (the sole `hasSampleData: true` dev persona) gets `createPersonaSampleData`: exactly **2 projects**, and `conversationCount` conversations (alice's override is 150, not the default-3 fallback). Of those, `convIndex === 2` (the 3rd conversation, 0-indexed) is titled `'Quantum Computing Research'` and seeded via `createSearchConversationMessages` (the fixed 4-message `SEARCH_MESSAGES` array — user asks about quantum computing developments, AI cites nature.com/arxiv.org, user asks about classical-computing comparison, AI cites science.org/ieee.org). All other conversations are titled `` `${personaName} Conversation ${n}` `` and get `3 + (convIndex % 3)` messages (i.e. message counts cycle 3, 4, 5, 3, 4, 5, …), alternating sender type starting `'user'`.
- Alice additionally gets `createPersonaPayments`: exactly **14** payments (confirmed by test), see §5.5 for exact amounts.
- **Only `charlie`** (unconditionally, regardless of `hasSampleData`) gets one extra hardcoded conversation via `createCharlieConversation`: exactly **1** conversation (`'Charlie Conversation'`), with exactly **4** messages alternating `user, ai, user, ai` (content `` `Charlie message ${n}` ``).
- Alice's screenshot conversations (see §5.4) push her total to **155** conversations (150 sample + 5 screenshot) — pinned by test.
- Bob and Charlie: 0 projects, 0 payments (pinned by test); Charlie's only conversation is the 1 hardcoded one (0 from `createPersonaSampleData` since `hasSampleData: false`).

#### 5.4 Screenshot conversations — `createScreenshotConversations()`
Runs once, attached to alice/bob/charlie dev personas (only if all three exist). Produces exactly:
- **5 conversations** total: 4 "solo" (alice-only) + 1 group (alice+bob+charlie).
- **5 epochs** (1 per conversation), **7 epoch members** (4 solo × 1 + 1 group × 3), **7 conversation members** (same split), **12 messages** total (4 solo × 2 + 1 group × 4), **12 content items** (1:1 with messages).

Solo conversations (id = `` seedUUID(`screenshot-conv-${name}`) ``, title `` `Screenshot: ${name}` ``, each exactly 2 messages: 1 user + 1 ai):
- `chat` — async/await JavaScript Q&A with a code example.
- `mermaid` — signup/email-verification flowchart (mermaid diagram with custom `classDef` styling).
- `code` — a React data-fetching hook (`useFetch<T>`) example.
- `privacy` — HushBox's OPAQUE / XChaCha20-Poly1305 / pseudonymous-AI-access privacy explanation.

Group conversation (id = `` seedUUID('screenshot-conv-group-chat') ``, title `'Screenshot: group-chat'`):
- 3 members: alice (`owner`), bob (`write`), charlie (`write`) — note this differs from `createDevGroupChat`'s owner/admin split; here privileges are `owner`/`write`/`write`.
- Exactly 4 messages: alice (user) asks Postgres vs MongoDB, bob (user) replies, charlie (user) replies, then one `ai` message (senderId `null`) recommending Postgres for relational integrity + Drizzle ORM support + JSONB.

#### 5.5 Persona usage history — `createPersonaUsageData()` (alice only)
- `USAGE_MODELS`: 5 fixed model/cost/weight entries used only for seeding synthetic dashboard data:
  | model | provider | weight | costPer1kInput | costPer1kOutput |
  | --- | --- | --- | --- | --- |
  | `anthropic/claude-opus-4.6` | anthropic | 40 | 0.015 | 0.075 |
  | `openai/gpt-4o` | openai | 25 | 0.0025 | 0.01 |
  | `google/gemini-2.5-pro` | google | 15 | 0.00125 | 0.01 |
  | `deepseek/deepseek-r1` | deepseek | 10 | 0.00055 | 0.00219 |
  | `anthropic/claude-sonnet-4.5` | anthropic | 10 | 0.003 | 0.015 |
- `pickModel(index, daysAgo)` deterministically hash-picks one of the 5 models: `hash = ((index * 2_654_435_761) ^ (daysAgo * 40_503)) >>> 0; picked = USAGE_MODELS[hash % 5]`.
- Generates exactly **200** `usage_records` rows (`recordCount = 200`), each with a paired `llm_completions` row and a `ledger_entries` (`entryType: 'usage_charge'`) row.
- Per-record fields: `daysAgo = floor(90 - (index/200) * 90)` (spans the last ~90 days), `hoursOffset = (index*7) % 24`, `inputTokens = 200 + (index*137) % 8000`, `outputTokens = 100 + (index*89) % 4000`, `cachedTokens = index % 4 === 0 ? 50 + (index*43) % 1500 : 0` (cached tokens only on every 4th record).
- `cost = (inputTokens/1000)*costPer1kInput + (outputTokens/1000)*costPer1kOutput`, formatted to 8 decimal places.
- `runningBalance` starts at **10,000** and decrements by each record's cost, written as each ledger entry's `balanceAfter`.
- Records are round-robin assigned to alice's sample conversation ids (`conversationIds[index % conversationIds.length]`).
- Aggregates a `conversation_spending` row per touched conversation (`totalSpent` = sum of that conversation's usage costs, formatted to 8 decimals).

#### 5.6 Persona payment history — `createPersonaPayments()` (alice only)
- Exactly **14** payments (`for index in 0..13`).
- `baseAmount = 5 + (index % 5)` (cycles 5,6,7,8,9,5,6,...); `amount = index === 13 ? baseAmount + 4 : baseAmount` (the 14th/last payment gets a +4 bump).
- `paymentDate = now - (14 - index) days` (spans the last 14 days, oldest first).
- Every payment: `status: 'completed'`, `helcimTransactionId: hlcm-${personaName}-${index+1}`, `cardType`: alternates `'Visa'` (even index) / `'Mastercard'` (odd index), `cardLastFour: String(4000 + index).slice(-4)`.
- Each payment gets a paired `deposit`-type ledger entry against the persona's `purchased` wallet; `runningBalance` accumulates across all 14 payments and is written as `balanceAfter`.

#### 5.7 Test personas — `BASE_TEST_PERSONAS` × `E2E_PROJECT_NAMES` = `TEST_PERSONAS`
`E2E_PROJECT_NAMES` (7 Playwright project names, each with a 2-char code used to keep the cross-product username ≤ 20 chars):
| project | code |
| --- | --- |
| `chromium` | `cr` |
| `firefox` | `ff` |
| `webkit` | `wk` |
| `iphone-15` | `ih` |
| `pixel-7` | `px` |
| `ipad-pro` | `ip` |
| `auth-tests` | `au` |

`BASE_TEST_PERSONAS` (10 entries, cross-producted with all 7 projects → 70 total test users):
| name | displayName | emailVerified | hasSampleData | totpSecret |
| --- | --- | --- | --- | --- |
| `test-alice` | Test Alice | true | **true** | null |
| `test-bob` | Test Bob | true | false | null |
| `test-charlie` | Test Charlie | **false** | false | null |
| `test-dave` | Test Dave | true | false | null |
| `test-billing-success` | Test Bill Success | true | false | null |
| `test-billing-failure` | Test Bill Failure | true | false | null |
| `test-billing-validation` | Test Bill Valid | true | false | null |
| `test-billing-success-2` | Test Bill OK 2 | true | false | null |
| `test-billing-devmode` | Test Bill Dev | true | false | null |
| `test-billing-token` | Test Bill Token | true | false | null |
| `test-2fa` | Test 2FA User | true | false | `TEST_2FA_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'` |

- Test persona emails: `` `test-{name}-{project}@${TEST_EMAIL_DOMAIN}` ``; usernames: `` `${normalizedDisplayName}_${projectCode}` `` (throws at module load if any generated username exceeds 20 chars — a `USERNAME_MAX_LENGTH` hard constraint).
- Each of the 70 (`10 personas × 7 projects`) test users gets exactly **2 wallets**. `hasSampleData` persona (only `test-alice-*` variants, 7 of them): balance `10000.00000000` on the purchased wallet; all others: `0.00000000`.
- `test-alice-*` variants each get: exactly **2 projects**, exactly **3 conversations** (each conversation gets `3 + (index % 3)` messages, i.e. 3, 4, 5 messages for conv 1/2/3), plus a `createTestPaymentData`: exactly **1** payment of amount **100** (`status: 'completed'`, `helcimTransactionId: hlcm-{name}-1`, `cardType: 'Visa'`, `cardLastFour: '4242'`) with 1 matching deposit ledger entry.
- `test-charlie-*` is the only base persona seeded with `emailVerified: false`.
- `test-2fa-*` variants: `totpEnabled: true`, `totpSecretEncrypted` populated by encrypting `TEST_2FA_TOTP_SECRET` via `deriveTotpEncryptionKey(masterSecretBytes)` + `encryptTotpSecret`.
- Total test-persona-cross-product users: `BASE_TEST_PERSONAS.length (10) × E2E_PROJECT_NAMES.length (7) = 70`.

#### 5.8 Mobile test persona — `MOBILE_TEST_PERSONA`
- A single persona **outside** the `E2E_PROJECT_NAMES` cross-product, so Maestro mobile flows can hardcode `test-mobile@test.hushbox.ai` without depending on Playwright project state.
- `name: 'test-mobile'`, `username: 'tmu'` (exactly 3 characters — the shortest legal username per the `^[a-z][a-z0-9_]{2,19}$` pattern). Comment: chosen this short because Maestro 2.6.0 spends ~10s per character on Capacitor WebView text inputs on docker-android (a documented Maestro issue, #2718), so trimming from an 11-char username to 3 chars saves ~80 seconds per `inputText` call across the mobile flows.
- `emailVerified: true`, `hasSampleData: true`, `totpSecret: null`.
- Gets 2 wallets (purchased + free_tier) and sample data (2 projects, ≥1 conversation) same as any `hasSampleData: true` test persona.
- Deterministic UUID: `seedUUID('test-user-test-mobile')`.

#### 5.9 Persona/test-user crypto — OPAQUE registration + cache
- Every seeded user gets real OPAQUE registration material (`opaqueRegistration`, `publicKey`, `passwordWrappedPrivateKey`, `recoveryWrappedPrivateKey`) generated via a shared in-process OPAQUE server (`getSharedOpaqueServer()`, cached at module scope, seeded from `OPAQUE_MASTER_SECRET`) and the real client-side `createOpaqueClient`/`startRegistration`/`finishRegistration`/`createAccount` flow, using the constant `DEV_PASSWORD` for every persona.
- `OPAQUE_SERVER_IDENTIFIER` is passed to both registration init and finish.
- A crypto-generation **cache** (`loadPersonaCryptoFromCache()` / `ensurePersonaCrypto`) avoids regenerating this (comparatively expensive) OPAQUE material on every seed run: cache dir `scripts/.cache/seed-crypto`, keyed by a fingerprint of `packages/crypto/src` (`computeCryptoFingerprint`), `CACHE_VERSION`, the resolved master secret, and each persona's `credentialIdentifier`/`password`. All dev, test, and mobile personas are included in the cache request list.
- `resolveOpaqueMasterSecret()`: prefers `process.env.OPAQUE_MASTER_SECRET` if non-empty, else falls back to `resolveRaw(envConfig.OPAQUE_MASTER_SECRET, Mode.Development)`.

#### 5.10 Upsert mechanics
- `TRACKED_TABLE_OBJECTS`: the fixed list of 14 tables the seed writes to — `users, conversations, messages, contentItems, projects, payments, wallets, ledgerEntries, epochs, epochMembers, conversationMembers, usageRecords, llmCompletions, conversationSpending`. Comment notes this list is intentionally load-bearing for two other places: `bulkUpsert`'s type parameter (`TrackedTable`) and an `ensure-stack-cli` script that derives SQL identifiers for a `__stack_meta` trigger/TRUNCATE step — adding a table to seeding requires updating both sides or getting a compile error.
- `upsertEntity(db, table, data)`: select-by-id; if 0 rows, `INSERT` and return `'created'`; else `UPDATE` (excluding `id` from the SET clause) and return `'updated'`. (Simple, non-batched — used directly only by its own unit tests; production seeding uses `bulkUpsert`.)
- `bulkUpsert(db, table, entities)`: batches of **500** rows (`BULK_UPSERT_BATCH_SIZE`) per multi-row `INSERT ... ON CONFLICT (id) DO UPDATE SET <every column except id> = excluded.<column>`. Comment: batching keeps each statement under Postgres's 65,535-bound-parameter limit on wide tables; a single multi-row upsert avoids N sequential round-trips at the cost of losing the created-vs-updated distinction (both reported together as one `total`). Empty input returns `{ total: 0 }` without issuing a query.
- `seed()` writes in this fixed dependency order: 1) persona users + random filler users, 2) wallets, 3) projects, 4) conversations, 5) conversation members, 6) epochs, 7) epoch members, 8) messages, 8b) content items, 9) usage records, 10) LLM completions, 11) conversation spending, 12) payments, 13) ledger entries — each step's console log reports `"{Entity}: {total} upserted"`.
- Every generated collection (`data` random filler, `personaData`, `testPersonaData`) is concatenated together per table before each `bulkUpsert` call.

### 6. Crypto-cache warming script (`scripts/legacy_seed-cache.ts`)

- Standalone CLI entry point (guarded by `isMainModule(import.meta.url)`, run via `runMain`) that pre-warms the same persona-crypto cache the main seed script reads.
- `enumerateAllPersonaRequests()`: builds the full request list — one entry per `DEV_PERSONAS` member (credential id `` dev-user-${name} ``), one per `TEST_PERSONAS` member (credential id `` test-user-${name} ``), plus one for `MOBILE_TEST_PERSONA` (credential id `test-user-test-mobile`) — all using `DEV_PASSWORD`. Total request count = `DEV_PERSONAS.length + TEST_PERSONAS.length + 1` (confirmed by test).
- `refreshCache({ cacheDir, cryptoDir, masterSecret, runChunk?, workerCount? })` (`RefreshCacheResult = { hits, misses, total }`): for each requested persona, checks the on-disk cache entry (keyed by `cacheKey({ cacheVersion: CACHE_VERSION, cryptoFingerprint, masterSecret, password, credentialIdentifier })`); cache hits are not regenerated, misses are computed via the chunk runner (real OPAQUE registration work, parallelizable via `workerCount`) and written back.
- CLI output format: `` `seed:cache: {hits}/{total} hot, {misses} regenerated in {elapsed}` ``, where `elapsed` is formatted as `{ms}ms` if under 1000ms else `{seconds.toFixed(1)}s`.
- Default paths: `DEFAULT_CACHE_DIR = scripts/.cache/seed-crypto`, `DEFAULT_CRYPTO_DIR = packages/crypto/src` — identical to the main seed script's constants (kept independently in each file, not imported from a shared module).

### 7. Notable documented limitation

The seed script's file header explicitly documents: media bytes are **not** seeded into MinIO. Only `contentType: 'text'` rows are generated by `generateSeedData()`/persona/test-persona paths — there are no seeded image/video/audio content items, so no encrypted blobs are ever uploaded to the local MinIO bucket by this script. (The `/dev/media-conversation` **route**, by contrast — §1/§4 above — does seed one real encrypted media blob into MinIO/R2 per call, since it goes through `createDevMediaConversation` rather than the bulk seed generators.) The stated workaround for exercising media locally is to run a real chat flow through the production media pipeline.


---

## 12. Core Infra Utilities

Report on `apps/api/src/legacy/lib/`: stream-error classification, DB helpers, error diagnostics/response formatting, evidence config, fire-and-forget, AI gateway config, processed-catalog memoization, rate limiting, the Redis key registry, the Redis client factory, and unique-violation detection.

### Stream error classification (`classify-stream-error.ts`)

`classifyStreamErrorCode(error: unknown): string` maps any thrown value to one machine-readable API error code. It lives in its own module specifically so both `stream-pipeline.ts` and `multi-stream.ts` can import it without creating a module cycle.

Classification order (first match wins — the function returns as soon as a rule matches):

1. **Non-`Error` values** → `ERROR_CODE_STREAM_ERROR`. Anything not an `instanceof Error` (string, null, number, etc.) short-circuits immediately to this code.
2. **Context length** — `error.message.includes('context length')` → `ERROR_CODE_CONTEXT_LENGTH_EXCEEDED`. Checked before every other rule, so it wins even if the same message also contains "rate limit" text with a 429 status.
3. **Fork-tip conflict** — `error.name === 'ForkTipConflictError'` → `ERROR_CODE_FORK_TIP_CONFLICT`. Wins over content-policy text matches even when both are present.
4. **Unique violation** — delegates to `isUniqueViolation(error)` (see below) → `ERROR_CODE_DUPLICATE_MESSAGE`.
5. **Rate limit** — `isRateLimitError`: true if extracted HTTP status is exactly `429`, OR `error.message.toLowerCase()` contains `'rate limit'` or `'429'` → `ERROR_CODE_RATE_LIMITED`.
6. **Content policy** — `isContentPolicyError`: message (lowercased) contains any of `'content policy'`, `'safety'`, `'moderation'`, `'harmful'` → `ERROR_CODE_CONTENT_POLICY`.
7. **Provider billing** — `isProviderBillingError`: status is `401`, `402`, or `403`, OR message contains `'insufficient credits'` → `ERROR_CODE_PROVIDER_BILLING`.
8. **Network error** — `isNetworkError`: `error.name === 'AbortError'`, OR `error instanceof TypeError` with message containing `'fetch failed'`, OR (fallback for shims that rethrow as plain `Error`) message contains `'fetch failed'` regardless of type → `ERROR_CODE_NETWORK_ERROR`.
9. **AI SDK errors** — `isAiSdkError`: `error.name` starts with `'AI_'` (e.g. `AI_APICallError`, `AI_RetryError`) or equals `'AISDKError'` → `ERROR_CODE_INFERENCE_FAILED`. This catches any Vercel AI SDK error that didn't match a more specific bucket above.
10. **Last-resort catch-all** — anything else (a plain non-SDK `Error`) → `ERROR_CODE_STREAM_ERROR`.

`extractStatusCode(error)` reads, in order, `error.status`, `error.statusCode`, `error.response?.status`, returning the first value that is a finite `number`; `undefined` if none match.

### DB helpers (`db-helpers.ts`)

`ResourceNotFoundError extends Error` — constructed as `new ResourceNotFoundError(resource)`, sets `message` to `` `${resource} not found` `` and `name` to `'ResourceNotFoundError'`.

- `getOwnedConversation(db, conversationId, userId)` — selects from `conversations` where `id = conversationId AND userId = userId`; throws `ResourceNotFoundError('Conversation')` (message `"Conversation not found"`) if no row matches (covers both nonexistent id and existing-but-not-owned).
- `getOwnedPayment(db, paymentId, userId)` — selects from `payments` where `id = paymentId AND userId = userId`; throws `ResourceNotFoundError('Payment')` (message `"Payment not found"`) on no match.
- `findActiveMember(db, memberId, conversationId)` — selects `{id, privilege, userId}` from `conversationMembers` where `id = memberId AND conversationId = conversationId AND leftAt IS NULL`, `LIMIT 1`; returns `undefined` (not a throw) when no row matches.
- `findActiveSharedLink(db, conversationId, linkPublicKey)` — selects `{id, displayName}` from `sharedLinks` where `conversationId = conversationId AND linkPublicKey = linkPublicKey AND revokedAt IS NULL`, `LIMIT 1`; returns `undefined` when no row matches.

### Error diagnostics (`error-diagnostics.ts`)

`extractErrorDiagnostics(err, options?)` walks an error's `cause` chain and serializes each layer into a flat, log-safe object, because Cloudflare Workers' default console serializer only prints `name`/`message`/`stack` and drops other enumerable properties. Used by `writeStreamErrorFromException` so one log line captures a full SDK error chain (e.g. V8 SyntaxError → JSONParseError → APICallError → GatewayResponseError).

Defaults: `DEFAULT_MAX_DEPTH = 5`, `DEFAULT_MAX_BODY_CHARS = 1024`. Both overridable via `options.maxDepth` / `options.maxBodyChars`.

Per-layer output shape (`ErrorDiagnosticLayer`): `{ name, message, statusCode?, url?, bodyPreview? }`.

- `name` — read via `readStringProperty(candidate, 'name')`, defaulting to `'Unknown'` if absent or if the key matches the sensitive-property pattern.
- `message` — read the same way; if absent/non-string, falls back to `stringifyNonError(candidate['message'])`.
- `statusCode` — only included if `readNumberProperty(candidate, 'statusCode')` yields a finite number.
- `url` — only included if a string `url` property exists; query strings are stripped via `stripQueryString` (everything from `?` onward is cut) as a defense against leaking API keys embedded in URLs.
- `bodyPreview` — read from `responseBody` first, falling back to `text` if `responseBody` is absent (comment: `responseBody` wins because it's "closer to the wire" — this covers APICallError vs JSONParseError shapes respectively). Truncated via `truncate(value, maxBodyChars)`: if `value.length > maxBodyChars`, sliced to `maxBodyChars` and suffixed with `'…'` (one ellipsis character, making output length `maxBodyChars + 1`).

Sensitive-property redaction: `SENSITIVE_PROPERTY_PATTERN = /prompt|secret|token|apikey|cookie|authorization/i` (case-insensitive). Any candidate key matching this regex is skipped entirely by both `readStringProperty` and `readNumberProperty` — this is how `requestBodyValues`, `responseHeaders`, `apiKey`, `secret`, `cookie`, and any `PROMPT`-cased key are excluded, regardless of casing.

Traversal: loops up to `maxDepth` iterations. Each iteration extracts a layer from `current`, pushes it, and if `cause` is non-null moves `current = cause` for the next iteration; if `cause` is `null` it breaks early (no `truncated` flag set). If the loop reaches `depth + 1 === maxDepth` while a `cause` still remains pending, `truncated` is set to `true` in the returned `{ layers, truncated }`. This bounds cyclic cause chains (e.g. `a.cause = b; b.cause = a`) — with `maxDepth: 3`, exactly 3 layers are returned and `truncated: true`.

Non-object/non-Error inputs (`null`, a string, a number) produce a single layer `{ name: 'Unknown', message: stringifyNonError(current) }` with no further traversal. `stringifyNonError` returns `'null'` for `null`, `'undefined'` for `undefined`, the value itself for strings, `String(value)` for number/boolean/bigint, else attempts `JSON.stringify` (falling back to `typeof value` on stringify failure or `undefined` result).

### Error response formatting (`error-response.ts`)

- `createErrorResponse(code, details?)` — returns `{ code }`, adding a `details` key only when `details !== undefined` (so `details: undefined` is never present as an explicit key — `'details' in response` is `false` when omitted).
- `errorJson(code, status = 400, details?)` — wraps `createErrorResponse` in `Response.json(body, { status, headers: { 'Content-Type': 'application/json' } })`. Default HTTP status is `400` when not specified.

Both are documented as backing the `{ code, details? }` API error format, with the frontend mapping `code` to a user message via `legacyFriendlyErrorMessage()`.

### Evidence config (`evidence-config.ts`)

`createEvidenceConfig(c: Context<AppEnv>): EvidenceConfig` bundles `{ db: c.get('db'), isCI: envUtils.isCI }` for any external-service factory middleware that records CI evidence after a successful real API call (named callers: `aiClientMiddleware`, `helcimMiddleware`). It reads `envUtils` from Hono context via `c.get('envUtils')`.

Fail-fast behavior: if `envUtils` is `undefined` on the context (i.e. `envMiddleware()` was never run), it throws `Error('createEvidenceConfig requires envUtils — run envMiddleware() or call createEnvUtilities(c.env) in test setup')`. The comment notes this is real runtime defense, not dead code, because tests that bypass the middleware chain genuinely hit this path. The write itself is gated downstream by `recordServiceEvidence`, which only records evidence when `isCI === true`; this helper only collects the inputs.

### Fire-and-forget (`fire-and-forget.ts`)

`fireAndForget<T>(promise, errorContext, executionCtx?): void` — runs a promise without awaiting it in the caller, catching any rejection and logging `console.error('[fire-and-forget] ' + errorContext + ':', error)` (works for both `Error` rejections and non-`Error` rejection values, e.g. a rejected string). Documented use cases: WebSocket broadcast events, push notifications, background cleanup tasks.

If `executionCtx` (a Cloudflare Workers execution context exposing `waitUntil(p)`) is supplied, the wrapped/handled promise is registered via `executionCtx.waitUntil(handled)` so the isolate is kept alive until the operation completes, without blocking synchronous execution. If `executionCtx.waitUntil` itself throws (e.g. `executionCtx` unavailable outside the Workers runtime), the throw is caught and silently swallowed with a comment noting the reason. The function itself always returns `void` (does not return the promise or its result); `void handled` at the end is a lint-satisfying no-op after the promise has already been kicked off.

### Gateway config (`gateway-config.ts`)

Two fail-fast environment accessors reading from `Bindings`, each throwing a descriptive `Error` (no silent fallback) when the corresponding binding is falsy:

- `requireCatalogConfig(env)` → `{ publicModelsUrl: env.PUBLIC_MODELS_URL }`; throws `Error('PUBLIC_MODELS_URL required')` if `env.PUBLIC_MODELS_URL` is missing. `PUBLIC_MODELS_URL` is documented as powering `fetchModels`, described as "the only catalog source."
- `requireInferenceConfig(env)` → `{ apiKey: env.AI_GATEWAY_API_KEY }`; throws `Error('AI_GATEWAY_API_KEY required')` if `env.AI_GATEWAY_API_KEY` is missing. `AI_GATEWAY_API_KEY` is documented as required for inference calls: `streamText`, `generateImage`, `experimental_generateVideo`, `getGenerationInfo`. The comment notes the catalog path (above) no longer reads this key — the two configs are deliberately split.

### Processed catalog memoization (`processed-catalog.ts`)

`getProcessedCatalog(c: Context<AppEnv>): Promise<ProcessedModels>` — per-request memoized accessor over `processModels(raw)` (the ZDR filter + percentile classification + premium detection + Smart Model synthesis pipeline), because several callers within one chat request all need its output: the chat route's tier gate, billing resolution, stream-pipeline's Smart Model staging, and the models route.

Implementation: a module-level `WeakMap<Context<AppEnv>, Promise<ProcessedModels>>`. First call for a given `Context` object calls `c.var.aiClient.listRawModels()` then `processModels(raw)`, stores the resulting `Promise` (not yet resolved) in the map keyed by that exact `Context` instance, and returns it. Subsequent calls with the *same* `Context` object return the identical cached `Promise` instance (verified: same-object identity, not just equal value) without a second call to `listRawModels()`. Different `Context` objects (i.e. different requests) get independent caches — no cross-request bleed, since `WeakMap` keys by object identity.

Rejections are cached too: if the initial `listRawModels()` call rejects, that same rejected `Promise` is returned on every subsequent call within the same request — the upstream gateway is not re-hit; each request gets exactly "one shot" at the catalog.

### Rate limiting (`rate-limit.ts`)

Generic sliding-window-style (fixed-window-with-reset) rate limiter and lockout system built on top of `REDIS_REGISTRY`.

- `RateLimitConfig`: `{ maxAttempts: number; windowSeconds: number; lockoutSeconds?: number }`.
- `RateLimitResult`: `{ allowed: boolean; remaining: number; retryAfterSeconds?: number }`.
- `LockoutResult`: `{ lockedOut: false } | { lockedOut: true; retryAfterSeconds: number }`.
- `createRateLimiter(config)` — trivial wrapper returning `{ config }`.

**`checkRateLimit(redis, keyName, ...buildKeyArgs)`** — checks (without necessarily persisting a failed attempt) whether the caller is within budget:
- Throws `Error('Key ${keyName} is not a rate limit key')` if the registry entry lacks `rateLimitConfig`.
- No stored data → writes `{ count: 1, firstAttempt: Date.now() }` and returns `{ allowed: true, remaining: maxAttempts - 1 }`.
- Stored data present but `now > firstAttempt + windowSeconds * 1000` (window expired) → resets to `{ count: 1, firstAttempt: now }`, returns `{ allowed: true, remaining: maxAttempts - 1 }`.
- Stored `data.count >= maxAttempts` (within window) → returns `{ allowed: false, remaining: 0, retryAfterSeconds: ceil((windowExpiry - now) / 1000) }` — does NOT increment the counter further.
- Otherwise (within window, under the cap) → increments count by 1, writes with `ttlOverride` set to the exact remaining window (`ceil((windowExpiry - now)/1000)`) so the Redis key expires exactly when the window ends rather than at the registry's default full TTL, returns `{ allowed: true, remaining: maxAttempts - newCount }`.

**`recordFailedAttempt(redis, rateLimitKeyName, ...args, lockoutKeyName?)`** — unconditionally records a failed attempt (used for auth-style "count only on failure, clear on success" flows) and optionally triggers a lockout:
- The last variadic argument is inspected: if it's a string in `LOCKOUT_KEY_NAMES` (`'loginLockout'`, `'twoFactorLockout'`, `'recoveryLockout'`, `'deleteAccountLockout'`), it's treated as the optional lockout key and stripped from the args used to build the rate-limit key.
- Throws the same "not a rate limit key" error if `rateLimitKeyName`'s entry lacks `rateLimitConfig`.
- If no stored data: `{ count: 1, firstAttempt: Date.now() }`.
- If stored and window expired: resets to `{ count: 1, firstAttempt: now }`.
- If stored and window active: `{ count: existing.count + 1, firstAttempt: existing.firstAttempt }` (this write is NOT capped at `maxAttempts` — count can exceed it).
- Always writes the new data via `redisSetRateLimitData` (using the registry's default TTL, no `ttlOverride`).
- If a lockout key was supplied AND `data.count >= config.maxAttempts`: sets the lockout key's value to `String(Date.now() + lockoutEntry.ttl * 1000)` (i.e. the lockout key's own registry TTL, in seconds, converted to a future millisecond timestamp) via `redisSet`, and returns `{ lockoutTriggered: true }`. Otherwise returns `{ lockoutTriggered: false }`.

**`isLockedOut(redis, lockoutKeyName, ...args)`** — reads the lockout key's stored value (a stringified millisecond timestamp), returns `{ lockedOut: false }` if absent or if `Date.now() >= lockoutUntil`; otherwise returns `{ lockedOut: true, retryAfterSeconds: ceil((lockoutUntil - now)/1000) }`.

**`clearLockout(redis, lockoutKeyName, ...args, rateLimitKeyName?)`** — deletes the lockout key; if the last arg is a valid `REDIS_REGISTRY` key name it also deletes that rate-limit counter key (so clearing a lockout can simultaneously reset the underlying attempt counter, e.g. on successful login).

**Dual (email + IP) rate limiting:**
- `checkDualRateLimit({redis, userKeyName, ipKeyName, userIdentifier, ipHash})` — checks the user-keyed limit first; if not allowed, returns that result immediately (IP limit is not even checked). Otherwise checks the IP-keyed limit; if not allowed, returns that. If both allowed, returns `{ allowed: true, remaining: min(userResult.remaining, ipResult.remaining) }`.
- `recordDualFailedAttempt({redis, userKeyName, ipKeyName, userIdentifier, ipHash, lockoutKeyName?})` — records a failed attempt on the user key (with `lockoutKeyName` passed through if provided, enabling lockout only on the user-identifier side) AND unconditionally records a failed attempt on the IP key (never triggers lockout via the IP key itself — no lockout key passed for that call). Returns `{ lockoutTriggered: <from the user-key call only> }`.

### Redis key registry (`redis-registry.ts`)

Central typed registry (`REDIS_REGISTRY`) of every Redis key pattern in the legacy system, each entry built via `defineKey({schema, ttl, buildKey})` or, for rate-limit-tracked keys, `defineRateLimitKey({schema, ttl, buildKey, rateLimitConfig: {maxAttempts, windowSeconds, lockoutSeconds?}})`. `rateLimitDataSchema = z.object({ count: z.number(), firstAttempt: z.number() })`.

#### Rate-limit keys (all use `rateLimitDataSchema`)

| Key name | Pattern | TTL (s) | maxAttempts | windowSeconds |
|---|---|---|---|---|
| `loginUserRateLimit` | `login:user:ratelimit:${identifier.toLowerCase()}` | 900 | 5 | 900 |
| `loginIpRateLimit` | `login:ip:ratelimit:${ipHash}` | 900 | 20 | 900 |
| `registerEmailRateLimit` | `register:email:ratelimit:${email.toLowerCase()}` | 3600 | 3 | 3600 |
| `registerIpRateLimit` | `register:ip:ratelimit:${ipHash}` | 3600 | 10 | 3600 |
| `twoFactorUserRateLimit` | `2fa:user:ratelimit:${userId}` | 900 | 10 | 900 |
| `deleteAccountUserRateLimit` | `delete-account:user:ratelimit:${userId}` | 3600 | 3 | 3600 |
| `recoveryUserRateLimit` | `recovery:user:ratelimit:${identifier.toLowerCase()}` | 3600 | 3 | 3600 |
| `recoveryIpRateLimit` | `recovery:ip:ratelimit:${ipHash}` | 3600 | 10 | 3600 |
| `recoveryGetKeyUserRateLimit` | `recovery:getkey:user:ratelimit:${identifier.toLowerCase()}` | 3600 | 3 | 3600 |
| `recoveryGetKeyIpRateLimit` | `recovery:getkey:ip:ratelimit:${ipHash}` | 3600 | 10 | 3600 |
| `verifyTokenRateLimit` | `verify:token:ratelimit:${token}` | 3600 | 10 | 3600 |
| `verifyIpRateLimit` | `verify:ip:ratelimit:${ipHash}` | 3600 | 30 | 3600 |
| `resendVerifyEmailRateLimit` | `resend-verify:email:ratelimit:${email.toLowerCase()}` | 60 | 1 | 60 |
| `resendVerifyIpRateLimit` | `resend-verify:ip:ratelimit:${ipHash}` | 60 | 5 | 60 |
| `chatStreamUserRateLimit` | `chat:stream:user:ratelimit:${userId}` | 60 | 30 | 60 |
| `mediaDownloadUserRateLimit` | `media:download:user:ratelimit:${userId}` | 60 | 60 | 60 |
| `shareGetIpRateLimit` | `share:get:ip:ratelimit:${ipHash}` | 60 | 30 | 60 |
| `shareCreateUserRateLimit` | `share:create:user:ratelimit:${userId}` | 60 | 20 | 60 |
| `trialChatStreamIpRateLimit` | `trial:chat:stream:ip:ratelimit:${ipHash}` | 60 | 20 | 60 |
| `roadmapIpRateLimit` | `roadmap:ip:ratelimit:${ipHash}` | 60 | 30 | 60 |

In-code rationale comments (verbatim intent, not evaluation):
- `chatStreamUserRateLimit`: "Per-user cap on AI Gateway calls. The bottleneck is the gateway itself, so a user-level cap is sufficient — IP-level adds little when the worst offender is an authenticated user repeatedly invoking inference."
- `mediaDownloadUserRateLimit`: "Per-user cap on presigned URL minting. Minting is cheap, but a flood could DOS the signing path (R2 SigV4 / KMS) — cap at 60/min/user."
- `shareGetIpRateLimit`: "Per-IP cap on the UNAUTHENTICATED public share lookup endpoint. Throttle to slow down share-id scraping/scanning."
- `shareCreateUserRateLimit`: "Per-user cap on share creation — each request inserts a DB row."
- `trialChatStreamIpRateLimit`: "Per-IP burst cap on the UNAUTHENTICATED trial chat stream. The daily message-count cap (consumeTrialMessage) limits total spend, but a burst of requests under the daily cap can still flood Redis / the AI gateway before the daily counter saturates. 20/60s is generous for trial UX while throttling pathological floods."
- `roadmapIpRateLimit`: "Per-IP cap on the UNAUTHENTICATED public roadmap endpoint. The response is heavily cached (1h Redis + 5min CDN edge) so this primarily caps scrape-style traffic that bypasses the edge cache by varying headers. 30/60s aligns with shareGetIpRateLimit; a marketing roadmap page does not refresh that frequently in normal use."

#### Lockout keys (schema: `z.coerce.string()`, storing a stringified future-timestamp)

| Key name | Pattern | TTL (s) |
|---|---|---|
| `loginLockout` | `login:lockout:${identifier.toLowerCase()}` | 900 |
| `twoFactorLockout` | `2fa:lockout:${userId}` | 900 |
| `recoveryLockout` | `recovery:lockout:${identifier.toLowerCase()}` | 3600 |
| `deleteAccountLockout` | `delete-account:lockout:${userId}` | 86400 (`24 * 60 * 60`) |

#### OPAQUE handshake state keys

All six OPAQUE handshakes key by a server-issued `sessionId` (UUID), not by identifier/userId — the identifier/userId is stored in the value instead. Comment explains: per-identifier keying previously caused a race where two concurrent handshakes for the same user clobbered each other's `expected` value in Redis, breaking both; sessionId-keying matches how RFC-compliant PAKE implementations track per-handshake state. Also framed as defense-in-depth against a stolen session token being used with a different account.

| Key name | Pattern | TTL (s) | Value schema fields |
|---|---|---|---|
| `opaquePendingRegistration` | `opaque:pending:${sessionId}` | 300 | `email, username, userId, existing?` |
| `opaquePendingLogin` | `opaque:login:${sessionId}` | 120 | `identifier, userId (nullable), expectedSerialized: number[]` |
| `opaquePendingChangePassword` | `opaque:change-pw:${sessionId}` | 300 | `userId, expectedSerialized: number[]` |
| `opaquePending2FADisable` | `opaque:2fa-disable:${sessionId}` | 300 | `userId, expectedSerialized: number[]` |
| `opaquePendingDeleteAccount` | `opaque:delete-account:${sessionId}` | 300 | `userId, expectedSerialized: number[]` (same shape as change-password) |
| `opaquePendingRecoveryReset` | `opaque:recovery-reset:${sessionId}` | 300 | `identifier` |

Note the login handshake TTL (120s) is shorter than the other five (300s each).

#### TOTP state keys

| Key name | Pattern | TTL (s) | Value |
|---|---|---|---|
| `totpPendingSetup` | `totp:pending:${userId}` | 300 | `{ secret, encryptedBlob: number[] }` |
| `totpUsedCode` | `totp:used:${userId}:${code}` | 120 | `z.coerce.string()` |

Test asserts `totpUsedCode.ttl >= 120`, with comment: "3 time steps × 30s + buffer" covers a ±30s TOTP epoch tolerance window.

#### Trial usage keys

| Key name | Pattern | TTL (s) | Value |
|---|---|---|---|
| `trialTokenUsage` | `trial:token:${trialToken}` | 86400 | `z.coerce.number()` |
| `trialIpUsage` | `trial:ip:${ipHash}` | 86400 | `z.coerce.number()` |

#### Speculative balance reservation keys

| Key name | Pattern | TTL (s) | Value |
|---|---|---|---|
| `chatReservedBalance` | `chat:reserved:${userId}` | 180 | `z.coerce.number()` |
| `groupMemberReserved` | `chat:group-reserved:${conversationId}:${memberId}` | 180 | `z.coerce.number()` |
| `conversationReserved` | `chat:conversation-reserved:${conversationId}` | 180 | `z.coerce.number()` |

#### Other keys

| Key name | Pattern | TTL (s) | Value |
|---|---|---|---|
| `billingLoginToken` | `billing:login-token:${token}` | 60 | `{ userId }` |
| `roadmapCache` | `roadmap:${teamKey.toLowerCase()}:${schemaVersion}` | 3600 (`60 * 60`) | `roadmapResponseSchema` |
| `sessionActive` | `sessions:user:active:${userId}:${sessionId}` | `SESSION_MAX_AGE_SECONDS` = 2,592,000 (30 days, `60*60*24*30`, from `session.ts`) | `z.coerce.string()` |
| `passwordChangedAt` | `auth:pw-changed:${userId}` | `SESSION_MAX_AGE_SECONDS` = 2,592,000 | `z.coerce.number()` |

`roadmapCache` key comment: key includes a literal `schemaVersion` segment so that when the response shape changes, bumping the version prevents old isolates from serving stale-schema data under the same key.

#### Registry accessor functions

- `redisGet(redis, keyName, ...buildKeyArgs)` — builds the key, calls `redis.get`, returns `null` if the stored value is `null`, otherwise validates/coerces through `entry.schema.parse(stored)` and returns the parsed value. Throws (via Zod) if the stored shape doesn't match the schema.
- `redisSet(redis, keyName, value, ...buildKeyArgs, options?: {ttlOverride?})` — the trailing argument is inspected for an object with a `ttlOverride` key to detect an optional `SetOptions`; validates `value` via `entry.schema.parse(value)` **before** writing (a validation failure throws and `redis.set` is never called); writes via `redis.set(key, value, { ex: ttlOverride ?? entry.ttl })`.
- `redisSetRateLimitData(redis, keyName, value, ...args, options?)` — type-narrowed variant of `redisSet` restricted to rate-limit keys, whose schema is always `rateLimitDataSchema`; same TTL-override and validate-then-write semantics.
- `redisDel(redis, keyName, ...buildKeyArgs)` — builds the key and calls `redis.del(key)`.
- `redisIncrByFloat(redis, keyName, increment, ...buildKeyArgs)` — atomically increments a float-valued key via a Lua script (`INCR_BY_FLOAT_SCRIPT`) executed with `redis.eval`. Script: `INCRBYFLOAT` the key by `ARGV[1]`; if the resulting value is `<= 0`, `DEL` the key and return `"0"`; otherwise `EXPIRE` the key to `ARGV[2]` seconds (the registry's `entry.ttl`, always the key's static TTL — never overridable) and return the new value. The JS wrapper coerces the Lua-returned string to a `number` via `Number(result)`. Used (per test evidence) for `chatReservedBalance` with TTL 180s, decrementing/zeroing a speculative hold once a run settles.

### Redis client factory (`redis.ts`)

`createRedisClient(url, token): Redis` — a one-line wrapper: `new Redis({ url, token })` from `@upstash/redis`. No additional configuration, retry policy, or wrapping logic.

### Unique-violation detection (`unique-violation.ts`)

Detects Postgres unique-violation errors (SQLSTATE `23505`) as wrapped by Drizzle's `DrizzleQueryError`, which nests the original postgres-js/Neon driver error under `.cause`; the `constraint` and `code` fields live on that cause. The cause chain is walked (not just `.cause` once) specifically because "future Drizzle versions could add another wrapping layer."

`getUniqueViolationConstraint(error: unknown): string | null` returns one of three outcomes:
- **A constraint name** (e.g. `'users_username_unique'`, `'users_email_unique'`) when some layer in the chain has `code === '23505'` AND a string `constraint` field — callers can then discriminate collision type (e.g. username vs email).
- **Empty string `''`** when a unique violation was detected but no specific constraint name is available — either because `code === '23505'` but `constraint` is missing/non-string, or because detection matched only via message-text pattern (older drivers, or mocked test errors without structured fields). Callers must treat `''` as "unknown which constraint" and fall back to generic handling.
- **`null`** when the error is not a unique violation at all (including non-object inputs, or a different SQLSTATE code such as `23503` foreign-key violation).

Message-text fallback patterns (`UNIQUE_VIOLATION_MESSAGE_PATTERNS`, matched via `.includes()` case-sensitively): `'duplicate key'`, `'unique constraint'`, `'conversation_forks_conv_name_idx'`. The last pattern is specifically listed because the forks table's unique index has an explicit name (not Drizzle's generated `_unique` suffix), and some driver paths surface only the index name in the message with no structured `constraint` field.

Traversal is capped at `MAX_CAUSE_DEPTH = 16` — a guard against a pathologically circular cause chain, chosen (per comment) because "real wraps are 1-2 deep," and using a fixed depth cap avoids the cost of a `Set`-based cycle detector. Per iteration: if `value.code === '23505'`, either return the constraint (if a string) or mark `detectedWithoutConstraint = true` and continue; else if `value.message` is a string matching one of the three text patterns, mark `detectedWithoutConstraint = true` and continue; else this layer contributes nothing, move to `value.cause`. After the loop, returns `''` if `detectedWithoutConstraint` was ever set, else `null`.

`isUniqueViolation(error): boolean` — `getUniqueViolationConstraint(error) !== null` (i.e. both the constraint-name and empty-string outcomes count as "is a unique violation"; only `null` counts as "is not").

### Cross-references observed while reading

- `classify-stream-error.ts` imports `isUniqueViolation` from `unique-violation.ts` directly (both in this scope), confirming the classification module treats "duplicate message" as a specific stream-error subtype distinct from generic inference failures.
- `redis-registry.ts` imports `SESSION_MAX_AGE_SECONDS` from `./session.js` (outside this scope, value = 2,592,000s / 30 days) for both `sessionActive` and `passwordChangedAt` TTLs, and `roadmapResponseSchema` from `@hushbox/shared` for the `roadmapCache` value schema.
- `rate-limit.ts` and `redis-registry.ts` are tightly coupled: `checkRateLimit`/`recordFailedAttempt` type-parameterize over `RateLimitKeyName`, a mapped type filtering `REDIS_REGISTRY` to only entries carrying `rateLimitConfig`; `isLockedOut`/`clearLockout` type-parameterize similarly over the four literal `LockoutKeyName` values.

