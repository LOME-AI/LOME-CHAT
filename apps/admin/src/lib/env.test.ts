import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEnvUtilities } from '@hushbox/shared';
import { computeDevAuthEnabled, env, isDevAuthEnabled } from './env.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('env', () => {
  it('exports an EnvUtils object with the expected properties', () => {
    expect(typeof env.isDev).toBe('boolean');
    expect(typeof env.isLocalDev).toBe('boolean');
    expect(typeof env.isProduction).toBe('boolean');
    expect(typeof env.isCI).toBe('boolean');
  });

  it('reflects the test environment correctly', () => {
    // Vitest runs with MODE='test'. Only 'development' counts as dev mode, so
    // the dev-auth wrapper attaches nothing under vitest unless mocked.
    expect(env.isDev).toBe(false);
    expect(env.isLocalDev).toBe(false);
    expect(env.isProduction).toBe(false);
  });

  it('forwards VITE_CI and VITE_E2E into the utilities when set', async () => {
    vi.stubEnv('VITE_CI', 'true');
    vi.stubEnv('VITE_E2E', 'true');
    vi.resetModules();
    const { env: stubbedEnv } = await import('./env.js');
    expect(stubbedEnv.isCI).toBe(true);
    expect(stubbedEnv.isE2E).toBe(true);
  });
});

describe('computeDevAuthEnabled', () => {
  it('enables dev auth in local dev', () => {
    const utilities = createEnvUtilities({ NODE_ENV: 'development' });
    expect(computeDevAuthEnabled(utilities)).toBe(true);
  });

  it('enables dev auth in the CI-e2e shape (E2E true, isLocalDev false)', () => {
    const utilities = createEnvUtilities({ NODE_ENV: 'development', CI: 'true', E2E: 'true' });
    expect(utilities.isLocalDev).toBe(false);
    expect(utilities.isE2E).toBe(true);
    expect(computeDevAuthEnabled(utilities)).toBe(true);
  });

  it('production-leak guard: disables dev auth in the production shape (no CI/E2E flags)', () => {
    const utilities = createEnvUtilities({ NODE_ENV: 'production' });
    expect(computeDevAuthEnabled(utilities)).toBe(false);
  });

  it('production-leak guard: disables dev auth even if E2E flags leak into a production build', () => {
    const utilities = createEnvUtilities({ NODE_ENV: 'production', CI: 'true', E2E: 'true' });
    expect(computeDevAuthEnabled(utilities)).toBe(false);
  });

  it('disables dev auth under plain vitest (test mode, no flags)', () => {
    const utilities = createEnvUtilities({ NODE_ENV: 'test' });
    expect(computeDevAuthEnabled(utilities)).toBe(false);
  });
});

describe('isDevAuthEnabled', () => {
  it('derives from the module env (false under plain vitest)', () => {
    expect(isDevAuthEnabled()).toBe(computeDevAuthEnabled(env));
    expect(isDevAuthEnabled()).toBe(false);
  });

  it('is true when VITE_E2E is baked (CI-e2e shape)', async () => {
    vi.stubEnv('VITE_CI', 'true');
    vi.stubEnv('VITE_E2E', 'true');
    vi.resetModules();
    const { isDevAuthEnabled: stubbed } = await import('./env.js');
    expect(stubbed()).toBe(true);
  });
});
