import { describe, it, expect } from 'vitest';
import { envConfig, envSchema } from '../env.config.js';

describe('envConfig', () => {
  describe('structure', () => {
    it('has vars section with NODE_ENV', () => {
      expect(envConfig.vars.NODE_ENV).toBeDefined();
      expect(envConfig.vars.NODE_ENV.development).toBe('development');
      expect(envConfig.vars.NODE_ENV.production).toBe('production');
    });

    it('has vars section with BETTER_AUTH_URL', () => {
      expect(envConfig.vars.BETTER_AUTH_URL).toBeDefined();
      expect(envConfig.vars.BETTER_AUTH_URL.development).toBe('http://localhost:8787');
      expect(envConfig.vars.BETTER_AUTH_URL.production).toBe('https://api.lome-chat.com');
    });

    it('has secrets section with DATABASE_URL', () => {
      expect(envConfig.secrets.DATABASE_URL).toBeDefined();
      expect(envConfig.secrets.DATABASE_URL.development).toContain('postgres://');
      expect(envConfig.secrets.DATABASE_URL.production).toBeNull();
    });

    it('has secrets section with BETTER_AUTH_SECRET', () => {
      expect(envConfig.secrets.BETTER_AUTH_SECRET).toBeDefined();
      expect(envConfig.secrets.BETTER_AUTH_SECRET.development).toBeTruthy();
      expect(envConfig.secrets.BETTER_AUTH_SECRET.production).toBeNull();
    });

    it('has secrets section with RESEND_API_KEY', () => {
      expect(envConfig.secrets.RESEND_API_KEY).toBeDefined();
      expect(envConfig.secrets.RESEND_API_KEY.development).toBe('');
      expect(envConfig.secrets.RESEND_API_KEY.production).toBeNull();
    });

    it('has frontend section with VITE_API_URL', () => {
      expect(envConfig.frontend.VITE_API_URL).toBeDefined();
      expect(envConfig.frontend.VITE_API_URL.development).toBe('http://localhost:8787');
      expect(envConfig.frontend.VITE_API_URL.production).toBe('https://api.lome-chat.com');
    });

    it('has workerVars array with required vars', () => {
      expect(envConfig.workerVars).toContain('NODE_ENV');
      expect(envConfig.workerVars).toContain('DATABASE_URL');
      expect(envConfig.workerVars).toContain('BETTER_AUTH_URL');
      expect(envConfig.workerVars).toContain('BETTER_AUTH_SECRET');
      expect(envConfig.workerVars).toContain('RESEND_API_KEY');
    });

    it('has localOnly section with MIGRATION_DATABASE_URL', () => {
      expect(envConfig.localOnly).toBeDefined();
      expect(envConfig.localOnly.MIGRATION_DATABASE_URL).toContain('postgresql://');
    });

    it('does not have MIGRATION_DATABASE_URL in secrets', () => {
      expect(envConfig.secrets).not.toHaveProperty('MIGRATION_DATABASE_URL');
    });
  });

  describe('development values completeness', () => {
    it('all vars have development values', () => {
      for (const [key, values] of Object.entries(envConfig.vars)) {
        expect(values.development, `vars.${key}.development`).toBeDefined();
      }
    });

    it('all secrets have development values (can be empty string)', () => {
      for (const [key, values] of Object.entries(envConfig.secrets)) {
        // Development values should be strings (not null like production)
        expect(typeof values.development, `secrets.${key}.development should be a string`).toBe(
          'string'
        );
      }
    });

    it('all frontend vars have development values', () => {
      for (const [key, values] of Object.entries(envConfig.frontend)) {
        expect(values.development, `frontend.${key}.development`).toBeDefined();
      }
    });
  });

  describe('production secrets are null', () => {
    it('all secrets have null production values (set via CI)', () => {
      for (const [key, values] of Object.entries(envConfig.secrets)) {
        expect(values.production, `secrets.${key}.production should be null`).toBeNull();
      }
    });
  });
});

describe('envSchema', () => {
  it('validates correct development environment', () => {
    const validEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      RESEND_API_KEY: '',
      VITE_API_URL: 'http://localhost:8787',
    };

    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('validates correct production environment', () => {
    const validEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://neon.tech:5432/prod',
      BETTER_AUTH_URL: 'https://api.lome-chat.com',
      BETTER_AUTH_SECRET: 'a-production-secret-at-least-32-chars-long!!',
      RESEND_API_KEY: 're_123456789',
      VITE_API_URL: 'https://api.lome-chat.com',
    };

    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('rejects invalid NODE_ENV', () => {
    const invalidEnv = {
      NODE_ENV: 'invalid',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      VITE_API_URL: 'http://localhost:8787',
    };

    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects missing DATABASE_URL', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      VITE_API_URL: 'http://localhost:8787',
    };

    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects BETTER_AUTH_SECRET shorter than 32 characters', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'too-short',
      VITE_API_URL: 'http://localhost:8787',
    };

    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects invalid URL for BETTER_AUTH_URL', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'not-a-url',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      VITE_API_URL: 'http://localhost:8787',
    };

    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('allows RESEND_API_KEY to be optional/empty', () => {
    const validEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      VITE_API_URL: 'http://localhost:8787',
    };

    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });
});
