/**
 * Provider-side capability data for AI Gateway models — the axes each model
 * accepts that the public `/v1/models` catalog doesn't expose (or exposes
 * inconsistently). Single source of truth for both production code (request
 * shaping in `apps/api/services/ai/real.ts`, route-level validation) and
 * integration tests (capability-driven model picker).
 *
 * A new video model needs its capability entry added below; ZDR-reachability is
 * enforced separately at runtime from the live `/endpoints/zdr` set.
 */

import type { VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, IMAGE_ASPECT_RATIOS } from '../constants.js';

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
} as const satisfies Record<string, VideoCapability>;

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
