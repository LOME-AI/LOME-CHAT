import { describe, expect, it } from 'vitest';

import {
  cheapestClassifierEffort,
  parseClassifierAnswer,
  pickClassifiedEffortPlan,
  resolveClassifiedEffort,
} from './effort-dimension.js';
import { EFFORT_OPTION_IDS, effortDomainOptions } from '../dimensions/effort.js';
import { REASONING_OFF } from '../reasoning-effort.js';
import {
  offeredLevels,
  reasoningBudgetForWire,
  REASONING_BUDGET_FLOOR_TOKENS,
  REASONING_BUDGET_TOKENS_BY_EFFORT,
} from '../estimate/reasoning-plan.js';
import type {
  ReasoningPlan,
  ReasoningPlanModel,
  ReasoningWire,
} from '../estimate/reasoning-plan.js';

describe('resolveClassifiedEffort', () => {
  it('resolves an exact user-facing label to its option id', () => {
    expect(resolveClassifiedEffort('Mid')).toBe('medium');
  });

  it('resolves case-insensitively with surrounding whitespace', () => {
    expect(resolveClassifiedEffort('  high \n')).toBe('high');
  });

  it('resolves the labels the registry adds beyond the old triple', () => {
    expect(resolveClassifiedEffort('Min')).toBe(REASONING_OFF);
    expect(resolveClassifiedEffort('Lite')).toBe('lite');
    expect(resolveClassifiedEffort('Max')).toBe('max');
  });

  it('resolves a label out of the dimension`s own answer line', () => {
    expect(resolveClassifiedEffort('effort: Low')).toBe('low');
  });

  it('returns null for an unresolvable output', () => {
    expect(resolveClassifiedEffort('turbo')).toBeNull();
  });

  it('returns null for an empty output', () => {
    expect(resolveClassifiedEffort('')).toBeNull();
  });
});

describe('cheapestClassifierEffort', () => {
  it('is the first option of the axis, so the rule moves if the axis reorders', () => {
    expect(cheapestClassifierEffort()).toBe(effortDomainOptions()[0]?.optionId);
  });

  it('is the cheapest option, not a mid rung', () => {
    // The discriminating half: a named mid-rung fallback — the constant this
    // replaced — would satisfy nothing above and fails here.
    const domain = effortDomainOptions().map((option) => option.optionId);
    expect(domain.indexOf(cheapestClassifierEffort())).toBe(0);
    expect(cheapestClassifierEffort()).not.toBe('medium');
  });
});

describe('parseClassifierAnswer', () => {
  it('model-only: the whole answer is the model text', () => {
    const parts = parseClassifierAnswer('openai/gpt-5-nano', { model: true, effort: false });
    expect(parts).toEqual({ modelText: 'openai/gpt-5-nano', effortText: '' });
  });

  it('effort-only: the whole answer is the effort text', () => {
    const parts = parseClassifierAnswer('high', { model: false, effort: true });
    expect(parts).toEqual({ modelText: '', effortText: 'high' });
  });

  it('single dimension: a labelled line still wins over the raw answer', () => {
    expect(parseClassifierAnswer('effort: Mid', { model: false, effort: true })).toEqual({
      modelText: '',
      effortText: 'Mid',
    });
    expect(parseClassifierAnswer('model: a/b', { model: true, effort: false })).toEqual({
      modelText: 'a/b',
      effortText: '',
    });
  });

  it('both dimensions: each takes its own labelled line', () => {
    const parts = parseClassifierAnswer('model: openai/gpt-5-nano\neffort: Mid', {
      model: true,
      effort: true,
    });
    expect(parts).toEqual({ modelText: 'openai/gpt-5-nano', effortText: 'Mid' });
  });

  it('both dimensions: the labels carry the pairing, so line order does not', () => {
    const parts = parseClassifierAnswer('effort: Low\nmodel: openai/gpt-5-nano', {
      model: true,
      effort: true,
    });
    expect(parts).toEqual({ modelText: 'openai/gpt-5-nano', effortText: 'Low' });
  });

  it('both dimensions: tolerates blank lines and surrounding whitespace', () => {
    const parts = parseClassifierAnswer('\n  model:  openai/gpt-5-nano  \n\n  effort: Low  \n', {
      model: true,
      effort: true,
    });
    expect(parts).toEqual({ modelText: 'openai/gpt-5-nano', effortText: 'Low' });
  });

  it('both dimensions with a missing effort line: the effort text is empty (falls back downstream)', () => {
    const parts = parseClassifierAnswer('model: openai/gpt-5-nano', { model: true, effort: true });
    expect(parts).toEqual({ modelText: 'openai/gpt-5-nano', effortText: '' });
  });

  it('both dimensions with an unlabelled answer: neither dimension claims it', () => {
    // No labelled line means neither dimension can tell which text is its own,
    // so both fall back rather than guessing from position.
    expect(parseClassifierAnswer('openai/gpt-5-nano\nMid', { model: true, effort: true })).toEqual({
      modelText: '',
      effortText: '',
    });
  });

  it('both dimensions with an empty answer: both texts are empty', () => {
    expect(parseClassifierAnswer('', { model: true, effort: true })).toEqual({
      modelText: '',
      effortText: '',
    });
  });
});

