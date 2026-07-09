import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { getKeyChain, getKeyChainBatch } from './keychain.js';
import { conversationRecord, fakeStores, memberRecord, userRow } from './test-fixtures.js';

const CALLER_KEY = new Uint8Array(32).fill(7);

describe('getKeyChain', () => {
  it('answers not-found for a missing conversation', async () => {
    const stores = fakeStores({ conversations: { get: () => okAsync(null) } });
    const result = await getKeyChain(stores, { conversationId: 'c1', callerUserId: 'owner' });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('treats a missing users row for an authenticated member as a defect', async () => {
    const stores = fakeStores({
      conversations: { get: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: () => okAsync(null) },
    });
    await expect(
      getKeyChain(stores, { conversationId: 'c1', callerUserId: 'owner' })
    ).rejects.toThrow(/no users row/);
  });

  it('answers not-found for a member holding no wraps', async () => {
    const stores = fakeStores({
      conversations: { get: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: (id) => userRow(id, CALLER_KEY) },
      epochs: { wrapsForKey: () => okAsync([]), chainLinks: () => okAsync([]) },
    });
    const result = await getKeyChain(stores, { conversationId: 'c1', callerUserId: 'owner' });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

describe('getKeyChainBatch', () => {
  it('treats a missing users row for an authenticated caller as a defect', async () => {
    const stores = fakeStores({ users: { byId: () => okAsync(null) } });
    await expect(
      getKeyChainBatch(stores, { conversationIds: ['c1'], callerUserId: 'owner' })
    ).rejects.toThrow(/no users row/);
  });

  it('splits accessible conversations from missing ones and dedupes ids', async () => {
    const stores = fakeStores({
      users: { byId: (id) => userRow(id, CALLER_KEY) },
      conversations: {
        get: (id) => okAsync(id === 'c1' ? conversationRecord({ id: 'c1' }) : null),
      },
      members: { activeByUser: () => okAsync(memberRecord()) },
      epochs: {
        wrapsForKey: () =>
          okAsync([
            {
              epochNumber: 1,
              wrap: new Uint8Array([1]),
              confirmationHash: new Uint8Array([2]),
              visibleFromEpoch: 1,
            },
          ]),
        chainLinks: () => okAsync([]),
      },
    });
    const result = await getKeyChainBatch(stores, {
      conversationIds: ['c1', 'c1', 'gone'],
      callerUserId: 'owner',
    });
    const view = result._unsafeUnwrap();
    expect(Object.keys(view.keyChains)).toEqual(['c1']);
    expect(view.keyChains['c1']?.currentEpoch).toBe(1);
    expect(view.missing).toEqual(['gone']);
  });
});
