import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MEDIA_MIME_TYPES,
  ERROR_CODES,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
  nanoUSD,
  outputCharsPerTokenForTier,
} from '@hushbox/shared';
import { MAX_SEARCH_TOOL_CALLS } from '@hushbox/shared';
import { WEB_SEARCH_TOOL_NAME, createEstimateRun } from '../../models/index.js';
import {
  MEDIA_TURN_MIME_TYPES,
  assertModelProducesModality,
  assertModelsProduceModality,
  assertModelsWebSearchCapable,
  assertWebSearchCapable,
  buildMediaTurn,
  buildMultiModelTurn,
  buildSingleModelTurn,
  createTurnCompileRegistries,
  payerSpendableNanoUsd,
  promptInputTokensFor,
  reconcileAnswerCeiling,
  turnMaxOutputTokens,
  turnModelPricings,
  withStorageStamp,
} from './turn-definition.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID, TRIAL_TURN_HOOKS } from './constants.js';
import type { TurnBudget, TurnModelPricing } from './turn-definition.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelDescriptor, WorkflowDefinition } from '@hushbox/shared';

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

  it('carries the UNSUPPORTED_MODALITY wire code on the refusal', () => {
    expect(
      assertModelProducesModality(descriptorFor('m'), 'image')._unsafeUnwrapErr().wireCode
    ).toBe(ERROR_CODES.UNSUPPORTED_MODALITY);
  });
});

describe('buildMediaTurn', () => {
  it('compiles a one-node image turn for a text→image model, carrying its params', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    const result = buildMediaTurn({
      models: ['image-model'],
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
      models: ['video-model'],
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
      models: ['nope'],
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
      models: ['answer-model'],
      modality: 'image',
      params: {},
      nodes,
      constraints,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('compiles a single-model turn to exactly the one-node shape (id, no optional, no onError)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    const definition = buildMediaTurn({
      models: ['image-model'],
      modality: 'image',
      params: { aspectRatio: '1:1' },
      nodes,
      constraints,
    })._unsafeUnwrap();
    // N=1 must stay behaviorally identical to the historical single-model media
    // turn: one node under CHAT_TURN_NODE_ID (the settlement charge key), not a
    // one-wide fan-out sibling — a sibling would be optional/skip and re-key
    // the charge/message pairing.
    const calls = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(CHAT_TURN_NODE_ID);
    expect(calls[0]?.optional).toBe(false);
    expect(calls[0]?.onError).toBe('fail');
  });

  it('declares the reconciled legacy mime allowlist on the produced media tags', () => {
    // Parity with the legacy ALLOWED_MEDIA_MIME_TYPES image/video subsets, and
    // agreement with the storage adapter's allowlist: every mime the turn tag
    // admits must pass ALLOWED_MEDIA_MIME_TYPES at storage.put.
    expect(MEDIA_TURN_MIME_TYPES.image).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(MEDIA_TURN_MIME_TYPES.video).toEqual(['video/mp4', 'video/webm']);
    for (const mime of [...MEDIA_TURN_MIME_TYPES.image, ...MEDIA_TURN_MIME_TYPES.video]) {
      expect(ALLOWED_MEDIA_MIME_TYPES.safeParse(mime).success).toBe(true);
    }
  });
});

