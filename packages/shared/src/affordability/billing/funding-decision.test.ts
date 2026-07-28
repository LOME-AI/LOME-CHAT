import { describe, expect, it } from 'vitest';
import { resolveFunding, type FundingInputs } from './funding-decision.js';

/** A four-cent turn estimate, the amount the group headroom has to cover. */
const ESTIMATE = 40_000_000n;

/**
 * Base inputs for a solo owner with a positive purchased balance selecting a
 * non-premium model, with no turn priced. Individual cases override only the
 * fields under test.
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
    turnEstimateNanoUsd: undefined,
    ...overrides,
  };
}

/** Group inputs whose three headroom dimensions are all `headroom`. */
function groupInputs(headroom: bigint, overrides: Partial<FundingInputs>): FundingInputs {
  return inputs({
    isSolo: false,
    memberRemainingNanoUsd: headroom,
    conversationRemainingNanoUsd: headroom,
    ownerPurchasedBalanceNanoUsd: headroom,
    callerOwnPurchasedBalanceNanoUsd: 0n,
    ...overrides,
  });
}

describe('resolveFunding', () => {
  it('funds a solo owner with a positive purchased balance from their purchased wallet', () => {
    expect(resolveFunding(inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 5n }))).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
    });
  });

  it('funds a solo owner with no purchased balance from their free wallet', () => {
    expect(resolveFunding(inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 0n }))).toEqual({
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
    });
  });

  it('locks a premium model for a self-funding caller with no purchased balance', () => {
    expect(
      resolveFunding(
        inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 0n, isPremiumModel: true })
      )
    ).toEqual({ payer: 'refuse', refusalCode: 'MODEL_TIER_LOCKED' });
  });

  it('allows a premium model for a self-funding caller with a positive purchased balance', () => {
    expect(
      resolveFunding(
        inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 5n, isPremiumModel: true })
      )
    ).toEqual({ payer: 'self', walletKind: 'purchased', premiumAllowed: true });
  });

  it('owner-funds a member turn when group headroom is positive', () => {
    expect(
      resolveFunding(
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
      resolveFunding(
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
      resolveFunding(
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
      resolveFunding(
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
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: -50n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 7n,
        })
      )
    ).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('treats an absent member-budget row (0 headroom) as fall-through to self funding', () => {
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 0n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('refuses a link guest when group headroom is exhausted (no wallet to fall through to)', () => {
    expect(
      resolveFunding(
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
      resolveFunding(
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

describe('resolveFunding — priority 1 compares the turn estimate', () => {
  it('owner-funds when the headroom exactly equals the turn estimate', () => {
    expect(resolveFunding(groupInputs(ESTIMATE, { turnEstimateNanoUsd: ESTIMATE }))).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
    });
  });

  it('falls through to self funding when the headroom is one nano below the turn estimate', () => {
    expect(
      resolveFunding(
        groupInputs(ESTIMATE - 1n, {
          turnEstimateNanoUsd: ESTIMATE,
          callerOwnPurchasedBalanceNanoUsd: 7n,
        })
      )
    ).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('refuses a link guest whose headroom is positive but below the turn estimate', () => {
    expect(
      resolveFunding(groupInputs(ESTIMATE - 1n, { isGuest: true, turnEstimateNanoUsd: ESTIMATE }))
    ).toEqual({ payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' });
  });

  it('owner-funds on positive headroom when no turn is priced', () => {
    // The unpriced query — who WOULD pay — has no estimate clause to apply.
    expect(resolveFunding(groupInputs(1n, { turnEstimateNanoUsd: undefined }))).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
    });
  });

  it('never owner-funds exhausted headroom, even against a zero turn estimate', () => {
    expect(
      resolveFunding(
        groupInputs(0n, { turnEstimateNanoUsd: 0n, callerOwnPurchasedBalanceNanoUsd: 7n })
      )
    ).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('marks no payer switch on a solo turn', () => {
    // `toStrictEqual` so the key is asserted present and undefined: a consumer
    // reading it sees "no disclosure", not a missing field.
    expect(resolveFunding(inputs({ isSolo: true, turnEstimateNanoUsd: ESTIMATE }))).toStrictEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: undefined,
    });
  });
});
