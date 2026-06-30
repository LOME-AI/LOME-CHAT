import { describe, it, expect } from 'vitest';
import {
  calculateBudget,
  computeSafeMaxTokens,
  estimateTokensForTier,
  charsPerTokenForTier,
  getEffectiveBalance,
  getCushionCents,
  generateNotifications,
  effectiveBudgetCents,
  buildCostManifest,
  calculateBudgetFromManifest,
  canAffordModel,
  type BudgetCalculationInput,
  type NotificationInput,
  type BuildCostManifestInput,
  type CostManifest,
  type CanAffordModelInput,
} from './budget.js';
import {
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_TRIAL_MESSAGE_COST_CENTS,
  MINIMUM_OUTPUT_TOKENS,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  CAPACITY_RED_THRESHOLD,
  CAPACITY_YELLOW_THRESHOLD,
  STORAGE_COST_PER_CHARACTER,
  MAX_SELECTED_MODELS,
  TOTAL_FEE_RATE,
} from './constants.js';

describe('estimateTokensForTier', () => {
  describe('paid users', () => {
    it('uses standard 4 chars/token ratio', () => {
      expect(estimateTokensForTier('paid', 400)).toBe(100);
      expect(estimateTokensForTier('paid', 1000)).toBe(250);
    });

    it('rounds up partial tokens', () => {
      expect(estimateTokensForTier('paid', 401)).toBe(101);
      expect(estimateTokensForTier('paid', 1)).toBe(1);
    });
  });

  describe('free users', () => {
    it('uses conservative 2 chars/token ratio', () => {
      expect(estimateTokensForTier('free', 400)).toBe(200);
      expect(estimateTokensForTier('free', 1000)).toBe(500);
    });

    it('rounds up partial tokens', () => {
      expect(estimateTokensForTier('free', 401)).toBe(201);
      expect(estimateTokensForTier('free', 1)).toBe(1);
    });
  });

  describe('trial users', () => {
    it('uses conservative 2 chars/token ratio', () => {
      expect(estimateTokensForTier('trial', 400)).toBe(200);
      expect(estimateTokensForTier('trial', 1000)).toBe(500);
    });

    it('rounds up partial tokens', () => {
      expect(estimateTokensForTier('trial', 401)).toBe(201);
    });
  });

  describe('edge cases', () => {
    it('handles zero characters', () => {
      expect(estimateTokensForTier('paid', 0)).toBe(0);
      expect(estimateTokensForTier('free', 0)).toBe(0);
      expect(estimateTokensForTier('trial', 0)).toBe(0);
    });

    it('handles large character counts', () => {
      expect(estimateTokensForTier('paid', 1_000_000)).toBe(250_000);
      expect(estimateTokensForTier('free', 1_000_000)).toBe(500_000);
    });
  });
});

describe('getEffectiveBalance', () => {
  describe('trial users', () => {
    it('returns fixed max cost per message', () => {
      const result = getEffectiveBalance('trial', 0, 0);
      expect(result).toBe(MAX_TRIAL_MESSAGE_COST_CENTS / 100);
    });

    it('ignores balance and allowance values', () => {
      const result = getEffectiveBalance('trial', 10_000, 500);
      expect(result).toBe(MAX_TRIAL_MESSAGE_COST_CENTS / 100);
    });
  });

  describe('free users', () => {
    it('returns free allowance only (no cushion)', () => {
      const result = getEffectiveBalance('free', 0, 500);
      expect(result).toBe(5); // 500 cents = $5
    });

    it('ignores primary balance', () => {
      const result = getEffectiveBalance('free', 10_000, 500);
      expect(result).toBe(5); // Still just free allowance
    });

    it('handles zero allowance', () => {
      const result = getEffectiveBalance('free', 0, 0);
      expect(result).toBe(0);
    });
  });

  describe('paid users', () => {
    it('returns balance plus cushion', () => {
      const result = getEffectiveBalance('paid', 100, 0);
      expect(result).toBe((100 + MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) / 100);
    });

    it('includes the $0.50 cushion', () => {
      const result = getEffectiveBalance('paid', 0, 0);
      // Paid with $0 balance still gets $0.50 cushion
      // But wait - if balance is 0, tier should be 'free', not 'paid'
      // This function just calculates based on tier passed, doesn't validate
      expect(result).toBe(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS / 100);
    });

    it('ignores free allowance', () => {
      const result = getEffectiveBalance('paid', 100, 500);
      expect(result).toBe((100 + MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) / 100);
    });
  });
});

