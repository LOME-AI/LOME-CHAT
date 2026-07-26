import { getUserTier, resolveFundingDecision } from '@hushbox/shared/affordability';
import { notFoundError, unavailableError } from '../../../lib/errors/index.js';
import { ResultAsync, errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { HOLDS_READ_SCRIPT } from './admission-scripts.js';
import { resolveEffectiveSpendable } from './admission.js';
import { conversationBudgetScopeId, memberBudgetScopeId } from './budget-resolution.js';
import { groupEffectiveRemainingNanoUsd } from './group-budget.js';
import { BILLING_KEYS } from './keys.js';
import type { UserTier } from '@hushbox/shared/affordability';
import type { DomainError } from '../../../lib/errors/index.js';
import type { AdmissionDeps } from './admission.js';
import type { RedisClient } from './keys.js';

/** One hold hash's active readout: the held sum. */
export interface ActiveHoldsReadout {
  readonly heldNanoUsd: bigint;
}

/**
 * Active holds over N hold hashes (wallet or budget scope) in one round trip,
 * via the read script that embeds the shared `activeHolds` Lua fragment — the
 * hold value format is parsed only inside Lua, and expired entries prune
 * lazily exactly like admission. Redis down fails closed (typed
 * `unavailable`), matching admission.
 */
export function readActiveHolds(
  redis: RedisClient,
  keys: readonly string[],
  now: Date
): ResultAsync<readonly ActiveHoldsReadout[], DomainError> {
  if (keys.length === 0) {
    return okAsync([]);
  }
  return fromPromise(
    redis.createScript(HOLDS_READ_SCRIPT).exec([...keys], [String(now.getTime())]) as Promise<
      readonly (string | number)[]
    >,
    (cause) => unavailableError('holds read refused: Redis unavailable (fail-closed)', cause)
  ).map((flat) =>
    keys.map(
      (_, index): ActiveHoldsReadout => ({
        // The script formats each sum as a %.0f string (full 2^53 precision);
        // BigInt keeps money integer from there.
        heldNanoUsd: BigInt(String(flat[index])),
      })
    )
  );
}

/**
 * A group budget scope named by its domain identity. Callers (the budgets
 * display) never build scope-id strings — the id derivation is shared with
 * `resolveBudgetScopes`, so display and admission address the same hash.
 */
export type BudgetScopeHoldRef =
  | { readonly scope: 'member'; readonly memberId: string }
  | { readonly scope: 'conversation'; readonly conversationId: string };

function scopeHoldKey(ref: BudgetScopeHoldRef): string {
  return BILLING_KEYS.scopeHolds.buildKey(
    ref.scope === 'member'
      ? memberBudgetScopeId(ref.memberId)
      : conversationBudgetScopeId(ref.conversationId)
  );
}

/**
 * Active holds over budget scope hashes — the display-side counterpart of the
 * admission script's per-scope check. One script exec covers every ref (one
 * Redis read per request, not per scope); readouts pair with `refs`
 * positionally, one per ref by construction. Redis down fails closed.
 */
export function readBudgetScopeHolds(
  redis: RedisClient,
  scopes: readonly BudgetScopeHoldRef[],
  now: Date
): ResultAsync<readonly ActiveHoldsReadout[], DomainError> {
  return readActiveHolds(
    redis,
    scopes.map((scope) => scopeHoldKey(scope)),
    now
  );
}

/**
 * Positional pairing accessor for {@link readBudgetScopeHolds} readouts: one
 * readout exists per requested ref by construction, so a hole is a defect
 * (thrown), never a legal state to default around.
 */
export function holdReadoutAt(
  readouts: readonly ActiveHoldsReadout[],
  index: number
): ActiveHoldsReadout {
  const readout = readouts[index];
  if (readout === undefined) {
    throw new Error('holds readout missing for a requested scope');
  }
  return readout;
}

/**
 * Totals readouts (one per key in, one out by construction) — a fold instead
 * of `readouts[0]`, so no optional-index branch exists to defend.
 */
function totalHolds(readouts: readonly ActiveHoldsReadout[]): ActiveHoldsReadout {
  let heldNanoUsd = 0n;
  for (const readout of readouts) {
    heldNanoUsd += readout.heldNanoUsd;
  }
  return { heldNanoUsd };
}

/**
 * The conversations-owned facts that name the payer of a group turn: the
 * caller's active membership row (the member-budget scope), the owner whose
 * wallet funds the conversation, and the durable per-conversation cap. Billing
 * never reads the `conversations` or `conversation_members` tables, so these
 * are resolved by the composition root and handed in.
 */
export interface ConversationFundingFacts {
  readonly conversationId: string;
  readonly memberId: string;
  readonly ownerUserId: string;
  readonly conversationBudgetNanoUsd: bigint;
}

/**
 * Resolves {@link ConversationFundingFacts} for a caller. `null` for every
 * shape whose payer is the caller's own wallet: the caller IS the owner (a solo
 * conversation), holds no active membership, or the conversation is absent.
 */
export type ConversationFundingReader = (args: {
  readonly conversationId: string;
  readonly callerUserId: string;
}) => ResultAsync<ConversationFundingFacts | null, DomainError>;

export interface ReadFundingSnapshotArgs {
  readonly userId: string;
  /** The conversation the caller is composing in, when there is one. */
  readonly conversationId?: string | undefined;
  /** Resolves that conversation's payer facts; not consulted without an id. */
  readonly conversationFunding: ConversationFundingReader;
  readonly now: Date;
}

/**
 * The payer's funding snapshot behind `GET /billing/spendable` (BILLING
 * §Data Structures `FundingSnapshot`). Money only — no token quantity, no
 * per-model term — plus the identity of the wallet the figures describe.
 */
export interface FundingSnapshot {
  /**
   * Hold-aware. When the payer is the caller it is exactly what admission's
   * balance gate compares. When the payer is the conversation owner it is the
   * group's hold-aware remaining, whose owner-balance dimension is the RAW
   * purchased balance — neither the owner's paid-tier cushion nor the owner
   * wallet's own holds are applied, by ruling (a member must not be able to
   * infer the owner's activity elsewhere). So an owner-funded figure can
   * diverge from what admission admits in either direction, and the spec makes
   * that divergence a hard refusal at admission rather than an in-admission
   * re-resolve (BILLING §Group Funding 6b).
   */
  readonly spendableNanoUsd: bigint;
  /** What active holds took off the figure, so `spendable + held` is hold-blind. */
  readonly heldNanoUsd: bigint;
  /** The PAYER's tier — it drives every sizing ratio and the cushion. */
  readonly tier: UserTier;
  readonly payer: 'self' | 'owner';
}

/** The caller's own wallet figures, plus the raw balance the tier derives from. */
interface SelfFunding {
  readonly spendableNanoUsd: bigint;
  readonly heldNanoUsd: bigint;
  readonly purchasedBalanceNanoUsd: bigint;
}

/**
 * The caller's PURCHASED wallet resolved through the same snapshot + spendable
 * rule admission gates with, minus the wallet's active holds. The free-tier
 * daily allowance is a budget scope, not a balance — it rides the budgets
 * endpoint, never this number. Spendable may be negative (overdrawn wallet);
 * clamping would hide the deficit the composer must show.
 */
function readSelfFunding(
  deps: AdmissionDeps,
  args: { readonly userId: string; readonly now: Date }
): ResultAsync<SelfFunding, DomainError> {
  return deps.stores.readWallets(deps.db, args.userId).andThen((walletRows) => {
    const purchased = walletRows.find((wallet) => wallet.type === 'purchased');
    if (purchased === undefined) {
      return errAsync<SelfFunding, DomainError>(
        notFoundError('spendable: caller has no purchased wallet')
      );
    }
    return resolveEffectiveSpendable(deps, purchased.id).andThen((spendable) =>
      readActiveHolds(deps.redis, [BILLING_KEYS.walletHolds.buildKey(purchased.id)], args.now).map(
        (readouts): SelfFunding => {
          const holds = totalHolds(readouts);
          return {
            spendableNanoUsd: spendable.effectiveSpendableNanoUsd - holds.heldNanoUsd,
            heldNanoUsd: holds.heldNanoUsd,
            purchasedBalanceNanoUsd: purchased.balanceNanoUsd,
          };
        }
      )
    );
  });
}

/** The tier of a wallet holder, from the one shared derivation. */
function tierForBalance(purchasedBalanceNanoUsd: bigint): UserTier {
  // The daily allowance never moves the tier (a positive purchased balance
  // does), so the allowance dimension is irrelevant to this derivation.
  return getUserTier({ purchasedBalanceNanoUsd, freeAllowanceNanoUsd: 0n }).tier;
}

function selfSnapshot(self: SelfFunding): FundingSnapshot {
  return {
    spendableNanoUsd: self.spendableNanoUsd,
    heldNanoUsd: self.heldNanoUsd,
    tier: tierForBalance(self.purchasedBalanceNanoUsd),
    payer: 'self',
  };
}

/** The durable group dimensions plus the scope holds in flight against them. */
interface GroupFundingReadout {
  readonly memberRemainingNanoUsd: bigint;
  readonly conversationRemainingNanoUsd: bigint;
  readonly ownerBalanceNanoUsd: bigint;
  readonly memberHeldNanoUsd: bigint;
  readonly conversationHeldNanoUsd: bigint;
}

function readGroupFunding(
  deps: AdmissionDeps,
  conversation: ConversationFundingFacts,
  now: Date
): ResultAsync<GroupFundingReadout, DomainError> {
  return ResultAsync.combine([
    deps.stores.readWallets(deps.db, conversation.ownerUserId),
    deps.stores.readMemberBudget(deps.db, conversation.memberId),
    deps.stores.readConversationSpent(deps.db, conversation.conversationId),
    readBudgetScopeHolds(
      deps.redis,
      [
        { scope: 'conversation', conversationId: conversation.conversationId },
        { scope: 'member', memberId: conversation.memberId },
      ],
      now
    ),
  ]).map(([ownerWallets, memberRow, conversationSpent, holds]): GroupFundingReadout => {
    const ownerPurchased = ownerWallets.find((wallet) => wallet.type === 'purchased');
    return {
      // An absent member row is a zero cap (deny), never unlimited.
      memberRemainingNanoUsd:
        memberRow === null ? 0n : memberRow.budgetNanoUsd - memberRow.spentNanoUsd,
      conversationRemainingNanoUsd: conversation.conversationBudgetNanoUsd - conversationSpent,
      ownerBalanceNanoUsd: ownerPurchased?.balanceNanoUsd ?? 0n,
      conversationHeldNanoUsd: holdReadoutAt(holds, 0).heldNanoUsd,
      memberHeldNanoUsd: holdReadoutAt(holds, 1).heldNanoUsd,
    };
  });
}

/**
 * The snapshot of an owner-funded turn. The served figure is the group's
 * HOLD-AWARE remaining — the same clamp-then-min the budgets display shows and
 * the admission script gates each scope on — and `held` is what the holds took
 * off it, so `spendable + held` is the hold-blind remaining the picker greys
 * against (BILLING §Affordability, the four notions).
 *
 * The owner-balance dimension stays RAW in both figures by ruling: a member
 * must not be able to infer the owner's activity elsewhere, so only this
 * conversation's own scope holds move the number.
 */
function ownerSnapshot(group: GroupFundingReadout): FundingSnapshot {
  const holdAware = groupEffectiveRemainingNanoUsd(
    group.memberRemainingNanoUsd - group.memberHeldNanoUsd,
    group.conversationRemainingNanoUsd - group.conversationHeldNanoUsd,
    group.ownerBalanceNanoUsd
  );
  const holdBlind = groupEffectiveRemainingNanoUsd(
    group.memberRemainingNanoUsd,
    group.conversationRemainingNanoUsd,
    group.ownerBalanceNanoUsd
  );
  return {
    spendableNanoUsd: holdAware,
    heldNanoUsd: holdBlind - holdAware,
    // Owner-funded turns draw a purchased wallet with a positive balance (the
    // headroom min clamps the owner dimension), so the payer is paid-tier.
    tier: tierForBalance(group.ownerBalanceNanoUsd),
    payer: 'owner',
  };
}

/**
 * The served funding snapshot (BILLING §Affordability 1, §Group Funding 1): the
 * numbers of the wallet that will actually PAY, at that payer's tier. Who pays
 * comes from the one shared funding core — the same decision the send path's
 * `resolvePayerWallet` reaches — evaluated hold-blind, because a hold is a
 * transient reservation and never changes whose money funds a turn.
 *
 * A caller composing outside a group conversation, one who owns it, or one
 * whose group allowance is exhausted is served their own figures at their own
 * tier: the sender's tier applies exactly when the sender pays.
 */
export function readFundingSnapshot(
  deps: AdmissionDeps,
  args: ReadFundingSnapshotArgs
): ResultAsync<FundingSnapshot, DomainError> {
  const self = readSelfFunding(deps, { userId: args.userId, now: args.now });
  const { conversationId } = args;
  if (conversationId === undefined) return self.map((funding) => selfSnapshot(funding));
  return args
    .conversationFunding({ conversationId, callerUserId: args.userId })
    .andThen((conversation) => {
      if (conversation === null) return self.map((funding) => selfSnapshot(funding));
      return ResultAsync.combine([self, readGroupFunding(deps, conversation, args.now)]).map(
        ([selfFunding, group]): FundingSnapshot => {
          const decision = resolveFundingDecision({
            isSolo: false,
            // A link guest never reaches this endpoint (refused at HTTP for
            // every route class), so the caller always has a wallet to fall
            // through to.
            isGuest: false,
            memberRemainingNanoUsd: group.memberRemainingNanoUsd,
            conversationRemainingNanoUsd: group.conversationRemainingNanoUsd,
            ownerPurchasedBalanceNanoUsd: group.ownerBalanceNanoUsd,
            callerOwnPurchasedBalanceNanoUsd: selfFunding.purchasedBalanceNanoUsd,
            isPremiumModel: false,
            // No turn is priced: this endpoint names the payer for a composer
            // that has no prompt yet. The client applies priority 1's estimate
            // clause itself, against these numbers, as it types.
            turnEstimateNanoUsd: undefined,
          });
          return decision.payer === 'owner' ? ownerSnapshot(group) : selfSnapshot(selfFunding);
        }
      );
    });
}
