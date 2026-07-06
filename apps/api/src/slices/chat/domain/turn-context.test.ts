import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { resolveTurnContext } from './turn-context.js';
import type { ConversationsStoresFactory, ResolveTurnContextDeps } from './turn-context.js';
import type { BillingStores } from '../../billing/index.js';
import type { Database } from '@hushbox/db';

const DB = {} as Database;
const ARGS = { conversationId: 'c1', userId: 'u1' };

interface StoreStubs {
  readonly member?: unknown;
  readonly conversation?: { readonly currentEpoch: number } | null;
  readonly wallets?: readonly { readonly id: string; readonly type: string }[];
}

function deps(stubs: StoreStubs): ResolveTurnContextDeps {
  const conversations = (() => ({
    members: { activeByUser: () => okAsync(stubs.member ?? null) },
    conversations: { get: () => okAsync(stubs.conversation ?? null) },
  })) as unknown as ConversationsStoresFactory;
  const billing = {
    readWallets: () => okAsync(stubs.wallets ?? []),
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

  it('refuses a caller with no purchased wallet with forbidden', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        wallets: [{ id: 'w', type: 'free' }],
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('resolves the current epoch and the purchased wallet', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        wallets: [
          { id: 'free-w', type: 'free' },
          { id: 'paid-w', type: 'purchased' },
        ],
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({ epochNumber: 3, walletId: 'paid-w' });
  });
});