describe('calculateBudget', () => {
  const baseInput: BudgetCalculationInput = {
    tier: 'paid',
    balanceCents: 1000, // $10
    freeAllowanceCents: 0,
    promptCharacterCount: 4000, // ~1000 tokens at 4 chars/token
    models: [
      {
        modelInputPricePerToken: 0.000_03, // $0.03 per 1k input
        modelOutputPricePerToken: 0.000_06, // $0.06 per 1k output
        contextLength: 128_000,
      },
    ],
  };

  describe('token estimation', () => {
    it('estimates tokens based on tier', () => {
      const paidResult = calculateBudget(baseInput);
      expect(paidResult.estimatedInputTokens).toBe(1000); // 4000/4

      const freeResult = calculateBudget({
        ...baseInput,
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 500,
      });
      expect(freeResult.estimatedInputTokens).toBe(2000); // 4000/2 (conservative)
    });
  });

  describe('cost estimation', () => {
    it('calculates estimated input cost including storage', () => {
      const result = calculateBudget(baseInput);
      // Model: 1000 tokens * $0.00003 = $0.03
      // Storage: 4000 chars * $0.0000003 = $0.0012
      // Total: $0.0312
      const expectedInputCost =
        1000 * baseInput.models[0]!.modelInputPricePerToken +
        baseInput.promptCharacterCount * STORAGE_COST_PER_CHARACTER;
      expect(result.estimatedInputCost).toBeCloseTo(expectedInputCost, 10);
    });

    it('calculates estimated minimum cost (input + min output) including storage', () => {
      const result = calculateBudget(baseInput);
      // Input cost: $0.0312 (model + storage)
      // Output storage: paid tier → CONSERVATIVE (2) chars/tok (optimistic, inverted from input)
      // Output cost per token: $0.00006 + 2 * $0.0000003 = $0.0000606
      // Min output: 1000 * $0.0000606 = $0.0606
      // Total: $0.0312 + $0.0606 = $0.0918
      const expectedInputCost =
        1000 * baseInput.models[0]!.modelInputPricePerToken +
        baseInput.promptCharacterCount * STORAGE_COST_PER_CHARACTER;
      const outputCostPerToken =
        baseInput.models[0]!.modelOutputPricePerToken +
        CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
      const expectedMinCost = expectedInputCost + MINIMUM_OUTPUT_TOKENS * outputCostPerToken;
      expect(result.estimatedMinimumCost).toBeCloseTo(expectedMinCost, 10);
    });

    it('includes webSearchCost in estimated input cost', () => {
      const searchCost = 0.005;
      const result = calculateBudget({ ...baseInput, webSearchCost: searchCost });
      const expectedInputCost =
        1000 * baseInput.models[0]!.modelInputPricePerToken +
        baseInput.promptCharacterCount * STORAGE_COST_PER_CHARACTER +
        searchCost;
      expect(result.estimatedInputCost).toBeCloseTo(expectedInputCost, 10);
    });

    it('includes webSearchCost in estimated minimum cost', () => {
      const searchCost = 0.005;
      const result = calculateBudget({ ...baseInput, webSearchCost: searchCost });
      const expectedInputCost =
        1000 * baseInput.models[0]!.modelInputPricePerToken +
        baseInput.promptCharacterCount * STORAGE_COST_PER_CHARACTER +
        searchCost;
      const outputCostPerToken =
        baseInput.models[0]!.modelOutputPricePerToken +
        CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
      const expectedMinCost = expectedInputCost + MINIMUM_OUTPUT_TOKENS * outputCostPerToken;
      expect(result.estimatedMinimumCost).toBeCloseTo(expectedMinCost, 10);
    });

    it('defaults webSearchCost to 0 when omitted', () => {
      const withoutSearch = calculateBudget(baseInput);
      const withZeroSearch = calculateBudget({ ...baseInput, webSearchCost: 0 });
      expect(withoutSearch.estimatedInputCost).toBe(withZeroSearch.estimatedInputCost);
    });
  });

  describe('effective balance', () => {
    it('calculates effective balance for paid users', () => {
      const result = calculateBudget(baseInput);
      // $10 + $0.50 cushion = $10.50
      expect(result.effectiveBalance).toBeCloseTo(10.5, 10);
    });

    it('calculates effective balance for free users', () => {
      const result = calculateBudget({
        ...baseInput,
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 500, // $5
      });
      expect(result.effectiveBalance).toBe(5);
    });

    it('calculates effective balance for trial users', () => {
      const result = calculateBudget({
        ...baseInput,
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
      });
      expect(result.effectiveBalance).toBe(0.01);
    });
  });

  describe('max output tokens', () => {
    it('calculates max output tokens based on remaining budget', () => {
      const result = calculateBudget(baseInput);
      // Effective balance: $10.50
      // Input cost: 1000 * $0.00003 + 4000 * $0.0000003 = $0.0312
      // Remaining: $10.50 - $0.0312 = $10.4688
      // Output storage: paid tier → CONSERVATIVE (2) chars/tok (optimistic, inverted from input)
      // Output cost/token: $0.00006 + 2 * $0.0000003 = $0.0000606
      const expectedInputCost =
        1000 * baseInput.models[0]!.modelInputPricePerToken +
        baseInput.promptCharacterCount * STORAGE_COST_PER_CHARACTER;
      const outputCostPerToken =
        baseInput.models[0]!.modelOutputPricePerToken +
        CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
      const remaining = 10.5 - expectedInputCost;
      expect(result.maxOutputTokens).toBe(Math.floor(remaining / outputCostPerToken));
    });

    it('returns 0 max output tokens when personal balance insufficient', () => {
      const result = calculateBudget({
        ...baseInput,
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 0, // No balance
      });
      expect(result.maxOutputTokens).toBe(0);
    });

    it('handles case where only minimum output is affordable', () => {
      // Create a scenario where we can barely afford minimum output
      const result = calculateBudget({
        ...baseInput,
        tier: 'paid',
        balanceCents: 10, // $0.10
        freeAllowanceCents: 0,
        promptCharacterCount: 400, // Small prompt
        models: [
          {
            modelInputPricePerToken: 0.000_01, // Cheap input
            modelOutputPricePerToken: 0.000_05, // Moderate output cost
            contextLength: 128_000,
          },
        ],
      });
      expect(result.maxOutputTokens).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    });
  });

  describe('capacity calculation', () => {
    it('calculates current usage as input tokens + minimum output tokens', () => {
      const result = calculateBudget(baseInput);
      expect(result.currentUsage).toBe(1000 + MINIMUM_OUTPUT_TOKENS);
    });

    it('calculates capacity percent correctly', () => {
      const result = calculateBudget({
        ...baseInput,
        promptCharacterCount: 4000, // 1000 tokens
        models: [{ ...baseInput.models[0]!, contextLength: 10_000 }], // Small context for easy math
      });
      // Current usage: 1000 + 1000 = 2000
      // Capacity: 2000 / 10000 = 20%
      expect(result.capacityPercent).toBeCloseTo(20, 10);
    });

    it('handles high capacity usage', () => {
      const result = calculateBudget({
        ...baseInput,
        promptCharacterCount: 40_000, // 10000 tokens
        models: [{ ...baseInput.models[0]!, contextLength: 12_000 }], // Small context
      });
      // Current usage: 10000 + 1000 = 11000
      // Capacity: 11000 / 12000 = 91.67%
      expect(result.capacityPercent).toBeCloseTo(91.67, 1);
    });

    it('can exceed 100% when over context limit', () => {
      const result = calculateBudget({
        ...baseInput,
        promptCharacterCount: 50_000, // 12500 tokens
        models: [{ ...baseInput.models[0]!, contextLength: 10_000 }],
      });
      // Current usage: 12500 + 1000 = 13500
      // Capacity: 13500 / 10000 = 135%
      expect(result.capacityPercent).toBeGreaterThan(100);
    });

    it('returns capacityPercent 0 when contextLength is 0', () => {
      const result = calculateBudget({
        ...baseInput,
        promptCharacterCount: 100,
        models: [{ ...baseInput.models[0]!, contextLength: 0 }],
      });
      expect(result.capacityPercent).toBe(0);
    });
  });
});

describe('calculateBudget integration', () => {
  it('returns complete math-only result', () => {
    const result = calculateBudget({
      tier: 'free',
      balanceCents: 0,
      freeAllowanceCents: 500,
      promptCharacterCount: 4000,
      models: [
        {
          modelInputPricePerToken: 0.000_03,
          modelOutputPricePerToken: 0.000_06,
          contextLength: 128_000,
        },
      ],
    });

    expect(result).toHaveProperty('maxOutputTokens');
    expect(result).toHaveProperty('estimatedInputTokens');
    expect(result).toHaveProperty('estimatedInputCost');
    expect(result).toHaveProperty('estimatedMinimumCost');
    expect(result).toHaveProperty('effectiveBalance');
    expect(result).toHaveProperty('currentUsage');
    expect(result).toHaveProperty('capacityPercent');
    expect(result).not.toHaveProperty('canAfford');
    expect(result).not.toHaveProperty('errors');
  });
});

describe('calculateBudget outputCostPerToken', () => {
  const baseInput: BudgetCalculationInput = {
    tier: 'paid',
    balanceCents: 1000,
    freeAllowanceCents: 0,
    promptCharacterCount: 4000,
    models: [
      {
        modelInputPricePerToken: 0.000_03,
        modelOutputPricePerToken: 0.000_06,
        contextLength: 128_000,
      },
    ],
  };

  it('includes outputCostPerToken in result', () => {
    const result = calculateBudget(baseInput);
    expect(result).toHaveProperty('outputCostPerToken');
    expect(result.outputCostPerToken).toBeGreaterThan(
      baseInput.models[0]!.modelOutputPricePerToken
    );
  });

  it('outputCostPerToken includes inverted tier-aware storage cost', () => {
    // Output is tokens→chars: inverted from input (chars→tokens).
    // Paid: CONSERVATIVE (2) = optimistic. Free: STANDARD (4) = pessimistic.
    const paidResult = calculateBudget(baseInput);
    const expectedPaid =
      baseInput.models[0]!.modelOutputPricePerToken +
      CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
    expect(paidResult.outputCostPerToken).toBeCloseTo(expectedPaid, 15);

    const freeResult = calculateBudget({
      ...baseInput,
      tier: 'free',
      balanceCents: 0,
      freeAllowanceCents: 50_000,
    });
    const expectedFree =
      baseInput.models[0]!.modelOutputPricePerToken +
      CHARS_PER_TOKEN_STANDARD * STORAGE_COST_PER_CHARACTER;
    expect(freeResult.outputCostPerToken).toBeCloseTo(expectedFree, 15);
  });
});

describe('calculateBudget invariant', () => {
  it('worst case from budget tokens never exceeds effective balance', () => {
    const scenarios: BudgetCalculationInput[] = [
      // Flash Lite: cheap model, huge context, low balance
      {
        tier: 'paid',
        balanceCents: 20,
        freeAllowanceCents: 0,
        promptCharacterCount: 4000,
        models: [
          {
            modelInputPricePerToken: 0.000_000_075,
            modelOutputPricePerToken: 0.000_000_075,
            contextLength: 1_048_576,
          },
        ],
      },
      // Flash Lite: cheap model, huge context, higher balance
      {
        tier: 'paid',
        balanceCents: 500,
        freeAllowanceCents: 0,
        promptCharacterCount: 4000,
        models: [
          {
            modelInputPricePerToken: 0.000_000_075,
            modelOutputPricePerToken: 0.000_000_075,
            contextLength: 1_048_576,
          },
        ],
      },
      // Claude Opus: expensive model, small context, low balance
      {
        tier: 'paid',
        balanceCents: 20,
        freeAllowanceCents: 0,
        promptCharacterCount: 4000,
        models: [
          {
            modelInputPricePerToken: 0.000_015,
            modelOutputPricePerToken: 0.000_075,
            contextLength: 200_000,
          },
        ],
      },
      // Claude Opus: expensive model, higher balance
      {
        tier: 'paid',
        balanceCents: 500,
        freeAllowanceCents: 0,
        promptCharacterCount: 4000,
        models: [
          {
            modelInputPricePerToken: 0.000_015,
            modelOutputPricePerToken: 0.000_075,
            contextLength: 200_000,
          },
        ],
      },
      // Free model: zero pricing
      {
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 50,
        promptCharacterCount: 4000,
        models: [
          { modelInputPricePerToken: 0, modelOutputPricePerToken: 0, contextLength: 128_000 },
        ],
      },
      // DeepSeek R1: mid-range
      {
        tier: 'paid',
        balanceCents: 20,
        freeAllowanceCents: 0,
        promptCharacterCount: 4000,
        models: [
          {
            modelInputPricePerToken: 0.000_000_55,
            modelOutputPricePerToken: 0.000_000_55,
            contextLength: 64_000,
          },
        ],
      },
      // GPT-4o: moderate pricing
      {
        tier: 'paid',
        balanceCents: 20,
        freeAllowanceCents: 0,
        promptCharacterCount: 4000,
        models: [
          {
            modelInputPricePerToken: 0.000_005,
            modelOutputPricePerToken: 0.000_01,
            contextLength: 128_000,
          },
        ],
      },
    ];

    for (const input of scenarios) {
      const budget = calculateBudget(input);
      if (budget.maxOutputTokens === 0) continue; // Can't afford — no invariant to check

      const modelContextLength = Math.min(...input.models.map((m) => m.contextLength));
      const effectiveMaxOutputTokens =
        computeSafeMaxTokens({
          budgetMaxTokens: budget.maxOutputTokens,
          modelContextLength,
          estimatedInputTokens: budget.estimatedInputTokens,
        }) ?? modelContextLength - budget.estimatedInputTokens;

      const worstCaseDollars =
        budget.estimatedInputCost + effectiveMaxOutputTokens * budget.outputCostPerToken;

      expect(worstCaseDollars).toBeLessThanOrEqual(budget.effectiveBalance);
    }
  });
});

