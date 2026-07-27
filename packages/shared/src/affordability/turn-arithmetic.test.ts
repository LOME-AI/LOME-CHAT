/**
 * The arithmetic vocabulary of `docs/BILLING.md` §Math & Terms, pinned BY
 * AMOUNT. A test that checks a term exists satisfies the words and loses the
 * arithmetic, so every assertion here names the number it expects and where the
 * number comes from.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from './constants.js';
import { cheapestEffortOption, EFFORT_DIMENSION } from './dimensions/effort.js';
import { dimensionSupportFor } from './dimensions/derive.js';
import { nanoUSD } from './nano-usd.js';
import {
  budgetBuysTokens,
  callCostBasisForTier,
  ceilingTokens,
  contextHeadroomTokens,
  costNanoUsd,
  eligible,
  feasible,
  fixedCostsNanoUsd,
  inputTokensOf,
  inputStorageNanoUsd,
  maxCallCostNanoUsd,
  maxCallCostTokens,
  medianMaxCallCostNanoUsd,
  outlierModelIds,
  reasoningBudgetTokens,
  requiredCeilingTokens,
  siblingLineItems,
  storageRatePerTokenNanoUsd,
  variableRateNanoUsd,
} from './turn-arithmetic.js';
import type { PromptBasis } from './turn-types.js';
import type { PriceableModel } from './priceable-model.js';

/** 1,000 nano per input token, 2,000 per output token — round numbers on purpose. */
const MODEL: PriceableModel = {
  modelId: 'vendor/base',
  inputRateNanoUsd: nanoUSD(1000n),
  outputRateNanoUsd: nanoUSD(2000n),
  contextLength: 100_000,
  providerCap: 8000,
  reasoning: undefined,
};

