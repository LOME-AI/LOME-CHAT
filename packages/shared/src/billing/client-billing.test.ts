import { describe, expect, it } from 'vitest';
import {
  resolveClientBilling,
  deriveClientFundingInputs,
  type ClientBillingInput,
  type ResolveBillingResult,
} from './client-billing.js';
import { resolveFundingDecision } from './funding-decision.js';

const NANO_PER_CENT = 10_000_000n;

function input(overrides: Partial<ClientBillingInput>): ClientBillingInput {
  return {
    tier: 'paid',
    purchasedBalanceNanoUsd: 1000n * NANO_PER_CENT,
    // Served spendable: balance + cushion − holds; defaults to balance + 50¢.
    spendableNanoUsd: 1050n * NANO_PER_CENT,
    freeAllowanceNanoUsd: 0n,
    isPremiumModel: false,
    estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
    ...overrides,
  };
}

describe('resolveClientBilling — self-funding vocabulary', () => {
  it('paid tier with served spendable covering the estimate → personal_balance', () => {
    expect(
      resolveClientBilling(input({ tier: 'paid', spendableNanoUsd: 1050n * NANO_PER_CENT }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });

  it('paid tier with served spendable below the estimate → insufficient_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          purchasedBalanceNanoUsd: 1n * NANO_PER_CENT,
          spendableNanoUsd: 51n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 100_000n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });

  it('paid tier spendable exactly equal to the estimate → personal_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 40n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 40n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });

  it('paid tier never re-adds the cushion on top of the served spendable', () => {
    // The served number already bakes the $0.50 cushion (and hold subtraction).
    // spendable 10¢, estimate 30¢: a double-cushion bug would pass (10 + 50 ≥ 30);
    // the correct compare denies.
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 10n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 30n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });

  it('free tier with allowance covering the estimate → free_allowance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          freeAllowanceNanoUsd: 100n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
  });

  it('free tier compares exact bigint — allowance one nano short denies', () => {
    // The deleted 1e-6-cent float tolerance must not survive: a shortfall of a
    // single nano-USD is a real shortfall in exact integer money.
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          freeAllowanceNanoUsd: 10n * NANO_PER_CENT - 1n,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'insufficient_free_allowance',
    });
  });

  it('free tier with allowance exactly equal to the estimate → free_allowance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          freeAllowanceNanoUsd: 10n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
  });

  it('free tier with depleted allowance → insufficient_free_allowance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          freeAllowanceNanoUsd: 0n,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'insufficient_free_allowance',
    });
  });

  it('trial tier within the fixed 1¢ cap → trial_fixed', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'trial',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          estimatedMinimumCostNanoUsd: 1n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'trial_fixed' });
  });

  it('trial tier over the fixed cap → trial_limit_exceeded', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'trial',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          estimatedMinimumCostNanoUsd: 1n * NANO_PER_CENT + 1n,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'trial_limit_exceeded' });
  });

  it('guest tier without group budget → guest_budget_exhausted', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'guest',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          estimatedMinimumCostNanoUsd: 1n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'guest_budget_exhausted' });
  });
});

describe('resolveClientBilling — premium gating via the shared core', () => {
  it('free tier selecting a premium model → premium_requires_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          isPremiumModel: true,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'premium_requires_balance',
    });
  });

  it('trial tier selecting a premium model → premium_requires_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'trial',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          isPremiumModel: true,
          estimatedMinimumCostNanoUsd: 1n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'premium_requires_balance',
    });
  });

  it('paid tier selecting a premium model it can afford → personal_balance', () => {
    expect(
      resolveClientBilling(input({ tier: 'paid', isPremiumModel: true }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });
});

describe('resolveClientBilling — group / owner funding', () => {
  it('group budget available → owner_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          group: {
            effectiveRemainingNanoUsd: 500n * NANO_PER_CENT,
            ownerBalanceNanoUsd: 5000n * NANO_PER_CENT,
          },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'owner_balance' });
  });

  it('group budget available on a premium model → owner_balance (owner is premium-exempt)', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          isPremiumModel: true,
          group: {
            effectiveRemainingNanoUsd: 500n * NANO_PER_CENT,
            ownerBalanceNanoUsd: 5000n * NANO_PER_CENT,
          },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'owner_balance' });
  });

  it('group budget exhausted → falls through to the caller personal balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          group: {
            effectiveRemainingNanoUsd: 0n,
            ownerBalanceNanoUsd: 5000n * NANO_PER_CENT,
          },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });

  it('guest with group budget exhausted → guest_budget_exhausted', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'guest',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          estimatedMinimumCostNanoUsd: 1n * NANO_PER_CENT,
          group: {
            effectiveRemainingNanoUsd: 0n,
            ownerBalanceNanoUsd: 5000n * NANO_PER_CENT,
          },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'guest_budget_exhausted' });
  });
});

