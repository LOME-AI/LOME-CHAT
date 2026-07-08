import { describe, expect, it } from 'vitest';
import {
  extractMediaCostUsd,
  extractMediaGenerationId,
  mediaFinishEvent,
  mediaOutputEvents,
  mediaPromptFromInputs,
  validateMediaCall,
} from './media-generate.js';
import type { InferenceRequest, MediaValue, ModelDescriptor } from '@hushbox/shared';

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

function testRequest(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    model: 'google/imagen-4.0-generate-001',
    inputs: [{ modality: 'text', text: 'A red fox' }],
    parameters: {},
    outputs: ['image'],
    ...overrides,
  };
}

describe('extractMediaGenerationId', () => {
  it('returns the openrouter generation id (video)', () => {
    expect(extractMediaGenerationId({ openrouter: { generationId: 'gen_1' } })).toBe('gen_1');
  });

  it('returns undefined when metadata is undefined (image has none)', () => {
    expect(extractMediaGenerationId()).toBeUndefined();
  });

  it('returns undefined when metadata is null', () => {
    expect(extractMediaGenerationId(null)).toBeUndefined();
  });

  it('returns undefined when the openrouter generation id is null (best-effort)', () => {
    expect(extractMediaGenerationId({ openrouter: { generationId: null } })).toBeUndefined();
  });

  it('returns undefined when the openrouter namespace is absent', () => {
    expect(extractMediaGenerationId({ google: {} })).toBeUndefined();
  });

  it('returns undefined for non-object metadata', () => {
    expect(extractMediaGenerationId('unparseable')).toBeUndefined();
  });
});

describe('extractMediaCostUsd', () => {
  it('returns the authoritative inline openrouter cost (video)', () => {
    expect(extractMediaCostUsd({ openrouter: { generationId: 'g', cost: 0.42 } })).toBe(0.42);
  });

  it('returns undefined when metadata is undefined (image emits no cost)', () => {
    expect(extractMediaCostUsd()).toBeUndefined();
  });

  it('returns undefined when the openrouter cost is null', () => {
    expect(extractMediaCostUsd({ openrouter: { generationId: 'g', cost: null } })).toBeUndefined();
  });

  it('returns undefined when the openrouter namespace is absent', () => {
    expect(extractMediaCostUsd({ google: {} })).toBeUndefined();
  });
});

describe('validateMediaCall', () => {
  it('accepts a matching ZDR-reachable descriptor', () => {
    expect(() => {
      validateMediaCall(testRequest(), testDescriptor());
    }).not.toThrow();
  });

  it('rejects a request whose model differs from the descriptor', () => {
    expect(() => {
      validateMediaCall(testRequest({ model: 'google/other' }), testDescriptor());
    }).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });

  it('refuses a ZDR-unreachable descriptor fail-closed', () => {
    expect(() => {
      validateMediaCall(testRequest(), testDescriptor({ zdrReachable: false }));
    }).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});

describe('mediaPromptFromInputs', () => {
  it('joins text parts into one prompt', () => {
    const prompt = mediaPromptFromInputs([
      { modality: 'text', text: 'A red fox' },
      { modality: 'text', text: 'in watercolor' },
    ]);

    expect(prompt).toBe('A red fox\nin watercolor');
  });

  it('rejects a media reference input part', () => {
    expect(() =>
      mediaPromptFromInputs([
        { modality: 'image', ref: { ref: 'inputs/x/y', mimeType: 'image/png', byteLength: 3 } },
      ])
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });

  it('rejects an empty input list', () => {
    expect(() => mediaPromptFromInputs([])).toThrow(
      expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' })
    );
  });
});

describe('mediaOutputEvents', () => {
  const mediaValue: MediaValue = {
    ref: 'media/conv/msg/uuid-1',
    mimeType: 'image/png',
    modality: 'image',
    byteLength: 3,
    metadata: {},
  };

  it('maps each generated file through the mapper with sequential indices', () => {
    const files = [
      { mediaType: 'image/png', uint8Array: new Uint8Array([1]) },
      { mediaType: 'image/png', uint8Array: new Uint8Array([2]) },
    ];

    const events = mediaOutputEvents(files, (part, index) => [
      { kind: 'media-start', index, modality: 'image', mimeType: part.mediaType },
      { kind: 'media-done', index, value: mediaValue },
    ]);

    expect(events).toEqual([
      { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
      { kind: 'media-done', index: 0, value: mediaValue },
      { kind: 'media-start', index: 1, modality: 'image', mimeType: 'image/png' },
      { kind: 'media-done', index: 1, value: mediaValue },
    ]);
  });

  it('throws a defect when no mapper contract was supplied', () => {
    expect(() =>
      mediaOutputEvents([{ mediaType: 'image/png', uint8Array: new Uint8Array([1]) }])
    ).toThrow(expect.objectContaining({ name: 'AdapterDefect' }));
  });
});

describe('mediaFinishEvent', () => {
  it('carries the video generation id, inline cost, usage, and a stop finish reason', () => {
    const event = mediaFinishEvent(
      { openrouter: { generationId: 'gen_done', cost: 0.5 } },
      { inputTokens: 0, outputTokens: 0 },
      0.5
    );

    expect(event).toEqual({
      kind: 'finish',
      metadata: {
        generationId: 'gen_done',
        providerCostUsd: 0.5,
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'stop',
      },
    });
  });

  it('emits no generation id and no cost for an image finish (no metadata)', () => {
    const event = mediaFinishEvent(undefined, { inputTokens: 13, outputTokens: 1568 });

    expect(event).toEqual({
      kind: 'finish',
      metadata: {
        usage: { inputTokens: 13, outputTokens: 1568 },
        finishReason: 'stop',
      },
    });
  });
});
