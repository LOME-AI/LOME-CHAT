import { describe, expect, it } from 'vitest';

import { musicVolume } from './music-volume.js';

const swell = { baseVolume: 0.3, peakVolume: 0.5, swellFromFrame: 100, swellFrames: 20 };

describe('musicVolume', () => {
  it('holds base volume when no swell is configured', () => {
    const flat = { baseVolume: 0.3, peakVolume: 0.5, swellFrames: 20 };
    expect(musicVolume(0, flat)).toBe(0.3);
    expect(musicVolume(999, flat)).toBe(0.3);
  });

  it('holds base volume before the swell starts', () => {
    expect(musicVolume(50, swell)).toBe(0.3);
  });

  it('is base volume at the swell start', () => {
    expect(musicVolume(100, swell)).toBe(0.3);
  });

  it('reaches peak volume at the end of the swell ramp', () => {
    expect(musicVolume(120, swell)).toBe(0.5);
  });

  it('holds peak volume after the swell', () => {
    expect(musicVolume(500, swell)).toBe(0.5);
  });

  it('interpolates linearly across the ramp', () => {
    expect(musicVolume(110, swell)).toBeCloseTo(0.4, 5);
  });
});
