import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { assertWrapEpochWithinTx } from './wrap-epoch.js';
import type { ConversationsStores } from '../ports/index.js';

const PARAMS = { conversationId: 'c1', epochNumber: 2, userId: 'u1' };

interface Stubs {
  readonly conversation?: { readonly currentEpoch: number } | null;
  readonly member?: { readonly visibleFromEpoch: number } | null;
}

function stores(stubs: Stubs): ConversationsStores {
  return {
    conversations: { lockForShare: () => okAsync(stubs.conversation ?? null) },
    members: { activeByUser: () => okAsync(stubs.member ?? null) },
  } as unknown as ConversationsStores;
}

describe('assertWrapEpochWithinTx', () => {
  it('refuses a missing conversation with not_found', async () => {
    const result = await assertWrapEpochWithinTx(stores({ conversation: null }), PARAMS);
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('refuses a rotated epoch with conflict', async () => {
    const result = await assertWrapEpochWithinTx(
      stores({ conversation: { currentEpoch: 3 } }),
      PARAMS
    );
    expect(result._unsafeUnwrapErr().code).toBe('conflict');
  });

  it('refuses a non-member with forbidden', async () => {
    const result = await assertWrapEpochWithinTx(
      stores({ conversation: { currentEpoch: 2 }, member: null }),
      PARAMS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses a member whose visibility starts after the wrap epoch', async () => {
    const result = await assertWrapEpochWithinTx(
      stores({ conversation: { currentEpoch: 2 }, member: { visibleFromEpoch: 3 } }),
      PARAMS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('passes when the epoch is current and the initiator is a member of it', async () => {
    const result = await assertWrapEpochWithinTx(
      stores({ conversation: { currentEpoch: 2 }, member: { visibleFromEpoch: 1 } }),
      PARAMS
    );
    expect(result._unsafeUnwrap()).toBe(true);
  });
});
