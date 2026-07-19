/**
 * The pure funding + premium-tier decision — the single source of truth for
 * two questions a chat turn must answer before it runs: WHO pays (which
 * wallet), and WHETHER a premium model is permitted. It is the "functional
 * core": no DB, no I/O, no Zod — only the primitive balances and flags the
 * caller has already resolved. Both the server (the chat slice, from Postgres)
 * and the client (from its budgets / models endpoints) resolve those primitives
 * their own way and then call THIS function, so the two sides can never drift on
 * the decision itself. The chat slice's `resolvePayerWallet` and route tier gate
 * are its imperative shells; a contract test pins the §2.K funding-scenario
 * matrix against it.
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
}

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
 * cannot be masked by a larger sibling. `> 0` selects owner funding; `≤ 0` is
 * the fall-through signal.
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
 * Self-funding: purchased wallet while positive, else the free wallet. Premium
 * is allowed exactly when the caller's own purchased balance is positive; a
 * premium selection without it is the `MODEL_TIER_LOCKED` refusal.
 */
function selfFunding(
  callerOwnPurchasedBalanceNanoUsd: bigint,
  isPremiumModel: boolean
): FundingDecision {
  const canAccessPremium = callerOwnPurchasedBalanceNanoUsd > 0n;
  if (isPremiumModel && !canAccessPremium) {
    return { payer: 'refuse', refusalCode: 'MODEL_TIER_LOCKED' };
  }
  return {
    payer: 'self',
    walletKind: canAccessPremium ? 'purchased' : 'free',
    premiumAllowed: canAccessPremium,
  };
}

/**
 * Resolve the funding + premium decision. A solo turn always self-funds. A
 * non-solo turn with positive group headroom is owner-funded (premium-exempt);
 * with exhausted headroom a link guest is refused and a signed-in member falls
 * through to self-funding.
 */
export function resolveFundingDecision(inputs: FundingInputs): FundingDecision {
  if (!inputs.isSolo) {
    const effective = groupHeadroom(
      inputs.memberRemainingNanoUsd,
      inputs.conversationRemainingNanoUsd,
      inputs.ownerPurchasedBalanceNanoUsd
    );
    if (effective > 0n) {
      return { payer: 'owner', walletKind: 'purchased', premiumAllowed: true };
    }
    if (inputs.isGuest) {
      return { payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' };
    }
  }
  return selfFunding(inputs.callerOwnPurchasedBalanceNanoUsd, inputs.isPremiumModel);
}
