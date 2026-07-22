import { describe, expect, it } from 'vitest';

import { CANONICAL_REASONING_EFFORTS } from '../reasoning-effort.js';
import {
  REASONING_BUDGET_FLOOR_TOKENS,
  REASONING_BUDGET_TOKENS_BY_EFFORT,
  ReasoningWire,
  offeredLevels,
  planReasoning,
  planReasoningOff,
  reasoningBudgetForWire,
  reasoningPlanModelFrom,
  type ReasoningPlanModel,
} from './reasoning-plan.js';
import type { CanonicalReasoningEffort } from '../reasoning-effort.js';

/**
 * Deterministic PRNG (mulberry32) so the property loops are reproducible.
 * fast-check is not a dependency of this package; a seeded generator keeps
 * the property tests dependency-free.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return (): number => {
    // Math.imul coerces to int32 internally, so unbounded integer growth of
    // `a` does not affect the sequence; Math.trunc satisfies the lint rule.
    a = Math.trunc(a) + 0x6d_2b_79_f5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Enumerated effort vocabulary, upstream DESCENDING order (strongest first). */
const EFFORT_NATIVE: ReasoningPlanModel = {
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

const BUDGET_NATIVE: ReasoningPlanModel = { reasoning: { mandatory: true } };

const OPEN_EFFORT: ReasoningPlanModel = { reasoning: { supportedEfforts: null } };

function labelsOf(model: ReasoningPlanModel): readonly CanonicalReasoningEffort[] {
  return offeredLevels(model).map((offered) => offered.label);
}

function effortWiresOf(model: ReasoningPlanModel): readonly string[] {
  return offeredLevels(model).map((offered) => {
    const { wire } = offered;
    if (!('effort' in wire)) throw new Error('expected an effort wire');
    return wire.effort;
  });
}

describe('offeredLevels ladder rules', () => {
  it('returns nothing for a model without a reasoning object', () => {
    expect(offeredLevels({})).toEqual([]);
  });

  it('returns nothing for an empty enumeration (with or without none)', () => {
    expect(offeredLevels({ reasoning: { supportedEfforts: [] } })).toEqual([]);
    expect(offeredLevels({ reasoning: { supportedEfforts: ['none'] } })).toEqual([]);
  });

  it('returns nothing for a single-level mandatory model (no choice exists)', () => {
    expect(offeredLevels({ reasoning: { mandatory: true, supportedEfforts: ['high'] } })).toEqual(
      []
    );
  });

  it('offers [High] for a single-level model whose reasoning can be turned off', () => {
    const model: ReasoningPlanModel = { reasoning: { supportedEfforts: ['xhigh'] } };
    expect(offeredLevels(model)).toEqual([{ label: 'high', wire: { effort: 'xhigh' } }]);
  });

  it('assigns the ruled label ladder per count (1→[High] … 5→[Min…Max])', () => {
    expect(labelsOf({ reasoning: { supportedEfforts: ['a'] } })).toEqual(['high']);
    expect(labelsOf({ reasoning: { supportedEfforts: ['a', 'b'] } })).toEqual(['low', 'high']);
    expect(labelsOf({ reasoning: { supportedEfforts: ['a', 'b', 'c'] } })).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(labelsOf({ reasoning: { supportedEfforts: ['a', 'b', 'c', 'd'] } })).toEqual([
      'min',
      'low',
      'medium',
      'high',
    ]);
    expect(labelsOf({ reasoning: { supportedEfforts: ['a', 'b', 'c', 'd', 'e'] } })).toEqual([
      'min',
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it('maps labels positionally against the descending upstream order', () => {
    // Upstream enumerates strongest-first; the ascending label ladder zips
    // against the reversed list, so High is always the top native level.
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low'] },
    };
    expect(offeredLevels(model)).toEqual([
      { label: 'min', wire: { effort: 'low' } },
      { label: 'low', wire: { effort: 'medium' } },
      { label: 'medium', wire: { effort: 'high' } },
      { label: 'high', wire: { effort: 'xhigh' } },
      { label: 'max', wire: { effort: 'max' } },
    ]);
  });

  it('maps the GPT-5 shape 1:1 under N=4 (minimal/low/medium/high)', () => {
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['high', 'medium', 'low', 'minimal'] },
    };
    expect(offeredLevels(model)).toEqual([
      { label: 'min', wire: { effort: 'minimal' } },
      { label: 'low', wire: { effort: 'low' } },
      { label: 'medium', wire: { effort: 'medium' } },
      { label: 'high', wire: { effort: 'high' } },
    ]);
  });

  it('excludes a native none entry from the count and mapping', () => {
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['high', 'low', 'none'] },
    };
    expect(offeredLevels(model)).toEqual([
      { label: 'low', wire: { effort: 'low' } },
      { label: 'high', wire: { effort: 'high' } },
    ]);
  });

  it('still offers a mandatory model with two or more levels (a choice exists)', () => {
    const model: ReasoningPlanModel = {
      reasoning: { mandatory: true, supportedEfforts: ['high', 'low'] },
    };
    expect(labelsOf(model)).toEqual(['low', 'high']);
  });

  it('keeps the strongest five levels when a vocabulary exceeds the ladder', () => {
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'] },
    };
    expect(effortWiresOf(model)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('offers the full ladder over upstream effort words when supportedEfforts is null', () => {
    expect(offeredLevels(OPEN_EFFORT)).toEqual([
      { label: 'min', wire: { effort: 'minimal' } },
      { label: 'low', wire: { effort: 'low' } },
      { label: 'medium', wire: { effort: 'medium' } },
      { label: 'high', wire: { effort: 'high' } },
      { label: 'max', wire: { effort: 'max' } },
    ]);
  });

  it('offers the full five-tier budget ladder for budget-native models', () => {
    expect(offeredLevels(BUDGET_NATIVE)).toEqual(
      CANONICAL_REASONING_EFFORTS.map((label) => ({
        label,
        wire: { max_tokens: REASONING_BUDGET_TOKENS_BY_EFFORT[label] },
      }))
    );
  });

  it('clamps budget-native tier wires to the catalog context length with the floor winning', () => {
    const model: ReasoningPlanModel = { reasoning: {}, contextLength: 8000 };
    expect(offeredLevels(model)).toEqual([
      { label: 'min', wire: { max_tokens: 1024 } },
      { label: 'low', wire: { max_tokens: 4096 } },
      { label: 'medium', wire: { max_tokens: 8000 } },
      { label: 'high', wire: { max_tokens: 8000 } },
      { label: 'max', wire: { max_tokens: 8000 } },
    ]);
    const tiny: ReasoningPlanModel = { reasoning: {}, contextLength: 512 };
    for (const offered of offeredLevels(tiny)) {
      expect(offered.wire).toEqual({ max_tokens: REASONING_BUDGET_FLOOR_TOKENS });
    }
  });
});

describe('offeredLevels properties (seeded)', () => {
  const CASES = 500;
  const NATIVE_POOL = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'];
  const LADDERS: readonly (readonly CanonicalReasoningEffort[])[] = [
    [],
    ['high'],
    ['low', 'high'],
    ['low', 'medium', 'high'],
    ['min', 'low', 'medium', 'high'],
    ['min', 'low', 'medium', 'high', 'max'],
  ];

  it('count-match, ladder order, and positional wire mapping hold for random vocabularies', () => {
    const rand = mulberry32(0xba_5e_ba_11);
    for (let index = 0; index < CASES; index += 1) {
      const natives = NATIVE_POOL.filter(() => rand() < 0.5).slice(0, 5);
      const model: ReasoningPlanModel = { reasoning: { supportedEfforts: natives } };
      const offered = offeredLevels(model);
      expect(offered).toHaveLength(natives.length);
      expect(offered.map((entry) => entry.label)).toEqual(LADDERS[natives.length]);
      const ascending = natives.toReversed();
      for (const [position, entry] of offered.entries()) {
        expect(entry.wire).toEqual({ effort: ascending[position] });
      }
    }
  });
});

describe('planReasoning capability gating', () => {
  it('reports not-reasoning-capable when the descriptor has no reasoning object', () => {
    expect(planReasoning({}, 'medium', 100)).toEqual({
      feasible: false,
      reason: 'not-reasoning-capable',
    });
  });

  it('reports not-reasoning-capable before evaluating headroom', () => {
    expect(planReasoning({}, 'medium', 0)).toEqual({
      feasible: false,
      reason: 'not-reasoning-capable',
    });
  });
});

describe('planReasoning positional wiring', () => {
  it('wires the positional native level for an offered label', () => {
    const result = planReasoning(EFFORT_NATIVE, 'medium', 500);
    expect(result).toMatchObject({ feasible: true, plan: { wire: { effort: 'medium' } } });
  });

  it('wires a non-canonical native word when the position lands on it', () => {
    const model: ReasoningPlanModel = { reasoning: { supportedEfforts: ['xhigh', 'high'] } };
    expect(planReasoning(model, 'high', 500)).toMatchObject({
      feasible: true,
      plan: { wire: { effort: 'xhigh' } },
    });
    expect(planReasoning(model, 'low', 500)).toMatchObject({
      feasible: true,
      plan: { wire: { effort: 'high' } },
    });
  });

  it('reports effort-not-supported for labels outside the offered ladder', () => {
    // N=3 offers low|medium|high — the ladder ends stay unoffered.
    for (const label of ['min', 'max'] as const) {
      expect(planReasoning(EFFORT_NATIVE, label, 500)).toEqual({
        feasible: false,
        reason: 'effort-not-supported',
      });
    }
  });

  it('reports effort-not-supported for every level on an empty enumeration', () => {
    const model: ReasoningPlanModel = { reasoning: { supportedEfforts: [] } };
    for (const effort of CANONICAL_REASONING_EFFORTS) {
      expect(planReasoning(model, effort, 500)).toEqual({
        feasible: false,
        reason: 'effort-not-supported',
      });
    }
  });

  it('reports effort-not-supported on a single-level mandatory model (nothing offered)', () => {
    const model: ReasoningPlanModel = {
      reasoning: { mandatory: true, supportedEfforts: ['high'] },
    };
    expect(planReasoning(model, 'high', 500)).toEqual({
      feasible: false,
      reason: 'effort-not-supported',
    });
  });

  it('accepts every canonical level and wires upstream words when supportedEfforts is null', () => {
    const expectedNative: Record<CanonicalReasoningEffort, string> = {
      min: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max',
    };
    for (const effort of CANONICAL_REASONING_EFFORTS) {
      expect(planReasoning(OPEN_EFFORT, effort, 500)).toMatchObject({
        feasible: true,
        plan: { wire: { effort: expectedNative[effort] } },
      });
    }
  });

  it('wires { max_tokens } equal to the reasoning budget when supportedEfforts is absent', () => {
    const result = planReasoning(BUDGET_NATIVE, 'low', 500);
    expect(result).toEqual({
      feasible: true,
      plan: {
        reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.low,
        answerHeadroomTokens: 500,
        maxTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.low + 500,
        wire: { max_tokens: REASONING_BUDGET_TOKENS_BY_EFFORT.low },
      },
    });
  });

  it('is indifferent to the mandatory flag when several levels are offered', () => {
    const model: ReasoningPlanModel = {
      reasoning: { mandatory: true, supportedEfforts: ['high', 'medium'] },
    };
    expect(planReasoning(model, 'high', 500)).toMatchObject({ feasible: true });
  });
});

describe('planReasoning budget clamps', () => {
  it('prices each level at its tier constant when no catalog cap applies', () => {
    for (const effort of CANONICAL_REASONING_EFFORTS) {
      const result = planReasoning(OPEN_EFFORT, effort, 100);
      expect(result).toMatchObject({
        feasible: true,
        plan: { reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT[effort] },
      });
    }
  });

  it('exposes the approved five-entry tunable tier table with Min at the floor', () => {
    expect(REASONING_BUDGET_TOKENS_BY_EFFORT).toEqual({
      min: 1024,
      low: 4096,
      medium: 12_288,
      high: 32_768,
      max: 65_536,
    });
    expect(REASONING_BUDGET_TOKENS_BY_EFFORT.min).toBe(REASONING_BUDGET_FLOOR_TOKENS);
  });

  it('clamps the budget down to a catalog context length below the tier', () => {
    const model: ReasoningPlanModel = { reasoning: {}, contextLength: 8000 };
    expect(planReasoning(model, 'high', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: 8000 },
    });
  });

  it('clamps the effort-wire budget too (the priced B, not the wire)', () => {
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: null },
      contextLength: 8000,
    };
    expect(planReasoning(model, 'high', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: 8000, wire: { effort: 'high' } },
    });
  });

  it('raises a sub-floor clamp back to the 1024 protocol floor (floor wins over cap)', () => {
    const model: ReasoningPlanModel = { reasoning: {}, contextLength: 512 };
    expect(planReasoning(model, 'low', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: REASONING_BUDGET_FLOOR_TOKENS },
    });
  });

  it('floors a fractional catalog cap to a whole-token budget', () => {
    const model: ReasoningPlanModel = { reasoning: {}, contextLength: 8000.9 };
    expect(planReasoning(model, 'high', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: 8000 },
    });
  });

  it('ignores a non-finite or non-positive catalog cap', () => {
    for (const contextLength of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const model: ReasoningPlanModel = { reasoning: {}, contextLength };
      expect(planReasoning(model, 'medium', 100)).toMatchObject({
        feasible: true,
        plan: { reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.medium },
      });
    }
  });
});

