import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithValidatedRedirects } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { createVideoAdapter, videoEstimateInputs } from './video-adapter.js';

// The production download path replaces the SDK's built-in download, so it must
// itself perform the SDK's SSRF/redirect validation via this exported helper.
// Mock only that one export (a true external seam) so production-branch tests
// can drive the download without a real network hop while proving the
// redirect-validating fetch — not a bare fetch — is what runs.
vi.mock('@ai-sdk/provider-utils', async (importActual) => {
  const actual = await importActual<typeof import('@ai-sdk/provider-utils')>();
  return { ...actual, fetchWithValidatedRedirects: vi.fn() };
});
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
  vi.unstubAllGlobals();
  vi.mocked(fetchWithValidatedRedirects).mockReset();
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

/**
 * A download Response whose body is a chunked ReadableStream, tracking how many
 * bytes the reader actually pulled and whether the body was consumed at all —
 * so a test can assert the byte cap rejected before/during materialization.
 */
function trackedDownload(
  bytes: Uint8Array,
  options: { chunkSize?: number; contentLength?: string; contentType?: string } = {}
): { response: () => Response; pulled: () => number; consumed: () => boolean } {
  let pulled = 0;
  let consumed = false;
  const chunkSize = options.chunkSize ?? bytes.byteLength;
  return {
    pulled: () => pulled,
    consumed: () => consumed,
    response: () => {
      let offset = 0;
      // highWaterMark 0: the stream pulls only when a reader actively reads, so
      // `consumed` distinguishes "body was read" from the default eager one-chunk
      // prefetch a highWaterMark-1 stream performs at construction.
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            consumed = true;
            if (offset >= bytes.byteLength) {
              controller.close();
              return;
            }
            const end = Math.min(offset + chunkSize, bytes.byteLength);
            const chunk = bytes.slice(offset, end);
            pulled += chunk.byteLength;
            offset = end;
            controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 }
      );
      const headers: Record<string, string> = {};
      if (options.contentLength !== undefined) headers['content-length'] = options.contentLength;
      if (options.contentType !== undefined) headers['content-type'] = options.contentType;
      return new Response(stream, { status: 200, headers });
    },
  };
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

describe('createVideoAdapter download byte cap', () => {
  it('rejects before reading the body when content-length exceeds the remaining budget', async () => {
    const download = trackedDownload(MP4_BYTES, {
      contentLength: '100000',
      contentType: 'video/mp4',
    });
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch([
        () => submitResponse(),
        () => pollResponse(),
        () => download.response(),
      ]),
    });

    await expect(
      collect(
        adapter.infer(videoRequest('A drone shot'), testDescriptor(), {
          mapFilePart,
          downloadByteCap: 16,
        })
      )
    ).rejects.toMatchObject({ name: 'DownloadByteCapExceeded' });
    // The pre-check throws off the header alone — the body is never touched.
    expect(download.consumed()).toBe(false);
  });

  it('aborts mid-stream once the streamed bytes cross the cap, never materializing the whole artifact', async () => {
    const full = new Uint8Array(64);
    const download = trackedDownload(full, { chunkSize: 4 });
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch([
        () => submitResponse(),
        () => pollResponse(),
        () => download.response(),
      ]),
    });

    await expect(
      collect(
        adapter.infer(videoRequest('A drone shot'), testDescriptor(), {
          mapFilePart,
          downloadByteCap: 16,
        })
      )
    ).rejects.toMatchObject({ name: 'DownloadByteCapExceeded' });
    // Reading stopped near the cap; the full 64-byte artifact never materialized.
    expect(download.pulled()).toBeGreaterThanOrEqual(16);
    expect(download.pulled()).toBeLessThan(full.byteLength);
  });

  it('completes a within-cap chunked download with the bytes reassembled intact', async () => {
    const download = trackedDownload(MP4_BYTES, { chunkSize: 3, contentLength: '8' });
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch([
        () => submitResponse(),
        () => pollResponse(),
        () => download.response(),
      ]),
    });

    const events = await collect(
      adapter.infer(videoRequest('A drone shot'), testDescriptor(), {
        mapFilePart,
        downloadByteCap: 1_000_000,
      })
    );

    // The SDK sniffs video/mp4 off the reassembled ftyp header — proof the
    // chunk reassembly preserved the exact bytes.
    expect(events).toContainEqual({
      kind: 'media-start',
      index: 0,
      modality: 'video',
      mimeType: 'video/mp4',
    });
    expect(events.at(-1)?.kind).toBe('finish');
    expect(download.pulled()).toBe(MP4_BYTES.byteLength);
  });

  it('fails as a typed upstream error when the download body is empty', async () => {
    const adapter = createVideoAdapter({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch([
        () => submitResponse(),
        () => pollResponse(),
        () => new Response(null, { status: 200, headers: { 'content-type': 'video/mp4' } }),
      ]),
    });

    await expect(
      collect(
        adapter.infer(videoRequest('A drone shot'), testDescriptor(), {
          mapFilePart,
          downloadByteCap: 1_000_000,
        })
      )
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });
});

