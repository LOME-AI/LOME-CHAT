import { describe, expect, it } from 'vitest';
import {
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
