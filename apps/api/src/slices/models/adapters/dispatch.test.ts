import { describe, expect, it } from 'vitest';
import { callShapeFamilyFor } from '@hushbox/shared';
import { callShapeFor, createDispatchingProvider, createModelProvider } from './dispatch.js';
import type { ModelProvider } from '../ports/index.js';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  Modality,
  ModelDescriptor,
} from '@hushbox/shared';

function descriptorWithOutputs(id: string, outputs: Modality[]): ModelDescriptor {
  return {
    id,
    provider: id.split('/')[0] ?? 'unknown',
    version: '1',
    inputs: ['text'],
    outputs,
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

function requestFor(model: string, outputs: Modality[]): InferenceRequest {
  return {
    model,
    inputs: [{ modality: 'text', text: 'Hello' }],
    parameters: {},
    outputs,
  };
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
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

describe('callShapeFor', () => {
  it('routes a text-output model to the language shape', () => {
    expect(callShapeFor(descriptorWithOutputs('openai/gpt-4o', ['text']))).toBe('language');
  });

  it('routes a multi-output text+image model to the language shape', () => {
    expect(callShapeFor(descriptorWithOutputs('google/gemini-image', ['text', 'image']))).toBe(
      'language'
    );
  });

  it('routes an image-only model to the image shape', () => {
    expect(callShapeFor(descriptorWithOutputs('google/imagen-4.0-generate-001', ['image']))).toBe(
      'image'
    );
  });

  it('routes a video-only model to the video shape', () => {
    expect(callShapeFor(descriptorWithOutputs('google/veo-3.1-generate-001', ['video']))).toBe(
      'video'
    );
  });

  it('rejects an audio-output model with the typed unsupported-modality error', () => {
    expect(() => callShapeFor(descriptorWithOutputs('openai/tts', ['audio']))).toThrow(
      expect.objectContaining({ name: 'InferenceError', code: 'unsupported_modality' })
    );
  });

  it('rejects an embedding-output model (deferred, no consumer)', () => {
    expect(() =>
      callShapeFor(descriptorWithOutputs('openai/text-embedding-3-small', ['embedding']))
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'unsupported_modality' }));
  });
});

describe('createDispatchingProvider', () => {
  it('dispatches to a newly registered output-family adapter with no other changes', async () => {
    // The extensibility acceptance: a genuinely new modality is one enum
    // migration (simulated here by extending the classifier for audio
    // outputs) plus one registered adapter — dispatch itself needs no diff.
    const spoken: InferenceEvent = { kind: 'text-delta', index: 0, content: 'spoken' };
    const speechAdapter: ModelProvider = {
      async *infer(): AsyncIterable<InferenceEvent> {
        yield await Promise.resolve(spoken);
      },
    };
    const provider = createDispatchingProvider({
      classify: (outputs) => (outputs.includes('audio') ? 'speech' : callShapeFamilyFor(outputs)),
      adapters: new Map([['speech', speechAdapter]]),
    });

    const events = await collect(
      provider.infer(
        requestFor('openai/tts', ['audio']),
        descriptorWithOutputs('openai/tts', ['audio'])
      )
    );

    expect(events).toEqual([spoken]);
  });

  it('refuses an audio inference request with the typed unsupported-modality error', () => {
    const provider = createModelProvider({ apiKey: 'test-key' });

    expect(() =>
      provider.infer(
        requestFor('openai/tts', ['audio']),
        descriptorWithOutputs('openai/tts', ['audio'])
      )
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'unsupported_modality' }));
  });

  it('refuses a classified family that has no registered adapter', () => {
    const provider = createDispatchingProvider({
      classify: callShapeFamilyFor,
      adapters: new Map(),
    });

    expect(() =>
      provider.infer(
        requestFor('openai/gpt-4o', ['text']),
        descriptorWithOutputs('openai/gpt-4o', ['text'])
      )
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'unsupported_modality' }));
  });
});

function jsonResponse(body: unknown): Response {
  return Response.json(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('createModelProvider', () => {
  it('routes an image descriptor through the image call-shape', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const mediaValue: MediaValue = {
      ref: 'media/conv/msg/uuid-3',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: pngBytes.byteLength,
      metadata: {},
    };
    const mapFilePart: FilePartMapper = (part, index) => [
      { kind: 'media-start', index, modality: 'image', mimeType: part.mediaType },
      { kind: 'media-done', index, value: mediaValue },
    ];
    const provider = createModelProvider({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () => jsonResponse({ data: [{ b64_json: Buffer.from(pngBytes).toString('base64') }] }),
      ]),
    });

    const events = await collect(
      provider.infer(
        requestFor('google/imagen-4.0-generate-001', ['image']),
        descriptorWithOutputs('google/imagen-4.0-generate-001', ['image']),
        { mapFilePart }
      )
    );

    // Image emits no generation id and no inline cost.
    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'stop',
      },
    });
  });

  it('routes a video descriptor through the video call-shape', async () => {
    const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18]);
    const mediaValue: MediaValue = {
      ref: 'media/conv/msg/uuid-4',
      mimeType: 'video/mp4',
      modality: 'video',
      byteLength: mp4Bytes.byteLength,
      metadata: {},
    };
    const mapFilePart: FilePartMapper = (part, index) => [
      { kind: 'media-start', index, modality: 'video', mimeType: part.mediaType },
      { kind: 'media-done', index, value: mediaValue },
    ];
    const downloadUrl = 'https://openrouter.ai/api/v1/videos/vid-d/download.mp4';
    const provider = createModelProvider({
      apiKey: 'test-key',
      pollIntervalMs: 1,
      fetch: scriptedFetch([
        () =>
          jsonResponse({
            id: 'vid-d',
            polling_url: 'https://openrouter.ai/api/v1/videos/vid-d',
            status: 'pending',
          }),
        () =>
          jsonResponse({
            id: 'vid-d',
            polling_url: 'https://openrouter.ai/api/v1/videos/vid-d',
            status: 'completed',
            generation_id: 'gen_dispatch_vid',
            unsigned_urls: [downloadUrl],
            usage: { cost: 0.7 },
          }),
        () => new Response(mp4Bytes, { status: 200, headers: { 'content-type': 'video/mp4' } }),
      ]),
    });

    const events = await collect(
      provider.infer(
        requestFor('google/veo-3.1-generate-001', ['video']),
        descriptorWithOutputs('google/veo-3.1-generate-001', ['video']),
        { mapFilePart }
      )
    );

    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        generationId: 'gen_dispatch_vid',
        providerCostUsd: 0.7,
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'stop',
      },
    });
  });

  it('routes a text descriptor through the language call-shape', async () => {
    const chunks = [
      {
        id: 'gen_dispatch_text',
        provider: 'openai',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' } }],
      },
      {
        id: 'gen_dispatch_text',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
      },
    ];
    const provider = createModelProvider({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
              'data: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } }
          ),
      ]),
    });

    const events = await collect(
      provider.infer(
        requestFor('openai/gpt-4o', ['text']),
        descriptorWithOutputs('openai/gpt-4o', ['text'])
      )
    );

    expect(events).toContainEqual({ kind: 'text-delta', index: 0, content: 'Hi' });
    expect(events.at(-1)?.kind).toBe('finish');
  });
});