const EFFORT_NATIVE: ReasoningPlanModel = {
  reasoning: { supportedEfforts: null },
  contextLength: 200_000,
};

const BUDGET_NATIVE: ReasoningPlanModel = {
  reasoning: {},
  contextLength: 200_000,
};

describe('pickClassifiedEffortPlan', () => {
  it('returns the classified level verbatim when the model offers it, capped to the given completion cap', () => {
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.medium + 5000;
    const plan = pickClassifiedEffortPlan(EFFORT_NATIVE, 'medium', cap);
    expect(plan).toBeDefined();
    expect(plan?.wire).toEqual({ effort: 'medium' });
    expect(plan?.maxTokens).toBe(cap);
    expect(plan?.reasoningBudgetTokens).toBe(REASONING_BUDGET_TOKENS_BY_EFFORT.medium);
  });

  it('wires a token budget on a budget-native model', () => {
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high + 2000;
    const plan = pickClassifiedEffortPlan(BUDGET_NATIVE, 'high', cap);
    expect(plan?.wire).toEqual({ max_tokens: REASONING_BUDGET_TOKENS_BY_EFFORT.high });
    expect(plan?.maxTokens).toBe(cap);
  });

  it('never rises to a rung above the classified level when the model can disable reasoning', () => {
    // A single enumerated effort word offers only the High rung, which sits
    // ABOVE the classified Low. Resolution is downward-only, so the walk passes
    // High by and lands on the off rung.
    const single: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['ultra'] },
      contextLength: 200_000,
    };
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high + 2000;
    const plan = pickClassifiedEffortPlan(single, 'low', cap);
    expect(plan?.wire).toEqual({ enabled: false });
    expect(plan?.maxTokens).toBe(cap);
  });

  it('takes the nearest rung BELOW the classified level, never the nearer rung above', () => {
    const two: ReasoningPlanModel = {
      // Upstream order is descending: strongest first.
      reasoning: { supportedEfforts: ['strong', 'weak'] },
      contextLength: 200_000,
    };
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high + 2000;
    const plan = pickClassifiedEffortPlan(two, 'medium', cap);
    // The N=2 ladder is [low, high]. Low sits below Mid and High above it, so
    // the downward rule picks Low — the same answer a nearest-distance rule
    // would have given here only because the tie broke low.
    expect(plan?.wire).toEqual({ effort: 'weak' });
  });

  it('rises to a mandatory model`s lowest rung — the one upward exception', () => {
    const mandatorySingle: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['ultra'], mandatory: true },
      contextLength: 200_000,
    };
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high + 2000;
    const plan = pickClassifiedEffortPlan(mandatorySingle, 'low', cap);
    expect(plan?.wire).toEqual({ effort: 'ultra' });
    expect(plan?.maxTokens).toBe(cap);
  });

  it('walks past a mandatory ladder`s lowest rung to nothing when the cap cannot hold it', () => {
    // Nothing sits below a mandatory model's lowest rung, so a cap too small
    // for that rung leaves no reachable option: no reasoning wire is sent.
    const mandatory: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['ultra'], mandatory: true },
      contextLength: 200_000,
    };
    expect(pickClassifiedEffortPlan(mandatory, 'high', 2000)).toBeUndefined();
  });

  it('steps down to a level whose budget fits when the classified one exceeds the completion cap', () => {
    // Cap leaves no headroom above the high budget, so high is infeasible;
    // medium (nearest feasible below) wins.
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high;
    const plan = pickClassifiedEffortPlan(EFFORT_NATIVE, 'high', cap);
    expect(plan?.wire).toEqual({ effort: 'medium' });
    expect(plan?.maxTokens).toBe(cap);
  });

  it('returns undefined for a non-reasoning model', () => {
    expect(pickClassifiedEffortPlan({}, 'medium', 50_000)).toBeUndefined();
  });

  it('steps all the way down to the off rung when no rung fits the completion cap', () => {
    // Every budget clamps to the 1024 floor minimum; a cap at the floor leaves
    // no answer headroom for any rung, so the downward walk reaches Min.
    const plan = pickClassifiedEffortPlan(EFFORT_NATIVE, 'low', 1024);
    expect(plan?.wire).toEqual({ enabled: false });
    expect(plan?.maxTokens).toBe(1024);
  });

  it('returns undefined for a non-integer or sub-2 completion cap', () => {
    expect(pickClassifiedEffortPlan(EFFORT_NATIVE, 'medium', 1.5)).toBeUndefined();
    expect(pickClassifiedEffortPlan(EFFORT_NATIVE, 'medium', 1)).toBeUndefined();
  });
});