describe('calculateBudget edge cases', () => {
  it('zero model pricing produces finite maxOutputTokens', () => {
    const result = calculateBudget({
      tier: 'free',
      balanceCents: 0,
      freeAllowanceCents: 50,
      promptCharacterCount: 4000,
      models: [{ modelInputPricePerToken: 0, modelOutputPricePerToken: 0, contextLength: 128_000 }],
    });
    expect(Number.isFinite(result.maxOutputTokens)).toBe(true);
    expect(result.maxOutputTokens).toBeGreaterThan(0);
  });

  it('cheap model with large context is budget-bounded', () => {
    const result = calculateBudget({
      tier: 'paid',
      balanceCents: 20, // $0.20
      freeAllowanceCents: 0,
      promptCharacterCount: 4000,
      models: [
        {
          modelInputPricePerToken: 0.000_000_075,
          modelOutputPricePerToken: 0.000_000_075,
          contextLength: 1_048_576,
        },
      ],
    });
    expect(result.maxOutputTokens).toBeLessThan(1_048_576);
  });
});

describe('effectiveBudgetCents', () => {
  it('returns min of all three positive constraints', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 500,
      memberRemainingCents: 300,
      ownerRemainingCents: 1000,
    });
    expect(result).toBe(300);
  });

  it('includes conversationRemainingCents when zero', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 0,
      memberRemainingCents: 300,
      ownerRemainingCents: 1000,
    });
    expect(result).toBe(0);
  });

  it('includes memberRemainingCents when zero (no budget row)', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 500,
      memberRemainingCents: 0,
      ownerRemainingCents: 1000,
    });
    expect(result).toBe(0);
  });

  it('includes memberRemainingCents when zero (budget exhausted)', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 500,
      memberRemainingCents: 0,
      ownerRemainingCents: 1000,
    });
    expect(result).toBe(0);
  });

  it('includes negative memberRemainingCents (budget over-spent)', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 500,
      memberRemainingCents: -30,
      ownerRemainingCents: 1000,
    });
    expect(result).toBe(-30);
  });

  it('returns zero when ownerRemainingCents is zero', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 500,
      memberRemainingCents: 300,
      ownerRemainingCents: 0,
    });
    expect(result).toBe(0);
  });

  it('returns negative when ownerRemainingCents is negative', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 500,
      memberRemainingCents: 300,
      ownerRemainingCents: -50,
    });
    expect(result).toBe(-50);
  });

  it('returns zero when all constraints are zero (default state)', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 0,
      memberRemainingCents: 0,
      ownerRemainingCents: 2000,
    });
    expect(result).toBe(0);
  });

  it('returns the single smallest constraint when one wins', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 100,
      memberRemainingCents: 500,
      ownerRemainingCents: 1000,
    });
    expect(result).toBe(100);
  });

  it('returns ownerRemainingCents when it is the smallest', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 1000,
      memberRemainingCents: 500,
      ownerRemainingCents: 50,
    });
    expect(result).toBe(50);
  });

  it('includes conversationRemainingCents when zero (budget exhausted)', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: 0,
      memberRemainingCents: 300,
      ownerRemainingCents: 1000,
    });
    // conversationRemainingCents 0 is not null, so it is included → min(0, 300, 1000)
    expect(result).toBe(0);
  });

  it('includes negative conversationRemainingCents (budget over-spent)', () => {
    const result = effectiveBudgetCents({
      conversationRemainingCents: -10,
      memberRemainingCents: 300,
      ownerRemainingCents: 1000,
    });
    // conversationRemainingCents -10 is not null, so it is included → min(-10, 300, 1000)
    expect(result).toBe(-10);
  });
});

/** Helper to build NotificationInput with sensible defaults */
function notifInput(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    billingResult: { fundingSource: 'personal_balance' },
    capacityPercent: 20,
    maxOutputTokens: 50_000,
    ...overrides,
  };
}

