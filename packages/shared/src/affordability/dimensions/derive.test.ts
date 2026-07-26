import { describe, expect, it } from 'vitest';

import { nanoUSD } from '../nano-usd.js';
import { EFFORT_DIMENSION, EFFORT_OPTION_IDS } from './effort.js';
import {
  cheapestPresentedOption,
  chooseDimensionOption,
  classifierIsBought,
  deliveredCeilingTokens,
  dimensionSupportFor,
  optionDomain,
  renderDimensionSection,
  parseDimensionAnswer,
  reserveContribution,
  resolveOption,
} from './derive.js';
import { MODEL_DIMENSION } from './model.js';
import { defineDimension } from './registry.js';
import type { PriceableModel } from '../priceable-model.js';
import type { DimensionSpec, DimensionSupport } from './types.js';

function modelFor(overrides: Partial<PriceableModel> = {}): PriceableModel {
  return {
    modelId: 'vendor/model',
    inputRateNanoUsd: nanoUSD(1000n),
    outputRateNanoUsd: nanoUSD(2000n),
    contextLength: 200_000,
    providerCap: 64_000,
    reasoning: undefined,
    ...overrides,
  };
}

/** Budget-native: offers the whole five-rung ladder, and can be disabled. */
const budgetModel = modelFor({ reasoning: {} });
/** Effort-native, descending vocabulary ⇒ ascending ladder [low, medium, high]. */
const effortModel = modelFor({ reasoning: { supportedEfforts: ['high', 'medium', 'low'] } });
/** Mandatory reasoning: no off rung, so the carve-out's precondition holds. */
const mandatoryModel = modelFor({
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
});
/** Reasoning-incapable: offers nothing on this axis. */
const plainModel = modelFor();
/**
 * Budget-native with a cap under every ladder tier, so the 1024 protocol floor
 * collapses every rung to the same budget — a real plateau.
 */
const plateauModel = modelFor({ reasoning: {}, contextLength: 900, providerCap: 900 });

const ids = (support: DimensionSupport): readonly string[] =>
  support.options.map((option) => option.optionId);

describe('optionDomain', () => {
  it('reads a fixed literal domain off the declared ParamSpec', () => {
    expect(optionDomain(EFFORT_DIMENSION)).toEqual([...EFFORT_OPTION_IDS]);
  });

  it('is absent for a dimension whose domain is the catalog itself', () => {
    expect(optionDomain(MODEL_DIMENSION)).toBeUndefined();
  });
});

describe('dimensionSupportFor', () => {
  it('reads the effort options a model offers off its catalog row', () => {
    expect(ids(dimensionSupportFor(EFFORT_DIMENSION, effortModel))).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
  });

  it('grows the offered options when the catalog spec gains a value, with no registry edit', () => {
    const before = modelFor({ reasoning: { supportedEfforts: ['high', 'low'] } });
    const after = modelFor({ reasoning: { supportedEfforts: ['high', 'medium', 'low'] } });
    const spec = EFFORT_DIMENSION;
    expect(ids(dimensionSupportFor(spec, before))).toEqual(['off', 'low', 'high']);
    expect(ids(dimensionSupportFor(spec, after))).toEqual(['off', 'low', 'medium', 'high']);
    // Same registry entry object serviced both: the value came from the model.
    expect(spec).toBe(EFFORT_DIMENSION);
  });

  it('omits the off rung on a mandatory-reasoning model and marks it mandatory', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, mandatoryModel);
    expect(ids(support)).toEqual(['low', 'medium', 'high']);
    expect(support.mandatory).toBe(true);
  });

  it('offers nothing on a model that cannot reason', () => {
    expect(ids(dimensionSupportFor(EFFORT_DIMENSION, plainModel))).toEqual([]);
  });

  it('offers a model as its own single option on the model dimension', () => {
    expect(ids(dimensionSupportFor(MODEL_DIMENSION, effortModel))).toEqual(['vendor/model']);
  });

  it('refuses support that invents an option outside the declared domain', () => {
    const rogue = defineDimension({
      ...EFFORT_DIMENSION,
      support: () => ({ options: [{ optionId: 'turbo', label: 'Turbo' }], mandatory: false }),
    });
    expect(() => dimensionSupportFor(rogue, budgetModel)).toThrow(/turbo/);
  });
});

