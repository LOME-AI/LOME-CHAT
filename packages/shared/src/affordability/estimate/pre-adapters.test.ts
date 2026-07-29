import { describe, expect, it } from 'vitest';

import {
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_TRIAL_MESSAGE_COST_CENTS,
} from '../constants.js';
import { NANO_USD_PER_CENT } from '../nano-usd.js';
import {
  PAID_CUSHION_NANO_USD,
  charsPerTokenForTier,
  computePromptCapacity,
  estimateTokensForTier,
  getCushionNano,
  getEffectiveBalanceNano,
  outputCharsPerTokenForTier,
  spendableFundsNanoUsd,
} from './pre-adapters.js';

describe('charsPerTokenForTier', () => {
  it('uses the standard ratio for paid users', () => {
    expect(charsPerTokenForTier('paid')).toBe(CHARS_PER_TOKEN_STANDARD);
  });

  it('uses the conservative ratio for every non-paid tier', () => {
    expect(charsPerTokenForTier('free')).toBe(CHARS_PER_TOKEN_CONSERVATIVE);
    expect(charsPerTokenForTier('trial')).toBe(CHARS_PER_TOKEN_CONSERVATIVE);
    expect(charsPerTokenForTier('guest')).toBe(CHARS_PER_TOKEN_CONSERVATIVE);
  });
});

describe('estimateTokensForTier', () => {
  it('returns zero for an empty prompt', () => {
    expect(estimateTokensForTier('paid', 0)).toBe(0);
  });

  it('rounds up conservatively (2 chars/token) for free/trial/guest', () => {
    // 4001 chars / 2 = 2000.5 -> ceil 2001
    expect(estimateTokensForTier('free', 4001)).toBe(2001);
  });

  it('rounds up at 4 chars/token for paid', () => {
    expect(estimateTokensForTier('paid', 4001)).toBe(1001);
  });
});

describe('outputCharsPerTokenForTier', () => {
  it('inverts the input ratio: paid gets the conservative ratio', () => {
    expect(outputCharsPerTokenForTier('paid')).toBe(CHARS_PER_TOKEN_CONSERVATIVE);
  });

  it('inverts the input ratio: non-paid gets the standard ratio', () => {
    expect(outputCharsPerTokenForTier('free')).toBe(CHARS_PER_TOKEN_STANDARD);
    expect(outputCharsPerTokenForTier('trial')).toBe(CHARS_PER_TOKEN_STANDARD);
  });
});

describe('PAID_CUSHION_NANO_USD', () => {
  it('is the $0.50 negative-balance cushion in nano-USD', () => {
    expect(PAID_CUSHION_NANO_USD).toBe(
      BigInt(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) * NANO_USD_PER_CENT
    );
  });
});

describe('getCushionNano', () => {
  it('grants the cushion only to paid users', () => {
    expect(getCushionNano('paid')).toBe(PAID_CUSHION_NANO_USD);
  });

  it('grants no cushion to non-paid tiers', () => {
    expect(getCushionNano('free')).toBe(0n);
    expect(getCushionNano('trial')).toBe(0n);
    expect(getCushionNano('guest')).toBe(0n);
  });
});

describe('spendableFundsNanoUsd', () => {
  it('adds the cushion to a paid balance', () => {
    expect(spendableFundsNanoUsd(1_000_000n, 'paid')).toBe(1_000_000n + PAID_CUSHION_NANO_USD);
  });

  it('leaves a non-paid balance untouched', () => {
    expect(spendableFundsNanoUsd(1_000_000n, 'free')).toBe(1_000_000n);
  });
});

describe('getEffectiveBalanceNano', () => {
  it('caps the trial at the fixed max message cost', () => {
    // The trial alone: a link guest HAS a funding door and is owner-funded, so
    // it is excluded from the parameter type and cannot be handed this ceiling
    // (§Affordability 8). There is no runtime arm left to assert against —
    // `getEffectiveBalanceNano('guest', …)` is a compile error.
    const trialFixed = BigInt(MAX_TRIAL_MESSAGE_COST_CENTS) * NANO_USD_PER_CENT;
    expect(getEffectiveBalanceNano('trial', 999n, 999n)).toBe(trialFixed);
  });

  it('uses only the free allowance for free users', () => {
    expect(getEffectiveBalanceNano('free', 5_000_000_000n, 500_000n)).toBe(500_000n);
  });

  it('adds the cushion to the balance for paid users', () => {
    expect(getEffectiveBalanceNano('paid', 2_000_000n, 0n)).toBe(
      2_000_000n + PAID_CUSHION_NANO_USD
    );
  });
});

describe('computePromptCapacity', () => {
  it('reports usage as input tokens (4 chars/token) plus the minimum output reserve', () => {
    // 4000 chars / 4 = 1000 input tokens + 1000 minimum output = 2000 of 10000 -> 20%
    const capacity = computePromptCapacity({
      promptCharacterCount: 4000,
      modelContextLength: 10_000,
    });
    expect(capacity.currentUsage).toBe(2000);
    expect(capacity.maxCapacity).toBe(10_000);
    expect(capacity.capacityPercent).toBeCloseTo(20);
  });

  it('reports zero percent when the context length is unknown', () => {
    const capacity = computePromptCapacity({ promptCharacterCount: 4000, modelContextLength: 0 });
    expect(capacity.capacityPercent).toBe(0);
  });
});
