/**
 * The re-partition invariant, executably pinned (`docs/BILLING.md` §Invariants,
 * as equations):
 *
 *     re-partition   cost(m, ceiling(m)) is identical for every presented option
 *                    of every open dimension
 *
 * It is the invariant that makes a runtime choice safe under a hold placed
 * before that choice is known: an open dimension may REDISTRIBUTE an
 * already-priced ceiling, never enlarge it. That is why the pool is priced from
 * `maxB(m)` — a constant of the model, not of the chosen option — and why effort
 * has no marginal money cost.
 *
 * A pin that cannot fail would leave the claim unguarded, so each property is
 * paired with a control: an implementation that prices from the CHOSEN option
 * instead of the model's worst, shown to disagree across options on the same
 * fixtures. If the control ever stops disagreeing the fixtures have gone
 * degenerate, and the pin below has stopped constraining anything.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.js';
import { modelId } from '../model-id.js';
import { nanoUSD } from '../nano-usd.js';
import { EFFORT_DIMENSION, EFFORT_OPTION_IDS, maxReasoningBudgetTokens } from './effort.js';
import {
  dimensionSupportFor,
  partitionCeiling,
  partitionPoolTokens,
  reserveContribution,
} from './derive.js';
import type { PriceableModel } from '../priceable-model.js';

const HELD_CEILING_TOKENS = 48_000;

function modelFor(reasoning?: PriceableModel['reasoning'], caps = 200_000): PriceableModel {
  return {
    modelId: modelId(`vendor/${JSON.stringify(reasoning ?? null)}-${String(caps)}`),
    inputRateNanoUsd: nanoUSD(1000n),
    outputRateNanoUsd: nanoUSD(2000n),
    contextLength: caps,
    providerCap: caps,
    releasedAtMs: 0,
    reasoning,
  };
}

/** Every reasoning shape the catalog produces, plus a plateau and a non-reasoner. */
const MODELS: readonly PriceableModel[] = [
  modelFor({}),
  modelFor({ supportedEfforts: null }),
  modelFor({ supportedEfforts: ['high', 'medium', 'low'] }),
  modelFor({ supportedEfforts: ['high', 'medium', 'low'], mandatory: true }),
  modelFor({ supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'minimal'] }),
  modelFor({ supportedEfforts: ['high'] }),
  modelFor({ supportedEfforts: ['high'], mandatory: true }),
  modelFor({}, 900),
  modelFor(),
];

/** Models that actually present ≥1 option — the ones the invariant binds. */
const PRESENTING = MODELS.filter(
  (model) => dimensionSupportFor(EFFORT_DIMENSION, model).options.length > 0
);

describe('the priced pool is a constant of the model', () => {
  it('binds a non-degenerate fixture set', () => {
    expect(PRESENTING.length).toBeGreaterThanOrEqual(6);
    const optionCounts = PRESENTING.map(
      (model) => dimensionSupportFor(EFFORT_DIMENSION, model).options.length
    );
    expect(Math.max(...optionCounts)).toBeGreaterThan(1);
  });

  it('is maxB(m) — the generic derivation and the effort ladder agree', () => {
    for (const model of PRESENTING) {
      expect(partitionPoolTokens(EFFORT_DIMENSION, model)).toBe(maxReasoningBudgetTokens(model));
    }
  });

  it("splits an option's share the same way however many options are presented beside it", () => {
    for (const model of PRESENTING) {
      const support = dimensionSupportFor(EFFORT_DIMENSION, model);
      for (const option of support.options) {
        // Narrowing what is PRESENTED cannot move what an option reserves: the
        // split is sized from the CHOSEN option against the priced ceiling, so
        // affordability filtering an option out of the set beside it changes
        // nothing. What varies between these two calls is the support.
        const alone = { options: [option], mandatory: support.mandatory };
        const input = { ceilingTokens: HELD_CEILING_TOKENS, chosen: option.optionId };
        expect(partitionCeiling(EFFORT_DIMENSION, model, alone, input)).toEqual(
          partitionCeiling(EFFORT_DIMENSION, model, support, input)
        );
      }
    }
  });
});

