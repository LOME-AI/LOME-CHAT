/**
 * `presented ⟺ feasible` — every option presented is feasible, and every
 * feasible option is presented — over the `admissible` set (`docs/BILLING.md`
 * §Invariants, as equations; scoped by §Affordability §The four notions).
 *
 * The fixture is deliberately non-degenerate, because one model with one option
 * satisfies the words while proving nothing. What it carries, and why:
 *
 * - **five models**, so a turn has siblings and candidates rather than one row;
 * - **both registered dimensions**, model (open through the smart slot) and
 *   effort (open or pinned);
 * - **a mandatory-reasoning model**, whose cheapest corner is not free, so
 *   eligibility graded on an unreachable zero would be visible here;
 * - **a plateau-collapsed pair**, two rungs clamping to the same budget, so a
 *   presented set counted by label rather than by resolved requirement diverges.
 *
 * Each of those four properties is asserted before the invariant is, so the
 * fixture cannot decay into a degenerate one unnoticed.
 */

import { describe, expect, it } from 'vitest';

import { intBetween, mulberry32 } from '../__tests__/seeded-prng.js';
import { MINIMUM_OUTPUT_TOKENS } from './constants.js';
import { DIMENSION_IDS } from './dimensions/index.js';
import { dimensionSupportFor } from './dimensions/derive.js';
import { EFFORT_DIMENSION } from './dimensions/effort.js';
import { modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import { reasoningBudgetTokens } from './turn-arithmetic.js';
import { getTurnOptions } from './turn-options.js';
import type { PriceableModel } from './priceable-model.js';
import type { CandidateModelEntry, PromptBasis, Selection } from './turn-types.js';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = 1_800_000_000_000;

interface ModelShape {
  readonly modelId: string;
  readonly inputRate: bigint;
  readonly outputRate: bigint;
  readonly contextLength: number;
  readonly providerCap: number;
  readonly reasoning?: PriceableModel['reasoning'];
}

function modelOf(shape: ModelShape): PriceableModel {
  return {
    modelId: modelId(shape.modelId),
    inputRateNanoUsd: nanoUSD(shape.inputRate),
    outputRateNanoUsd: nanoUSD(shape.outputRate),
    contextLength: shape.contextLength,
    providerCap: shape.providerCap,
    releasedAtMs: 0,
    reasoning: shape.reasoning,
  };
}

const LADDER = modelOf({
  modelId: modelId('vendor/ladder'),
  inputRate: 80n,
  outputRate: 200n,
  contextLength: 200_000,
  providerCap: 64_000,
  reasoning: {
    supportedEfforts: ['high', 'medium', 'low'],
  },
});
const BUDGET_NATIVE = modelOf({
  modelId: modelId('vendor/budget-native'),
  inputRate: 500n,
  outputRate: 1500n,
  contextLength: 128_000,
  providerCap: 32_000,
  reasoning: {},
});
const MANDATORY = modelOf({
  modelId: modelId('vendor/mandatory'),
  inputRate: 2000n,
  outputRate: 6000n,
  contextLength: 40_000,
  providerCap: 20_000,
  reasoning: {
    supportedEfforts: ['high', 'medium', 'low'],
    mandatory: true,
  },
});
/** providerCap 1,200 clamps every rung to 1,200 — the plateau. */
const PLATEAU = modelOf({
  modelId: modelId('vendor/plateau'),
  inputRate: 300n,
  outputRate: 700n,
  contextLength: 6000,
  providerCap: 1200,
  reasoning: {
    supportedEfforts: ['high', 'medium', 'low'],
  },
});
const PLAIN = modelOf({
  modelId: modelId('vendor/plain'),
  inputRate: 700n,
  outputRate: 1400n,
  contextLength: 100_000,
  providerCap: 8000,
});

const CATALOG: readonly PriceableModel[] = [LADDER, BUDGET_NATIVE, MANDATORY, PLATEAU, PLAIN];

const BASIS: PromptBasis = {
  systemChars: 800,
  instructionChars: 120,
  historyChars: 3000,
  inputChars: 200,
  attachmentBytes: 0,
};

const SMART_SELECTION: Selection = {
  answerSources: { models: [modelId('vendor/ladder')], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

/**
 * The same turn with nothing pinned, so the ladder model is a CANDIDATE and
 * carries the per-option list this invariant is about. Its arrangement is the
 * ladder alone either way — the pinned-alone and candidate-alone arrangements have
 * the same membership — so the rungs it prices are the ones a pinned row would
 * have had.
 */
const LADDER_AS_CANDIDATE: Selection = {
  ...SMART_SELECTION,
  answerSources: { models: [], smartSlot: true },
};

describe('the fixture is non-degenerate', () => {
  it('carries five models', () => {
    expect(CATALOG).toHaveLength(5);
  });

  it('exercises both registered dimensions — model through the smart slot, effort in the menus', () => {
    expect([...DIMENSION_IDS].toSorted((left, right) => left.localeCompare(right))).toEqual([
      'effort',
      'model',
    ]);
    expect(SMART_SELECTION.answerSources.smartSlot).toBe(true);
    const options = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(200_000_000n),
        heldNanoUsd: nanoUSD(0n),
        tier: 'paid',
        payer: 'self',
      },
      BASIS,
      SMART_SELECTION,
      { models: CATALOG, nowMs: NOW_MS }
    );
    const turnDimensions = options.admissible.sendable ? options.admissible.turnDimensions : [];
    expect(turnDimensions.map((dimension) => dimension.dimensionId)).toEqual(['effort']);
    const entries = options.admissible.sendable ? options.admissible.all : [];
    expect(entries.length).toBeGreaterThan(1);
  });

  it('carries a mandatory-reasoning model whose cheapest rung is not free', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, MANDATORY);
    expect(support.mandatory).toBe(true);
    expect(support.options.map((option) => option.optionId)).not.toContain('off');
    expect(reasoningBudgetTokens(MANDATORY, 'low')).toBeGreaterThan(0);
  });

  it('carries a plateau-collapsed pair — two rungs clamping to one budget', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, PLATEAU);
    const rungs = support.options.filter((option) => option.optionId !== 'off');
    const budgets = rungs.map((option) => reasoningBudgetTokens(PLATEAU, option.optionId));
    expect(rungs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(budgets).size).toBeLessThan(budgets.length);
  });
});