/**
 * The spend bound, pinned at the BOUNDARIES rather than at comfortable values.
 *
 * `docs/BILLING.md` §Reasoning Effort 3 sizes the wire cap as `B + H`, and the
 * hold was placed against `ceiling(m)` before the classifier answered. So the
 * only thing that keeps a classified pick inside its reserve is that the plan's
 * `maxTokens` is the cap it was HANDED — never a number re-derived from a
 * budget, a ladder tier, or a model bound. That is what these sweep: every
 * reasoning shape the descriptor schema admits, every option the registry
 * presents, and a cap sweep that lands exactly on each rung's clamped budget
 * and on either side of it, which is where an off-by-one re-derivation shows.
 *
 * What it catches: any future edit that computes the cap instead of passing it
 * through — clamping to a model bound inside the plan, returning `B + fixed H`,
 * or rounding the answer headroom — silently over-spends the hold by the
 * difference, and no other assertion here would notice.
 */
describe('pickClassifiedEffortPlan — the level the plan resolved to', () => {
  it('reports the classified level when the model offers it', () => {
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.medium + 5000;
    expect(pickClassifiedEffortPlan(EFFORT_NATIVE, 'medium', cap)?.level).toBe('medium');
  });

  it('reports the level actually stepped down to, not the one classified', () => {
    // The cap leaves no headroom above High's budget, so the walk lands on Mid.
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high;
    expect(pickClassifiedEffortPlan(EFFORT_NATIVE, 'high', cap)?.level).toBe('medium');
  });

  it('reports the off rung when resolution disabled reasoning', () => {
    const single: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['ultra'] },
      contextLength: 200_000,
    };
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high + 2000;
    expect(pickClassifiedEffortPlan(single, 'low', cap)?.level).toBe(REASONING_OFF);
  });

  it('distinguishes two budget-native rungs that clamp to one identical wire', () => {
    // A cap tighter than both tiers collapses Mid and Max onto the same
    // `max_tokens` wire, so the wire alone cannot say which rung ran.
    const clamped: ReasoningPlanModel = {
      reasoning: {},
      contextLength: 3000,
      maxOutputTokens: 3000,
    };
    const cap = 4000;
    const mid = pickClassifiedEffortPlan(clamped, 'medium', cap);
    const max = pickClassifiedEffortPlan(clamped, 'max', cap);
    expect(mid?.wire).toEqual(max?.wire);
    expect(mid?.level).toBe('medium');
    expect(max?.level).toBe('max');
  });
});

