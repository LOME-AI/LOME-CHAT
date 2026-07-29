/**
 * The cross-side funding contract: the §2.K group-chat funding-scenario matrix
 * driven through the ONE shared decision core. Both sides resolve their
 * primitives their own way — the chat slice (`resolvePayerWallet` + the route
 * tier gate) from Postgres, the client (`resolveClientBilling` via
 * `deriveClientFundingInputs`) from its budgets / models endpoints — and then
 * call {@link resolveFunding}. Because there is a single decision
 * function, a scenario can be pinned once here and both sides are bound to the
 * same RULE; a change to that rule that split the two verdicts becomes a failure
 * of this table.
 *
 * What this table does NOT pin: that the two sides FEED the core the same inputs.
 * Every row hands the server leg a hand-written {@link FundingInputs} literal, so
 * a row's server inputs are what the chat slice COULD pass, never evidence of
 * what it does pass. The `minTurnCost` rows are where that matters — see the
 * note above them.
 *
 * Both legs are exercised:
 *  - the SERVER leg calls {@link resolveFunding} on the raw nano-USD
 *    {@link FundingInputs} (how the chat slice feeds it), and
 *  - the CLIENT leg feeds the equivalent nano-USD {@link ClientBillingInput}
 *    through the client's own {@link deriveClientFundingInputs} shell into the
 *    same core — proving the client production path lands on the identical
 *    decision.
 *
 * Trial funding (`trial_fixed`) is deliberately absent: it is a distinct funding
 * source gated by the trial quota policy, not a payer/premium decision, and it
 * never reaches this core.
 */
import { describe, expect, it } from 'vitest';
import { resolveFunding, type FundingDecision, type FundingInputs } from './funding-decision.js';
import { deriveClientFundingInputs, type ClientFundingContext } from './client-billing.js';

interface Scenario {
  readonly name: string;
  /** How the server (chat slice) feeds the core: raw nano-USD primitives. */
  readonly inputs: FundingInputs;
  /** How the client feeds the core: served nano-USD primitives through its own shell. */
  readonly clientInputs: ClientFundingContext;
  readonly expected: FundingDecision;
}

const ONE = 1_000_000n;

