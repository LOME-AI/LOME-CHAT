import { describe, expect, it } from 'vitest';
import { REASONING_BUDGET_TOKENS_BY_EFFORT, nanoUSD } from '@hushbox/shared';
import {
  AUTO_REASONING_EFFORT_ORDER,
  reasoningEntryFor,
  resolveTurnReasoning,
} from './turn-reasoning.js';
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

  it('refuses the whole multi-model turn when any model cannot run the level', () => {
    const resolve = resolverFor({
      a: descriptorFor('a', OPEN_EFFORT),
      b: descriptorFor('b'),
    });
    const result = resolveTurnReasoning(['a', 'b'], resolve, 'low');
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('skips an unknown model (the compile step owns the unknown-model refusal)', () => {
    const resolve = resolverFor({ a: descriptorFor('a', OPEN_EFFORT) });
    const entries = resolveTurnReasoning(['a', 'nope'], resolve, 'low')._unsafeUnwrap();
    expect(entries.size).toBe(1);
    expect(entries.get('a')?.wire).toEqual({ effort: 'low' });
  });

  it("resolves 'auto' to the medium placeholder on a reasoning model", () => {
    const resolve = resolverFor({ m: descriptorFor('m', OPEN_EFFORT) });
    const entries = resolveTurnReasoning(['m'], resolve, 'auto')._unsafeUnwrap();
    expect(entries.get('m')?.effort).toBe('medium');
  });

  it("resolves 'auto' to the next feasible level when medium is outside the set", () => {
    const resolve = resolverFor({ m: descriptorFor('m', HIGH_ONLY) });
    const entries = resolveTurnReasoning(['m'], resolve, 'auto')._unsafeUnwrap();
    expect(entries.get('m')?.effort).toBe('high');
  });

  it("resolves 'auto' on a non-reasoning model to no reasoning (no refusal, no entry)", () => {
    const resolve = resolverFor({ m: descriptorFor('m') });
    expect(resolveTurnReasoning(['m'], resolve, 'auto')._unsafeUnwrap().size).toBe(0);
  });

  it("resolves 'auto' positionally when the single native word is non-canonical", () => {
    // A lone `xhigh` normalizes to the High rung, so auto lands there and the
    // wire carries the native word.
    const resolve = resolverFor({
      m: descriptorFor('m', { supportedEfforts: ['xhigh'] }),
    });
    const entries = resolveTurnReasoning(['m'], resolve, 'auto')._unsafeUnwrap();
    expect(entries.get('m')?.effort).toBe('high');
    expect(entries.get('m')?.wire).toEqual({ effort: 'xhigh' });
  });

  it("resolves 'auto' to no entry when the model offers no choice (single-level mandatory)", () => {
    const resolve = resolverFor({
      m: descriptorFor('m', { mandatory: true, supportedEfforts: ['high'] }),
    });
    expect(resolveTurnReasoning(['m'], resolve, 'auto')._unsafeUnwrap().size).toBe(0);
  });

  it('keeps the auto placeholder order deterministic (medium first)', () => {
    expect(AUTO_REASONING_EFFORT_ORDER).toEqual(['medium', 'high', 'low']);
  });
});
