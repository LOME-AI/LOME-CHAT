/**
 * Two things the produced sets owe §Smart Model 3 and §Predicates: a high-cost
 * outlier must not tax every other candidate's ceiling, and a trial turn's
 * per-message cap must reach a row as its own typed reason rather than as a
 * money reason.
 *
 * The outlier assertions are written as INVARIANCE rather than as amounts: the
 * hold is unmoved by making an excluded candidate arbitrarily more extreme, and
 * moved by making an included one dearer. That pins membership of the `MAX`
 * domain without re-deriving the arrangement solve in the test, and it keeps the
 * catalog's identifier set — and therefore the classifier reserve the ids are
 * rendered into — byte-identical across the comparison.
 */

import { describe, expect, it } from 'vitest';

import { nanoUSD } from './nano-usd.js';
import { getTurnOptions } from './turn-options.js';
import type { NanoUSD } from './nano-usd.js';
import type { PriceableModel } from './priceable-model.js';
import type { FundingSnapshot, PromptBasis, Selection } from './turn-types.js';

/** 1,000 prompt characters exactly, so both tier ratios divide cleanly. */
const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

function modelOf(name: string, outputRate: bigint): PriceableModel {
  return {
    modelId: `vendor/${name}`,
    inputRateNanoUsd: nanoUSD(100n),
    outputRateNanoUsd: nanoUSD(outputRate),
    contextLength: 100_000,
    providerCap: 8000,
    reasoning: undefined,
  };
}

/** Four ordinary candidates plus one two orders of magnitude past the median. */
const CHEAP = modelOf('cheap', 1000n);
const MID = modelOf('mid', 2000n);
const MEDIAN = modelOf('median', 3000n);
const DEAREST = modelOf('dearest', 4000n);
const OUTLIER = modelOf('outlier', 200_000n);
const CATALOG: readonly PriceableModel[] = [CHEAP, MID, MEDIAN, DEAREST, OUTLIER];

function fundingOf(spendable: bigint, tier: FundingSnapshot['tier'] = 'paid'): FundingSnapshot {
  return {
    spendableNanoUsd: nanoUSD(spendable),
    heldNanoUsd: nanoUSD(0n),
    tier,
    payer: 'self',
  };
}

