import { describe, it, expect } from 'vitest';
import { computeSafeMaxTokens } from './max-tokens.js';

describe('computeSafeMaxTokens', () => {
  describe('when budget exceeds remaining context', () => {
    it('returns undefined to omit max_tokens param', () => {
      const result = computeSafeMaxTokens({
        budgetMaxTokens: 1_000_000,
        modelContextLength: 128_000,
        estimatedInputTokens: 1000,
      });

      expect(result).toBeUndefined();
    });

    it('returns undefined when budget equals remaining context', () => {
      const result = computeSafeMaxTokens({
        budgetMaxTokens: 127_000,
        modelContextLength: 128_000,
        estimatedInputTokens: 1000,
      });

      // 127_000 === 128_000 - 1_000, so budget is not less than remaining
      // We want to omit max_tokens when budget >= remaining
      expect(result).toBeUndefined();
    });
  });

  describe('when budget is less than remaining context', () => {
    it('returns full budget tokens (no headroom reduction)', () => {
      const result = computeSafeMaxTokens({
        budgetMaxTokens: 10_000,
        modelContextLength: 128_000,
        estimatedInputTokens: 1000,
      });

      expect(result).toBe(10_000);
    });

    it('returns exact budget for odd values', () => {
      const result = computeSafeMaxTokens({
        budgetMaxTokens: 10_001,
        modelContextLength: 128_000,
        estimatedInputTokens: 1000,
      });

      expect(result).toBe(10_001);
    });

    it('handles small budget values', () => {
      const result = computeSafeMaxTokens({
        budgetMaxTokens: 100,
        modelContextLength: 128_000,
        estimatedInputTokens: 1000,
      });

      expect(result).toBe(100);
    });
  });

  describe('edge cases', () => {
    it('handles zero budget', () => {
      const result = computeSafeMaxTokens({
        budgetMaxTokens: 0,
        modelContextLength: 128_000,
        estimatedInputTokens: 1000,
      });

      // 0 * 0.95 = 0
      expect(result).toBe(0);
    });

    it('handles input tokens exceeding context length', () => {
      const result = computeSafeMaxTokens({
        budgetMaxTokens: 1000,
        modelContextLength: 128_000,
        estimatedInputTokens: 200_000,
      });

      // remainingContext = 128_000 - 200_000 = -72_000 (negative)
      // budget (1_000) > remaining (-72_000), so undefined
      expect(result).toBeUndefined();
    });

    it('handles large context models like Claude', () => {
      const result = computeSafeMaxTokens({
        budgetMaxTokens: 50_000,
        modelContextLength: 200_000,
        estimatedInputTokens: 10_000,
      });

      expect(result).toBe(50_000);
    });
  });
});
