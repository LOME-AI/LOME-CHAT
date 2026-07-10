import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { resolveTurnContext } from './turn-context.js';
import type { ConversationsStoresFactory, ResolveTurnContextDeps } from './turn-context.js';
import type { BillingStores } from '../../billing/index.js';
import type { Database } from '@hushbox/db';

const DB = {} as Database;
const ARGS = { conversationId: 'c1', userId: 'u1' };

interface WalletStub {
  readonly id: string;
  readonly type: string;
  readonly balanceNanoUsd?: bigint;
}

interface StoreStubs {
  readonly member?: { readonly id: string } | null;
  readonly conversation?: {
    readonly currentEpoch: number;
    readonly ownerUserId?: string;
    readonly conversationBudgetNanoUsd?: bigint;
  } | null;
  /** Per-user wallet rows; the funding decision reads owner and sender separately. */
  readonly walletsByUser?: Record<string, readonly WalletStub[]>;
  /** The sender's durable per-member budget row (absent = no group headroom). */
  readonly memberBudget?: { readonly budgetNanoUsd: bigint; readonly spentNanoUsd: bigint } | null;
  /** The conversation's cumulative spend against its durable cap. */
  readonly conversationSpent?: bigint;
  readonly fork?: { readonly id: string } | null;
  /** Records the userIds the wallet lookup was scoped to, in call order. */
  readonly walletLookups?: string[];
}

function deps(stubs: StoreStubs): ResolveTurnContextDeps {
  const conversations = (() => ({
    members: { activeByUser: () => okAsync(stubs.member ?? null) },
    conversations: {
      get: () =>
        okAsync(
          stubs.conversation == null
            ? null
            : {
                currentEpoch: stubs.conversation.currentEpoch,
                // Default the owner to the caller so an unset owner is a SOLO turn.
                ownerUserId: stubs.conversation.ownerUserId ?? ARGS.userId,
                conversationBudgetNanoUsd: stubs.conversation.conversationBudgetNanoUsd ?? 0n,
              }
        ),
    },
    forks: { byId: () => okAsync(stubs.fork ?? null) },
  })) as unknown as ConversationsStoresFactory;
  const billing = {
    readWallets: (_db: Database, userId: string) => {
      stubs.walletLookups?.push(userId);
      return okAsync(stubs.walletsByUser?.[userId] ?? []);
    },
    readMemberBudget: () => okAsync(stubs.memberBudget ?? null),
    readConversationSpent: () => okAsync(stubs.conversationSpent ?? 0n),
  } as unknown as BillingStores;
  return { conversations, billing };
}

describe('resolveTurnContext', () => {
  it('refuses a non-member with forbidden', async () => {
    const result = await resolveTurnContext(deps({ member: null }), DB, ARGS);
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses a missing conversation with not_found', async () => {
    const result = await resolveTurnContext(
      deps({ member: { id: 'm1' }, conversation: null }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('refuses a solo caller with no purchased wallet with forbidden', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        walletsByUser: { u1: [{ id: 'w', type: 'free' }] },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('resolves the current epoch and the solo caller purchased wallet', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        walletsByUser: {
          u1: [
            { id: 'free-w', type: 'free', balanceNanoUsd: 0n },
            { id: 'paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({ epochNumber: 3, walletId: 'paid-w' });
  });

  it("selects the solo caller's free wallet when the purchased balance is spent to zero", async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        walletsByUser: {
          u1: [
            { id: 'free-w', type: 'free', balanceNanoUsd: 0n },
            { id: 'paid-w', type: 'purchased', balanceNanoUsd: 0n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({ epochNumber: 3, walletId: 'free-w' });
  });

  it("selects the solo caller's free wallet when the purchased balance is negative", async () => {
    // The founder ruling: a NEGATIVE purchased balance (a settled-into-the-red
    // wallet) draws the free tier, not the purchased wallet.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        walletsByUser: {
          u1: [
            { id: 'free-w', type: 'free', balanceNanoUsd: 0n },
            { id: 'paid-w', type: 'purchased', balanceNanoUsd: -100n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({ epochNumber: 3, walletId: 'free-w' });
  });

  it("falls through to the SENDER's free wallet when the group headroom is exhausted and their purchased balance is spent down", async () => {
    // The sender has no member-budget row (zero group headroom) → self-funds; the
    // sender's purchased wallet is spent to zero → the free wallet is the payer.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: null,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
          u1: [
            { id: 'sender-free', type: 'free', balanceNanoUsd: 0n },
            { id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 0n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({ epochNumber: 3, walletId: 'sender-free' });
  });

  it("funds an owner-funded group turn from the OWNER's wallet, not the sending member's", async () => {
    // The sender ('u1') is a member; the owner ('owner-9') is a different user
    // with positive group headroom (member cap, conversation cap, owner balance
    // all ample), so the turn is owner-funded — the payer is the OWNER's wallet.
    const walletLookups: string[] = [];
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: { budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n },
        conversationSpent: 0n,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
        },
        walletLookups,
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({ epochNumber: 3, walletId: 'owner-paid-w' });
    // Only the owner's wallet is read on the owner-funded branch.
    expect(walletLookups).toEqual(['owner-9']);
  });

  it("falls through to the SENDER's own wallet when the group headroom is exhausted (personal)", async () => {
    // The sender ('u1') has no member-budget row (zero group headroom), so even
    // with an ample-balance owner the route funds from the sender's OWN wallet.
    const walletLookups: string[] = [];
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: null, // absent → zero cap → zero headroom → fall through
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
          u1: [{ id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
        },
        walletLookups,
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({ epochNumber: 3, walletId: 'sender-paid-w' });
    // The owner is read for the headroom check, then the sender for the payer.
    expect(walletLookups).toEqual(['owner-9', 'u1']);
  });

  it("falls through to the sender's wallet when the owner has no purchased wallet at all", async () => {
    // The owner never funded a wallet → owner balance reads as zero → zero group
    // headroom → the turn funds from the sender's own wallet.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: { budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-free', type: 'free' }], // no purchased wallet
          u1: [{ id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({ epochNumber: 3, walletId: 'sender-paid-w' });
  });

  it('refuses a fallen-through group turn when the sender has no purchased wallet', async () => {
    // Group headroom exhausted (owner in the red) → fall through to the sender,
    // who has no purchased wallet → forbidden.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: { budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 0n }],
          u1: [{ id: 'sender-free', type: 'free' }],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses a send onto a missing fork with not_found', async () => {
    const result = await resolveTurnContext(
      deps({ member: { id: 'm1' }, conversation: { currentEpoch: 3 }, fork: null }),
      DB,
      { ...ARGS, forkId: 'gone' }
    );
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('resolves a solo send onto an existing fork', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        fork: { id: 'f1' },
        walletsByUser: { u1: [{ id: 'paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }] },
      }),
      DB,
      { ...ARGS, forkId: 'f1' }
    );
    expect(result._unsafeUnwrap()).toEqual({ epochNumber: 3, walletId: 'paid-w' });
  });
});