describe('generateNotifications', () => {
  describe('denial notifications', () => {
    it('returns error for premium_requires_balance', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
        })
      );
      const error = result.find((e) => e.id === 'premium_requires_balance');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe('This model requires a paid account.');
      expect(error?.segments).toEqual([
        { text: 'This model requires a paid account. ' },
        { text: 'Top up', link: '/billing' },
        { text: ' to use premium models.' },
      ]);
    });

    it('returns error for insufficient_balance', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
        })
      );
      const error = result.find((e) => e.id === 'insufficient_balance');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe('Insufficient balance. Top up or try a more affordable model.');
    });

    it('returns error for insufficient_free_allowance', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
        })
      );
      const error = result.find((e) => e.id === 'insufficient_free_allowance');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe(
        "Your free daily usage can't cover this message. Top up or try a shorter conversation."
      );
    });

    it('returns error for guest_budget_exhausted', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
        })
      );
      const error = result.find((e) => e.id === 'guest_budget_exhausted');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe('No budget allocated. Contact the conversation owner.');
    });

    it('suppresses delegated_budget_exhausted when guest_budget_exhausted', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
          hasDelegatedBudget: true,
        })
      );
      expect(result.some((e) => e.id === 'guest_budget_exhausted')).toBe(true);
      expect(result.some((e) => e.id === 'delegated_budget_exhausted')).toBe(false);
    });

    it('returns error for trial_limit_exceeded', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
        })
      );
      const error = result.find((e) => e.id === 'trial_limit_exceeded');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe('This message exceeds the usage limit.');
    });
  });

  describe('funding source info notices', () => {
    it('shows free tier notice for free_allowance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
        })
      );
      const notice = result.find((e) => e.id === 'free_tier_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice?.message).toBe('Using free allowance. Top up for longer conversations.');
    });

    it('shows trial notice for trial_fixed funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
        })
      );
      const notice = result.find((e) => e.id === 'trial_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice?.message).toBe('Free preview. Sign up for full access.');
    });

    it('does not show tier notice for personal_balance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
        })
      );
      expect(result.some((e) => e.id === 'free_tier_notice')).toBe(false);
      expect(result.some((e) => e.id === 'trial_notice')).toBe(false);
    });

    it('does not show tier notice for owner_balance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
        })
      );
      expect(result.some((e) => e.id === 'free_tier_notice')).toBe(false);
      expect(result.some((e) => e.id === 'trial_notice')).toBe(false);
    });
  });

  describe('capacity notifications', () => {
    it('shows capacity_exceeded when capacityPercent > 100', () => {
      const result = generateNotifications(notifInput({ capacityPercent: 150 }));
      const error = result.find((e) => e.id === 'capacity_exceeded');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
    });

    it('does not show capacity_exceeded when capacityPercent <= 100', () => {
      const result = generateNotifications(notifInput({ capacityPercent: 100 }));
      expect(result.some((e) => e.id === 'capacity_exceeded')).toBe(false);
    });

    it('shows capacity_warning at red threshold when no blocking errors', () => {
      const result = generateNotifications(
        notifInput({
          capacityPercent: CAPACITY_RED_THRESHOLD * 100,
        })
      );
      expect(result.some((e) => e.id === 'capacity_warning')).toBe(true);
    });

    it('does not show capacity_warning below red threshold', () => {
      const result = generateNotifications(
        notifInput({
          capacityPercent: CAPACITY_RED_THRESHOLD * 100 - 1,
        })
      );
      expect(result.some((e) => e.id === 'capacity_warning')).toBe(false);
    });

    it('does not show capacity_warning when denied (blocking error present)', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: 80,
        })
      );
      expect(result.some((e) => e.id === 'capacity_warning')).toBe(false);
    });

    it('does not show capacity_warning when over capacity (capacity_exceeded shown instead)', () => {
      const result = generateNotifications(notifInput({ capacityPercent: 110 }));
      expect(result.some((e) => e.id === 'capacity_warning')).toBe(false);
      expect(result.some((e) => e.id === 'capacity_exceeded')).toBe(true);
    });
  });

  describe('low balance warning', () => {
    it('shows low_balance for personal_balance with low maxOutputTokens', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          maxOutputTokens: LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD - 1,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(true);
    });

    it('does not show low_balance when maxOutputTokens >= threshold', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          maxOutputTokens: LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(false);
    });

    it('shows low_balance even when hasDelegatedBudget is true (budget exhausted, personal fallback)', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          maxOutputTokens: 100,
          hasDelegatedBudget: true,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(true);
    });

    it('does not show low_balance for non-personal_balance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          maxOutputTokens: 100,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(false);
    });

    it('does not show low_balance when denied', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          maxOutputTokens: 100,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(false);
    });
  });

  describe('delegated budget notices', () => {
    it('shows delegated_budget_notice when owner_balance and hasDelegatedBudget', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          hasDelegatedBudget: true,
        })
      );
      const notice = result.find((e) => e.id === 'delegated_budget_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice?.message).toBe(
        "You won't be charged. The conversation owner has allocated budget for your messages."
      );
    });

    it('does not show delegated_budget_notice without hasDelegatedBudget', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
        })
      );
      expect(result.some((e) => e.id === 'delegated_budget_notice')).toBe(false);
    });

    it('shows delegated_budget_exhausted when hasDelegatedBudget but fell through to personal', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          hasDelegatedBudget: true,
        })
      );
      const notice = result.find((e) => e.id === 'delegated_budget_exhausted');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
    });

    it('shows delegated_budget_exhausted even when denied (provides context)', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          hasDelegatedBudget: true,
        })
      );
      expect(result.some((e) => e.id === 'delegated_budget_exhausted')).toBe(true);
    });
  });

  describe('privilege notifications', () => {
    it('shows read_only_notice when privilege is read', () => {
      const result = generateNotifications(notifInput({ privilege: 'read' }));
      const notice = result.find((e) => e.id === 'read_only_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice?.message).toBe('You have read-only access to this conversation.');
    });

    it('does not show read_only_notice for write privilege', () => {
      const result = generateNotifications(notifInput({ privilege: 'write' }));
      expect(result.some((e) => e.id === 'read_only_notice')).toBe(false);
    });

    it('does not show read_only_notice when no privilege specified', () => {
      const result = generateNotifications(notifInput());
      expect(result.some((e) => e.id === 'read_only_notice')).toBe(false);
    });
  });
});

describe('generateNotifications — comprehensive state audit', () => {
  /** Extract notification IDs in order */
  function ids(result: ReturnType<typeof generateNotifications>): string[] {
    return result.map((n) => n.id);
  }

  const CAP_NORMAL = 20;
  const CAP_WARNING = 80;
  const CAP_EXCEEDED = 150;
  const BAL_HIGH = 50_000;
  const BAL_LOW = 5000;

  describe('A. Trial user — solo', () => {
    it('T1: basic, normal capacity, within cap → [trial_notice]', () => {
      const result = generateNotifications(
        notifInput({ billingResult: { fundingSource: 'trial_fixed' }, capacityPercent: CAP_NORMAL })
      );
      expect(ids(result)).toEqual(['trial_notice']);
    });

    it('T2: basic, warning capacity, within cap → [capacity_warning, trial_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'trial_notice']);
    });

    it('T3: basic, exceeded capacity, within cap → [capacity_exceeded, trial_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'trial_notice']);
    });

    it('T4: basic, normal capacity, over cap → [trial_limit_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['trial_limit_exceeded']);
    });

    it('T5: basic, warning capacity, over cap → [trial_limit_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['trial_limit_exceeded']);
    });

    it('T6: basic, exceeded capacity, over cap → [capacity_exceeded, trial_limit_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'trial_limit_exceeded']);
    });

    it('T7: premium, normal capacity → [premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance']);
    });

    it('T8: premium, warning capacity → [premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance']);
    });

    it('T9: premium, exceeded capacity → [capacity_exceeded, premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'premium_requires_balance']);
    });
  });

  describe('B. Free user — solo/owner', () => {
    it('F1: basic, normal, sufficient → [free_tier_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['free_tier_notice']);
    });

    it('F2: basic, warning, sufficient → [capacity_warning, free_tier_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'free_tier_notice']);
    });

    it('F3: basic, exceeded, sufficient → [capacity_exceeded, free_tier_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'free_tier_notice']);
    });

    it('F4: basic, normal, insufficient → [insufficient_free_allowance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['insufficient_free_allowance']);
    });

    it('F5: basic, warning, insufficient → [insufficient_free_allowance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['insufficient_free_allowance']);
    });

    it('F6: basic, exceeded, insufficient → [capacity_exceeded, insufficient_free_allowance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'insufficient_free_allowance']);
    });

    it('F7: premium, normal → [premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance']);
    });

    it('F8: premium, warning → [premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance']);
    });

    it('F9: premium, exceeded → [capacity_exceeded, premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'premium_requires_balance']);
    });
  });

  describe('C. Paid user — solo/owner', () => {
    it('P1: normal, high balance → []', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_HIGH,
        })
      );
      expect(ids(result)).toEqual([]);
    });

    it('P2: normal, low balance → [low_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_LOW,
        })
      );
      expect(ids(result)).toEqual(['low_balance']);
    });

    it('P3: warning, high balance → [capacity_warning]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_HIGH,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning']);
    });

    it('P4: warning, low balance → [capacity_warning, low_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_LOW,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'low_balance']);
    });

    it('P5: exceeded, sufficient → [capacity_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_EXCEEDED,
          maxOutputTokens: BAL_HIGH,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded']);
    });

    it('P6: normal, insufficient → [insufficient_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['insufficient_balance']);
    });

    it('P7: warning, insufficient → [insufficient_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['insufficient_balance']);
    });

    it('P8: exceeded, insufficient → [capacity_exceeded, insufficient_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'insufficient_balance']);
    });
  });

  describe('D. Group member — budget active', () => {
    it('GM1: normal → [delegated_budget_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['delegated_budget_notice']);
    });

    it('GM2: warning → [capacity_warning, delegated_budget_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'delegated_budget_notice']);
    });

    it('GM3: exceeded → [capacity_exceeded, delegated_budget_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'delegated_budget_notice']);
    });
  });

  describe('E. Group member — budget exhausted, paid', () => {
    it('GMP1: normal, high → [delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_HIGH,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['delegated_budget_exhausted']);
    });

    it('GMP2: normal, low → [low_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_LOW,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['low_balance', 'delegated_budget_exhausted']);
    });

    it('GMP3: warning, high → [capacity_warning, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_HIGH,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'delegated_budget_exhausted']);
    });

    it('GMP4: warning, low → [capacity_warning, low_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_LOW,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_warning',
        'low_balance',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMP5: exceeded, sufficient → [capacity_exceeded, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_EXCEEDED,
          maxOutputTokens: BAL_HIGH,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'delegated_budget_exhausted']);
    });

    it('GMP6: normal, insufficient → [insufficient_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_balance', 'delegated_budget_exhausted']);
    });

    it('GMP7: warning, insufficient → [insufficient_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_balance', 'delegated_budget_exhausted']);
    });

    it('GMP8: exceeded, insufficient → [capacity_exceeded, insufficient_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'insufficient_balance',
        'delegated_budget_exhausted',
      ]);
    });
  });

  describe('F. Group member — budget exhausted, free', () => {
    it('GMF1: basic, normal, sufficient → [free_tier_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['free_tier_notice', 'delegated_budget_exhausted']);
    });

    it('GMF2: basic, warning, sufficient → [capacity_warning, free_tier_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_warning',
        'free_tier_notice',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMF3: basic, exceeded, sufficient → [capacity_exceeded, free_tier_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'free_tier_notice',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMF4: basic, normal, insufficient → [insufficient_free_allowance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_free_allowance', 'delegated_budget_exhausted']);
    });

    it('GMF5: basic, warning, insufficient → [insufficient_free_allowance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_free_allowance', 'delegated_budget_exhausted']);
    });

    it('GMF6: basic, exceeded, insufficient → [capacity_exceeded, insufficient_free_allowance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'insufficient_free_allowance',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMF7: premium, normal → [premium_requires_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance', 'delegated_budget_exhausted']);
    });

    it('GMF8: premium, exceeded → [capacity_exceeded, premium_requires_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'premium_requires_balance',
        'delegated_budget_exhausted',
      ]);
    });
  });

  describe('G. Group member — budget exhausted, guest', () => {
    it('GMG1: basic, normal, within cap → [trial_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['trial_notice', 'delegated_budget_exhausted']);
    });

    it('GMG2: basic, warning, within cap → [capacity_warning, trial_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_warning',
        'trial_notice',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMG3: basic, exceeded, within cap → [capacity_exceeded, trial_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'trial_notice',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMG4: basic, normal, over cap → [trial_limit_exceeded, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['trial_limit_exceeded', 'delegated_budget_exhausted']);
    });

    it('GMG5: basic, warning, over cap → [trial_limit_exceeded, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['trial_limit_exceeded', 'delegated_budget_exhausted']);
    });

    it('GMG6: basic, exceeded, over cap → [capacity_exceeded, trial_limit_exceeded, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'trial_limit_exceeded',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMG7: premium, normal → [premium_requires_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance', 'delegated_budget_exhausted']);
    });

    it('GMG8: premium, exceeded → [capacity_exceeded, premium_requires_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'premium_requires_balance',
        'delegated_budget_exhausted',
      ]);
    });
  });

  describe('H. Read-only member', () => {
    it('RO1: read-only returns only read_only_notice regardless of billing state', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_EXCEEDED,
          maxOutputTokens: BAL_LOW,
          hasDelegatedBudget: true,
          privilege: 'read',
        })
      );
      expect(ids(result)).toEqual(['read_only_notice']);
    });
  });

  describe('Issue E: insufficient_free_allowance segments', () => {
    it('includes Top up link to /billing', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
        })
      );
      const error = result.find((e) => e.id === 'insufficient_free_allowance');
      expect(error).toBeDefined();
      expect(error!.message).toBe(
        "Your free daily usage can't cover this message. Top up or try a shorter conversation."
      );
      expect(error!.segments).toEqual([
        { text: "Your free daily usage can't cover this message. " },
        { text: 'Top up', link: '/billing' },
        { text: ' or try a shorter conversation.' },
      ]);
    });
  });
});

