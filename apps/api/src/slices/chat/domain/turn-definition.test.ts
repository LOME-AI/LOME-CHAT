import { describe, expect, it } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { MAX_SEARCH_TOOL_CALLS } from '@hushbox/shared';
import { WEB_SEARCH_TOOL_NAME } from '../../models/index.js';
import {
  assertModelProducesModality,
  assertModelsWebSearchCapable,
  assertWebSearchCapable,
  buildMediaTurn,
  buildMultiModelTurn,
  buildSingleModelTurn,
  createTurnCompileRegistries,
  turnMaxOutputTokens,
  turnModelPricings,
} from './turn-definition.js';
import { CHAT_TURN_NODE_ID } from './constants.js';
import type { TurnModelPricing } from './turn-definition.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelDescriptor } from '@hushbox/shared';

function descriptorFor(id: string, behaviors: string[] = []): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors,
    limits: { contextLength: 1000 },
    pricing: { inputPerToken: nanoUSD(2n), outputPerToken: nanoUSD(3n) },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

const KNOWN_MODELS = new Set(['answer-model', 'model-a', 'model-b', 'model-c']);
const resolver: ModelPricingResolver = (id) =>
  KNOWN_MODELS.has(id) ? descriptorFor(id) : undefined;

/** A text→media descriptor: the model consumes text and produces one media modality. */
function mediaDescriptorFor(id: string, output: 'image' | 'video'): ModelDescriptor {
  return { ...descriptorFor(id), inputs: ['text'], outputs: [output] };
}

const MEDIA_MODELS: Record<string, 'image' | 'video'> = {
  'image-model': 'image',
  'video-model': 'video',
};
const mediaResolver: ModelPricingResolver = (id) =>
  id in MEDIA_MODELS ? mediaDescriptorFor(id, MEDIA_MODELS[id]!) : undefined;

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

  it('gives the answer node the web-search tool and step ceiling when enabled', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildSingleModelTurn({
      model: 'answer-model',
      nodes,
      constraints,
      webSearchEnabled: true,
    });
    const answer = result
      ._unsafeUnwrap()
      .nodes.find((node) => node.type === 'modelCall' && node.id === CHAT_TURN_NODE_ID);
    expect(answer?.type === 'modelCall' && answer.tools).toEqual([WEB_SEARCH_TOOL_NAME]);
    expect(answer?.type === 'modelCall' && answer.maxSteps).toBe(MAX_SEARCH_TOOL_CALLS);
  });

  it('leaves the answer node tool-free when web search is not enabled', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const answer = buildSingleModelTurn({ model: 'answer-model', nodes, constraints })
      ._unsafeUnwrap()
      .nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.tools).toEqual([]);
    expect(answer?.type === 'modelCall' && answer.maxSteps).toBe(1);
  });
});

