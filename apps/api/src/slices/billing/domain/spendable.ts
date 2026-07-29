import { nanoUSD, serializeNanoUSD } from '@hushbox/shared';
import { getUserTier, resolveFunding } from '@hushbox/shared/affordability';
import { notFoundError, unavailableError } from '../../../lib/errors/index.js';
import { ResultAsync, errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { HOLDS_READ_SCRIPT } from './admission-scripts.js';
import { resolveEffectiveSpendable } from './admission.js';
import {
  conversationBudgetScopeId,
  memberBudgetScopeId,
  resolveBudgetScopes,
} from './budget-resolution.js';
import { groupEffectiveRemainingNanoUsd } from './group-budget.js';
import { BILLING_KEYS } from './keys.js';
import type { GetSpendableResponse } from '@hushbox/shared';
import type { UserTier } from '@hushbox/shared/affordability';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { AdmissionDeps, BudgetScope } from './admission.js';
import type { BillingStores } from '../ports/index.js';
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
 * The payer's funding snapshot (BILLING §Data Structures `FundingSnapshot`).
 * Money only — no token quantity, no per-model term — plus the identity of the
 * wallet the figures describe. Two doors serve it: `GET /billing/spendable` for
 * a caller who holds a wallet, and the conversations slice's guest read for a
 * link guest, who holds none. A different route is not a second source; the
 * figures come from the producers below either way.
 */
export interface FundingSnapshot {
  /**
   * Hold-aware, and whole at whatever tier the payer is: when the payer is the
   * caller it is exactly what admission gates their turn on — the purchased
   * wallet's spendable funds while that balance funds turns, otherwise the
   * day's remaining free allowance, which is then the entire money gate because
   * a free wallet skips the balance check. When the payer is the conversation owner it
   * is the group's hold-aware remaining, whose owner-balance dimension is the RAW
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
  /**
   * The PAYER's tier — it drives every sizing ratio and the cushion. Named for
   * the payer because a link guest's two tiers differ: `guest` answers who is
   * sending, and this answers what funds the turn, so a composer holding both
   * cannot cross them by reading the shorter name (BILLING §User Tiers).
   */
  readonly payerTier: UserTier;
  /**
   * Structural, not funding-derived: a link guest's payer is the conversation's
   * owner whether or not the owner's funds cover the turn, so zero spendable is
   * not a third kind of payer and this union stays closed at two.
   */
  readonly payer: 'self' | 'owner';
}

/**
 * The snapshot's wire encoding, typed to the served schema. Both doors call
 * this: a second hand-rolled encoder would be a copy that must agree to be
 * correct, and only one of the two would keep pace with a schema change.
 */
export function serializeFundingSnapshot(snapshot: FundingSnapshot): GetSpendableResponse {
  return {
    spendableNanoUsd: serializeNanoUSD(nanoUSD(snapshot.spendableNanoUsd)),
    heldNanoUsd: serializeNanoUSD(nanoUSD(snapshot.heldNanoUsd)),
    payerTier: snapshot.payerTier,
    payer: snapshot.payer,
  };
}

/** What one funding arm resolves: the money pair, unlabelled. */
interface FundingFigures {
  readonly spendableNanoUsd: bigint;
  readonly heldNanoUsd: bigint;
}

/**
 * The caller's own figures under the tier that produced them, plus the raw
 * purchased balance the group funding core reads independently of them.
 */
interface SelfFunding extends FundingFigures {
  readonly purchasedBalanceNanoUsd: bigint;
  readonly tier: UserTier;
}

/**
 * The paid arm: the caller's PURCHASED wallet resolved through the same
 * snapshot + spendable rule admission gates with, minus the wallet's active
 * holds. Spendable may be negative (holds beyond the cushion); clamping would
 * hide the deficit the composer must show.
 */
function readPurchasedFunding(
  deps: AdmissionDeps,
  purchasedWalletId: string,
  now: Date
): ResultAsync<FundingFigures, DomainError> {
  return resolveEffectiveSpendable(deps, purchasedWalletId).andThen((spendable) =>
    readActiveHolds(deps.redis, [BILLING_KEYS.walletHolds.buildKey(purchasedWalletId)], now).map(
      (readouts): FundingFigures => {
        const holds = totalHolds(readouts);
        return {
          spendableNanoUsd: spendable.effectiveSpendableNanoUsd - holds.heldNanoUsd,
          heldNanoUsd: holds.heldNanoUsd,
        };
      }
    )
  );
}

/**
 * Exactly one scope comes back for an allowance-only resolve; anything else is
 * a defect in the resolver, never a state to default around.
 */
function soleScope(scopes: readonly BudgetScope[]): BudgetScope {
  const scope = scopes[0];
  /* v8 ignore next 3 -- unreachable: the only caller requests the allowance scope alone, and resolveBudgetScopes pushes exactly one scope per request field; kept fail-fast */
  if (scope === undefined || scopes.length !== 1) {
    throw new Error('spendable: allowance resolve returned no single budget scope');
  }
  return scope;
}

/**
 * The free arm: a payer whose purchased balance cannot fund a turn draws the
 * day-keyed free allowance, and that allowance IS their effective balance
 * (BILLING §Funding). The gate is reproduced rather than restated — the scope
 * comes from the same `resolveBudgetScopes` call the admission hook makes, so
 * the served remaining and the scope id whose holds come off it are admission's
 * own, and the allowance can never drift into a second derivation here. There
 * is no reset: a new day resolves a new scope id with no row behind it, which
 * is why this reads "remaining today" from `now` alone.
 *
 * The wallet-holds hash is deliberately not read: a free wallet skips the
 * balance check entirely (`spendableFor`), so the allowance scope is the whole
 * money gate, and its holds are the ones that move the served number.
 */
function readAllowanceFunding(
  deps: AdmissionDeps,
  userId: string,
  now: Date
): ResultAsync<FundingFigures, DomainError> {
  return resolveBudgetScopes(deps.stores, deps.db, { now, allowance: { userId } }).andThen(
    (scopes) => {
      const allowance = soleScope(scopes);
      return readActiveHolds(
        deps.redis,
        [BILLING_KEYS.scopeHolds.buildKey(allowance.scopeId)],
        now
      ).map((readouts): FundingFigures => {
        const holds = totalHolds(readouts);
        return {
          spendableNanoUsd: allowance.remainingNanoUsd - holds.heldNanoUsd,
          heldNanoUsd: holds.heldNanoUsd,
        };
      });
    }
  );
}

/** The tier of a wallet holder, from the one shared derivation. */
function tierForBalance(purchasedBalanceNanoUsd: bigint): UserTier {
  // The daily allowance never moves the tier (a positive purchased balance
  // does), so the allowance dimension is irrelevant to this derivation.
  return getUserTier({ purchasedBalanceNanoUsd, freeAllowanceNanoUsd: 0n }).tier;
}

/**
 * The caller's own funding, priced from the wallet that would actually pay
 * their turn. ONE tier derivation both picks the arm and labels its figures, so
 * the number and the tier beside it cannot describe different wallets: `paid`
 * reads the purchased wallet through admission's own spendable rule, every arm
 * below it the day-keyed allowance. Hidden coupling: the send path resolves the
 * payer wallet at this same tier boundary (`chat/domain/turn-context.ts` falls
 * through to the free wallet there), so moving the boundary in one place alone
 * makes this endpoint describe a wallet that will not pay.
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
    const tier = tierForBalance(purchased.balanceNanoUsd);
    const figures =
      tier === 'paid'
        ? readPurchasedFunding(deps, purchased.id, args.now)
        : readAllowanceFunding(deps, args.userId, args.now);
    return figures.map(
      (funding): SelfFunding => ({
        ...funding,
        purchasedBalanceNanoUsd: purchased.balanceNanoUsd,
        tier,
      })
    );
  });
}

function selfSnapshot(self: SelfFunding): FundingSnapshot {
  return {
    spendableNanoUsd: self.spendableNanoUsd,
    heldNanoUsd: self.heldNanoUsd,
    payerTier: self.tier,
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

/**
 * What reading a group's funding needs, narrower than {@link AdmissionDeps}:
 * three durable reads and the scope-hold hashes. Stated separately so the
 * conversations slice can serve a guest through the same producer with the
 * budget-surface store subset it already composes, rather than acquiring the
 * whole billing store to read one snapshot.
 */
export interface GroupFundingDeps {
  readonly redis: RedisClient;
  readonly db: Database;
  readonly stores: Pick<
    BillingStores,
    'readWallets' | 'readMemberBudget' | 'readConversationSpent'
  >;
}

function readGroupFunding(
  deps: GroupFundingDeps,
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
    payerTier: tierForBalance(group.ownerBalanceNanoUsd),
    payer: 'owner',
  };
}

