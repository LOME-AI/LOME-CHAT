import { describe, expect, it } from 'vitest';
import {
  deriveCiVitestGate,
  deriveIntegrationEnv,
  languageDescriptor,
  languageRequest,
  setupIntegrationProvider,
} from './integration-setup.js';
import type { InferenceEvent } from '@hushbox/shared';

/**
 * Harness-side pin for the env→provider derivation: outside CI the adapter
 * integration suites MUST resolve the deterministic mock — the structural
 * guarantee that no local shell (however CI-shaped its other vars look) can
 * make a real evidence-writing OpenRouter call. Every case injects its env, so
 * the pin holds identically under local vitest and CI.
 */
describe('deriveIntegrationEnv', () => {
  it('yields the mock outside CI (local vitest shell)', () => {
    expect(deriveIntegrationEnv({ NODE_ENV: 'development', VITEST: 'true' })).toEqual({
      useMock: true,
      isCI: false,
    });
  });

  it('yields the mock for an E2E-shaped shell without CI', () => {
    expect(deriveIntegrationEnv({ NODE_ENV: 'development', E2E: 'true', VITEST: 'true' })).toEqual({
      useMock: true,
      isCI: false,
    });
  });

  it('yields the real path only when CI is set', () => {
    expect(deriveIntegrationEnv({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' })).toEqual({
      useMock: false,
      isCI: true,
    });
  });
});

/**
 * Pin for the CI-vitest real-call gate the still-skipping real-only suites
 * (gateway-metadata) derive `SHOULD_RUN` from: a real OpenRouter call is
 * reachable only in a CI, non-E2E shell that also has a real key and a db —
 * never from a local shell, however its other vars look.
 */
describe('deriveCiVitestGate', () => {
  const HAS_ALL = { hasRealKey: true, hasDatabase: true };

  it('refuses a local vitest shell even with a real key and db', () => {
    expect(deriveCiVitestGate({ NODE_ENV: 'development', VITEST: 'true' }, HAS_ALL)).toBe(false);
  });

  it('refuses a CI-E2E shell', () => {
    expect(
      deriveCiVitestGate(
        { NODE_ENV: 'development', CI: 'true', E2E: 'true', VITEST: 'true' },
        HAS_ALL
      )
    ).toBe(false);
  });

  it('refuses CI-vitest when the key or the db is missing (skip, never a real call)', () => {
    const env = { NODE_ENV: 'development', CI: 'true', VITEST: 'true' };
    expect(deriveCiVitestGate(env, { hasRealKey: false, hasDatabase: true })).toBe(false);
    expect(deriveCiVitestGate(env, { hasRealKey: true, hasDatabase: false })).toBe(false);
  });

  it('admits only CI-vitest with a real key and a db', () => {
    expect(
      deriveCiVitestGate({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' }, HAS_ALL)
    ).toBe(true);
  });
});

describe('setupIntegrationProvider — mock path', () => {
  it('resolves the deterministic mock outside CI and its teardown is a no-op', async () => {
    const setup = setupIntegrationProvider({ NODE_ENV: 'development', VITEST: 'true' });
    const events: InferenceEvent[] = [];
    for await (const event of setup.provider.infer(languageRequest(), languageDescriptor())) {
      events.push(event);
    }
    const text = events
      .filter((event) => event.kind === 'text-delta')
      .map((event) => event.content)
      .join('');
    expect(text).toContain('Echo:');
    await expect(setup.teardown()).resolves.toBeUndefined();
  });
});
