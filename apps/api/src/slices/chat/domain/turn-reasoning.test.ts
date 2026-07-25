import { describe, expect, it } from 'vitest';
import { REASONING_BUDGET_TOKENS_BY_EFFORT, nanoUSD } from '@hushbox/shared';
import { reasoningEntryFor, resolveTurnReasoning } from './turn-reasoning.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelDescriptor, ModelReasoning } from '@hushbox/shared';

function descriptorFor(id: string, reasoning?: ModelReasoning): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1_000_000 },
    pricing: { inputPerToken: nanoUSD(2n), outputPerToken: nanoUSD(3n) },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** An effort-vocabulary model accepting every canonical level (`null` tristate). */
const OPEN_EFFORT: ModelReasoning = { supportedEfforts: null };
/** An enumerated-levels model. */
const HIGH_ONLY: ModelReasoning = { supportedEfforts: ['high'] };
/** A budget-native model (no effort vocabulary — absent `supportedEfforts`). */
const BUDGET_NATIVE: ModelReasoning = {};

function resolverFor(models: Record<string, ModelDescriptor>): ModelPricingResolver {
  return (id) => models[id];
}

describe('reasoningEntryFor', () => {
  it('returns the effort wire and budget for an effort-vocabulary model', () => {
    const entry = reasoningEntryFor(descriptorFor('m', OPEN_EFFORT), 'low');
    expect(entry).toEqual({
      effort: 'low',
      wire: { effort: 'low' },
      reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.low,
    });
  });

  it('returns the max_tokens wire for a budget-native model', () => {
    const entry = reasoningEntryFor(descriptorFor('m', BUDGET_NATIVE), 'medium');
    expect(entry).toEqual({
      effort: 'medium',
      wire: { max_tokens: REASONING_BUDGET_TOKENS_BY_EFFORT.medium },
      reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.medium,
    });
  });

  it('returns undefined for a level outside the enumerated set', () => {
    expect(reasoningEntryFor(descriptorFor('m', HIGH_ONLY), 'low')).toBeUndefined();
  });

  it('returns undefined for a non-reasoning model', () => {
    expect(reasoningEntryFor(descriptorFor('m'), 'low')).toBeUndefined();
  });
});

