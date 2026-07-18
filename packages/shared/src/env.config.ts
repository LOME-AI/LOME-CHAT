import { z } from 'zod';
import { ref, secret, Destination, Mode, type VariableConfig } from './env-types.js';
import { VALID_PLATFORMS } from './platform.js';

export * from './env-types.js';

/**
 * Environment configuration with typed values.
 *
 * Each var has:
 * - `to`: Default destinations for this var
 * - Per-mode values: `Mode.Development`, `Mode.CiVitest`, `Mode.E2E`, `Mode.CiE2E`, `Mode.Production`
 *
 * Value types:
 * - `'literal'`                    - Use this exact string
 * - `ref(Mode.X)`                  - Use same value as another mode
 * - `secret('NAME')`               - Read from GitHub secret at runtime
 * - `{ value: ..., to: [...] }`    - Override destinations for this mode
 *
 * Destinations:
 * - `Destination.Backend`  → .dev.vars (local) / wrangler.toml + secrets (prod)
 * - `Destination.Frontend` → .env.development (Vite, VITE_* vars only)
 * - `Destination.Scripts`  → .env.scripts (migrations, seed, etc.)
 * - `Destination.Ops`      → ops runner env blocks only (ci.yml ops-env +
 *                            run-ops-script.yml ops-dispatch-env); never
 *                            wrangler secret put / runtime Worker
 */
