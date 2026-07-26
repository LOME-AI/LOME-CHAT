import { describe, it, expect } from 'vitest';
import {
  getUserTier,
  canUseModel,
  FREE_ALLOWANCE_DOLLARS,
  FREE_ALLOWANCE_CENTS_VALUE,
  TRIAL_MESSAGE_LIMIT,
  WELCOME_CREDIT_CENTS,
  type UserTierInfo,
} from './tiers.js';

function tierInfo(overrides: Partial<UserTierInfo>): UserTierInfo {
  return {
    tier: 'trial',
    canAccessPremium: false,
    purchasedBalanceNanoUsd: 0n,
    freeAllowanceNanoUsd: 0n,
    ...overrides,
  };
}

describe('tiers', () => {
  describe('constants', () => {
    it('exports FREE_ALLOWANCE_DOLLARS as a dollar string for database', () => {
      expect(typeof FREE_ALLOWANCE_DOLLARS).toBe('string');
      expect(Number.parseFloat(FREE_ALLOWANCE_DOLLARS)).toBe(0.05);
    });

    it('exports FREE_ALLOWANCE_CENTS_VALUE as a positive integer for calculations', () => {
      expect(FREE_ALLOWANCE_CENTS_VALUE).toBeGreaterThan(0);
      expect(Number.isInteger(FREE_ALLOWANCE_CENTS_VALUE)).toBe(true);
    });

    it('exports TRIAL_MESSAGE_LIMIT as a positive integer', () => {
      expect(TRIAL_MESSAGE_LIMIT).toBeGreaterThan(0);
      expect(Number.isInteger(TRIAL_MESSAGE_LIMIT)).toBe(true);
    });

    it('exports WELCOME_CREDIT_CENTS as a positive integer', () => {
      expect(WELCOME_CREDIT_CENTS).toBeGreaterThan(0);
      expect(Number.isInteger(WELCOME_CREDIT_CENTS)).toBe(true);
    });
  });

  describe('getUserTier', () => {
    it('returns trial tier when user is null', () => {
      const result = getUserTier(null);

      expect(result).toEqual<UserTierInfo>({
        tier: 'trial',
        canAccessPremium: false,
        purchasedBalanceNanoUsd: 0n,
        freeAllowanceNanoUsd: 0n,
      });
    });

    it('returns guest tier when user is null and isLinkGuest is true', () => {
      const result = getUserTier(null, { isLinkGuest: true });

      expect(result).toEqual<UserTierInfo>({
        tier: 'guest',
        canAccessPremium: false,
        purchasedBalanceNanoUsd: 0n,
        freeAllowanceNanoUsd: 0n,
      });
    });

    it('returns paid tier when user has positive balance', () => {
      const result = getUserTier({
        purchasedBalanceNanoUsd: 1_000_000_000n,
        freeAllowanceNanoUsd: 50_000_000n,
      });

      expect(result).toEqual<UserTierInfo>({
        tier: 'paid',
        canAccessPremium: true,
        purchasedBalanceNanoUsd: 1_000_000_000n,
        freeAllowanceNanoUsd: 50_000_000n,
      });
    });

    it('returns paid tier for a balance of a single nano-USD (exact bigint compare)', () => {
      // A sub-cent positive balance is still paid: the compare is exact bigint,
      // never a cents round-trip that would truncate 1 nano to 0.
      const result = getUserTier({ purchasedBalanceNanoUsd: 1n, freeAllowanceNanoUsd: 0n });

      expect(result.tier).toBe('paid');
      expect(result.canAccessPremium).toBe(true);
    });

    it('returns free tier when user has zero balance', () => {
      const result = getUserTier({
        purchasedBalanceNanoUsd: 0n,
        freeAllowanceNanoUsd: 50_000_000n,
      });

      expect(result).toEqual<UserTierInfo>({
        tier: 'free',
        canAccessPremium: false,
        purchasedBalanceNanoUsd: 0n,
        freeAllowanceNanoUsd: 50_000_000n,
      });
    });

    it('returns free tier when user has negative balance', () => {
      const result = getUserTier({
        purchasedBalanceNanoUsd: -100_000_000n,
        freeAllowanceNanoUsd: 50_000_000n,
      });

      expect(result).toEqual<UserTierInfo>({
        tier: 'free',
        canAccessPremium: false,
        purchasedBalanceNanoUsd: -100_000_000n,
        freeAllowanceNanoUsd: 50_000_000n,
      });
    });
  });

  describe('canUseModel', () => {
    it('allows any tier to use basic models', () => {
      expect(canUseModel(tierInfo({ tier: 'trial' }), false)).toBe(true);
      expect(canUseModel(tierInfo({ tier: 'guest' }), false)).toBe(true);
      expect(canUseModel(tierInfo({ tier: 'free' }), false)).toBe(true);
      expect(
        canUseModel(
          tierInfo({
            tier: 'paid',
            canAccessPremium: true,
            purchasedBalanceNanoUsd: 1_000_000_000n,
          }),
          false
        )
      ).toBe(true);
    });

    it('only allows paid tier to use premium models', () => {
      expect(canUseModel(tierInfo({ tier: 'trial' }), true)).toBe(false);
      expect(canUseModel(tierInfo({ tier: 'guest' }), true)).toBe(false);
      expect(canUseModel(tierInfo({ tier: 'free' }), true)).toBe(false);
      expect(
        canUseModel(
          tierInfo({
            tier: 'paid',
            canAccessPremium: true,
            purchasedBalanceNanoUsd: 1_000_000_000n,
          }),
          true
        )
      ).toBe(true);
    });
  });
});