const SMART_SLOT: Selection = {
  answerSources: { models: [], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

function holdFor(
  catalog: readonly PriceableModel[],
  funding: FundingSnapshot
): NanoUSD | undefined {
  return getTurnOptions(funding, BASIS, SMART_SLOT, catalog).holdNanoUsd;
}

/** The same catalog with one model's output rate replaced. */
function withRate(
  catalog: readonly PriceableModel[],
  modelId: string,
  outputRate: bigint
): readonly PriceableModel[] {
  return catalog.map((model) =>
    model.modelId === modelId ? { ...model, outputRateNanoUsd: nanoUSD(outputRate) } : model
  );
}

describe('a high-cost outlier is not in the hold`s MAX domain', () => {
  const rich = fundingOf(100_000_000_000n);

  it('leaves the hold unmoved when the excluded candidate becomes ten times more extreme', () => {
    expect(holdFor(withRate(CATALOG, OUTLIER.modelId, 2_000_000n), rich)).toBe(
      holdFor(CATALOG, rich)
    );
  });

  it('moves the hold when an INCLUDED candidate becomes dearer, so the pin above is not vacuous', () => {
    expect(holdFor(withRate(CATALOG, DEAREST.modelId, 5000n), rich)).not.toBe(
      holdFor(CATALOG, rich)
    );
  });

  it('reaches the same exclusion at a balance three orders of magnitude smaller', () => {
    // Every surviving candidate is cap-bound at both balances, so an identical
    // hold means the same candidate set was maximised over at both — the
    // exclusion moved with neither the balance nor the outlier's own rate.
    const poor = fundingOf(100_000_000n);
    expect(holdFor(CATALOG, poor)).toBe(holdFor(CATALOG, rich));
    expect(holdFor(withRate(CATALOG, OUTLIER.modelId, 2_000_000n), poor)).toBe(
      holdFor(CATALOG, poor)
    );
  });

  it('keeps the excluded model on the picker, marked available', () => {
    const options = getTurnOptions(rich, BASIS, SMART_SLOT, CATALOG);
    const row = options.admissible.all.find((entry) => entry.modelId === OUTLIER.modelId);
    expect(row?.availability).toEqual({ available: true });
  });

  it('keeps the excluded model out of `runnable`, so the hold`s domain and the witness agree', () => {
    const options = getTurnOptions(rich, BASIS, SMART_SLOT, CATALOG);
    expect(options.admissible.sendable).toBe(true);
    const runnableIds = options.admissible.sendable
      ? options.admissible.runnable.map((entry) => entry.modelId)
      : [];
    expect(runnableIds).not.toContain(OUTLIER.modelId);
    expect(runnableIds).toContain(DEAREST.modelId);
  });

  it('never withholds a PINNED model, however extreme its cost', () => {
    const explicit: Selection = {
      ...SMART_SLOT,
      answerSources: { models: [OUTLIER.modelId], smartSlot: false },
    };
    const options = getTurnOptions(rich, BASIS, explicit, CATALOG);
    const runnableIds = options.admissible.sendable
      ? options.admissible.runnable.map((entry) => entry.modelId)
      : [];
    expect(runnableIds).toContain(OUTLIER.modelId);
  });

  it('keeps the excluded model explicitly selectable', () => {
    const explicit: Selection = {
      ...SMART_SLOT,
      answerSources: { models: [OUTLIER.modelId], smartSlot: false },
    };
    expect(getTurnOptions(rich, BASIS, explicit, CATALOG).admissible.sendable).toBe(true);
  });

  it('excludes nothing from a tight distribution', () => {
    const tight = CATALOG.filter((model) => model.modelId !== OUTLIER.modelId);
    expect(holdFor(withRate(tight, DEAREST.modelId, 5000n), rich)).not.toBe(holdFor(tight, rich));
  });
});

describe('a trial row over the per-message cap carries its own reason', () => {
  const trialFunding = fundingOf(100_000_000n, 'trial');
  /** 500 input tokens × 1,000 + 2,000 output × 5,000 = 10.5m nano, past the 1¢ cap. */
  const OVER_CAP: PriceableModel = {
    ...modelOf('over-cap', 5000n),
    inputRateNanoUsd: nanoUSD(1000n),
  };
  /** The same shape at a fifth of the output rate: 4.5m nano, inside the cap. */
  const UNDER_CAP: PriceableModel = { ...OVER_CAP, modelId: 'vendor/under-cap' };

  function rowReason(model: PriceableModel, catalog: readonly PriceableModel[]) {
    const selection: Selection = {
      ...SMART_SLOT,
      answerSources: { models: [model.modelId], smartSlot: false },
    };
    const options = getTurnOptions(trialFunding, BASIS, selection, catalog);
    return options.admissible.all.find((entry) => entry.modelId === model.modelId)?.availability;
  }

  it('marks the model the cap refuses, rather than calling it a money problem', () => {
    expect(rowReason(OVER_CAP, [OVER_CAP])).toEqual({
      available: false,
      reason: 'trial_message_cap_exceeded',
    });
  });

  it('leaves a model inside the cap alone', () => {
    const cheapTrial = { ...UNDER_CAP, outputRateNanoUsd: nanoUSD(1000n) };
    expect(rowReason(cheapTrial, [cheapTrial])).toEqual({ available: true });
  });

  it('does not apply the trial cap to a paid payer', () => {
    const selection: Selection = {
      ...SMART_SLOT,
      answerSources: { models: [OVER_CAP.modelId], smartSlot: false },
    };
    const options = getTurnOptions(fundingOf(100_000_000n), BASIS, selection, [OVER_CAP]);
    expect(options.admissible.all[0]?.availability).toEqual({ available: true });
  });
});
