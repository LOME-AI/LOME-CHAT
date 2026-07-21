import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  applyMarkup,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  NANO_USD_PER_CENT,
} from '@hushbox/shared';
import { useMediaCostEstimate } from '@/hooks/billing/use-media-cost-estimate';

const CENTS_PER_NANO = Number(NANO_USD_PER_CENT);

/** Customer-facing cents for a media manifest: markup(provider) + raw storage. */
function expectedCents(providerBaseNano: bigint, storageBaseNano: bigint): number {
  return Number(applyMarkup(providerBaseNano) + storageBaseNano) / CENTS_PER_NANO;
}

describe('useMediaCostEstimate', () => {
  it('returns 0 cents for text modality', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'text' }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('computes image cost as marked-up per-model provider rate plus per-model storage', () => {
    // BASE (pre-markup) nano per-image rates: $0.04 and $0.06.
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imageRatesNano: [40_000_000n, 60_000_000n],
      })
    );
    const storage = BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO * 2n;
    expect(result.current.estimatedCents).toBeCloseTo(expectedCents(100_000_000n, storage), 6);
  });

  it('image cost reflects actual per-model rates, not max × count', () => {
    const { result: mixed } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [20_000_000n, 60_000_000n] })
    );
    const { result: maxOnly } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [60_000_000n, 60_000_000n] })
    );
    expect(mixed.current.estimatedCents).toBeLessThan(maxOnly.current.estimatedCents);
  });

  it('computes video cost as marked-up (per-model rate × duration) plus storage', () => {
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
    expect(result.current.estimatedCents).toBeCloseTo(expectedCents(provider, storage), 6);
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
    expect(long.current.estimatedCents).toBeCloseTo(short.current.estimatedCents * 4, 3);
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
    expect(three.current.estimatedCents).toBeCloseTo(one.current.estimatedCents * 3, 6);
  });

  it('computes audio cost as marked-up (per-model rate × maxDuration) plus storage', () => {
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
    expect(result.current.estimatedCents).toBeCloseTo(expectedCents(provider, storage), 6);
  });

  it('counts a zero-rate (unpriced) model in storage while charging no provider cost', () => {
    const { result: priced } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [40_000_000n] })
    );
    const { result: withGhost } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [40_000_000n, 0n] })
    );
    // The ghost adds a second model's storage but no provider cost.
    const extraStorage =
      Number(BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO) / CENTS_PER_NANO;
    expect(withGhost.current.estimatedCents).toBeCloseTo(
      priced.current.estimatedCents + extraStorage,
      6
    );
  });

  it('returns 0 when no models are selected (empty image rates)', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [] })
    );
    expect(result.current.estimatedCents).toBe(0);
  });

  it('returns 0 for video when duration is zero', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        videoRatesNano: { ratesNano: [100_000_000n], durationSeconds: 0 },
      })
    );
    expect(result.current.estimatedCents).toBe(0);
  });

  it('returns 0 for image modality when no rates are supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'image' }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('returns 0 for video modality when no rates are supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'video' }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('returns 0 for audio modality when no rates are supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'audio' }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('exposes estimatedDollars for display convenience', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({ modality: 'image', imageRatesNano: [40_000_000n] })
    );
    expect(result.current.estimatedDollars).toBeCloseTo(result.current.estimatedCents / 100, 6);
  });
});
