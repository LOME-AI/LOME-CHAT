import { groupEffectiveRemainingNanoUsd, readBalance } from '../../billing/index.js';
import { resolveCallerMember } from '../../conversations/index.js';
import { forbiddenError, notFoundError } from '../../../lib/errors/index.js';
import { ResultAsync, errAsync, okAsync } from '../../../lib/result/index.js';
import { senderCaller } from './sender.js';
import type { SenderPrincipal } from '@hushbox/shared';
import type { createConversationsStores } from '../../conversations/index.js';
import type { MemberRecord, RealtimeBroadcast } from '../../conversations/index.js';
import type { BillingStores } from '../../billing/index.js';
import type { LinkResolutionPort } from '../../identity/index.js';
import type { Database } from '@hushbox/db';
import type { AppEnv } from '../../../lib/context/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ChatStores } from '../ports/stores.js';
import type { EpochPublicKeyReader } from './settlement.js';

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
   * chat's single-writer content persister (`messages` + `content_items`) for
   * the runless Pattern-A user-only send. Routes and domain may not reach the
   * slice's own adapter, so the slice-root manifest composer defaults it —
   * the same seam `conversation-runtime.ts` uses for the DO runtime.
   */
  readonly chatStores: ChatStores;
  /**
   * The `epochs` wrap-key read the user-only send wraps its content to — the
   * same seam the settlement consumes; defaulted by the slice's manifest
   * composer.
   */
  readonly readEpochPublicKey: EpochPublicKeyReader;
  /**
   * The trial DO-id builder (`@hushbox/realtime`'s `trialRoomName`). Injected
   * rather than imported here because value-importing the realtime barrel drags
   * in the workerd-only DO class, which cannot load in node-environment tests;
   * the composition root (workerd) supplies the real one.
   */
  readonly trialRoomName: (sessionId: string) => string;
  /**
   * Shared-link credential resolution (identity's port over conversations'
   * shared-link store), per request. The public guest-send seam resolves the
   * presented `x-link-public-key` to a link guest through it — the same seam
   * the guest-reachable conversation reads and media presign use — so a guest's
   * `linkId`/`conversationId` are SERVER-derived, never trusted from the body.
   */
  readonly linkResolution: (db: Database) => LinkResolutionPort;
}

/**
 * The payer's spendable funds for ONE turn, feeding the output-token ceiling
 * (legacy `getEffectiveBalance` inputs, nano-USD). `kind` mirrors the legacy
 * tier split the budget math branches on: 'purchased' is the legacy paid tier
 * (4 chars/token input estimate, negative-balance cushion), 'free' is the
 * legacy free tier (2 chars/token, daily allowance only, no cushion).
 */
export interface PayerFunding {
  readonly remainingNanoUsd: bigint;
  readonly kind: 'purchased' | 'free';
}

/**
 * The turn's SENDER as the route resolved it server-side — a full-session user
 * (by `userId`) or a link guest (by the `linkId` its credential resolved to).
 * The PAYER is derived from this plus the conversation owner: a solo/self-funded
 * user pays their own wallet, an owner-funded group turn (user or guest) pays the
 * owner's, and a guest with no owner headroom is denied (guests hold no wallet).
 */
export type TurnSender =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'linkGuest'; readonly linkId: string };

/** The turn preconditions resolved from conversations + billing before the run starts. */
export interface TurnContext {
  readonly epochNumber: number;
  readonly walletId: string;
  readonly funding: PayerFunding;
  /**
   * The server-resolved sender principal (carrying the resolved
   * `conversation_members.id`) for the run-start body — the seam that lets a
   * guest send be represented and that keys the member-wrapped epoch gate and
   * per-member spend at settlement.
   */
  readonly sender: SenderPrincipal;
  /**
   * The sender's principal id (a member's `userId`, a guest's `linkId`),
   * persisted as `messages.senderId`.
   */
  readonly senderId: string;
  /**
   * The paying user account: the member for a user sender (byte-identical to the
   * legacy path, incl. an owner-funded user turn attributing usage to the
   * initiator), the conversation OWNER for a guest sender (a guest has no
   * account). The charge always debits `walletId`, resolved in lockstep.
   */
  readonly payerUserId: string;
}

export interface ResolveTurnContextDeps {
  readonly conversations: ConversationsStoresFactory;
  readonly billing: BillingStores;
}

type Stores = ReturnType<ConversationsStoresFactory>;

/**
 * The sender must be an active member; the returned row's id names their durable
 * per-member budget. Resolved through the shared `resolveCallerMember` gate — a
 * user by `userId`, a link guest by `linkId` — so a revoked/departed sender (its
 * row marked left) resolves to `null` here and the turn is forbidden, and one
 * gate serves both principal kinds.
 */