describe('charsPerTokenForTier', () => {
  it('returns CHARS_PER_TOKEN_STANDARD for paid users', () => {
    expect(charsPerTokenForTier('paid')).toBe(CHARS_PER_TOKEN_STANDARD);
  });

  it('returns CHARS_PER_TOKEN_CONSERVATIVE for free users', () => {
    expect(charsPerTokenForTier('free')).toBe(CHARS_PER_TOKEN_CONSERVATIVE);
  });

  it('returns CHARS_PER_TOKEN_CONSERVATIVE for trial users', () => {
    expect(charsPerTokenForTier('trial')).toBe(CHARS_PER_TOKEN_CONSERVATIVE);
  });

  it('returns CHARS_PER_TOKEN_CONSERVATIVE for guest users', () => {
    expect(charsPerTokenForTier('guest')).toBe(CHARS_PER_TOKEN_CONSERVATIVE);
  });
});

describe('getCushionCents', () => {
  it('returns MAX_ALLOWED_NEGATIVE_BALANCE_CENTS for paid users', () => {
    expect(getCushionCents('paid')).toBe(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS);
  });

  it('returns 0 for free users', () => {
    expect(getCushionCents('free')).toBe(0);
  });

  it('returns 0 for trial users', () => {
    expect(getCushionCents('trial')).toBe(0);
  });

  it('returns 0 for guest users', () => {
    expect(getCushionCents('guest')).toBe(0);
  });
});

describe('buildCostManifest', () => {
  const baseManifestInput: BuildCostManifestInput = {
    tier: 'paid',
    promptCharacterCount: 4000,
    models: [
      {
        modelInputPricePerToken: 0.000_03,
        modelOutputPricePerToken: 0.000_06,
      },
    ],
  };

  describe('fixed items', () => {
    it('includes text-input-tokens with tier-estimated token count', () => {
      const manifest = buildCostManifest(baseManifestInput);
      const inputItem = manifest.fixedItems.find((index) => index.type === 'text-input-tokens');
      expect(inputItem).toBeDefined();
      // paid tier: 4000 / 4 = 1000 tokens
      expect(inputItem!.units).toBe(1000);
      expect(inputItem!.costPerUnit).toBe(0.000_03);
      expect(inputItem!.applyFees).toBe(false);
    });

    it('uses conservative token estimation for free tier', () => {
      const manifest = buildCostManifest({ ...baseManifestInput, tier: 'free' });
      const inputItem = manifest.fixedItems.find((index) => index.type === 'text-input-tokens');
      // free tier: 4000 / 2 = 2000 tokens
      expect(inputItem!.units).toBe(2000);
    });

    it('uses conservative token estimation for trial tier', () => {
      const manifest = buildCostManifest({ ...baseManifestInput, tier: 'trial' });
      const inputItem = manifest.fixedItems.find((index) => index.type === 'text-input-tokens');
      // trial tier: 4000 / 2 = 2000 tokens
      expect(inputItem!.units).toBe(2000);
    });

    it('uses conservative token estimation for guest tier', () => {
      const manifest = buildCostManifest({ ...baseManifestInput, tier: 'guest' });
      const inputItem = manifest.fixedItems.find((index) => index.type === 'text-input-tokens');
      // guest tier: 4000 / 2 = 2000 tokens
      expect(inputItem!.units).toBe(2000);
    });

    it('includes input-storage with character count', () => {
      const manifest = buildCostManifest(baseManifestInput);
      const storageItem = manifest.fixedItems.find((index) => index.type === 'input-storage');
      expect(storageItem).toBeDefined();
      expect(storageItem!.units).toBe(4000);
      expect(storageItem!.costPerUnit).toBe(STORAGE_COST_PER_CHARACTER);
      expect(storageItem!.applyFees).toBe(false);
    });

    it('does not include web-search when cost is 0', () => {
      const manifest = buildCostManifest(baseManifestInput);
      const searchItem = manifest.fixedItems.find((index) => index.type === 'web-search');
      expect(searchItem).toBeUndefined();
    });

    it('does not include web-search when cost is omitted', () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- destructuring rest requires binding the excluded key
      const { webSearchCost: _webSearchCost, ...inputWithoutSearch } = baseManifestInput;
      const manifest = buildCostManifest(inputWithoutSearch);
      const searchItem = manifest.fixedItems.find((index) => index.type === 'web-search');
      expect(searchItem).toBeUndefined();
    });

    it('includes web-search when cost is provided', () => {
      const manifest = buildCostManifest({ ...baseManifestInput, webSearchCost: 0.005 });
      const searchItem = manifest.fixedItems.find((index) => index.type === 'web-search');
      expect(searchItem).toBeDefined();
      expect(searchItem!.units).toBe(1);
      expect(searchItem!.costPerUnit).toBe(0.005);
      expect(searchItem!.applyFees).toBe(false);
    });

    it('has zero input tokens for zero character count', () => {
      const manifest = buildCostManifest({ ...baseManifestInput, promptCharacterCount: 0 });
      const inputItem = manifest.fixedItems.find((index) => index.type === 'text-input-tokens');
      expect(inputItem!.units).toBe(0);
    });
  });

  describe('variable items', () => {
    it('includes text-output-tokens with model price', () => {
      const manifest = buildCostManifest(baseManifestInput);
      const outputItem = manifest.variableItems.find(
        (index) => index.type === 'text-output-tokens'
      );
      expect(outputItem).toBeDefined();
      expect(outputItem!.costPerUnit).toBe(0.000_06);
      expect(outputItem!.applyFees).toBe(false);
    });

    it('includes output-storage with tier-inverted chars/token ratio for paid', () => {
      const manifest = buildCostManifest(baseManifestInput);
      const storageItem = manifest.variableItems.find((index) => index.type === 'output-storage');
      expect(storageItem).toBeDefined();
      // paid tier output storage → CONSERVATIVE (2) chars/tok
      expect(storageItem!.costPerUnit).toBe(
        CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER
      );
      expect(storageItem!.applyFees).toBe(false);
    });

    it('uses standard chars/token for free tier output storage', () => {
      const manifest = buildCostManifest({ ...baseManifestInput, tier: 'free' });
      const storageItem = manifest.variableItems.find((index) => index.type === 'output-storage');
      // free tier output storage → STANDARD (4) chars/tok
      expect(storageItem!.costPerUnit).toBe(CHARS_PER_TOKEN_STANDARD * STORAGE_COST_PER_CHARACTER);
    });

    it('uses standard chars/token for trial tier output storage', () => {
      const manifest = buildCostManifest({ ...baseManifestInput, tier: 'trial' });
      const storageItem = manifest.variableItems.find((index) => index.type === 'output-storage');
      expect(storageItem!.costPerUnit).toBe(CHARS_PER_TOKEN_STANDARD * STORAGE_COST_PER_CHARACTER);
    });
  });

  describe('manifest matches effectiveOutputCostPerToken', () => {
    it('variable items sum equals effectiveOutputCostPerToken for paid tier', () => {
      const manifest = buildCostManifest(baseManifestInput);
      const variableSum = manifest.variableItems.reduce((sum, item) => sum + item.costPerUnit, 0);
      // effectiveOutputCostPerToken for paid: modelOutput + CONSERVATIVE * STORAGE
      const expected =
        baseManifestInput.models[0]!.modelOutputPricePerToken +
        CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
      expect(variableSum).toBeCloseTo(expected, 15);
    });

    it('variable items sum equals effectiveOutputCostPerToken for free tier', () => {
      const manifest = buildCostManifest({ ...baseManifestInput, tier: 'free' });
      const variableSum = manifest.variableItems.reduce((sum, item) => sum + item.costPerUnit, 0);
      const expected =
        baseManifestInput.models[0]!.modelOutputPricePerToken +
        CHARS_PER_TOKEN_STANDARD * STORAGE_COST_PER_CHARACTER;
      expect(variableSum).toBeCloseTo(expected, 15);
    });
  });
});