describe('planReasoning answer headroom (strictly-greater rule)', () => {
  it('reports no-answer-headroom when headroom is zero', () => {
    expect(planReasoning(EFFORT_NATIVE, 'low', 0)).toEqual({
      feasible: false,
      reason: 'no-answer-headroom',
    });
  });

  it('reports no-answer-headroom for negative, fractional, and non-finite headroom', () => {
    for (const headroom of [-3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planReasoning(EFFORT_NATIVE, 'low', headroom)).toEqual({
        feasible: false,
        reason: 'no-answer-headroom',
      });
    }
  });

  it('accepts one token of headroom and sizes maxTokens strictly above the budget', () => {
    const result = planReasoning(EFFORT_NATIVE, 'low', 1);
    expect(result).toEqual({
      feasible: true,
      plan: {
        reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.low,
        answerHeadroomTokens: 1,
        maxTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.low + 1,
        wire: { effort: 'low' },
      },
    });
  });

  it('checks vocabulary support before headroom', () => {
    const model: ReasoningPlanModel = { reasoning: { supportedEfforts: ['high'] } };
    expect(planReasoning(model, 'low', 0)).toEqual({
      feasible: false,
      reason: 'effort-not-supported',
    });
  });
});

describe('planReasoningOff (hard off)', () => {
  it('reports not-reasoning-capable when the descriptor has no reasoning object', () => {
    expect(planReasoningOff({}, 100)).toEqual({
      feasible: false,
      reason: 'not-reasoning-capable',
    });
  });

  it('reports reasoning-mandatory when reasoning cannot be disabled upstream', () => {
    expect(planReasoningOff(BUDGET_NATIVE, 100)).toEqual({
      feasible: false,
      reason: 'reasoning-mandatory',
    });
  });

  it('reports no-answer-headroom for invalid headroom', () => {
    for (const headroom of [0, -3, 2.5, Number.NaN]) {
      expect(planReasoningOff(EFFORT_NATIVE, headroom)).toEqual({
        feasible: false,
        reason: 'no-answer-headroom',
      });
    }
  });

  it('plans B=0, maxTokens=H, and the { enabled: false } wire', () => {
    expect(planReasoningOff(EFFORT_NATIVE, 700)).toEqual({
      feasible: true,
      plan: {
        reasoningBudgetTokens: 0,
        answerHeadroomTokens: 700,
        maxTokens: 700,
        wire: { enabled: false },
      },
    });
  });

  it('turns off a budget-native non-mandatory model too', () => {
    expect(planReasoningOff({ reasoning: {} }, 50)).toMatchObject({
      feasible: true,
      plan: { wire: { enabled: false } },
    });
  });
});