describe('resolveClientBilling — negative-balance guard', () => {
  it('solo caller with an overdrawn purchased wallet → insufficient_balance', () => {
    // getUserTier maps a negative balance to the free tier; the guard fires first.
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: -100n * NANO_PER_CENT,
          spendableNanoUsd: 0n,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });

  it('overdrawn wallet denies even when the served spendable is positive', () => {
    // Complementary defense (never collapse into the spendable compare): a
    // −$0.10 balance still yields a +40¢ cushioned spendable, but new paid
    // turns are hard-blocked until top-up.
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          purchasedBalanceNanoUsd: -10n * NANO_PER_CENT,
          spendableNanoUsd: 40n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 5n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });

  it('group owner with an overdrawn wallet → insufficient_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          group: {
            effectiveRemainingNanoUsd: 500n * NANO_PER_CENT,
            ownerBalanceNanoUsd: -100n * NANO_PER_CENT,
          },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });
});

describe('deriveClientFundingInputs — routes through the shared core', () => {
  it('a solo positive-balance caller resolves to self/purchased with premium allowed', () => {
    const fundingInputs = deriveClientFundingInputs(input({ tier: 'paid' }));
    expect(fundingInputs.isSolo).toBe(true);
    expect(resolveFundingDecision(fundingInputs)).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
    });
  });

  it('a non-owner member with headroom resolves to owner funding', () => {
    const fundingInputs = deriveClientFundingInputs(
      input({
        tier: 'free',
        purchasedBalanceNanoUsd: 0n,
        spendableNanoUsd: 50n * NANO_PER_CENT,
        group: {
          effectiveRemainingNanoUsd: 500n * NANO_PER_CENT,
          ownerBalanceNanoUsd: 5000n * NANO_PER_CENT,
        },
      })
    );
    expect(fundingInputs.isSolo).toBe(false);
    expect(resolveFundingDecision(fundingInputs)).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
    });
  });

  it('a link guest carries the isGuest flag into the core', () => {
    const fundingInputs = deriveClientFundingInputs(
      input({
        tier: 'guest',
        purchasedBalanceNanoUsd: 0n,
        spendableNanoUsd: 0n,
        group: { effectiveRemainingNanoUsd: 0n, ownerBalanceNanoUsd: 1n },
      })
    );
    expect(fundingInputs.isGuest).toBe(true);
    expect(resolveFundingDecision(fundingInputs)).toEqual({
      payer: 'refuse',
      refusalCode: 'GROUP_BUDGET_EXHAUSTED',
    });
  });

  it('feeds the RAW purchased balance to the core, preserving a negative sign', () => {
    // An overdrawn wallet keeps its sign so the core denies premium; the served
    // spendable (cushioned, possibly positive) must never stand in for it.
    const fundingInputs = deriveClientFundingInputs(
      input({
        tier: 'free',
        purchasedBalanceNanoUsd: -100n * NANO_PER_CENT,
        spendableNanoUsd: 40n * NANO_PER_CENT,
      })
    );
    expect(fundingInputs.callerOwnPurchasedBalanceNanoUsd).toBe(-100n * NANO_PER_CENT);
  });
});
