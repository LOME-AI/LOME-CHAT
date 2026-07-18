import { interpolate } from 'remotion';

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/**
 * Opacity for an overlay that fades in over `fadeFrames`, holds, then fades out
 * over the same span before `durationInFrames`. Opacity-only motion — the type
 * never moves; stillness is the voice.
 */
export function crossFadeOpacity(frame: number, durationInFrames: number, fadeFrames = 6): number {
  return interpolate(
    frame,
    [0, fadeFrames, durationInFrames - fadeFrames, durationInFrames],
    [0, 1, 1, 0],
    CLAMP
  );
}

/** Opacity for an element that fades in over `fadeFrames` and then holds. */
export function fadeInOpacity(frame: number, fadeFrames = 6): number {
  return interpolate(frame, [0, fadeFrames], [0, 1], CLAMP);
}

/**
 * Scale for a caption chunk that pops from 0.96 to 1 over `fadeFrames` — a
 * subtle settle, never a bounce. Pairs with a fade so the chunk lands on beat.
 */
export function popInScale(frame: number, fadeFrames = 6): number {
  return interpolate(frame, [0, fadeFrames], [0.96, 1], CLAMP);
}
