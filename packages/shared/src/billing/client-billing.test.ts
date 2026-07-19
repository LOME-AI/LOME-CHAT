import { describe, expect, it } from 'vitest';
import {
  resolveClientBilling,
  deriveClientFundingInputs,
  type ClientBillingInput,
  type ResolveBillingResult,
} from './client-billing.js';
import { resolveFundingDecision } from './funding-decision.js';

function input(overrides: Partial<ClientBillingInput>): ClientBillingInput {
  return {
    tier: 'paid',
    balanceCents: 1000,
    freeAllowanceCents: 0,
    isPremiumModel: false,
    estimatedMinimumCostCents: 10,
    ...overrides,
  };
}

describe('resolveClientBilling — self-funding vocabulary', () => {
  it('paid tier with sufficient balance → personal_balance', () => {
    expect(
      resolveClientBilling(input({ tier: 'paid', balanceCents: 1000 }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });

  it('paid tier below balance+cushion → insufficient_balance', () => {
    expect(
      resolveClientBilling(
        input({ tier: 'paid', balanceCents: 1, estimatedMinimumCostCents: 100_000 })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });

  it('paid tier within the $0.50 cushion → personal_balance', () => {
    // balance 0¢ + 50¢ cushion covers a 40¢ estimate
    expect(
      resolveClientBilling(input({ tier: 'paid', balanceCents: 0, estimatedMinimumCostCents: 40 }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });

  it('free tier with allowance covering the estimate → free_allowance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 100,
          estimatedMinimumCostCents: 10,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
  });

  it('free tier with depleted allowance → insufficient_free_allowance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          estimatedMinimumCostCents: 10,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'insufficient_free_allowance',
    });
  });

  it('trial tier within the fixed cap → trial_fixed', () => {
    expect(
      resolveClientBilling(input({ tier: 'trial', balanceCents: 0, estimatedMinimumCostCents: 1 }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'trial_fixed' });
  });

  it('trial tier over the fixed cap → trial_limit_exceeded', () => {
    expect(
      resolveClientBilling(input({ tier: 'trial', balanceCents: 0, estimatedMinimumCostCents: 10 }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'trial_limit_exceeded' });
  });

  it('guest tier without group budget → guest_budget_exhausted', () => {
    expect(
      resolveClientBilling(input({ tier: 'guest', balanceCents: 0, estimatedMinimumCostCents: 1 }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'guest_budget_exhausted' });
  });
});

describe('resolveClientBilling — premium gating via the shared core', () => {
  it('free tier selecting a premium model → premium_requires_balance', () => {
    expect(
      resolveClientBilling(input({ tier: 'free', balanceCents: 0, isPremiumModel: true }))
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
          balanceCents: 0,
          isPremiumModel: true,
          estimatedMinimumCostCents: 1,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'premium_requires_balance',
    });
  });

  it('paid tier selecting a premium model it can afford → personal_balance', () => {
    expect(
      resolveClientBilling(input({ tier: 'paid', balanceCents: 1000, isPremiumModel: true }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });
});

describe('resolveClientBilling — group / owner funding', () => {
  it('group budget available → owner_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          balanceCents: 0,
          group: { effectiveCents: 500, ownerBalanceCents: 5000 },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'owner_balance' });
  });

  it('group budget available on a premium model → owner_balance (owner is premium-exempt)', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          balanceCents: 0,
          isPremiumModel: true,
          group: { effectiveCents: 500, ownerBalanceCents: 5000 },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'owner_balance' });
  });

  it('group budget exhausted → falls through to the caller personal balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          balanceCents: 1000,
          group: { effectiveCents: 0, ownerBalanceCents: 5000 },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });

  it('guest with group budget exhausted → guest_budget_exhausted', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'guest',
          balanceCents: 0,
          estimatedMinimumCostCents: 1,
          group: { effectiveCents: 0, ownerBalanceCents: 5000 },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'guest_budget_exhausted' });
  });
});

describe('resolveClientBilling — negative-balance guard', () => {
  it('solo caller with an overdrawn purchased wallet → insufficient_balance', () => {
    // getUserTier maps a negative balance to the free tier; the guard fires first.
    expect(
      resolveClientBilling(input({ tier: 'free', balanceCents: -100 }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });

  it('group owner with an overdrawn wallet → insufficient_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          balanceCents: 0,
          group: { effectiveCents: 500, ownerBalanceCents: -100 },
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });
});

describe('deriveClientFundingInputs — routes through the shared core', () => {
  it('a solo positive-balance caller resolves to self/purchased with premium allowed', () => {
    const fundingInputs = deriveClientFundingInputs(input({ tier: 'paid', balanceCents: 1000 }));
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
        balanceCents: 0,
        group: { effectiveCents: 500, ownerBalanceCents: 5000 },
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
      input({ tier: 'guest', balanceCents: 0, group: { effectiveCents: 0, ownerBalanceCents: 1 } })
    );
    expect(fundingInputs.isGuest).toBe(true);
    expect(resolveFundingDecision(fundingInputs)).toEqual({
      payer: 'refuse',
      refusalCode: 'GROUP_BUDGET_EXHAUSTED',
    });
  });

  it('preserves a negative caller balance as a negative signed-nano primitive', () => {
    // An overdrawn wallet keeps its sign so the core denies premium (canAccessPremium = balance > 0).
    const fundingInputs = deriveClientFundingInputs(input({ tier: 'free', balanceCents: -100 }));
    expect(fundingInputs.callerOwnPurchasedBalanceNanoUsd).toBeLessThan(0n);
  });
});