export const envConfig = {
  // Backend + Scripts in dev (seed.ts needs it), Backend only in CI/prod
  DATABASE_URL: {
    to: [Destination.Backend],
    [Mode.Development]: {
      value: 'postgres://postgres:postgres@localhost:4444/hushbox',
      to: [Destination.Backend, Destination.Scripts],
    },
    [Mode.CiVitest]: ref(Mode.Development), // Backend only (uses default `to`)
    [Mode.E2E]: ref(Mode.Development), // Backend only (uses default `to`)
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('DATABASE_URL'), // Backend only (uses default `to`)
  },

  // Backend only
  NODE_ENV: {
    to: [Destination.Backend],
    [Mode.Development]: 'development',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'production',
  },

  API_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:8788',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://api.hushbox.ai',
  },

  FRONTEND_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:5173',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://hushbox.ai',
  },

  FRONTEND_PREVIEW_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:4173',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  // The admin SPA's own origin, admitted by the CSRF Origin check (browsers
  // send Origin on all POSTs, same-origin included — without this entry every
  // production admin mutation would 403). Dev/E2E point at the local admin
  // dev server; `pnpm dev` offsets the port per-worktree.
  ADMIN_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:7000',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://admin.hushbox.ai',
  },

  CI: {
    to: [Destination.Backend],
    [Mode.CiVitest]: 'true',
    [Mode.CiE2E]: 'true',
    // NOT in E2E — local e2e is not CI
  },

  E2E: {
    to: [Destination.Backend],
    [Mode.E2E]: 'true',
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  // Redis (Upstash in prod, SRH locally)
  UPSTASH_REDIS_REST_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:8079',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('UPSTASH_REDIS_REST_URL'),
  },

  UPSTASH_REDIS_REST_TOKEN: {
    to: [Destination.Backend],
    [Mode.Development]: 'local_dev_token',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('UPSTASH_REDIS_REST_TOKEN'),
  },

  // OPAQUE master secret (derives OPRF seed, AKE keypair, TOTP encryption key)
  OPAQUE_MASTER_SECRET: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-opaque-master-secret-32-bytes-minimum',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('OPAQUE_MASTER_SECRET'),
  },

  // iron-session secret for encrypted cookies
  IRON_SESSION_SECRET: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-iron-session-secret-32-bytes-min',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('IRON_SESSION_SECRET'),
  },

  // ── Admin plane: Cloudflare Access JWT verification ──────────────────────
  // The `admin` route class verifies `Cf-Access-Jwt-Assertion` in-Worker
  // (jose): issuer `https://<CF_ACCESS_TEAM_DOMAIN>.cloudflareaccess.com`,
  // audience CF_ACCESS_AUD, actor email against ADMIN_ACTOR_ALLOWLIST —
  // fail-closed. Production resolves the real Access app's values as secrets;
  // dev/CI carry literals the dev-admin mint route signs against.
  CF_ACCESS_TEAM_DOMAIN: {
    to: [Destination.Backend],
    [Mode.Development]: 'hushbox-dev',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('CF_ACCESS_TEAM_DOMAIN'),
  },

  CF_ACCESS_AUD: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-admin-access-aud',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('CF_ACCESS_AUD'),
  },

  // Exact-match admin actor emails, comma-separated (1–3 entries; never a
  // domain-wide rule — ARCHITECTURE §Admin plane). The in-Worker check mirrors the
  // Access app's own allowlist: the belt behind the edge wall.
  ADMIN_ACTOR_ALLOWLIST: {
    to: [Destination.Backend],
    [Mode.Development]: 'admin@hushbox.test,ops@hushbox.test',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('ADMIN_ACTOR_ALLOWLIST'),
  },

  // Connection string for the SELECT-only `admin_sql_panel` Postgres role
  // (created in-chain by the admin-plane foundations migration). Dev/CI point
  // at local Postgres through the neon proxy; the role is created NOLOGIN by
  // the migration (its production login password is minted out-of-band), so
  // local login as the role additionally requires an out-of-band
  // `ALTER ROLE admin_sql_panel LOGIN PASSWORD 'admin_sql_panel'`. Production
  // is the full URL as a secret — the credential never appears in code.
  ADMIN_SQL_PANEL_DATABASE_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'postgres://admin_sql_panel:admin_sql_panel@localhost:4444/hushbox',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('ADMIN_SQL_PANEL_DATABASE_URL'),
  },

  // Cloudflare API token (Access authentication-logs read scope) for the
  // admin plane's Access-log pull cron. Dev/CI use a placeholder literal —
  // the puller is mocked locally, never a live Cloudflare call.
  CLOUDFLARE_ACCESS_LOG_API_TOKEN: {
    to: [Destination.Backend],
    [Mode.Development]: 'mock-cloudflare-access-log-token',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('CLOUDFLARE_ACCESS_LOG_API_TOKEN'),
  },

  // The Cloudflare account id the Access-log pull cron's API path embeds
  // (/accounts/{account_id}/access/logs/access_requests). Dev/CI use a
  // placeholder literal — the puller is mocked locally, never a live
  // Cloudflare call; production supplies the real id alongside the token.
  CLOUDFLARE_ACCOUNT_ID: {
    to: [Destination.Backend],
    [Mode.Development]: 'mock-cloudflare-account-id',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('CLOUDFLARE_ACCOUNT_ID'),
  },

  // The DEV-ONLY Access signing key (Ed25519 private JWK, committed — a local
  // fixture, never a production secret). The dev-admin mint route signs
  // Access-shaped JWTs with it and the admin JWT stage derives its LOCAL JWKS
  // from its public half, so the SAME jose verification path runs in every
  // mode — only the key source varies. Production deliberately carries NO
  // value: nothing deployable can mint admin access (CODE-RULES §Admin
  // Operations; asserted by test).
  CF_ACCESS_DEV_PRIVATE_JWK: {
    to: [Destination.Backend],
    [Mode.Development]:
      '{"kty":"OKP","crv":"Ed25519","alg":"EdDSA","kid":"hushbox-dev-admin","x":"5UK_KdbiPHqjbALUfCX-hQskgmFFShqwp_LTaFF9Q4I","d":"h8fBcfBOUkOF98WiWzzT-Ng7jV9sd_9WwKQ8Mjs1i9s"}',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  APP_VERSION: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-local',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('APP_VERSION'),
  },

  // Per-native-platform sha256 of the published OTA bundle, served on
  // `/updates/current` (selected by the X-HushBox-Platform header) so the
  // native client can hand it to Capgo's `download({ checksum })`, which
  // rejects a tampered/corrupt bundle before it is applied. OTA bundles are
  // built per platform (`builds/<platform>/<version>.zip`, distinct VITE_PLATFORM
  // → distinct sha256), so there is one binding per native platform.
  //
  // These carry NO per-mode value: the production sha256 does not exist until
  // each platform bundle is zipped in CI, so it is published at deploy time by
  // the "Upload mobile OTA bundles to R2" step (`wrangler secret put`), exactly
  // as APP_VERSION's real value comes from the version job — NOT a static
  // GitHub secret. A `secret()` here would make generate-env emit an empty
  // `wrangler secret put` (no such GitHub secret) into deploy-secrets before the
  // bundle sha exists. Dev/CI carry no value, so the route omits the checksum.
  APP_BUNDLE_CHECKSUM_IOS: {
    to: [Destination.Backend],
  },
  APP_BUNDLE_CHECKSUM_ANDROID: {
    to: [Destination.Backend],
  },
  APP_BUNDLE_CHECKSUM_ANDROID_DIRECT: {
    to: [Destination.Backend],
  },

  RESEND_API_KEY: {
    to: [Destination.Backend],
    [Mode.Production]: secret('RESEND_API_KEY'),
    // NOT in CI - email service uses console client when CI=true
  },

  // Signing secret for the Resend webhook receiver (Svix scheme, `whsec_`
  // prefix + standard base64). Dev/CI carry a fixed literal — never a real
  // secret — so tests can sign their own deliveries against the same
  // verification path production runs.
  RESEND_WEBHOOK_SECRET: {
    to: [Destination.Backend],
    [Mode.Development]: 'whsec_bmV3c2xldHRlci1kZXYtd2ViaG9vay1zZWNyZXQ=',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('RESEND_WEBHOOK_SECRET'),
  },

  // OpenRouter API key, consumed by the models-slice adapters
  // (createOpenRouterProvider). Production carries the production key.
  // CiVitest carries the spend-restricted key: CI records AI cassettes on a
  // miss (the first uncached call is a real charged call, replayed from the
  // Actions cache thereafter), and the restricted key also backs the real-call
  // tests that `verify:evidence --require=openrouter` asserts. Missing-secret
  // fail-fast comes from `generate:env --mode=ciVitest`, which throws when a
  // required secret is missing or empty; `verify:env` only checks registry
  // completeness, not secret values. Dev/E2E/CiE2E use the mock literal — they
  // ride cassette replay and failure fixtures only, so no secret is required
  // there.
  OPENROUTER_API_KEY: {
    to: [Destination.Backend],
    [Mode.Development]: 'mock-openrouter-key',
    [Mode.CiVitest]: secret('OPENROUTER_API_KEY_RESTRICTED'),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('OPENROUTER_API_KEY_PRODUCTION'),
  },

  // Unauthenticated public endpoint exposing per-modality pricing (per-image
  // for image models, per-second-by-resolution for video models). The SDK's
  // authenticated `/config` endpoint doesn't carry media pricing, so we merge
  // both sources. URL is stable; exposed in envConfig for per-environment
  // override (e.g., pointing at a fixture in E2E) rather than a runtime secret.
  PUBLIC_MODELS_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'https://ai-gateway.vercel.sh/v1/models',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: ref(Mode.Development),
  },

  FCM_PROJECT_ID: {
    to: [Destination.Backend],
    [Mode.Production]: secret('FCM_PROJECT_ID'),
    // NOT in dev/CI - push service uses console client
  },

  FCM_SERVICE_ACCOUNT_JSON: {
    to: [Destination.Backend],
    [Mode.Production]: secret('FCM_SERVICE_ACCOUNT_JSON'),
    // NOT in dev/CI - push service uses console client
  },

  GOOGLE_SERVICES_JSON_BASE64: {
    to: [Destination.Scripts],
    [Mode.Development]:
      'ewogICJwcm9qZWN0X2luZm8iOiB7CiAgICAicHJvamVjdF9udW1iZXIiOiAiMTAwNjQwMjYyNjAzOSIsCiAgICAicHJvamVjdF9pZCI6ICJodXNoYm94LWxvY2FsZGV2IiwKICAgICJzdG9yYWdlX2J1Y2tldCI6ICJodXNoYm94LWxvY2FsZGV2LmZpcmViYXNlc3RvcmFnZS5hcHAiCiAgfSwKICAiY2xpZW50IjogWwogICAgewogICAgICAiY2xpZW50X2luZm8iOiB7CiAgICAgICAgIm1vYmlsZXNka19hcHBfaWQiOiAiMToxMDA2NDAyNjI2MDM5OmFuZHJvaWQ6MjQ1MTRiMmRlMDEyY2MxNWEwY2VmMiIsCiAgICAgICAgImFuZHJvaWRfY2xpZW50X2luZm8iOiB7CiAgICAgICAgICAicGFja2FnZV9uYW1lIjogImFpLmh1c2hib3guYXBwIgogICAgICAgIH0KICAgICAgfSwKICAgICAgIm9hdXRoX2NsaWVudCI6IFtdLAogICAgICAiYXBpX2tleSI6IFsKICAgICAgICB7CiAgICAgICAgICAiY3VycmVudF9rZXkiOiAiQUl6YVN5QzlobVR2Rm95V05GZ0VYdDV3dW51TTlaSkRvSFdsYkVrIgogICAgICAgIH0KICAgICAgXSwKICAgICAgInNlcnZpY2VzIjogewogICAgICAgICJhcHBpbnZpdGVfc2VydmljZSI6IHsKICAgICAgICAgICJvdGhlcl9wbGF0Zm9ybV9vYXV0aF9jbGllbnQiOiBbXQogICAgICAgIH0KICAgICAgfQogICAgfQogIF0sCiAgImNvbmZpZ3VyYXRpb25fdmVyc2lvbiI6ICIxIgp9',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('GOOGLE_SERVICES_JSON_BASE64'),
  },

  HELCIM_API_TOKEN: {
    to: [Destination.Backend],
    [Mode.CiE2E]: secret('HELCIM_API_TOKEN_SANDBOX'),
    [Mode.Production]: secret('HELCIM_API_TOKEN_PRODUCTION'),
    // NOT in ciVitest or e2e - only CI e2e and production need real Helcim
  },

  // Linear read-only API key for the public /roadmap page. One key used in
  // both CI integration tests (catches Linear GraphQL schema breaks) and
  // production. NOT in Development / E2E / CiE2E — those modes use the mock
  // Linear client per the factory at apps/api/src/services/linear/index.ts.
  // A single GitHub secret name serves both CiVitest and Production because
  // there is no permission difference between CI and prod for a read-only key.
  LINEAR_API_KEY_READ: {
    to: [Destination.Backend],
    [Mode.CiVitest]: secret('LINEAR_API_KEY_READ'),
    [Mode.Production]: secret('LINEAR_API_KEY_READ'),
  },

  HELCIM_WEBHOOK_VERIFIER: {
    to: [Destination.Backend],
    [Mode.Development]: 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=', // Mock verifier for local webhook testing
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: secret('HELCIM_WEBHOOK_VERIFIER_SANDBOX'),
    [Mode.Production]: secret('HELCIM_WEBHOOK_VERIFIER_PRODUCTION'),
  },

  // R2 media storage — single S3 codepath for both reads and writes.
  // PUTs/DELETEs/LIST/presigned GET URLs all go through aws4fetch using these
  // R2 S3 API credentials. No Workers binding.
  R2_S3_ENDPOINT: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:9000',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_S3_ENDPOINT'),
  },

  R2_ACCESS_KEY_ID: {
    to: [Destination.Backend],
    [Mode.Development]: 'minioadmin',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_ACCESS_KEY_ID'),
  },

  R2_SECRET_ACCESS_KEY: {
    to: [Destination.Backend],
    [Mode.Development]: 'minioadmin',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_SECRET_ACCESS_KEY'),
  },

  R2_BUCKET_MEDIA: {
    to: [Destination.Backend],
    [Mode.Development]: 'hushbox-media-dev',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'hushbox-media',
  },

  // Which Telemetry-port sinks the API composes per request. Per-mode
  // registry values are the mechanism (no code branches on NODE_ENV):
  // dev/test/E2E modes compose the console adapter only; production composes
  // every bound sink. The composition seam fails fast on a missing or
  // unknown value — there is no default sink list.
  TELEMETRY_SINKS: {
    to: [Destination.Backend],
    [Mode.Development]: 'console',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'console,sentry,wae',
  },

  // Sentry DSN for the unexpected-error telemetry channel. Dev/test/E2E
  // disable Sentry with an EXPLICIT empty value (the sentry sink is not in
  // TELEMETRY_SINKS there, and the registry never relies on a fallback);
  // production resolves the secret, and the composition seam fails fast when
  // the sentry sink is requested without a DSN.
  SENTRY_DSN: {
    to: [Destination.Backend],
    [Mode.Development]: '',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('SENTRY_DSN'),
  },

  // R2 bucket-admin S3 credentials — separate token from the object-scoped
  // runtime credentials above. Only bucket-config ops (e.g. PutBucketCors in
  // ops/r2/configure-cors.ts) need this; the runtime Worker must NOT hold it,
  // so these go to Destination.Ops (ops runner env blocks only), never to
  // wrangler secret put. Locally the MinIO root account is admin-capable, so
  // dev/CI reuse the same minioadmin defaults as the object credentials.
  R2_ADMIN_ACCESS_KEY_ID: {
    to: [Destination.Ops],
    [Mode.Development]: 'minioadmin',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_ADMIN_ACCESS_KEY_ID'),
  },

  R2_ADMIN_SECRET_ACCESS_KEY: {
    to: [Destination.Ops],
    [Mode.Development]: 'minioadmin',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_ADMIN_SECRET_ACCESS_KEY'),
  },

  // Frontend only
  VITE_API_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://localhost:8788',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://api.hushbox.ai',
  },

  VITE_HELCIM_JS_TOKEN: {
    to: [Destination.Frontend],
    [Mode.CiE2E]: secret('VITE_HELCIM_JS_TOKEN_SANDBOX'),
    [Mode.Production]: secret('VITE_HELCIM_JS_TOKEN_PRODUCTION'),
    // NOT in e2e - only CI e2e and production need real Helcim
  },

  VITE_PLATFORM: {
    to: [Destination.Frontend],
    [Mode.Development]: 'web',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'web', // Mobile builds override via CI env
  },

  VITE_APP_VERSION: {
    to: [Destination.Frontend],
    [Mode.Development]: 'dev-local',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'set-by-ci', // All BUILD_VARIANTS override this; literal documents intent
  },

  VITE_CI: {
    to: [Destination.Frontend],
    [Mode.CiVitest]: 'true',
    [Mode.CiE2E]: 'true',
    // NOT in E2E — local e2e is not CI
  },

  VITE_E2E: {
    to: [Destination.Frontend],
    [Mode.E2E]: 'true',
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  // Drizzle Studio's hosted UI connects to a local websocket server (default
  // port 4983). `pnpm dev` offsets that port per-worktree, so each worktree
  // gets a routable URL. Dev-only — production/CI builds hide the link.
  VITE_DRIZZLE_STUDIO_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://localhost:4983',
    [Mode.E2E]: ref(Mode.Development),
  },

  // Admin SPA dev server URL for the web app's dev-only sidebar link. `pnpm
  // dev` offsets the port per-worktree. Dev-only — production admin lives on
  // admin.hushbox.ai behind Cloudflare Access, never linked from the product.
  VITE_ADMIN_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://localhost:7000',
    [Mode.E2E]: ref(Mode.Development),
  },

  // Crawler-view dev-tool origin for the dev-only "crawler-eye" badge on the
  // web app. `pnpm dev` offsets the port per-worktree. Development-only:
  // crawler-view is a local tooling server that is never deployed, and the badge
  // is gated on `env.isDevServer` (false under E2E/vitest/CI/production), so no
  // other mode needs a value — an E2E value would be baked into that dev-mode
  // build yet never read, and its `/api/crawl` fetch would trip the app CSP.
  VITE_CRAWLER_VIEW_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://localhost:7200',
  },

  // Product web-app origin for the admin SPA's admin→chat link. Defined for
  // every mode, production included, because that link must work in prod
  // (unlike the dev-only VITE_ADMIN_URL). Mirrors FRONTEND_URL's mode set;
  // `pnpm dev` offsets the local port per-worktree.
  VITE_WEB_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://localhost:5173',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://hushbox.ai',
  },

  // Scripts only
  MIGRATION_DATABASE_URL: {
    to: [Destination.Scripts],
    [Mode.Development]: 'postgresql://postgres:postgres@localhost:5432/hushbox',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
  },
} as const satisfies Record<string, VariableConfig>;

