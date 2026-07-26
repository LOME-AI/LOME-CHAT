/**
 * The pure funding + premium-tier decision — the single source of truth for
 * two questions a chat turn must answer before it runs: WHO pays (which
 * wallet), and WHETHER a premium model is permitted. It is the "functional
 * core": no DB, no I/O, no Zod — only the primitive balances and flags the
 * caller has already resolved. Both the server (the chat slice, from Postgres)
 * and the client (from its budgets / models endpoints) resolve those primitives
 * their own way and then call THIS function. The chat slice's
 * `resolvePayerWallet` and route tier gate are its imperative shells; a contract
 * test pins the §2.K funding-scenario matrix against it.
 *
 * The RULE is shared; the INPUTS are not, so the two sides do NOT always reach
 * the same verdict today. The send path freezes the payer before the turn is
 * priced (see `turnEstimateNanoUsd` below) and therefore supplies no estimate,
 * which makes priority 1's estimate clause client-only: for a group member whose
 * headroom is positive but below the estimate, the client resolves `self` with a
 * `payerSwitch` while `resolvePayerWallet` resolves `owner`, and admission's
 * per-scope check then refuses the send. That divergence is a spec violation, not
 * a documented stop — §Funding Decision Matrix priority 1 and §Group Funding 6(a)
 * fall a signed-in member through to personal funds, and 6(b)'s hard refusal
 * covers only the race where the client's retry re-resolves, whereas this case
 * re-resolves to the same refusal forever. The contract test cannot catch it: it
 * hands both legs the same inputs by construction, so it pins the shared rule and
 * never the callers' input parity.
 *
 * The branching it encodes is exactly what previously lived inline in the chat
 * slice: the clamp-then-min group headroom, purchased-then-free wallet
 * selection, the owner-funded premium exemption, and the
 * `canAccessPremium = own purchased > 0` gate.
 */

/**
 * The primitive inputs the decision reads — all already resolved by the caller.
 * Balances are nano-USD `bigint`. `memberRemainingNanoUsd` is `0n` for an absent
 * `member_budgets` row (a missing cap is zero headroom, never unlimited).
 * `isPremiumModel` is the caller's premium classification of the selected
 * model(s) — the server does not consult it when it only needs the payer.
 */
export interface FundingInputs {
  /** The sender is the conversation owner (a solo turn) — always self-funded. */
  readonly isSolo: boolean;
  /** The sender is a link guest, which holds no wallet and cannot self-fund. */
  readonly isGuest: boolean;
  /** Sender's remaining per-member budget (cap − spent); `0n` when no row. */
  readonly memberRemainingNanoUsd: bigint;
  /** Conversation's remaining budget (cap − spent). */
  readonly conversationRemainingNanoUsd: bigint;
  /** Owner's purchased-wallet balance (the only pool group turns draw from). */
  readonly ownerPurchasedBalanceNanoUsd: bigint;
  /** Caller's own purchased-wallet balance — gates self-funding and premium. */
  readonly callerOwnPurchasedBalanceNanoUsd: bigint;
  /** Whether the selected model is premium-tier. */
  readonly isPremiumModel: boolean;
  /**
   * The estimated cost the group headroom must cover for the owner to fund the
   * turn (BILLING §Funding Decision Matrix priority 1): headroom that cannot
   * cover it is not fundable, so a signed-in sender falls through to personal
   * funds and a guest is refused.
   *
   * `undefined` means NO turn is being priced — the caller asks only who WOULD
   * pay, and priority 1's estimate clause is inapplicable. Three callers ask
   * that question: the served funding snapshot (which names the payer before a
   * prompt exists), the premium tier gate, and the send path's payer-wallet
   * freeze (the payer is chosen before the turn is priced, because the turn's
   * ceiling is bounded by what the payer can pay). Deliberately not an amount:
   * an unpriced query cannot be mistaken for a free turn.
   */
  readonly turnEstimateNanoUsd: bigint | undefined;
}

/**
 * Why a group turn's payer changed to the sender. One typed value covers both
 * shapes — an allowance that ran out and one that was never granted — because
 * §Notices 5's disclosure is the same in both: the sender is about to be
 * charged. Copy derives from this reason in one place (§Notices 1), never from a
 * boolean a surface interprets for itself.
 */
export type PayerSwitchReason = 'group_headroom_insufficient';

