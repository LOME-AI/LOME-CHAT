import { groupEffectiveRemainingNanoUsd } from '../../billing/index.js';
import { forbiddenError, notFoundError } from '../../../lib/errors/index.js';
import { ResultAsync, errAsync, okAsync } from '../../../lib/result/index.js';
import type { createConversationsStores } from '../../conversations/index.js';
import type { RealtimeBroadcast } from '../../conversations/index.js';
import type { BillingStores } from '../../billing/index.js';
import type { Database } from '@hushbox/db';
import type { AppEnv } from '../../../lib/context/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The conversation-scoped store factory, named from its published barrel
 * constructor so the route can hold the factory without reaching a
 * conversations internal.
 */
export type ConversationsStoresFactory = typeof createConversationsStores;

/**
 * The chat route's injected collaborators: the conversations store factory
 * (membership + current epoch), billing's stores (the paying wallet), and the
 * ConversationRoom DO client. Wired at app assembly; a port double in tests.
 */
export interface ChatRouteDeps {
  readonly conversations: ConversationsStoresFactory;
  readonly billing: BillingStores;
  readonly realtime: (env: AppEnv['Bindings']) => RealtimeBroadcast;
  /**
   * The trial DO-id builder (`@hushbox/realtime`'s `trialRoomName`). Injected
   * rather than imported here because value-importing the realtime barrel drags
   * in the workerd-only DO class, which cannot load in node-environment tests;
   * the composition root (workerd) supplies the real one.
   */
  readonly trialRoomName: (sessionId: string) => string;
}

/** The turn preconditions resolved from conversations + billing before the run starts. */
export interface TurnContext {
  readonly epochNumber: number;
  readonly walletId: string;
}

export interface ResolveTurnContextDeps {
  readonly conversations: ConversationsStoresFactory;
  readonly billing: BillingStores;
}

type Stores = ReturnType<ConversationsStoresFactory>;

/** The caller's active-membership row; its id keys the sender's durable per-member budget. */
interface ActiveMember {
  readonly id: string;
}

/** The caller must be an active member; the returned row's id names their per-member budget. */
function requireMembership(
  stores: Stores,
  args: { readonly conversationId: string; readonly userId: string }
): ResultAsync<ActiveMember, DomainError> {
  return stores.members
    .activeByUser(args.conversationId, args.userId)
    .andThen((member) =>
      member === null
        ? errAsync<ActiveMember, DomainError>(
            forbiddenError('chat turn: caller is not an active member of the conversation')
          )
        : okAsync<ActiveMember, DomainError>(member)
    );
}

/** The conversation-derived turn facts: the wrap-target epoch, the owner, and the group cap. */
interface ConversationFacts {
  readonly epochNumber: number;
  readonly ownerUserId: string;
  /** The durable per-conversation budget cap (owner-set); `0n` when none configured. */
  readonly conversationBudgetNanoUsd: bigint;
}

/**
 * The conversation must exist; its current epoch is the content wrap target, its
 * owner is the potential funding principal, and its per-conversation cap gates a
 * group turn's group-funded headroom.
 */
function requireConversation(
  stores: Stores,
  conversationId: string
): ResultAsync<ConversationFacts, DomainError> {
  return stores.conversations.get(conversationId).andThen((conversation) =>
    conversation === null
      ? errAsync<ConversationFacts, DomainError>(notFoundError('chat turn: conversation not found'))
      : okAsync<ConversationFacts, DomainError>({
          epochNumber: conversation.currentEpoch,
          ownerUserId: conversation.ownerUserId,
          conversationBudgetNanoUsd: conversation.conversationBudgetNanoUsd,
        })
  );
}

/**
 * A send onto a fork must reference an existing branch: reject a stale/bogus
 * forkId with a 404 before the run starts, rather than admit a paid run that
 * would only terminal-fail at settlement. The boolean is a gate token, unused.
 */
function requireFork(
  stores: Stores,
  conversationId: string,
  forkId: string
): ResultAsync<boolean, DomainError> {
  return stores.forks
    .byId(conversationId, forkId)
    .andThen((fork) =>
      fork === null
        ? errAsync<boolean, DomainError>(notFoundError('chat turn: fork not found'))
        : okAsync<boolean, DomainError>(true)
    );
}

/**
 * The sender's payer wallet: their purchased wallet while it carries a positive
 * balance, otherwise their free wallet — the daily-allowance draw. Admission is
 * the only balance gate, so a purchased balance of `≤ 0` (a spent-down or
 * negative wallet) falls through to the free wallet, whose sole ceiling is the
 * daily allowance (emitted by the admission hook, which recovers the free-tier
 * decision from the payer wallet's type the same way owner-funding is recovered
 * from the payer wallet identity). A genuinely absent purchased wallet cannot
 * fund a turn (forbidden); the free wallet is provisioned alongside it at
 * registration.
 */
function senderPayerWalletId(
  billing: BillingStores,
  db: Database,
  userId: string
): ResultAsync<string, DomainError> {
  return billing.readWallets(db, userId).andThen((wallets) => {
    const purchased = wallets.find((wallet) => wallet.type === 'purchased');
    if (purchased === undefined) {
      return errAsync<string, DomainError>(forbiddenError('chat turn: no purchased wallet'));
    }
    if (purchased.balanceNanoUsd > 0n) {
      return okAsync<string, DomainError>(purchased.id);
    }
    const free = wallets.find((wallet) => wallet.type === 'free');
    /* v8 ignore next 3 -- the free wallet is provisioned with the purchased wallet at registration; its absence is a defect, not a reachable state */
    if (free === undefined) {
      return errAsync<string, DomainError>(forbiddenError('chat turn: no free wallet'));
    }
    return okAsync<string, DomainError>(free.id);
  });
}