describe('buildCostManifest multi-model', () => {
  const modelA = { modelInputPricePerToken: 0.000_03, modelOutputPricePerToken: 0.000_06 };
  const modelB = { modelInputPricePerToken: 0.000_01, modelOutputPricePerToken: 0.000_02 };

  it('sums input prices across models', () => {
    const manifest = buildCostManifest({
      tier: 'paid',
      promptCharacterCount: 4000,
      models: [modelA, modelB],
    });
    const inputItem = manifest.fixedItems.find((index) => index.type === 'text-input-tokens');
    expect(inputItem!.costPerUnit).toBeCloseTo(
      modelA.modelInputPricePerToken + modelB.modelInputPricePerToken,
      15
    );
    // Same token count regardless of model count
    expect(inputItem!.units).toBe(1000); // 4000 / 4 (paid tier)
  });

  it('stores input once regardless of model count', () => {
    const manifest = buildCostManifest({
      tier: 'paid',
      promptCharacterCount: 4000,
      models: [modelA, modelB],
    });
    const storageItem = manifest.fixedItems.find((index) => index.type === 'input-storage');
    expect(storageItem!.units).toBe(4000);
    expect(storageItem!.costPerUnit).toBe(STORAGE_COST_PER_CHARACTER);
  });

  it('web search units equals model count', () => {
    const manifest = buildCostManifest({
      tier: 'paid',
      promptCharacterCount: 4000,
      models: [modelA, modelB],
      webSearchCost: 0.005,
    });
    const searchItem = manifest.fixedItems.find((index) => index.type === 'web-search');
    expect(searchItem!.units).toBe(2);
    expect(searchItem!.costPerUnit).toBe(0.005);
  });

  it('sums output prices across models', () => {
    const manifest = buildCostManifest({
      tier: 'paid',
      promptCharacterCount: 4000,
      models: [modelA, modelB],
    });
    const outputItem = manifest.variableItems.find((index) => index.type === 'text-output-tokens');
    expect(outputItem!.costPerUnit).toBeCloseTo(
      modelA.modelOutputPricePerToken + modelB.modelOutputPricePerToken,
      15
    );
  });

  it('scales output storage by model count', () => {
    const manifest = buildCostManifest({
      tier: 'paid',
      promptCharacterCount: 4000,
      models: [modelA, modelB],
    });
    const storageItem = manifest.variableItems.find((index) => index.type === 'output-storage');
    // 2 models → 2x storage
    expect(storageItem!.costPerUnit).toBeCloseTo(
      CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER * 2,
      15
    );
  });

  it('produces identical results to single model when models has length 1', () => {
    const singleManifest = buildCostManifest({
      tier: 'paid',
      promptCharacterCount: 4000,
      models: [modelA],
    });
    const multiManifest = buildCostManifest({
      tier: 'paid',
      promptCharacterCount: 4000,
      models: [modelA],
    });
    expect(singleManifest).toEqual(multiManifest);
  });
});

describe('calculateBudget multi-model', () => {
  const modelA = {
    modelInputPricePerToken: 0.000_03,
    modelOutputPricePerToken: 0.000_06,
    contextLength: 128_000,
  };
  const modelB = {
    modelInputPricePerToken: 0.000_01,
    modelOutputPricePerToken: 0.000_02,
    contextLength: 64_000,
  };

  it('uses minimum context length for capacity', () => {
    const result = calculateBudget({
      tier: 'paid',
      balanceCents: 1000,
      freeAllowanceCents: 0,
      promptCharacterCount: 4000,
      models: [modelA, modelB],
    });
    // Most restrictive model context: 64,000
    // Current usage: 1000 + 1000 = 2000
    // Capacity: 2000 / 64000 = 3.125%
    expect(result.capacityPercent).toBeCloseTo((2000 / 64_000) * 100, 10);
  });

  it('costs more with two models than one', () => {
    const singleResult = calculateBudget({
      tier: 'paid',
      balanceCents: 1000,
      freeAllowanceCents: 0,
      promptCharacterCount: 4000,
      models: [modelA],
    });
    const multiResult = calculateBudget({
      tier: 'paid',
      balanceCents: 1000,
      freeAllowanceCents: 0,
      promptCharacterCount: 4000,
      models: [modelA, modelB],
    });
    expect(multiResult.estimatedMinimumCost).toBeGreaterThan(singleResult.estimatedMinimumCost);
    expect(multiResult.maxOutputTokens).toBeLessThan(singleResult.maxOutputTokens);
  });

  it('maintains budget invariant with multiple models', () => {
    const result = calculateBudget({
      tier: 'paid',
      balanceCents: 1000,
      freeAllowanceCents: 0,
      promptCharacterCount: 4000,
      models: [modelA, modelB],
    });
    if (result.maxOutputTokens === 0) return;

    const modelContextLength = Math.min(...[modelA, modelB].map((m) => m.contextLength));
    const effectiveMaxOutputTokens =
      computeSafeMaxTokens({
        budgetMaxTokens: result.maxOutputTokens,
        modelContextLength,
        estimatedInputTokens: result.estimatedInputTokens,
      }) ?? modelContextLength - result.estimatedInputTokens;

    const worstCaseDollars =
      result.estimatedInputCost + effectiveMaxOutputTokens * result.outputCostPerToken;
    expect(worstCaseDollars).toBeLessThanOrEqual(result.effectiveBalance);
  });

  it('web search cost scales with model count', () => {
    const withSearch = calculateBudget({
      tier: 'paid',
      balanceCents: 1000,
      freeAllowanceCents: 0,
      promptCharacterCount: 4000,
      models: [modelA, modelB],
      webSearchCost: 0.005,
    });
    const withoutSearch = calculateBudget({
      tier: 'paid',
      balanceCents: 1000,
      freeAllowanceCents: 0,
      promptCharacterCount: 4000,
      models: [modelA, modelB],
    });
    // Search cost: 2 models × $0.005 = $0.01
    expect(withSearch.estimatedInputCost - withoutSearch.estimatedInputCost).toBeCloseTo(0.01, 10);
  });
});

