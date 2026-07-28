/**
 * The client's imperative shell around the shared {@link resolveFunding}
 * core. It is the client counterpart to the server's `resolvePayerWallet`: both
 * sides feed the SAME pure core, so the who-pays + premium-tier RULE is shared —
 * but the inputs are not, and the verdicts can differ. This shell passes the
 * turn's estimate into the core; the server's payer freeze passes none (it
 * chooses the payer before the turn is priced), so §Funding Decision Matrix
 * priority 1's estimate clause applies here and not there. A member whose group
 * headroom is positive but below the estimate is told here that personal funds
 * will pay, while the server still resolves the owner as payer and admission
 * refuses the send. `funding-decision.contract.test.ts` pins the rule both sides
 * run, not the inputs they feed it.
 *
 * The core answers only two questions — WHO pays and WHETHER a premium model is
 * allowed. It says nothing about affordability or the trial quota. Those live
 * here, in the client-only affordability layer, which maps the core's
 * {@link FundingDecision} plus the caller's served numbers onto this module's
 * own denial discriminator ({@link DenialReason}). That discriminator names WHY
 * the client refused; `generateNotifications()` maps it onto the shared typed
 * notice vocabulary, which is where the wording lives. The server never uses
 * this discriminator — its settlement path draws from the core directly.
 *
 * All money here is nano-USD `bigint`, exact end-to-end — cents exist only at
 * display formatting, never in a decision.
 */

import { MAX_TRIAL_MESSAGE_COST_CENTS } from '../constants.js';
import { NANO_USD_PER_CENT } from '../nano-usd.js';
import { resolveFunding, type FundingInputs, type PayerSwitchReason } from './funding-decision.js';
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
  /**
   * `payerSwitch` is present exactly when a group turn's headroom could not
   * cover this turn and the sender pays instead of the owner — the affirmative
   * pre-send disclosure §Notices 5 requires, since that send succeeds and would
   * otherwise change who is charged silently. Absent on a refused send, which
   * carries its refusal reason instead.
   */
  | { fundingSource: FundingSource; payerSwitch?: PayerSwitchReason }
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
   *
   * It is ONE number for every authenticated tier: a paid payer's is the
   * cushioned wallet spendable, a free payer's is the day-keyed allowance
   * remaining, and both arrive hold-aware from the same field. There is no
   * second funding figure to compose against, which is what makes the
   * affordability compare below tier-blind in its arithmetic and tier-keyed
   * only in its vocabulary.
   */
  spendableNanoUsd: bigint;
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
 * The funding-relevant subset of {@link ClientBillingInput}: who pays depends on
 * the caller's tier, raw balance, model tier, the served group figures, and — at
 * priority 1 — the amount the group headroom has to cover, never on the
 * affordability balances. `ClientBillingInput` is structurally assignable to it.
 *
 * `estimatedMinimumCostNanoUsd` is `undefined` for a caller asking only who
 * WOULD pay, with no turn priced.
 */
export interface ClientFundingContext {
  tier: UserTier;
  purchasedBalanceNanoUsd: bigint;
  isPremiumModel: boolean;
  estimatedMinimumCostNanoUsd: bigint | undefined;
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
 * would falsify. The estimate the surface is judging is what priority 1's group
 * headroom must cover, so it crosses into the core under the core's own name.
 */
export function deriveClientFundingInputs(input: ClientFundingContext): FundingInputs {
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
      turnEstimateNanoUsd: input.estimatedMinimumCostNanoUsd,
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
    turnEstimateNanoUsd: input.estimatedMinimumCostNanoUsd,
  };
}

/**
 * The tier the client SIZES a turn with (input-token ratio, output-storage
 * ratio, cushion inputs): owner-funded means owner-priced (BILLING §Group
 * Funding 1) — an owner-funded turn is estimated exactly as if the owner sent
 * it, and the owner's admitted wallet is a purchased one, so the payer tier is
 * `paid` by construction (the server derives the same tier from the admitted
 * wallet's kind). Everywhere the sender pays — solo turns, exhausted-headroom
 * fall-through, guests refused — sizing keeps the caller's own tier. Routes
 * through the SAME shared funding core as {@link resolveClientBilling}
 * (`isPremiumModel` is irrelevant to who-pays, so it is fixed `false` here,
 * mirroring the server's turn-context derivation), so the who-pays verdict and
 * the sizing tier can never drift. A caller with no turn priced
 * (`estimatedMinimumCostNanoUsd: undefined`) gets the tier of whoever would pay
 * a turn of unknown size.
 */
export function payerSizingTier(input: Omit<ClientFundingContext, 'isPremiumModel'>): UserTier {
  if (input.group === undefined) return input.tier;
  const decision = resolveFunding(deriveClientFundingInputs({ ...input, isPremiumModel: false }));
  return decision.payer === 'owner' ? 'paid' : input.tier;
}

/**
 * The affordability + trial-quota layer for a self-funding caller. The core has
 * already permitted the model tier, so this only asks "can the caller's own
 * funds cover the estimate?" and picks the tier-specific vocabulary. Exact
 * bigint compares throughout — no float tolerance exists in integer money.
 */
function resolveSelfFunding(
  input: ClientBillingInput,
  payerSwitch: PayerSwitchReason | undefined
): ResolveBillingResult {
  const { tier, spendableNanoUsd, estimatedMinimumCostNanoUsd } = input;
  // Carried onto the approved arms only: a denial states its own reason, and
  // §Notices 5's disclosure exists for the send that succeeds.
  const disclosure = payerSwitch === undefined ? {} : { payerSwitch };

  // Paid and free run the SAME compare against the SAME served number — the
  // wallet each draws on differs, but which wallet it is was decided
  // server-side and is already baked into the served figure. Only the
  // vocabulary is tier-keyed: what the payer can do about a shortfall differs
  // (top up versus wait for tomorrow), so the two arms name different sources
  // and different reasons for one piece of arithmetic.
  if (tier === 'paid' || tier === 'free') {
    const source = tier === 'paid' ? 'personal_balance' : 'free_allowance';
    const reason = tier === 'paid' ? 'insufficient_balance' : 'insufficient_free_allowance';
    return spendableNanoUsd >= estimatedMinimumCostNanoUsd
      ? { fundingSource: source, ...disclosure }
      : { fundingSource: 'denied', reason };
  }

  if (tier === 'guest') {
    return { fundingSource: 'denied', reason: 'guest_budget_exhausted' };
  }

  return estimatedMinimumCostNanoUsd <= TRIAL_FIXED_COST_CAP_NANO_USD
    ? { fundingSource: 'trial_fixed', ...disclosure }
    : { fundingSource: 'denied', reason: 'trial_limit_exceeded' };
}

/**
 * Resolve billing for a message on the client: WHO pays or WHY it's denied.
 *
 * Who-pays + premium comes from the shared {@link resolveFunding} core;
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

  const decision = resolveFunding(deriveClientFundingInputs(input));

  if (decision.payer === 'owner') {
    return { fundingSource: 'owner_balance' };
  }
  if (decision.payer === 'refuse') {
    return decision.refusalCode === 'MODEL_TIER_LOCKED'
      ? { fundingSource: 'denied', reason: 'premium_requires_balance' }
      : { fundingSource: 'denied', reason: 'guest_budget_exhausted' };
  }
  return resolveSelfFunding(input, decision.payerSwitch);
}