/**
 * Whether a run is OWNER-FUNDED — the drift-free recovery of the route-time
 * funding decision at the admission and settlement seams. The route encodes the
 * decision in the payer wallet it froze into the run identity: a group turn with
 * positive group headroom is funded from the OWNER's wallet, a solo turn or a
 * fallen-through group turn from the SENDER's OWN wallet. So a run is
 * owner-funded exactly when its payer wallet is NOT one of the sender's own
 * wallets — a pure function of stable data (wallet ownership never drifts), so
 * payer, group-scope emission, and group-spend attribution can never disagree.
 * The `senderUserId === ownerUserId` (solo) case is self-consistent: the payer
 * is then the sender's own wallet, so this returns false (personal) — the
 * callers additionally short-circuit solo before reaching here.
 */
export function isOwnerFundedTurn(
  billing: BillingStores,
  db: Database,
  senderUserId: string,
  payerWalletId: string
): ResultAsync<boolean, DomainError> {
  return billing
    .readWallets(db, senderUserId)
    .map((wallets) => !wallets.some((wallet) => wallet.id === payerWalletId));
}

/** The inputs the group funding decision reads the durable spend/cap rows against. */
interface GroupFundingArgs {
  readonly senderUserId: string;
  readonly ownerUserId: string;
  readonly memberId: string;
  readonly conversationId: string;
  readonly conversationBudgetNanoUsd: bigint;
}

/**
 * Picks the payer wallet — the single funding decision, made ONCE at route time
 * (mirroring legacy `fundingSource`), whose outcome the admission and settlement
 * seams recover via `isOwnerFundedTurn`.
 *
 * A SOLO turn (sender is the owner) funds from the owner's own wallet — the
 * personal path, unchanged. A GROUP turn (sender ≠ owner) computes the effective
 * group headroom = `min(memberRemaining, conversationRemaining, ownerBalance)`
 * (legacy `effectiveBudgetCents`, nano-USD): `> 0` funds from the OWNER's wallet
 * (owner-funded — both group caps gate admission and settlement accrues group
 * spend); `≤ 0` — any dimension exhausted/absent, or the owner in the red —
 * falls through to the signed-in sender's OWN wallet (self-funded — no group
 * scopes, no group accrual). An absent member-budget row reads a zero cap, so a
 * member's first turn falls through to self-funding instead of being denied.
 */
function resolvePayerWallet(
  billing: BillingStores,
  db: Database,
  args: GroupFundingArgs
): ResultAsync<string, DomainError> {
  if (args.senderUserId === args.ownerUserId) {
    return senderPayerWalletId(billing, db, args.ownerUserId);
  }
  return ResultAsync.combine([
    billing.readWallets(db, args.ownerUserId),
    billing.readMemberBudget(db, args.memberId),
    billing.readConversationSpent(db, args.conversationId),
  ]).andThen(([ownerWallets, memberRow, conversationSpent]) => {
    const ownerPurchased = ownerWallets.find((wallet) => wallet.type === 'purchased');
    const ownerBalance = ownerPurchased?.balanceNanoUsd ?? 0n;
    const memberRemaining =
      memberRow === null ? 0n : memberRow.budgetNanoUsd - memberRow.spentNanoUsd;
    const conversationRemaining = args.conversationBudgetNanoUsd - conversationSpent;
    const effective = groupEffectiveRemainingNanoUsd(
      memberRemaining,
      conversationRemaining,
      ownerBalance
    );
    if (effective > 0n) {
      // Owner-funded: effective > 0 implies ownerBalance > 0, so the owner's
      // purchased wallet is present.
      /* v8 ignore next 3 -- effective > 0 requires ownerBalance > 0, which requires a purchased owner wallet; the undefined arm is unreachable */
      return ownerPurchased === undefined
        ? errAsync<string, DomainError>(forbiddenError('chat turn: owner has no purchased wallet'))
        : okAsync<string, DomainError>(ownerPurchased.id);
    }
    // Fall-through: the signed-in sender self-funds on their own wallet —
    // purchased while it holds positive balance, else their free wallet.
    return senderPayerWalletId(billing, db, args.senderUserId);
  });
}

/**
 * Resolves the turn's preconditions: the caller must be an active member, the
 * conversation must exist (its current epoch is the wrap target), a fork send
 * must name an existing branch, and the payer wallet is chosen by the single
 * funding decision (`resolvePayerWallet`) — the owner's wallet for a solo turn
 * or an owner-funded group turn, the sender's own wallet for a fallen-through
 * group turn. The admission hold and the settlement charge fund from that one
 * wallet in lockstep.
 */
export function resolveTurnContext(
  deps: ResolveTurnContextDeps,
  db: Database,
  args: {
    readonly conversationId: string;
    readonly userId: string;
    readonly forkId?: string | undefined;
  }
): ResultAsync<TurnContext, DomainError> {
  const stores = deps.conversations(db);
  return requireMembership(stores, args).andThen((member) =>
    requireConversation(stores, args.conversationId)
      .andThen((facts) =>
        (args.forkId === undefined
          ? okAsync<boolean, DomainError>(true)
          : requireFork(stores, args.conversationId, args.forkId)
        ).map(() => facts)
      )
      .andThen((facts) =>
        resolvePayerWallet(deps.billing, db, {
          senderUserId: args.userId,
          ownerUserId: facts.ownerUserId,
          memberId: member.id,
          conversationId: args.conversationId,
          conversationBudgetNanoUsd: facts.conversationBudgetNanoUsd,
        }).map((walletId) => ({
          epochNumber: facts.epochNumber,
          walletId,
        }))
      )
  );
}