describe('the spend bound: B + H equals the held ceiling', () => {
  const nativeWords = ['w6', 'w5', 'w4', 'w3', 'w2', 'w1'];
  const reasoningShapes: (ReasoningPlanModel['reasoning'] | undefined)[] = [
    undefined,
    {},
    { mandatory: true },
    { supportedEfforts: null },
    { supportedEfforts: null, mandatory: true },
    ...Array.from({ length: 7 }, (_, n) => n).flatMap((n) => [
      { supportedEfforts: nativeWords.slice(0, n) },
      { supportedEfforts: nativeWords.slice(0, n), mandatory: true },
    ]),
  ];

  /** Every shape at a roomy context and at one tight enough to clamp every rung. */
  const space: ReasoningPlanModel[] = reasoningShapes.flatMap((reasoning) => [
    { reasoning, contextLength: 200_000 },
    { reasoning, contextLength: 200_000, maxOutputTokens: 3000 },
    { reasoning, contextLength: 900 },
  ]);

  /** Each rung's tier budget, its neighbours, and the degenerate extremes. */
  const caps: number[] = [
    2,
    3,
    REASONING_BUDGET_FLOOR_TOKENS,
    REASONING_BUDGET_FLOOR_TOKENS + 1,
    ...Object.values(REASONING_BUDGET_TOKENS_BY_EFFORT).flatMap((budget) => [
      budget - 1,
      budget,
      budget + 1,
    ]),
    REASONING_BUDGET_TOKENS_BY_EFFORT.max + 10_000,
    Number.MAX_SAFE_INTEGER,
  ];

  /** One planned outcome of the sweep: what was asked, what was handed, what came back. */
  interface Planned {
    readonly model: ReasoningPlanModel;
    readonly asked: (typeof EFFORT_OPTION_IDS)[number];
    readonly cap: number;
    readonly plan: ReasoningPlan;
  }

  const sweep = (): readonly Planned[] =>
    space.flatMap((model) =>
      EFFORT_OPTION_IDS.flatMap((asked) =>
        caps.flatMap((cap) => {
          const plan = pickClassifiedEffortPlan(model, asked, cap);
          return plan === undefined ? [] : [{ model, asked, cap, plan }];
        })
      )
    );

  const positionOf = (option: (typeof EFFORT_OPTION_IDS)[number]): number =>
    EFFORT_OPTION_IDS.indexOf(option);

  /**
   * Wire equality BY VALUE. Reference equality is wrong here and silently so:
   * `offeredLevels` mints a fresh parsed wire on every call, and the plan carries
   * one minted by a different call, so `===` is false for every pair — a lookup
   * written that way never matches, always falls through to the off rung, and
   * turns the assertion below into one that passes for any implementation.
   */
  const sameWire = (a: ReasoningWire, b: ReasoningWire): boolean =>
    ('effort' in a && 'effort' in b && a.effort === b.effort) ||
    ('max_tokens' in a && 'max_tokens' in b && a.max_tokens === b.max_tokens) ||
    ('enabled' in a && 'enabled' in b);

  /**
   * Which option a returned plan bound. On a fully-clamped ladder several labels
   * share one wire; `find` takes the lowest, which is the weakest true reading
   * and cannot manufacture a violation out of a plateau.
   */
  const boundOptionOf = (planned: Planned): (typeof EFFORT_OPTION_IDS)[number] =>
    offeredLevels(planned.model).find((level) => sameWire(level.wire, planned.plan.wire))?.label ??
    REASONING_OFF;

  /**
   * An independent oracle in BUDGET space, immune to the plateau ambiguity above:
   * the most thinking the asked-for option could legitimately buy on this model
   * is the budget of the highest rung at or below it, or zero when only Min sits
   * below. Derived from the model's own ladder through the shared budget
   * function, never by re-walking the resolver under test.
   */
  const budgetCeilingFor = (planned: Planned): number =>
    Math.max(
      0,
      ...offeredLevels(planned.model)
        .filter((level) => positionOf(level.label) <= positionOf(planned.asked))
        .map((level) => reasoningBudgetForWire(planned.model, level.wire))
    );

  it('returns the cap it was handed, for every shape, option and cap', () => {
    const planned = sweep();
    for (const one of planned) {
      expect(one.plan.maxTokens).toBe(one.cap);
      expect(one.plan.reasoningBudgetTokens + one.plan.answerHeadroomTokens).toBe(one.cap);
    }
    // Guards the sweep itself: an over-strict change that made every arm return
    // `undefined` would satisfy every assertion above vacuously.
    expect(planned.length).toBeGreaterThan(1000);
  });

  it('never binds a rung above the classified option unless reasoning is mandatory', () => {
    const optional = sweep().filter((one) => one.model.reasoning?.mandatory !== true);
    const risen = optional.filter((one) => positionOf(boundOptionOf(one)) > positionOf(one.asked));
    expect(risen).toEqual([]);
    // The sweep must actually reach rungs, or a lookup that silently resolved to
    // the off rung every time would satisfy the filter above vacuously.
    expect(optional.filter((one) => boundOptionOf(one) !== REASONING_OFF).length).toBeGreaterThan(
      100
    );
  });

  it('never spends more thinking than the classified option asked for', () => {
    const optional = sweep().filter((one) => one.model.reasoning?.mandatory !== true);
    const overspent = optional.filter(
      (one) => one.plan.reasoningBudgetTokens > budgetCeilingFor(one)
    );
    expect(overspent).toEqual([]);
    // Same guard, in budget space: a sweep that only ever planned a zero budget
    // would satisfy the comparison without constraining anything.
    expect(optional.filter((one) => one.plan.reasoningBudgetTokens > 0).length).toBeGreaterThan(
      100
    );
  });
});
