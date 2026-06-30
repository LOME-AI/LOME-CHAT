import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CassetteMissError, createCassetteFetch, replayFromCassette } from './recording-fetch.js';
import { createCassetteStore, type Cassette, type CassetteStore } from './cassette-store.js';

let rootDir: string;
let store: CassetteStore;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'recording-fetch-'));
  store = createCassetteStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v3/ai/language-model';

function gatewayRequest(body: unknown): [string, RequestInit] {
  return [
    GATEWAY_URL,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ai-language-model-id': 'openai/gpt-4o',
      },
      body: JSON.stringify(body),
    },
  ];
}

function upstreamReturning(bodyText: string, status = 200): typeof globalThis.fetch {
  return vi.fn(() =>
    Promise.resolve(
      new Response(bodyText, {
        status,
        headers: { 'content-type': 'text/event-stream' },
      })
    )
  );
}

/** The single cassette the test just recorded; fails the test when absent. */
function readSingleCassette(fromStore: CassetteStore): Cassette {
  const hash = fromStore.list()[0];
  const cassette = hash === undefined ? undefined : fromStore.read(hash);
  if (cassette === undefined) throw new Error('expected exactly one recorded cassette');
  return cassette;
}

describe('createCassetteFetch in record mode', () => {
  it('passes a miss through to the real fetch and returns its body', async () => {
    const cassetteFetch = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
    });

    const response = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"type":"finish"}\n\n');
  });

  it('records the exchange so a second identical request replays without upstream', async () => {
    const realFetch = upstreamReturning('data: {"type":"finish"}\n\n');
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    const first = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
    await first.text();
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const second = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(await second.text()).toBe('data: {"type":"finish"}\n\n');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('records the canonical request alongside the response', async () => {
    const cassetteFetch = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
    });

    const response = await cassetteFetch(
      ...gatewayRequest({ providerOptions: { gateway: { zeroDataRetention: true } } })
    );
    await response.text();
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const recorded = readSingleCassette(store).request;
    expect(recorded?.method).toBe('POST');
    expect(recorded?.pathAndQuery).toBe('/v3/ai/language-model');
    expect(recorded?.headers['ai-language-model-id']).toBe('openai/gpt-4o');
    const parsedBody: unknown = JSON.parse(recorded?.body ?? '{}');
    expect(parsedBody).toEqual({ providerOptions: { gateway: { zeroDataRetention: true } } });
  });

  it('does not record a 4xx/5xx response', async () => {
    const cassetteFetch = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('{"error":{"message":"nope"}}', 429),
    });

    const response = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
    await response.text();

    expect(response.status).toBe(429);
    expect(store.list()).toEqual([]);
  });

  it('records a bodyless response and replays status and headers', async () => {
    const realFetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 204, headers: { 'x-marker': 'yes' } }))
    ) as unknown as typeof globalThis.fetch;
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    await cassetteFetch(...gatewayRequest({ prompt: 'empty' }));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const replayed = await cassetteFetch(...gatewayRequest({ prompt: 'empty' }));

    expect(replayed.status).toBe(204);
    expect(replayed.headers.get('x-marker')).toBe('yes');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast when record mode is configured without a real fetch', () => {
    expect(() => createCassetteFetch({ store, mode: 'record' })).toThrow(/realFetch/);
  });
});

describe('replayFromCassette', () => {
  it('throws on a hand-edited cassette with no exchanges', () => {
    expect(() =>
      replayFromCassette({ version: 1, exchanges: [], recordedAt: '2026-06-11T00:00:00.000Z' })
    ).toThrow(/exchanges is empty/);
  });
});

describe('createCassetteFetch in replay-only mode', () => {
  it('replays a stored cassette', async () => {
    const recorder = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
    });
    const recorded = await recorder(...gatewayRequest({ prompt: 'hi' }));
    await recorded.text();
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const replayFetch = createCassetteFetch({ store, mode: 'replay-only' });
    const replayed = await replayFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(await replayed.text()).toBe('data: {"type":"finish"}\n\n');
  });

  it('throws CassetteMissError on a miss instead of recording', async () => {
    const replayFetch = createCassetteFetch({ store, mode: 'replay-only' });

    await expect(replayFetch(...gatewayRequest({ prompt: 'unseen' }))).rejects.toBeInstanceOf(
      CassetteMissError
    );
    expect(store.list()).toEqual([]);
  });

  it('names the request shape but never the body in the miss error', async () => {
    const replayFetch = createCassetteFetch({ store, mode: 'replay-only' });

    const error = await replayFetch(...gatewayRequest({ prompt: 'secret-content' })).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(CassetteMissError);
    expect((error as CassetteMissError).message).toContain('/v3/ai/language-model');
    expect((error as CassetteMissError).message).not.toContain('secret-content');
  });
});
