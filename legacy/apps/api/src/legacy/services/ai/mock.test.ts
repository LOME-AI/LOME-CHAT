import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CLASSIFIER_SYSTEM_PROMPT_MARKER, SMART_MODEL_ID } from '@hushbox/shared';
import { clearModelCache } from '@hushbox/shared/models';
import { createMockAIClient, CANNED_IMAGE, CANNED_VIDEO } from './mock.js';
import { E2E_MODEL_CATALOG } from './e2e-catalog.fixture.js';
import type {
  MockAIClient,
  ModelInfo,
  TextRequest,
  ImageRequest,
  VideoRequest,
  AudioRequest,
  InferenceEvent,
} from './types.js';

async function collectEvents(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/**
 * Inline catalog fixture used by mock.test.ts. The mock client routes
 * `listRawModels` through `fetchModels`, so tests need to stub the public
 * `/v1/models` fetch with a deterministic catalog. Models mirror the real
 * ZDR allow-list so `processModels` keeps them after filtering.
 */
const MOCK_CATALOG_FIXTURE = {
  object: 'list',
  data: [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      description: 'Fast text model',
      type: 'language',
      pricing: { input: '0.000003', output: '0.000015' },
      context_window: 200_000,
      created: 0,
    },
    {
      id: 'anthropic/claude-opus-4.6',
      name: 'Claude Opus 4.6',
      description: 'Most capable text model',
      type: 'language',
      pricing: { input: '0.000015', output: '0.000075' },
      context_window: 200_000,
      created: 0,
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      name: 'Claude Haiku 4.5',
      description: 'Cheap text model',
      type: 'language',
      pricing: { input: '0.0000003', output: '0.0000015' },
      context_window: 200_000,
      created: 0,
    },
    {
      id: 'openai/gpt-5-nano',
      name: 'GPT-5 Nano',
      description: 'Cheap general-purpose model',
      type: 'language',
      pricing: { input: '0.0000004', output: '0.0000016' },
      context_window: 200_000,
      created: 0,
    },
    {
      id: 'google/gemini-2.5-flash-lite',
      name: 'Gemini 2.5 Flash Lite',
      description: 'Lightweight, low-cost model',
      type: 'language',
      pricing: { input: '0.00000025', output: '0.0000012' },
      context_window: 200_000,
      created: 0,
    },
    {
      id: 'openai/gpt-5-mini',
      name: 'GPT-5 Mini',
      description: 'Balanced cost-quality model',
      type: 'language',
      pricing: { input: '0.0000005', output: '0.0000018' },
      context_window: 200_000,
      created: 0,
    },
    {
      id: 'google/imagen-4.0-generate-001',
      name: 'Imagen 4',
      description: 'High-quality image generation',
      type: 'image',
      pricing: { image: '0.04' },
    },
    {
      id: 'google/imagen-4.0-fast-generate-001',
      name: 'Imagen 4 Fast',
      description: 'Fast image generation',
      type: 'image',
      pricing: { image: '0.04' },
    },
  ],
};

function stubCatalog(fixture: unknown = MOCK_CATALOG_FIXTURE): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(fixture),
      } as Response)
    )
  );
}