/**
 * The snapshot served to a LINK GUEST, whose payer is structural: a guest holds
 * no wallet, so the conversation's owner funds the turn whether or not the
 * owner's funds cover it (BILLING §Group Funding 1, 2). There is no self arm to
 * fall through to and therefore no who-pays decision to make — which is why
 * this takes the conversation's facts and no caller identity.
 *
 * It is the SAME producer the owner-funded arm of {@link readFundingSnapshot}
 * uses, over the same rows and the same scope-hold hashes, so the number a
 * guest is served and the number admission gates its turn on cannot drift. The
 * caller (the conversations slice) authorizes the guest and resolves the facts;
 * nothing about the money is recomputed there.
 */
export function readGuestFundingSnapshot(
  deps: GroupFundingDeps,
  args: { readonly conversation: ConversationFundingFacts; readonly now: Date }
): ResultAsync<FundingSnapshot, DomainError> {
  return readGroupFunding(deps, args.conversation, args.now).map((group) => ownerSnapshot(group));
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
          const decision = resolveFunding({
            isSolo: false,
            // This arm resolves a caller who holds a wallet; a link guest is
            // served by `readGuestFundingSnapshot` instead, so there is always
            // something to fall through to here.
            isGuest: false,
            memberRemainingNanoUsd: group.memberRemainingNanoUsd,
            conversationRemainingNanoUsd: group.conversationRemainingNanoUsd,
            ownerPurchasedBalanceNanoUsd: group.ownerBalanceNanoUsd,
            callerOwnPurchasedBalanceNanoUsd: selfFunding.purchasedBalanceNanoUsd,
            isPremiumModel: false,
            // No turn is priced: this endpoint names the payer for a composer
            // that has no prompt yet, so priority 1's comparison has nothing to
            // compare and the answer is who WOULD pay. The send path prices the
            // turn's minimum and can therefore reach the other verdict — a
            // member served `owner` here may still be charged personally once a
            // prompt exists, which is the disclosure gap §Notices 5 covers.
            minTurnCostNanoUsd: undefined,
          });
          return decision.payer === 'owner' ? ownerSnapshot(group) : selfSnapshot(selfFunding);
        }
      );
    });
}
