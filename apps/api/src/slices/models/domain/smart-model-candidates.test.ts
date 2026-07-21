import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  MAX_CLASSIFIER_CONTEXT_CHARS,
  computeClassifierPromptOverhead,
  estimateTokensForTier,
  nanoUSD,
} from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import { callBaseNanoUsd, estimateRunCeilingNanoUsd } from './estimate.js';
import {
  CLASSIFIER_CHARS_PER_TOKEN,
  buildSmartModelCandidates,
  classifierWorstCaseBaseNanoUsd,
} from './smart-model-candidates.js';
import type { Modality, ModelDescriptor, Pricing } from '@hushbox/shared';

function descriptorOf(params: {
  readonly id: string;
  readonly inputRate: bigint;
  readonly outputRate: bigint;
  readonly contextLength?: number | undefined;
  readonly outputs?: readonly Modality[];
  readonly description?: string;
}): ModelDescriptor {
  const pricing: Pricing = {
    inputPerToken: nanoUSD(params.inputRate),
    outputPerToken: nanoUSD(params.outputRate),
  };
  return {
    id: params.id,
    provider: 'openrouter',
    version: '1',
    inputs: ['text'],
    outputs: [...(params.outputs ?? ['text'])],
    parameters: {},
    behaviors: ['streaming'],
    limits: params.contextLength === undefined ? {} : { contextLength: params.contextLength },
    pricing,
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
    ...(params.description === undefined ? {} : { description: params.description }),
  };
}

// Cheap: combined 3n/token, context 1000. Ceiling base = 1000×1 + 1000×2 = 3000.
const CHEAP = descriptorOf({
  id: 'cheap/model',
  inputRate: 1n,
  outputRate: 2n,
  contextLength: 1000,
  description: 'cheap and fast',
});
// Mid: combined 30n/token, context 1000. Ceiling base = 30_000.
const MID = descriptorOf({
  id: 'mid/model',
  inputRate: 10n,
  outputRate: 20n,
  contextLength: 1000,
});
// Big: combined 3000n/token, context 2000. Ceiling base = 2000×1000 + 2000×2000 = 6_000_000.
const BIG = descriptorOf({
  id: 'big/model',
  inputRate: 1000n,
  outputRate: 2000n,
  contextLength: 2000,
  description: 'strong reasoning',
});

/** The exact classifier reserve the builder computes for a candidate list. */
function classifierReserve(
  classifier: ModelDescriptor,
  textCatalog: readonly ModelDescriptor[]
): bigint {
  const overheadChars = computeClassifierPromptOverhead(
    textCatalog.map((descriptor) => ({
      id: descriptor.id,
      description: descriptor.description ?? '',
    }))
  );
  const inputTokens = Math.ceil(
    (MAX_CLASSIFIER_CONTEXT_CHARS + overheadChars) / CLASSIFIER_CHARS_PER_TOKEN
  );
  return applyMarkup(
    callBaseNanoUsd(classifier.pricing, {
      kind: 'tokens',
      inputTokens,
      outputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP,
    })._unsafeUnwrap()
  );
}

/** The exact full-context turn ceiling the builder prices a candidate at. */
function turnCeiling(descriptor: ModelDescriptor): bigint {
  const contextLength = descriptor.limits['contextLength'] ?? 0;
  return estimateRunCeilingNanoUsd(
    descriptor.pricing,
    { kind: 'tokens', inputTokens: contextLength, outputTokens: contextLength },
    { maxFanOutWidth: 1, maxSteps: 1, maxIterations: 1 }
  )._unsafeUnwrap();
}

const HUGE_BALANCE = 10n ** 15n;

describe('classifierWorstCaseBaseNanoUsd', () => {
  it('derives classifier input tokens from the shared estimateTokensForTier helper', () => {
    const classifier = descriptorOf({ id: 'cls/model', inputRate: 1000n, outputRate: 2000n });
    const catalog = [classifier];
    const overheadChars = computeClassifierPromptOverhead(
      catalog.map((d) => ({ id: d.id, description: d.description ?? '' }))
    );
    const expectedInputTokens = estimateTokensForTier(
      'trial',
      MAX_CLASSIFIER_CONTEXT_CHARS + overheadChars
    );
    const expectedBase =
      BigInt(expectedInputTokens) * 1000n + BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * 2000n;
    expect(classifierWorstCaseBaseNanoUsd(classifier, catalog)).toBe(expectedBase);
  });
});