describe('calculateBudgetFromManifest', () => {
  const paidManifest: CostManifest = {
    fixedItems: [
      { type: 'text-input-tokens', units: 1000, costPerUnit: 0.000_03, applyFees: false },
      {
        type: 'input-storage',
        units: 4000,
        costPerUnit: STORAGE_COST_PER_CHARACTER,
        applyFees: false,
      },
    ],
    variableItems: [
      { type: 'text-output-tokens', costPerUnit: 0.000_06, applyFees: false },
      {
        type: 'output-storage',
        costPerUnit: CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER,
        applyFees: false,
      },
    ],
  };

  describe('totalFixedCost', () => {
    it('sums fixed items correctly', () => {
      const result = calculateBudgetFromManifest(paidManifest, 10);
      // 1000 * 0.00003 + 4000 * 0.0000003 = 0.03 + 0.0012 = 0.0312
      const expected = 1000 * 0.000_03 + 4000 * STORAGE_COST_PER_CHARACTER;
      expect(result.totalFixedCost).toBeCloseTo(expected, 10);
    });

    it('includes web search cost when present', () => {
      const manifestWithSearch: CostManifest = {
        ...paidManifest,
        fixedItems: [
          ...paidManifest.fixedItems,
          { type: 'web-search', units: 1, costPerUnit: 0.005, applyFees: false },
        ],
      };
      const result = calculateBudgetFromManifest(manifestWithSearch, 10);
      const expected = 1000 * 0.000_03 + 4000 * STORAGE_COST_PER_CHARACTER + 0.005;
      expect(result.totalFixedCost).toBeCloseTo(expected, 10);
    });
  });

  describe('variableCostPerToken', () => {
    it('sums variable items correctly', () => {
      const result = calculateBudgetFromManifest(paidManifest, 10);
      const expected = 0.000_06 + CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
      expect(result.variableCostPerToken).toBeCloseTo(expected, 15);
    });
  });

  describe('estimatedMinimumCost', () => {
    it('equals totalFixedCost + MINIMUM_OUTPUT_TOKENS * variableCostPerToken', () => {
      const result = calculateBudgetFromManifest(paidManifest, 10);
      const expectedFixed = 1000 * 0.000_03 + 4000 * STORAGE_COST_PER_CHARACTER;
      const expectedVariable = 0.000_06 + CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
      expect(result.estimatedMinimumCost).toBeCloseTo(
        expectedFixed + MINIMUM_OUTPUT_TOKENS * expectedVariable,
        10
      );
    });
  });

  describe('maxOutputTokens', () => {
    it('calculates max tokens when balance is sufficient', () => {
      const result = calculateBudgetFromManifest(paidManifest, 10);
      const expectedFixed = 1000 * 0.000_03 + 4000 * STORAGE_COST_PER_CHARACTER;
      const expectedVariable = 0.000_06 + CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
      const expectedMax = Math.floor((10 - expectedFixed) / expectedVariable);
      expect(result.maxOutputTokens).toBe(expectedMax);
    });

    it('returns 0 when balance is below minimum cost', () => {
      const result = calculateBudgetFromManifest(paidManifest, 0.001);
      expect(result.maxOutputTokens).toBe(0);
    });

    it('returns 0 when balance is exactly 0', () => {
      const result = calculateBudgetFromManifest(paidManifest, 0);
      expect(result.maxOutputTokens).toBe(0);
    });

    it('allows tokens when balance exactly equals minimum cost', () => {
      const expectedFixed = 1000 * 0.000_03 + 4000 * STORAGE_COST_PER_CHARACTER;
      const expectedVariable = 0.000_06 + CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
      const exactMinimum = expectedFixed + MINIMUM_OUTPUT_TOKENS * expectedVariable;
      const result = calculateBudgetFromManifest(paidManifest, exactMinimum);
      expect(result.maxOutputTokens).toBe(MINIMUM_OUTPUT_TOKENS);
    });
  });

  describe('applyFees flag', () => {
    it('applies fees to fixed items when flagged', () => {
      const manifestWithFees: CostManifest = {
        fixedItems: [{ type: 'future-cost', units: 1, costPerUnit: 1, applyFees: true }],
        variableItems: [{ type: 'text-output-tokens', costPerUnit: 0.000_06, applyFees: false }],
      };
      const result = calculateBudgetFromManifest(manifestWithFees, 10);
      // 1.0 * (1 + TOTAL_FEE_RATE)
      expect(result.totalFixedCost).toBeCloseTo(1 + TOTAL_FEE_RATE, 10);
    });

    it('applies fees to variable items when flagged', () => {
      const manifestWithFees: CostManifest = {
        fixedItems: [],
        variableItems: [{ type: 'future-output', costPerUnit: 1, applyFees: true }],
      };
      const result = calculateBudgetFromManifest(manifestWithFees, 10);
      expect(result.variableCostPerToken).toBeCloseTo(1 + TOTAL_FEE_RATE, 10);
    });

    it('does not apply fees when flag is false', () => {
      const manifestNoFees: CostManifest = {
        fixedItems: [{ type: 'pre-applied', units: 1, costPerUnit: 1, applyFees: false }],
        variableItems: [{ type: 'pre-applied-output', costPerUnit: 1, applyFees: false }],
      };
      const result = calculateBudgetFromManifest(manifestNoFees, 10);
      expect(result.totalFixedCost).toBeCloseTo(1, 10);
      expect(result.variableCostPerToken).toBeCloseTo(1, 10);
    });
  });

  describe('empty manifest', () => {
    it('handles empty fixed items', () => {
      const manifest: CostManifest = {
        fixedItems: [],
        variableItems: [{ type: 'text-output-tokens', costPerUnit: 0.000_06, applyFees: false }],
      };
      const result = calculateBudgetFromManifest(manifest, 10);
      expect(result.totalFixedCost).toBe(0);
      expect(result.estimatedMinimumCost).toBe(MINIMUM_OUTPUT_TOKENS * 0.000_06);
    });
  });

  describe('consistency with calculateBudget', () => {
    it('produces identical results when built from same inputs (paid)', () => {
      const budgetInput: BudgetCalculationInput = {
        tier: 'paid',
        balanceCents: 1000,
        freeAllowanceCents: 0,
        promptCharacterCount: 4000,
        models: [
          {
            modelInputPricePerToken: 0.000_03,
            modelOutputPricePerToken: 0.000_06,
            contextLength: 128_000,
          },
        ],
      };
      const budgetResult = calculateBudget(budgetInput);

      const manifest = buildCostManifest({
        tier: 'paid',
        promptCharacterCount: 4000,
        models: [{ modelInputPricePerToken: 0.000_03, modelOutputPricePerToken: 0.000_06 }],
      });
      const effectiveBalance = getEffectiveBalance('paid', 1000, 0);
      const manifestResult = calculateBudgetFromManifest(manifest, effectiveBalance);

      expect(manifestResult.totalFixedCost).toBeCloseTo(budgetResult.estimatedInputCost, 10);
      expect(manifestResult.variableCostPerToken).toBeCloseTo(budgetResult.outputCostPerToken, 15);
      expect(manifestResult.estimatedMinimumCost).toBeCloseTo(
        budgetResult.estimatedMinimumCost,
        10
      );
      expect(manifestResult.maxOutputTokens).toBe(budgetResult.maxOutputTokens);
    });

    it('produces identical results when built from same inputs (free)', () => {
      const budgetInput: BudgetCalculationInput = {
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 500,
        promptCharacterCount: 2000,
        models: [
          {
            modelInputPricePerToken: 0.000_01,
            modelOutputPricePerToken: 0.000_02,
            contextLength: 128_000,
          },
        ],
      };
      const budgetResult = calculateBudget(budgetInput);

      const manifest = buildCostManifest({
        tier: 'free',
        promptCharacterCount: 2000,
        models: [{ modelInputPricePerToken: 0.000_01, modelOutputPricePerToken: 0.000_02 }],
      });
      const effectiveBalance = getEffectiveBalance('free', 0, 500);
      const manifestResult = calculateBudgetFromManifest(manifest, effectiveBalance);

      expect(manifestResult.totalFixedCost).toBeCloseTo(budgetResult.estimatedInputCost, 10);
      expect(manifestResult.variableCostPerToken).toBeCloseTo(budgetResult.outputCostPerToken, 15);
      expect(manifestResult.estimatedMinimumCost).toBeCloseTo(
        budgetResult.estimatedMinimumCost,
        10
      );
      expect(manifestResult.maxOutputTokens).toBe(budgetResult.maxOutputTokens);
    });

    it('produces identical results when built from same inputs (trial)', () => {
      const budgetInput: BudgetCalculationInput = {
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
        promptCharacterCount: 100,
        models: [
          {
            modelInputPricePerToken: 0.000_001,
            modelOutputPricePerToken: 0.000_002,
            contextLength: 128_000,
          },
        ],
      };
      const budgetResult = calculateBudget(budgetInput);

      const manifest = buildCostManifest({
        tier: 'trial',
        promptCharacterCount: 100,
        models: [{ modelInputPricePerToken: 0.000_001, modelOutputPricePerToken: 0.000_002 }],
      });
      const effectiveBalance = getEffectiveBalance('trial', 0, 0);
      const manifestResult = calculateBudgetFromManifest(manifest, effectiveBalance);

      expect(manifestResult.totalFixedCost).toBeCloseTo(budgetResult.estimatedInputCost, 10);
      expect(manifestResult.variableCostPerToken).toBeCloseTo(budgetResult.outputCostPerToken, 15);
      expect(manifestResult.estimatedMinimumCost).toBeCloseTo(
        budgetResult.estimatedMinimumCost,
        10
      );
      expect(manifestResult.maxOutputTokens).toBe(budgetResult.maxOutputTokens);
    });

    it('produces identical results with web search cost', () => {
      const budgetInput: BudgetCalculationInput = {
        tier: 'paid',
        balanceCents: 1000,
        freeAllowanceCents: 0,
        promptCharacterCount: 4000,
        models: [
          {
            modelInputPricePerToken: 0.000_03,
            modelOutputPricePerToken: 0.000_06,
            contextLength: 128_000,
          },
        ],
        webSearchCost: 0.005,
      };
      const budgetResult = calculateBudget(budgetInput);

      const manifest = buildCostManifest({
        tier: 'paid',
        promptCharacterCount: 4000,
        models: [{ modelInputPricePerToken: 0.000_03, modelOutputPricePerToken: 0.000_06 }],
        webSearchCost: 0.005,
      });
      const effectiveBalance = getEffectiveBalance('paid', 1000, 0);
      const manifestResult = calculateBudgetFromManifest(manifest, effectiveBalance);

      expect(manifestResult.totalFixedCost).toBeCloseTo(budgetResult.estimatedInputCost, 10);
      expect(manifestResult.estimatedMinimumCost).toBeCloseTo(
        budgetResult.estimatedMinimumCost,
        10
      );
      expect(manifestResult.maxOutputTokens).toBe(budgetResult.maxOutputTokens);
    });
  });
});

