import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from './env.js';

describe('env module construction (VITE_CI / VITE_E2E spreads)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('forwards CI and E2E to createEnvUtilities when both vars are present (truthy spread branch)', async () => {
    vi.stubEnv('VITE_CI', 'true');
    vi.stubEnv('VITE_E2E', 'true');
    vi.resetModules();
    const { env: reloaded } = await import('./env.js');
    // CI mode: createEnvUtilities treats CI as requiring real services.
    expect(reloaded.isCI).toBe(true);
    expect(reloaded.isE2E).toBe(true);
  });

  it('omits CI and E2E when the vars are absent (falsy spread branch)', async () => {
    vi.stubEnv('VITE_CI', '');
    vi.stubEnv('VITE_E2E', '');
    vi.resetModules();
    const { env: reloaded } = await import('./env.js');
    // Empty strings are falsy, so neither key is spread in — plain test mode.
    expect(reloaded.isCI).toBe(false);
    expect(reloaded.isE2E).toBe(false);
  });
});

describe('env', () => {
  it('exports an EnvUtils object with all expected properties', () => {
    expect(env).toBeDefined();
    expect(typeof env.isDev).toBe('boolean');
    expect(typeof env.isLocalDev).toBe('boolean');
    expect(typeof env.isProduction).toBe('boolean');
    expect(typeof env.isCI).toBe('boolean');
    expect(typeof env.requiresRealServices).toBe('boolean');
  });

  it('has consistent boolean relationships', () => {
    // isLocalDev can only be true if isDev is true
    if (env.isLocalDev) {
      expect(env.isDev).toBe(true);
    }

    // requiresRealServices is true if isProduction or isCI
    if (env.requiresRealServices) {
      expect(env.isProduction || env.isCI).toBe(true);
    }

    // isDev and isProduction are mutually exclusive
    expect(env.isDev && env.isProduction).toBe(false);
  });

  it('reflects test environment correctly', () => {
    // Vitest runs with MODE='test'. Only 'development' counts as dev mode,
    // so isDev is false under vitest; tests that need a dev-true env mock
    // @/lib/env directly.
    expect(env.isDev).toBe(false);
    expect(env.isLocalDev).toBe(false);
    expect(env.isProduction).toBe(false);
  });
});