describe('reserveContribution — derived from resource and cost class', () => {
  it('is nothing for a partition dimension: it redistributes an already-priced pool', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, budgetModel);
    expect(reserveContribution(EFFORT_DIMENSION, budgetModel, support)).toEqual({ kind: 'none' });
  });

  it('is the worst option in money for an additive money dimension', () => {
    // An absolute-amount money dimension — the shape web search has: each option
    // costs a fixed number of nano-USD, so the worst one IS the hold term.
    const spec = defineDimension({
      ...EFFORT_DIMENSION,
      resource: 'money',
      costClass: 'additive',
      requirement: (_model, option) => (option === 'off' ? 0n : 7_000_000n),
    });
    const support = dimensionSupportFor(spec, effortModel);
    expect(reserveContribution(spec, effortModel, support)).toEqual({
      kind: 'money',
      nanoUsd: 7_000_000n,
    });
  });

  it('is a per-token RATE for the model dimension, kinded apart from a money amount', () => {
    const support = dimensionSupportFor(MODEL_DIMENSION, effortModel);
    // 1000n input + 2000n output per token. Not a hold term: the hold term for
    // an open model dimension is `MAX over candidates cost(m, ceiling(m))`, and
    // the ceiling is the producer's, not the registry's. A separate `kind` is
    // what makes spending this number as money unwriteable rather than merely
    // discouraged.
    expect(reserveContribution(MODEL_DIMENSION, effortModel, support)).toEqual({
      kind: 'moneyPerToken',
      nanoUsdPerToken: 3000n,
    });
  });

  it('is the worst option in tokens for an additive completion-token dimension', () => {
    const spec = defineDimension({
      ...EFFORT_DIMENSION,
      costClass: 'additive',
    });
    const support = dimensionSupportFor(spec, effortModel);
    expect(reserveContribution(spec, effortModel, support)).toEqual({
      kind: 'completionTokens',
      tokens: 32_768,
    });
  });

  it('is a ceiling multiplier for a multiplicative dimension', () => {
    const spec = defineDimension({
      ...EFFORT_DIMENSION,
      costClass: 'multiplicative',
      deliversAtHoldCeiling: false,
      requirement: (_model, option) => (option === 'off' ? 1 : 4),
    });
    const support = dimensionSupportFor(spec, budgetModel);
    expect(reserveContribution(spec, budgetModel, support)).toEqual({
      kind: 'ceilingMultiplier',
      factor: 4,
    });
  });

  it('is nothing for a free dimension — it skips affordability entirely', () => {
    const spec = defineDimension({
      ...EFFORT_DIMENSION,
      resource: 'none',
      costClass: 'free',
    });
    const support = dimensionSupportFor(spec, budgetModel);
    expect(reserveContribution(spec, budgetModel, support)).toEqual({ kind: 'none' });
  });

  it('is nothing when nothing is presented', () => {
    const spec = defineDimension({ ...EFFORT_DIMENSION, costClass: 'additive' });
    expect(reserveContribution(spec, plainModel, { options: [], mandatory: false })).toEqual({
      kind: 'none',
    });
  });
});

describe('deliveredCeilingTokens', () => {
  const multiplicative = defineDimension({
    ...EFFORT_DIMENSION,
    costClass: 'multiplicative',
    deliversAtHoldCeiling: false,
    requirement: (_model, option) => (option === 'off' ? 1 : 4),
  });

  it('delivers the whole held ceiling when the dimension declares it does', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, budgetModel);
    expect(deliveredCeilingTokens(EFFORT_DIMENSION, budgetModel, support, 40_000)).toBe(40_000);
  });

  it("delivers the worst option's share when the dimension declares it does not", () => {
    const support = dimensionSupportFor(multiplicative, budgetModel);
    expect(deliveredCeilingTokens(multiplicative, budgetModel, support, 40_000)).toBe(10_000);
  });

  it('shrinks by the worst option even though the cheapest option costs 1×', () => {
    const support = dimensionSupportFor(multiplicative, budgetModel);
    const cheapest = cheapestPresentedOption(multiplicative, budgetModel, support);
    expect(multiplicative.requirement(budgetModel, cheapest)).toBe(1);
    expect(deliveredCeilingTokens(multiplicative, budgetModel, support, 40_000)).toBeLessThan(
      40_000
    );
  });

  it('flipping the declaration to true is what changes the delivered ceiling', () => {
    const declaringDelivery = { ...multiplicative, deliversAtHoldCeiling: true };
    const support = dimensionSupportFor(multiplicative, budgetModel);
    expect(deliveredCeilingTokens(declaringDelivery, budgetModel, support, 40_000)).toBe(40_000);
  });

  it('delivers the held ceiling when nothing is presented', () => {
    expect(
      deliveredCeilingTokens(multiplicative, plainModel, { options: [], mandatory: false }, 999)
    ).toBe(999);
  });
});