const MATRIX: readonly Scenario[] = [
  {
    name: 'owner solo, positive purchased balance → self / purchased, premium allowed',
    inputs: {
      isSolo: true,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: ONE,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'paid',
      purchasedBalanceNanoUsd: ONE,
      spendableNanoUsd: ONE,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: {
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: undefined,
    },
  },
  {
    name: 'owner solo, zero purchased balance → self / free, premium denied',
    inputs: {
      isSolo: true,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: 0n,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'free',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 0n,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: {
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
      payerSwitch: undefined,
    },
  },
  {
    name: 'free-allowance user selecting a premium model → MODEL_TIER_LOCKED',
    inputs: {
      isSolo: true,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: 0n,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: true,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'free',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 0n,
      isPremiumModel: true,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: { payer: 'refuse', refusalCode: 'MODEL_TIER_LOCKED' },
  },
  {
    name: 'member within budget (headroom > 0) → owner-funded / purchased',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: ONE,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'free',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 0n,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
      group: { effectiveRemainingNanoUsd: ONE, ownerBalanceNanoUsd: ONE },
    },
    expected: { payer: 'owner', walletKind: 'purchased', premiumAllowed: true },
  },
  {
    name: 'member within budget on a premium model → owner-funded (premium-exempt)',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: ONE,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: true,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'free',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 0n,
      isPremiumModel: true,
      estimatedMinimumCostNanoUsd: 0n,
      group: { effectiveRemainingNanoUsd: ONE, ownerBalanceNanoUsd: ONE },
    },
    expected: { payer: 'owner', walletKind: 'purchased', premiumAllowed: true },
  },
  {
    name: 'member over budget (headroom ≤ 0), positive own balance → self / purchased',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: ONE,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'paid',
      purchasedBalanceNanoUsd: ONE,
      spendableNanoUsd: ONE,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
      group: { effectiveRemainingNanoUsd: 0n, ownerBalanceNanoUsd: ONE },
    },
    expected: {
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    },
  },
  {
    name: 'member with no budget row (0 headroom), zero own balance → self / free',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'free',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 0n,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
      group: { effectiveRemainingNanoUsd: 0n, ownerBalanceNanoUsd: ONE },
    },
    expected: {
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
      payerSwitch: 'group_headroom_insufficient',
    },
  },
  {
    name: 'link guest, headroom > 0 → owner-funded / purchased',
    inputs: {
      isSolo: false,
      isGuest: true,
      memberRemainingNanoUsd: ONE,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'guest',
      purchasedBalanceNanoUsd: 0n,
      // A guest's served figure IS its headroom — one payer-scoped number, not
      // a group blob the client composes.
      spendableNanoUsd: ONE,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: { payer: 'owner', walletKind: 'purchased', premiumAllowed: true },
  },
  {
    name: 'link guest, headroom ≤ 0 → refused (no wallet)',
    inputs: {
      isSolo: false,
      isGuest: true,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'guest',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 0n,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: { payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' },
  },
  // The three rows below exercise §Funding Decision Matrix priority 1's
  // comparison. It is the SERVER leg that makes it, against the `minTurnCost`
  // the send path prices above the payer freeze; no production client caller
  // supplies a group dimension at all, so the client's own leg resolves the
  // solo arm and renders the served payer instead.
  {
    name: 'headroom exactly covering the turn minimum → owner-funded / purchased',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: ONE,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: ONE,
      isPremiumModel: false,
      minTurnCostNanoUsd: ONE,
    },
    clientInputs: {
      tier: 'paid',
      purchasedBalanceNanoUsd: ONE,
      spendableNanoUsd: ONE,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: ONE,
      group: { effectiveRemainingNanoUsd: ONE, ownerBalanceNanoUsd: ONE },
    },
    expected: { payer: 'owner', walletKind: 'purchased', premiumAllowed: true },
  },
  {
    name: 'headroom one nano below the turn estimate → self / purchased, payer switched',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: ONE - 1n,
      conversationRemainingNanoUsd: ONE - 1n,
      ownerPurchasedBalanceNanoUsd: ONE - 1n,
      callerOwnPurchasedBalanceNanoUsd: ONE,
      isPremiumModel: false,
      minTurnCostNanoUsd: ONE,
    },
    clientInputs: {
      tier: 'paid',
      purchasedBalanceNanoUsd: ONE,
      spendableNanoUsd: ONE,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: ONE,
      group: { effectiveRemainingNanoUsd: ONE - 1n, ownerBalanceNanoUsd: ONE - 1n },
    },
    expected: {
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    },
  },
  {
    name: 'link guest, headroom below the turn estimate → refused (no wallet)',
    inputs: {
      isSolo: false,
      isGuest: true,
      memberRemainingNanoUsd: ONE - 1n,
      conversationRemainingNanoUsd: ONE - 1n,
      ownerPurchasedBalanceNanoUsd: ONE - 1n,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: ONE,
    },
    clientInputs: {
      tier: 'guest',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: ONE - 1n,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: ONE,
    },
    expected: { payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' },
  },
];

describe('§2.K funding-scenario contract', () => {
  it.each(MATRIX)('server leg — $name', ({ inputs, expected }) => {
    expect(resolveFunding(inputs)).toEqual(expected);
  });

  it.each(MATRIX)('client leg — $name', ({ clientInputs, expected }) => {
    // The client's production shell (deriveClientFundingInputs) feeds the SAME
    // core, so its decision must match the server's for the same scenario.
    expect(resolveFunding(deriveClientFundingInputs(clientInputs))).toEqual(expected);
  });

  it('binds both sides — client and server resolve every scenario identically', () => {
    for (const { inputs, clientInputs } of MATRIX) {
      expect(resolveFunding(deriveClientFundingInputs(clientInputs))).toEqual(
        resolveFunding(inputs)
      );
    }
  });
});
