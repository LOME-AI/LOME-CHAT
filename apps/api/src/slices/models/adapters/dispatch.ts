import { callShapeFamilyFor } from '@hushbox/shared';
import { unsupportedModalityError } from './inference-error.js';
import { createImageAdapter } from './image-adapter.js';
import { createLanguageAdapter } from './language-adapter.js';
import { createVideoAdapter } from './video-adapter.js';
import type { InferenceEvent, InferenceRequest, Modality, ModelDescriptor } from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../ports/index.js';

/**
 * Call-shape dispatch for the ModelProvider port: one adapter per SDK
 * call-shape family, keyed on the descriptor's output family. Audio has no
 * gateway call-shape yet and embeddings are deferred (no consumer) — both
 * are refused with the typed unsupported-modality error, never crashed on
 * (unknown gateway types are excluded with an alert by the catalog).
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
    throw unsupportedModalityError(descriptor.outputs);
  }
  return family;
}

/**
 * The dispatch registry seam. Adding a modality is one classifier extension
 * (the enum migration's family derivation) plus one registered adapter —
 * dispatch itself never changes. A descriptor whose outputs classify to no
 * family, or to a family with no registered adapter, is refused with the
 * typed unsupported-modality error.
 */
export interface DispatchTable {
  readonly classify: (outputs: readonly Modality[]) => string | undefined;
  readonly adapters: ReadonlyMap<string, ModelProvider>;
}

export function createDispatchingProvider(table: DispatchTable): ModelProvider {
  return {
    infer(
      request: InferenceRequest,
      descriptor: ModelDescriptor,
      inferOptions: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      const family = table.classify(descriptor.outputs);
      const adapter = family === undefined ? undefined : table.adapters.get(family);
      if (adapter === undefined) throw unsupportedModalityError(descriptor.outputs);
      return adapter.infer(request, descriptor, inferOptions);
    },
  };
}

export interface CreateModelProviderOptions {
  readonly apiKey: string;
  /** The cassette/fixture seam, threaded into every family adapter. */
  readonly fetch?: typeof globalThis.fetch;
  /** Video poll cadence, threaded to the video adapter (tests use a small value). */
  readonly pollIntervalMs?: number;
}

export function createModelProvider(options: CreateModelProviderOptions): ModelProvider {
  return createDispatchingProvider({
    classify: callShapeFamilyFor,
    adapters: new Map<string, ModelProvider>([
      ['language', createLanguageAdapter(options)],
      ['image', createImageAdapter(options)],
      ['video', createVideoAdapter(options)],
    ]),
  });
}
