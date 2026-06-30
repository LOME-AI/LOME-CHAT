import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGenerationInfoClient } from './generation-info-client.js';
import { createCassetteStore, type CassetteStore } from './cassette/cassette-store.js';
import { createCassetteFetch } from './cassette/recording-fetch.js';

let rootDir: string;
let store: CassetteStore;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'generation-info-'));
  store = createCassetteStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

/** SYNTHETIC: the gateway's /v1/generation record, authored from its response schema. */
function generationInfoBody(id: string): unknown {
  return {
    data: {
      id,
      total_cost: 0.0021,
      upstream_inference_cost: 0,
      usage: 0.0021,
      created_at: '2026-06-11T00:00:00.000Z',
      model: 'openai/gpt-4o',
      is_byok: false,
      provider_name: 'openai',
      streamed: true,
      finish_reason: 'stop',
      latency: 320,
      generation_time: 900,
      native_tokens_prompt: 12,
      native_tokens_completion: 5,
      native_tokens_reasoning: 0,
      native_tokens_cached: 0,
      native_tokens_cache_creation: 0,
      billable_web_search_calls: 0,
    },
  };
}

function jsonFetch(status: number, body: unknown): typeof globalThis.fetch {
  return () => Promise.resolve(Response.json(body, { status }));
}

describe('createGenerationInfoClient', () => {
  it('fetches the raw per-generation cost and stats', async () => {
    const client = createGenerationInfoClient({
      apiKey: 'test-key',
      fetch: jsonFetch(200, generationInfoBody('gen_1')),
    });

    const result = await client.fetchGenerationInfo('gen_1');

    const info = result._unsafeUnwrap();
    expect(info.generationId).toBe('gen_1');
    expect(info.totalCostUsd).toBe(0.0021);
    expect(info.raw).toMatchObject({ model: 'openai/gpt-4o', providerName: 'openai' });
  });

  it('replays a recorded generation-info exchange from the cassette store', async () => {
    const recordingClient = createGenerationInfoClient({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: jsonFetch(200, generationInfoBody('gen_2')),
      }),
    });
    const recorded = await recordingClient.fetchGenerationInfo('gen_2');
    recorded._unsafeUnwrap();
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const replayClient = createGenerationInfoClient({
      apiKey: 'test-key',
      fetch: createCassetteFetch({ store, mode: 'replay-only' }),
    });
    const replayedResult = await replayClient.fetchGenerationInfo('gen_2');
    const replayed = replayedResult._unsafeUnwrap();

    expect(replayed.totalCostUsd).toBe(0.0021);
  });

  it('maps the post-generation 404 window to not_found', async () => {
    const client = createGenerationInfoClient({
      apiKey: 'test-key',
      fetch: jsonFetch(404, { error: { message: 'not found', type: 'not_found' } }),
    });

    const result = await client.fetchGenerationInfo('gen_missing');

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('maps a 429 to rate_limited', async () => {
    const client = createGenerationInfoClient({
      apiKey: 'test-key',
      fetch: jsonFetch(429, { error: { message: 'slow down', type: 'rate_limit_exceeded' } }),
    });

    const result = await client.fetchGenerationInfo('gen_1');

    expect(result._unsafeUnwrapErr().code).toBe('rate_limited');
  });

  it('maps any other gateway failure to unavailable', async () => {
    const client = createGenerationInfoClient({
      apiKey: 'test-key',
      fetch: jsonFetch(500, { error: { message: 'boom', type: 'internal_server_error' } }),
    });

    const result = await client.fetchGenerationInfo('gen_1');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a network failure to unavailable', async () => {
    const client = createGenerationInfoClient({
      apiKey: 'test-key',
      fetch: () => Promise.reject(new Error('socket hang up')),
    });

    const result = await client.fetchGenerationInfo('gen_1');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('constructs a production client without a custom fetch', () => {
    const client = createGenerationInfoClient({ apiKey: 'test-key' });

    expect(typeof client.fetchGenerationInfo).toBe('function');
  });
});
