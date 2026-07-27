import { describe, expect, it } from 'vitest';

import { CANONICAL_REASONING_EFFORTS } from '../reasoning-effort.js';
import {
  REASONING_BUDGET_FLOOR_TOKENS,
  REASONING_BUDGET_TOKENS_BY_EFFORT,
  REASONING_OFF_WIRE,
  ReasoningWire,
  offeredLevels,
  planReasoning,
  planReasoningOff,
  reasoningBudgetForWire,
  reasoningPlanModelFrom,
  type OfferedLevel,
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

  it('offers the one rung of a single-level mandatory model, since it is priced', () => {
    // No choice exists on such a model, but a BUDGET does: the provider spends it
    // whether or not a menu shows the rung, so it has to be offerable for
    // `e_min(m)` to be a reachable corner rather than an unreachable zero.
    expect(offeredLevels({ reasoning: { mandatory: true, supportedEfforts: ['high'] } })).toEqual([
      { label: 'high', wire: { effort: 'high' } },
    ]);
  });

  it('offers [High] for a single-level model whose reasoning can be turned off', () => {
    const model: ReasoningPlanModel = { reasoning: { supportedEfforts: ['xhigh'] } };
    expect(offeredLevels(model)).toEqual([{ label: 'high', wire: { effort: 'xhigh' } }]);
  });

  it('assigns the ruled label ladder per count (1→[High] … 5→[Lite…Max])', () => {
    expect(labelsOf({ reasoning: { supportedEfforts: ['a'] } })).toEqual(['high']);
    expect(labelsOf({ reasoning: { supportedEfforts: ['a', 'b'] } })).toEqual(['low', 'high']);
    expect(labelsOf({ reasoning: { supportedEfforts: ['a', 'b', 'c'] } })).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(labelsOf({ reasoning: { supportedEfforts: ['a', 'b', 'c', 'd'] } })).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(labelsOf({ reasoning: { supportedEfforts: ['a', 'b', 'c', 'd', 'e'] } })).toEqual([
      'lite',
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it('offers all five levels when a vocabulary enumerates five', () => {
    // Upstream enumerates strongest-first; the ascending label ladder zips
    // against the reversed list, so Max is always the true top.
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low'] },
    };
    expect(offeredLevels(model)).toEqual([
      { label: 'lite', wire: { effort: 'low' } },
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
      { label: 'low', wire: { effort: 'minimal' } },
      { label: 'medium', wire: { effort: 'low' } },
      { label: 'high', wire: { effort: 'medium' } },
      { label: 'max', wire: { effort: 'high' } },
    ]);
  });

  it('maps the GPT-5+xhigh shape 1:1 under N=5 (minimal→Lite … xhigh→Max)', () => {
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'minimal'] },
    };
    expect(offeredLevels(model)).toEqual([
      { label: 'lite', wire: { effort: 'minimal' } },
      { label: 'low', wire: { effort: 'low' } },
      { label: 'medium', wire: { effort: 'medium' } },
      { label: 'high', wire: { effort: 'high' } },
      { label: 'max', wire: { effort: 'xhigh' } },
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
      { label: 'lite', wire: { effort: 'minimal' } },
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
      { label: 'lite', wire: { max_tokens: 2048 } },
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
  const NATIVE_POOL = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
  const LADDERS: readonly (readonly CanonicalReasoningEffort[])[] = [
    [],
    ['high'],
    ['low', 'high'],
    ['low', 'medium', 'high'],
    ['low', 'medium', 'high', 'max'],
    ['lite', 'low', 'medium', 'high', 'max'],
  ];

  it('count-match, ladder order, and positional wire mapping hold for random vocabularies', () => {
    const rand = mulberry32(0xba_5e_ba_11);
    for (let index = 0; index < CASES; index += 1) {
      const natives = NATIVE_POOL.filter(() => rand() < 0.5);
      const model: ReasoningPlanModel = { reasoning: { supportedEfforts: natives } };
      const offered = offeredLevels(model);
      // A native `none` entry is the off row, never an effort rung: it is
      // excluded from the count and the mapping.
      const efforts = natives.filter((native) => native !== 'none');
      const shown = efforts.slice(0, 5);
      expect(offered).toHaveLength(shown.length);
      expect(offered.map((entry) => entry.label)).toEqual(LADDERS[shown.length]);
      const ascending = shown.toReversed();
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
    for (const label of ['lite', 'max'] as const) {
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

  it('plans the one rung of a single-level mandatory model', () => {
    const model: ReasoningPlanModel = {
      reasoning: { mandatory: true, supportedEfforts: ['high'] },
    };
    expect(planReasoning(model, 'high', 500)).toEqual({
      feasible: true,
      plan: {
        reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.high,
        answerHeadroomTokens: 500,
        maxTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.high + 500,
        wire: { effort: 'high' },
      },
    });
  });

  it('still reports effort-not-supported for a level that single rung does not carry', () => {
    const model: ReasoningPlanModel = {
      reasoning: { mandatory: true, supportedEfforts: ['high'] },
    };
    expect(planReasoning(model, 'low', 500)).toEqual({
      feasible: false,
      reason: 'effort-not-supported',
    });
  });

  it('accepts every canonical level and wires upstream words when supportedEfforts is null', () => {
    // `lite` is not an upstream word — it rides the gateway's `minimal`; the
    // other four labels are themselves legal upstream effort words.
    const expectedNative: Record<CanonicalReasoningEffort, string> = {
      lite: 'minimal',
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

  it('exposes the approved five-entry tunable tier table', () => {
    expect(REASONING_BUDGET_TOKENS_BY_EFFORT).toEqual({
      lite: 2048,
      low: 4096,
      medium: 12_288,
      high: 32_768,
      max: 65_536,
    });
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
    expect(reasoningBudgetForWire(EFFORT_NATIVE, ReasoningWire.parse({ enabled: false }))).toBe(0);
  });

  it('takes a budget wire verbatim', () => {
    expect(reasoningBudgetForWire(BUDGET_NATIVE, ReasoningWire.parse({ max_tokens: 2048 }))).toBe(
      2048
    );
  });

  it('re-derives the clamped tier budget from the positional label of an effort wire', () => {
    const model: ReasoningPlanModel = { reasoning: { supportedEfforts: ['xhigh', 'high'] } };
    // xhigh sits at the High position, high at the Low position.
    expect(reasoningBudgetForWire(model, ReasoningWire.parse({ effort: 'xhigh' }))).toBe(
      REASONING_BUDGET_TOKENS_BY_EFFORT.high
    );
    expect(reasoningBudgetForWire(model, ReasoningWire.parse({ effort: 'high' }))).toBe(
      REASONING_BUDGET_TOKENS_BY_EFFORT.low
    );
  });

  it('clamps the re-derived budget to the catalog context length', () => {
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: null },
      contextLength: 8000,
    };
    expect(reasoningBudgetForWire(model, ReasoningWire.parse({ effort: 'high' }))).toBe(8000);
  });

  it('prices an unoffered native word at zero (fail-safe: no phantom allowance)', () => {
    expect(reasoningBudgetForWire(EFFORT_NATIVE, ReasoningWire.parse({ effort: 'xhigh' }))).toBe(0);
    expect(reasoningBudgetForWire({}, ReasoningWire.parse({ effort: 'high' }))).toBe(0);
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

describe('provider completion cap (maxOutputTokens) bounds the budget', () => {
  it('clamps a budget-native tier to the provider cap when it is tighter than the context', () => {
    const model: ReasoningPlanModel = {
      reasoning: {},
      contextLength: 200_000,
      maxOutputTokens: 8192,
    };
    expect(planReasoning(model, 'max', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: 8192, wire: { max_tokens: 8192 } },
    });
  });

  it('keeps the context clamp when it is tighter than the provider cap', () => {
    const model: ReasoningPlanModel = {
      reasoning: {},
      contextLength: 4000,
      maxOutputTokens: 8192,
    };
    expect(planReasoning(model, 'max', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: 4000 },
    });
  });

  it('clamps by the provider cap alone when no context length is known', () => {
    const model: ReasoningPlanModel = { reasoning: {}, maxOutputTokens: 8192 };
    expect(planReasoning(model, 'max', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: 8192 },
    });
  });

  it('clamps the effort-wire priced budget by the provider cap too', () => {
    const model: ReasoningPlanModel = {
      reasoning: { supportedEfforts: null },
      contextLength: 200_000,
      maxOutputTokens: 8192,
    };
    expect(planReasoning(model, 'high', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: 8192, wire: { effort: 'high' } },
    });
    expect(reasoningBudgetForWire(model, ReasoningWire.parse({ effort: 'high' }))).toBe(8192);
  });

  it('raises a sub-floor provider cap back to the 1024 protocol floor (floor wins over cap)', () => {
    // Mirrors the contextLength floor-wins rule: upstream raises sub-floor
    // budgets to 1024 regardless, and downstream answer-headroom sizing is
    // what refuses a level that cannot fit such a cap.
    const model: ReasoningPlanModel = { reasoning: {}, maxOutputTokens: 512 };
    expect(planReasoning(model, 'low', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: REASONING_BUDGET_FLOOR_TOKENS },
    });
  });

  it('ignores a non-finite or non-positive provider cap', () => {
    for (const maxOutputTokens of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const model: ReasoningPlanModel = { reasoning: {}, maxOutputTokens };
      expect(planReasoning(model, 'medium', 100)).toMatchObject({
        feasible: true,
        plan: { reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.medium },
      });
    }
  });

  it('maps the descriptor limits maxOutputTokens entry onto the plan model cap', () => {
    const model = reasoningPlanModelFrom({
      reasoning: {},
      limits: { contextLength: 200_000, maxOutputTokens: 8192 },
    });
    expect(model.maxOutputTokens).toBe(8192);
    expect(planReasoning(model, 'max', 100)).toMatchObject({
      feasible: true,
      plan: { reasoningBudgetTokens: 8192 },
    });
  });

  it('leaves the cap absent when limits carries no maxOutputTokens entry', () => {
    const model = reasoningPlanModelFrom({ reasoning: {}, limits: { contextLength: 200_000 } });
    expect(model.maxOutputTokens).toBeUndefined();
  });

  function expectLevelBounded(
    model: ReasoningPlanModel,
    offered: OfferedLevel,
    maxOutputTokens: number
  ): void {
    if ('max_tokens' in offered.wire) {
      expect(offered.wire.max_tokens).toBeLessThanOrEqual(maxOutputTokens);
    }
    const result = planReasoning(model, offered.label, 1);
    if (!result.feasible) return;
    expect(result.plan.reasoningBudgetTokens).toBeLessThanOrEqual(maxOutputTokens);
    expect(reasoningBudgetForWire(model, result.plan.wire)).toBeLessThanOrEqual(maxOutputTokens);
  }

  it('never plans or offers a budget above a floor-or-larger provider cap (seeded property)', () => {
    const rand = mulberry32(0x0d_dc_0d_e5);
    for (let index = 0; index < 500; index += 1) {
      const maxOutputTokens = REASONING_BUDGET_FLOOR_TOKENS + Math.floor(rand() * 100_000);
      const withContext = rand() < 0.5;
      const model: ReasoningPlanModel = {
        reasoning: rand() < 0.5 ? {} : { supportedEfforts: null },
        maxOutputTokens,
        ...(withContext ? { contextLength: Math.floor(rand() * 200_000) + 1 } : {}),
      };
      for (const offered of offeredLevels(model)) {
        expectLevelBounded(model, offered, maxOutputTokens);
      }
    }
  });
});

describe('ReasoningWire brand (G1)', () => {
  it('exports the minted hard-off wire, identical to what planReasoningOff wires', () => {
    expect(REASONING_OFF_WIRE).toEqual({ enabled: false });
    const result = planReasoningOff(EFFORT_NATIVE, 100);
    if (!result.feasible) throw new Error('expected feasible');
    expect(result.plan.wire).toEqual(REASONING_OFF_WIRE);
  });

  it('accepts schema-minted values but rejects hand-written literals at the type level', () => {
    const minted: ReasoningWire = ReasoningWire.parse({ effort: 'medium' });
    // @ts-expect-error — a hand-written wire object literal must not satisfy the
    // branded ReasoningWire type: the schema/plan functions are the only mint (G1).
    const raw: ReasoningWire = { effort: 'medium' };
    expect(raw).toEqual(minted);
  });

  it('brands every wire the plan functions and offered ladder produce', () => {
    // Type-position check: plan outputs assign to the branded type without casts.
    for (const model of [EFFORT_NATIVE, BUDGET_NATIVE, OPEN_EFFORT]) {
      for (const offered of offeredLevels(model)) {
        const wire: ReasoningWire = offered.wire;
        expect(ReasoningWire.safeParse(wire).success).toBe(true);
      }
    }
  });
});