describe('createMockAIClient', () => {
  let client: MockAIClient;

  beforeEach(() => {
    clearModelCache();
    stubCatalog();
    client = createMockAIClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('factory', () => {
    it('returns a client with isMock set to true', () => {
      expect(client.isMock).toBe(true);
    });

    it('exposes all AIClient methods', () => {
      expect(typeof client.listModels).toBe('function');
      expect(typeof client.getModel).toBe('function');
      expect(typeof client.stream).toBe('function');
      expect(typeof client.getGenerationStats).toBe('function');
    });

    it('exposes request-history helpers', () => {
      expect(typeof client.getRequestHistory).toBe('function');
      expect(typeof client.clearHistory).toBe('function');
    });
  });

  describe('classifier streaming', () => {
    function classifierRequest(): TextRequest {
      return {
        modality: 'text',
        model: 'cheap/c',
        messages: [
          {
            role: 'system',
            content: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nPick a model.\nAvailable: m/a, m/b`,
          },
          { role: 'user', content: '[USER START]: hello' },
        ],
      };
    }

    it('emits the configured resolution as text-deltas plus a finish event', async () => {
      const configured = createMockAIClient({
        classifierResolution: 'anthropic/claude-opus-4.6',
      });
      const events = await collectEvents(configured.stream(classifierRequest()));
      const text = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');
      expect(text).toBe('anthropic/claude-opus-4.6');
      expect(events.at(-1)?.kind).toBe('finish');
    });

    it('returns the default classifier resolution when none is configured', async () => {
      const events = await collectEvents(client.stream(classifierRequest()));
      const text = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');
      expect(text.length).toBeGreaterThan(0);
    });

    it('rejects the stream when classifier failure is configured', async () => {
      const failing = createMockAIClient({ classifierFailure: true });
      await expect(collectEvents(failing.stream(classifierRequest()))).rejects.toThrow(
        'Classifier unavailable (test)'
      );
    });

    it('delays the first classifier event by classifierDelayMs', async () => {
      // Real-classifier round-trip timing is ~1-3s; the mock resolves on the
      // microtask queue with no delay, so the "Choosing the best model…"
      // indicator never paints long enough for E2E to observe. The delay
      // option restores observability without slowing every test.
      const delayMs = 80;
      const delayed = createMockAIClient({
        classifierResolution: 'anthropic/claude-haiku-4.5',
        classifierDelayMs: delayMs,
      });
      const start = Date.now();
      await collectEvents(delayed.stream(classifierRequest()));
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(delayMs);
    });

    it('delays the failure rejection by classifierDelayMs as well', async () => {
      const delayMs = 80;
      const delayedFailure = createMockAIClient({
        classifierFailure: true,
        classifierDelayMs: delayMs,
      });
      const start = Date.now();
      await expect(collectEvents(delayedFailure.stream(classifierRequest()))).rejects.toThrow(
        'Classifier unavailable (test)'
      );
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(delayMs);
    });

    it('applies a default delay when classifierDelayMs is unset (observability in dev + E2E)', async () => {
      const defaulted = createMockAIClient({
        classifierResolution: 'anthropic/claude-haiku-4.5',
      });
      const start = Date.now();
      await collectEvents(defaulted.stream(classifierRequest()));
      const elapsed = Date.now() - start;
      // Default is large enough to make the "Choosing the best model…"
      // indicator observable without per-test header plumbing. Floor at 250ms
      // (well under the actual default) to absorb CI scheduler jitter.
      expect(elapsed).toBeGreaterThanOrEqual(250);
    });

    it('does not delay when classifierDelayMs is explicitly 0', async () => {
      const noDelay = createMockAIClient({
        classifierResolution: 'anthropic/claude-haiku-4.5',
        classifierDelayMs: 0,
      });
      const start = Date.now();
      await collectEvents(noDelay.stream(classifierRequest()));
      const elapsed = Date.now() - start;
      // Generous ceiling — the entire iteration drains on the microtask queue,
      // but we leave headroom for CI scheduler jitter.
      expect(elapsed).toBeLessThan(50);
    });

    it('does not classify when system prompt lacks the marker', async () => {
      const configured = createMockAIClient({
        classifierResolution: 'classifier/should-not-fire',
      });
      const request: TextRequest = {
        modality: 'text',
        model: 'm/a',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello, world!' },
        ],
      };
      const events = await collectEvents(configured.stream(request));
      const text = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');
      expect(text).toContain('Echo:\nHello, world!');
    });
  });

  describe('text streaming', () => {
    it('rejects the virtual Smart Model id (must be resolved before inference)', async () => {
      // The real gateway has no `smart-model` and returns "Model 'smart-model'
      // not found"; the mock mirrors that so a path forwarding the virtual id
      // instead of resolving it fails in tests, not just in production.
      const request: TextRequest = {
        modality: 'text',
        model: SMART_MODEL_ID,
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await expect(collectEvents(client.stream(request))).rejects.toThrow(/not found/);
    });

    it('echoes the last user message content', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello, world!' },
        ],
      };

      const events = await collectEvents(client.stream(request));
      const textContent = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');

      expect(textContent.startsWith('Echo:\nHello, world!')).toBe(true);
    });

    it('streams the echo as multiple coalesced text-delta chunks', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const events = await collectEvents(client.stream(request));
      const deltas = events.filter(
        (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
      );

      const joined = deltas.map((d) => d.content).join('');
      // Streamed in pieces (exercises the client's incremental-render path)…
      expect(deltas.length).toBeGreaterThan(1);
      // …but coalesced, not one delta per character (keeps SSE frame count low).
      expect(deltas.length).toBeLessThan(joined.length);
      expect(joined.startsWith('Echo:\nHi')).toBe(true);
    });

    it('ends with a finish event containing a generationId (no inline cost)', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const events = await collectEvents(client.stream(request));
      const finish = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'finish' }> => e.kind === 'finish'
      );

      expect(finish).toBeDefined();
      expect(finish!.providerMetadata).toBeDefined();
      expect(typeof finish!.providerMetadata!.generationId).toBe('string');
    });

    it('handles missing user message gracefully', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'system', content: 'System only' }],
      };

      const events = await collectEvents(client.stream(request));
      const textContent = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');

      expect(textContent.startsWith('Echo:\nNo message')).toBe(true);
    });

    it('uses the last user message when multiple exist', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Response' },
          { role: 'user', content: 'Second' },
        ],
      };

      const events = await collectEvents(client.stream(request));
      const textContent = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');

      expect(textContent.startsWith('Echo:\nSecond')).toBe(true);
    });

    it('delays between text-delta events by textDelayMs', async () => {
      const delayMs = 25;
      const delayed = createMockAIClient({ textDelayMs: delayMs });
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        // Long enough that the chunked echo spans several deltas, so the
        // inter-delta delay is exercised across multiple gaps.
        messages: [{ role: 'user', content: 'x'.repeat(120) }],
      };
      const start = Date.now();
      const events = await collectEvents(delayed.stream(request));
      const elapsed = Date.now() - start;
      const deltas = events.filter((e) => e.kind === 'text-delta').length;
      expect(deltas).toBeGreaterThan(3);
      expect(elapsed).toBeGreaterThanOrEqual(delayMs * (deltas - 1));
    });

    it('does not delay when textDelayMs is unset (default 0)', async () => {
      const fast = createMockAIClient();
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hello, world!' }],
      };
      const start = Date.now();
      await collectEvents(fast.stream(request));
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('image generation', () => {
    it('emits media-start, media-done, and finish events', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A cat wearing a hat',
      };

      const events = await collectEvents(client.stream(request));
      const kinds = events.map((e) => e.kind);

      expect(kinds).toEqual(['media-start', 'media-done', 'finish']);
    });

    it('emits media-start with image mediaType and image/jpeg mimeType', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A sunset',
      };

      const events = await collectEvents(client.stream(request));
      const start = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-start' }> => e.kind === 'media-start'
      );

      expect(start).toBeDefined();
      expect(start!.mediaType).toBe('image');
      expect(start!.mimeType).toBe('image/jpeg');
    });

    it('emits media-done with non-empty JPEG bytes and 400×300 dimensions', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A mountain',
      };

      const events = await collectEvents(client.stream(request));
      const done = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-done' }> => e.kind === 'media-done'
      );

      expect(done).toBeDefined();
      expect(done!.bytes.length).toBeGreaterThan(0);
      expect(done!.mimeType).toBe('image/jpeg');
      expect(done!.width).toBe(400);
      expect(done!.height).toBe(300);
    });

    it('reports dimensions matching the requested aspect ratio', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A cat',
        aspectRatio: '16:9',
      };
      const events = await collectEvents(client.stream(request));
      const done = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-done' }> => e.kind === 'media-done'
      );
      expect(done).toBeDefined();
      expect(done!.width! / done!.height!).toBeCloseTo(16 / 9);
    });

    it('canned image bytes start with the JPEG SOI marker', () => {
      expect(CANNED_IMAGE.length).toBeGreaterThan(0);
      expect(CANNED_IMAGE[0]).toBe(0xff);
      expect(CANNED_IMAGE[1]).toBe(0xd8);
      expect(CANNED_IMAGE[2]).toBe(0xff);
    });

    it('emits finish with a generationId (no inline cost)', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A forest',
      };

      const events = await collectEvents(client.stream(request));
      const finish = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'finish' }> => e.kind === 'finish'
      );

      expect(finish).toBeDefined();
      expect(finish!.providerMetadata).toBeDefined();
      expect(typeof finish!.providerMetadata!.generationId).toBe('string');
    });

    it('yields media-start immediately, then media-done after mediaDelayMs', async () => {
      const delayMs = 50;
      const delayed = createMockAIClient({ mediaDelayMs: delayMs });
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A cat wearing a hat',
      };
      const iterator = delayed.stream(request)[Symbol.asyncIterator]();

      const startedAt = Date.now();
      const first = await iterator.next();
      const afterStart = Date.now() - startedAt;
      const second = await iterator.next();
      const afterDone = Date.now() - startedAt;

      expect(first.value?.kind).toBe('media-start');
      expect(second.value?.kind).toBe('media-done');
      // The wait sits BETWEEN the two events, so the placeholder paints first
      // and then lingers for mediaDelayMs.
      expect(afterDone - afterStart).toBeGreaterThanOrEqual(delayMs);
    });

    it('does not delay media when mediaDelayMs is unset (default 0)', async () => {
      const fast = createMockAIClient();
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A cat',
      };
      const start = Date.now();
      await collectEvents(fast.stream(request));
      expect(Date.now() - start).toBeLessThan(50);
    });
  });

  describe('video generation', () => {
    it('emits media-start, media-done, and finish events', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A flying bird',
      };

      const events = await collectEvents(client.stream(request));
      const kinds = events.map((e) => e.kind);

      expect(kinds).toEqual(['media-start', 'media-done', 'finish']);
    });

    it('emits media-start with video mediaType and video/webm mimeType', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A wave',
      };

      const events = await collectEvents(client.stream(request));
      const start = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-start' }> => e.kind === 'media-start'
      );

      expect(start).toBeDefined();
      expect(start!.mediaType).toBe('video');
      expect(start!.mimeType).toBe('video/webm');
    });

    it('emits media-done with bytes and durationMs matching the canned video', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'Ocean',
      };

      const events = await collectEvents(client.stream(request));
      const done = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-done' }> => e.kind === 'media-done'
      );

      expect(done).toBeDefined();
      expect(done!.bytes.length).toBeGreaterThan(0);
      expect(done!.mimeType).toBe('video/webm');
      expect(done!.durationMs).toBe(3000);
    });

    it('reports dimensions matching the requested aspect ratio', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A bird',
        aspectRatio: '9:16',
      };
      const events = await collectEvents(client.stream(request));
      const done = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-done' }> => e.kind === 'media-done'
      );
      expect(done).toBeDefined();
      expect(done!.width! / done!.height!).toBeCloseTo(9 / 16);
    });

    it('canned video bytes carry the EBML header signature at offset 0', () => {
      expect(CANNED_VIDEO.length).toBeGreaterThan(0);
      expect(CANNED_VIDEO[0]).toBe(0x1a);
      expect(CANNED_VIDEO[1]).toBe(0x45);
      expect(CANNED_VIDEO[2]).toBe(0xdf);
      expect(CANNED_VIDEO[3]).toBe(0xa3);
    });

    it('rejects unsupported video duration with the same error shape as the real Gateway', async () => {
      // Veo 3.1 supports [4, 6, 8]. Passing 5 (its native default in 3.0)
      // exercises exactly the production code path that broke before the
      // store-level snap landed.
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1-generate-001',
        prompt: 'A flying bird',
        durationSeconds: 5,
      };

      await expect(collectEvents(client.stream(request))).rejects.toThrow(
        /Unsupported output video duration 5 seconds.*\[4,6,8\]/
      );
    });

    it('accepts a supported duration on a model with known capabilities', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1-generate-001',
        prompt: 'A flying bird',
        durationSeconds: 6,
      };

      const events = await collectEvents(client.stream(request));
      expect(events.map((e) => e.kind)).toEqual(['media-start', 'media-done', 'finish']);
    });

    it('delays media generation by mediaDelayMs while preserving event order', async () => {
      const delayMs = 50;
      const delayed = createMockAIClient({ mediaDelayMs: delayMs });
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A flying bird',
      };
      const start = Date.now();
      const events = await collectEvents(delayed.stream(request));
      expect(Date.now() - start).toBeGreaterThanOrEqual(delayMs);
      expect(events.map((e) => e.kind)).toEqual(['media-start', 'media-done', 'finish']);
    });
  });

  describe('audio generation', () => {
    it('emits media-start, media-done, and finish events', async () => {
      const request: AudioRequest = {
        modality: 'audio',
        model: 'some/audio-model',
        prompt: 'A soothing melody',
      };

      const events = await collectEvents(client.stream(request));
      const kinds = events.map((e) => e.kind);

      expect(kinds).toEqual(['media-start', 'media-done', 'finish']);
    });

    it('emits media-done with audio/mpeg mimeType and durationMs', async () => {
      const request: AudioRequest = {
        modality: 'audio',
        model: 'some/audio-model',
        prompt: 'Birds chirping',
      };

      const events = await collectEvents(client.stream(request));
      const done = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-done' }> => e.kind === 'media-done'
      );

      expect(done).toBeDefined();
      expect(done!.bytes.length).toBeGreaterThan(0);
      expect(done!.mimeType).toBe('audio/mpeg');
      expect(done!.durationMs).toBeGreaterThan(0);
    });

    it('delays media generation by mediaDelayMs while preserving event order', async () => {
      const delayMs = 50;
      const delayed = createMockAIClient({ mediaDelayMs: delayMs });
      const request: AudioRequest = {
        modality: 'audio',
        model: 'some/audio-model',
        prompt: 'A soothing melody',
      };
      const start = Date.now();
      const events = await collectEvents(delayed.stream(request));
      expect(Date.now() - start).toBeGreaterThanOrEqual(delayMs);
      expect(events.map((e) => e.kind)).toEqual(['media-start', 'media-done', 'finish']);
    });
  });

  describe('request history', () => {
    it('starts with empty history', () => {
      expect(client.getRequestHistory()).toEqual([]);
    });

    it('records text requests', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await collectEvents(client.stream(request));

      const history = client.getRequestHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject(request);
    });

    it('records image requests', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'Test image',
      };

      await collectEvents(client.stream(request));

      const history = client.getRequestHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject(request);
    });

    it('records multiple requests in order', async () => {
      const textRequest: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'First' }],
      };
      const imageRequest: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'Second',
      };

      await collectEvents(client.stream(textRequest));
      await collectEvents(client.stream(imageRequest));

      const history = client.getRequestHistory();
      expect(history).toHaveLength(2);
      expect(history[0]!.modality).toBe('text');
      expect(history[1]!.modality).toBe('image');
    });

    it('returns defensive copies', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await collectEvents(client.stream(request));

      const history1 = client.getRequestHistory();
      const history2 = client.getRequestHistory();
      expect(history1).not.toBe(history2);
      expect(history1).toEqual(history2);
    });

    it('clears history', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await collectEvents(client.stream(request));
      expect(client.getRequestHistory()).toHaveLength(1);

      client.clearHistory();
      expect(client.getRequestHistory()).toEqual([]);
    });
  });

  describe('zdrEnforced tracking', () => {
    it('records zdrEnforced=true on text requests', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Test' }],
      };
      await collectEvents(client.stream(request));
      const history = client.getRequestHistory();
      expect(history[0]?.zdrEnforced).toBe(true);
    });

    it('records zdrEnforced=true on image requests', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A sunset',
      };
      await collectEvents(client.stream(request));
      const history = client.getRequestHistory();
      expect(history[0]?.zdrEnforced).toBe(true);
    });

    it('records zdrEnforced=true on video requests', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A wave',
      };
      await collectEvents(client.stream(request));
      const history = client.getRequestHistory();
      expect(history[0]?.zdrEnforced).toBe(true);
    });

    it('records zdrEnforced=true on audio requests', async () => {
      const request: AudioRequest = {
        modality: 'audio',
        model: 'openai/tts-1',
        prompt: 'Hello.',
      };
      await collectEvents(client.stream(request));
      const history = client.getRequestHistory();
      expect(history[0]?.zdrEnforced).toBe(true);
    });

    it('records zdrEnforced=true on classifier (Smart Model) calls', async () => {
      const classifierRequest: TextRequest = {
        modality: 'text',
        model: 'cheap/c',
        messages: [
          {
            role: 'system',
            content: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nPick a model.\n- a/x — A.\n- b/y — B.`,
          },
          { role: 'user', content: '[USER START]: hi' },
        ],
      };
      await collectEvents(client.stream(classifierRequest));
      const history = client.getRequestHistory();
      expect(history).toHaveLength(1);
      expect(history[0]?.zdrEnforced).toBe(true);
    });
  });

  describe('failing models', () => {
    it('throws for a model in the configured failing set', async () => {
      const configured = createMockAIClient({ failingModels: ['bad/model'] });

      const request: TextRequest = {
        modality: 'text',
        model: 'bad/model',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await expect(collectEvents(configured.stream(request))).rejects.toThrow(
        'Model bad/model is unavailable'
      );
    });

    it('does not throw for models not in the failing set', async () => {
      const configured = createMockAIClient({ failingModels: ['bad/model'] });

      const request: TextRequest = {
        modality: 'text',
        model: 'good/model',
        messages: [{ role: 'user', content: 'Test' }],
      };

      const events = await collectEvents(configured.stream(request));
      expect(events.length).toBeGreaterThan(0);
    });

    it('fresh client with no failing config accepts any model', async () => {
      const fresh = createMockAIClient();
      const request: TextRequest = {
        modality: 'text',
        model: 'bad/model',
        messages: [{ role: 'user', content: 'Test' }],
      };

      const events = await collectEvents(fresh.stream(request));
      expect(events.length).toBeGreaterThan(0);
    });

    it('throws for image requests to failing models', async () => {
      const configured = createMockAIClient({ failingModels: ['bad/image-model'] });

      const request: ImageRequest = {
        modality: 'image',
        model: 'bad/image-model',
        prompt: 'Test',
      };

      await expect(collectEvents(configured.stream(request))).rejects.toThrow(
        'Model bad/image-model is unavailable'
      );
    });
  });

  describe('listModels', () => {
    it('returns a non-empty array of ModelInfo', async () => {
      const models = await client.listModels();
      expect(models.length).toBeGreaterThan(0);
    });

    it('returns models with all required fields', async () => {
      const models = await client.listModels();
      for (const model of models) {
        expect(typeof model.id).toBe('string');
        expect(typeof model.name).toBe('string');
        expect(typeof model.provider).toBe('string');
        expect(['text', 'image', 'audio', 'video']).toContain(model.modality);
        expect(typeof model.description).toBe('string');
        expect(model.pricing).toBeDefined();
        expect(model.capabilities).toBeDefined();
        expect(typeof model.isZdr).toBe('boolean');
      }
    });

    it('includes at least one text and one image model', async () => {
      const models = await client.listModels();
      const textModels = models.filter((m) => m.modality === 'text');
      const imageModels = models.filter((m) => m.modality === 'image');
      expect(textModels.length).toBeGreaterThan(0);
      expect(imageModels.length).toBeGreaterThan(0);
    });
  });

  describe('listRawModels', () => {
    it('returns a non-empty RawModel array with the gateway-shaped pricing fields', async () => {
      const raw = await client.listRawModels();
      expect(raw.length).toBeGreaterThan(0);
      for (const model of raw) {
        expect(typeof model.id).toBe('string');
        expect(typeof model.name).toBe('string');
        expect(['text', 'image', 'audio', 'video']).toContain(model.modality);
        expect(typeof model.context_length).toBe('number');
        expect(typeof model.pricing.prompt).toBe('string');
        expect(typeof model.pricing.completion).toBe('string');
        expect(Array.isArray(model.supported_parameters)).toBe(true);
        expect(Array.isArray(model.architecture.input_modalities)).toBe(true);
        expect(Array.isArray(model.architecture.output_modalities)).toBe(true);
      }
    });

    it('exposes the same id set as listModels — single source of truth', async () => {
      const [raw, info] = await Promise.all([client.listRawModels(), client.listModels()]);
      const rawIds = raw.map((m) => m.id).toSorted((a, b) => a.localeCompare(b));
      const infoIds = info.map((m) => m.id).toSorted((a, b) => a.localeCompare(b));
      expect(rawIds).toEqual(infoIds);
    });

    it('returns a defensive copy — mutating the result does not affect future calls', async () => {
      const first = await client.listRawModels();
      first.length = 0;
      const second = await client.listRawModels();
      expect(second.length).toBeGreaterThan(0);
    });

    it('feeds processModels with at least one premium text model so the tier gate has something to lock', async () => {
      const { processModels } = await import('@hushbox/shared/models');
      const raw = await client.listRawModels();
      const { premiumIds } = processModels(raw);
      expect(premiumIds.length).toBeGreaterThan(0);
    });

    it('exposes at least 5 non-premium text models so the multi-model max-selection flow has enough options', async () => {
      const { processModels } = await import('@hushbox/shared/models');
      const raw = await client.listRawModels();
      const { models, premiumIds } = processModels(raw);
      const nonPremiumText = models.filter(
        (m) => m.modality === 'text' && !premiumIds.includes(m.id)
      );
      expect(nonPremiumText.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('getModel', () => {
    it('returns the model matching the given id', async () => {
      const models = await client.listModels();
      const firstModel = models[0]!;
      const found = await client.getModel(firstModel.id);
      expect(found.id).toBe(firstModel.id);
    });

    it('throws for an unknown model id', async () => {
      await expect(client.getModel('nonexistent/model')).rejects.toThrow();
    });
  });

  describe('getGenerationStats', () => {
    interface TextPricedModel extends ModelInfo {
      pricing: { kind: 'token'; inputPerToken: number; outputPerToken: number };
    }

    /** Pick the first token-priced model from the mock catalog (fail-loud if none). */
    async function firstTextModel(): Promise<TextPricedModel> {
      const models = await client.listModels();
      const model = models.find((m): m is TextPricedModel => m.pricing.kind === 'token');
      if (!model) {
        throw new Error('Expected at least one token-priced model in the mock catalog');
      }
      return model;
    }

    async function findFinishEvent(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent> {
      let finish: InferenceEvent | undefined;
      for await (const event of stream) {
        if (event.kind === 'finish') finish = event;
      }
      if (finish === undefined) throw new Error('Stream produced no finish event');
      return finish;
    }

    /** Drive a real text stream to completion and return its `finish` accounting. */
    async function streamAndCaptureFinish(
      modelId: string
    ): Promise<{ generationId: string; inputTokens: number; outputTokens: number }> {
      const stream = client.stream({
        modality: 'text',
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const finish = await findFinishEvent(stream);
      if (finish.kind !== 'finish') throw new Error('Expected finish event');
      const meta = finish.providerMetadata;
      if (!meta?.generationId) throw new Error('Stream produced no generationId');
      return {
        generationId: meta.generationId,
        inputTokens: meta.usage?.inputTokens ?? 0,
        outputTokens: meta.usage?.outputTokens ?? 0,
      };
    }

    it('throws loudly for a generationId this mock never minted', async () => {
      await expect(client.getGenerationStats('forged-id-123')).rejects.toThrow(
        /Unknown mock generationId/
      );
    });

    it('returns per-model cost computed from catalog pricing and recorded tokens', async () => {
      const textModel = await firstTextModel();
      const { generationId, inputTokens, outputTokens } = await streamAndCaptureFinish(
        textModel.id
      );

      const stats = await client.getGenerationStats(generationId);
      const expected =
        inputTokens * textModel.pricing.inputPerToken +
        outputTokens * textModel.pricing.outputPerToken;
      expect(stats.costUsd).toBeCloseTo(expected, 12);
    });

    it('throws when the recorded model has non-positive per-token pricing', async () => {
      const textModel = await firstTextModel();
      const { generationId } = await streamAndCaptureFinish(textModel.id);

      // Poison the catalog lookup so the model resolves to zero prices. Silent
      // $0 cost is exactly the failure mode the guard exists to prevent.
      const zeroPricedModel = {
        ...textModel,
        pricing: { kind: 'token' as const, inputPerToken: 0, outputPerToken: 0 },
      };
      vi.spyOn(client, 'getModel').mockResolvedValueOnce(zeroPricedModel);

      await expect(client.getGenerationStats(generationId)).rejects.toThrow(
        /no usable per-token pricing/
      );
    });

    it('throws when the recorded model resolves to a non-token pricing kind', async () => {
      const textModel = await firstTextModel();
      const { generationId } = await streamAndCaptureFinish(textModel.id);

      const imagePricedModel = {
        ...textModel,
        pricing: { kind: 'image' as const, perImage: 0.04 },
      };
      vi.spyOn(client, 'getModel').mockResolvedValueOnce(imagePricedModel);

      await expect(client.getGenerationStats(generationId)).rejects.toThrow(
        /non-token pricing kind/
      );
    });
  });

  describe('stream exhaustiveness guard', () => {
    it('throws when given an unrecognized modality (assertNever)', () => {
      const badRequest = {
        modality: 'rogue',
        model: 'rogue/model',
        prompt: 'unused',
      } as unknown as TextRequest;

      expect(() => client.stream(badRequest)).toThrow(/exhaustiveness/i);
    });
  });
});

/**
 * E2E catalog source. When `useFixtureCatalog` is set (E2E mode wires this from
 * `getAIClient`), the mock must serve the pinned `E2E_MODEL_CATALOG` and never
 * touch the network — the live `/v1/models` endpoint is the only non-hermetic
 * dependency E2E would otherwise hit.
 */
describe('createMockAIClient with useFixtureCatalog', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearModelCache();
    // A fetch that fails loudly: if the fixture path ever falls through to the
    // network the test catches it, instead of silently hitting live /v1/models.
    fetchSpy = vi.fn(() => Promise.reject(new Error('fetch must not be called on the E2E path')));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listRawModels returns the pinned fixture catalog without calling fetch', async () => {
    const client = createMockAIClient({}, { useFixtureCatalog: true });
    const raw = await client.listRawModels();
    expect(raw).toEqual(E2E_MODEL_CATALOG);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('listModels maps the fixture catalog without calling fetch', async () => {
    const client = createMockAIClient({}, { useFixtureCatalog: true });
    const models = await client.listModels();
    const fixtureIds = E2E_MODEL_CATALOG.map((m) => m.id).toSorted((a, b) => a.localeCompare(b));
    const modelIds = models.map((m) => m.id).toSorted((a, b) => a.localeCompare(b));
    expect(modelIds).toEqual(fixtureIds);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a defensive copy — mutating the result does not affect the fixture', async () => {
    const client = createMockAIClient({}, { useFixtureCatalog: true });
    const first = await client.listRawModels();
    first.length = 0;
    const second = await client.listRawModels();
    expect(second).toEqual(E2E_MODEL_CATALOG);
  });
});
