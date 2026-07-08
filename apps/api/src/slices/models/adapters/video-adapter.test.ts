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
    releasedAt: 1_700_000_000,
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
const DOWNLOAD_URL = 'https://openrouter.ai/api/v1/videos/vid-1/download.mp4';

function jsonResponse(body: unknown): Response {
  return Response.json(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * SYNTHETIC OpenRouter video wire: submit (`POST /videos`) → poll
 * (`GET /videos/{id}` until `completed`) → download (`GET unsigned_url`). The
 * generation id and inline cost ride the completed poll's provider metadata.
 */
function submitResponse(): Response {
  return jsonResponse({
    id: 'vid-1',
    polling_url: 'https://openrouter.ai/api/v1/videos/vid-1',
    status: 'pending',
  });
}

function pollResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    id: 'vid-1',
    polling_url: 'https://openrouter.ai/api/v1/videos/vid-1',
    status: 'completed',
    generation_id: 'gen_vid',
    unsigned_urls: [DOWNLOAD_URL],
    usage: { cost: 0.9 },
    ...overrides,
  });
}

function downloadResponse(): Response {
  return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
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

/** The happy-path three-call sequence (submit, poll, download). */
function videoFlow(pollOverrides: Record<string, unknown> = {}): (() => Response)[] {
  return [() => submitResponse(), () => pollResponse(pollOverrides), () => downloadResponse()];
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
  it('maps a replayed video generation (submit/poll/download) to the typed event sequence', async () => {
    const recorder = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: createCassetteFetch({ store, mode: 'record', realFetch: scriptedFetch(videoFlow()) }),
    });
    await collect(recorder.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(3);
    });

    const replayer = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
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
          providerCostUsd: 0.9,
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });
});

describe('createVideoAdapter ZDR', () => {
  it('sends the ZDR routing block in the submit request body', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: createCassetteFetch({ store, mode: 'record', realFetch: scriptedFetch(videoFlow()) }),
    });

    await collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(3);
    });

    const submit = store
      .list()
      .map((hash) => store.read(hash)?.request)
      .find((request) => request?.method === 'POST' && request.pathAndQuery === '/api/v1/videos');
    expect(submit).toBeDefined();
    const body = z
      .looseObject({
        provider: z.looseObject({
          zdr: z.boolean(),
          data_collection: z.string(),
          allow_fallbacks: z.boolean(),
        }),
      })
      .parse(JSON.parse(submit?.body ?? '{}'));
    expect(body.provider.zdr).toBe(true);
    expect(body.provider.data_collection).toBe('deny');
    expect(body.provider.allow_fallbacks).toBe(false);
  });

  it('refuses a ZDR-unreachable descriptor without calling the provider', () => {
    const adapter = createVideoAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() =>
      adapter.infer(videoRequest('A drone shot'), testDescriptor({ zdrReachable: false }), {
        mapFilePart,
      })
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});

describe('createVideoAdapter parameters', () => {
  it('wires aspect_ratio, size, and duration onto the submit request body', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: createCassetteFetch({ store, mode: 'record', realFetch: scriptedFetch(videoFlow()) }),
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
      expect(store.list()).toHaveLength(3);
    });

    const submit = store
      .list()
      .map((hash) => store.read(hash)?.request)
      .find((request) => request?.method === 'POST' && request.pathAndQuery === '/api/v1/videos');
    const body: unknown = JSON.parse(submit?.body ?? '{}');
    expect(body).toMatchObject({ aspect_ratio: '16:9', size: '720p', duration: 8 });
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
  it('carries the inline cost and generation id on the finish', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch(videoFlow()),
    });

    const events = await collect(
      adapter.infer(videoRequest('A drone shot', { n: 1 }), testDescriptor(), { mapFilePart })
    );

    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        generationId: 'gen_vid',
        providerCostUsd: 0.9,
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'stop',
      },
    });
  });

  it('omits cost and generation id when the completed poll reports neither', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch(videoFlow({ generation_id: undefined, usage: undefined })),
    });

    const events = await collect(
      adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart })
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
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch(videoFlow()),
    });

    const consumed = collect(adapter.infer(videoRequest('A drone shot'), testDescriptor()));

    await expect(consumed).rejects.toThrow(/mapFilePart/);
    await expect(consumed).rejects.toMatchObject({ name: 'AdapterDefect' });
  });

  it('sniffs the mime type when the download response omits content-type', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch([
        () => submitResponse(),
        () => pollResponse(),
        () => new Response(MP4_BYTES, { status: 200 }),
      ]),
    });

    const events = await collect(
      adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart })
    );

    // The URL declared video/mp4; with no content-type header the SDK sniffs it.
    expect(events).toContainEqual({
      kind: 'media-start',
      index: 0,
      modality: 'video',
      mimeType: 'video/mp4',
    });
  });

  it('threads a live (non-aborted) signal through the download', async () => {
    const controller = new AbortController();
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch(videoFlow()),
    });

    const events = await collect(
      adapter.infer(videoRequest('A drone shot'), testDescriptor(), {
        mapFilePart,
        signal: controller.signal,
      })
    );

    expect(events.at(-1)?.kind).toBe('finish');
  });

  it('fails when the video download itself returns a non-ok response', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch([
        () => submitResponse(),
        () => pollResponse(),
        () => new Response('gone', { status: 404 }),
      ]),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });
});

describe('createVideoAdapter failure shapes', () => {
  it('classifies the no_providers_available fixture as the typed ZDR fail-closed error', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: createFixtureFetch(VIDEO_FAILURE_FIXTURES.noProvidersAvailable),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'no_providers_available' });
  });

  it('classifies the 429 fixture as rate_limited', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: createFixtureFetch(VIDEO_FAILURE_FIXTURES.rateLimited),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'rate_limited' });
  });

  it('classifies the malformed submit response as a typed upstream error', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: createFixtureFetch(VIDEO_FAILURE_FIXTURES.malformedResponse),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'upstream_error' });
  });

  it('classifies an empty video list as an empty completion', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch([() => submitResponse(), () => pollResponse({ unsigned_urls: [] })]),
    });

    await expect(
      collect(adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'empty_completion' });
  });
});

describe('createVideoAdapter abort', () => {
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
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: hangingFetch,
    });
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
