import { interpolate } from 'remotion';

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** The volume-relevant subset of a spec's music bed. */
export interface MusicVolumeConfig {
  /** Volume before the swell, and the flat volume when no swell is set (0..1). */
  baseVolume: number;
  /** Volume at the top of the swell (0..1). */
  peakVolume: number;
  /** Frame the swell begins; omit for a flat bed at base volume. */
  swellFromFrame?: number | undefined;
  /** Frames the swell ramps base→peak over. */
  swellFrames: number;
}

/**
 * Bed volume for a composition frame: flat `baseVolume` until `swellFromFrame`,
 * then a linear ramp to `peakVolume` over `swellFrames`, held after. The bed's
 * hard cut to silence at the payoff is the Sequence's `durationInFrames`, never
 * a volume drop — silence is a cut, not a fade.
 */
export function musicVolume(frame: number, config: MusicVolumeConfig): number {
  const { baseVolume, peakVolume, swellFromFrame, swellFrames } = config;
  if (swellFromFrame === undefined) {
    return baseVolume;
  }
  return interpolate(
    frame,
    [swellFromFrame, swellFromFrame + swellFrames],
    [baseVolume, peakVolume],
    CLAMP
  );
}
