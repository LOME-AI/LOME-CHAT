import { describe, it, expect } from 'vitest';
import {
  computeBannerMode,
  marqueeSpeedFor,
  computeMarqueeDurationSeconds,
  MARQUEE_SPEED_FAST_PX_PER_S,
  MARQUEE_SPEED_READABLE_PX_PER_S,
  MIN_MARQUEE_DURATION_S,
} from './compute-mode.js';

describe('computeBannerMode', () => {
  it('is "none" with no messages', () => {
    expect(computeBannerMode(0, 100, 800)).toBe('none');
  });

  it('is "static" for a single message that fits', () => {
    expect(computeBannerMode(1, 300, 800)).toBe('static');
  });

  it('is "scroll" for a single message wider than the viewport', () => {
    expect(computeBannerMode(1, 1200, 800)).toBe('scroll');
  });

  it('is "scroll" for multiple messages even when they would fit', () => {
    expect(computeBannerMode(3, 200, 800)).toBe('scroll');
  });
});

describe('marqueeSpeedFor', () => {
  it('uses the readable speed for a single (overflowing) message', () => {
    expect(marqueeSpeedFor(1)).toBe(MARQUEE_SPEED_READABLE_PX_PER_S);
  });

  it('uses the fast speed for multiple messages', () => {
    expect(marqueeSpeedFor(4)).toBe(MARQUEE_SPEED_FAST_PX_PER_S);
  });
});

describe('computeMarqueeDurationSeconds', () => {
  it('is distance / speed', () => {
    expect(computeMarqueeDurationSeconds(900, 90)).toBe(10);
  });

  it('clamps to a minimum for tiny content', () => {
    expect(computeMarqueeDurationSeconds(10, 90)).toBe(MIN_MARQUEE_DURATION_S);
  });

  it('falls back to the minimum on a zero or NaN measurement (no divide-by-zero)', () => {
    expect(computeMarqueeDurationSeconds(0, 90)).toBe(MIN_MARQUEE_DURATION_S);
    expect(computeMarqueeDurationSeconds(Number.NaN, 90)).toBe(MIN_MARQUEE_DURATION_S);
    expect(computeMarqueeDurationSeconds(900, 0)).toBe(MIN_MARQUEE_DURATION_S);
  });
});
