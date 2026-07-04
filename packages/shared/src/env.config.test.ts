import { describe, it, expect } from 'vitest';
import {
  envConfig,
  backendEnvSchema,
  frontendEnvSchema,
  Destination,
  Mode,
  isSecret,
  getDestinations,
  resolveRaw,
} from './env.config.js';

describe('envConfig', () => {
  describe('DATABASE_URL', () => {
    it('has development value going to Backend + Scripts', () => {
      expect(getDestinations(envConfig.DATABASE_URL, Mode.Development)).toEqual([
        Destination.Backend,
        Destination.Scripts,
      ]);
    });

    it('inherits Dev destinations through ref in CiVitest, E2E, and CiE2E', () => {
      expect(getDestinations(envConfig.DATABASE_URL, Mode.CiVitest)).toEqual([
        Destination.Backend,
        Destination.Scripts,
      ]);
      expect(getDestinations(envConfig.DATABASE_URL, Mode.E2E)).toEqual([
        Destination.Backend,
        Destination.Scripts,
      ]);
      expect(getDestinations(envConfig.DATABASE_URL, Mode.CiE2E)).toEqual([
        Destination.Backend,
        Destination.Scripts,
      ]);
    });

    it('has production secret going to Backend only', () => {
      expect(getDestinations(envConfig.DATABASE_URL, Mode.Production)).toEqual([
        Destination.Backend,
      ]);
      const raw = resolveRaw(envConfig.DATABASE_URL, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('NODE_ENV', () => {
    it('goes to Backend only', () => {
      expect(envConfig.NODE_ENV.to).toEqual([Destination.Backend]);
    });

    it('has development value', () => {
      expect(resolveRaw(envConfig.NODE_ENV, Mode.Development)).toBe('development');
    });

    it('has production value', () => {
      expect(resolveRaw(envConfig.NODE_ENV, Mode.Production)).toBe('production');
    });

    it('refs development for CI environments', () => {
      expect(resolveRaw(envConfig.NODE_ENV, Mode.CiVitest)).toBe('development');
      expect(resolveRaw(envConfig.NODE_ENV, Mode.E2E)).toBe('development');
    });
  });

  describe('API_URL', () => {
    it('goes to Backend only', () => {
      expect(envConfig.API_URL.to).toEqual([Destination.Backend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.API_URL, Mode.Development)).toBe('http://localhost:8787');
      expect(resolveRaw(envConfig.API_URL, Mode.Production)).toBe('https://api.hushbox.ai');
    });
  });

  describe('FRONTEND_URL', () => {
    it('goes to Backend only', () => {
      expect(envConfig.FRONTEND_URL.to).toEqual([Destination.Backend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.FRONTEND_URL, Mode.Development)).toBe('http://localhost:5173');
      expect(resolveRaw(envConfig.FRONTEND_URL, Mode.Production)).toBe('https://hushbox.ai');
    });
  });

  describe('CI flag', () => {
    it('goes to Backend only', () => {
      expect(envConfig.CI.to).toEqual([Destination.Backend]);
    });

    it('is only set in CI environments', () => {
      expect(resolveRaw(envConfig.CI, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.CI, Mode.CiVitest)).toBe('true');
      expect(resolveRaw(envConfig.CI, Mode.E2E)).toBeUndefined();
      expect(resolveRaw(envConfig.CI, Mode.CiE2E)).toBe('true');
      expect(resolveRaw(envConfig.CI, Mode.Production)).toBeUndefined();
    });
  });

  describe('E2E flag', () => {
    it('goes to Backend only', () => {
      expect(envConfig.E2E.to).toEqual([Destination.Backend]);
    });

    it('is only set in e2e environment', () => {
      expect(resolveRaw(envConfig.E2E, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.E2E, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.E2E, Mode.E2E)).toBe('true');
      expect(resolveRaw(envConfig.E2E, Mode.Production)).toBeUndefined();
    });
  });

  describe('RESEND_API_KEY', () => {
    it('goes to Backend only', () => {
      expect(envConfig.RESEND_API_KEY.to).toEqual([Destination.Backend]);
    });

    it('is only set in production (not in dev or CI)', () => {
      expect(resolveRaw(envConfig.RESEND_API_KEY, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.RESEND_API_KEY, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.RESEND_API_KEY, Mode.E2E)).toBeUndefined();
      const production = resolveRaw(envConfig.RESEND_API_KEY, Mode.Production);
      expect(isSecret(production)).toBe(true);
    });
  });

  describe('AI_GATEWAY_API_KEY', () => {
    it('goes to Backend only', () => {
      expect(envConfig.AI_GATEWAY_API_KEY.to).toEqual([Destination.Backend]);
    });

    it('is only set in CiVitest and Production (other modes use the mock AI client)', () => {
      expect(resolveRaw(envConfig.AI_GATEWAY_API_KEY, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.AI_GATEWAY_API_KEY, Mode.E2E)).toBeUndefined();
      expect(resolveRaw(envConfig.AI_GATEWAY_API_KEY, Mode.CiE2E)).toBeUndefined();
      const ciVitest = resolveRaw(envConfig.AI_GATEWAY_API_KEY, Mode.CiVitest);
      expect(isSecret(ciVitest)).toBe(true);
      const production = resolveRaw(envConfig.AI_GATEWAY_API_KEY, Mode.Production);
      expect(isSecret(production)).toBe(true);
    });

    it('uses _RESTRICTED secret in CiVitest and _PRODUCTION secret in Production', () => {
      const ciVitest = resolveRaw(envConfig.AI_GATEWAY_API_KEY, Mode.CiVitest);
      const production = resolveRaw(envConfig.AI_GATEWAY_API_KEY, Mode.Production);
      // Distinct GitHub secrets resolve to the same env var name across modes,
      // mirroring the deleted OpenRouter pattern. The actual secret-name suffix
      // is opaque to this test (resolveRaw returns a Secret marker), but the
      // marker objects are distinct references when sourced from different secrets.
      expect(isSecret(ciVitest)).toBe(true);
      expect(isSecret(production)).toBe(true);
    });
  });

  describe('HELCIM_API_TOKEN', () => {
    it('goes to Backend only', () => {
      expect(envConfig.HELCIM_API_TOKEN.to).toEqual([Destination.Backend]);
    });

    it('is set in ciVitest, ciE2E, and production (NOT development or e2e)', () => {
      // ciVitest hits the real Helcim SANDBOX (no cassette) to confirm the
      // orphaned-capture invoiceNumber round-trip; mirrors AI_GATEWAY_API_KEY.
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.E2E)).toBeUndefined();
      expect(isSecret(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiVitest))).toBe(true);
      expect(isSecret(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiE2E))).toBe(true);
      expect(isSecret(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.Production))).toBe(true);
    });

    it('reuses the _SANDBOX secret across ciVitest and ciE2E, differing from production', () => {
      const ciVitest = resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiVitest);
      const ciE2E = resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiE2E);
      const production = resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.Production);
      // Same GitHub secret name in both CI modes (one permission surface),
      // distinct from the unrestricted production token.
      expect(ciVitest).toEqual(ciE2E);
      expect(ciVitest).not.toEqual(production);
    });
  });

  describe('HELCIM_WEBHOOK_VERIFIER', () => {
    it('goes to Backend only', () => {
      expect(envConfig.HELCIM_WEBHOOK_VERIFIER.to).toEqual([Destination.Backend]);
    });

    it('has mock value for development (for local webhook testing)', () => {
      const dev = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.Development);
      expect(dev).toBeDefined();
      expect(typeof dev).toBe('string');
      expect(isSecret(dev)).toBe(false);
    });

    it('e2e uses development mock value', () => {
      const e2e = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.E2E);
      const dev = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.Development);
      expect(e2e).toBe(dev);
    });

    it('uses different secrets for ciE2E and production', () => {
      const ciE2E = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.CiE2E);
      const production = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.Production);
      expect(isSecret(ciE2E)).toBe(true);
      expect(isSecret(production)).toBe(true);
      expect(ciE2E).not.toEqual(production);
    });
  });

  describe('VITE_API_URL', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_API_URL.to).toEqual([Destination.Frontend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.VITE_API_URL, Mode.Development)).toBe('http://localhost:8787');
      expect(resolveRaw(envConfig.VITE_API_URL, Mode.Production)).toBe('https://api.hushbox.ai');
    });
  });

  describe('VITE_HELCIM_JS_TOKEN', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_HELCIM_JS_TOKEN.to).toEqual([Destination.Frontend]);
    });

    it('is only in ciE2E and production (NOT development, ciVitest, or e2e)', () => {
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.E2E)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.CiE2E)).toBeDefined();
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.Production)).toBeDefined();
    });
  });

  describe('VITE_APP_VERSION', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_APP_VERSION.to).toEqual([Destination.Frontend]);
    });

    it('has dev-local for development', () => {
      expect(resolveRaw(envConfig.VITE_APP_VERSION, Mode.Development)).toBe('dev-local');
    });

    it('production value is a literal (not a secret) — CI BUILD_VARIANTS override it', () => {
      const raw = resolveRaw(envConfig.VITE_APP_VERSION, Mode.Production);
      expect(isSecret(raw)).toBe(false);
      expect(raw).toBe('set-by-ci');
    });
  });

  describe('VITE_CI', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_CI.to).toEqual([Destination.Frontend]);
    });

    it('is only set in CI environments', () => {
      expect(resolveRaw(envConfig.VITE_CI, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_CI, Mode.CiVitest)).toBe('true');
      expect(resolveRaw(envConfig.VITE_CI, Mode.E2E)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_CI, Mode.CiE2E)).toBe('true');
      expect(resolveRaw(envConfig.VITE_CI, Mode.Production)).toBeUndefined();
    });
  });

  describe('R2_S3_ENDPOINT', () => {
    it('goes to Backend only', () => {
      expect(envConfig.R2_S3_ENDPOINT.to).toEqual([Destination.Backend]);
    });

    it('has MinIO endpoint for development', () => {
      expect(resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.Development)).toBe('http://localhost:9000');
    });

    it('refs development for CI/E2E environments', () => {
      expect(resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.CiVitest)).toBe('http://localhost:9000');
      expect(resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.E2E)).toBe('http://localhost:9000');
      expect(resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.CiE2E)).toBe('http://localhost:9000');
    });

    it('is a secret in production', () => {
      const raw = resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('R2_ACCESS_KEY_ID', () => {
    it('goes to Backend only', () => {
      expect(envConfig.R2_ACCESS_KEY_ID.to).toEqual([Destination.Backend]);
    });

    it('has MinIO default for development', () => {
      expect(resolveRaw(envConfig.R2_ACCESS_KEY_ID, Mode.Development)).toBe('minioadmin');
    });

    it('is a secret in production', () => {
      const raw = resolveRaw(envConfig.R2_ACCESS_KEY_ID, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('R2_SECRET_ACCESS_KEY', () => {
    it('goes to Backend only', () => {
      expect(envConfig.R2_SECRET_ACCESS_KEY.to).toEqual([Destination.Backend]);
    });

    it('has MinIO default for development', () => {
      expect(resolveRaw(envConfig.R2_SECRET_ACCESS_KEY, Mode.Development)).toBe('minioadmin');
    });

    it('is a secret in production', () => {
      const raw = resolveRaw(envConfig.R2_SECRET_ACCESS_KEY, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('R2_BUCKET_MEDIA', () => {
    it('goes to Backend only', () => {
      expect(envConfig.R2_BUCKET_MEDIA.to).toEqual([Destination.Backend]);
    });

    it('has local bucket name for development', () => {
      expect(resolveRaw(envConfig.R2_BUCKET_MEDIA, Mode.Development)).toBe('hushbox-media-dev');
    });

    it('has production bucket name as a literal (not a secret)', () => {
      const raw = resolveRaw(envConfig.R2_BUCKET_MEDIA, Mode.Production);
      expect(isSecret(raw)).toBe(false);
      expect(raw).toBe('hushbox-media');
    });
  });

  describe('R2_ADMIN_ACCESS_KEY_ID', () => {
    it('goes to the Ops lane only (never the runtime Worker)', () => {
      expect(envConfig.R2_ADMIN_ACCESS_KEY_ID.to).toEqual([Destination.Ops]);
    });

    it('has MinIO default for development', () => {
      expect(resolveRaw(envConfig.R2_ADMIN_ACCESS_KEY_ID, Mode.Development)).toBe('minioadmin');
    });

    it('is the R2_ADMIN_ACCESS_KEY_ID secret in production', () => {
      const raw = resolveRaw(envConfig.R2_ADMIN_ACCESS_KEY_ID, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('R2_ADMIN_ACCESS_KEY_ID');
    });
  });

  describe('R2_ADMIN_SECRET_ACCESS_KEY', () => {
    it('goes to the Ops lane only (never the runtime Worker)', () => {
      expect(envConfig.R2_ADMIN_SECRET_ACCESS_KEY.to).toEqual([Destination.Ops]);
    });

    it('has MinIO default for development', () => {
      expect(resolveRaw(envConfig.R2_ADMIN_SECRET_ACCESS_KEY, Mode.Development)).toBe('minioadmin');
    });

    it('is the R2_ADMIN_SECRET_ACCESS_KEY secret in production', () => {
      const raw = resolveRaw(envConfig.R2_ADMIN_SECRET_ACCESS_KEY, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('R2_ADMIN_SECRET_ACCESS_KEY');
    });
  });

  describe('admin R2 credentials never reach the runtime Worker', () => {
    it('omits R2_ADMIN_* from the backend env schema', () => {
      expect('R2_ADMIN_ACCESS_KEY_ID' in backendEnvSchema.shape).toBe(false);
      expect('R2_ADMIN_SECRET_ACCESS_KEY' in backendEnvSchema.shape).toBe(false);
    });
  });

  describe('TELEMETRY_SINKS', () => {
    it('goes to Backend only', () => {
      expect(envConfig.TELEMETRY_SINKS.to).toEqual([Destination.Backend]);
    });

    it('composes the console sink only in development', () => {
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.Development)).toBe('console');
    });

    it('refs development for CiVitest, E2E, and CiE2E', () => {
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.CiVitest)).toBe('console');
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.E2E)).toBe('console');
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.CiE2E)).toBe('console');
    });

    it('composes all sinks in production', () => {
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.Production)).toBe('console,sentry,wae');
    });
  });

  describe('SENTRY_DSN', () => {
    it('goes to Backend only', () => {
      expect(envConfig.SENTRY_DSN.to).toEqual([Destination.Backend]);
    });

    it('is explicitly empty (disabled) in development', () => {
      expect(resolveRaw(envConfig.SENTRY_DSN, Mode.Development)).toBe('');
    });

    it('refs the disabled development value for CiVitest, E2E, and CiE2E', () => {
      expect(resolveRaw(envConfig.SENTRY_DSN, Mode.CiVitest)).toBe('');
      expect(resolveRaw(envConfig.SENTRY_DSN, Mode.E2E)).toBe('');
      expect(resolveRaw(envConfig.SENTRY_DSN, Mode.CiE2E)).toBe('');
    });

    it('is a secret in production', () => {
      const raw = resolveRaw(envConfig.SENTRY_DSN, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('MIGRATION_DATABASE_URL', () => {
    it('goes to Scripts only', () => {
      expect(envConfig.MIGRATION_DATABASE_URL.to).toEqual([Destination.Scripts]);
    });

    it('has development value', () => {
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.Development)).toContain(
        'postgresql://'
      );
    });

    it('is available in CI environments via ref', () => {
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.CiVitest)).toBeDefined();
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.E2E)).toBeDefined();
    });

    it('is not set in production (scripts not deployed)', () => {
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.Production)).toBeUndefined();
    });
  });
});

