import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { setConversationBudget } from './budgets.js';
import { conversationRecord, fakeStores } from './test-fixtures.js';
import type { ConversationRecord } from '../ports/index.js';

/**
 * The conversation-cap write's 0-row disambiguation tail is reachable only via
 * a mid-transaction race (the authz pre-check already saw the owner's row, so
 * the conditional UPDATE can miss only if the row was deleted or re-owned in
 * between). Real infra cannot produce that state deterministically, so these
 * cases stub the store: the first `get` answers the pre-check, `updateBudget`
 * reports 0 rows, and the second `get` discriminates the two refusals.
 */
describe('setConversationBudget zero-row disambiguation', () => {
  function racingStores(rowAfterMiss: ConversationRecord | null) {
    let reads = 0;
    return fakeStores({
      conversations: {
        get: () => {
          reads += 1;
          return okAsync(reads === 1 ? conversationRecord() : rowAfterMiss);
        },
        updateBudget: () => okAsync(null),
      },
    });
  }

  const params = { conversationId: 'c1', callerUserId: 'owner', capNanoUsd: 10n };

  it('answers forbidden when the update misses but the row still exists (re-owned mid-transaction)', async () => {
    const stores = racingStores(conversationRecord({ ownerUserId: 'other' }));
    const result = await setConversationBudget(stores, () => okAsync(0n), params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('answers not-found when the update misses and the row is gone (deleted mid-transaction)', async () => {
    const stores = racingStores(null);
    const result = await setConversationBudget(stores, () => okAsync(0n), params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});
