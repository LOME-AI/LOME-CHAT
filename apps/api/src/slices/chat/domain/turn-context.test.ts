import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { resolveTurnContext } from './turn-context.js';
import type { ConversationsStoresFactory, ResolveTurnContextDeps } from './turn-context.js';
import { DAILY_ALLOWANCE_NANO_USD } from '../../billing/index.js';
import type { BillingStores } from '../../billing/index.js';
import type { Database } from '@hushbox/db';

const DB = {} as Database;
const NOW = new Date('2026-07-10T12:00:00Z');
const ARGS = { conversationId: 'c1', sender: { kind: 'user', userId: 'u1' } as const, now: NOW };
/** The server-resolved sender fields a user turn (member 'm1', sender 'u1') always yields. */
const USER_FIELDS = {
  sender: { kind: 'user', userId: 'u1', memberId: 'm1' },
  senderId: 'u1',
  payerUserId: 'u1',
} as const;

interface WalletStub {
  readonly id: string;
  readonly type: string;
  readonly balanceNanoUsd?: bigint;
}

interface StoreStubs {
  readonly member?: { readonly id: string } | null;
  /** The active link-guest member row `resolveCallerMember` returns for a guest sender. */
  readonly linkGuest?: { readonly id: string; readonly privilege?: string } | null;
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
  /** The payer's free-tier allowance already spent today (defaults 0). */
  readonly allowanceSpent?: bigint;
  readonly fork?: { readonly id: string } | null;
  /** Records the userIds the wallet lookup was scoped to, in call order. */
  readonly walletLookups?: string[];
}

function deps(stubs: StoreStubs): ResolveTurnContextDeps {
  const conversations = (() => ({
    members: {
      activeByUser: () => okAsync(stubs.member ?? null),
      activeLinkGuest: () =>
        okAsync(
          stubs.linkGuest == null
            ? null
            : { member: stubs.linkGuest, publicKey: new Uint8Array(), displayName: null }
        ),
    },
    conversations: {
      get: () =>
        okAsync(
          stubs.conversation == null
            ? null
            : {
                currentEpoch: stubs.conversation.currentEpoch,
                // Default the owner to the caller so an unset owner is a SOLO turn.
                ownerUserId: stubs.conversation.ownerUserId ?? ARGS.sender.userId,
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
    readAllowanceSpent: () => okAsync(stubs.allowanceSpent ?? 0n),
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
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'paid-w',
      funding: { remainingNanoUsd: 1_000_000n, kind: 'purchased' },
    });
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
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'free-w',
      funding: { remainingNanoUsd: DAILY_ALLOWANCE_NANO_USD, kind: 'free' },
    });
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
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'free-w',
      funding: { remainingNanoUsd: DAILY_ALLOWANCE_NANO_USD, kind: 'free' },
    });
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
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'sender-free',
      funding: { remainingNanoUsd: DAILY_ALLOWANCE_NANO_USD, kind: 'free' },
    });
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
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'owner-paid-w',
      funding: { remainingNanoUsd: 1_000_000n, kind: 'purchased' },
    });
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
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'sender-paid-w',
      funding: { remainingNanoUsd: 1_000_000n, kind: 'purchased' },
    });
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
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'sender-paid-w',
      funding: { remainingNanoUsd: 1_000_000n, kind: 'purchased' },
    });
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
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'paid-w',
      funding: { remainingNanoUsd: 1_000_000n, kind: 'purchased' },
    });
  });

  it("surfaces the free payer's REMAINING daily allowance (limit minus today's spend)", async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        allowanceSpent: 1_000_000n,
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
    expect(result._unsafeUnwrap().funding).toEqual({
      remainingNanoUsd: DAILY_ALLOWANCE_NANO_USD - 1_000_000n,
      kind: 'free',
    });
  });

  it('clamps an overspent daily allowance to zero remaining (admission then refuses)', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        allowanceSpent: DAILY_ALLOWANCE_NANO_USD + 5n,
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
    expect(result._unsafeUnwrap().funding).toEqual({ remainingNanoUsd: 0n, kind: 'free' });
  });

  it('surfaces the group MIN (member cap, conversation cap, owner balance) as the owner-funded remaining', async () => {
    // memberRemaining = 700 − 200 = 500 is the binding dimension:
    // conversationRemaining = 2000 − 100 = 1900, ownerBalance = 5000.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 2000n,
        },
        memberBudget: { budgetNanoUsd: 700n, spentNanoUsd: 200n },
        conversationSpent: 100n,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 5000n }],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'owner-paid-w',
      funding: { remainingNanoUsd: 500n, kind: 'purchased' },
    });
  });

  const GUEST_ARGS = {
    conversationId: 'c1',
    sender: { kind: 'linkGuest', linkId: 'l1' } as const,
    now: NOW,
  };

  it('funds a WRITE link-guest turn from the OWNER wallet and attributes the guest as sender', async () => {
    const result = await resolveTurnContext(
      deps({
        linkGuest: { id: 'gm1' },
        conversation: {
          currentEpoch: 4,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: { budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n },
        conversationSpent: 0n,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
        },
      }),
      DB,
      GUEST_ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      epochNumber: 4,
      walletId: 'owner-paid-w',
      funding: { remainingNanoUsd: 1_000_000n, kind: 'purchased' },
      // The guest is the sender (linkId persists as senderId); the OWNER pays.
      sender: { kind: 'linkGuest', linkId: 'l1', memberId: 'gm1' },
      senderId: 'l1',
      payerUserId: 'owner-9',
    });
  });

  it('DENIES a link-guest turn when the owner headroom is exhausted (a guest has no wallet)', async () => {
    // Member cap zeroed (no row) → group headroom ≤ 0; a user would self-fund,
    // but a guest has no wallet to fall through to, so the send is refused.
    const result = await resolveTurnContext(
      deps({
        linkGuest: { id: 'gm1' },
        conversation: {
          currentEpoch: 4,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: null,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
        },
      }),
      DB,
      GUEST_ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses a link-guest turn when no active guest membership resolves', async () => {
    const result = await resolveTurnContext(
      deps({ linkGuest: null, conversation: { currentEpoch: 4, ownerUserId: 'owner-9' } }),
      DB,
      GUEST_ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });
});
