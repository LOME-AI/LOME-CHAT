import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCassetteFetch } from './recording-fetch.js';
import { createCassetteStore } from './cassette-store.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function streamingResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function readAll(response: Response): Promise<string> {
  if (response.body === null) return '';
  let result = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    result += decoder.decode(chunk, { stream: true });
  }
  result += decoder.decode();
  return result;
}

describe('createCassetteFetch', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'cassette-fetch-test-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('first call (miss) — invokes realFetch and returns the original response', async () => {
    const realFetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const fetch = createCassetteFetch({
      store: createCassetteStore({ rootDir }),
      realFetch,
    });
    const response = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    expect(realFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await readAll(response)).toBe('{"ok":true}');
  });

  it('second call (hit) — replays the recorded response without calling realFetch', async () => {
    const realFetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const fetch = createCassetteFetch({
      store: createCassetteStore({ rootDir }),
      realFetch,
    });
    const first = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    await readAll(first); // drain so the cassette write completes
    realFetch.mockClear();
    const second = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    expect(realFetch).toHaveBeenCalledTimes(0);
    expect(second.status).toBe(200);
    expect(await readAll(second)).toBe('{"ok":true}');
  });

  it('replays multi-chunk streaming bodies preserving chunk count', async () => {
    const realFetch = vi.fn().mockResolvedValue(streamingResponse(['chunk1', 'chunk2', 'chunk3']));
    const fetch = createCassetteFetch({
      store: createCassetteStore({ rootDir }),
      realFetch,
    });
    const first = await fetch('https://x.test/stream', { method: 'POST', body: '{}' });
    expect(await readAll(first)).toBe('chunk1chunk2chunk3');

    realFetch.mockClear();
    const second = await fetch('https://x.test/stream', { method: 'POST', body: '{}' });
    expect(realFetch).toHaveBeenCalledTimes(0);

    // Pull chunks one by one and check each is non-empty (chunk boundary preserved)
    if (second.body === null) throw new Error('expected a body');
    const chunks: string[] = [];
    for await (const chunk of second.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(decoder.decode(chunk));
    }
    expect(chunks).toEqual(['chunk1', 'chunk2', 'chunk3']);
  });

  it('does NOT record 4xx responses — replay re-calls realFetch', async () => {
    const realFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate limited' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const fetch = createCassetteFetch({
      store: createCassetteStore({ rootDir }),
      realFetch,
    });
    const first = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    expect(first.status).toBe(429);
    await readAll(first);

    const second = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    expect(realFetch).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(200); // fresh real call, not a replayed 429
  });

  it('does NOT record a 403 auth/plan failure (ZDR-poisoning regression)', async () => {
    // A 403 ZdrUnauthorized is transient — it clears the moment the plan is
    // fixed, and costs nothing to re-run. Caching it replayed the stale failure
    // on every later run and poisoned CI, which is the bug this guards against.
    const realFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { error: { type: 'permission_denied' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const fetch = createCassetteFetch({
      store: createCassetteStore({ rootDir }),
      realFetch,
    });
    const first = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    expect(first.status).toBe(403);
    await readAll(first);

    const second = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    expect(realFetch).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(200); // a fixed plan is picked up live, never the stale 403
  });

  it('does NOT record 5xx responses — replay re-calls realFetch', async () => {
    const realFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'transient' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const fetch = createCassetteFetch({
      store: createCassetteStore({ rootDir }),
      realFetch,
    });
    const first = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    expect(first.status).toBe(503);
    await readAll(first);

    const second = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    expect(realFetch).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(200); // fresh real call
  });

  it('does NOT record network errors — replay re-throws on second call', async () => {
    const networkError = new TypeError('fetch failed');
    const realFetch = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const fetch = createCassetteFetch({
      store: createCassetteStore({ rootDir }),
      realFetch,
    });
    await expect(fetch('https://x.test/p', { method: 'POST', body: '{}' })).rejects.toBe(
      networkError
    );

    const second = await fetch('https://x.test/p', { method: 'POST', body: '{}' });
    expect(realFetch).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(200);
  });

  it('different request bodies → separate cassettes', async () => {
    const realFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { for: 'first' }))
      .mockResolvedValueOnce(jsonResponse(200, { for: 'second' }));
    const fetch = createCassetteFetch({
      store: createCassetteStore({ rootDir }),
      realFetch,
    });
    const a1 = await fetch('https://x.test/p', { method: 'POST', body: '{"a":1}' });
    await readAll(a1);
    const b1 = await fetch('https://x.test/p', { method: 'POST', body: '{"a":2}' });
    await readAll(b1);
    expect(realFetch).toHaveBeenCalledTimes(2);

    realFetch.mockClear();
    const a2 = await fetch('https://x.test/p', { method: 'POST', body: '{"a":1}' });
    const b2 = await fetch('https://x.test/p', { method: 'POST', body: '{"a":2}' });
    expect(realFetch).toHaveBeenCalledTimes(0);
    expect(await readAll(a2)).toBe('{"for":"first"}');
    expect(await readAll(b2)).toBe('{"for":"second"}');
  });
});
