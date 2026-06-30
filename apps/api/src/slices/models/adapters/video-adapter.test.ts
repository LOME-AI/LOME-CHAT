import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createVideoAdapter, videoEstimateInputs } from './video-adapter.js';
import { createCassetteStore, type CassetteStore } from './cassette/cassette-store.js';
import { createCassetteFetch } from './cassette/recording-fetch.js';
import { createFixtureFetch } from './cassette/failure-fixtures.js';
import { VIDEO_FAILURE_FIXTURES } from './cassette/media-failure-fixtures.js';
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
  rootDir = mkdtempSync(path.join(tmpdir(), 'video-adapter-'));
  store = createCassetteStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function testDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'google/veo-3.1-generate-001',
    provider: 'google',
    version: '1',
    inputs: ['text'],
    outputs: ['video'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    fetchedAt: 0,
    ...overrides,
  };
}

function videoRequest(text: string, parameters: Record<string, unknown> = {}): InferenceRequest {
  return {
    model: 'google/veo-3.1-generate-001',
    inputs: [{ modality: 'text', text }],
    parameters,
    outputs: ['video'],
  };
}

const MP4_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
const MP4_BASE64 = Buffer.from(MP4_BYTES).toString('base64');

/**
 * SYNTHETIC wire response: the gateway video-model SSE contract (one
 * terminal `result` data event) authored from @ai-sdk/gateway's event
 * schema, not recorded from the live gateway (no credentials here).
 */
function videoResultEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    videos: [{ type: 'base64', data: MP4_BASE64, mediaType: 'video/mp4' }],
    providerMetadata: { gateway: { generationId: 'gen_vid' } },
    ...overrides,
  };
}

function sseResponse(event: unknown): Response {
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
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
  ref: 'media/conv/msg/uuid-2',
  mimeType: 'video/mp4',
  modality: 'video',
  byteLength: MP4_BYTES.byteLength,
  metadata: {},
};

const mapFilePart: FilePartMapper = (part, index) => [
  { kind: 'media-start', index, modality: 'video', mimeType: part.mediaType },
  { kind: 'media-done', index, value: mediaValue },
];

describe('createVideoAdapter cassette replay', () => {
  it('maps a replayed video generation to the exact typed event sequence', async () => {
    const recorder = createVideoAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(videoResultEvent())]),
      }),
    });
    await collect(recorder.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const replayer = createVideoAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({ store, mode: 'replay-only' }),
    });
    const events = await collect(
      replayer.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart })
    );

    expect(events).toEqual([
      { kind: 'media-start', index: 0, modality: 'video', mimeType: 'video/mp4' },
      { kind: 'media-done', index: 0, value: mediaValue },
      {
        kind: 'finish',
        metadata: {
          generationId: 'gen_vid',
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });
});

describe('createVideoAdapter ZDR', () => {
  it('sends the gateway zero-data-retention flag on every recorded request', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(videoResultEvent())]),
      }),
    });

    await collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    for (const hash of store.list()) {
      const request = store.read(hash)?.request;
      expect(request?.pathAndQuery).toBe('/v3/ai/video-model');
      const body = z
        .looseObject({
          providerOptions: z.looseObject({
            gateway: z.looseObject({ zeroDataRetention: z.boolean() }),
          }),
        })
        .parse(JSON.parse(request?.body ?? '{}'));
      expect(body.providerOptions.gateway.zeroDataRetention).toBe(true);
    }
  });

  it('refuses a ZDR-unreachable descriptor without calling the gateway', () => {
    const adapter = createVideoAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() =>
      adapter.infer(videoRequest('A drone shot'), testDescriptor({ zdrReachable: false }), {
        mapFilePart,
      })
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});

describe('createVideoAdapter parameters', () => {
  it('wires aspectRatio, resolution, and duration onto the gateway request body', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(videoResultEvent())]),
      }),
    });

    await collect(
      adapter.infer(
        videoRequest('A drone shot', {
          aspectRatio: '16:9',
          resolution: '720p',
          durationSeconds: 8,
        }),
        testDescriptor(),
        { mapFilePart }
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ aspectRatio: '16:9', resolution: '720p', duration: 8 });
  });

  it('rejects a parameter key the adapter cannot wire', async () => {
    const adapter = createVideoAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(videoRequest('A drone shot', { fps: 60 }), testDescriptor(), { mapFilePart })
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('rejects a request whose model differs from the descriptor', () => {
    const adapter = createVideoAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() =>
      adapter.infer({ ...videoRequest('A drone shot'), model: 'google/other' }, testDescriptor(), {
        mapFilePart,
      })
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});

describe('createVideoAdapter result mapping', () => {
  it('treats a result without gateway generation metadata as truncated', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(videoResultEvent({ providerMetadata: undefined }))]),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'truncated_stream' });
  });

  it('propagates a generated file without a mapper contract as a defect', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(videoResultEvent())]),
    });

    const consumed = collect(adapter.infer(videoRequest('A drone shot'), testDescriptor()));

    await expect(consumed).rejects.toThrow(/mapFilePart/);
    await expect(consumed).rejects.toMatchObject({ name: 'AdapterDefect' });
  });
});

describe('createVideoAdapter failure shapes', () => {
  it('classifies the no_providers_available fixture as the typed ZDR fail-closed error', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(VIDEO_FAILURE_FIXTURES.noProvidersAvailable),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'no_providers_available' });
  });

  it('classifies the 429 fixture as rate_limited', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(VIDEO_FAILURE_FIXTURES.rateLimited),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'rate_limited' });
  });

  it('classifies the truncated SSE fixture as a typed upstream error', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(VIDEO_FAILURE_FIXTURES.truncatedStream),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'upstream_error' });
  });

  it('classifies an empty video list as an empty completion', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(videoResultEvent({ videos: [] }))]),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'empty_completion' });
  });
});

describe('createVideoAdapter abort', () => {
  it('aborts the underlying gateway fetch when the signal fires', async () => {
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
    const adapter = createVideoAdapter({ apiKey: 'test-key', fetch: hangingFetch });
    const controller = new AbortController();

    const consumed = collect(
      adapter.infer(videoRequest('A drone shot'), testDescriptor(), {
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

describe('createVideoAdapter construction', () => {
  it('constructs a production adapter without a custom fetch', () => {
    const adapter = createVideoAdapter({ apiKey: 'test-key' });

    expect(typeof adapter.infer).toBe('function');
  });
});

describe('videoEstimateInputs', () => {
  it('defaults to a single video when no parameters are declared', () => {
    expect(videoEstimateInputs(videoRequest('A drone shot'))).toEqual({ n: 1 });
  });

  it('carries the declared count, dimensions, and duration', () => {
    expect(
      videoEstimateInputs(
        videoRequest('A drone shot', {
          n: 2,
          aspectRatio: '16:9',
          resolution: '1080p',
          durationSeconds: 6,
        })
      )
    ).toEqual({ n: 2, aspectRatio: '16:9', resolution: '1080p', durationSeconds: 6 });
  });

  it('rejects a parameter key the adapter cannot wire', () => {
    expect(() => videoEstimateInputs(videoRequest('A drone shot', { fps: 60 }))).toThrow(
      expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' })
    );
  });
});