describe('reasoningBudgetForWire', () => {
  it('prices the off wire at zero', () => {
    expect(reasoningBudgetForWire(EFFORT_NATIVE, { enabled: false })).toBe(0);
  });

  it('takes a budget wire verbatim', () => {
    expect(reasoningBudgetForWire(BUDGET_NATIVE, { max_tokens: 2048 })).toBe(2048);
  });

  it('re-derives the clamped tier budget from the positional label of an effort wire', () => {
    const model: ReasoningPlanModel = { reasoning: { supportedEfforts: ['xhigh', 'high'] } };
    // xhigh sits at the High position, high at the Low position.
    expect(reasoningBudgetForWire(model, { effort: 'xhigh' })).toBe(
      REASONING_BUDGET_TOKENS_BY_EFFORT.high
    );
    expect(reasoningBudgetForWire(model, { effort: 'high' })).toBe(
      REASONING_BUDGET_TOKENS_BY_EFFORT.low
    );
  });

  it('clamps the re-derived budget to the catalog context length', () => {
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: null },
      contextLength: 8000,
    };
    expect(reasoningBudgetForWire(model, { effort: 'high' })).toBe(8000);
  });

  it('prices an unoffered native word at zero (fail-safe: no phantom allowance)', () => {
    expect(reasoningBudgetForWire(EFFORT_NATIVE, { effort: 'xhigh' })).toBe(0);
    expect(reasoningBudgetForWire({}, { effort: 'high' })).toBe(0);
  });

  it('agrees with every feasible plan the plan function produces', () => {
    for (const model of [EFFORT_NATIVE, BUDGET_NATIVE, OPEN_EFFORT]) {
      for (const offered of offeredLevels(model)) {
        const result = planReasoning(model, offered.label, 200);
        if (!result.feasible) throw new Error('expected feasible');
        expect(reasoningBudgetForWire(model, result.plan.wire)).toBe(
          result.plan.reasoningBudgetTokens
        );
      }
    }
  });
});

