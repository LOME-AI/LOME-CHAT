import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MEDIA_MIME_TYPES,
  ERROR_CODES,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  ReasoningWire,
  STORAGE_COST_PER_CHARACTER_NANO,
  nanoUSD,
} from '@hushbox/shared';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { outputCharsPerTokenForTier } from '@hushbox/shared/affordability/estimate/pre-adapters';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared/affordability/estimate/reasoning-plan';
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
  fitAnswerCapToCeiling,
  payerSpendableNanoUsd,
  promptInputTokensFor,
  reconcileAnswerCeiling,
  physicalAnswerCeiling,
  sharedAnswerCeiling,
  trialReasoningSelection,
  turnModelPricings,
  withStorageStamp,
} from './turn-definition.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID, TRIAL_TURN_HOOKS } from './constants.js';
import type { TurnBudget, TurnModelPricing } from './turn-definition.js';
import type { TurnReasoningEntry } from './turn-reasoning.js';
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

/** Billable per-token rates (fees baked at catalog ingestion); summed as-is. */
function pricingEntry(
  inputPerTokenNanoUsd: bigint,
  outputPerTokenNanoUsd: bigint,
  contextLength: number,
  maxOutputTokens?: number
): TurnModelPricing {
  return {
    inputPerTokenNanoUsd,
    outputPerTokenNanoUsd,
    contextLength,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

describe('physicalAnswerCeiling', () => {
  // Fixture rates: billable input 2000 / output 10_000 nano-USD per token. They
  // are present so a rate-bearing derivation WOULD have something to price with,
  // and every expectation below is independent of them — the ceiling is
  // `min(providerCap, contextHeadroom)` and carries no money term at all.
  const MODEL = pricingEntry(2000n, 10_000n, 1_000_000);
  const paid = (chars: number, remainingNanoUsd: bigint): TurnBudget => ({
    promptCharacterCount: chars,
    funding: { remainingNanoUsd, kind: 'purchased' },
  });

  it('is the context headroom when the model declares no completion cap', () => {
    // chars=400 → inputTokens=ceil(400/4)=100 (paid = 4 chars/token);
    // headroom = 1_000_000 − 100.
    expect(physicalAnswerCeiling(paid(400, 100_000_000n), [MODEL])).toBe(999_900);
  });

  it('is the provider completion cap when the context leaves more room', () => {
    expect(
      physicalAnswerCeiling(paid(400, 100_000_000n), [
        pricingEntry(2000n, 10_000n, 1_000_000, 8192),
      ])
    ).toBe(8192);
  });

  it('sizes the prompt at the payer tier ratio, so a free payer keeps less headroom', () => {
    // free = 2 chars/token → 200 input tokens against the paid tier's 100.
    const free: TurnBudget = {
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 100_000_000n, kind: 'free' },
    };
    expect(physicalAnswerCeiling(free, [MODEL])).toBe(999_800);
  });

  it('takes the WIDEST sibling`s room on a multi-model turn, so no sibling caps another', () => {
    // sibling a: headroom 100_000 − 100 = 99_900; sibling b: cap 9000. §Multi-Model 3
    // forbids the tight sibling from truncating the wide one, and each node clamps
    // itself when the cap is stamped, so the search's upper bound is the widest room.
    expect(
      physicalAnswerCeiling(paid(400, 100_000_000n), [
        pricingEntry(2000n, 10_000n, 100_000),
        pricingEntry(4000n, 20_000n, 50_000, 9000),
      ])
    ).toBe(99_900);
  });

  it('is undefined for an empty model list', () => {
    expect(physicalAnswerCeiling(paid(400, 100_000_000n), [])).toBeUndefined();
  });

  it('floors at one token when the prompt overruns the context window', () => {
    // 4000 chars → 1000 input tokens against a 500-token window: the fit needs a
    // positive upper bound, and a one-token answer is what admission then refuses.
    expect(
      physicalAnswerCeiling(paid(4000, 100_000_000n), [pricingEntry(2000n, 10_000n, 500)])
    ).toBe(1);
  });

  it('carries no money term — a broke payer and a rich one get the same bound', () => {
    // The money bound belongs to the ONE canonical admission estimator, applied by
    // `reconcileAnswerCeiling`; this function is only the search's upper bound, so
    // it cannot drift from the estimator the way a second cost formula would.
    expect(physicalAnswerCeiling(paid(400, 1n), [MODEL])).toBe(
      physicalAnswerCeiling(paid(400, 10_000_000_000_000n), [MODEL])
    );
  });
});

describe('sharedAnswerCeiling', () => {
  // One cap that must fit EVERY model — the Smart Model slot's shape, where a
  // single composite node's cap rides whichever candidate the classifier picks.
  const paid = (chars: number, remainingNanoUsd: bigint): TurnBudget => ({
    promptCharacterCount: chars,
    funding: { remainingNanoUsd, kind: 'purchased' },
  });

  it('takes the tightest room across the models', () => {
    // sibling a: headroom 100_000 − 100 = 99_900; sibling b: cap 9000.
    expect(
      sharedAnswerCeiling(paid(400, 100_000_000n), [
        pricingEntry(2000n, 10_000n, 100_000),
        pricingEntry(4000n, 20_000n, 50_000, 9000),
      ])
    ).toBe(9000);
  });

  it('is undefined for an empty model list', () => {
    expect(sharedAnswerCeiling(paid(400, 100_000_000n), [])).toBeUndefined();
  });

  it('is the same as the per-node bound for a single model, where widest and tightest coincide', () => {
    const one = [pricingEntry(2000n, 10_000n, 1_000_000, 8192)];
    expect(sharedAnswerCeiling(paid(400, 100_000_000n), one)).toBe(
      physicalAnswerCeiling(paid(400, 100_000_000n), one)
    );
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

  it('carries the catalog maxOutputTokens limit when present', () => {
    const capped: ModelPricingResolver = (id) => ({
      ...descriptorFor(id),
      limits: { contextLength: 1000, maxOutputTokens: 300 },
    });
    expect(turnModelPricings(['answer-model'], capped)).toEqual([
      {
        inputPerTokenNanoUsd: 2n,
        outputPerTokenNanoUsd: 3n,
        contextLength: 1000,
        maxOutputTokens: 300,
      },
    ]);
  });

  it('leaves maxOutputTokens absent when the catalog carries no completion cap', () => {
    const pricings = turnModelPricings(['answer-model'], resolver);
    expect(pricings?.[0]).not.toHaveProperty('maxOutputTokens');
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
  // formula. The upper bound it starts from is physical only
  // (`physicalAnswerCeiling`), so the money question is asked exactly once; the fit
  // shrinks the cap until the estimator agrees, which makes "sized-to-fit" ⇒
  // "ceiling ≤ funds" by construction.
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

  it('fits a single-model turn cap so the estimator ceiling stays within the payer funds', () => {
    const { nodes, constraints } = createTurnCompileRegistries(wideResolver);
    const pricings = turnModelPricings(['wide-a'], wideResolver);
    const guess = physicalAnswerCeiling(budget, pricings!);
    expect(typeof guess).toBe('number');
    const built = buildSingleModelTurn({
      model: 'wide-a',
      nodes,
      constraints,
      maxOutputTokens: guess!,
      promptInputTokens: promptInputTokensFor(budget),
    })._unsafeUnwrap();
    const stamped = withStorageStamp(built, budget, CHAT_TURN_HOOKS);
    const fitted = reconcileAnswerCeiling(stamped, wideResolver, budget, guess);
    // Sized-to-fit ⇒ ceiling ≤ funds, by the same canonical estimator that
    // prices the admission hold: the physical bound can only be kept or shrunk
    // by the fit, never inflated past funds.
    expect(estimate(fitted)._unsafeUnwrap() <= spendable).toBe(true);
    const cap = modelCallCaps(fitted)[0];
    expect(typeof cap === 'number' && cap <= guess! && cap >= 1).toBe(true);
  });

  it('fits a multi-model turn shared cap so the estimator ceiling stays within the payer funds', () => {
    const { nodes, constraints } = createTurnCompileRegistries(wideResolver);
    const pricings = turnModelPricings(['wide-a', 'wide-b'], wideResolver);
    const guess = physicalAnswerCeiling(budget, pricings!);
    expect(typeof guess).toBe('number');
    const built = buildMultiModelTurn({
      models: ['wide-a', 'wide-b'],
      nodes,
      constraints,
      maxOutputTokens: guess!,
      promptInputTokens: promptInputTokensFor(budget),
    })._unsafeUnwrap();
    const stamped = withStorageStamp(built, budget, CHAT_TURN_HOOKS);
    const fitted = reconcileAnswerCeiling(stamped, wideResolver, budget, guess);
    expect(estimate(fitted)._unsafeUnwrap() <= spendable).toBe(true);
    // Both siblings have the same physical room here, so the shared money-derived
    // headroom lands identically on each; the heterogeneous case below is what shows
    // the clamp is per sibling rather than one tightest-sibling value.
    const caps = modelCallCaps(fitted);
    expect(caps).toHaveLength(2);
    expect(new Set(caps).size).toBe(1);
    const cap = caps[0];
    expect(typeof cap === 'number' && cap <= guess! && cap >= 1).toBe(true);
  });

  it('gives a heterogeneous pair each sibling its own cap, so the tight one cannot truncate the wide one', () => {
    // §Multi-Model 3. Rich purchased payer, so the money term does not bind and only
    // the physical bounds decide: 400 chars at 4 chars/token = 100 input tokens, so
    // wide-a keeps 128,000 − 100 = 127,900 while the tight sibling keeps
    // min(4,000 cap, 4,000 − 100) = 3,900. One shared tightest-sibling cap would have
    // stamped 3,900 on both and truncated the wide sibling by 124,000 tokens.
    const mixedLimits = new Map<string, ModelDescriptor['limits']>([
      ['wide-a', { contextLength: 128_000 }],
      ['tight-a', { contextLength: 4000, maxOutputTokens: 4000 }],
    ]);
    const mixedResolver: ModelPricingResolver = (id) => {
      const limits = mixedLimits.get(id);
      return limits === undefined ? undefined : { ...descriptorFor(id), limits };
    };
    const richBudget: TurnBudget = {
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 5_000_000_000n, kind: 'purchased' },
    };
    const { nodes, constraints } = createTurnCompileRegistries(mixedResolver);
    const models = ['wide-a', 'tight-a'];
    const guess = physicalAnswerCeiling(richBudget, turnModelPricings(models, mixedResolver)!);
    // The search's upper bound is the WIDEST room, not the tightest.
    expect(guess).toBe(127_900);
    const built = buildMultiModelTurn({
      models,
      nodes,
      constraints,
      maxOutputTokens: guess!,
      promptInputTokens: promptInputTokensFor(richBudget),
    })._unsafeUnwrap();
    const stamped = withStorageStamp(built, richBudget, CHAT_TURN_HOOKS);
    const fitted = reconcileAnswerCeiling(stamped, mixedResolver, richBudget, guess);
    expect(modelCallCaps(fitted)).toEqual([127_900, 3900]);
    // And the hold still fits: per-sibling clamping only ever lowers a cap.
    const priced = createEstimateRun(mixedResolver)(fitted)._unsafeUnwrap();
    expect(priced <= payerSpendableNanoUsd(richBudget)).toBe(true);
  });

  it('floors the cap at a minimum viable answer and stays over funds when even that over-reserves', () => {
    // Pins the fail-closed money-safety floor: a free-tier payer has no cushion, so
    // 1 nano-USD of balance is 1 nano-USD spendable — below even the smallest useful
    // answer's estimator ceiling. §Affordability 6 makes a minimum viable answer THE
    // minimum, so the fit stops there rather than offering a shorter one, and the
    // sized definition is STILL priced above the payer's funds → admission's balance
    // gate refuses the run.
    const { nodes, constraints } = createTurnCompileRegistries(wideResolver);
    const brokeBudget: TurnBudget = {
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 1n, kind: 'free' },
    };
    const spendableBroke = payerSpendableNanoUsd(brokeBudget);
    const guess = 1000;
    const built = buildSingleModelTurn({
      model: 'wide-a',
      nodes,
      constraints,
      maxOutputTokens: guess,
      promptInputTokens: promptInputTokensFor(brokeBudget),
    })._unsafeUnwrap();
    const stamped = withStorageStamp(built, brokeBudget, CHAT_TURN_HOOKS);
    const fitted = reconcileAnswerCeiling(stamped, wideResolver, brokeBudget, guess);
    // The cap floored at the minimum viable answer...
    expect(modelCallCaps(fitted)[0]).toBe(MINIMUM_OUTPUT_TOKENS);
    // ...and even that floored ceiling exceeds the payer's funds — fail closed, not silently under-reserved.
    expect(estimate(fitted)._unsafeUnwrap() > spendableBroke).toBe(true);
  });
});

describe('reasoning-bearing turn builds', () => {
  const LOW_B = REASONING_BUDGET_TOKENS_BY_EFFORT.low;
  const LOW_ENTRY: TurnReasoningEntry = {
    effort: 'low',
    wire: ReasoningWire.parse({ effort: 'low' }),
    reasoningBudgetTokens: LOW_B,
  };

  function answerParamsOf(definition: WorkflowDefinition): Record<string, unknown> {
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing');
    return answer.params;
  }

  it('writes the reasoning wire and a B+H completion cap onto the answer node', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const built = buildSingleModelTurn({
      model: 'answer-model',
      nodes,
      constraints,
      maxOutputTokens: 5000,
      reasoning: LOW_ENTRY,
    })._unsafeUnwrap();
    expect(answerParamsOf(built)).toEqual({
      maxOutputTokens: LOW_B + 5000,
      reasoning: { effort: 'low' },
    });
  });

  it('writes the hard-off wire with the reasoning-free answer cap (B=0, cap = H alone)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const built = buildSingleModelTurn({
      model: 'answer-model',
      nodes,
      constraints,
      maxOutputTokens: 5000,
      reasoning: {
        effort: 'off',
        wire: ReasoningWire.parse({ enabled: false }),
        reasoningBudgetTokens: 0,
      },
    })._unsafeUnwrap();
    expect(answerParamsOf(built)).toEqual({
      maxOutputTokens: 5000,
      reasoning: { enabled: false },
    });
  });

  it('omits the cap on a hard-off node with no derivable ceiling (mirrors the reasoning-free turn)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const built = buildSingleModelTurn({
      model: 'answer-model',
      nodes,
      constraints,
      reasoning: {
        effort: 'off',
        wire: ReasoningWire.parse({ enabled: false }),
        reasoningBudgetTokens: 0,
      },
    })._unsafeUnwrap();
    expect(answerParamsOf(built)).toEqual({ reasoning: { enabled: false } });
  });

  it('keeps an explicit completion cap on a reasoning call even with no derivable headroom (G2)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const built = buildSingleModelTurn({
      model: 'answer-model',
      nodes,
      constraints,
      reasoning: LOW_ENTRY,
    })._unsafeUnwrap();
    expect(answerParamsOf(built)).toEqual({
      maxOutputTokens: LOW_B + MINIMUM_OUTPUT_TOKENS,
      reasoning: { effort: 'low' },
    });
  });

  it('writes each sibling its own reasoning wire and B_i+H cap on a multi-model turn', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const built = buildMultiModelTurn({
      models: ['model-a', 'model-b'],
      nodes,
      constraints,
      maxOutputTokens: 500,
      reasoning: new Map<string, TurnReasoningEntry>([
        ['model-a', LOW_ENTRY],
        [
          'model-b',
          {
            effort: 'low',
            wire: ReasoningWire.parse({ max_tokens: 2048 }),
            reasoningBudgetTokens: 2048,
          },
        ],
      ]),
    })._unsafeUnwrap();
    const siblings = built.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings.map((node) => node.params)).toEqual([
      { maxOutputTokens: LOW_B + 500, reasoning: { effort: 'low' } },
      { maxOutputTokens: 2048 + 500, reasoning: { max_tokens: 2048 } },
    ]);
  });

  it('leaves a sibling without an entry reasoning-free on a mixed multi-model turn', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const built = buildMultiModelTurn({
      models: ['model-a', 'model-b'],
      nodes,
      constraints,
      maxOutputTokens: 500,
      reasoning: new Map<string, TurnReasoningEntry>([['model-a', LOW_ENTRY]]),
    })._unsafeUnwrap();
    const siblings = built.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings.map((node) => node.params)).toEqual([
      { maxOutputTokens: LOW_B + 500, reasoning: { effort: 'low' } },
      { maxOutputTokens: 500 },
    ]);
  });
});