/**
 * Assert the biconditional on one entry, and report how many options landed on
 * each side of it so the caller can prove both sides were exercised.
 */
function checkEntry(entry: CandidateModelEntry): {
  readonly presented: number;
  readonly greyed: number;
} {
  const model = CATALOG.find((candidate) => candidate.modelId === entry.modelId);
  expect(model).toBeDefined();
  if (model === undefined) return { presented: 0, greyed: 0 };
  const options = entry.dimensions.flatMap((dimension) => dimension.options);
  let presented = 0;
  let greyed = 0;
  for (const option of options) {
    const wouldFit =
      reasoningBudgetTokens(model, option.optionId) + MINIMUM_OUTPUT_TOKENS <= entry.ceilingTokens;
    // A model the turn cannot run at all greys every one of its options, so
    // feasibility is only the whole story on an available entry.
    const expected = entry.availability.available && wouldFit;
    expect(option.availability.available).toBe(expected);
    if (expected) presented += 1;
    else greyed += 1;
  }
  return { presented, greyed };
}

describe('presented is exactly feasible, over the admissible set', () => {
  it('agrees on every model x option assignment across a balance sweep', () => {
    const rng = mulberry32(0x0a_0b_0c_0d);
    let presentedCount = 0;
    let greyedCount = 0;
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const spendable = BigInt(intBetween(rng, 1, 500)) * 1_000_000n;
      const options = getTurnOptions(
        {
          spendableNanoUsd: nanoUSD(spendable),
          heldNanoUsd: nanoUSD(0n),
          tier: 'paid',
          payer: 'self',
        },
        BASIS,
        SMART_SELECTION,
        { models: CATALOG, nowMs: NOW_MS }
      );
      if (!options.admissible.sendable) continue;
      for (const entry of options.admissible.all) {
        // `presented ⟺ feasible` is scoped to the decision-bearing rows. A pinned
        // row publishes no option list at all, so there is nothing to check on it.
        if (entry.kind !== 'candidate') continue;
        const counted = checkEntry(entry);
        presentedCount += counted.presented;
        greyedCount += counted.greyed;
      }
    }
    // Both directions of the biconditional have to occur, or the equality above
    // is only being checked on one side of it.
    expect(presentedCount).toBeGreaterThan(0);
    expect(greyedCount).toBeGreaterThan(0);
  });

  it('greys the rungs a shrinking ceiling can no longer fit, from the top down', () => {
    const rich = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(500_000_000n),
        heldNanoUsd: nanoUSD(0n),
        tier: 'paid',
        payer: 'self',
      },
      BASIS,
      LADDER_AS_CANDIDATE,
      { models: CATALOG, nowMs: NOW_MS }
    );
    const poor = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(6_000_000n),
        heldNanoUsd: nanoUSD(0n),
        tier: 'paid',
        payer: 'self',
      },
      BASIS,
      LADDER_AS_CANDIDATE,
      { models: CATALOG, nowMs: NOW_MS }
    );
    const rungsOf = (
      set: typeof rich.admissible
    ): readonly { readonly optionId: string; readonly available: boolean }[] => {
      const entry = set.sendable
        ? set.all.find((candidate) => candidate.modelId === 'vendor/ladder')
        : undefined;
      const dimensions = entry?.kind === 'candidate' ? entry.dimensions : [];
      return (dimensions[0]?.options ?? []).map((option) => ({
        optionId: option.optionId,
        available: option.availability.available,
      }));
    };
    expect(rungsOf(rich.admissible).every((rung) => rung.available)).toBe(true);
    const poorRungs = rungsOf(poor.admissible);
    expect(poorRungs.some((rung) => !rung.available)).toBe(true);
    // The feasible set of an ordered dimension is a downward-closed prefix, so
    // an available rung never sits above an unavailable one.
    const firstUnavailable = poorRungs.findIndex((rung) => !rung.available);
    expect(poorRungs.slice(firstUnavailable).every((rung) => !rung.available)).toBe(true);
  });
});