describe('assertModelProducesModality', () => {
  it('is ok when the model is unknown (absent descriptor) — compile refuses it later', () => {
    expect(assertModelProducesModality(undefined, 'image').isOk()).toBe(true);
  });

  it('is ok when the model produces exactly the requested modality', () => {
    expect(assertModelProducesModality(mediaDescriptorFor('m', 'video'), 'video').isOk()).toBe(
      true
    );
  });

  it('refuses a text model for a media modality with a validation error', () => {
    expect(assertModelProducesModality(descriptorFor('m'), 'image')._unsafeUnwrapErr().code).toBe(
      'validation'
    );
  });

  it('refuses a media model producing a different modality', () => {
    expect(
      assertModelProducesModality(mediaDescriptorFor('m', 'image'), 'video')._unsafeUnwrapErr().code
    ).toBe('validation');
  });

  it('refuses a multi-output model (needs exactly one output)', () => {
    const multi: ModelDescriptor = { ...descriptorFor('m'), outputs: ['text', 'image'] };
    expect(assertModelProducesModality(multi, 'image')._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('buildMediaTurn', () => {
  it('compiles a one-node image turn for a text→image model, carrying its params', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    const result = buildMediaTurn({
      model: 'image-model',
      modality: 'image',
      params: { aspectRatio: '1:1' },
      nodes,
      constraints,
    });
    const definition = result._unsafeUnwrap();
    // A media turn is deadline-classed 'media', not 'text'.
    expect(definition.deadlineClass).toBe('media');
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.model).toBe('image-model');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ aspectRatio: '1:1' });
  });

  it('compiles a one-node video turn for a text→video model, carrying its params', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    const result = buildMediaTurn({
      model: 'video-model',
      modality: 'video',
      params: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
      nodes,
      constraints,
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({
      aspectRatio: '16:9',
      durationSeconds: 6,
      resolution: '720p',
    });
  });

  it('refuses a media turn whose model is unknown with a validation error', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    const result = buildMediaTurn({
      model: 'nope',
      modality: 'image',
      params: {},
      nodes,
      constraints,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a media turn whose model produces the wrong modality (a text model for image)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    // 'answer-model' is a text→text model, absent from the media resolver, so an
    // image turn over it fails the build closed.
    const result = buildMediaTurn({
      model: 'answer-model',
      modality: 'image',
      params: {},
      nodes,
      constraints,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('assertWebSearchCapable', () => {
  it('is ok when web search is disabled regardless of the model', () => {
    expect(assertWebSearchCapable(descriptorFor('m'), false).isOk()).toBe(true);
  });

  it('is ok for a tool-capable model when enabled', () => {
    expect(assertWebSearchCapable(descriptorFor('m', ['tools']), true).isOk()).toBe(true);
  });

  it('is ok when the model is unknown (absent descriptor) — compile refuses it later', () => {
    expect(assertWebSearchCapable(undefined, true).isOk()).toBe(true);
  });

  it('refuses a tool-incapable model with a validation error when enabled', () => {
    expect(assertWebSearchCapable(descriptorFor('m'), true)._unsafeUnwrapErr().code).toBe(
      'validation'
    );
  });
});

describe('assertModelsWebSearchCapable', () => {
  const resolve: ModelPricingResolver = (id) =>
    id === 'capable' ? descriptorFor(id, ['tools']) : descriptorFor(id);

  it('is ok when disabled regardless of the models', () => {
    expect(assertModelsWebSearchCapable(['incapable'], resolve, false).isOk()).toBe(true);
  });

  it('is ok when every model is tool-capable', () => {
    expect(assertModelsWebSearchCapable(['capable', 'capable'], resolve, true).isOk()).toBe(true);
  });

  it('refuses when any model is tool-incapable', () => {
    expect(
      assertModelsWebSearchCapable(['capable', 'incapable'], resolve, true)._unsafeUnwrapErr().code
    ).toBe('validation');
  });
});

/** Base (pre-markup) per-token rates; the derivation applies the 15% markup. */
function pricingEntry(
  inputPerTokenNanoUsd: bigint,
  outputPerTokenNanoUsd: bigint,
  contextLength: number
): TurnModelPricing {
  return { inputPerTokenNanoUsd, outputPerTokenNanoUsd, contextLength };
}

describe('turnMaxOutputTokens', () => {
  // Fixture rates: base input 2000 / output 10_000 nano-USD per token →
  // fee-inclusive 2300 / 11_500 after the 15% markup (legacy prices were
  // fee-inclusive before entering the budget math).
  const MODEL = pricingEntry(2000n, 10_000n, 1_000_000);

  it('derives the purchased-payer ceiling with the legacy paid-tier formula', () => {
    // chars=400 → estInput=ceil(400/4)=100 (paid = 4 chars/token);
    // fixed = 100×2300 + 400×300(storage) = 350_000;
    // variable = 11_500 + 2(paid output chars/token)×300 = 12_100;
    // effective = 100_000_000 + 500_000_000 cushion = 600_000_000;
    // maxOutputTokens = floor((600_000_000 − 350_000) / 12_100) = 49_557.
    const result = turnMaxOutputTokens(
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 100_000_000n, kind: 'purchased' } },
      [MODEL]
    );
    expect(result).toBe(49_557);
  });

  it('derives the free-payer ceiling with the legacy free-tier formula (no cushion, 2 chars/token)', () => {
    // chars=400 → estInput=ceil(400/2)=200 (free = 2 chars/token);
    // fixed = 200×2300 + 400×300 = 580_000;
    // variable = 11_500 + 4(free output chars/token)×300 = 12_700;
    // effective = 50_000_000 (allowance only, no cushion);
    // maxOutputTokens = floor((50_000_000 − 580_000) / 12_700) = 3_891.
    const result = turnMaxOutputTokens(
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      [MODEL]
    );
    expect(result).toBe(3891);
  });

  it('returns undefined when the budget covers the remaining context (model default applies)', () => {
    const result = turnMaxOutputTokens(
      {
        promptCharacterCount: 400,
        funding: { remainingNanoUsd: 10_000_000_000_000n, kind: 'purchased' },
      },
      [MODEL]
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined below the legacy minimum-output threshold (admission is the refusal gate)', () => {
    // free minimum = 580_000 + 1000×12_700 = 13_280_000 > 10_000_000 remaining →
    // legacy set maxOutputTokens=0 and denied upstream; here the cap is omitted so
    // the full-context hold makes admission refuse.
    const result = turnMaxOutputTokens(
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 10_000_000n, kind: 'free' } },
      [MODEL]
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when the budget exceeds a small remaining context window', () => {
    // context 5000 − estInput 100 = 4900 remaining < the 49_557 budget → omit.
    const result = turnMaxOutputTokens(
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 100_000_000n, kind: 'purchased' } },
      [pricingEntry(2000n, 10_000n, 5000)]
    );
    expect(result).toBeUndefined();
  });

  it('sums rates across models and uses the min context length (legacy multi-model)', () => {
    // sumIn = 2300+4600 = 6900; sumOut = 11_500+23_000 = 34_500;
    // variable = 34_500 + 2×300×2 models = 35_700;
    // fixed = 100×6900 + 400×300 = 810_000;
    // maxOutputTokens = floor((600_000_000 − 810_000) / 35_700) = 16_784.
    const result = turnMaxOutputTokens(
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 100_000_000n, kind: 'purchased' } },
      [pricingEntry(2000n, 10_000n, 100_000), pricingEntry(4000n, 20_000n, 50_000)]
    );
    expect(result).toBe(16_784);
  });

  it('returns undefined for an empty model list', () => {
    const result = turnMaxOutputTokens(
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 100_000_000n, kind: 'purchased' } },
      []
    );
    expect(result).toBeUndefined();
  });

  it('estimates zero input tokens for an empty prompt (legacy estimateTokensForTier)', () => {
    // chars=0 → estInput=0; fixed = 0; effective = 600_000_000;
    // maxOutputTokens = floor(600_000_000 / 12_100) = 49_586.
    const result = turnMaxOutputTokens(
      { promptCharacterCount: 0, funding: { remainingNanoUsd: 100_000_000n, kind: 'purchased' } },
      [MODEL]
    );
    expect(result).toBe(49_586);
  });
});

describe('turnModelPricings', () => {
  it('resolves base rates and context length for known models', () => {
    expect(turnModelPricings(['answer-model'], resolver)).toEqual([
      { inputPerTokenNanoUsd: 2n, outputPerTokenNanoUsd: 3n, contextLength: 1000 },
    ]);
  });

  it('returns undefined when any model is unknown', () => {
    expect(turnModelPricings(['answer-model', 'nope'], resolver)).toBeUndefined();
  });

  it('returns undefined when a model has no context-length limit', () => {
    const noContext: ModelPricingResolver = (id) => ({
      ...descriptorFor(id),
      limits: {},
    });
    expect(turnModelPricings(['answer-model'], noContext)).toBeUndefined();
  });

  it('returns undefined when a model lacks a plain per-token rate', () => {
    const noRate: ModelPricingResolver = (id) => ({
      ...descriptorFor(id),
      pricing: { inputPerToken: nanoUSD(2n) },
    });
    expect(turnModelPricings(['answer-model'], noRate)).toBeUndefined();
  });
});

describe('buildSingleModelTurn maxOutputTokens', () => {
  it('injects the ceiling into the answer node params when defined', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const answer = buildSingleModelTurn({
      model: 'answer-model',
      nodes,
      constraints,
      maxOutputTokens: 1234,
    })
      ._unsafeUnwrap()
      .nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ maxOutputTokens: 1234 });
  });

  it('omits the key entirely when the ceiling is undefined (model default)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const answer = buildSingleModelTurn({ model: 'answer-model', nodes, constraints })
      ._unsafeUnwrap()
      .nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({});
  });
});

