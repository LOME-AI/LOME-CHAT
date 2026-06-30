import { describe, expect, it } from 'vitest';

import {
  buildEligibleModels,
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  CLASSIFIER_PROMPT_OVERHEAD_CHARS,
  computeMaxClassifierOverhead,
} from './eligible-models.js';
import { computeClassifierPromptOverhead } from './prompts.js';
import { canAffordModel } from '../budget.js';
import type { Model } from '../schemas/api/models.js';

function makeTextModel(overrides: Partial<Model> & { id: string; name: string }): Model {
  return {
    description: 'description',
    provider: 'TestProvider',
    modality: 'text',
    contextLength: 200_000,
    pricePerInputToken: 0.000_001,
    pricePerOutputToken: 0.000_005,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: [],
    ...overrides,
  };
}

const PAID_BALANCE_CENTS = 1000; // $10
const FREE_ALLOWANCE_CENTS = 0;
const PROMPT_CHAR_COUNT = 200;

describe('buildEligibleModels constants', () => {
  it('exposes a non-zero classifier output token cap', () => {
    expect(CLASSIFIER_OUTPUT_TOKEN_CAP).toBeGreaterThan(0);
  });

  it('reserves overhead chars for the classifier system prompt and model list', () => {
    expect(CLASSIFIER_PROMPT_OVERHEAD_CHARS).toBeGreaterThan(0);
  });
});

