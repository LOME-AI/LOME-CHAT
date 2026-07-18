import { describe, it, expect } from 'vitest';
import {
  computeBannerMode,
  marqueeSpeedFor,
  computeMarqueeDurationSeconds,
  computeEnterDurationSeconds,
  computeMarqueeCopyCount,
  MARQUEE_SPEED_FAST_PX_PER_S,
  MARQUEE_SPEED_READABLE_PX_PER_S,
  FALLBACK_MARQUEE_DURATION_S,
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

describe('computeEnterDurationSeconds', () => {
  it('is viewport width / speed so the off-screen entry moves at marquee speed', () => {
    expect(computeEnterDurationSeconds(800, 55)).toBe(800 / 55);
  });

  it('is zero for a zero or NaN viewport width (no off-screen offset to travel)', () => {
    expect(computeEnterDurationSeconds(0, 55)).toBe(0);
    expect(computeEnterDurationSeconds(Number.NaN, 55)).toBe(0);
  });

  it('is zero for a zero or NaN speed (no divide-by-zero)', () => {
    expect(computeEnterDurationSeconds(800, 0)).toBe(0);
    expect(computeEnterDurationSeconds(800, Number.NaN)).toBe(0);
  });
});

describe('computeMarqueeDurationSeconds', () => {
  it('is distance / speed', () => {
    expect(computeMarqueeDurationSeconds(900, 90)).toBe(10);
  });

  it('is distance / speed even for tiny content (no clamp — speed stays constant)', () => {
    expect(computeMarqueeDurationSeconds(10, 90)).toBe(10 / 90);
  });

  it('keeps the loop speed equal to the entry speed for short and long tracks', () => {
    for (const distance of [10, 250, 900, 6000]) {
      const loopSpeed = distance / computeMarqueeDurationSeconds(distance, 90);
      const enterSpeed = 800 / computeEnterDurationSeconds(800, 90);
      expect(loopSpeed).toBeCloseTo(enterSpeed, 10);
    }
  });

  it('falls back to a sane duration on a zero or NaN measurement (no divide-by-zero)', () => {
    expect(computeMarqueeDurationSeconds(0, 90)).toBe(FALLBACK_MARQUEE_DURATION_S);
    expect(computeMarqueeDurationSeconds(Number.NaN, 90)).toBe(FALLBACK_MARQUEE_DURATION_S);
    expect(computeMarqueeDurationSeconds(900, 0)).toBe(FALLBACK_MARQUEE_DURATION_S);
  });
});

describe('computeMarqueeCopyCount', () => {
  it('adds copies until the track covers viewport + one content period (short content, wide viewport)', () => {
    // ceil((1440 + 500) / 500) = 4 — the window can never scroll past the tail.
    expect(computeMarqueeCopyCount(1440, 500)).toBe(4);
  });

  it('keeps the minimum two copies when one copy is wider than the viewport', () => {
    // ceil((800 + 1200) / 1200) = 2.
    expect(computeMarqueeCopyCount(800, 1200)).toBe(2);
  });

  it('never returns fewer than two copies', () => {
    // Exactly viewport-wide content: ceil(2) = 2.
    expect(computeMarqueeCopyCount(500, 500)).toBe(2);
  });

  it('falls back to two copies on zero or NaN measurements (jsdom / unlaid-out track)', () => {
    expect(computeMarqueeCopyCount(800, 0)).toBe(2);
    expect(computeMarqueeCopyCount(Number.NaN, 500)).toBe(2);
    expect(computeMarqueeCopyCount(800, Number.NaN)).toBe(2);
  });
});