/** 1,000 prompt characters exactly, so the tier ratios divide cleanly. */
const BASIS: PromptBasis = {
  systemChars: 500,
  instructionChars: 100,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

describe('storageRatePerTokenNanoUsd — outputCharsPerToken(tier) × storageRatePerChar', () => {
  it('is 600 nano per token for paid: 2 chars per token at 300 nano per char', () => {
    expect(storageRatePerTokenNanoUsd('paid')).toBe(600n);
  });

  it('is 1,200 nano per token for every other tier: the INVERTED ratio, 4 chars per token', () => {
    expect(storageRatePerTokenNanoUsd('free')).toBe(1200n);
    expect(storageRatePerTokenNanoUsd('trial')).toBe(1200n);
    expect(storageRatePerTokenNanoUsd('guest')).toBe(1200n);
  });
});

describe('variableRateNanoUsd — outputRate(m) plus per-token storage when the turn persists', () => {
  it('adds the storage rate per token on a persisting paid turn: 2,000 + 600', () => {
    expect(variableRateNanoUsd(MODEL, 'paid', true)).toBe(2600n);
  });

  it('adds the inverted rate on a persisting free turn: 2,000 + 1,200', () => {
    expect(variableRateNanoUsd(MODEL, 'free', true)).toBe(3200n);
  });

  it('is the bare output rate when the turn does not persist', () => {
    expect(variableRateNanoUsd(MODEL, 'trial', false)).toBe(2000n);
  });
});

describe('inputTokensOf — ceil(promptChars / charsPerToken(tier))', () => {
  it('sizes a paid prompt at 4 characters per token: 1,000 chars → 250 tokens', () => {
    expect(inputTokensOf(BASIS, 'paid')).toBe(250);
  });

  it('sizes every other tier at 2 characters per token: 1,000 chars → 500 tokens', () => {
    expect(inputTokensOf(BASIS, 'free')).toBe(500);
  });

  it('rounds up, against the user, on a prompt that does not divide evenly', () => {
    const odd = { ...BASIS, inputChars: 101 };
    expect(inputTokensOf(odd, 'paid')).toBe(251);
    expect(inputTokensOf(odd, 'free')).toBe(501);
  });
});

describe('inputStorageNanoUsd — promptChars × storageRatePerChar, once per turn', () => {
  it('is 300,000 nano for a 1,000-character prompt at 300 nano per char', () => {
    expect(inputStorageNanoUsd(BASIS, true)).toBe(300_000n);
  });

  it('is zero when the turn does not persist', () => {
    expect(inputStorageNanoUsd(BASIS, false)).toBe(0n);
  });
});

describe('fixedCostsNanoUsd — the terms that do not scale with output tokens', () => {
  it('sums the per-sibling input leg, input storage, the classifier reserve and additives', () => {
    // 250 input tokens × 1,000 nano × 2 siblings = 500,000
    //                     + inputStorage 300,000
    //                     + classifierReserve 7,000
    //                     + additive 57,500,000
    expect(
      fixedCostsNanoUsd({
        siblings: [MODEL, MODEL],
        inputTokens: 250,
        inputStorageNanoUsd: 300_000n,
        classifierReserveNanoUsd: 7000n,
        additiveNanoUsd: 57_500_000n,
      })
    ).toBe(58_307_000n);
  });

  it('counts input storage exactly once however many siblings share the prompt', () => {
    const one = fixedCostsNanoUsd({
      siblings: [MODEL],
      inputTokens: 250,
      inputStorageNanoUsd: 300_000n,
      classifierReserveNanoUsd: 0n,
      additiveNanoUsd: 0n,
    });
    const three = fixedCostsNanoUsd({
      siblings: [MODEL, MODEL, MODEL],
      inputTokens: 250,
      inputStorageNanoUsd: 300_000n,
      classifierReserveNanoUsd: 0n,
      additiveNanoUsd: 0n,
    });
    expect(one).toBe(550_000n);
    expect(three).toBe(1_050_000n);
    expect(three - one).toBe(500_000n);
  });

  it('carries no classifier reserve when no classifier runs', () => {
    expect(
      fixedCostsNanoUsd({
        siblings: [MODEL],
        inputTokens: 0,
        inputStorageNanoUsd: 0n,
        classifierReserveNanoUsd: 0n,
        additiveNanoUsd: 0n,
      })
    ).toBe(0n);
  });
});

describe('costNanoUsd — inputTokens × inputRate(m) + tokens × variableRate(m)', () => {
  it('prices a persisting paid call: 250 × 1,000 + 1,000 × 2,600', () => {
    expect(
      costNanoUsd(MODEL, 1000, { inputTokens: 250, inputChars: 0, tier: 'paid', persists: true })
    ).toBe(2_850_000n);
  });

  it('drops the storage term when the turn does not persist', () => {
    expect(
      costNanoUsd(MODEL, 1000, { inputTokens: 250, inputChars: 0, tier: 'paid', persists: false })
    ).toBe(2_250_000n);
  });

  it('adds prompt storage for the sibling that carries it: 1,000 chars × 300n', () => {
    expect(
      costNanoUsd(MODEL, 1000, { inputTokens: 250, inputChars: 1000, tier: 'paid', persists: true })
    ).toBe(2_850_000n + 300_000n);
  });

  it('folds the same manifest a surface reads, so an amount and its breakdown cannot disagree', () => {
    const context = { inputTokens: 250, inputChars: 1000, tier: 'paid', persists: true } as const;
    const items = siblingLineItems(MODEL, context);
    expect(items.map((item) => item.label)).toEqual([
      'text-input-tokens',
      'input-storage',
      'text-output-tokens',
      'output-storage',
    ]);
    expect(costNanoUsd(MODEL, 0, context)).toBe(
      items.reduce((sum, item) => sum + (item.fixedNano ?? 0n), 0n)
    );
  });

  it('carries no storage line item at all when the turn does not persist', () => {
    const items = siblingLineItems(MODEL, {
      inputTokens: 250,
      inputChars: 1000,
      tier: 'paid',
      persists: false,
    });
    expect(items.filter((item) => item.kind === 'storage')).toEqual([]);
  });
});

describe('contextHeadroomTokens — contextLength(m) − inputTokens', () => {
  it('subtracts the prompt from the context window', () => {
    expect(contextHeadroomTokens(MODEL, 250)).toBe(99_750);
  });

  it('never reports negative headroom for a prompt past the window', () => {
    expect(contextHeadroomTokens(MODEL, 250_000)).toBe(0);
  });
});

describe('budgetBuysTokens — floor((funding − fixedCosts) / Σ variableRate)', () => {
  it('floors the division, so a partial token is never bought', () => {
    expect(budgetBuysTokens(10_000_000n, 1_000_000n, 2600n)).toBe(3461);
  });

  it('is zero when the funding does not cover the fixed costs', () => {
    expect(budgetBuysTokens(500_000n, 1_000_000n, 2600n)).toBe(0);
  });

  it('is zero when nothing scales with output tokens, rather than dividing by zero', () => {
    expect(budgetBuysTokens(10_000_000n, 0n, 0n)).toBe(0);
  });
});

describe('ceilingTokens — min(providerCap, contextHeadroom, budgetBuys)', () => {
  it('is bound by the provider cap when the money and the prompt leave more room', () => {
    expect(ceilingTokens(MODEL, { contextHeadroomTokens: 99_750, sharedTokens: 50_000 })).toBe(
      8000
    );
  });

  it('is bound by the context headroom when that is tightest', () => {
    expect(ceilingTokens(MODEL, { contextHeadroomTokens: 500, sharedTokens: 50_000 })).toBe(500);
  });

  it('is bound by what the money buys when that is tightest', () => {
    expect(ceilingTokens(MODEL, { contextHeadroomTokens: 99_750, sharedTokens: 1200 })).toBe(1200);
  });

  it('falls back to the context length when the catalog carries no provider cap', () => {
    const uncapped = { ...MODEL, providerCap: undefined };
    expect(ceilingTokens(uncapped, { contextHeadroomTokens: 200_000, sharedTokens: 500_000 })).toBe(
      100_000
    );
  });
});

describe('reasoningBudgetTokens — B(m, e), and e_min(m)', () => {
  const disableable: PriceableModel = {
    ...MODEL,
    modelId: 'vendor/disableable',
    contextLength: 200_000,
    providerCap: 200_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  };
  const mandatory: PriceableModel = {
    ...MODEL,
    modelId: 'vendor/mandatory',
    contextLength: 200_000,
    providerCap: 200_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  };

  it('is the ladder budget for a named rung: Mid is 12,288 tokens', () => {
    expect(reasoningBudgetTokens(disableable, 'medium')).toBe(12_288);
  });

  it("is zero at e_min for a model that can disable reasoning — the 'off' rung", () => {
    expect(cheapestEffortOption(disableable)).toBe('off');
    expect(reasoningBudgetTokens(disableable, 'off')).toBe(0);
  });

  it("is the lowest offered rung's budget at e_min for a mandatory-reasoning model: 4,096", () => {
    expect(cheapestEffortOption(mandatory)).toBe('low');
    expect(reasoningBudgetTokens(mandatory, 'low')).toBe(4096);
  });

  it('has no cheapest option for a model that cannot reason at all', () => {
    expect(cheapestEffortOption(MODEL)).toBeUndefined();
  });

  it('reserves nothing for a model that cannot reason', () => {
    expect(reasoningBudgetTokens(MODEL, 'off')).toBe(0);
  });
});

describe('feasible(m, e) and eligible(m)', () => {
  const mandatory: PriceableModel = {
    ...MODEL,
    modelId: 'vendor/mandatory',
    contextLength: 200_000,
    providerCap: 200_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  };

  it('admits a level whose budget plus a minimum answer fits the ceiling', () => {
    expect(feasible(mandatory, 'low', 4096 + MINIMUM_OUTPUT_TOKENS)).toBe(true);
  });

  it('refuses a level one token short of the minimum answer', () => {
    expect(feasible(mandatory, 'low', 4096 + MINIMUM_OUTPUT_TOKENS - 1)).toBe(false);
  });

  it('grades eligibility on the resolved cheapest corner, never on an unreachable zero', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, mandatory);
    expect(support.options.map((option) => option.optionId)).not.toContain('off');
    // A ceiling that fits a minimum answer but not the lowest rung beside it.
    expect(eligible(mandatory, MINIMUM_OUTPUT_TOKENS + 1)).toBe(false);
    expect(eligible(mandatory, 4096 + MINIMUM_OUTPUT_TOKENS)).toBe(true);
  });

  it('grades a non-reasoning model on the minimum answer alone', () => {
    expect(eligible(MODEL, MINIMUM_OUTPUT_TOKENS)).toBe(true);
    expect(eligible(MODEL, MINIMUM_OUTPUT_TOKENS - 1)).toBe(false);
  });

  it('requires the minimum answer alone when no rung applies', () => {
    expect(requiredCeilingTokens(MODEL)).toBe(MINIMUM_OUTPUT_TOKENS);
    expect(feasible(MODEL, undefined, MINIMUM_OUTPUT_TOKENS)).toBe(true);
    expect(feasible(MODEL, undefined, MINIMUM_OUTPUT_TOKENS - 1)).toBe(false);
  });

  it('states the same requirement the predicate tests, so a reason cannot re-add it', () => {
    expect(requiredCeilingTokens(mandatory, 'low')).toBe(4096 + MINIMUM_OUTPUT_TOKENS);
    expect(feasible(mandatory, 'low', requiredCeilingTokens(mandatory, 'low'))).toBe(true);
  });
});