describe('canAffordModel', () => {
  const baseAffordInput: CanAffordModelInput = {
    tier: 'paid',
    balanceCents: 1000, // $10
    freeAllowanceCents: 0,
    promptCharacterCount: 4000,
    modelInputPricePerToken: 0.000_03,
    modelOutputPricePerToken: 0.000_06,
    isPremium: false,
  };

  describe('affordability', () => {
    it('returns affordable true when balance covers minimum cost', () => {
      const result = canAffordModel(baseAffordInput);
      expect(result.affordable).toBe(true);
      expect(result.maxOutputTokens).toBeGreaterThan(0);
    });

    it('returns affordable false when balance is insufficient', () => {
      const result = canAffordModel({
        ...baseAffordInput,
        balanceCents: 0,
        freeAllowanceCents: 0,
        tier: 'free',
      });
      expect(result.affordable).toBe(false);
      expect(result.maxOutputTokens).toBe(0);
    });

    it('returns affordable true for free user with sufficient allowance', () => {
      const result = canAffordModel({
        ...baseAffordInput,
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 500, // $5
      });
      expect(result.affordable).toBe(true);
      expect(result.maxOutputTokens).toBeGreaterThan(0);
    });

    it('returns affordable true for trial user with cheap model', () => {
      const result = canAffordModel({
        ...baseAffordInput,
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
        modelInputPricePerToken: 0.000_001,
        modelOutputPricePerToken: 0.000_002,
      });
      expect(result.affordable).toBe(true);
    });

    it('returns affordable false for trial user with expensive model', () => {
      const result = canAffordModel({
        ...baseAffordInput,
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
        modelInputPricePerToken: 0.0001,
        modelOutputPricePerToken: 0.0002,
        promptCharacterCount: 10_000,
      });
      expect(result.affordable).toBe(false);
    });
  });

  describe('premium gating', () => {
    it('returns affordable false for premium model when user cannot access premium', () => {
      const result = canAffordModel({
        ...baseAffordInput,
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 5000,
        isPremium: true,
      });
      expect(result.affordable).toBe(false);
    });

    it('returns affordable false for premium model for trial user', () => {
      const result = canAffordModel({
        ...baseAffordInput,
        tier: 'trial',
        isPremium: true,
      });
      expect(result.affordable).toBe(false);
    });

    it('returns affordable false for premium model for guest user', () => {
      const result = canAffordModel({
        ...baseAffordInput,
        tier: 'guest',
        isPremium: true,
      });
      expect(result.affordable).toBe(false);
    });

    it('returns affordable true for premium model for paid user with balance', () => {
      const result = canAffordModel({
        ...baseAffordInput,
        isPremium: true,
      });
      expect(result.affordable).toBe(true);
    });
  });

  describe('estimatedMinimumCost', () => {
    it('matches calculateBudget estimatedMinimumCost for same inputs', () => {
      const budgetResult = calculateBudget({
        tier: baseAffordInput.tier,
        balanceCents: baseAffordInput.balanceCents,
        freeAllowanceCents: baseAffordInput.freeAllowanceCents,
        promptCharacterCount: baseAffordInput.promptCharacterCount,
        models: [
          {
            modelInputPricePerToken: baseAffordInput.modelInputPricePerToken,
            modelOutputPricePerToken: baseAffordInput.modelOutputPricePerToken,
            contextLength: 128_000,
          },
        ],
      });
      const affordResult = canAffordModel(baseAffordInput);
      expect(affordResult.estimatedMinimumCost).toBeCloseTo(budgetResult.estimatedMinimumCost, 10);
    });

    it('includes web search cost', () => {
      const withoutSearch = canAffordModel(baseAffordInput);
      const withSearch = canAffordModel({
        ...baseAffordInput,
        webSearchCost: 0.005,
      });
      expect(withSearch.estimatedMinimumCost).toBeGreaterThan(withoutSearch.estimatedMinimumCost);
    });
  });

  describe('maxOutputTokens', () => {
    it('matches calculateBudget maxOutputTokens for same inputs', () => {
      const budgetResult = calculateBudget({
        tier: baseAffordInput.tier,
        balanceCents: baseAffordInput.balanceCents,
        freeAllowanceCents: baseAffordInput.freeAllowanceCents,
        promptCharacterCount: baseAffordInput.promptCharacterCount,
        models: [
          {
            modelInputPricePerToken: baseAffordInput.modelInputPricePerToken,
            modelOutputPricePerToken: baseAffordInput.modelOutputPricePerToken,
            contextLength: 128_000,
          },
        ],
      });
      const affordResult = canAffordModel(baseAffordInput);
      expect(affordResult.maxOutputTokens).toBe(budgetResult.maxOutputTokens);
    });
  });
});

describe('constants verification', () => {
  it('uses correct character/token ratios', () => {
    expect(CHARS_PER_TOKEN_CONSERVATIVE).toBe(2);
    expect(CHARS_PER_TOKEN_STANDARD).toBe(4);
  });

  it('uses correct capacity thresholds', () => {
    expect(CAPACITY_RED_THRESHOLD).toBe(0.67);
    expect(CAPACITY_YELLOW_THRESHOLD).toBe(0.33);
  });

  it('uses correct budget constants', () => {
    expect(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS).toBe(50);
    expect(MAX_TRIAL_MESSAGE_COST_CENTS).toBe(1);
    expect(MINIMUM_OUTPUT_TOKENS).toBe(1000);
    expect(LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD).toBe(10_000);
  });

  it('uses correct multi-model constant', () => {
    expect(MAX_SELECTED_MODELS).toBe(5);
  });
});

// Uncoverable branch note: calculateBudget's `inputTokenItem?.units
// ?? 0` fallback is unreachable — buildCostManifest unconditionally emits a
// 'text-input-tokens' fixed item, and the find() runs over the manifest it
// just built.
