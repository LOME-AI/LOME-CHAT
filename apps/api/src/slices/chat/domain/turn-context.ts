import { forbiddenError, notFoundError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import type { createConversationsStores } from '../../conversations/index.js';
import type { RealtimeBroadcast } from '../../conversations/index.js';
import type { BillingStores } from '../../billing/index.js';
import type { Database } from '@hushbox/db';
import type { AppEnv } from '../../../lib/context/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

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

/** The caller must be an active member; the boolean is a gate token, unused downstream. */
function requireMembership(
  stores: Stores,
  args: { readonly conversationId: string; readonly userId: string }
): ResultAsync<boolean, DomainError> {
  return stores.members
    .activeByUser(args.conversationId, args.userId)
    .andThen((member) =>
      member === null
        ? errAsync<boolean, DomainError>(
            forbiddenError('chat turn: caller is not an active member of the conversation')
          )
        : okAsync<boolean, DomainError>(true)
    );
}

/** The conversation must exist; its current epoch is the content wrap target. */
function requireEpoch(stores: Stores, conversationId: string): ResultAsync<number, DomainError> {
  return stores.conversations
    .get(conversationId)
    .andThen((conversation) =>
      conversation === null
        ? errAsync<number, DomainError>(notFoundError('chat turn: conversation not found'))
        : okAsync<number, DomainError>(conversation.currentEpoch)
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

/** The paying wallet; admission is the only balance gate, so no balance check here. */
function requirePurchasedWallet(
  billing: BillingStores,
  db: Database,
  userId: string
): ResultAsync<string, DomainError> {
  return billing.readWallets(db, userId).andThen((wallets) => {
    const purchased = wallets.find((wallet) => wallet.type === 'purchased');
    return purchased === undefined
      ? errAsync<string, DomainError>(forbiddenError('chat turn: caller has no purchased wallet'))
      : okAsync<string, DomainError>(purchased.id);
  });
}

/**
 * Resolves the turn's preconditions: the caller must be an active member, the
 * conversation must exist (its current epoch is the wrap target), a fork send
 * must name an existing branch, and the caller must have a purchased wallet
 * (the paying wallet).
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
  return requireMembership(stores, args)
    .andThen(() => requireEpoch(stores, args.conversationId))
    .andThen((epochNumber) =>
      (args.forkId === undefined
        ? okAsync<boolean, DomainError>(true)
        : requireFork(stores, args.conversationId, args.forkId)
      ).map(() => epochNumber)
    )
    .andThen((epochNumber) =>
      requirePurchasedWallet(deps.billing, db, args.userId).map((walletId) => ({
        epochNumber,
        walletId,
      }))
    );
}