describe('renderDimensionSection — derived from the description plus option labels', () => {
  const support = dimensionSupportFor(EFFORT_DIMENSION, budgetModel);
  const section = renderDimensionSection(EFFORT_DIMENSION, support);

  it('carries the declared sentence naming the axis', () => {
    expect(section).toContain(EFFORT_DIMENSION.promptDescription);
  });

  it('lists every presented option by its user-facing label', () => {
    expect(section).toContain('Min');
    expect(section).toContain('Lite');
    expect(section).toContain('Mid');
    expect(section).toContain('Max');
  });

  it('emits no option id whose label differs from it', () => {
    for (const spec of [EFFORT_DIMENSION, MODEL_DIMENSION]) {
      const rendered = renderDimensionSection(
        spec,
        dimensionSupportFor(spec, spec === EFFORT_DIMENSION ? budgetModel : effortModel)
      );
      for (const option of dimensionSupportFor(
        spec,
        spec === EFFORT_DIMENSION ? budgetModel : effortModel
      ).options) {
        expect(rendered).toContain(option.label);
        if (option.label !== option.optionId) {
          expect(rendered).not.toContain(option.optionId);
        }
      }
    }
  });

  it('labels its answer line with the dimension, so a new dimension cannot break the parser', () => {
    expect(section).toContain('effort:');
    expect(
      renderDimensionSection(MODEL_DIMENSION, dimensionSupportFor(MODEL_DIMENSION, effortModel))
    ).toContain('model:');
  });

  it('refuses to render a section for a dimension that presents nothing', () => {
    expect(() =>
      renderDimensionSection(EFFORT_DIMENSION, { options: [], mandatory: false })
    ).toThrow(RangeError);
  });
});

describe('parseDimensionAnswer — derived from the option labels', () => {
  const support = dimensionSupportFor(EFFORT_DIMENSION, budgetModel);

  it('reads its own labelled line out of a multi-dimension answer', () => {
    expect(parseDimensionAnswer(EFFORT_DIMENSION, support, 'model: vendor/x\neffort: High')).toBe(
      'high'
    );
  });

  it('reads the whole answer when the classifier answered one dimension', () => {
    expect(parseDimensionAnswer(EFFORT_DIMENSION, support, ' Mid ')).toBe('medium');
  });

  it('resolves the off rung from its label, never from its id', () => {
    expect(parseDimensionAnswer(EFFORT_DIMENSION, support, 'effort: Min')).toBe('off');
  });

  it('tolerates a case difference the way the closed-set matcher does', () => {
    expect(parseDimensionAnswer(EFFORT_DIMENSION, support, 'effort: max')).toBe('max');
  });

  it('returns nothing for an answer outside the presented set', () => {
    expect(parseDimensionAnswer(EFFORT_DIMENSION, support, 'effort: Ludicrous')).toBeUndefined();
  });

  it('returns nothing for an empty answer', () => {
    expect(parseDimensionAnswer(EFFORT_DIMENSION, support, '   ')).toBeUndefined();
  });

  it('never returns an option the model does not offer', () => {
    const narrow = dimensionSupportFor(EFFORT_DIMENSION, effortModel);
    expect(parseDimensionAnswer(EFFORT_DIMENSION, narrow, 'effort: Lite')).not.toBe('lite');
  });
});

