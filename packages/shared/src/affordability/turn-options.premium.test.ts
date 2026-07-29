/**
 * Premium classification reaching the produced sets.
 *
 * A premium row is MARKED, never removed: it rides `all` with an unavailable
 * verdict and a typed reason, so a surface greys it and says why (§Model
 * Classification, §Notices & Refusals 1). The clock is an ARGUMENT: every
 * instant here is injected, so a classification is reproducible from the
 * producer's inputs and the money core still reads no clock.
 *
 * The window and guard blocks use a single-model pool deliberately: the price leg
 * needs a pool of at least `MIN_POOL_FOR_PRICE_PERCENTILE` to have a threshold at
 * all, so one model isolates the RECENCY leg from it. The last block needs the
 * opposite and says so at its own fixture — a pool large enough to have a price
 * threshold, because what it pins is that the price leg reads no clock.
 */

import { describe, expect, it } from 'vitest';

import { PREMIUM_RECENCY_MS } from './premium.js';
import { modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import { getTurnOptions } from './turn-options.js';
import type { PriceableModel } from './priceable-model.js';
import type { UserTier } from './tiers.js';
import type { FundingSnapshot, PromptBasis, Selection } from './turn-types.js';

const NOW_MS = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function modelReleasedAt(releasedAtMs: number): PriceableModel {
  return {
    modelId: modelId('vendor/only'),
    inputRateNanoUsd: nanoUSD(100n),
    outputRateNanoUsd: nanoUSD(200n),
    contextLength: 200_000,
    providerCap: 32_000,
    reasoning: undefined,
    releasedAtMs,
  };
}

const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

const SELECTION: Selection = {
  answerSources: { models: [modelId('vendor/only')], smartSlot: false },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

function fundingAt(payerTier: UserTier): FundingSnapshot {
  return {
    spendableNanoUsd: nanoUSD(1_000_000_000n),
    heldNanoUsd: nanoUSD(0n),
    payerTier,
    payer: 'self',
  };
}

function verdictFor(releasedAtMs: number, tier: UserTier) {
  const model = modelReleasedAt(releasedAtMs);
  const options = getTurnOptions(fundingAt(tier), BASIS, SELECTION, {
    models: [model],
    nowMs: NOW_MS,
  });
  const [entry] = options.admissible.all;
  if (entry === undefined) throw new Error('the selection produced no row');
  return entry.availability;
}

describe('a model released inside the premium window', () => {
  it('is refused to a payer whose tier has no premium access', () => {
    expect(verdictFor(NOW_MS - DAY_MS, 'free')).toEqual({
      available: false,
      reason: 'premium_requires_credit',
    });
  });

  it('is available to a paid payer', () => {
    expect(verdictFor(NOW_MS - DAY_MS, 'paid')).toEqual({ available: true });
  });

  it('names the account, not the credit, when the payer has no account', () => {
    expect(verdictFor(NOW_MS - DAY_MS, 'trial')).toEqual({
      available: false,
      reason: 'premium_requires_account',
    });
  });
});

describe('a model released outside the premium window', () => {
  it('is available at the same tier, driven from the same clock', () => {
    expect(verdictFor(NOW_MS - PREMIUM_RECENCY_MS - DAY_MS, 'free')).toEqual({ available: true });
  });
});

describe('the snapshot instant is validated, not trusted', () => {
  // A clock a caller got wrong changes premium classification, which is a money
  // verdict — so an unusable instant is refused where the snapshot enters the
  // module, the same posture this module already takes on `promptChars` and on an
  // empty identifier.
  //
  // The guard refuses BOTH directions of unusable, and the direction is not
  // uniform across these cases: a non-comparable instant (`NaN`, `+Infinity`)
  // makes every recency test false and fails permissive — a premium row comes back
  // available; a sub-window instant (`-Infinity`, `0`, `-1`, just under the
  // window) makes every model read as recently released and fails closed. A
  // fractional instant changes no verdict at all and is refused for being
  // unusable rather than for what it decides. Measured case by case with the guard
  // bypassed, and recorded in this task's report rather than summarised here.
  const cases: readonly (readonly [string, number])[] = [
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['negatively infinite', Number.NEGATIVE_INFINITY],
    ['fractional', NOW_MS + 0.5],
    ['zero', 0],
    ['negative', -1],
    ['before the recency window is representable', PREMIUM_RECENCY_MS - 1],
  ];

  it.each(cases)('refuses an instant that is %s', (_what, nowMs) => {
    expect(() =>
      getTurnOptions(fundingAt('free'), BASIS, SELECTION, {
        models: [modelReleasedAt(NOW_MS - DAY_MS)],
        nowMs,
      })
    ).toThrow(RangeError);
  });

  it('accepts the boundary instant, so the guard refuses only the unusable', () => {
    expect(() =>
      getTurnOptions(fundingAt('free'), BASIS, SELECTION, {
        models: [modelReleasedAt(0)],
        nowMs: PREMIUM_RECENCY_MS,
      })
    ).not.toThrow();
  });
});

describe('what a wrong-but-usable clock can reach', () => {
  // The guard bounds nonsense, not caller error: a far-future instant IS a
  // representable instant, and it makes the recency leg vacuous — which is what
  // that instant means. What matters for money is the other leg: `isPremiumModel`
  // takes no clock into its price comparison, so a row premium by price is refused
  // at whatever instant the guard admits. The two draws below are the correct
  // instant and one a thousand years out. A pool of four is the minimum that has a
  // price threshold at all.
  const pool = [10n, 20n, 30n, 900n].map((rate, index) => ({
    modelId: modelId(`vendor/m${String(index)}`),
    inputRateNanoUsd: nanoUSD(rate),
    outputRateNanoUsd: nanoUSD(rate),
    contextLength: 200_000,
    providerCap: 32_000,
    reasoning: undefined,
    releasedAtMs: 0,
  }));
  const dearest = modelId('vendor/m3');
  const selection: Selection = {
    answerSources: { models: [dearest], smartSlot: false },
    modality: 'text',
    pinned: {},
    webSearch: false,
  };

  function priceVerdictAt(nowMs: number) {
    const options = getTurnOptions(fundingAt('free'), BASIS, selection, { models: pool, nowMs });
    return options.admissible.all.find((entry) => entry.modelId === dearest)?.availability;
  }

  it('refuses a price-premium row on a correct clock', () => {
    expect(priceVerdictAt(NOW_MS)).toEqual({
      available: false,
      reason: 'premium_requires_credit',
    });
  });

  it('still refuses it a thousand years later, because the price leg reads no clock', () => {
    expect(priceVerdictAt(NOW_MS + 1000 * 365 * DAY_MS)).toEqual({
      available: false,
      reason: 'premium_requires_credit',
    });
  });
});