function requireSenderMember(
  stores: Stores,
  conversationId: string,
  sender: TurnSender
): ResultAsync<MemberRecord, DomainError> {
  return resolveCallerMember(stores, conversationId, senderCaller(sender, conversationId)).andThen(
    (member) =>
      member === null
        ? errAsync<MemberRecord, DomainError>(
            forbiddenError('chat turn: caller is not an active member of the conversation')
          )
        : okAsync<MemberRecord, DomainError>(member)
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

/** The payer wallet plus its spendable funds — the shape the funding decision yields. */
interface PayerWallet {
  readonly walletId: string;
  readonly funding: PayerFunding;
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
 * registration. The funding mirrors what legacy fed its budget math: the
 * purchased balance for the paid tier, the REMAINING daily allowance for the
 * free tier (legacy `getEffectiveBalance` inputs).
 */
function senderPayerWallet(
  billing: BillingStores,
  db: Database,
  userId: string,
  now: Date
): ResultAsync<PayerWallet, DomainError> {
  return billing.readWallets(db, userId).andThen((wallets) => {
    const purchased = wallets.find((wallet) => wallet.type === 'purchased');
    if (purchased === undefined) {
      return errAsync<PayerWallet, DomainError>(forbiddenError('chat turn: no purchased wallet'));
    }
    if (purchased.balanceNanoUsd > 0n) {
      return okAsync<PayerWallet, DomainError>({
        walletId: purchased.id,
        funding: { remainingNanoUsd: purchased.balanceNanoUsd, kind: 'purchased' },
      });
    }
    const free = wallets.find((wallet) => wallet.type === 'free');
    /* v8 ignore next 3 -- the free wallet is provisioned with the purchased wallet at registration; its absence is a defect, not a reachable state */
    if (free === undefined) {
      return errAsync<PayerWallet, DomainError>(forbiddenError('chat turn: no free wallet'));
    }
    return readBalance(billing, db, userId, now).map((balance) => ({
      walletId: free.id,
      funding: { remainingNanoUsd: balance.allowance.remainingNanoUsd, kind: 'free' as const },
    }));
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
  readonly sender: TurnSender;
  readonly ownerUserId: string;
  readonly memberId: string;
  readonly conversationId: string;
  readonly conversationBudgetNanoUsd: bigint;
}

/**
 * Picks the payer wallet — the single funding decision, made ONCE at route time
 * (mirroring legacy `fundingSource`), whose outcome the admission and settlement
 * seams recover (via `isOwnerFundedTurn` for a user, or unconditionally for a
 * guest — a guest is never the payer).
 *
 * A SOLO turn (a user sender who owns the conversation) funds from the owner's
 * own wallet — the personal path, unchanged. A GROUP turn (a user sender ≠ owner,
 * or ANY link guest) computes the effective group headroom =
 * `min(memberRemaining, conversationRemaining, ownerBalance)` (legacy
 * `effectiveBudgetCents`, nano-USD): `> 0` funds from the OWNER's wallet
 * (owner-funded — both group caps gate admission and settlement accrues group
 * spend); `≤ 0` — any dimension exhausted/absent, or the owner in the red — a
 * USER sender falls through to its OWN wallet (self-funded — no group scopes, no
 * group accrual), while a LINK GUEST is DENIED (it holds no wallet to fall
 * through to). An absent member-budget row reads a zero cap.
 */
function resolvePayerWallet(
  billing: BillingStores,
  db: Database,
  args: GroupFundingArgs,
  now: Date
): ResultAsync<PayerWallet, DomainError> {
  if (args.sender.kind === 'user' && args.sender.userId === args.ownerUserId) {
    return senderPayerWallet(billing, db, args.ownerUserId, now);
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
      // purchased wallet is present. The spendable funds are the group MIN
      // itself (legacy `computeEffectivePayerBalance`), not the raw owner
      // balance — the tightest of the three caps bounds the turn.
      /* v8 ignore next 5 -- effective > 0 requires ownerBalance > 0, which requires a purchased owner wallet; the undefined arm is unreachable */
      return ownerPurchased === undefined
        ? errAsync<PayerWallet, DomainError>(
            forbiddenError('chat turn: owner has no purchased wallet')
          )
        : okAsync<PayerWallet, DomainError>({
            walletId: ownerPurchased.id,
            funding: { remainingNanoUsd: effective, kind: 'purchased' },
          });
    }
    // Group headroom exhausted. A link guest holds no wallet, so the send is
    // denied rather than falling through; a signed-in user self-funds on their
    // own wallet — purchased while it holds positive balance, else their free.
    if (args.sender.kind === 'linkGuest') {
      return errAsync<PayerWallet, DomainError>(
        forbiddenError('chat turn: link guest has no funds and the owner cannot cover the turn')
      );
    }
    return senderPayerWallet(billing, db, args.sender.userId, now);
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
    readonly sender: TurnSender;
    readonly forkId?: string | undefined;
    /** The clock the free payer's daily allowance is keyed by (UTC day). */
    readonly now: Date;
  }
): ResultAsync<TurnContext, DomainError> {
  const stores = deps.conversations(db);
  return requireSenderMember(stores, args.conversationId, args.sender).andThen((member) =>
    requireConversation(stores, args.conversationId)
      .andThen((facts) =>
        (args.forkId === undefined
          ? okAsync<boolean, DomainError>(true)
          : requireFork(stores, args.conversationId, args.forkId)
        ).map(() => facts)
      )
      .andThen((facts) =>
        resolvePayerWallet(
          deps.billing,
          db,
          {
            sender: args.sender,
            ownerUserId: facts.ownerUserId,
            memberId: member.id,
            conversationId: args.conversationId,
            conversationBudgetNanoUsd: facts.conversationBudgetNanoUsd,
          },
          args.now
        ).map((payer) => {
          const resolvedSender: SenderPrincipal =
            args.sender.kind === 'user'
              ? { kind: 'user', userId: args.sender.userId, memberId: member.id }
              : { kind: 'linkGuest', linkId: args.sender.linkId, memberId: member.id };
          return {
            epochNumber: facts.epochNumber,
            walletId: payer.walletId,
            funding: payer.funding,
            sender: resolvedSender,
            senderId: args.sender.kind === 'user' ? args.sender.userId : args.sender.linkId,
            // The member pays for a user turn (byte-identical to legacy, incl.
            // owner-funded user turns attributing to the initiator); the owner
            // pays for a guest turn (the guest has no account).
            payerUserId: args.sender.kind === 'user' ? args.sender.userId : facts.ownerUserId,
          };
        })
      )
  );
}