describe('cheapestPresentedOption — the derived failure fallback', () => {
  it('is the cheapest presented option by requirement', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, budgetModel);
    expect(cheapestPresentedOption(EFFORT_DIMENSION, budgetModel, support)).toBe('off');
  });

  it('is the cheapest reachable corner on a mandatory-reasoning model, not a free zero', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, mandatoryModel);
    expect(cheapestPresentedOption(EFFORT_DIMENSION, mandatoryModel, support)).toBe('low');
  });

  it('breaks a requirement tie on the identifier, so the pick is reproducible', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, plateauModel);
    // Every rung clamps to the 1024 floor, so only the id order can decide.
    expect(cheapestPresentedOption(EFFORT_DIMENSION, plateauModel, support)).toBe('off');
    const withoutOff = {
      options: support.options.filter((option) => option.optionId !== 'off'),
      mandatory: false,
    };
    expect(cheapestPresentedOption(EFFORT_DIMENSION, plateauModel, withoutOff)).toBe('high');
  });

  it('compares a nano-USD rate requirement as a bigint', () => {
    // The presented shape of an OPEN model dimension: one option per pool
    // candidate, each carrying its own combined per-token rate. `moneyPerToken`
    // is the resource whose requirement reaches this comparison as a bigint
    // rather than as a widened token count.
    const pool = defineDimension({
      ...EFFORT_DIMENSION,
      resource: 'moneyPerToken',
      costClass: 'additive',
      requirement: (_model, option) => {
        if (option === 'low') return 900n;
        if (option === 'medium') return 5000n;
        return 12_000n;
      },
    });
    const support = dimensionSupportFor(pool, effortModel);
    // The cheapest rate is neither the first option presented ('off') nor the
    // first by id ('high'), so only the comparison itself can produce it.
    expect(cheapestPresentedOption(pool, effortModel, support)).toBe('low');
  });

  it('refuses an empty presented set rather than returning nothing', () => {
    expect(() =>
      cheapestPresentedOption(EFFORT_DIMENSION, plainModel, { options: [], mandatory: false })
    ).toThrow(RangeError);
  });
});

describe('chooseDimensionOption', () => {
  const support = dimensionSupportFor(EFFORT_DIMENSION, budgetModel);

  it('takes the classifier answer when it names a presented option', () => {
    expect(chooseDimensionOption(EFFORT_DIMENSION, budgetModel, support, 'effort: High')).toBe(
      'high'
    );
  });

  it('falls back to the declared cheapest presented option on an unparseable answer', () => {
    expect(chooseDimensionOption(EFFORT_DIMENSION, budgetModel, support, 'no idea')).toBe('off');
  });
});

describe('classifierIsBought — ≥2 distinct RESOLVED requirements', () => {
  it('is bought when the presented options carry distinct requirements', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, budgetModel);
    expect(classifierIsBought(EFFORT_DIMENSION, budgetModel, support)).toBe(true);
  });

  it('is not bought when every label clamps to the same budget', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, plateauModel);
    const withoutOff = {
      options: support.options.filter((option) => option.optionId !== 'off'),
      mandatory: false,
    };
    expect(withoutOff.options.length).toBeGreaterThan(1);
    expect(classifierIsBought(EFFORT_DIMENSION, plateauModel, withoutOff)).toBe(false);
  });

  it('is not bought for a single presented option', () => {
    const support = dimensionSupportFor(MODEL_DIMENSION, effortModel);
    expect(classifierIsBought(MODEL_DIMENSION, effortModel, support)).toBe(false);
  });

  it('is not bought when nothing is presented', () => {
    expect(
      classifierIsBought(EFFORT_DIMENSION, plainModel, { options: [], mandatory: false })
    ).toBe(false);
  });
});