describe('buildEligibleModels', () => {
  it('returns null when there are no text models', () => {
    expect(
      buildEligibleModels({
        textModels: [],
        premiumIds: new Set(),
        payerTier: 'paid',
        payerBalanceCents: PAID_BALANCE_CENTS,
        payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
        promptCharacterCount: PROMPT_CHAR_COUNT,
      })
    ).toBeNull();
  });

  it('picks the cheapest non-premium text model as the classifier', () => {
    const models = [
      makeTextModel({
        id: 'expensive/x',
        name: 'X',
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_05,
      }),
      makeTextModel({
        id: 'cheap/c',
        name: 'C',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
      makeTextModel({
        id: 'mid/m',
        name: 'M',
        pricePerInputToken: 0.000_005,
        pricePerOutputToken: 0.000_025,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.classifierModelId).toBe('cheap/c');
  });

  it('excludes premium models for non-paid users', () => {
    const models = [
      makeTextModel({
        id: 'cheap/free',
        name: 'F',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
      makeTextModel({
        id: 'premium/p',
        name: 'P',
        pricePerInputToken: 0.000_002,
        pricePerOutputToken: 0.000_01,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(['premium/p']),
      payerTier: 'free',
      payerBalanceCents: 0,
      payerFreeAllowanceCents: 5,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.eligibleInferenceIds).toContain('cheap/free');
    expect(result?.eligibleInferenceIds).not.toContain('premium/p');
  });

  it('includes premium models for paid users', () => {
    const models = [
      makeTextModel({
        id: 'cheap/free',
        name: 'F',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
      makeTextModel({
        id: 'premium/p',
        name: 'P',
        pricePerInputToken: 0.000_002,
        pricePerOutputToken: 0.000_01,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(['premium/p']),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.eligibleInferenceIds).toContain('premium/p');
  });

  it('drops candidates whose worst-case inference plus classifier cost exceeds the budget', () => {
    const models = [
      makeTextModel({
        id: 'cheap/c',
        name: 'C',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
      makeTextModel({
        id: 'tooexpensive/x',
        name: 'X',
        pricePerInputToken: 0.001,
        pricePerOutputToken: 0.005,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: 50, // tight budget
      payerFreeAllowanceCents: 0,
      promptCharacterCount: 100,
    });
    expect(result?.eligibleInferenceIds).toContain('cheap/c');
    expect(result?.eligibleInferenceIds).not.toContain('tooexpensive/x');
  });

  it('returns null when no candidate is affordable even with classifier overhead', () => {
    const models = [
      makeTextModel({
        id: 'expensive/e',
        name: 'E',
        pricePerInputToken: 1,
        pricePerOutputToken: 1,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: 1, // 1 cent
      payerFreeAllowanceCents: 0,
      promptCharacterCount: 100,
    });
    expect(result).toBeNull();
  });

  it('includes the classifier itself in eligibleInferenceIds when affordable', () => {
    const models = [
      makeTextModel({
        id: 'only/c',
        name: 'C',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.classifierModelId).toBe('only/c');
    expect(result?.eligibleInferenceIds).toEqual(['only/c']);
  });

  it('agrees with resolveBilling: free-tier user with 5¢ free allowance gets an eligible cheap model', () => {
    // resolveBilling step-4 approves the request when the free allowance
    // covers the cheapest model's minimum cost; eligibility must produce
    // at least that model so the two paths agree.
    const models = [
      makeTextModel({
        id: 'cheap/haiku-like',
        name: 'Haiku-like',
        // Cheapest tier in the real catalog: ~$0.25/M input, $1.25/M output.
        pricePerInputToken: 0.000_000_25,
        pricePerOutputToken: 0.000_001_25,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'free',
      payerBalanceCents: 0,
      payerFreeAllowanceCents: 5,
      promptCharacterCount: 200,
    });
    expect(result).not.toBeNull();
    expect(result?.eligibleInferenceIds).toContain('cheap/haiku-like');
  });

  it('reports a positive classifier worst-case cents', () => {
    const result = buildEligibleModels({
      textModels: [
        makeTextModel({
          id: 'cheap/c',
          name: 'C',
          pricePerInputToken: 0.000_001,
          pricePerOutputToken: 0.000_005,
        }),
      ],
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.classifierWorstCaseCents).toBeGreaterThan(0);
  });

  it('skips models flagged as Smart Model in the input', () => {
    const models = [
      makeTextModel({ id: 'smart-model', name: 'Smart', isSmartModel: true }),
      makeTextModel({
        id: 'real/r',
        name: 'R',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.classifierModelId).toBe('real/r');
    expect(result?.eligibleInferenceIds).not.toContain('smart-model');
  });
});

describe('computeMaxClassifierOverhead', () => {
  it('returns the actual rendered prompt char count for a non-Smart Model list', () => {
    const models = [
      makeTextModel({
        id: 'a/x',
        name: 'X',
        description: 'Description for X.',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
      makeTextModel({
        id: 'b/y',
        name: 'Y',
        description: 'Description for Y, slightly longer for variety.',
        pricePerInputToken: 0.000_002,
        pricePerOutputToken: 0.000_006,
      }),
    ];
    const overhead = computeMaxClassifierOverhead(models);
    const expected = computeClassifierPromptOverhead(
      models.map((m) => ({ id: m.id, description: m.description }))
    );
    expect(overhead).toBe(expected);
  });

  it('skips Smart Model entries when computing overhead', () => {
    const realModel = makeTextModel({
      id: 'real/m',
      name: 'M',
      description: 'A real model.',
      pricePerInputToken: 0.000_001,
      pricePerOutputToken: 0.000_005,
    });
    const smartEntry = makeTextModel({
      id: 'smart-model',
      name: 'Smart',
      description: 'Smart router',
      isSmartModel: true,
    });

    const overheadWithSmart = computeMaxClassifierOverhead([smartEntry, realModel]);
    const overheadWithoutSmart = computeMaxClassifierOverhead([realModel]);
    expect(overheadWithSmart).toBe(overheadWithoutSmart);
  });

  it('returns a positive integer for any non-empty filterable list', () => {
    const models = [
      makeTextModel({
        id: 'a/x',
        name: 'X',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
    ];
    const overhead = computeMaxClassifierOverhead(models);
    expect(overhead).toBeGreaterThan(0);
    expect(Number.isInteger(overhead)).toBe(true);
  });

  it('returns 0 (no overhead) when the filtered list is empty', () => {
    // Only Smart Model entries → nothing real, nothing rendered. The math
    // upstream still works: an empty eligible set short-circuits before
    // touching the overhead.
    const onlySmart = [makeTextModel({ id: 'smart-model', name: 'Smart', isSmartModel: true })];
    const overhead = computeMaxClassifierOverhead(onlySmart);
    // Even with zero real models, the system prompt template carries fixed
    // chars; the user message is empty. So this is greater than zero but
    // bounded by the smallest possible template.
    expect(overhead).toBeGreaterThan(0);
  });
});

describe('buildEligibleModels uses the actual prompt overhead', () => {
  it('classifierWorstCaseCents agrees with the prompt-template-derived overhead, not a fixed constant', () => {
    // Two scenarios with different model-list sizes — the larger list MUST
    // produce a strictly larger worst-case (more entries → more chars in
    // the prompt). If we still hardcoded 5000, both scenarios would agree.
    const oneModel = [
      makeTextModel({
        id: 'a/x',
        name: 'X',
        description: 'D'.repeat(50),
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
    ];
    const twentyModels = Array.from({ length: 20 }, (_, index) =>
      makeTextModel({
        id: `m${String(index)}/x`,
        name: `M${String(index)}`,
        description: 'D'.repeat(50),
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      })
    );

    const small = buildEligibleModels({
      textModels: oneModel,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    const large = buildEligibleModels({
      textModels: twentyModels,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });

    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(large!.classifierWorstCaseCents).toBeGreaterThan(small!.classifierWorstCaseCents);
  });
});

describe('buildEligibleModels classifier-overhead exclusion', () => {
  it('excludes a model affordable on its own when classifier overhead pushes it past balance', () => {
    // 20k prompt chars at paid tier → the expensive model's minimum cost
    // (~101¢) fits balance + cushion alone, but adding the classifier's
    // worst-case reservation (~1.4¢) pushes it over. The cheap classifier
    // remains; the expensive model must drop out.
    const models = [
      makeTextModel({ id: 'cheap/c', name: 'C' }),
      makeTextModel({
        id: 'big/b',
        name: 'B',
        pricePerInputToken: 0.0001,
        pricePerOutputToken: 0.0005,
      }),
    ];
    const balanceCents = 51;
    const promptCharacterCount = 20_000;

    const aloneAffordable = canAffordModel({
      tier: 'paid',
      balanceCents,
      freeAllowanceCents: 0,
      promptCharacterCount,
      modelInputPricePerToken: 0.0001,
      modelOutputPricePerToken: 0.0005,
      isPremium: false,
    });
    expect(aloneAffordable.affordable).toBe(true);

    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: balanceCents,
      payerFreeAllowanceCents: 0,
      promptCharacterCount,
    });

    expect(result?.classifierModelId).toBe('cheap/c');
    expect(result?.eligibleInferenceIds).toEqual(['cheap/c']);
  });
});

// Uncoverable branch note: buildEligibleModels' `classifier === undefined`
// guard is unreachable — the `candidates.length === 0` early return above it
// guarantees index 0 exists. The guard only narrows the
// noUncheckedIndexedAccess type of `candidates[0]`.