describe('ReasoningWire schema', () => {
  it('parses the effort variant for any non-empty native word', () => {
    expect(ReasoningWire.parse({ effort: 'medium' })).toEqual({ effort: 'medium' });
    expect(ReasoningWire.parse({ effort: 'xhigh' })).toEqual({ effort: 'xhigh' });
  });

  it('parses the max_tokens variant for a positive integer budget', () => {
    expect(ReasoningWire.parse({ max_tokens: 2048 })).toEqual({ max_tokens: 2048 });
  });

  it('parses the hard-off variant', () => {
    expect(ReasoningWire.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('rejects mixed shapes (the three variants are mutually exclusive)', () => {
    expect(ReasoningWire.safeParse({ effort: 'low', max_tokens: 2048 }).success).toBe(false);
    expect(ReasoningWire.safeParse({ enabled: false, effort: 'low' }).success).toBe(false);
    expect(ReasoningWire.safeParse({ enabled: false, max_tokens: 8 }).success).toBe(false);
  });

  it('rejects enabled true, empty efforts, and non-positive-integer budgets', () => {
    expect(ReasoningWire.safeParse({ enabled: true }).success).toBe(false);
    expect(ReasoningWire.safeParse({ effort: '' }).success).toBe(false);
    expect(ReasoningWire.safeParse({ max_tokens: 0 }).success).toBe(false);
    expect(ReasoningWire.safeParse({ max_tokens: 2048.5 }).success).toBe(false);
    expect(ReasoningWire.safeParse({}).success).toBe(false);
  });

  it('accepts every wire the plan functions produce', () => {
    for (const model of [EFFORT_NATIVE, BUDGET_NATIVE]) {
      const result = planReasoning(model, 'medium', 500);
      if (!result.feasible) throw new Error('expected feasible');
      expect(ReasoningWire.parse(result.plan.wire)).toEqual(result.plan.wire);
    }
    const off = planReasoningOff(EFFORT_NATIVE, 500);
    if (!off.feasible) throw new Error('expected feasible');
    expect(ReasoningWire.parse(off.plan.wire)).toEqual(off.plan.wire);
  });
});

describe('reasoningPlanModelFrom', () => {
  it('maps the descriptor limits contextLength entry onto the plan model cap', () => {
    const model = reasoningPlanModelFrom({
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 8000 },
    });
    expect(model).toEqual({ reasoning: { supportedEfforts: null }, contextLength: 8000 });
    expect(planReasoning(model, 'high', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: 8000 },
    });
  });

  it('leaves the cap absent when limits carries no contextLength entry', () => {
    const model = reasoningPlanModelFrom({ reasoning: {}, limits: { outputTokens: 4096 } });
    expect(model.contextLength).toBeUndefined();
  });

  it('passes an absent reasoning object through unchanged', () => {
    const model = reasoningPlanModelFrom({ limits: {} });
    expect(planReasoning(model, 'low', 100)).toEqual({
      feasible: false,
      reason: 'not-reasoning-capable',
    });
  });
});

describe('planReasoning properties (seeded)', () => {
  const CASES = 500;

  function randomReasoning(rand: () => number): ReasoningPlanModel['reasoning'] {
    const tristate = Math.floor(rand() * 4);
    if (tristate === 0) return { supportedEfforts: null };
    if (tristate === 1) return {};
    return {
      supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'minimal'].filter(() => rand() < 0.5),
    };
  }

  function randomModel(rand: () => number): ReasoningPlanModel {
    const reasoning = randomReasoning(rand);
    const withCap = rand() < 0.5;
    return withCap ? { reasoning, contextLength: Math.floor(rand() * 40_000) + 1 } : { reasoning };
  }

  it('every feasible plan obeys the floor, the cap formula, and strict greater-than', () => {
    const rand = mulberry32(0xc0_ff_ee);
    for (let index = 0; index < CASES; index += 1) {
      const model = randomModel(rand);
      const effort =
        CANONICAL_REASONING_EFFORTS[Math.floor(rand() * CANONICAL_REASONING_EFFORTS.length)] ??
        'low';
      const headroom = Math.floor(rand() * 4000) + 1;
      const result = planReasoning(model, effort, headroom);
      if (!result.feasible) continue;
      const { plan } = result;
      expect(Number.isInteger(plan.reasoningBudgetTokens)).toBe(true);
      expect(plan.reasoningBudgetTokens).toBeGreaterThanOrEqual(REASONING_BUDGET_FLOOR_TOKENS);
      const cap = model.contextLength;
      const expectedBudget = Math.max(
        cap === undefined
          ? REASONING_BUDGET_TOKENS_BY_EFFORT[effort]
          : Math.min(REASONING_BUDGET_TOKENS_BY_EFFORT[effort], Math.floor(cap)),
        REASONING_BUDGET_FLOOR_TOKENS
      );
      expect(plan.reasoningBudgetTokens).toBe(expectedBudget);
      expect(plan.maxTokens).toBe(plan.reasoningBudgetTokens + plan.answerHeadroomTokens);
      expect(plan.maxTokens).toBeGreaterThan(plan.reasoningBudgetTokens);
      expect(plan.answerHeadroomTokens).toBe(headroom);
    }
  });

  it('the wire discriminant always matches the supportedEfforts tristate, never mixed keys', () => {
    const rand = mulberry32(0xde_ca_fb_ad);
    for (let index = 0; index < CASES; index += 1) {
      const model = randomModel(rand);
      const effort =
        CANONICAL_REASONING_EFFORTS[Math.floor(rand() * CANONICAL_REASONING_EFFORTS.length)] ??
        'low';
      const result = planReasoning(model, effort, 200);
      if (!result.feasible) continue;
      const wire = result.plan.wire;
      expect(Object.keys(wire)).toHaveLength(1);
      if (model.reasoning?.supportedEfforts === undefined) {
        expect(wire).toEqual({ max_tokens: result.plan.reasoningBudgetTokens });
      } else {
        expect('effort' in wire).toBe(true);
      }
    }
  });

  it('feasibility on enumerated vocabularies is exactly offered-ladder membership', () => {
    const rand = mulberry32(0xba_5e_ba_11);
    for (let index = 0; index < CASES; index += 1) {
      const supportedEfforts = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'].filter(
        () => rand() < 0.5
      );
      const model: ReasoningPlanModel = { reasoning: { supportedEfforts } };
      const effort =
        CANONICAL_REASONING_EFFORTS[Math.floor(rand() * CANONICAL_REASONING_EFFORTS.length)] ??
        'low';
      const result = planReasoning(model, effort, 200);
      const offered = offeredLevels(model).some((entry) => entry.label === effort);
      expect(result.feasible).toBe(offered);
      if (!result.feasible) {
        expect(result.reason).toBe('effort-not-supported');
      }
    }
  });
});
