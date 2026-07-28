/**
 * The re-partition invariant, closed end to end against a PRODUCED ceiling:
 *
 *     re-partition   cost(m, ceiling(m)) is identical for every presented option
 *                    of every open dimension
 *
 * The dimension registry's own suite pins that the partition pool is `maxB(m)`
 * and that a split leaves the ceiling untouched, but its ceiling was a test
 * constant, so nothing there connected the invariant to the number the producer
 * actually prices. These pins use `getTurnOptions`' own output, which is the
 * ceiling a hold is taken against.
 *
 * Three facts make the invariant true end to end, and each is asserted:
 *
 * 1. the produced ceiling does not move with the chosen effort option;
 * 2. neither does the produced hold — effort carries no marginal money cost;
 * 3. the pool a chosen option draws from is `maxB(m)`, a constant of the model,
 *    and it fits inside the produced ceiling whenever the top rung is presented.
 *
 * A control shows what a ceiling priced from the chosen option would do on the
 * same fixtures, so the pins constrain something.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from './constants.js';
import { dimensionSupportFor, partitionCeiling, partitionPoolTokens } from './dimensions/derive.js';
import { EFFORT_DIMENSION, maxReasoningBudgetTokens } from './dimensions/effort.js';
import { modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import { getTurnOptions } from './turn-options.js';
import type { OptionId } from './dimensions/index.js';
import type { PriceableModel } from './priceable-model.js';
import type { FundingSnapshot, ModelEntry, PromptBasis, Selection } from './turn-types.js';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = 1_800_000_000_000;

const LADDER: PriceableModel = {
  modelId: modelId('vendor/ladder'),
  inputRateNanoUsd: nanoUSD(80n),
  outputRateNanoUsd: nanoUSD(200n),
  contextLength: 200_000,
  providerCap: 100_000,
  releasedAtMs: 0,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

const FUNDING: FundingSnapshot = {
  spendableNanoUsd: nanoUSD(120_000_000n),
  heldNanoUsd: nanoUSD(0n),
  tier: 'paid',
  payer: 'self',
};

const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 2000,
  inputChars: 200,
  attachmentBytes: 0,
};

function selectionPinnedTo(option: OptionId): Selection {
  return {
    answerSources: { models: [modelId('vendor/ladder')], smartSlot: false },
    modality: 'text',
    pinned: { effort: option },
    webSearch: false,
  };
}

function entryFor(option: OptionId): { entry: ModelEntry; holdNanoUsd: bigint | undefined } {
  const options = getTurnOptions(FUNDING, BASIS, selectionPinnedTo(option), {
    models: [LADDER],
    nowMs: NOW_MS,
  });
  const entry = options.admissible.sendable
    ? options.admissible.all.find((candidate) => candidate.modelId === 'vendor/ladder')
    : undefined;
  expect(entry).toBeDefined();
  return {
    // Narrowed by the assertion above; the fallback only satisfies the compiler.
    // The selection pins the model, so the row it looks up is a pinned one.
    entry: entry ?? {
      kind: 'pinned',
      modelId: modelId(''),
      availability: { available: true },
      ceilingTokens: 0,
    },
    holdNanoUsd: options.holdNanoUsd,
  };
}

const PRESENTED_OPTIONS = dimensionSupportFor(EFFORT_DIMENSION, LADDER).options.map(
  (option) => option.optionId
);

describe('the produced ceiling is option-invariant', () => {
  it('binds a fixture presenting more than one option with distinct budgets', () => {
    expect(PRESENTED_OPTIONS.length).toBeGreaterThan(2);
    const budgets = new Set(
      PRESENTED_OPTIONS.map((option) => Number(EFFORT_DIMENSION.requirement(LADDER, option)))
    );
    expect(budgets.size).toBeGreaterThan(1);
  });

  it('prices the same ceiling whichever rung the user pins', () => {
    const ceilings = new Set(
      PRESENTED_OPTIONS.map((option) => entryFor(option).entry.ceilingTokens)
    );
    expect(ceilings.size).toBe(1);
  });

  it('places the same hold whichever rung the user pins', () => {
    const holds = new Set(PRESENTED_OPTIONS.map((option) => entryFor(option).holdNanoUsd));
    expect(holds.size).toBe(1);
  });
});

describe('the pool a chosen option draws from is maxB(m)', () => {
  it('matches the effort ladder`s own worst budget', () => {
    expect(partitionPoolTokens(EFFORT_DIMENSION, LADDER)).toBe(maxReasoningBudgetTokens(LADDER));
  });

  it('fits inside the produced ceiling, with a minimum answer beside it', () => {
    const { entry } = entryFor('low');
    expect(
      partitionPoolTokens(EFFORT_DIMENSION, LADDER) + MINIMUM_OUTPUT_TOKENS
    ).toBeLessThanOrEqual(entry.ceilingTokens);
  });

  it('redistributes the produced ceiling rather than enlarging it', () => {
    const { entry } = entryFor('low');
    const support = dimensionSupportFor(EFFORT_DIMENSION, LADDER);
    for (const option of PRESENTED_OPTIONS) {
      const split = partitionCeiling(EFFORT_DIMENSION, LADDER, support, {
        ceilingTokens: entry.ceilingTokens,
        chosen: option,
      });
      expect(split.ceilingTokens).toBe(entry.ceilingTokens);
      expect(split.reservedTokens + split.answerTokens).toBe(entry.ceilingTokens);
      expect(split.reservedTokens).toBeLessThanOrEqual(
        partitionPoolTokens(EFFORT_DIMENSION, LADDER)
      );
    }
  });
});

describe('the control — a ceiling priced from the chosen option', () => {
  it('would move between rungs on this very fixture, so the pins above constrain something', () => {
    const { entry } = entryFor('low');
    const fromChosen = new Set(
      PRESENTED_OPTIONS.map(
        (option) => entry.ceilingTokens - Number(EFFORT_DIMENSION.requirement(LADDER, option))
      )
    );
    expect(fromChosen.size).toBeGreaterThan(1);
  });
});