describe('buildMediaTurn multi-model', () => {
  const THREE_IMAGE_MODELS: Record<string, 'image' | 'video'> = {
    'image-a': 'image',
    'image-b': 'image',
    'image-c': 'image',
  };
  const threeImageResolver: ModelPricingResolver = (id) =>
    id in THREE_IMAGE_MODELS ? mediaDescriptorFor(id, THREE_IMAGE_MODELS[id]!) : undefined;

  it('compiles one optional skip-on-error sibling node per selected model, in order', () => {
    const { nodes, constraints } = createTurnCompileRegistries(threeImageResolver);
    const definition = buildMediaTurn({
      models: ['image-a', 'image-b', 'image-c'],
      modality: 'image',
      params: { aspectRatio: '1:1' },
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.deadlineClass).toBe('media');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings.map((node) => node.model)).toEqual(['image-a', 'image-b', 'image-c']);
    // Distinct node ids: each sibling is its own settlement charge key and
    // assistant message.
    expect(new Set(siblings.map((node) => node.id)).size).toBe(3);
    for (const sibling of siblings) {
      expect(sibling.optional).toBe(true);
      expect(sibling.onError).toBe('skip');
      expect(sibling.params).toEqual({ aspectRatio: '1:1' });
    }
  });

  it('refuses when any selected model is unknown or unexposed', () => {
    const { nodes, constraints } = createTurnCompileRegistries(threeImageResolver);
    const result = buildMediaTurn({
      models: ['image-a', 'nope', 'image-c'],
      modality: 'image',
      params: {},
      nodes,
      constraints,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('buildMediaTurn — admission storage stamp', () => {
  // Media descriptors with REAL media pricing (the shared media resolver's
  // token-only pricing cannot price a media node). Image charges perImage;
  // video charges the perSecondByResolution matrix.
  const imagePriced: ModelDescriptor = {
    ...mediaDescriptorFor('img', 'image'),
    pricing: { perImage: nanoUSD(1_000_000n) },
  };
  const videoPriced: ModelDescriptor = {
    ...mediaDescriptorFor('vid', 'video'),
    pricing: { perSecondByResolution: { '720p': nanoUSD(2_000_000n) } },
  };
  const pricedMedia: Record<string, ModelDescriptor> = { img: imagePriced, vid: videoPriced };
  const pricedMediaResolver: ModelPricingResolver = (id) => pricedMedia[id];
  const paidBudget: TurnBudget = {
    promptCharacterCount: 100,
    funding: { kind: 'purchased', remainingNanoUsd: 1n },
  };

  function imageTurn(budget?: TurnBudget): WorkflowDefinition {
    const { nodes, constraints } = createTurnCompileRegistries(pricedMediaResolver);
    return buildMediaTurn({
      models: ['img'],
      modality: 'image',
      params: { aspectRatio: '1:1' },
      nodes,
      constraints,
      ...(budget === undefined ? {} : { budget }),
    })._unsafeUnwrap();
  }

  function videoTurn(budget?: TurnBudget): WorkflowDefinition {
    const { nodes, constraints } = createTurnCompileRegistries(pricedMediaResolver);
    return buildMediaTurn({
      models: ['vid'],
      modality: 'video',
      params: { resolution: '720p', durationSeconds: 4 },
      nodes,
      constraints,
      ...(budget === undefined ? {} : { budget }),
    })._unsafeUnwrap();
  }

  it('stamps the payer tier + prompt-char count onto a media definition', () => {
    expect(imageTurn(paidBudget).storage).toEqual({ inputChars: 100, tier: 'paid' });
  });

  it('leaves a media definition unstamped when no budget is supplied', () => {
    expect(imageTurn().storage).toBeUndefined();
  });

  it('reserves image byte-storage + prompt char-storage at the settlement rates', () => {
    // Founder-ruled fix: a media turn's hold must reserve what settlement bills —
    // media byte-storage (estimated) + prompt char-storage — at the SAME nano
    // rates settlement charges (char 300n, byte 18n). The delta between the
    // stamped hold and the provider-only (unstamped) hold is EXACTLY that
    // storage, proving no spurious text-output char-storage rides a media node
    // (a media node produces zero output tokens).
    const estimateRun = createEstimateRun(pricedMediaResolver);
    const stamped = estimateRun(imageTurn(paidBudget))._unsafeUnwrap();
    const providerOnly = estimateRun(imageTurn())._unsafeUnwrap();
    const storage =
      100n * STORAGE_COST_PER_CHARACTER_NANO +
      BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    expect(stamped - providerOnly).toBe(storage);
    // 30_000n (100 chars × 300n) + 144_000_000n (8_000_000 bytes × 18n).
    expect(storage).toBe(144_030_000n);
  });

  it('reserves video byte-storage + prompt char-storage at the settlement rates', () => {
    const estimateRun = createEstimateRun(pricedMediaResolver);
    const stamped = estimateRun(videoTurn(paidBudget))._unsafeUnwrap();
    const providerOnly = estimateRun(videoTurn())._unsafeUnwrap();
    const storage =
      100n * STORAGE_COST_PER_CHARACTER_NANO +
      BigInt(4 * ESTIMATED_VIDEO_BYTES_PER_SECOND) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    expect(stamped - providerOnly).toBe(storage);
    // 30_000n (100 chars × 300n) + 360_000_000n (20_000_000 bytes × 18n).
    expect(storage).toBe(360_030_000n);
  });
});

describe('assertModelsProduceModality', () => {
  const resolve: ModelPricingResolver = (id) => {
    if (id === 'image-a' || id === 'image-b') return mediaDescriptorFor(id, 'image');
    return id === 'text-model' ? descriptorFor(id) : undefined;
  };

  it('is ok when every model produces the requested modality', () => {
    expect(assertModelsProduceModality(['image-a', 'image-b'], resolve, 'image').isOk()).toBe(true);
  });

  it('refuses the whole list when any model produces the wrong modality', () => {
    // Matches the text multi-model behavior (assertModelsWebSearchCapable /
    // compile): one bad model fails the whole build closed — no partial turn.
    expect(
      assertModelsProduceModality(['image-a', 'text-model'], resolve, 'image')._unsafeUnwrapErr()
        .code
    ).toBe('validation');
  });

  it('lets an unknown model fall through to the compile refusal', () => {
    expect(assertModelsProduceModality(['image-a', 'nope'], resolve, 'image').isOk()).toBe(true);
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

describe('buildSingleModelTurn promptInputTokens', () => {
  it('stamps promptInputTokens on the node (NOT in params — it is not a call parameter)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const answer = buildSingleModelTurn({
      model: 'answer-model',
      nodes,
      constraints,
      maxOutputTokens: 1234,
      promptInputTokens: 321,
    })
      ._unsafeUnwrap()
      .nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.promptInputTokens).toBe(321);
    // The provider call params still carry only the real call parameter.
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ maxOutputTokens: 1234 });
  });

  it('omits promptInputTokens when not supplied', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const answer = buildSingleModelTurn({ model: 'answer-model', nodes, constraints })
      ._unsafeUnwrap()
      .nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.promptInputTokens).toBeUndefined();
  });

  it('stamps promptInputTokens on every sibling of a multi-model turn', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildMultiModelTurn({
      models: ['model-a', 'model-b'],
      nodes,
      constraints,
      promptInputTokens: 77,
    })._unsafeUnwrap();
    for (const sibling of definition.nodes.filter((node) => node.type === 'modelCall')) {
      expect(sibling.promptInputTokens).toBe(77);
    }
  });
});

describe('withStorageStamp', () => {
  const paidBudget: TurnBudget = {
    promptCharacterCount: 100,
    funding: { kind: 'purchased', remainingNanoUsd: 1n },
  };
  const freeBudget: TurnBudget = {
    promptCharacterCount: 100,
    funding: { kind: 'free', remainingNanoUsd: 1n },
  };

  function singleTurn(): ReturnType<typeof buildSingleModelTurn> {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    return buildSingleModelTurn({ model: 'answer-model', nodes, constraints });
  }

  it('stamps the paid tier and prompt-char count for a purchased payer on a persisting turn', () => {
    const stamped = withStorageStamp(singleTurn()._unsafeUnwrap(), paidBudget, CHAT_TURN_HOOKS);
    expect(stamped.storage).toEqual({ inputChars: 100, tier: 'paid' });
  });

  it('stamps the free tier for a free-wallet payer', () => {
    const stamped = withStorageStamp(singleTurn()._unsafeUnwrap(), freeBudget, CHAT_TURN_HOOKS);
    expect(stamped.storage).toEqual({ inputChars: 100, tier: 'free' });
  });

  it('adds NO stamp under the trial (no-persist) hooks — a trial turn stores nothing', () => {
    // A trial send carries a budget with kind 'free', so without the hooks gate it
    // would wrongly be stamped 'free'. Trial persists nothing, so its hold must not
    // reserve storage.
    const stamped = withStorageStamp(singleTurn()._unsafeUnwrap(), freeBudget, TRIAL_TURN_HOOKS);
    expect(stamped.storage).toBeUndefined();
  });

  it('adds NO stamp when there is no budget (nothing to size the storage from)', () => {
    const stamped = withStorageStamp(singleTurn()._unsafeUnwrap(), undefined, CHAT_TURN_HOOKS);
    expect(stamped.storage).toBeUndefined();
  });

  it('sizes the admission hold storage at the tier ratio — paid = 2 chars/token, free = 4', () => {
    // The load-bearing money guarantee: a persisting chat turn's hold now covers
    // the storage settlement will bill, at the payer's exact tier ratio. The model
    // has context 1000 and no output cap, so the output leg is the full 1000-token
    // window; the stamp is the ONLY thing that differs between the two holds.
    const CHAR_RATE = STORAGE_COST_PER_CHARACTER_NANO;
    const estimateRun = createEstimateRun(resolver);
    const base = singleTurn()._unsafeUnwrap();

    const paidHold = estimateRun(
      withStorageStamp(base, paidBudget, CHAT_TURN_HOOKS)
    )._unsafeUnwrap();
    const freeHold = estimateRun(
      withStorageStamp(base, freeBudget, CHAT_TURN_HOOKS)
    )._unsafeUnwrap();
    const noStorage = estimateRun(base)._unsafeUnwrap();

    expect(outputCharsPerTokenForTier('paid')).toBe(2);
    expect(outputCharsPerTokenForTier('free')).toBe(4);
    // input storage (100 chars) once + output storage (1000 tokens × tier ratio).
    const paidStorage = 100n * CHAR_RATE + 1000n * 2n * CHAR_RATE;
    const freeStorage = 100n * CHAR_RATE + 1000n * 4n * CHAR_RATE;
    expect(paidHold - noStorage).toBe(paidStorage);
    expect(freeHold - noStorage).toBe(freeStorage);
    // The free hold reserves strictly more storage than the paid hold (4 vs 2).
    expect(freeHold > paidHold).toBe(true);
  });
});

describe('promptInputTokensFor', () => {
  it('estimates prompt input tokens at the paid ratio (4 chars/token) for a purchased payer', () => {
    const tokens = promptInputTokensFor({
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 1n, kind: 'purchased' },
    });
    expect(tokens).toBe(100);
  });

  it('estimates prompt input tokens at the conservative ratio (2 chars/token) for a free payer', () => {
    const tokens = promptInputTokensFor({
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 1n, kind: 'free' },
    });
    expect(tokens).toBe(200);
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

describe('regular turn answer cap fits payer funds via the ONE estimator', () => {
  // Regression + one-implementation pin: the regular single/multi-model turn sizes
  // its answer cap through the SAME canonical admission estimator its hold is priced
  // by (`createEstimateRun` + `reconcileAnswerCeiling`), not a parallel per-rate cost
  // formula. With tiny integer nano rates the per-rate markup rounds the 15% away, so
  // the upper-bound guess (`turnMaxOutputTokens`) OVER-reserves past the payer's funds
  // — the drift class that caused the 402s. The fit shrinks the cap until the estimator
  // agrees, so "sized-to-fit" ⇒ "ceiling ≤ funds" by construction.
  const WIDE_MODELS = new Set(['wide-a', 'wide-b']);
  const wideResolver: ModelPricingResolver = (id) =>
    WIDE_MODELS.has(id) ? { ...descriptorFor(id), limits: { contextLength: 128_000 } } : undefined;
  const budget: TurnBudget = {
    promptCharacterCount: 400,
    funding: { remainingNanoUsd: 50_000_000n, kind: 'free' },
  };
  const spendable = payerSpendableNanoUsd(budget);
  const estimate = createEstimateRun(wideResolver);

  function modelCallCaps(definition: WorkflowDefinition): unknown[] {
    return definition.nodes
      .filter((node) => node.type === 'modelCall')
      .map((node) => node.params['maxOutputTokens']);
  }

  it('shrinks a single-model turn cap so the estimator ceiling fits the payer funds', () => {
    const { nodes, constraints } = createTurnCompileRegistries(wideResolver);
    const pricings = turnModelPricings(['wide-a'], wideResolver);
    const guess = turnMaxOutputTokens(budget, pricings!);
    expect(typeof guess).toBe('number');
    const built = buildSingleModelTurn({
      model: 'wide-a',
      nodes,
      constraints,
      maxOutputTokens: guess!,
      promptInputTokens: promptInputTokensFor(budget),
    })._unsafeUnwrap();
    const stamped = withStorageStamp(built, budget, CHAT_TURN_HOOKS);
    // The upper-bound guess over-reserves past the payer's funds (the bug).
    expect(estimate(stamped)._unsafeUnwrap() > spendable).toBe(true);
    const fitted = reconcileAnswerCeiling(stamped, wideResolver, budget, guess);
    // The estimator now prices the fitted definition within the payer's funds...
    expect(estimate(fitted)._unsafeUnwrap() <= spendable).toBe(true);
    // ...and the authoritative cap shrank below the over-reserving guess.
    const cap = modelCallCaps(fitted)[0];
    expect(typeof cap === 'number' && cap < guess! && cap >= 1).toBe(true);
  });

  it('shrinks a multi-model turn shared cap so the estimator ceiling fits the payer funds', () => {
    const { nodes, constraints } = createTurnCompileRegistries(wideResolver);
    const pricings = turnModelPricings(['wide-a', 'wide-b'], wideResolver);
    const guess = turnMaxOutputTokens(budget, pricings!);
    expect(typeof guess).toBe('number');
    const built = buildMultiModelTurn({
      models: ['wide-a', 'wide-b'],
      nodes,
      constraints,
      maxOutputTokens: guess!,
      promptInputTokens: promptInputTokensFor(budget),
    })._unsafeUnwrap();
    const stamped = withStorageStamp(built, budget, CHAT_TURN_HOOKS);
    expect(estimate(stamped)._unsafeUnwrap() > spendable).toBe(true);
    const fitted = reconcileAnswerCeiling(stamped, wideResolver, budget, guess);
    expect(estimate(fitted)._unsafeUnwrap() <= spendable).toBe(true);
    // Every sibling carries the SAME shrunk cap (legacy applied one value to all).
    const caps = modelCallCaps(fitted);
    expect(caps).toHaveLength(2);
    expect(new Set(caps).size).toBe(1);
    const cap = caps[0];
    expect(typeof cap === 'number' && cap < guess! && cap >= 1).toBe(true);
  });
});
