import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from './env.js';

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