describe('createVideoAdapter production download (no injected fetch)', () => {
  // Submit + poll ride the SDK's lazily-resolved globalThis.fetch; the download
  // rides the mocked fetchWithValidatedRedirects. So a production adapter (no
  // injected fetch) can be driven end-to-end without a real network hop.
  function stubSubmitAndPoll(): void {
    vi.stubGlobal('fetch', scriptedFetch([() => submitResponse(), () => pollResponse()]));
  }

  it('routes the download through the redirect-validating fetch and aborts an over-budget stream', async () => {
    const full = new Uint8Array(64);
    const download = trackedDownload(full, { chunkSize: 4 });
    stubSubmitAndPoll();
    vi.mocked(fetchWithValidatedRedirects).mockResolvedValue(download.response());
    const adapter = createVideoAdapter({ apiKey: 'test-key', pollIntervalMs: 1 });

    await expect(
      collect(
        adapter.infer(videoRequest('A drone shot'), testDescriptor(), {
          mapFilePart,
          downloadByteCap: 16,
        })
      )
    ).rejects.toMatchObject({ name: 'DownloadByteCapExceeded' });

    // SSRF hardening preserved: the download went through the redirect-validating
    // fetch, never a bare fetch.
    expect(vi.mocked(fetchWithValidatedRedirects)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchWithValidatedRedirects).mock.calls[0]?.[0]).toMatchObject({
      url: DOWNLOAD_URL,
    });
    expect(download.pulled()).toBeLessThan(full.byteLength);
  });

  it('completes a within-cap production download with the bytes reassembled intact', async () => {
    const download = trackedDownload(MP4_BYTES, { chunkSize: 3 });
    stubSubmitAndPoll();
    vi.mocked(fetchWithValidatedRedirects).mockResolvedValue(download.response());
    const adapter = createVideoAdapter({ apiKey: 'test-key', pollIntervalMs: 1 });

    const events = await collect(
      adapter.infer(videoRequest('A drone shot'), testDescriptor(), {
        mapFilePart,
        downloadByteCap: 1_000_000,
      })
    );

    expect(events).toContainEqual({
      kind: 'media-start',
      index: 0,
      modality: 'video',
      mimeType: 'video/mp4',
    });
    expect(events.at(-1)?.kind).toBe('finish');
    expect(vi.mocked(fetchWithValidatedRedirects)).toHaveBeenCalledTimes(1);
  });

  it('bounds a production download at the SDK 2 GiB floor when no per-call cap is threaded', async () => {
    const download = trackedDownload(MP4_BYTES);
    stubSubmitAndPoll();
    vi.mocked(fetchWithValidatedRedirects).mockResolvedValue(download.response());
    const adapter = createVideoAdapter({ apiKey: 'test-key', pollIntervalMs: 1 });

    // No downloadByteCap: the small artifact rides the DEFAULT_MAX_DOWNLOAD_SIZE
    // fallback and completes.
    const events = await collect(
      adapter.infer(videoRequest('A drone shot'), testDescriptor(), { mapFilePart })
    );

    expect(events.at(-1)?.kind).toBe('finish');
    expect(vi.mocked(fetchWithValidatedRedirects)).toHaveBeenCalledTimes(1);
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

  it('rejects a fractional durationSeconds (deterministic pricing needs integer seconds)', () => {
    expect(() =>
      videoEstimateInputs(videoRequest('A drone shot', { durationSeconds: 2.5 }))
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});
