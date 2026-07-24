/**
 * The client's imperative shell around the shared {@link resolveFundingDecision}
 * core. It is the client counterpart to the server's `resolvePayerWallet`: both
 * sides feed the SAME pure core, so who-pays + premium-tier decisions can never
 * drift between client and server (pinned by `funding-decision.contract.test.ts`).
 *
 * The core answers only two questions — WHO pays and WHETHER a premium model is
 * allowed. It says nothing about affordability or the trial quota. Those live
 * here, in the client-only affordability layer, which maps the core's
 * {@link FundingDecision} plus the caller's served numbers onto the notification
 * vocabulary that `generateNotifications()` renders (`insufficient_balance`,
 * `insufficient_free_allowance`, `trial_limit_exceeded`, `trial_fixed`, …). The
 * server never uses this vocabulary — its settlement path draws from the core
 * directly.
 *
 * All money here is nano-USD `bigint`, exact end-to-end — cents exist only at
 * display formatting, never in a decision.
 */

import { MAX_TRIAL_MESSAGE_COST_CENTS } from '../constants.js';
import { NANO_USD_PER_CENT } from '../nano-usd.js';
import { resolveFundingDecision, type FundingInputs } from './funding-decision.js';
import type { UserTier } from '../tiers.js';

/** The trial/guest fixed per-message ceiling, in nano-USD (client-side arm — trial has no served-spendable endpoint). */
const TRIAL_FIXED_COST_CAP_NANO_USD: bigint =
  BigInt(MAX_TRIAL_MESSAGE_COST_CENTS) * NANO_USD_PER_CENT;

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
  /**
   * The RAW served purchased-wallet balance (negative-capable). Feeds the
   * negative-balance hard block and the core's who-pays sign — never the
   * affordability compare (that is {@link ClientBillingInput.spendableNanoUsd}).
   */
  purchasedBalanceNanoUsd: bigint;
  /**
   * The SERVED spendable (`GET /billing/spendable`): cushion- and hold-aware,
   * exactly what admission's balance gate compares. The cushion is baked in
   * exactly once server-side — this layer must never re-add it (the
   * double-cushion hazard). `0n` for tiers with no endpoint (trial/guest).
   */
  spendableNanoUsd: bigint;
  /** The served daily free-allowance remaining. */
  freeAllowanceNanoUsd: bigint;
  isPremiumModel: boolean;
  estimatedMinimumCostNanoUsd: bigint;
  /**
   * Group funding context for a non-owner participant.
   * `effectiveRemainingNanoUsd` is the backend's own hold-aware
   * `min(member cap, conversation cap, owner balance)` — the exact figure
   * admission gates on, never re-derived here. Absent for solo turns and for
   * owners.
   */
  group?: {
    effectiveRemainingNanoUsd: bigint;
    ownerBalanceNanoUsd: bigint;
  };
}

/**
 * Map the client's served nano numbers onto the core's {@link FundingInputs}.
 * `effectiveRemainingNanoUsd` is already the backend's clamped group minimum,
 * so the member/conversation dimensions collapse onto it (the owner balance is
 * carried through for fidelity); the core's `min` therefore tracks the sign of
 * the effective remaining. The caller's own balance is the RAW wallet figure —
 * the core reads its sign for premium access, which a cushioned spendable
 * would falsify.
 */
export function deriveClientFundingInputs(input: ClientBillingInput): FundingInputs {
  const isGuest = input.tier === 'guest';

  if (input.group === undefined) {
    return {
      isSolo: true,
      isGuest,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: 0n,
      callerOwnPurchasedBalanceNanoUsd: input.purchasedBalanceNanoUsd,
      isPremiumModel: input.isPremiumModel,
    };
  }

  return {
    isSolo: false,
    isGuest,
    memberRemainingNanoUsd: input.group.effectiveRemainingNanoUsd,
    conversationRemainingNanoUsd: input.group.effectiveRemainingNanoUsd,
    ownerPurchasedBalanceNanoUsd: input.group.ownerBalanceNanoUsd,
    callerOwnPurchasedBalanceNanoUsd: input.purchasedBalanceNanoUsd,
    isPremiumModel: input.isPremiumModel,
  };
}

/**
 * The affordability + trial-quota layer for a self-funding caller. The core has
 * already permitted the model tier, so this only asks "can the caller's own
 * funds cover the estimate?" and picks the tier-specific vocabulary. Exact
 * bigint compares throughout — no float tolerance exists in integer money.
 */
function resolveSelfFunding(input: ClientBillingInput): ResolveBillingResult {
  const { tier, spendableNanoUsd, freeAllowanceNanoUsd, estimatedMinimumCostNanoUsd } = input;

  if (tier === 'paid') {
    // The served spendable already includes the negative-balance cushion (and
    // subtracts active holds) — compare directly, never re-add the cushion.
    return spendableNanoUsd >= estimatedMinimumCostNanoUsd
      ? { fundingSource: 'personal_balance' }
      : { fundingSource: 'denied', reason: 'insufficient_balance' };
  }

  if (tier === 'free') {
    return freeAllowanceNanoUsd >= estimatedMinimumCostNanoUsd
      ? { fundingSource: 'free_allowance' }
      : { fundingSource: 'denied', reason: 'insufficient_free_allowance' };
  }

  if (tier === 'guest') {
    return { fundingSource: 'denied', reason: 'guest_budget_exhausted' };
  }

  return estimatedMinimumCostNanoUsd <= TRIAL_FIXED_COST_CAP_NANO_USD
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
  // wallet and never offsets against the free allowance). This reads the RAW
  // served balance — a complementary defense the cushioned spendable compare
  // must never absorb (a −$0.10 wallet still shows a positive spendable). The
  // server's admission is authoritative; surfacing the denial here disables the
  // composer before the request is sent. The relevant wallet is the owner's for
  // a group turn, the caller's own otherwise.
  const payerBalanceNanoUsd =
    input.group === undefined ? input.purchasedBalanceNanoUsd : input.group.ownerBalanceNanoUsd;
  if (payerBalanceNanoUsd < 0n) {
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
  return resolveSelfFunding(input);
}
