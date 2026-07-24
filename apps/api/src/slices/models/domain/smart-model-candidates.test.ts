import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  MAX_CLASSIFIER_CONTEXT_CHARS,
  MINIMUM_OUTPUT_TOKENS,
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
  pickEffortClassifier,
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
  // Rates are billable at ingestion — the shared gate's reserve is the raw
  // provider fold, no fee math.
  return callBaseNanoUsd(classifier.pricing, {
    kind: 'tokens',
    inputTokens,
    outputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP,
  })._unsafeUnwrap();
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
    expect(result?.candidates[0]).toMatchObject({
      id: 'cheap/model',
      description: 'cheap and fast',
    });
    expect(result?.candidates[1]).toMatchObject({ id: 'mid/model' });
    expect(result?.candidates[1]).not.toHaveProperty('description');
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

  it('keeps only the AFFORDABLE subset when the wallet funds the cheap model but not the expensive one', () => {
    const reserve = classifierReserve(CHEAP, [CHEAP, BIG]);
    // A balance that funds cheap's floor + reserve but NOT big's far larger
    // floor: the affordable-subset gate admits [cheap] alone (legacy behavior),
    // and admission then reserves only that cheaper model's worst case.
    const modest = reserve + turnCeiling(CHEAP);
    const modestMenu = buildSmartModelCandidates({
      descriptors: [CHEAP, BIG],
      balanceNanoUsd: modest,
    });
    expect(modestMenu?.candidates.map((candidate) => candidate.id)).toEqual(['cheap/model']);
  });

  it('grows the affordable subset with the balance: a well-funded wallet keeps the full pool', () => {
    // A large wallet affords every candidate's worst case, so the subset is the
    // whole priceable pool — the well-funded concurrency case is not regressed.
    const richMenu = buildSmartModelCandidates({
      descriptors: [CHEAP, BIG],
      balanceNanoUsd: HUGE_BALANCE,
    });
    expect(richMenu?.candidates.map((candidate) => candidate.id)).toEqual([
      'cheap/model',
      'big/model',
    ]);
  });

  it('refuses the whole turn (binary gate) when the wallet cannot afford even the cheapest candidate', () => {
    const reserve = classifierReserve(CHEAP, [CHEAP, BIG]);
    // Exactly the classifier reserve leaves a $0 answer budget, so no candidate
    // can produce a minimum answer (cap(m) = 0 < MINIMUM): a genuinely
    // under-funded wallet, refused outright rather than handed a shrunken menu.
    expect(
      buildSmartModelCandidates({ descriptors: [CHEAP, BIG], balanceNanoUsd: reserve })
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

  it('stamps each candidate its OWN affordable cap: budget-bound when tight, full-context when rich', () => {
    // A WIDE-context model (remaining 7900 ≫ MINIMUM_OUTPUT_TOKENS) so the budget
    // can bite below the context. Tight wallet ⇒ a budget-bound cap under the
    // full window; a huge wallet ⇒ the cap is the full remaining context (7900).
    const WIDE = descriptorOf({
      id: 'wide/model',
      inputRate: 2n,
      outputRate: 3n,
      contextLength: 8000,
    });
    const reserve = classifierReserve(WIDE, [WIDE]);
    const constrained = buildSmartModelCandidates({
      descriptors: [WIDE],
      balanceNanoUsd: reserve + 10_000n,
      promptInputTokens: 100,
    });
    const constrainedCap = constrained?.candidates[0]?.maxOutputTokens ?? 0;
    expect(constrainedCap).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    expect(constrainedCap).toBeLessThan(7900);

    const rich = buildSmartModelCandidates({
      descriptors: [WIDE],
      balanceNanoUsd: HUGE_BALANCE,
      promptInputTokens: 100,
    });
    expect(rich?.candidates[0]?.maxOutputTokens).toBe(7900);
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

describe('pickEffortClassifier', () => {
  it('picks the cheapest engine-text model as the effort classifier, reserve priced over the pinned candidate', () => {
    const pick = pickEffortClassifier([BIG, MID, CHEAP], BIG);
    expect(pick).toEqual({
      classifierModelId: 'cheap/model',
      // pickEffortClassifier still applies the transitional markup wrapper
      // (deleted by the port-conversion task).
      classifierWorstCaseNanoUsd: applyMarkup(classifierReserve(CHEAP, [BIG])),
    });
  });

  it('resolves a cheapest-price tie deterministically (stable sort keeps the first)', () => {
    // Two models share the cheapest combined price, exercising the comparator's
    // tie branch; the stable sort keeps the first-listed as the classifier.
    const tieA = descriptorOf({
      id: 'tie-a/model',
      inputRate: 1n,
      outputRate: 1n,
      contextLength: 1000,
    });
    const tieB = descriptorOf({
      id: 'tie-b/model',
      inputRate: 1n,
      outputRate: 1n,
      contextLength: 1000,
    });
    expect(pickEffortClassifier([tieA, tieB], BIG)?.classifierModelId).toBe('tie-a/model');
  });

  it('returns null when no priceable engine-text model exists to classify with', () => {
    const imageModel = descriptorOf({
      id: 'img/model',
      inputRate: 1n,
      outputRate: 1n,
      outputs: ['image'],
    });
    expect(pickEffortClassifier([imageModel], imageModel)).toBeNull();
  });

  it('returns null when the cheapest text model lacks a per-token rate', () => {
    const rateless: ModelDescriptor = {
      ...descriptorOf({ id: 'free/model', inputRate: 1n, outputRate: 1n, contextLength: 1000 }),
      pricing: {},
    };
    // Two models so the comparator runs: the rate-less model sorts as combined 0,
    // becoming the cheapest classifier pick, whose reserve then fails closed.
    expect(pickEffortClassifier([rateless, CHEAP], CHEAP)).toBeNull();
  });
});