export type EnvConfig = typeof envConfig;
export type EnvKey = keyof EnvConfig;

// Zod schemas for validation
export const backendEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  API_URL: z.string().url(),
  FRONTEND_URL: z.string().url(),
  FRONTEND_PREVIEW_URL: z.string().url().optional(),
  ADMIN_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  APP_VERSION: z.string().min(1),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  HELCIM_API_TOKEN: z.string().optional(),
  HELCIM_WEBHOOK_VERIFIER: z.string().optional(),
  LINEAR_API_KEY_READ: z.string().min(1).optional(),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Redis
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  // Auth secrets
  OPAQUE_MASTER_SECRET: z.string().min(32),
  IRON_SESSION_SECRET: z.string().min(32),
  // Admin plane (Cloudflare Access). Optional here because only the admin
  // JWT stage consumes them, with its own fail-fast at first admin-classed
  // request; CF_ACCESS_DEV_PRIVATE_JWK exists in dev/CI modes only.
  CF_ACCESS_TEAM_DOMAIN: z.string().min(1).optional(),
  CF_ACCESS_AUD: z.string().min(1).optional(),
  ADMIN_ACTOR_ALLOWLIST: z.string().min(1).optional(),
  CF_ACCESS_DEV_PRIVATE_JWK: z.string().min(1).optional(),
  ADMIN_SQL_PANEL_DATABASE_URL: z.string().min(1).optional(),
  CLOUDFLARE_ACCESS_LOG_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
  // R2 media storage (S3 API credentials — full read/write scope).
  //
  // These four fields are `.optional()` here because dev and CI satisfy them
  // automatically from `envConfig`'s mode-specific defaults pointing at the
  // local MinIO emulator — engineers do not (and should not) set them in
  // their personal env files.
  //
  // In production they are REQUIRED. The runtime fail-fast guard lives in
  // `apps/api/src/services/storage/media-storage.ts:requireConfig`, which
  // throws a clear error when any of these four env vars is missing or empty
  // when the storage client is constructed. Keeping the schema permissive
  // here while delegating the production assertion to the consumer module
  // avoids a second source of truth and keeps dev/CI bootstrap clean.
  R2_S3_ENDPOINT: z.string().url().optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET_MEDIA: z.string().min(1).optional(),
});

