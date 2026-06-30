import { describe, expect, it } from 'vitest';
import { BACKOFF_CAP_SECONDS, backoffSeconds } from './backoff.js';

/** Deterministic PRNG (Park-Miller) so jitter assertions replay exactly. */
function seededRandom(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) state += 2_147_483_646;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

describe('backoffSeconds', () => {
  it('returns the quartic base when jitter is centered', () => {
    expect(backoffSeconds(2, () => 0.5)).toBe(16);
  });

  it('scales as failures to the fourth power', () => {
    expect(backoffSeconds(3, () => 0.5)).toBe(81);
  });

  it('applies -10% jitter at the random floor', () => {
    expect(backoffSeconds(2, () => 0)).toBeCloseTo(14.4, 10);
  });

  it('applies +10% jitter at the random ceiling', () => {
    expect(backoffSeconds(2, () => 1)).toBeCloseTo(17.6, 10);
  });

  it('caps the delay at one hour', () => {
    expect(backoffSeconds(10, () => 1)).toBe(BACKOFF_CAP_SECONDS);
  });

  it('keeps seeded jitter within the +/-10% band below the cap', () => {
    const random = seededRandom(0xc0_ff_ee);
    for (let failures = 1; failures <= 7; failures += 1) {
      const base = Math.min(failures ** 4, BACKOFF_CAP_SECONDS);
      const value = backoffSeconds(failures, random);
      expect(value).toBeGreaterThanOrEqual(base * 0.9);
      expect(value).toBeLessThanOrEqual(Math.min(base * 1.1, BACKOFF_CAP_SECONDS));
    }
  });

  it('rejects a non-positive failure count', () => {
    expect(() => backoffSeconds(0, () => 0.5)).toThrow('failures');
  });

  it('rejects a fractional failure count', () => {
    expect(() => backoffSeconds(1.5, () => 0.5)).toThrow('failures');
  });
});
