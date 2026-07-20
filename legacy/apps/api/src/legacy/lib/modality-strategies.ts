/**
 * Modality strategies — per-modality wiring for the streaming pipeline.
 *
 * Each strategy describes how a modality builds its inference request, prices
 * its outputs, and reports SSE error messages. The text and media pipelines
 * share an orchestrator skeleton in `stream-pipeline.ts` and pull modality-
 * specific behavior from these strategies, eliminating the parallel
 * `executeImage/Video/AudioPipeline` branches that diverged only in three
 * fields each.
 *
 * The interface is generic over the AI request type so callers preserve full
 * type narrowing on `strategy.buildRequest(...)`. Media strategies reuse the
 * existing `MediaStreamResult` and `MediaPersistPricing` shapes consumed by
 * the orchestrator. Text has its own pipeline in `stream-pipeline.ts` because
 * it carries Smart Model classification, multi-stage pre-inference, and token
 * broadcasting that have no analogue in image/video/audio.
 */

import { assertNever } from '@hushbox/shared';
import type { ImageAspectRatio, VideoAspectRatio } from '@hushbox/shared/models';

import type {
  AudioRequest,
  ImageRequest,
  InferenceRequest,
  TextRequest,
  VideoRequest,
} from '../services/ai/index.js';
import type { Modality } from '../services/ai/index.js';
import type { MediaStreamResult } from './multi-stream.js';
import type {
  AudioBillingValidationSuccess,
  ImageBillingValidationSuccess,
  MediaPersistPricing,
  VideoBillingValidationSuccess,
} from './billing-types.js';

/**
 * Strategy descriptor used by the media pipeline orchestrator. Text has its
 * own descriptor below — the two diverge enough (Smart Model, batched
 * broadcast, multi-stage pre-inference) that a single contract obscured more
 * than it shared.
 *
 * `buildRequest` takes the per-call dynamic fields (prompt and any
 * caller-driven knobs like `aspectRatio` or `format`) alongside the resolved
 * billing context, and returns a complete inference request — no spread-and-
 * override at the call site. The shape of `TBuildExtras` is per-modality so
 * the type system enforces what each modality needs.
 */
export interface MediaModalityStrategy<
  TRequest extends InferenceRequest,
  TBilling extends
    | ImageBillingValidationSuccess
    | VideoBillingValidationSuccess
    | AudioBillingValidationSuccess,
  TBuildExtras,
> {
  modality: Extract<Modality, 'image' | 'video' | 'audio'>;
  /** Inference request payload for a single model in the batch. */
  buildRequest: (input: { modelId: string; billing: TBilling; extras: TBuildExtras }) => TRequest;
  /** Per-model + per-result pricing factory passed to `processMediaResults`. */
  pricingFor: (
    modelId: string,
    result: MediaStreamResult,
    billing: TBilling
  ) => MediaPersistPricing;
  /** Message written to SSE when every model in the batch fails. */
  noContentErrorMessage: string;
}

/**
 * Text strategy descriptor. Lives alongside the media descriptors so callers
 * have a single discovery point for "everything keyed on Modality" without
 * pretending the text pipeline shares a runtime path with media. Today this
 * carries only the request builder; future expansions (e.g. lifting Smart
 * Model classification into the strategy) can extend this shape.
 */
export interface TextModalityStrategy {
  modality: Extract<Modality, 'text'>;
  buildRequest: (input: BuildTextRequestInput) => TextRequest;
}

export interface BuildTextRequestInput {
  modelId: string;
  messages: TextRequest['messages'];
  /** Optional — omitted when the caller never enables web search (e.g., trial). */
  webSearchEnabled?: boolean;
  maxOutputTokens?: number;
}

export interface ImageBuildExtras {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
}

export interface VideoBuildExtras {
  prompt: string;
  aspectRatio: VideoAspectRatio;
}

export interface AudioBuildExtras {
  prompt: string;
  format: 'mp3' | 'wav' | 'ogg';
  voice?: string;
}

export const textStrategy: TextModalityStrategy = {
  modality: 'text',
  buildRequest: ({ modelId, messages, webSearchEnabled, maxOutputTokens }): TextRequest => ({
    modality: 'text',
    model: modelId,
    messages,
    ...(webSearchEnabled !== undefined && { webSearchEnabled }),
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
  }),
};

