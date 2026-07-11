import { describe, expect, it } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { createTurnCompileRegistries } from './turn-definition.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID, TRIAL_TURN_HOOKS } from './constants.js';
import { answerMaxOutputTokens, buildSmartModelTurn } from './smart-model-turn.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelDescriptor } from '@hushbox/shared';

function descriptorFor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1000 },
    pricing: { inputPerToken: nanoUSD(2n), outputPerToken: nanoUSD(3n) },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

const KNOWN_MODELS = new Set(['cheap-model', 'mid-model']);
const resolver: ModelPricingResolver = (id) =>
  KNOWN_MODELS.has(id) ? descriptorFor(id) : undefined;

/** A catalog descriptor with explicit per-token rates and context window. */
function pricedDescriptor(
  id: string,
  inputPerToken: bigint,
  outputPerToken: bigint,
  contextLength: number
): ModelDescriptor {
  return {
    ...descriptorFor(id),
    limits: { contextLength },
    pricing: { inputPerToken: nanoUSD(inputPerToken), outputPerToken: nanoUSD(outputPerToken) },
  };
}

describe('answerMaxOutputTokens', () => {
  // Legacy reserved the Smart Model slot at the MOST EXPENSIVE eligible rates
  // (computeMaxEligibleFees) so the budget absorbs whichever candidate the
  // classifier picks; the context bound is the tightest candidate window.
  const CATALOG = [
    pricedDescriptor('cheap', 2000n, 10_000n, 8000),
    pricedDescriptor('big', 4000n, 20_000n, 4000),
  ];

  it('derives the ceiling from the max candidate rates and min context length', () => {
    // free payer, chars=400 → estInput=200; max rates marked = 4600 / 23_000;
    // fixed = 200×4600 + 400×300 = 1_040_000; variable = 23_000 + 4×300 = 24_200;
    // maxOutputTokens = floor((50_000_000 − 1_040_000) / 24_200) = 2_023;
    // min context 4000 − 200 = 3_800 remaining > 2_023 → capped.
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      0n
    );
    expect(result).toBe(2023);
  });

  it('shrinks the ceiling by the classifier reserve deducted from the budget', () => {
    // Same inputs as above, but the classifier's worst-case reserve is set aside
    // first: effective = 50_000_000 − 10_000_000 = 40_000_000;
    // maxOutputTokens = floor((40_000_000 − 1_040_000) / 24_200) = 1_609;
    // min context 4000 − 200 = 3_800 remaining > 1_609 → capped.
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      10_000_000n
    );
    expect(result).toBe(1609);
  });

  it('omits the cap when the reserve leaves too little for the minimum output', () => {
    // reserve 45_000_000 leaves 5_000_000 < the minimum-output cost
    // (1_040_000 + 1000×24_200 = 25_240_000) → no cap derivable.
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      45_000_000n
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when a candidate is missing from the catalog snapshot', () => {
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'ghost' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      0n
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when the budget covers the tightest remaining context', () => {
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      {
        promptCharacterCount: 400,
        funding: { remainingNanoUsd: 10_000_000_000_000n, kind: 'purchased' },
      },
      0n
    );
    expect(result).toBeUndefined();
  });
});

describe('buildSmartModelTurn', () => {
  it('compiles a one-node smartModel turn under the paid chat hooks', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model', description: 'cheap' }, { id: 'mid-model' }],
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.deadlineClass).toBe('text');
    expect(definition.hooks).toEqual(CHAT_TURN_HOOKS);
    const node = definition.nodes[0];
    expect(definition.nodes).toHaveLength(1);
    expect(node).toMatchObject({
      id: CHAT_TURN_NODE_ID,
      type: 'smartModel',
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model', description: 'cheap' }, { id: 'mid-model' }],
    });
  });

  it('compiles the same turn under the trial hooks when a policy is supplied', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }],
      hooks: TRIAL_TURN_HOOKS,
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.hooks).toEqual(TRIAL_TURN_HOOKS);
    expect(definition.nodes[0]).toMatchObject({ type: 'smartModel' });
  });

  it('injects the answer output-token ceiling into the node params when defined', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
      answerMaxOutputTokens: 512,
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.nodes[0]).toMatchObject({
      type: 'smartModel',
      params: { maxOutputTokens: 512 },
    });
  });

  it('leaves the node params empty when no ceiling is derived', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }],
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.nodes[0]).toMatchObject({ type: 'smartModel', params: {} });
  });

  it('refuses a candidate list naming an unexposed model with a validation error', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'ghost-model' }],
      nodes,
      constraints,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