describe('re-partition — the priced ceiling is identical for every presented option', () => {
  it('holds for every model and every presented option', () => {
    for (const model of PRESENTING) {
      const support = dimensionSupportFor(EFFORT_DIMENSION, model);
      const ceilings = support.options.map(
        (option) =>
          partitionCeiling(EFFORT_DIMENSION, model, support, {
            ceilingTokens: HELD_CEILING_TOKENS,
            chosen: option.optionId,
          }).ceilingTokens
      );
      expect(new Set(ceilings)).toEqual(new Set([HELD_CEILING_TOKENS]));
    }
  });

  it('redistributes rather than enlarges: reservation plus answer is the ceiling', () => {
    for (const model of PRESENTING) {
      const support = dimensionSupportFor(EFFORT_DIMENSION, model);
      for (const option of support.options) {
        const split = partitionCeiling(EFFORT_DIMENSION, model, support, {
          ceilingTokens: HELD_CEILING_TOKENS,
          chosen: option.optionId,
        });
        expect(split.reservedTokens + split.answerTokens).toBe(HELD_CEILING_TOKENS);
        expect(split.reservedTokens).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('costs no marginal money on any presented subset', () => {
    for (const model of PRESENTING) {
      const support = dimensionSupportFor(EFFORT_DIMENSION, model);
      for (let size = 1; size <= support.options.length; size += 1) {
        const subset = { options: support.options.slice(0, size), mandatory: support.mandatory };
        expect(reserveContribution(EFFORT_DIMENSION, model, subset)).toEqual({ kind: 'none' });
      }
    }
  });

  it('prices a floor that fits the worst option plus a minimum answer', () => {
    for (const model of PRESENTING) {
      const floor = partitionPoolTokens(EFFORT_DIMENSION, model) + MINIMUM_OUTPUT_TOKENS;
      const support = dimensionSupportFor(EFFORT_DIMENSION, model);
      for (const option of support.options) {
        const reserved = EFFORT_DIMENSION.requirement(model, option.optionId);
        expect(Number(reserved) + MINIMUM_OUTPUT_TOKENS).toBeLessThanOrEqual(floor);
      }
    }
  });
});

describe('the control — pricing from the CHOSEN option instead of maxB(m)', () => {
  /** What the invariant forbids: a ceiling sized from the option in hand. */
  function ceilingFromChosen(model: PriceableModel, option: string): number {
    return HELD_CEILING_TOKENS - Number(EFFORT_DIMENSION.requirement(model, option));
  }

  it('disagrees across the presented options, so the pin above constrains something', () => {
    const disagreeing = PRESENTING.filter((model) => {
      const support = dimensionSupportFor(EFFORT_DIMENSION, model);
      const values = new Set(
        support.options.map((option) => ceilingFromChosen(model, option.optionId))
      );
      return values.size > 1;
    });
    expect(disagreeing.length).toBeGreaterThan(0);
  });

  it('a split sized from the presented WORST disagrees when the set is narrowed', () => {
    // The mistake the pin above forbids: reserving the worst PRESENTED option
    // rather than the chosen one. Shown here to produce different reservations
    // for the same chosen option under a narrowed set, so the pin has something
    // to catch.
    function reservedFromPresentedWorst(model: PriceableModel, options: readonly string[]): number {
      return Math.max(
        ...options.map((option) => Number(EFFORT_DIMENSION.requirement(model, option)))
      );
    }

    const disagreeing = PRESENTING.filter((model) => {
      const support = dimensionSupportFor(EFFORT_DIMENSION, model);
      return support.options.some(
        (option) =>
          reservedFromPresentedWorst(model, [option.optionId]) !==
          reservedFromPresentedWorst(
            model,
            support.options.map((candidate) => candidate.optionId)
          )
      );
    });
    expect(disagreeing.length).toBeGreaterThan(0);
  });

  it('is what a partition dimension would have to declare to be legal — and does not', () => {
    // Were `requirement` the ceiling's basis, `reserveContribution` would have
    // to carry it; a partition dimension deriving `none` is the statement that
    // it does not.
    const model = PRESENTING[0];
    expect(model).toBeDefined();
    if (model === undefined) return;
    const support = dimensionSupportFor(EFFORT_DIMENSION, model);
    const distinctRequirements = new Set(
      support.options.map((option) => Number(EFFORT_DIMENSION.requirement(model, option.optionId)))
    );
    expect(distinctRequirements.size).toBeGreaterThan(1);
    expect(reserveContribution(EFFORT_DIMENSION, model, support)).toEqual({ kind: 'none' });
  });
});

describe('the option domain is the ladder plus the off rung', () => {
  it('carries no second token for the reasoning-off rung', () => {
    expect(EFFORT_OPTION_IDS).toEqual(['off', 'lite', 'low', 'medium', 'high', 'max']);
  });
});