/** A wide-context, open-effort reasoning model resolver shared by the fit tests. */
const REASONING_WIDE_MODELS = new Set(['wide-a']);
const reasoningResolver: ModelPricingResolver = (id) =>
  REASONING_WIDE_MODELS.has(id)
    ? {
        ...descriptorFor(id),
        limits: { contextLength: 128_000 },
        reasoning: { supportedEfforts: null },
      }
    : undefined;

describe('reasoning answer cap fitting (B constant, H sized)', () => {
  // The fit searches the ANSWER headroom H; every answer node's wire cap is
  // its own reasoning budget B plus the shared H — B never shrinks (the level
  // was the user's explicit ask; G3), H is what affordability sizes.
  const LOW_B = REASONING_BUDGET_TOKENS_BY_EFFORT.low;
  const budget: TurnBudget = {
    promptCharacterCount: 400,
    funding: { remainingNanoUsd: 100_000_000n, kind: 'purchased' },
  };

  function builtWith(entry: TurnReasoningEntry, headroom: number): WorkflowDefinition {
    const { nodes, constraints } = createTurnCompileRegistries(reasoningResolver);
    const built = buildSingleModelTurn({
      model: 'wide-a',
      nodes,
      constraints,
      maxOutputTokens: headroom,
      reasoning: entry,
      promptInputTokens: promptInputTokensFor(budget),
    })._unsafeUnwrap();
    return withStorageStamp(built, budget, CHAT_TURN_HOOKS);
  }

  function capOf(definition: WorkflowDefinition): number {
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing');
    const cap = answer.params['maxOutputTokens'];
    if (typeof cap !== 'number') throw new Error('expected a numeric cap');
    return cap;
  }

  it('fits the definition within the payer funds while preserving B and the wire', () => {
    const pricings = turnModelPricings(['wide-a'], reasoningResolver);
    // The physical room LESS the constant reasoning budget: the searched quantity
    // is the answer headroom H, and the wire cap is B + H.
    const guess = physicalAnswerCeiling(budget, pricings!)! - LOW_B;
    const entry: TurnReasoningEntry = {
      effort: 'low',
      wire: ReasoningWire.parse({ effort: 'low' }),
      reasoningBudgetTokens: LOW_B,
    };
    const stamped = builtWith(entry, guess);
    const fitted = reconcileAnswerCeiling(stamped, reasoningResolver, budget, guess);
    const estimate = createEstimateRun(reasoningResolver);
    const spendable = payerSpendableNanoUsd(budget);
    expect(estimate(fitted)._unsafeUnwrap() <= spendable).toBe(true);
    const cap = capOf(fitted);
    // B rides the cap as a constant term; only H shrank (or held).
    expect(cap - LOW_B).toBeGreaterThanOrEqual(1);
    expect(cap - LOW_B).toBeLessThanOrEqual(guess);
    const answer = fitted.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params['reasoning']).toEqual({ effort: 'low' });
  });

  it('floors the answer headroom at a minimum viable answer above B when even that over-reserves', () => {
    const entry: TurnReasoningEntry = {
      effort: 'low',
      wire: ReasoningWire.parse({ effort: 'low' }),
      reasoningBudgetTokens: LOW_B,
    };
    const stamped = builtWith(entry, 1000);
    const floored = fitAnswerCapToCeiling(stamped, reasoningResolver, 1000, 1n).definition;
    expect(capOf(floored)).toBe(LOW_B + MINIMUM_OUTPUT_TOKENS);
  });

  it('re-derives B from a budget-native max_tokens wire when refitting', () => {
    const entry: TurnReasoningEntry = {
      effort: 'low',
      wire: ReasoningWire.parse({ max_tokens: LOW_B }),
      reasoningBudgetTokens: LOW_B,
    };
    const stamped = builtWith(entry, 1000);
    const floored = fitAnswerCapToCeiling(stamped, reasoningResolver, 1000, 1n).definition;
    expect(capOf(floored)).toBe(LOW_B + MINIMUM_OUTPUT_TOKENS);
  });

  it('re-derives B as 0 from the hard-off wire when refitting', () => {
    const entry: TurnReasoningEntry = {
      effort: 'off',
      wire: ReasoningWire.parse({ enabled: false }),
      reasoningBudgetTokens: 0,
    };
    const stamped = builtWith(entry, 1000);
    const floored = fitAnswerCapToCeiling(stamped, reasoningResolver, 1000, 1n).definition;
    expect(capOf(floored)).toBe(MINIMUM_OUTPUT_TOKENS);
  });

  it('re-derives B positionally from a native non-canonical effort wire when refitting', () => {
    // xhigh sits at the High rung of this two-word ladder, so its budget is
    // the High tier — never 0, never the word's own (absent) tier.
    const HIGH_B = REASONING_BUDGET_TOKENS_BY_EFFORT.high;
    const xhighResolver: ModelPricingResolver = (id) =>
      REASONING_WIDE_MODELS.has(id)
        ? {
            ...descriptorFor(id),
            limits: { contextLength: 128_000 },
            reasoning: { supportedEfforts: ['xhigh', 'high'] },
          }
        : undefined;
    const entry: TurnReasoningEntry = {
      effort: 'high',
      wire: ReasoningWire.parse({ effort: 'xhigh' }),
      reasoningBudgetTokens: HIGH_B,
    };
    const stamped = builtWith(entry, 1000);
    const floored = fitAnswerCapToCeiling(stamped, xhighResolver, 1000, 1n).definition;
    expect(capOf(floored)).toBe(HIGH_B + MINIMUM_OUTPUT_TOKENS);
  });
});

