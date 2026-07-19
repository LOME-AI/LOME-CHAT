import { describe, expect, it } from 'vitest';
import { resolveFundingDecision, type FundingInputs } from './funding-decision.js';

/**
 * Base inputs for a solo owner with a positive purchased balance selecting a
 * non-premium model. Individual cases override only the fields under test.
 */
function inputs(overrides: Partial<FundingInputs>): FundingInputs {
  return {
    isSolo: true,
    isGuest: false,
    memberRemainingNanoUsd: 0n,
    conversationRemainingNanoUsd: 0n,
    ownerPurchasedBalanceNanoUsd: 0n,
    callerOwnPurchasedBalanceNanoUsd: 1000n,
    isPremiumModel: false,
    ...overrides,
  };
}

describe('resolveFundingDecision', () => {
  it('funds a solo owner with a positive purchased balance from their purchased wallet', () => {
    expect(
      resolveFundingDecision(inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 5n }))
    ).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
    });
  });

  it('funds a solo owner with no purchased balance from their free wallet', () => {
    expect(
      resolveFundingDecision(inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 0n }))
    ).toEqual({
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
    });
  });

  it('locks a premium model for a self-funding caller with no purchased balance', () => {
    expect(
      resolveFundingDecision(
        inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 0n, isPremiumModel: true })
      )
    ).toEqual({ payer: 'refuse', refusalCode: 'MODEL_TIER_LOCKED' });
  });

  it('allows a premium model for a self-funding caller with a positive purchased balance', () => {
    expect(
      resolveFundingDecision(
        inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 5n, isPremiumModel: true })
      )
    ).toEqual({ payer: 'self', walletKind: 'purchased', premiumAllowed: true });
  });

  it('owner-funds a member turn when group headroom is positive', () => {
    expect(
      resolveFundingDecision(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 100n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({ payer: 'owner', walletKind: 'purchased', premiumAllowed: true });
  });

  it('owner-funds a member turn on a premium model without a tier lock (owner-funded exemption)', () => {
    expect(
      resolveFundingDecision(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 100n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
          isPremiumModel: true,
        })
      )
    ).toEqual({ payer: 'owner', walletKind: 'purchased', premiumAllowed: true });
  });

  it('owner-funds when the conversation dimension is the tightest positive headroom', () => {
    expect(
      resolveFundingDecision(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 1000n,
          conversationRemainingNanoUsd: 5n,
          ownerPurchasedBalanceNanoUsd: 1000n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({ payer: 'owner', walletKind: 'purchased', premiumAllowed: true });
  });

  it('owner-funds when the owner balance is the tightest positive headroom', () => {
    expect(
      resolveFundingDecision(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 1000n,
          conversationRemainingNanoUsd: 1000n,
          ownerPurchasedBalanceNanoUsd: 5n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({ payer: 'owner', walletKind: 'purchased', premiumAllowed: true });
  });

  it('clamps each headroom dimension to zero before the min so an overspent member blocks owner funding', () => {
    expect(
      resolveFundingDecision(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: -50n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 7n,
        })
      )
    ).toEqual({ payer: 'self', walletKind: 'purchased', premiumAllowed: true });
  });

  it('treats an absent member-budget row (0 headroom) as fall-through to self funding', () => {
    expect(
      resolveFundingDecision(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 0n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({ payer: 'self', walletKind: 'free', premiumAllowed: false });
  });

  it('refuses a link guest when group headroom is exhausted (no wallet to fall through to)', () => {
    expect(
      resolveFundingDecision(
        inputs({
          isSolo: false,
          isGuest: true,
          memberRemainingNanoUsd: 0n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({ payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' });
  });

  it('owner-funds a link guest when group headroom is positive', () => {
    expect(
      resolveFundingDecision(
        inputs({
          isSolo: false,
          isGuest: true,
          memberRemainingNanoUsd: 100n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({ payer: 'owner', walletKind: 'purchased', premiumAllowed: true });
  });
});
