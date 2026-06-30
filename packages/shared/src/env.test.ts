import { describe, it, expect } from 'vitest';
import { createEnvUtilities } from './env.js';

describe('createEnvUtilities', () => {
  describe('missing NODE_ENV', () => {
    it('throws naming the variable when NODE_ENV is absent', () => {
      expect(() => createEnvUtilities({})).toThrow(/NODE_ENV/);
    });
  });

  describe('isDev', () => {
    it('returns true when NODE_ENV is development', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development' });
      expect(env.isDev).toBe(true);
    });

    it('returns false when NODE_ENV is test', () => {
      const env = createEnvUtilities({ NODE_ENV: 'test' });
      expect(env.isDev).toBe(false);
    });

    it('returns false when NODE_ENV is production', () => {
      const env = createEnvUtilities({ NODE_ENV: 'production' });
      expect(env.isDev).toBe(false);
    });

    it('returns true in CI with development NODE_ENV', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: 'true' });
      expect(env.isDev).toBe(true);
    });

    it('returns false in CI with test NODE_ENV', () => {
      const env = createEnvUtilities({ NODE_ENV: 'test', CI: 'true' });
      expect(env.isDev).toBe(false);
    });
  });

  describe('isLocalDev', () => {
    it('returns true when NODE_ENV is development and CI is not set', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development' });
      expect(env.isLocalDev).toBe(true);
    });

    it('returns false when NODE_ENV is test (vitest mode is not dev server)', () => {
      const env = createEnvUtilities({ NODE_ENV: 'test' });
      expect(env.isLocalDev).toBe(false);
    });

    it('returns false when NODE_ENV is development but CI is set', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: 'true' });
      expect(env.isLocalDev).toBe(false);
    });

    it('returns false when NODE_ENV is test but CI is set', () => {
      const env = createEnvUtilities({ NODE_ENV: 'test', CI: 'true' });
      expect(env.isLocalDev).toBe(false);
    });

    it('returns false when NODE_ENV is production', () => {
      const env = createEnvUtilities({ NODE_ENV: 'production' });
      expect(env.isLocalDev).toBe(false);
    });

    it('returns false when CI is any truthy string', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: '1' });
      expect(env.isLocalDev).toBe(false);
    });
  });

  describe('isDevServer', () => {
    it('returns true for a plain local dev server', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development' });
      expect(env.isDevServer).toBe(true);
    });

    it('returns false under vitest (VITEST set), even in dev mode', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', VITEST: 'true' });
      expect(env.isDevServer).toBe(false);
    });

    it('returns false under E2E, even in dev mode', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', E2E: 'true' });
      expect(env.isDevServer).toBe(false);
    });

    it('returns false in CI vitest', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' });
      expect(env.isDevServer).toBe(false);
    });

    it('returns false in CI E2E', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: 'true', E2E: 'true' });
      expect(env.isDevServer).toBe(false);
    });

    it('returns false in production', () => {
      const env = createEnvUtilities({ NODE_ENV: 'production' });
      expect(env.isDevServer).toBe(false);
    });

    it('treats an empty VITEST string as not-vitest', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', VITEST: '' });
      expect(env.isDevServer).toBe(true);
    });
  });

  describe('isProduction', () => {
    it('returns true when NODE_ENV is production', () => {
      const env = createEnvUtilities({ NODE_ENV: 'production' });
      expect(env.isProduction).toBe(true);
    });

    it('returns false when NODE_ENV is development', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development' });
      expect(env.isProduction).toBe(false);
    });
  });

  describe('isCI', () => {
    it('returns true when CI is set', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: 'true' });
      expect(env.isCI).toBe(true);
    });

    it('returns true when CI is any truthy string', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: '1' });
      expect(env.isCI).toBe(true);
    });

    it('returns false when CI is not set', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development' });
      expect(env.isCI).toBe(false);
    });

    it('returns false when CI is empty string', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: '' });
      expect(env.isCI).toBe(false);
    });
  });

  describe('requiresRealServices', () => {
    it('returns true in production', () => {
      const env = createEnvUtilities({ NODE_ENV: 'production' });
      expect(env.requiresRealServices).toBe(true);
    });

    it('returns true in CI (even with development NODE_ENV)', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: 'true' });
      expect(env.requiresRealServices).toBe(true);
    });

    it('returns false in local development', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development' });
      expect(env.requiresRealServices).toBe(false);
    });
  });

  describe('isE2E', () => {
    it('returns true when E2E is set', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', E2E: 'true' });
      expect(env.isE2E).toBe(true);
    });

    it('returns true when E2E is any truthy string', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', E2E: '1' });
      expect(env.isE2E).toBe(true);
    });

    it('returns false when E2E is not set', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development' });
      expect(env.isE2E).toBe(false);
    });

    it('returns false when E2E is empty string', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', E2E: '' });
      expect(env.isE2E).toBe(false);
    });

    it('returns true in CI E2E mode', () => {
      const env = createEnvUtilities({ NODE_ENV: 'development', CI: 'true', E2E: 'true' });
      expect(env.isE2E).toBe(true);
      expect(env.isCI).toBe(true);
    });
  });
});
