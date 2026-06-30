/**
 * Per-modality typed view of a model — the rich shape consumed by code that
 * already knows the modality it cares about (test pickers, per-modality route
 * capability gates, billing math). Unifies three previously scattered concerns:
 *
 *   1. AIClient flat `ModelInfo` view (pricing as tagged union — keep for
 *      modality-agnostic UI listings; ModelView is the modality-typed sibling).
 *   2. Provider input parameter axes (`supportedAspectRatios`,
 *      `supportedResolutions`, `supportedDurationsSeconds`, `imagenSampleSize`)
 *      from `packages/shared/src/models/capabilities.ts`.
 *   3. Feature capabilities (`vision`, `python-execution`, `javascript-execution`)
 *      from `packages/shared/src/capabilities/`, exposed as `features`.
 *
 * Capability axes (supported{AspectRatios,Resolutions,DurationsSeconds},
 * imagenSampleSize) are optional: present when our capability tables pin the
 * model, omitted otherwise. Omission means "we haven't verified — the gateway
 * is the gate." Consumers that require capability data (e.g., the test
 * picker) filter to entries that carry it.
 *
 * Fee contract: every price field on a `ModelView` (`inputPerToken`,
 * `outputPerToken`, `perImage`, `perSecondByResolution[*]`, `perSecond`) is
 * FEE-INCLUSIVE — passes through unchanged from `Model.pricePer*`, which is
 * fee-inclusive per the `processModels` contract.
 */

import {
  assertNever,
  getModelFeatures,
  IMAGE_ASPECT_RATIOS,
  type ModelFeatureId,
  type Model,
} from '@hushbox/shared';
import {
  getImagenSampleSize,
  getSupportedVideoAspectRatios,
  getSupportedVideoDurations,
  getSupportedVideoResolutions,
  processModels,
  type ImageAspectRatio,
  type ImagenSampleSize,
  type RawModel,
  type VideoAspectRatio,
  type VideoResolution,
} from '@hushbox/shared/models';
import type { Modality } from './types.js';

interface BaseModelView {
  id: string;
  name: string;
  provider: string;
  description: string;
  isPremium: boolean;
  /**
   * Feature capabilities derived from `supportedParameters` (e.g., 'vision',
   * 'python-execution'). Distinct from the supported{AspectRatios,...} input
   * axes — features describe what the model can DO; supported{...} describe
   * what input values it ACCEPTS.
   */
  features: readonly ModelFeatureId[];
  created?: number;
}

export interface TextModelView extends BaseModelView {
  modality: 'text';
  contextLength: number;
  inputPerToken: number;
  outputPerToken: number;
}

export interface ImageModelView extends BaseModelView {
  modality: 'image';
  perImage: number;
  supportedAspectRatios?: readonly ImageAspectRatio[];
  imagenSampleSize?: ImagenSampleSize;
}

export interface VideoModelView extends BaseModelView {
  modality: 'video';
  perSecondByResolution: Readonly<Record<string, number>>;
  supportedAspectRatios?: readonly VideoAspectRatio[];
  supportedResolutions?: readonly VideoResolution[];
  supportedDurationsSeconds?: readonly number[];
}

export interface AudioModelView extends BaseModelView {
  modality: 'audio';
  perSecond: number;
}

export type ModelView = TextModelView | ImageModelView | VideoModelView | AudioModelView;

export type ModelViewFor<M extends Modality> = M extends 'text'
  ? TextModelView
  : M extends 'image'
    ? ImageModelView
    : M extends 'video'
      ? VideoModelView
      : M extends 'audio'
        ? AudioModelView
        : never;

function buildTextView(model: Model, base: Omit<BaseModelView, 'modality'>): TextModelView {
  return {
    ...base,
    modality: 'text',
    contextLength: model.contextLength,
    inputPerToken: model.pricePerInputToken,
    outputPerToken: model.pricePerOutputToken,
  };
}

function buildImageView(model: Model, base: Omit<BaseModelView, 'modality'>): ImageModelView {
  const imagenSampleSize = getImagenSampleSize(model.id);
  // Imagen-4 family is the only image provider with verified aspect-ratio
  // support today; deriving the set from `getImagenSampleSize` keeps a single
  // SoT for "this is an Imagen-4 variant."
  const imagenAxes =
    imagenSampleSize === undefined
      ? {}
      : { supportedAspectRatios: [...IMAGE_ASPECT_RATIOS] as const, imagenSampleSize };
  return {
    ...base,
    modality: 'image',
    perImage: model.pricePerImage,
    ...imagenAxes,
  };
}

function buildVideoView(model: Model, base: Omit<BaseModelView, 'modality'>): VideoModelView {
  const supportedAspectRatios = getSupportedVideoAspectRatios(model.id);
  const supportedResolutions = getSupportedVideoResolutions(model.id);
  const supportedDurationsSeconds = getSupportedVideoDurations(model.id);
  return {
    ...base,
    modality: 'video',
    perSecondByResolution: model.pricePerSecondByResolution,
    ...(supportedAspectRatios !== undefined && { supportedAspectRatios }),
    ...(supportedResolutions !== undefined && { supportedResolutions }),
    ...(supportedDurationsSeconds !== undefined && { supportedDurationsSeconds }),
  };
}

function buildAudioView(model: Model, base: Omit<BaseModelView, 'modality'>): AudioModelView {
  return {
    ...base,
    modality: 'audio',
    perSecond: model.pricePerSecond,
  };
}

/**
 * Build the per-modality typed views from a raw gateway catalog. Single
 * funnel through `processModels` so ZDR filtering, price-floor, age, and
 * premium detection happen once and the views inherit the same rules as
 * everything else served from the catalog. The synthetic Smart Model entry
 * is excluded — it's a virtual router, not a real model anyone would
 * stream against.
 */
export function buildModelViewsForModality<M extends Modality>(
  rawModels: readonly RawModel[],
  modality: M
): readonly ModelViewFor<M>[] {
  const processed = processModels([...rawModels]);
  const premiumSet = new Set(processed.premiumIds);
  // The filter narrows to one modality at runtime, but the type system can't
  // see through `.filter`. The double cast (`as unknown as ...`) is the
  // canonical TS workaround for value-level narrowing with a generic key.
  const views = processed.models
    .filter((m) => m.modality === modality && m.isSmartModel !== true)
    .map((m) => toModelView(m, premiumSet.has(m.id)));
  return views as unknown as readonly ModelViewFor<M>[];
}

/**
 * Build a `ModelView` from a processed `Model` (output of `processModels`)
 * and its premium status. The result is the canonical rich-typed view used
 * across the API service for capability-aware code.
 */
export function toModelView(model: Model, isPremium: boolean): ModelView {
  const base: Omit<BaseModelView, 'modality'> = {
    id: model.id,
    name: model.name,
    provider: model.provider,
    description: model.description,
    isPremium,
    features: getModelFeatures(model),
    ...(model.created !== undefined && { created: model.created }),
  };
  switch (model.modality) {
    case 'text': {
      return buildTextView(model, base);
    }
    case 'image': {
      return buildImageView(model, base);
    }
    case 'video': {
      return buildVideoView(model, base);
    }
    case 'audio': {
      return buildAudioView(model, base);
    }
    default: {
      return assertNever(model.modality);
    }
  }
}