describe('resolveTurnReasoning', () => {
  it('resolves no reasoning when the selection is absent', () => {
    const resolve = resolverFor({ m: descriptorFor('m', OPEN_EFFORT) });
    expect(resolveTurnReasoning(['m'], resolve)._unsafeUnwrap().size).toBe(0);
  });

  it("resolves 'none' to the explicit hard-off wire on a non-mandatory reasoning model", () => {
    const resolve = resolverFor({ m: descriptorFor('m', OPEN_EFFORT) });
    const entries = resolveTurnReasoning(['m'], resolve, 'none')._unsafeUnwrap();
    expect(entries.get('m')).toEqual({
      effort: 'none',
      wire: { enabled: false },
      reasoningBudgetTokens: 0,
    });
  });

  it("resolves 'none' on a non-reasoning model to no entry (nothing to turn off)", () => {
    const resolve = resolverFor({ m: descriptorFor('m') });
    expect(resolveTurnReasoning(['m'], resolve, 'none')._unsafeUnwrap().size).toBe(0);
  });

  it("refuses 'none' on a mandatory-reasoning model (never silently ignored)", () => {
    const resolve = resolverFor({
      m: descriptorFor('m', { mandatory: true, supportedEfforts: null }),
    });
    const result = resolveTurnReasoning(['m'], resolve, 'none');
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('resolves an explicit level to a per-model entry', () => {
    const resolve = resolverFor({ m: descriptorFor('m', OPEN_EFFORT) });
    const entries = resolveTurnReasoning(['m'], resolve, 'high')._unsafeUnwrap();
    expect(entries.get('m')).toEqual({
      effort: 'high',
      wire: { effort: 'high' },
      reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.high,
    });
  });

  it('refuses an explicit level on a non-reasoning model (no silent downgrade)', () => {
    const resolve = resolverFor({ m: descriptorFor('m') });
    const result = resolveTurnReasoning(['m'], resolve, 'medium');
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses an explicit level outside the enumerated set (no nearest-mapping)', () => {
    const resolve = resolverFor({ m: descriptorFor('m', HIGH_ONLY) });
    const result = resolveTurnReasoning(['m'], resolve, 'low');
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('skips an unknown model (the compile step owns the unknown-model refusal)', () => {
    const resolve = resolverFor({ a: descriptorFor('a', OPEN_EFFORT) });
    const entries = resolveTurnReasoning(['a', 'nope'], resolve, 'low')._unsafeUnwrap();
    expect(entries.size).toBe(1);
    expect(entries.get('a')?.wire).toEqual({ effort: 'low' });
  });

  it('resolves to an empty map when every model of a multi-model turn is unknown', () => {
    const resolve = resolverFor({});
    expect(resolveTurnReasoning(['x', 'y'], resolve, 'low')._unsafeUnwrap().size).toBe(0);
  });
});

describe('resolveTurnReasoning — multi-model union resolution', () => {
  it('resolves a sibling lacking the union level to hard off, not a 400 (ruled edge a)', () => {
    // `low` sits below HIGH_ONLY's whole ladder and the model can disable, so
    // it runs reasoning-off while the open sibling runs the asked level.
    const resolve = resolverFor({
      a: descriptorFor('a', OPEN_EFFORT),
      b: descriptorFor('b', HIGH_ONLY),
    });
    const entries = resolveTurnReasoning(['a', 'b'], resolve, 'low')._unsafeUnwrap();
    expect(entries.get('a')?.wire).toEqual({ effort: 'low' });
    expect(entries.get('b')).toEqual({
      effort: 'none',
      wire: { enabled: false },
      reasoningBudgetTokens: 0,
    });
  });

  it('resolves a mandatory sibling below its ladder UP to its lowest rung (ruled edge b)', () => {
    // ['hi','lo'] is upstream-descending; the ascending 2-rung ladder maps
    // low→'lo', high→'hi'. `lite` sits below it and off is impossible.
    const resolve = resolverFor({
      a: descriptorFor('a', OPEN_EFFORT),
      b: descriptorFor('b', { mandatory: true, supportedEfforts: ['hi', 'lo'] }),
    });
    const entries = resolveTurnReasoning(['a', 'b'], resolve, 'lite')._unsafeUnwrap();
    expect(entries.get('a')?.wire).toEqual({ effort: 'minimal' });
    expect(entries.get('b')?.wire).toEqual({ effort: 'lo' });
    expect(entries.get('b')?.effort).toBe('low');
  });

  it('resolves a chosen level to the nearest offered rung BELOW, never up', () => {
    // b offers [low, high]; `medium` is not offered, so b falls to low while
    // the open sibling runs medium exactly.
    const resolve = resolverFor({
      a: descriptorFor('a', OPEN_EFFORT),
      b: descriptorFor('b', { supportedEfforts: ['hi', 'lo'] }),
    });
    const entries = resolveTurnReasoning(['a', 'b'], resolve, 'medium')._unsafeUnwrap();
    expect(entries.get('a')?.wire).toEqual({ effort: 'medium' });
    expect(entries.get('b')?.wire).toEqual({ effort: 'lo' });
  });

  it('leaves a non-reasoning sibling wire-silent at a union level (no entry, no error)', () => {
    const resolve = resolverFor({
      a: descriptorFor('a', OPEN_EFFORT),
      b: descriptorFor('b'),
    });
    const entries = resolveTurnReasoning(['a', 'b'], resolve, 'medium')._unsafeUnwrap();
    expect(entries.get('a')?.wire).toEqual({ effort: 'medium' });
    expect(entries.has('b')).toBe(false);
  });

  it("resolves multi-model 'none' per model: a mandatory sibling runs its lowest rung", () => {
    const resolve = resolverFor({
      a: descriptorFor('a', OPEN_EFFORT),
      b: descriptorFor('b', { mandatory: true, supportedEfforts: ['hi', 'lo'] }),
    });
    const entries = resolveTurnReasoning(['a', 'b'], resolve, 'none')._unsafeUnwrap();
    expect(entries.get('a')?.wire).toEqual({ enabled: false });
    expect(entries.get('b')?.wire).toEqual({ effort: 'lo' });
  });

  it('refuses a choice outside the union option set with a 400', () => {
    // Both models offer only High (+ Min via disable): `low` is not in the
    // turn's choice set, so the request never came from the offered menu.
    const resolve = resolverFor({
      a: descriptorFor('a', HIGH_ONLY),
      b: descriptorFor('b', HIGH_ONLY),
    });
    const result = resolveTurnReasoning(['a', 'b'], resolve, 'low');
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a level when no selected model reasons at all (empty option set)', () => {
    const resolve = resolverFor({ a: descriptorFor('a'), b: descriptorFor('b') });
    const result = resolveTurnReasoning(['a', 'b'], resolve, 'medium');
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it("keeps multi-model 'none' a no-op when no selected model reasons", () => {
    const resolve = resolverFor({ a: descriptorFor('a'), b: descriptorFor('b') });
    expect(resolveTurnReasoning(['a', 'b'], resolve, 'none')._unsafeUnwrap().size).toBe(0);
  });
});

describe("resolveTurnReasoning — deterministic 'auto' (no static preference order)", () => {
  it("resolves 'auto' reasoning-free when the model offers two or more real choices", () => {
    // Multi-choice auto belongs to the classifier stage; a build that reaches
    // this resolution without one runs reasoning-free — never a static pick.
    const resolve = resolverFor({ m: descriptorFor('m', OPEN_EFFORT) });
    expect(resolveTurnReasoning(['m'], resolve, 'auto')._unsafeUnwrap().size).toBe(0);
  });

  it("resolves 'auto' on a non-reasoning model to no reasoning (no refusal, no entry)", () => {
    const resolve = resolverFor({ m: descriptorFor('m') });
    expect(resolveTurnReasoning(['m'], resolve, 'auto')._unsafeUnwrap().size).toBe(0);
  });

  it("picks the sole choice deterministically on a Min-only model ('auto' → hard off)", () => {
    // A disableable model with no offered rungs has exactly one real choice
    // (Min), so auto picks it with no classifier and no reserve.
    const resolve = resolverFor({ m: descriptorFor('m', { supportedEfforts: ['none'] }) });
    const entries = resolveTurnReasoning(['m'], resolve, 'auto')._unsafeUnwrap();
    expect(entries.get('m')).toEqual({
      effort: 'none',
      wire: { enabled: false },
      reasoningBudgetTokens: 0,
    });
  });

  it("resolves 'auto' to no entry when the model offers no choice (single-level mandatory)", () => {
    const resolve = resolverFor({
      m: descriptorFor('m', { mandatory: true, supportedEfforts: ['high'] }),
    });
    expect(resolveTurnReasoning(['m'], resolve, 'auto')._unsafeUnwrap().size).toBe(0);
  });

  it('applies the sole union choice per model on a multi-model turn', () => {
    // Union = {Min} (one Min-only model, one non-reasoning): the deterministic
    // pick turns the disableable sibling off and leaves the other silent.
    const resolve = resolverFor({
      a: descriptorFor('a', { supportedEfforts: ['none'] }),
      b: descriptorFor('b'),
    });
    const entries = resolveTurnReasoning(['a', 'b'], resolve, 'auto')._unsafeUnwrap();
    expect(entries.get('a')?.wire).toEqual({ enabled: false });
    expect(entries.has('b')).toBe(false);
  });

  it("resolves multi-model 'auto' reasoning-free when the union offers two or more choices", () => {
    const resolve = resolverFor({
      a: descriptorFor('a', OPEN_EFFORT),
      b: descriptorFor('b', HIGH_ONLY),
    });
    expect(resolveTurnReasoning(['a', 'b'], resolve, 'auto')._unsafeUnwrap().size).toBe(0);
  });
});