describe('trialReasoningSelection', () => {
  // A trial turn persists nothing, so §Trial Usage gives it no storage term at all
  // and the 1¢ ceiling buys purely provider tokens. Rates are therefore chosen so the
  // MONEY term actually binds: at 1,500 billable nano per output token,
  // `low` costs 3 × 1,000 + (4,096 + 1,000) × 1,500 = 7,647,000 nano and fits the
  // 10,000,000-nano ceiling, while `medium` costs
  // 3 × 1,000 + (12,288 + 1,000) × 1,500 = 19,935,000 and does not. A 2–3 nano
  // fixture cannot tell the two apart — every level fits — so it would pin nothing.
  function trialDescriptor(reasoning?: ModelDescriptor['reasoning']): ModelDescriptor {
    return {
      ...descriptorFor('trial-model'),
      limits: { contextLength: 1_000_000 },
      pricing: { inputPerToken: nanoUSD(1000n), outputPerToken: nanoUSD(1500n) },
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }
  const budget: TurnBudget = {
    promptCharacterCount: 5,
    funding: { remainingNanoUsd: 10_000_000n, kind: 'free' },
  };

  it('accepts a level whose plan fits the trial ceiling', () => {
    const decision = trialReasoningSelection(
      trialDescriptor({ supportedEfforts: null }),
      budget,
      'low'
    )._unsafeUnwrap();
    expect(decision).toEqual({ accepted: true, selection: 'low' });
  });

  it('refuses a level whose plan exceeds the trial ceiling (G9 — computed, not hardcoded)', () => {
    const decision = trialReasoningSelection(
      trialDescriptor({ supportedEfforts: null }),
      budget,
      'medium'
    )._unsafeUnwrap();
    expect(decision).toEqual({ accepted: false });
  });

  it("resolves 'auto' reasoning-free when the model offers multiple choices (no static pick)", () => {
    // Multi-choice auto is classifier-owned; the trial build has no
    // classifier stage on this path, so auto degrades honestly — never
    // through a static preference order.
    const decision = trialReasoningSelection(
      trialDescriptor({ supportedEfforts: null }),
      budget,
      'auto'
    )._unsafeUnwrap();
    expect(decision).toEqual({ accepted: true, selection: undefined });
  });

  it("resolves 'auto' on a non-reasoning model to no reasoning", () => {
    const decision = trialReasoningSelection(trialDescriptor(), budget, 'auto')._unsafeUnwrap();
    expect(decision).toEqual({ accepted: true, selection: undefined });
  });

  it("picks the sole real choice deterministically on a Min-only model ('auto' → 'off')", () => {
    // A disableable model with no offered rungs has exactly one real choice
    // (Min), so auto picks it with no classifier and no reserve (§Effort 5).
    const decision = trialReasoningSelection(
      trialDescriptor({ supportedEfforts: ['none'] }),
      budget,
      'auto'
    )._unsafeUnwrap();
    expect(decision).toEqual({ accepted: true, selection: 'off' });
  });

  it("passes 'off' through untouched (the build owns the mandatory refusal)", () => {
    const decision = trialReasoningSelection(trialDescriptor(), budget, 'off')._unsafeUnwrap();
    expect(decision).toEqual({ accepted: true, selection: 'off' });
  });

  it('surfaces an infeasible explicit level as the validation error (400, not 402)', () => {
    const result = trialReasoningSelection(trialDescriptor(), budget, 'low');
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('reasoning budget re-derivation defensives', () => {
  // `nodeReasoningBudgetTokens` falls back to B=0 when the wire cannot be
  // re-derived — an unknown model or a descriptor with no reasoning object.
  // Both are defensive (a compiled turn's models resolve, and its wires came
  // from the plan): the floor cap is then the bare answer token, never a crash.
  const LOW_ENTRY: TurnReasoningEntry = {
    effort: 'low',
    wire: ReasoningWire.parse({ effort: 'low' }),
    reasoningBudgetTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.low,
  };

  function reasoningStamped(): WorkflowDefinition {
    const { nodes, constraints } = createTurnCompileRegistries(reasoningResolver);
    return buildSingleModelTurn({
      model: 'wide-a',
      nodes,
      constraints,
      maxOutputTokens: 1000,
      reasoning: LOW_ENTRY,
    })._unsafeUnwrap();
  }

  function flooredCap(resolver: ModelPricingResolver): unknown {
    const floored = fitAnswerCapToCeiling(reasoningStamped(), resolver, 1000, 1n).definition;
    const answer = floored.nodes.find((node) => node.type === 'modelCall');
    return answer?.type === 'modelCall' ? answer.params['maxOutputTokens'] : undefined;
  }

  it('treats an unresolvable model as B=0 when refitting', () => {
    // The shared KNOWN_MODELS resolver does not know 'wide-a'.
    expect(flooredCap(resolver)).toBe(MINIMUM_OUTPUT_TOKENS);
  });

  it('treats an effort wire on a non-reasoning descriptor as B=0 when refitting', () => {
    expect(flooredCap((id) => ({ ...descriptorFor(id), limits: { contextLength: 128_000 } }))).toBe(
      MINIMUM_OUTPUT_TOKENS
    );
  });
});
