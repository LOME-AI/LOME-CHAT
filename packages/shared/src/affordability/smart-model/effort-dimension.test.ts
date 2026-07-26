import { describe, expect, it } from 'vitest';

import {
  CLASSIFIER_EFFORT_LEVELS,
  parseClassifierAnswer,
  pickClassifiedEffortPlan,
  resolveClassifiedEffort,
} from './effort-dimension.js';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '../estimate/reasoning-plan.js';
import type { ReasoningPlanModel } from '../estimate/reasoning-plan.js';

describe('CLASSIFIER_EFFORT_LEVELS', () => {
  it('is the canonical model-agnostic classifier scale: low | medium | high', () => {
    expect(CLASSIFIER_EFFORT_LEVELS).toEqual(['low', 'medium', 'high']);
  });
});

describe('resolveClassifiedEffort', () => {
  it('resolves an exact level word', () => {
    expect(resolveClassifiedEffort('medium')).toBe('medium');
  });

  it('resolves case-insensitively with surrounding whitespace', () => {
    expect(resolveClassifiedEffort('  High \n')).toBe('high');
  });

  it('resolves a level embedded in short prose', () => {
    expect(resolveClassifiedEffort('effort: low')).toBe('low');
  });

  it('returns null for an unresolvable output', () => {
    expect(resolveClassifiedEffort('turbo')).toBeNull();
  });

  it('returns null for an empty output', () => {
    expect(resolveClassifiedEffort('')).toBeNull();
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

  it('both dimensions: line 1 is the model, line 2 is the effort', () => {
    const parts = parseClassifierAnswer('openai/gpt-5-nano\nmedium', {
      model: true,
      effort: true,
    });
    expect(parts).toEqual({ modelText: 'openai/gpt-5-nano', effortText: 'medium' });
  });

  it('both dimensions: skips blank lines and trims each line', () => {
    const parts = parseClassifierAnswer('\n  openai/gpt-5-nano  \n\n  low  \n', {
      model: true,
      effort: true,
    });
    expect(parts).toEqual({ modelText: 'openai/gpt-5-nano', effortText: 'low' });
  });

  it('both dimensions with a one-line answer: the effort text is empty (falls back downstream)', () => {
    const parts = parseClassifierAnswer('openai/gpt-5-nano', { model: true, effort: true });
    expect(parts).toEqual({ modelText: 'openai/gpt-5-nano', effortText: '' });
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

  it('maps to the nearest offered position when the classified level is not offered (N=1 ladder → high)', () => {
    // A single enumerated effort word offers only the High rung.
    const single: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['ultra'] },
      contextLength: 200_000,
    };
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high + 2000;
    const plan = pickClassifiedEffortPlan(single, 'low', cap);
    expect(plan?.wire).toEqual({ effort: 'ultra' });
  });

  it('prefers the LOWER position on a distance tie (N=2 ladder, classified medium → low)', () => {
    const two: ReasoningPlanModel = {
      // Upstream order is descending: strongest first.
      reasoning: { supportedEfforts: ['strong', 'weak'] },
      contextLength: 200_000,
    };
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high + 2000;
    const plan = pickClassifiedEffortPlan(two, 'medium', cap);
    // N=2 ladder is [low, high]; low and high are both distance 1 from medium.
    expect(plan?.wire).toEqual({ effort: 'weak' });
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

  it('returns undefined when no offered level fits the completion cap', () => {
    // Every budget clamps to the 1024 floor minimum; a cap at the floor leaves
    // no answer headroom for any level.
    expect(pickClassifiedEffortPlan(EFFORT_NATIVE, 'low', 1024)).toBeUndefined();
  });

  it('returns undefined for a non-integer or sub-2 completion cap', () => {
    expect(pickClassifiedEffortPlan(EFFORT_NATIVE, 'medium', 1.5)).toBeUndefined();
    expect(pickClassifiedEffortPlan(EFFORT_NATIVE, 'medium', 1)).toBeUndefined();
  });

  it('always yields maxTokens equal to the given completion cap (reserve-preserving)', () => {
    for (const level of CLASSIFIER_EFFORT_LEVELS) {
      const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.max + 10_000;
      const plan = pickClassifiedEffortPlan(BUDGET_NATIVE, level, cap);
      expect(plan?.maxTokens).toBe(cap);
    }
  });
});
