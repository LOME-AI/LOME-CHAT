/**
 * `eligible(m)` is graded on the resolved cheapest corner `B(m, e_min(m)) +
 * MINIMUM_OUTPUT_TOKENS`, never on an unreachable zero (`docs/BILLING.md`
 * §Predicates, §Affordability 6).
 *
 * The pair below is RATE-IDENTICAL and differs only in how many native effort
 * words the catalog lists: one rung versus three, both mandatory. Two models that
 * cost the same and reason the same must reach the same verdict at the same
 * funding, so the asymmetry is the assertion — a single-rung model graded at the
 * minimum-answer floor would sell a paid turn whose whole ceiling the provider
 * spends thinking, returning nothing.
 */

import { describe, expect, it } from 'vitest';

import { REASONING_BUDGET_TOKENS_BY_EFFORT } from './estimate/reasoning-plan.js';
import { MINIMUM_OUTPUT_TOKENS } from './constants.js';
import { nanoUSD } from './nano-usd.js';
import { getTurnOptions } from './turn-options.js';
import type { PriceableModel } from './priceable-model.js';
import type { FundingSnapshot, PromptBasis, Selection } from './turn-types.js';

/** 1,000 prompt characters exactly: 250 input tokens at the paid ratio. */
const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

const RATES = {
  inputRateNanoUsd: nanoUSD(100n),
  outputRateNanoUsd: nanoUSD(200n),
  contextLength: 200_000,
  providerCap: 64_000,
} as const;

/** One native effort word, mandatory: the model reasons or it does not run. */
const SINGLE_RUNG: PriceableModel = {
  ...RATES,
  modelId: 'vendor/single-rung',
  reasoning: { supportedEfforts: ['high'], mandatory: true },
};

/** Its twin in every rate and cap, listing three words instead of one. */
const THREE_RUNG: PriceableModel = {
  ...RATES,
  modelId: 'vendor/three-rung',
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};

function fundingOf(spendable: bigint): FundingSnapshot {
  return {
    spendableNanoUsd: nanoUSD(spendable),
    heldNanoUsd: nanoUSD(0n),
    tier: 'paid',
    payer: 'self',
  };
}

/** Effort OPEN, so the verdict is graded on `e_min(m)` rather than on a pin. */
function autoTurn(model: PriceableModel, spendable: bigint) {
  const selection: Selection = {
    answerSources: { models: [model.modelId], smartSlot: false },
    modality: 'text',
    pinned: {},
    webSearch: false,
  };
  return getTurnOptions(fundingOf(spendable), BASIS, selection, [model]).admissible;
}

/**
 * The funding that leaves a ~3,343-token ceiling: 0.3¢ less 325,000 nano of fixed
 * costs, over an 800-nano variable rate. Chosen because it sits above the
 * minimum-answer floor and below either model's cheapest reasoning budget, which
 * is exactly the band the two verdicts used to disagree in.
 */
const NARROW_FUNDING = 3_000_000n;

describe('a mandatory-reasoning model is graded on the rung it will actually run', () => {
  it('refuses the single-rung model where its own cheapest rung does not fit', () => {
    const options = autoTurn(SINGLE_RUNG, NARROW_FUNDING);
    expect(options.sendable).toBe(false);
    expect(options.all[0]?.ceilingTokens).toBe(3343);
  });

  it('reaches the same verdict as its rate-identical three-rung twin', () => {
    expect(autoTurn(SINGLE_RUNG, NARROW_FUNDING).sendable).toBe(
      autoTurn(THREE_RUNG, NARROW_FUNDING).sendable
    );
  });

  it('names money as the reason, since the funding cannot cover the corner', () => {
    const options = autoTurn(SINGLE_RUNG, NARROW_FUNDING);
    expect(options.sendable ? undefined : options.refusal).toBe('insufficient_funds');
  });

  it('sends once the funding covers B(m, e_min(m)) + a minimum answer', () => {
    // Its one rung is High, clamped by the 64,000-token provider cap to 32,768.
    const corner = REASONING_BUDGET_TOKENS_BY_EFFORT.high + MINIMUM_OUTPUT_TOKENS;
    const options = autoTurn(SINGLE_RUNG, 28_000_000n);
    expect(options.sendable).toBe(true);
    expect(options.all[0]?.ceilingTokens).toBeGreaterThanOrEqual(corner);
  });

  it('offers that rung on the menu rather than presenting an empty axis', () => {
    const options = autoTurn(SINGLE_RUNG, 28_000_000n);
    expect(options.turnDimensions).toEqual([
      {
        dimensionId: 'effort',
        options: [{ optionId: 'high', label: 'High', availability: { available: true } }],
      },
    ]);
  });
});
