/**
 * The group-turn budget primitive: the spendable headroom a group turn has
 * before it must fall through to the sender's own wallet. It is the nano-USD
 * `bigint` analogue of legacy `effectiveBudgetCents` — the smallest of the
 * sender's remaining per-member budget, the conversation's remaining budget,
 * and the conversation owner's wallet balance.
 *
 * Each dimension is clamped to ≥ 0 before the min, so an overspent (negative)
 * or absent dimension reads as zero headroom and can never be masked by a
 * larger sibling. The result drives the funding decision: `> 0` selects
 * owner-funding (the owner's wallet pays and both group caps gate the run);
 * `≤ 0` — any dimension exhausted or absent, or the owner in the red — is the
 * fall-through signal that a signed-in sender self-funds on their own wallet.
 *
 * The per-conversation display endpoint consumes this SAME function, so the
 * "remaining" a user is shown is exactly the value that gates their turn.
 */
function clampNonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

export function groupEffectiveRemainingNanoUsd(
  memberRemainingNanoUsd: bigint,
  conversationRemainingNanoUsd: bigint,
  ownerBalanceNanoUsd: bigint
): bigint {
  // `bigint` rules out `Math.min`; clamp each dimension, then take the smallest.
  let smallest = clampNonNegative(memberRemainingNanoUsd);
  const conversationRemaining = clampNonNegative(conversationRemainingNanoUsd);
  const ownerBalance = clampNonNegative(ownerBalanceNanoUsd);
  if (conversationRemaining < smallest) smallest = conversationRemaining;
  if (ownerBalance < smallest) smallest = ownerBalance;
  return smallest;
}
