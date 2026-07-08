import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createImageAdapter, imageEstimateInputs } from './image-adapter.js';
import { createCassetteStore, type CassetteStore } from './cassette/cassette-store.js';
import { createCassetteFetch } from './cassette/recording-fetch.js';
import { createFixtureFetch } from './cassette/failure-fixtures.js';
import { IMAGE_FAILURE_FIXTURES } from './cassette/media-failure-fixtures.js';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  ModelDescriptor,
} from '@hushbox/shared';

let rootDir: string;
let store: CassetteStore;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'image-adapter-'));
  store = createCassetteStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function testDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'google/imagen-4.0-generate-001',
    provider: 'google',
    version: '1',
    inputs: ['text'],
    outputs: ['image'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
    ...overrides,
  };
}

function imageRequest(text: string, parameters: Record<string, unknown> = {}): InferenceRequest {
  return {
    model: 'google/imagen-4.0-generate-001',
    inputs: [{ modality: 'text', text }],
    parameters,
    outputs: ['image'],
  };
}

/** PNG signature bytes so the SDK's media-type sniffing is deterministic. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

/**
 * SYNTHETIC wire response: OpenRouter's `/images` JSON contract (`data` is an
 * array of `{ b64_json }`; no provider metadata, no inline cost), authored from
 * the provider schema, not recorded from the live provider (no credentials).
 */
function imageResponseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: [{ b64_json: PNG_BASE64 }],
    usage: { prompt_tokens: 13, completion_tokens: 1568, total_tokens: 1581 },
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return Response.json(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Serves each scripted response once, in order; throws when exhausted. */
function scriptedFetch(responses: (() => Response)[]): typeof globalThis.fetch {
  let next = 0;
  return function scripted(): Promise<Response> {
    const make = responses[next];
    next += 1;
    if (make === undefined) throw new Error(`scriptedFetch exhausted after ${String(next - 1)}`);
    return Promise.resolve(make());
  };
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const mediaValue: MediaValue = {
  ref: 'media/conv/msg/uuid-1',
  mimeType: 'image/png',
  modality: 'image',
  byteLength: PNG_BYTES.byteLength,
  metadata: {},
};

const mapFilePart: FilePartMapper = (part, index) => [
  { kind: 'media-start', index, modality: 'image', mimeType: part.mediaType },
  { kind: 'media-done', index, value: mediaValue },
];

describe('createImageAdapter cassette replay', () => {
  it('maps a replayed image generation to the exact typed event sequence (no cost)', async () => {
    const recorder = createImageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => jsonResponse(imageResponseBody())]),
      }),
    });
    await collect(recorder.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const replayer = createImageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({ store, mode: 'replay-only' }),
    });
    const events = await collect(
      replayer.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart })
    );

    // Image emits no generation id and no cost — settlement uses the estimate.
    expect(events).toEqual([
      { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
      { kind: 'media-done', index: 0, value: mediaValue },
      {
        kind: 'finish',
        metadata: {
          usage: { inputTokens: 13, outputTokens: 1568 },
          finishReason: 'stop',
        },
      },
    ]);
  });
});

describe('createImageAdapter ZDR', () => {
  it('sends the ZDR routing block in the request body on every recorded request', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => jsonResponse(imageResponseBody())]),
      }),
    });

    await collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    for (const hash of store.list()) {
      const request = store.read(hash)?.request;
      expect(request?.pathAndQuery).toBe('/api/v1/images');
      const body = z
        .looseObject({
          provider: z.looseObject({
            zdr: z.boolean(),
            data_collection: z.string(),
            allow_fallbacks: z.boolean(),
          }),
        })
        .parse(JSON.parse(request?.body ?? '{}'));
      expect(body.provider.zdr).toBe(true);
      expect(body.provider.data_collection).toBe('deny');
      expect(body.provider.allow_fallbacks).toBe(false);
    }
  });

  it('refuses a ZDR-unreachable descriptor without calling the provider', () => {
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() =>
      adapter.infer(imageRequest('A red fox'), testDescriptor({ zdrReachable: false }), {
        mapFilePart,
      })
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});