/**
 * The decision. `self` — the caller pays their own wallet (`purchased` while it
 * carries a positive balance, else the `free` daily-allowance wallet); its
 * `premiumAllowed` mirrors the tier gate. `owner` — an owner-funded group turn
 * draws the owner's purchased wallet and is premium-exempt by construction.
 * `refuse` — the turn cannot be funded/allowed: `GROUP_BUDGET_EXHAUSTED` (a link
 * guest with no headroom and no wallet) or `MODEL_TIER_LOCKED` (a self-funding
 * caller with no purchased balance selecting a premium model).
 */
export type FundingDecision =
  | {
      readonly payer: 'self';
      readonly walletKind: 'purchased' | 'free';
      readonly premiumAllowed: boolean;
      /**
       * Set only when a group turn's headroom could not cover it, so the sender
       * pays instead of the owner — the pre-send disclosure §Notices 5 requires.
       * `undefined` on a turn that was self-funded all along.
       */
      readonly payerSwitch: PayerSwitchReason | undefined;
    }
  | { readonly payer: 'owner'; readonly walletKind: 'purchased'; readonly premiumAllowed: true }
  | {
      readonly payer: 'refuse';
      readonly refusalCode: 'GROUP_BUDGET_EXHAUSTED' | 'MODEL_TIER_LOCKED';
    };

function clampNonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

/**
 * The spendable group headroom: the smallest of the three dimensions, each
 * clamped to ≥ 0 first so an overspent or absent dimension reads as zero and
 * cannot be masked by a larger sibling.
 */
function groupHeadroom(
  memberRemainingNanoUsd: bigint,
  conversationRemainingNanoUsd: bigint,
  ownerPurchasedBalanceNanoUsd: bigint
): bigint {
  let smallest = clampNonNegative(memberRemainingNanoUsd);
  const conversationRemaining = clampNonNegative(conversationRemainingNanoUsd);
  const ownerBalance = clampNonNegative(ownerPurchasedBalanceNanoUsd);
  if (conversationRemaining < smallest) smallest = conversationRemaining;
  if (ownerBalance < smallest) smallest = ownerBalance;
  return smallest;
}

/**
 * Whether the owner funds the turn: headroom remains AND it covers the turn's
 * estimate. Both clauses are load-bearing — exhausted headroom is never
 * fundable whatever the estimate, and headroom that cannot cover this turn is
 * not fundable however positive it is (the failure this comparison exists to
 * catch: a remainder too small to answer with, presented as sendable and then
 * refused at admission). An unpriced query has no estimate clause to apply.
 */
function coversTurn(headroom: bigint, turnEstimateNanoUsd: bigint | undefined): boolean {
  if (headroom <= 0n) return false;
  return turnEstimateNanoUsd === undefined || headroom >= turnEstimateNanoUsd;
}

/**
 * Self-funding: purchased wallet while positive, else the free wallet. Premium
 * is allowed exactly when the caller's own purchased balance is positive; a
 * premium selection without it is the `MODEL_TIER_LOCKED` refusal — which
 * carries no payer-switch disclosure, because a refused send has a refusal
 * notice instead.
 */
function selfFunding(
  callerOwnPurchasedBalanceNanoUsd: bigint,
  isPremiumModel: boolean,
  payerSwitch?: PayerSwitchReason
): FundingDecision {
  const canAccessPremium = callerOwnPurchasedBalanceNanoUsd > 0n;
  if (isPremiumModel && !canAccessPremium) {
    return { payer: 'refuse', refusalCode: 'MODEL_TIER_LOCKED' };
  }
  return {
    payer: 'self',
    walletKind: canAccessPremium ? 'purchased' : 'free',
    premiumAllowed: canAccessPremium,
    payerSwitch,
  };
}

/**
 * Resolve the funding + premium decision. A solo turn always self-funds. A
 * non-solo turn whose group headroom covers the turn is owner-funded
 * (premium-exempt); headroom that does not cover it refuses a link guest and
 * falls a signed-in member through to self-funding, carrying the payer-switch
 * reason.
 */
export function resolveFundingDecision(inputs: FundingInputs): FundingDecision {
  if (!inputs.isSolo) {
    const effective = groupHeadroom(
      inputs.memberRemainingNanoUsd,
      inputs.conversationRemainingNanoUsd,
      inputs.ownerPurchasedBalanceNanoUsd
    );
    if (coversTurn(effective, inputs.turnEstimateNanoUsd)) {
      return { payer: 'owner', walletKind: 'purchased', premiumAllowed: true };
    }
    if (inputs.isGuest) {
      return { payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' };
    }
    return selfFunding(
      inputs.callerOwnPurchasedBalanceNanoUsd,
      inputs.isPremiumModel,
      'group_headroom_insufficient'
    );
  }
  return selfFunding(inputs.callerOwnPurchasedBalanceNanoUsd, inputs.isPremiumModel);
}