describe('maxCallCostNanoUsd — cost(m, min(providerCap, contextHeadroom))', () => {
  it('prices the provider cap when the prompt leaves more room: 250 × 1,000 + 8,000 × 2,600', () => {
    expect(maxCallCostNanoUsd(MODEL, callCostBasisForTier(250, 'paid', true))).toBe(
      250_000n + 20_800_000n
    );
  });

  it('prices the context headroom when that is tighter than the provider cap', () => {
    expect(maxCallCostNanoUsd(MODEL, callCostBasisForTier(99_000, 'paid', true))).toBe(
      99_000_000n + 1000n * 2600n
    );
  });

  it('drops the storage term on a turn that does not persist', () => {
    expect(maxCallCostNanoUsd(MODEL, callCostBasisForTier(250, 'paid', false))).toBe(
      250_000n + 16_000_000n
    );
  });

  it('carries no funding term, so two payers price the same model identically', () => {
    const basis = callCostBasisForTier(250, 'paid', true);
    expect(maxCallCostNanoUsd(MODEL, basis)).toBe(maxCallCostNanoUsd(MODEL, basis));
  });

  it('is zero tokens wide once the prompt fills the window', () => {
    expect(maxCallCostTokens(MODEL, 100_000)).toBe(0);
  });
});

describe('outlier(m) — maxCallCost above OUTLIER_COST_MULTIPLE × the pool median', () => {
  /** Output rate alone varies, and every cap is 1,000 tokens, so maxCallCost is
   * exactly 1,000 × outputRate: 1e6, 2e6, 3e6, 4e6 and 1e8 nano. */
  const pool: readonly PriceableModel[] = [1000n, 2000n, 3000n, 4000n, 100_000n].map((rate) => ({
    modelId: `vendor/rate-${String(rate)}`,
    inputRateNanoUsd: nanoUSD(0n),
    outputRateNanoUsd: nanoUSD(rate),
    contextLength: 100_000,
    providerCap: 1000,
    reasoning: undefined,
  }));
  const basis = callCostBasisForTier(0, 'paid', false);

  it('takes the median over the whole priceable pool: 3,000,000 nano', () => {
    expect(medianMaxCallCostNanoUsd(pool, basis)).toBe(3_000_000n);
  });

  it('excludes only the model past 20 × that median', () => {
    expect([...outlierModelIds(pool, basis)]).toEqual(['vendor/rate-100000']);
  });

  it('never trims a tight distribution', () => {
    expect(outlierModelIds(pool.slice(0, 4), basis).size).toBe(0);
  });

  it('keeps a candidate exactly at the multiple: the test is strictly greater', () => {
    const atThreshold: PriceableModel = {
      ...pool[0]!,
      modelId: 'vendor/at-threshold',
      outputRateNanoUsd: nanoUSD(3000n * 20n),
    };
    expect(outlierModelIds([...pool.slice(0, 4), atThreshold], basis).size).toBe(0);
  });

  it('excludes a model made extreme by its CAPACITY rather than its rate', () => {
    const enormous: PriceableModel = {
      ...pool[1]!,
      modelId: 'vendor/enormous',
      providerCap: 100_000,
      contextLength: 1_000_000,
    };
    expect([...outlierModelIds([...pool.slice(0, 4), enormous], basis)]).toEqual([
      'vendor/enormous',
    ]);
  });

  it('drops a model the prompt leaves no room for from the pool rather than ranking it at zero', () => {
    const narrow: PriceableModel = { ...pool[0]!, modelId: 'vendor/narrow', contextLength: 10 };
    expect(medianMaxCallCostNanoUsd([...pool, narrow], { ...basis, inputTokens: 100 })).toBe(
      medianMaxCallCostNanoUsd(pool, { ...basis, inputTokens: 100 })
    );
  });

  it('has no median, and therefore no exclusion, over an empty pool', () => {
    expect(medianMaxCallCostNanoUsd([], basis)).toBeUndefined();
    expect(outlierModelIds([], basis).size).toBe(0);
  });
});
