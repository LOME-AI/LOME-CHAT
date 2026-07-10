import { describe, expect, it } from 'vitest';
import { groupEffectiveRemainingNanoUsd } from './group-budget.js';

describe('groupEffectiveRemainingNanoUsd', () => {
  it('returns the smallest of the three dimensions when all are positive', () => {
    expect(groupEffectiveRemainingNanoUsd(500n, 300n, 900n)).toBe(300n);
  });

  it('is zero when the member dimension is exhausted (owner-funding refused)', () => {
    expect(groupEffectiveRemainingNanoUsd(0n, 1_000_000n, 1_000_000n)).toBe(0n);
  });

  it('is zero when the conversation dimension is exhausted', () => {
    expect(groupEffectiveRemainingNanoUsd(1_000_000n, 0n, 1_000_000n)).toBe(0n);
  });

  it('is zero when the owner has no balance', () => {
    expect(groupEffectiveRemainingNanoUsd(1_000_000n, 1_000_000n, 0n)).toBe(0n);
  });

  it('clamps a negative (overspent) member dimension to zero, never masking it with a larger sibling', () => {
    // memberRemaining is negative (spent past the cap); a positive owner balance
    // and conversation budget must not let the min go positive.
    expect(groupEffectiveRemainingNanoUsd(-1000n, 5_000_000n, 5_000_000n)).toBe(0n);
  });

  it('clamps a negative (in-the-red) owner balance to zero', () => {
    expect(groupEffectiveRemainingNanoUsd(5_000_000n, 5_000_000n, -42n)).toBe(0n);
  });
});