describe('resolveOption — a closed rule, never a callback', () => {
  it('is the identity for an option the model offers', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, effortModel);
    expect(resolveOption(EFFORT_DIMENSION, support, 'medium')).toBe('medium');
  });

  it('falls to the nearest offered option below the request', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, effortModel);
    expect(resolveOption(EFFORT_DIMENSION, support, 'max')).toBe('high');
  });

  it('falls to the off rung when nothing else sits below and reasoning can be disabled', () => {
    const oneRung = modelFor({ reasoning: { supportedEfforts: ['high'] } });
    const support = dimensionSupportFor(EFFORT_DIMENSION, oneRung);
    expect(resolveOption(EFFORT_DIMENSION, support, 'lite')).toBe('off');
  });

  it('rises to the lowest offered option only on a mandatory dimension', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, mandatoryModel);
    expect(resolveOption(EFFORT_DIMENSION, support, 'lite')).toBe('low');
  });

  it('refuses rather than rising when the resolution rule is nearestBelow only', () => {
    const downwardOnly = defineDimension({ ...EFFORT_DIMENSION, resolution: 'nearestBelow' });
    const support = dimensionSupportFor(downwardOnly, mandatoryModel);
    expect(resolveOption(downwardOnly, support, 'lite')).toBeUndefined();
  });

  it('resolves to nothing when the model offers no option at all', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, plainModel);
    expect(resolveOption(EFFORT_DIMENSION, support, 'high')).toBeUndefined();
  });

  it('resolves to nothing for a request outside the declared domain', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, effortModel);
    expect(resolveOption(EFFORT_DIMENSION, support, 'turbo')).toBeUndefined();
  });

  it('resolves to nothing on a dimension whose domain carries no order', () => {
    const support = dimensionSupportFor(MODEL_DIMENSION, effortModel);
    expect(resolveOption(MODEL_DIMENSION, support, 'vendor/other')).toBeUndefined();
  });

  it('never moves upward except on the mandatory carve-out', () => {
    const domain = optionDomain(EFFORT_DIMENSION) ?? [];
    const models: readonly PriceableModel[] = [
      budgetModel,
      effortModel,
      mandatoryModel,
      plainModel,
      plateauModel,
      modelFor({ reasoning: { supportedEfforts: ['high'] } }),
      modelFor({ reasoning: { supportedEfforts: ['high'], mandatory: true } }),
      modelFor({ reasoning: { supportedEfforts: null } }),
    ];
    let carveOuts = 0;
    for (const model of models) {
      const support = dimensionSupportFor(EFFORT_DIMENSION, model);
      for (const requested of domain) {
        const resolved = resolveOption(EFFORT_DIMENSION, support, requested);
        if (resolved === undefined) continue;
        const moved = domain.indexOf(resolved) - domain.indexOf(requested);
        if (moved <= 0) continue;
        carveOuts += 1;
        expect(support.mandatory).toBe(true);
        expect(resolved).toBe(support.options[0]?.optionId);
      }
    }
    // The carve-out must actually fire, or the property is vacuous.
    expect(carveOuts).toBeGreaterThan(0);
  });
});

describe('the requirement contract', () => {
  it('rejects a requirement query for an option the model does not offer', () => {
    expect(() => EFFORT_DIMENSION.requirement(plainModel, 'high')).toThrow(RangeError);
    expect(() => EFFORT_DIMENSION.requirement(mandatoryModel, 'off')).toThrow(RangeError);
    expect(() => MODEL_DIMENSION.requirement(effortModel, 'vendor/other')).toThrow(RangeError);
  });

  it('rejects a wire query for an option the model does not offer', () => {
    expect(() => EFFORT_DIMENSION.wire(plainModel, 'high')).toThrow(RangeError);
    expect(() => EFFORT_DIMENSION.wire(mandatoryModel, 'off')).toThrow(RangeError);
    expect(() => MODEL_DIMENSION.wire(effortModel, 'vendor/other')).toThrow(RangeError);
  });

  it('mints the provider fragment for an offered option', () => {
    expect(EFFORT_DIMENSION.wire(budgetModel, 'off')).toEqual({ reasoning: { enabled: false } });
    expect(EFFORT_DIMENSION.wire(effortModel, 'high')).toEqual({ reasoning: { effort: 'high' } });
    expect(MODEL_DIMENSION.wire(effortModel, 'vendor/model')).toEqual({ model: 'vendor/model' });
  });

  it('reports a spec with a rogue requirement type rather than mis-pricing it', () => {
    const rogue: DimensionSpec = {
      ...MODEL_DIMENSION,
      requirement: () => 5,
    };
    const support = dimensionSupportFor(rogue, effortModel);
    expect(() => reserveContribution(rogue, effortModel, support)).toThrow(TypeError);
  });

  it('reports a money amount returned where a token count belongs', () => {
    const rogue: DimensionSpec = {
      ...EFFORT_DIMENSION,
      costClass: 'additive',
      requirement: () => 5n,
    };
    const support = dimensionSupportFor(rogue, effortModel);
    expect(() => reserveContribution(rogue, effortModel, support)).toThrow(TypeError);
  });
});
