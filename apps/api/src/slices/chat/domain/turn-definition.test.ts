import { describe, expect, it } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { buildSingleModelTurn, createTurnCompileRegistries } from './turn-definition.js';
import { CHAT_TURN_NODE_ID } from './constants.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelDescriptor } from '@hushbox/shared';

const descriptor: ModelDescriptor = {
  id: 'answer-model',
  provider: 'p',
  version: '1',
  inputs: ['text'],
  outputs: ['text'],
  parameters: {},
  behaviors: [],
  limits: { contextLength: 1000 },
  pricing: { inputPerToken: nanoUSD(2n), outputPerToken: nanoUSD(3n) },
  zdrReachable: true,
  fetchedAt: 0,
};

const resolver: ModelPricingResolver = (id) => (id === 'answer-model' ? descriptor : undefined);

describe('buildSingleModelTurn', () => {
  it('compiles a one-node text turn for a known model', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildSingleModelTurn({ model: 'answer-model', nodes, constraints });
    const definition = result._unsafeUnwrap();
    expect(definition.deadlineClass).toBe('text');
    expect(definition.nodes.map((node) => node.id)).toContain(CHAT_TURN_NODE_ID);
  });

  it('refuses an unknown model with a validation error', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildSingleModelTurn({ model: 'nope', nodes, constraints });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
