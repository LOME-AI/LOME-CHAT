import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  NANO_USD_PER_DOLLAR,
} from '@hushbox/shared';
import { useMediaCostEstimate } from '@/hooks/billing/use-media-cost-estimate';

/** Customer-facing nano for a media manifest: billable provider + raw storage
 * (rates are billable at ingestion — no fee math in the estimator). */
function expectedNano(providerBillableNano: bigint, storageBaseNano: bigint): bigint {
  return providerBillableNano + storageBaseNano;
}

describe('useMediaCostEstimate', () => {
  it('returns 0 nano for text modality', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'text' }));
    expect(result.current.estimatedNanoUsd).toBe(0n);
  });

  it('computes image cost as the billable per-model provider rate plus per-model storage', () => {
    // Billable nano per-image rates: $0.04 and $0.06.
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imageRatesNano: [40_000_000n, 60_000_000n],
      })
    );
    const storage = BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO * 2n;
    expect(result.current.estimatedNanoUsd).toBe(expectedNano(100_000_000n, storage));
  });

  it('image cost reflects actual per-model rates, not max × count', () => {
    const { result: mixed } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [20_000_000n, 60_000_000n] })
    );
    const { result: maxOnly } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [60_000_000n, 60_000_000n] })
    );
    expect(mixed.current.estimatedNanoUsd).toBeLessThan(maxOnly.current.estimatedNanoUsd);
  });

  it('computes video cost as the billable (per-model rate × duration) plus storage', () => {
    const durationSeconds = 4;
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        videoRatesNano: { ratesNano: [100_000_000n, 400_000_000n], durationSeconds },
      })
    );
    const provider = (100_000_000n + 400_000_000n) * BigInt(durationSeconds);
    const storage =
      BigInt(durationSeconds) *
      BigInt(ESTIMATED_VIDEO_BYTES_PER_SECOND) *
      MEDIA_STORAGE_COST_PER_BYTE_NANO *
      2n;
    expect(result.current.estimatedNanoUsd).toBe(expectedNano(provider, storage));
  });

  it('scales video cost linearly with duration', () => {
    const { result: short } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        videoRatesNano: { ratesNano: [100_000_000n], durationSeconds: 2 },
      })
    );
    const { result: long } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        videoRatesNano: { ratesNano: [100_000_000n], durationSeconds: 8 },
      })
    );
    expect(long.current.estimatedNanoUsd).toBe(short.current.estimatedNanoUsd * 4n);
  });

  it('scales image cost with the number of selected models', () => {
    const { result: one } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [40_000_000n] })
    );
    const { result: three } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imageRatesNano: [40_000_000n, 40_000_000n, 40_000_000n],
      })
    );
    expect(three.current.estimatedNanoUsd).toBe(one.current.estimatedNanoUsd * 3n);
  });

  it('computes audio cost as the billable (per-model rate × maxDuration) plus storage', () => {
    const durationSeconds = 60;
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'audio',
        audioRatesNano: { ratesNano: [15_000_000n, 30_000_000n], durationSeconds },
      })
    );
    const provider = (15_000_000n + 30_000_000n) * BigInt(durationSeconds);
    const storage =
      BigInt(durationSeconds) *
      BigInt(ESTIMATED_AUDIO_BYTES_PER_SECOND) *
      MEDIA_STORAGE_COST_PER_BYTE_NANO *
      2n;
    expect(result.current.estimatedNanoUsd).toBe(expectedNano(provider, storage));
  });

  it('counts a zero-rate (unpriced) model in storage while charging no provider cost', () => {
    const { result: priced } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [40_000_000n] })
    );
    const { result: withGhost } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [40_000_000n, 0n] })
    );
    // The ghost adds a second model's storage but no provider cost.
    const extraStorage = BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    expect(withGhost.current.estimatedNanoUsd).toBe(priced.current.estimatedNanoUsd + extraStorage);
  });

  it('returns 0 when no models are selected (empty image rates)', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [] })
    );
    expect(result.current.estimatedNanoUsd).toBe(0n);
  });

  it('returns 0 for video when duration is zero', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        videoRatesNano: { ratesNano: [100_000_000n], durationSeconds: 0 },
      })
    );
    expect(result.current.estimatedNanoUsd).toBe(0n);
  });

  it('returns 0 for image modality when no rates are supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'image' }));
    expect(result.current.estimatedNanoUsd).toBe(0n);
  });

  it('returns 0 for video modality when no rates are supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'video' }));
    expect(result.current.estimatedNanoUsd).toBe(0n);
  });

  it('returns 0 for audio modality when no rates are supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'audio' }));
    expect(result.current.estimatedNanoUsd).toBe(0n);
  });

  it('exposes estimatedDollars for display convenience (the one permitted coercion)', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [40_000_000n] })
    );
    expect(result.current.estimatedDollars).toBeCloseTo(
      Number(result.current.estimatedNanoUsd) / Number(NANO_USD_PER_DOLLAR),
      9
    );
  });
});
