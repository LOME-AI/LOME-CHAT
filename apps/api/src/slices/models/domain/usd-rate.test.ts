import { describe, expect, it } from 'vitest';
import { usdRateToNanoUsd } from './usd-rate.js';

describe('usdRateToNanoUsd', () => {
  it('converts a per-token USD decimal to an integer nano-USD string', () => {
    expect(usdRateToNanoUsd('0.0000025')).toBe('2500');
  });

  it('converts a whole-dollar rate', () => {
    expect(usdRateToNanoUsd('2')).toBe('2000000000');
  });

  it('converts a rate with no fractional part and a trailing dot rejected', () => {
    expect(usdRateToNanoUsd('1.')).toBeUndefined();
  });

  it('converts zero to the canonical zero string', () => {
    expect(usdRateToNanoUsd('0')).toBe('0');
  });

  it('rounds half-even when the rate has more than nine fractional digits', () => {
    // 12.5 nano rounds to 12 (even); 13.5 nano rounds to 14 (even).
    expect(usdRateToNanoUsd('0.0000000125')).toBe('12');
    expect(usdRateToNanoUsd('0.0000000135')).toBe('14');
  });

  it('rounds up when the remainder is above half', () => {
    expect(usdRateToNanoUsd('0.0000000126')).toBe('13');
  });

  it('rounds down when the remainder is below half', () => {
    expect(usdRateToNanoUsd('0.0000000124')).toBe('12');
  });

  it('rounds up when a half digit is followed by more precision', () => {
    expect(usdRateToNanoUsd('0.00000001251')).toBe('13');
  });

  it('rejects a negative rate', () => {
    expect(usdRateToNanoUsd('-0.001')).toBeUndefined();
  });

  it('rejects a non-numeric rate', () => {
    expect(usdRateToNanoUsd('free')).toBeUndefined();
  });

  it('rejects exponent notation', () => {
    expect(usdRateToNanoUsd('2.5e-6')).toBeUndefined();
  });

  it('rejects the empty string', () => {
    expect(usdRateToNanoUsd('')).toBeUndefined();
  });
});