export const imageStrategy: MediaModalityStrategy<
  ImageRequest,
  ImageBillingValidationSuccess,
  ImageBuildExtras
> = {
  modality: 'image',
  buildRequest: ({ modelId, extras }): ImageRequest => ({
    modality: 'image',
    model: modelId,
    prompt: extras.prompt,
    ...(extras.aspectRatio !== undefined && { aspectRatio: extras.aspectRatio }),
  }),
  pricingFor: (modelId, _result, billing): MediaPersistPricing => {
    const perImage = billing.perImageByModel.get(modelId);
    if (perImage === undefined) {
      throw new Error(`invariant: perImageByModel missing entry for ${modelId}`);
    }
    return { kind: 'image', perImage };
  },
  noContentErrorMessage: 'No image generated',
};

export const videoStrategy: MediaModalityStrategy<
  VideoRequest,
  VideoBillingValidationSuccess,
  VideoBuildExtras
> = {
  modality: 'video',
  buildRequest: ({ modelId, billing, extras }): VideoRequest => ({
    modality: 'video',
    model: modelId,
    prompt: extras.prompt,
    durationSeconds: billing.durationSeconds,
    resolution: billing.resolution,
    aspectRatio: extras.aspectRatio,
  }),
  pricingFor: (modelId, _result, billing): MediaPersistPricing => {
    const perSecond = billing.perSecondByModel.get(modelId);
    if (perSecond === undefined) {
      throw new Error(`invariant: perSecondByModel missing entry for ${modelId}`);
    }
    return {
      kind: 'video',
      perSecond,
      durationSeconds: billing.durationSeconds,
      resolution: billing.resolution,
    };
  },
  noContentErrorMessage: 'No video generated',
};

export const audioStrategy: MediaModalityStrategy<
  AudioRequest,
  AudioBillingValidationSuccess,
  AudioBuildExtras
> = {
  modality: 'audio',
  buildRequest: ({ modelId, extras }): AudioRequest => ({
    modality: 'audio',
    model: modelId,
    prompt: extras.prompt,
    format: extras.format,
    ...(extras.voice !== undefined && { voice: extras.voice }),
  }),
  pricingFor: (modelId, result, billing): MediaPersistPricing => {
    const perSecond = billing.perSecondByModel.get(modelId);
    if (perSecond === undefined) {
      throw new Error(`invariant: perSecondByModel missing entry for ${modelId}`);
    }
    // TTS duration is determined by the synthesis, not the request — read
    // from the actual stream result. Fall back to 0 if absent (which yields
    // storage-only cost; the model cost component is 0 when duration is 0).
    const durationSeconds = (result.durationMs ?? 0) / 1000;
    return { kind: 'audio', perSecond, durationSeconds };
  },
  noContentErrorMessage: 'No audio generated',
};

/**
 * Type-narrowing return for {@link getStrategy}. Function overloads above the
 * implementation give every modality a tightly-typed strategy at the call
 * site so callers don't lose generic information when dispatching by modality.
 */
export type StrategyByModality<M extends Modality> = M extends 'text'
  ? typeof textStrategy
  : M extends 'image'
    ? typeof imageStrategy
    : M extends 'video'
      ? typeof videoStrategy
      : M extends 'audio'
        ? typeof audioStrategy
        : never;

export function getStrategy(modality: 'text'): typeof textStrategy;
export function getStrategy(modality: 'image'): typeof imageStrategy;
export function getStrategy(modality: 'video'): typeof videoStrategy;
export function getStrategy(modality: 'audio'): typeof audioStrategy;
export function getStrategy<M extends Modality>(modality: M): StrategyByModality<M>;
export function getStrategy(
  modality: Modality
): typeof textStrategy | typeof imageStrategy | typeof videoStrategy | typeof audioStrategy {
  switch (modality) {
    case 'text': {
      return textStrategy;
    }
    case 'image': {
      return imageStrategy;
    }
    case 'video': {
      return videoStrategy;
    }
    case 'audio': {
      return audioStrategy;
    }
    default: {
      return assertNever(modality);
    }
  }
}
