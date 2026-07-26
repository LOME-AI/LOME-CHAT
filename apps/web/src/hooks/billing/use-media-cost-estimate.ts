import * as React from 'react';
import {
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  NANO_USD_PER_DOLLAR,
} from '@hushbox/shared';
import { priceRequest } from '@hushbox/shared/affordability/estimate/price-request';
import { reservationCeiling } from '@hushbox/shared/affordability/estimate/reducers';
import type { ChatModality } from '@hushbox/shared';
import type { BillableRequest } from '@hushbox/shared/affordability/estimate/types';

export interface VideoRates {
  /** BASE (pre-markup) nano per-second rate for each selected model, in order. */
  ratesNano: readonly bigint[];
  /** Duration in seconds (fixed at request time for video). */
  durationSeconds: number;
}

export interface AudioRates {
  /** BASE (pre-markup) nano per-second rate for each selected model, in order. */
  ratesNano: readonly bigint[];
  /** User-set worst-case cap on the synthesized duration, in seconds. */
  durationSeconds: number;
}

export interface UseMediaCostEstimateInput {
  modality: ChatModality;
  /** BASE (pre-markup) nano per-image rate for each selected image model. */
  imageRatesNano?: readonly bigint[];
  videoRatesNano?: VideoRates;
  audioRatesNano?: AudioRates;
}

export interface MediaCostEstimate {
  /** Exact nano-USD estimate — the decision-domain figure. */
  estimatedNanoUsd: bigint;
  /** Display-only dollars (the one permitted money coercion). */
  estimatedDollars: number;
}

/**
 * A BillableRequest carries text fields the media path never reads; these
 * satisfy the shape without affecting the media manifest.
 */
const MEDIA_REQUEST_TEXT_DEFAULTS = {
  inputTokens: 0n,
  inputChars: 0,
  outputCharsPerToken: 1,
} as const;

function imageRequest(ratesNano: readonly bigint[]): BillableRequest {
  return {
    ...MEDIA_REQUEST_TEXT_DEFAULTS,
    models: ratesNano.map((perImage) => ({ pricing: { perImage } })),
    modality: 'image',
    media: { rateKey: 'perImage', units: 1, storageBytes: ESTIMATED_IMAGE_BYTES },
  };
}

function perSecondRequest(
  modality: 'video' | 'audio',
  rates: VideoRates | AudioRates,
  bytesPerSecond: number
): BillableRequest {
  return {
    ...MEDIA_REQUEST_TEXT_DEFAULTS,
    models: rates.ratesNano.map((perSecond) => ({ pricing: { perSecond } })),
    modality,
    media: {
      rateKey: 'perSecond',
      units: rates.durationSeconds,
      storageBytes: rates.durationSeconds * bytesPerSecond,
    },
  };
}

/**
 * Price a media request through the shared cost core, in exact nano-USD.
 * `reservationCeiling` over a media manifest (which has no per-output-token
 * items) is exactly `markup(provider) + storage` — the same total the server
 * reserves. An unpriceable request (no models, zero duration, missing rate)
 * fails closed in the core and shows $0, matching "no cost until pricing is
 * available".
 */
function priceMediaNano(request: BillableRequest): bigint {
  const manifest = priceRequest(request);
  if (!manifest.ok) return 0n;
  return reservationCeiling(manifest.value, {
    outputTokenCeiling: 0n,
    fanOutWidth: 1,
    maxSteps: 1,
    maxIterations: 1,
  });
}

/**
 * Pre-inference cost estimate for a pending media request, computed from the
 * shared cost core over each selected model's BASE nano rates. Image and video
 * are exact (every input fixes the cost); audio is worst-case against the
 * user-set duration cap. The value is the customer-facing total (marked-up
 * provider cost + pass-through storage), matching the server-side reservation
 * for the same inputs, exact nano-USD; dollars exist only for display. Returns
 * 0 for text, for an empty selection, and when the modality's rates aren't
 * supplied yet.
 */
export function useMediaCostEstimate(input: UseMediaCostEstimateInput): MediaCostEstimate {
  const { modality, imageRatesNano, videoRatesNano, audioRatesNano } = input;

  return React.useMemo(() => {
    let nano = 0n;
    if (modality === 'image' && imageRatesNano) {
      nano = priceMediaNano(imageRequest(imageRatesNano));
    } else if (modality === 'video' && videoRatesNano) {
      nano = priceMediaNano(
        perSecondRequest('video', videoRatesNano, ESTIMATED_VIDEO_BYTES_PER_SECOND)
      );
    } else if (modality === 'audio' && audioRatesNano) {
      nano = priceMediaNano(
        perSecondRequest('audio', audioRatesNano, ESTIMATED_AUDIO_BYTES_PER_SECOND)
      );
    }

    return { estimatedNanoUsd: nano, estimatedDollars: Number(nano) / Number(NANO_USD_PER_DOLLAR) };
  }, [modality, imageRatesNano, videoRatesNano, audioRatesNano]);
}
