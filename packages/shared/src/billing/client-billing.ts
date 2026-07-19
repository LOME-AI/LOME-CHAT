/**
 * The client's imperative shell around the shared {@link resolveFundingDecision}
 * core. It is the client counterpart to the server's `resolvePayerWallet`: both
 * sides feed the SAME pure core, so who-pays + premium-tier decisions can never
 * drift between client and server (pinned by `funding-decision.contract.test.ts`).
 *
 * The core answers only two questions — WHO pays and WHETHER a premium model is
 * allowed. It says nothing about affordability or the trial quota. Those live
 * here, in the client-only affordability layer, which maps the core's
 * {@link FundingDecision} plus the caller's balances onto the notification
 * vocabulary that `generateNotifications()` renders (`insufficient_balance`,
 * `insufficient_free_allowance`, `trial_limit_exceeded`, `trial_fixed`, …). The
 * server never uses this vocabulary — its settlement path draws from the core
 * directly.
 */

import { MAX_TRIAL_MESSAGE_COST_CENTS } from '../constants.js';
import { getCushionCents } from '../budget.js';
import { resolveFundingDecision, type FundingInputs } from './funding-decision.js';
import type { UserTier } from '../tiers.js';

/**
 * Floating-point tolerance for the free-tier balance comparison. The wallet
 * balance round-trip (numeric(20,8) → parseFloat → *100) can lose sub-cent
 * precision vs the independently computed estimatedMinimumCostCents. 1e-6 cents
 * = $0.00000001 — negligible for real money, absorbs float errors.
 */
const FREE_TIER_FLOAT_TOLERANCE_CENTS = 1e-6;

export type FundingSource = 'owner_balance' | 'personal_balance' | 'free_allowance' | 'trial_fixed';

export type DenialReason =
  | 'premium_requires_balance'
  | 'insufficient_balance'
  | 'insufficient_free_allowance'
  | 'trial_limit_exceeded'
  | 'guest_budget_exhausted';

export type ResolveBillingResult =
  | { fundingSource: FundingSource }
  | { fundingSource: 'denied'; reason: DenialReason };

export interface ClientBillingInput {
  tier: UserTier;
  balanceCents: number;
  freeAllowanceCents: number;
  isPremiumModel: boolean;
  estimatedMinimumCostCents: number;
  /**
   * Group funding context for a non-owner participant. `effectiveCents` is the
   * backend's own `min(member cap, conversation cap, owner balance)` — the exact
   * figure admission gates on, never re-derived here. Absent for solo turns and
   * for owners.
   */
  group?: {
    effectiveCents: number;
    ownerBalanceCents: number;
  };
}

/**
 * Preserve the sign (and rough magnitude) of a cents figure as a nano-USD
 * `bigint`. The core reads only the SIGN of these balances for its who-pays
 * decision, so a positive figure must never round to `0n`; the ×1e7 scale keeps
 * ordering intact for the group-headroom `min`.
 */
function centsToSignedNano(cents: number): bigint {
  if (cents > 0) return BigInt(Math.max(1, Math.round(cents * 10_000_000)));
  if (cents < 0) return -BigInt(Math.max(1, Math.round(-cents * 10_000_000)));
  return 0n;
}

/**
 * Map the client's resolved primitives onto the core's {@link FundingInputs}.
 * `effectiveCents` is already the backend's clamped group minimum, so the three
 * group dimensions collapse onto it (the owner balance is carried through for
 * fidelity); the core's `min` therefore tracks the sign of `effectiveCents`.
 */
export function deriveClientFundingInputs(input: ClientBillingInput): FundingInputs {
  const isGuest = input.tier === 'guest';
  const callerOwnPurchasedBalanceNanoUsd = centsToSignedNano(input.balanceCents);

  if (input.group === undefined) {
    return {
      isSolo: true,
      isGuest,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: 0n,
      callerOwnPurchasedBalanceNanoUsd,
      isPremiumModel: input.isPremiumModel,
    };
  }

  const effective = centsToSignedNano(input.group.effectiveCents);
  return {
    isSolo: false,
    isGuest,
    memberRemainingNanoUsd: effective,
    conversationRemainingNanoUsd: effective,
    ownerPurchasedBalanceNanoUsd: centsToSignedNano(input.group.ownerBalanceCents),
    callerOwnPurchasedBalanceNanoUsd,
    isPremiumModel: input.isPremiumModel,
  };
}

/**
 * The affordability + trial-quota layer for a self-funding caller. The core has
 * already permitted the model tier, so this only asks "can the caller's own
 * wallet cover the estimate?" and picks the tier-specific vocabulary.
 */
function resolveSelfAffordability(input: ClientBillingInput): ResolveBillingResult {
  const { tier, balanceCents, freeAllowanceCents, estimatedMinimumCostCents } = input;

  if (tier === 'paid') {
    return balanceCents + getCushionCents('paid') >= estimatedMinimumCostCents
      ? { fundingSource: 'personal_balance' }
      : { fundingSource: 'denied', reason: 'insufficient_balance' };
  }

  if (tier === 'free') {
    return freeAllowanceCents + FREE_TIER_FLOAT_TOLERANCE_CENTS >= estimatedMinimumCostCents
      ? { fundingSource: 'free_allowance' }
      : { fundingSource: 'denied', reason: 'insufficient_free_allowance' };
  }

  if (tier === 'guest') {
    return { fundingSource: 'denied', reason: 'guest_budget_exhausted' };
  }

  return estimatedMinimumCostCents <= MAX_TRIAL_MESSAGE_COST_CENTS
    ? { fundingSource: 'trial_fixed' }
    : { fundingSource: 'denied', reason: 'trial_limit_exceeded' };
}

/**
 * Resolve billing for a message on the client: WHO pays or WHY it's denied.
 *
 * Who-pays + premium comes from the shared {@link resolveFundingDecision} core;
 * this function only translates the core's decision into the notification
 * vocabulary and layers the affordability / trial checks on top.
 */
export function resolveClientBilling(input: ClientBillingInput): ResolveBillingResult {
  // A negative balance on the wallet that would fund this turn hard-blocks new
  // paid turns until top-up (§13 — a negative balance lives on the purchased
  // wallet and never offsets against the free allowance). The server's admission
  // is authoritative; surfacing the denial here disables the composer before the
  // request is sent. The relevant wallet is the owner's for a group turn, the
  // caller's own otherwise.
  const payerBalanceCents =
    input.group === undefined ? input.balanceCents : input.group.ownerBalanceCents;
  if (payerBalanceCents < 0) {
    return { fundingSource: 'denied', reason: 'insufficient_balance' };
  }

  const decision = resolveFundingDecision(deriveClientFundingInputs(input));

  if (decision.payer === 'owner') {
    return { fundingSource: 'owner_balance' };
  }
  if (decision.payer === 'refuse') {
    return decision.refusalCode === 'MODEL_TIER_LOCKED'
      ? { fundingSource: 'denied', reason: 'premium_requires_balance' }
      : { fundingSource: 'denied', reason: 'guest_budget_exhausted' };
  }
  return resolveSelfAffordability(input);
}
