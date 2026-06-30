import * as React from 'react';
import {
  computeImageExactCents,
  computeVideoExactCents,
  computeAudioWorstCaseCents,
} from '@hushbox/shared';
import type { LegacyModality } from '@hushbox/shared';

export interface ImagePricing {
  /** Fee-inclusive USD per image, one entry per selected model (from `Model.pricePerImage`). */
  pricesPerImage: readonly number[];
}

export interface VideoPricing {
  /** Fee-inclusive USD per second at the chosen resolution, one entry per selected model. */
  pricesPerSecond: readonly number[];
  /** Duration in seconds (fixed at request time for video). */
  durationSeconds: number;
}

export interface AudioPricing {
  /** Fee-inclusive USD per second of synthesized speech, one entry per selected model. */
  pricesPerSecond: readonly number[];
  /** User-set worst-case cap on the synthesized duration. */
  durationSeconds: number;
}

export interface UseMediaCostEstimateInput {
  modality: LegacyModality;
  imagePricing?: ImagePricing;
  videoPricing?: VideoPricing;
  audioPricing?: AudioPricing;
}

export interface MediaCostEstimate {
  estimatedCents: number;
  estimatedDollars: number;
}

/**
 * Pre-inference cost estimate for a pending media request.
 *
 * Image and video are exact (deterministic at reservation time): every input
 * fully fixes the cost. Audio is worst-case because TTS duration emerges from
 * synthesizing the input text — `durationSeconds` is the user-set upper bound.
 *
 * The hook takes per-model price arrays so the estimate reflects each
 * selected model's actual price (no max-of pessimism). Returns 0 when no
 * models are selected, when pricing isn't yet available, or for text.
 *
 * Computed via the same helpers the backend uses for reservation, so the UI
 * estimate matches the server-side value exactly for image/video, and tracks
 * the worst-case ceiling for audio.
 */
export function useMediaCostEstimate(input: UseMediaCostEstimateInput): MediaCostEstimate {
  const { modality, imagePricing, videoPricing, audioPricing } = input;

  return React.useMemo(() => {
    let cents = 0;
    if (modality === 'image' && imagePricing) {
      cents = computeImageExactCents(imagePricing.pricesPerImage);
    } else if (modality === 'video' && videoPricing) {
      cents = computeVideoExactCents(videoPricing.pricesPerSecond, videoPricing.durationSeconds);
    } else if (modality === 'audio' && audioPricing) {
      cents = computeAudioWorstCaseCents(
        audioPricing.pricesPerSecond,
        audioPricing.durationSeconds
      );
    }

    return { estimatedCents: cents, estimatedDollars: cents / 100 };
  }, [modality, imagePricing, videoPricing, audioPricing]);
}