describe('buildSmartModelCandidates', () => {
  it('sorts candidates ascending by combined base price with the cheapest as classifier', () => {
    const result = buildSmartModelCandidates({
      descriptors: [BIG, CHEAP, MID],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(result?.classifierModelId).toBe('cheap/model');
    expect(result?.candidates.map((candidate) => candidate.id)).toEqual([
      'cheap/model',
      'mid/model',
      'big/model',
    ]);
  });

  it('carries descriptions through and omits them where the catalog has none', () => {
    const result = buildSmartModelCandidates({
      descriptors: [CHEAP, MID],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(result?.candidates[0]).toEqual({ id: 'cheap/model', description: 'cheap and fast' });
    expect(result?.candidates[1]).toEqual({ id: 'mid/model' });
  });

  it('keeps both models when two share the same combined price (a sort tie)', () => {
    // Equal combined base price exercises the ascending-comparator tie branch;
    // both models stay in the menu.
    const tieA = descriptorOf({
      id: 'tie-a/model',
      inputRate: 5n,
      outputRate: 5n,
      contextLength: 1000,
    });
    const tieB = descriptorOf({
      id: 'tie-b/model',
      inputRate: 5n,
      outputRate: 5n,
      contextLength: 1000,
    });
    const result = buildSmartModelCandidates({
      descriptors: [tieA, tieB],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(result?.candidates.map((candidate) => candidate.id).toSorted()).toEqual([
      'tie-a/model',
      'tie-b/model',
    ]);
  });

  it('stamps a balance-INDEPENDENT menu: the full priceable set, never a balance-scaled subset', () => {
    const reserve = classifierReserve(CHEAP, [CHEAP, BIG]);
    // A balance that funds the cheap model but NOT big's full-context worst
    // case: the OLD affordability filter admitted only [cheap]; the fixed menu
    // stamps the full priceable set regardless.
    const modest = reserve + turnCeiling(CHEAP);
    const modestMenu = buildSmartModelCandidates({
      descriptors: [CHEAP, BIG],
      balanceNanoUsd: modest,
    });
    const richMenu = buildSmartModelCandidates({
      descriptors: [CHEAP, BIG],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(modestMenu?.candidates.map((candidate) => candidate.id)).toEqual([
      'cheap/model',
      'big/model',
    ]);
    // The menu does not vary with the balance — modest and huge stamp the same.
    expect(modestMenu?.candidates.map((candidate) => candidate.id)).toEqual(
      richMenu?.candidates.map((candidate) => candidate.id)
    );
  });

  it('refuses the whole turn (binary gate) when the wallet cannot afford even the cheapest candidate', () => {
    const reserve = classifierReserve(CHEAP, [CHEAP, BIG]);
    // One nano below the cheapest candidate's full-context floor: a genuinely
    // under-funded wallet, refused outright rather than handed a shrunken menu.
    const belowCheapest = reserve + turnCeiling(CHEAP) - 1n;
    expect(
      buildSmartModelCandidates({ descriptors: [CHEAP, BIG], balanceNanoUsd: belowCheapest })
    ).toBeNull();
  });

  it('includes a multimodal-INPUT text model (Smart Model only ever sends text)', () => {
    const vision: ModelDescriptor = {
      ...descriptorOf({ id: 'vision/model', inputRate: 1n, outputRate: 1n, contextLength: 1000 }),
      inputs: ['text', 'image'],
    };
    const result = buildSmartModelCandidates({
      descriptors: [CHEAP, vision],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(result?.candidates.map((candidate) => candidate.id)).toEqual([
      'vision/model',
      'cheap/model',
    ]);
  });

  it('excludes non-text models (media and text+media) from candidacy', () => {
    const imageModel = descriptorOf({
      id: 'img/model',
      inputRate: 1n,
      outputRate: 1n,
      contextLength: 1000,
      outputs: ['image'],
    });
    const multiModel = descriptorOf({
      id: 'multi/model',
      inputRate: 1n,
      outputRate: 1n,
      contextLength: 1000,
      outputs: ['text', 'image'],
    });
    const result = buildSmartModelCandidates({
      descriptors: [CHEAP, imageModel, multiModel],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(result?.candidates.map((candidate) => candidate.id)).toEqual(['cheap/model']);
  });

  it('excludes an unpriceable candidate (no context length) without failing the rest', () => {
    const unpriceable = descriptorOf({ id: 'nolimit/model', inputRate: 5n, outputRate: 5n });
    const result = buildSmartModelCandidates({
      descriptors: [CHEAP, unpriceable],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(result?.candidates.map((candidate) => candidate.id)).toEqual(['cheap/model']);
  });

  it('returns null when no candidate is affordable', () => {
    expect(buildSmartModelCandidates({ descriptors: [CHEAP, MID], balanceNanoUsd: 0n })).toBeNull();
  });

  it('returns null for a catalog with no text models', () => {
    const imageModel = descriptorOf({
      id: 'img/model',
      inputRate: 1n,
      outputRate: 1n,
      contextLength: 1000,
      outputs: ['image'],
    });
    expect(
      buildSmartModelCandidates({ descriptors: [imageModel], balanceNanoUsd: HUGE_BALANCE })
    ).toBeNull();
  });

  it('exposes the classifier worst-case reserve it filtered against', () => {
    const result = buildSmartModelCandidates({
      descriptors: [CHEAP, MID],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(result?.classifierWorstCaseNanoUsd).toBe(classifierReserve(CHEAP, [CHEAP, MID]));
  });

  it('returns null when the cheapest text model has no per-token rates to reserve against', () => {
    // Missing rates sort as combined 0n, so this model IS the classifier pick;
    // an unpriceable classifier reserve fails the whole list closed.
    const rateless: ModelDescriptor = {
      ...descriptorOf({ id: 'free/model', inputRate: 1n, outputRate: 1n, contextLength: 1000 }),
      pricing: {},
    };
    expect(
      buildSmartModelCandidates({ descriptors: [rateless, MID], balanceNanoUsd: HUGE_BALANCE })
    ).toBeNull();
  });

  it('excludes a candidate whose rates are missing even with a context length', () => {
    const rateless: ModelDescriptor = {
      ...descriptorOf({ id: 'norates/model', inputRate: 1n, outputRate: 1n, contextLength: 1000 }),
      pricing: { inputPerToken: nanoUSD(50n) },
    };
    const result = buildSmartModelCandidates({
      descriptors: [CHEAP, rateless],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(result?.candidates.map((candidate) => candidate.id)).toEqual(['cheap/model']);
  });
});
