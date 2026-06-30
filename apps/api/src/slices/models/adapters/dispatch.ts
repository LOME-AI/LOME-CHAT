import { callShapeFamilyFor } from '@hushbox/shared';
import { invalidRequestError } from './inference-error.js';
import { createImageAdapter } from './image-adapter.js';
import { createLanguageAdapter } from './language-adapter.js';
import { createVideoAdapter } from './video-adapter.js';
import type { InferenceEvent, InferenceRequest, ModelDescriptor } from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../ports/index.js';

/**
 * Call-shape dispatch for the ModelProvider port: one adapter per SDK
 * call-shape family, keyed on the descriptor's output family. Audio has no
 * gateway call-shape yet and embeddings are deferred (no consumer) — both
 * are refused, never crashed on (unknown gateway types are excluded with an
 * alert by the catalog).
 */
export const CALL_SHAPES = ['language', 'image', 'video'] as const;
export type CallShape = (typeof CALL_SHAPES)[number];

export function callShapeFor(descriptor: ModelDescriptor): CallShape {
  // Routing delegates to the canonical shared derivation: the domain
  // exposure gate classifies with the same function, so a descriptor can
  // never be media-routed here while riding the language path past the
  // dated-ZDR media gate.
  const family = callShapeFamilyFor(descriptor.outputs);
  if (family === undefined || family === 'embedding') {
    throw invalidRequestError(
      `No call-shape adapter for model outputs (${descriptor.outputs.join(', ')})`
    );
  }
  return family;
}

export interface CreateModelProviderOptions {
  readonly apiKey: string;
  /** The cassette/fixture seam, threaded into every family adapter. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createModelProvider(options: CreateModelProviderOptions): ModelProvider {
  const adapters: Readonly<Record<CallShape, ModelProvider>> = {
    language: createLanguageAdapter(options),
    image: createImageAdapter(options),
    video: createVideoAdapter(options),
  };

  return {
    infer(
      request: InferenceRequest,
      descriptor: ModelDescriptor,
      inferOptions: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      return adapters[callShapeFor(descriptor)].infer(request, descriptor, inferOptions);
    },
  };
}
