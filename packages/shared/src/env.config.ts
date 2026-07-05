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
    [Mode.Development]: 'http://localhost:8787',
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

  APP_VERSION: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-local',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('APP_VERSION'),
  },

  RESEND_API_KEY: {
    to: [Destination.Backend],
    [Mode.Production]: secret('RESEND_API_KEY'),
    // NOT in CI - email service uses console client when CI=true
  },

  // Vercel AI Gateway API key. Two distinct GitHub secrets resolve to the same
  // env var name in different modes — _RESTRICTED is a low-budget key used by
  // CI integration tests in the ciVitest mode test job; _PRODUCTION is the
  // unrestricted production-grade key. The AI client factory mocks when
  // isE2E=true, so CiE2E does NOT need the key — local E2E and CI E2E both
  // use the mock AIClient. Mirrors the deleted OpenRouter pattern exactly.
  AI_GATEWAY_API_KEY: {
    to: [Destination.Backend],
    [Mode.CiVitest]: secret('AI_GATEWAY_API_KEY_RESTRICTED'),
    [Mode.Production]: secret('AI_GATEWAY_API_KEY_PRODUCTION'),
  },

  // OpenRouter API key — the inference gateway the backend is migrating to.
  // Additive foundation: nothing consumes it yet (adapters, catalog, and
  // billing wire it up in later tasks). Only Production needs the real key
  // right now, so every other mode uses a mock placeholder: the mock AI
  // client serves dev/CI/E2E, and the ciVitest OpenRouter tests are synthetic
  // (no real OpenRouter call — `verify:evidence --require=openrouter` is
  // deferred to Phase-4). A placeholder (not a GitHub secret) in CiVitest
  // avoids an empty-required-secret in the generated ciVitest env block.
  // Phase-4 switches CiVitest to `secret('OPENROUTER_API_KEY_RESTRICTED')`
  // when real ciVitest OpenRouter tests land.
  OPENROUTER_API_KEY: {
    to: [Destination.Backend],
    [Mode.Development]: 'mock-openrouter-key',
    [Mode.CiVitest]: ref(Mode.Development),
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
  // Mirrors the AI_GATEWAY_API_KEY pattern but with a single GitHub secret
  // name because there is no permission difference between CI and prod.
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
    [Mode.Development]: 'http://localhost:8787',
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
  DATABASE_URL: z.string().min(1),
  APP_VERSION: z.string().min(1),
  RESEND_API_KEY: z.string().optional(),
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
});

export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
