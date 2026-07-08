import { describe, expect, it } from 'vitest';
import {
  COST_CIRCUIT_MULTIPLIER,
  DAILY_ALLOWANCE_NANO_USD,
  HOLD_TTL_MARGIN_SECONDS,
  TRIAL_DAILY_SPEND_CAP_NANO_USD,
  WELCOME_CREDIT_NANO_USD,
} from './constants.js';

describe('billing constants', () => {
  it('names the cost-circuit multiplier K with its initial value 5', () => {
    expect(COST_CIRCUIT_MULTIPLIER).toBe(5n);
  });

  it('derives the welcome credit from the shared cents constant', () => {
    // $0.20 in nano-USD
    expect(WELCOME_CREDIT_NANO_USD).toBe(200_000_000n);
  });

  it('derives the daily allowance from the shared cents constant', () => {
    // $0.05 in nano-USD
    expect(DAILY_ALLOWANCE_NANO_USD).toBe(50_000_000n);
  });

  it('keeps the hold-TTL margin positive', () => {
    expect(HOLD_TTL_MARGIN_SECONDS).toBeGreaterThan(0);
  });

  it('sets the daily trial-spend cap at $50 (nano-USD bigint, no float)', () => {
    expect(typeof TRIAL_DAILY_SPEND_CAP_NANO_USD).toBe('bigint');
    expect(TRIAL_DAILY_SPEND_CAP_NANO_USD).toBe(50_000_000_000n);
  });
});