describe('turn definition carries no user content (safe-to-log invariant)', () => {
  // Custom instructions are run-scoped ctx (RunStartBody → NodeRunContext),
  // NEVER baked into the definition — the WorkflowDefinition must stay free of
  // user content so it remains safe to log. The builders take no custom-
  // instructions input at all; these assert the serialized definition holds no
  // trace of it, whatever a caller passes as prompt/model.
  it('has no customInstructions param on a single-model turn', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSingleModelTurn({
      model: 'answer-model',
      nodes,
      constraints,
      maxOutputTokens: 500,
    })._unsafeUnwrap();
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ maxOutputTokens: 500 });
    expect(JSON.stringify(definition)).not.toContain('customInstructions');
  });

  it('has no customInstructions param on any sibling of a multi-model turn', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildMultiModelTurn({
      models: ['model-a', 'model-b'],
      nodes,
      constraints,
    })._unsafeUnwrap();
    for (const sibling of definition.nodes.filter((node) => node.type === 'modelCall')) {
      expect(sibling.params).toEqual({});
    }
    expect(JSON.stringify(definition)).not.toContain('customInstructions');
  });
});

describe('buildMultiModelTurn', () => {
  it('injects the ONE shared ceiling into every sibling (legacy applied one value to all slots)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const siblings = buildMultiModelTurn({
      models: ['model-a', 'model-b'],
      nodes,
      constraints,
      maxOutputTokens: 777,
    })
      ._unsafeUnwrap()
      .nodes.filter((node) => node.type === 'modelCall');
    expect(siblings).toHaveLength(2);
    for (const sibling of siblings) {
      expect(sibling.params).toEqual({ maxOutputTokens: 777 });
    }
  });

  it('leaves sibling params empty when no ceiling is derived', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const siblings = buildMultiModelTurn({ models: ['model-a', 'model-b'], nodes, constraints })
      ._unsafeUnwrap()
      .nodes.filter((node) => node.type === 'modelCall');
    for (const sibling of siblings) {
      expect(sibling.params).toEqual({});
    }
  });
  it('compiles one optional skip-on-error sibling node per selected model, in order', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildMultiModelTurn({
      models: ['model-a', 'model-b', 'model-c'],
      nodes,
      constraints,
    });
    const definition = result._unsafeUnwrap();
    expect(definition.deadlineClass).toBe('text');
    // One modelCall node per model, each carrying its model id, all optional and
    // skip-on-error so one model's failure never fails the run.
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings).toHaveLength(3);
    for (const sibling of siblings) {
      expect(sibling.optional).toBe(true);
      expect(sibling.onError).toBe('skip');
    }
    expect(siblings.map((node) => node.model)).toEqual(['model-a', 'model-b', 'model-c']);
    // Distinct node ids — each sibling is its own charge key / assistant message.
    expect(new Set(siblings.map((node) => node.id)).size).toBe(3);
  });

  it('refuses when any selected model is unknown or unexposed', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildMultiModelTurn({ models: ['model-a', 'nope'], nodes, constraints });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('gives every sibling the web-search tool and step ceiling when enabled', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const siblings = buildMultiModelTurn({
      models: ['model-a', 'model-b'],
      nodes,
      constraints,
      webSearchEnabled: true,
    })
      ._unsafeUnwrap()
      .nodes.filter((node) => node.type === 'modelCall');
    for (const sibling of siblings) {
      expect(sibling.tools).toEqual([WEB_SEARCH_TOOL_NAME]);
      expect(sibling.maxSteps).toBe(MAX_SEARCH_TOOL_CALLS);
    }
  });
});