describe('createImageAdapter parameters', () => {
  it('wires n, size, and aspect_ratio onto the request body', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([
          () =>
            jsonResponse(
              imageResponseBody({ data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }] })
            ),
        ]),
      }),
    });

    await collect(
      adapter.infer(
        imageRequest('A red fox', { n: 2, size: '1024x768', aspectRatio: '4:3' }),
        testDescriptor(),
        { mapFilePart }
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ n: 2, size: '1024x768', aspect_ratio: '4:3' });
  });

  it('rejects a parameter key the adapter cannot wire', async () => {
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(imageRequest('A red fox', { steps: 50 }), testDescriptor(), { mapFilePart })
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('rejects a request whose model differs from the descriptor', () => {
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() =>
      adapter.infer({ ...imageRequest('A red fox'), model: 'google/other' }, testDescriptor(), {
        mapFilePart,
      })
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});

describe('createImageAdapter result mapping', () => {
  it('defaults missing usage to zero and emits no generation id or cost', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => jsonResponse(imageResponseBody({ usage: undefined }))]),
    });

    const events = await collect(
      adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart })
    );

    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'stop',
      },
    });
  });

  it('propagates a generated file without a mapper contract as a defect', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => jsonResponse(imageResponseBody())]),
    });

    const consumed = collect(adapter.infer(imageRequest('A red fox'), testDescriptor()));

    await expect(consumed).rejects.toThrow(/mapFilePart/);
    await expect(consumed).rejects.toMatchObject({ name: 'AdapterDefect' });
  });
});

describe('createImageAdapter failure shapes', () => {
  it('classifies the no_providers_available fixture as the typed ZDR fail-closed error', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(IMAGE_FAILURE_FIXTURES.noProvidersAvailable),
    });

    await expect(
      collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'no_providers_available' });
  });

  it('classifies the 429 fixture as rate_limited', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(IMAGE_FAILURE_FIXTURES.rateLimited),
    });

    await expect(
      collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'rate_limited' });
  });

  it('classifies the malformed-response fixture as a typed upstream error', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(IMAGE_FAILURE_FIXTURES.malformedResponse),
    });

    await expect(
      collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'upstream_error' });
  });

  it('classifies an empty image list as an empty completion', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => jsonResponse(imageResponseBody({ data: [] }))]),
    });

    await expect(
      collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'empty_completion' });
  });
});

describe('createImageAdapter abort', () => {
  it('aborts the underlying provider fetch when the signal fires', async () => {
    let fetchedSignal: AbortSignal | undefined;
    const hangingFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      fetchedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: hangingFetch });
    const controller = new AbortController();

    const consumed = collect(
      adapter.infer(imageRequest('A red fox'), testDescriptor(), {
        mapFilePart,
        signal: controller.signal,
      })
    );
    await vi.waitFor(() => {
      expect(fetchedSignal).toBeDefined();
    });
    controller.abort();

    await expect(consumed).rejects.toMatchObject({ name: 'InferenceError', code: 'aborted' });
    expect(fetchedSignal?.aborted).toBe(true);
  });
});

describe('createImageAdapter construction', () => {
  it('constructs a production adapter without a custom fetch', () => {
    const adapter = createImageAdapter({ apiKey: 'test-key' });

    expect(typeof adapter.infer).toBe('function');
  });
});

describe('imageEstimateInputs', () => {
  it('defaults to a single image when no parameters are declared', () => {
    expect(imageEstimateInputs(imageRequest('A red fox'))).toEqual({ n: 1 });
  });

  it('carries the declared count and dimensions', () => {
    expect(
      imageEstimateInputs(imageRequest('A red fox', { n: 3, size: '1024x768', aspectRatio: '4:3' }))
    ).toEqual({ n: 3, size: '1024x768', aspectRatio: '4:3' });
  });

  it('rejects a parameter key the adapter cannot wire', () => {
    expect(() => imageEstimateInputs(imageRequest('A red fox', { steps: 50 }))).toThrow(
      expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' })
    );
  });
});