export type BackendEnv = z.infer<typeof backendEnvSchema>;

export const frontendEnvSchema = z.object({
  // No `.default()` for VITE_PLATFORM / VITE_APP_VERSION: the generated env files
  // carry a value for every mode and api.ts forwards them, so absence means a
  // bad bootstrap and must fail fast rather than silently resolve to a default.
  VITE_API_URL: z.string().url(),
  VITE_PLATFORM: z.enum(VALID_PLATFORMS),
  VITE_APP_VERSION: z.string().min(1),
  VITE_HELCIM_JS_TOKEN: z.string().optional(),
  VITE_DRIZZLE_STUDIO_URL: z.string().url().optional(),
  VITE_ADMIN_URL: z.string().url().optional(),
  // Optional (like VITE_ADMIN_URL): the dev-only crawler-eye badge reads it
  // behind an `env.isDev` gate; it carries no production value, so a required
  // field would throw at web-app module load in prod.
  VITE_CRAWLER_VIEW_URL: z.string().url().optional(),
  // Optional (like VITE_ADMIN_URL): the admin SPA supplies it for its
  // admin→chat link, but the product web app parses only VITE_API_URL /
  // VITE_PLATFORM / VITE_APP_VERSION (apps/web/src/lib/api.ts), so a required
  // field would throw at web-app module load. Defined for every mode in
  // envConfig (production `https://hushbox.ai`), so it is present when needed.
  VITE_WEB_URL: z.string().url().optional(),
});

export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