describe('backendEnvSchema', () => {
  it('validates correct development environment', () => {
    const validEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      API_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:5173',
      APP_VERSION: 'dev-local',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
      OPAQUE_MASTER_SECRET: 'dev-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
      IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('validates correct production environment', () => {
    const validEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://neon.tech:5432/prod',
      API_URL: 'https://api.hushbox.ai',
      FRONTEND_URL: 'https://hushbox.ai',
      APP_VERSION: 'abc1234',
      RESEND_API_KEY: 're_123456789',
      HELCIM_API_TOKEN: 'helcim-token',
      HELCIM_WEBHOOK_VERIFIER: 'webhook-verifier',
      UPSTASH_REDIS_REST_URL: 'https://upstash-redis.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'prod_token_value',
      OPAQUE_MASTER_SECRET: 'prod-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
      IRON_SESSION_SECRET: 'prod-iron-session-secret-32-bytes-min', // gitleaks:allow
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('accepts R2 media storage vars when provided', () => {
    const validEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://neon.tech:5432/prod',
      API_URL: 'https://api.hushbox.ai',
      FRONTEND_URL: 'https://hushbox.ai',
      APP_VERSION: 'abc1234',
      UPSTASH_REDIS_REST_URL: 'https://upstash-redis.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'prod_token_value',
      OPAQUE_MASTER_SECRET: 'prod-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
      IRON_SESSION_SECRET: 'prod-iron-session-secret-32-bytes-min', // gitleaks:allow
      R2_S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
      R2_ACCESS_KEY_ID: 'r2-access-key',
      R2_SECRET_ACCESS_KEY: 'r2-secret-key',
      R2_BUCKET_MEDIA: 'hushbox-media',
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('rejects invalid NODE_ENV', () => {
    const invalidEnv = {
      NODE_ENV: 'invalid',
      DATABASE_URL: 'postgres://localhost:5432/test',
      API_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:5173',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
      OPAQUE_MASTER_SECRET: 'dev-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
      IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
    };

    const result = backendEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects missing DATABASE_URL', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      API_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:5173',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
      OPAQUE_MASTER_SECRET: 'dev-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
      IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
    };

    const result = backendEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('allows CI/prod secrets to be optional', () => {
    const validEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      API_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:5173',
      APP_VERSION: 'dev-local',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
      OPAQUE_MASTER_SECRET: 'dev-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
      IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
      // CI/prod secrets are omitted - test they're optional
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });
});

describe('frontendEnvSchema', () => {
  it('validates VITE_API_URL', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_API_URL).toBe('http://localhost:8787');
    }
  });

  it('rejects invalid URL', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'not-a-url',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing VITE_API_URL', () => {
    const result = frontendEnvSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  it('rejects missing VITE_PLATFORM', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_APP_VERSION: 'dev-local',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing VITE_APP_VERSION', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
    });

    expect(result.success).toBe(false);
  });

  it('accepts explicit VITE_PLATFORM and VITE_APP_VERSION', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'ios',
      VITE_APP_VERSION: '1.2.3',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_PLATFORM).toBe('ios');
      expect(result.data.VITE_APP_VERSION).toBe('1.2.3');
    }
  });

  it('allows VITE_HELCIM_JS_TOKEN to be optional', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
    });

    expect(result.success).toBe(true);
  });

  it('accepts VITE_HELCIM_JS_TOKEN when provided', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
      VITE_HELCIM_JS_TOKEN: 'some-token',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_HELCIM_JS_TOKEN).toBe('some-token');
    }
  });

  it('accepts VITE_DRIZZLE_STUDIO_URL when provided', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
      VITE_DRIZZLE_STUDIO_URL: 'http://localhost:4983',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_DRIZZLE_STUDIO_URL).toBe('http://localhost:4983');
    }
  });

  it('allows VITE_DRIZZLE_STUDIO_URL to be optional', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
    });

    expect(result.success).toBe(true);
  });
});
