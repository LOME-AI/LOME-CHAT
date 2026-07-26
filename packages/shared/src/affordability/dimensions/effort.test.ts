import { describe, expect, it } from 'vitest';

import { CANONICAL_REASONING_EFFORTS, REASONING_OFF } from '../reasoning-effort.js';
import { nanoUSD } from '../nano-usd.js';
import {
  EFFORT_DIMENSION,
  EFFORT_OPTION_IDS,
  cheapestEffortOption,
  maxReasoningBudgetTokens,
} from './effort.js';
import type { PriceableModel } from '../priceable-model.js';

function modelFor(reasoning?: PriceableModel['reasoning'], caps = 200_000): PriceableModel {
  return {
    modelId: 'vendor/model',
    inputRateNanoUsd: nanoUSD(1000n),
    outputRateNanoUsd: nanoUSD(2000n),
    contextLength: caps,
    providerCap: caps,
    reasoning,
  };
}

describe('EFFORT_OPTION_IDS', () => {
  it('is the off rung below the canonical ladder, ascending', () => {
    expect(EFFORT_OPTION_IDS).toEqual([REASONING_OFF, ...CANONICAL_REASONING_EFFORTS]);
  });
});

describe('EFFORT_DIMENSION', () => {
  it('declares effort a partition of the completion pool', () => {
    expect(EFFORT_DIMENSION.resource).toBe('completionTokens');
    expect(EFFORT_DIMENSION.costClass).toBe('partition');
  });

  it('is ordered and enumerable, so a ceiling represents it and Auto can open it', () => {
    expect(EFFORT_DIMENSION.ordered).toBe(true);
    expect(EFFORT_DIMENSION.enumerable).toBe(true);
  });

  it('resolves downward with the mandatory-reasoning carve-out', () => {
    expect(EFFORT_DIMENSION.resolution).toBe('lowestOfferedWhenMandatory');
  });

  it('delivers at the hold ceiling — a partition never shrinks it', () => {
    expect(EFFORT_DIMENSION.deliversAtHoldCeiling).toBe(true);
  });

  it('declares its option domain in the catalog parameter-spec language', () => {
    expect(EFFORT_DIMENSION.param).toEqual({
      type: 'enum',
      values: [...EFFORT_OPTION_IDS],
      wire: 'providerOptions',
    });
  });
});

describe('maxReasoningBudgetTokens — maxB(m)', () => {
  it('is the strongest rung the model offers, after the catalog clamp', () => {
    expect(maxReasoningBudgetTokens(modelFor({}))).toBe(65_536);
  });

  it('collapses to the protocol floor when the catalog cap sits below every tier', () => {
    expect(maxReasoningBudgetTokens(modelFor({}, 900))).toBe(1024);
  });

  it('is zero for a model that cannot reason', () => {
    expect(maxReasoningBudgetTokens(modelFor())).toBe(0);
  });

  it('clamps to the tighter of the context length and the provider cap', () => {
    const model: PriceableModel = { ...modelFor({}), contextLength: 200_000, providerCap: 8000 };
    expect(maxReasoningBudgetTokens(model)).toBe(8000);
  });
});

describe('cheapestEffortOption — e_min(m)', () => {
  it('is the off rung when reasoning can be disabled', () => {
    expect(cheapestEffortOption(modelFor({}))).toBe(REASONING_OFF);
  });

  it('is the lowest offered rung on a mandatory-reasoning model — never a free zero', () => {
    expect(
      cheapestEffortOption(
        modelFor({ supportedEfforts: ['high', 'medium', 'low'], mandatory: true })
      )
    ).toBe('low');
  });

  it('is absent when the model offers nothing on the axis', () => {
    expect(cheapestEffortOption(modelFor())).toBeUndefined();
  });
});
