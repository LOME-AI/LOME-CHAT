/**
 * Provider-side capability data for AI Gateway models — the axes each model
 * accepts that the public `/v1/models` catalog doesn't expose (or exposes
 * inconsistently). Single source of truth for both production code (request
 * shaping in `apps/api/services/ai/real.ts`, route-level validation) and
 * integration tests (capability-driven model picker).
 *
 * Adding a new ZDR-allowlisted media model requires two edits:
 *   1. Add its id to the matching `ZDR_*_MODEL_IDS` in `./zdr.ts`.
 *   2. Add its capability entry below.
 * The `satisfies Record<ZdrVideoModelId, VideoCapability>` clause on
 * `VEO_CAPABILITY` fails the build when step 1 happens without step 2.
 */

import type { VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, IMAGE_ASPECT_RATIOS } from '../constants.js';
import type { ZdrVideoModelId } from './zdr.js';

// ---------------------------------------------------------------------------
// Strong types — derived from the existing `as const` arrays in constants.ts
// so '4K' / '21:9' / '1080P' fail at compile time anywhere downstream.
// ---------------------------------------------------------------------------

export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

// ---------------------------------------------------------------------------
// Video capability
// ---------------------------------------------------------------------------

export interface VideoCapability {
  readonly aspectRatios: readonly VideoAspectRatio[];
  readonly resolutions: readonly VideoResolution[];
  readonly durationsSeconds: readonly number[];
}

/**
 * Per-Veo-version capability. All Veo 3.x models accept `[4, 6, 8]s`; Veo 3.0
 * is capped at 720p/1080p, Veo 3.1 also accepts 4K. Veo 3.1 reference-image
 * variants are 8s-only but that mode isn't surfaced today.
 *
 * Vertex realigned Veo 3.0 / 3.0 Fast onto the `[4, 6, 8]` set the 3.1 family
 * uses; the old `[5, 6, 7, 8]` advertisement now triggers `Unsupported output
 * video duration` from the gateway.
 */
export const VEO_CAPABILITY = {
  'google/veo-3.0-generate-001': {
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    durationsSeconds: [4, 6, 8],
  },
  'google/veo-3.0-fast-generate-001': {
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    durationsSeconds: [4, 6, 8],
  },
  'google/veo-3.1-generate-001': {
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4k'],
    durationsSeconds: [4, 6, 8],
  },
  'google/veo-3.1-fast-generate-001': {
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4k'],
    durationsSeconds: [4, 6, 8],
  },
} as const satisfies Record<ZdrVideoModelId, VideoCapability>;

// ---------------------------------------------------------------------------
// Image capability — per-model Imagen sample size
// ---------------------------------------------------------------------------

export type ImagenSampleSize = '1K' | '2K';

/**
 * Imagen 4 sample size — fast variant is 1K only; generate and ultra support
 * 2K. Not user-visible (flat pricing → no tradeoff), injected at request-build
 * time. Models absent from this map use the gateway default and receive no
 * `google.sampleImageSize` provider option.
 */
export const IMAGEN_SAMPLE_SIZE_BY_MODEL = {
  'google/imagen-4.0-fast-generate-001': '1K',
  'google/imagen-4.0-generate-001': '2K',
  'google/imagen-4.0-ultra-generate-001': '2K',
} as const satisfies Record<string, ImagenSampleSize>;

// ---------------------------------------------------------------------------
// ZDR / provider-routing options — sent on every inference call. The per-call-
// family shapes live in the sibling module; re-exported here as the models
// slice's capability surface.
// ---------------------------------------------------------------------------

export {
  languageRoutingOptions,
  mediaRoutingOptions,
  type OpenRouterProviderRouting,
  type LanguageRoutingOptions,
  type MediaRoutingOptions,
} from './routing-options.js';

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getVideoCapability(modelId: string): VideoCapability | undefined {
  return (VEO_CAPABILITY as Record<string, VideoCapability>)[modelId];
}

export function getSupportedVideoDurations(modelId: string): readonly number[] | undefined {
  return getVideoCapability(modelId)?.durationsSeconds;
}

export function getSupportedVideoResolutions(
  modelId: string
): readonly VideoResolution[] | undefined {
  return getVideoCapability(modelId)?.resolutions;
}

export function getSupportedVideoAspectRatios(
  modelId: string
): readonly VideoAspectRatio[] | undefined {
  return getVideoCapability(modelId)?.aspectRatios;
}

export function getImagenSampleSize(modelId: string): ImagenSampleSize | undefined {
  return (IMAGEN_SAMPLE_SIZE_BY_MODEL as Record<string, ImagenSampleSize>)[modelId];
}
