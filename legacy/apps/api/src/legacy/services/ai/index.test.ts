import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearModelCache } from '@hushbox/shared/models';
import { getAIClient, buildMockConfig, LOCAL_DEV_MEDIA_DELAY_MS } from './index.js';
import { E2E_MODEL_CATALOG } from './e2e-catalog.fixture.js';

describe('getAIClient', () => {
  it('returns a mock client in local development', () => {
    const client = getAIClient({ NODE_ENV: 'development' });
    expect(client.isMock).toBe(true);
  });

  it('throws for NODE_ENV=test (vitest mode no longer treated as dev)', () => {
    expect(() => getAIClient({ NODE_ENV: 'test' })).toThrow('AI_GATEWAY_API_KEY required');
  });

  it('returns a mock client in E2E mode', () => {
    const client = getAIClient({ NODE_ENV: 'development', E2E: 'true' });
    expect(client.isMock).toBe(true);
  });

  it('throws if AI_GATEWAY_API_KEY is missing in production', () => {
    expect(() => getAIClient({ NODE_ENV: 'production' })).toThrow('AI_GATEWAY_API_KEY required');
  });

  it('throws if AI_GATEWAY_API_KEY is missing in CI', () => {
    expect(() => getAIClient({ NODE_ENV: 'development', CI: 'true' })).toThrow(
      'AI_GATEWAY_API_KEY required'
    );
  });

  it('returns a mock client even when API key is present in local dev', () => {
    const client = getAIClient({
      NODE_ENV: 'development',
      AI_GATEWAY_API_KEY: 'test-key',
    });
    expect(client.isMock).toBe(true);
  });

  it('returns a real client in CI when API key is provided', () => {
    const client = getAIClient({
      NODE_ENV: 'development',
      CI: 'true',
      AI_GATEWAY_API_KEY: 'test-key',
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
    });
    expect(client.isMock).toBe(false);
  });

  it('throws if PUBLIC_MODELS_URL is missing in production', () => {
    expect(() => getAIClient({ NODE_ENV: 'production', AI_GATEWAY_API_KEY: 'test-key' })).toThrow(
      'PUBLIC_MODELS_URL required'
    );
  });

  it('returns a fresh mock instance on every call (no module-level cache)', () => {
    // Mock state is per-request: every aiClientMiddleware invocation builds
    // a new mock from request headers, so there is no cross-request bleed.
    const first = getAIClient({ NODE_ENV: 'development' });
    const second = getAIClient({ NODE_ENV: 'development' });
    expect(first).not.toBe(second);
  });

  it('threads mockConfig into the mock — classifierResolution drives the classifier output', async () => {
    const client = getAIClient(
      { NODE_ENV: 'development' },
      { mockConfig: { classifierResolution: 'anthropic/claude-opus-4.6' } }
    );
    expect(client.isMock).toBe(true);
    const { CLASSIFIER_SYSTEM_PROMPT_MARKER } = await import('@hushbox/shared');
    const events: unknown[] = [];
    for await (const event of client.stream({
      modality: 'text',
      model: 'cheap/c',
      messages: [
        { role: 'system', content: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nPick.\n- a/x\n- b/y` },
        { role: 'user', content: '[USER START]: hi' },
      ],
    })) {
      events.push(event);
    }
    const text = events
      .filter(
        (e): e is { kind: 'text-delta'; content: string } =>
          typeof (e as { kind?: unknown }).kind === 'string' &&
          (e as { kind: string }).kind === 'text-delta'
      )
      .map((e) => e.content)
      .join('');
    expect(text).toBe('anthropic/claude-opus-4.6');
  });

  describe('E2E catalog is pinned to the fixture', () => {
    beforeEach(() => {
      clearModelCache();
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(new Error('fetch must not be called in E2E')))
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('serves the pinned fixture catalog and hits no network in E2E', async () => {
      const client = getAIClient({ NODE_ENV: 'development', E2E: 'true' });
      const raw = await client.listRawModels();
      expect(raw).toEqual(E2E_MODEL_CATALOG);
    });

    it('does not pin the catalog in plain local dev (live fetch path)', async () => {
      const fetchSpy = vi.fn(() => Promise.reject(new Error('reached network')));
      vi.stubGlobal('fetch', fetchSpy);
      const client = getAIClient({ NODE_ENV: 'development' });
      await expect(client.listRawModels()).rejects.toThrow('reached network');
      expect(fetchSpy).toHaveBeenCalled();
    });
  });
});

describe('buildMockConfig', () => {
  it('applies the dev-server delays when isDevServer is true', () => {
    const config = buildMockConfig({}, true);
    expect(config.mediaDelayMs).toBe(LOCAL_DEV_MEDIA_DELAY_MS);
    expect(config.textDelayMs ?? 0).toBeGreaterThan(0);
    expect(config.classifierDelayMs ?? 0).toBeGreaterThan(0);
  });

  it('zeroes all delays when isDevServer is false (vitest, E2E, CI, production)', () => {
    const config = buildMockConfig({}, false);
    expect(config.mediaDelayMs).toBe(0);
    expect(config.textDelayMs).toBe(0);
    expect(config.classifierDelayMs).toBe(0);
  });

  it('lets an explicit mockConfig override win over the dev-server default', () => {
    const config = buildMockConfig({ mockConfig: { mediaDelayMs: 0, textDelayMs: 5 } }, true);
    expect(config.mediaDelayMs).toBe(0);
    expect(config.textDelayMs).toBe(5);
  });
});
