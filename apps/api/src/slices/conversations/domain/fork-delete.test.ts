import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { deleteFork } from './forks.js';
import { conversationRecord, fakeStores, memberRecord } from './test-fixtures.js';
import type { ForkRecord } from '../ports/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

const writer = memberRecord({ userId: 'writer', privilege: 'write' });

function fork(id: string, name: string, tipMessageId: string | null): ForkRecord {
  return { id, name, tipMessageId, createdAt: new Date(0) };
}

// A branch tree: m0→m1, then Main (m2), F1 (f1a→f1b), F2 (f2a→f2b) all off m1.
const TREE = [
  { id: 'm0', parentMessageId: null },
  { id: 'm1', parentMessageId: 'm0' },
  { id: 'm2', parentMessageId: 'm1' },
  { id: 'f1a', parentMessageId: 'm1' },
  { id: 'f1b', parentMessageId: 'f1a' },
  { id: 'f2a', parentMessageId: 'm1' },
  { id: 'f2b', parentMessageId: 'f2a' },
];

function recordingDeleter(): {
  readonly calls: { readonly conversationId: string; readonly ids: string[] }[];
  readonly deleteMessages: (
    conversationId: string,
    ids: readonly string[]
  ) => ResultAsync<void, DomainError>;
} {
  const calls: { readonly conversationId: string; readonly ids: string[] }[] = [];
  return {
    calls,
    deleteMessages: (conversationId, ids) => {
      calls.push({ conversationId, ids: [...ids] });
      return okAsync();
    },
  };
}

describe('deleteFork orphan cleanup', () => {
  it('deletes only the branch messages exclusive to the deleted fork, never a shared ancestor', async () => {
    const forks = [fork('main', 'Main', 'm2'), fork('f1', 'F1', 'f1b'), fork('f2', 'F2', 'f2b')];
    let listed = 0;
    const { calls, deleteMessages } = recordingDeleter();
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(writer) },
      messages: { parentChainRows: () => okAsync(TREE) },
      forks: {
        list: () => {
          listed += 1;
          // First read sees all three; after the remove, F2 is gone.
          return okAsync(listed === 1 ? forks : forks.slice(0, 2));
        },
        remove: () => okAsync(true),
      },
    });

    const result = await deleteFork(
      stores,
      { conversationId: 'c1', forkId: 'f2', callerUserId: 'writer' },
      deleteMessages
    );

    expect(result.isOk()).toBe(true);
    // Exactly F2's own branch (f2b, f2a); the shared ancestors m1, m0 stay so
    // Main's and F1's tips are never nulled by the cascade.
    expect(calls).toHaveLength(1);
    expect([...(calls[0]?.ids ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'f2a',
      'f2b',
    ]);
    // The deleter is scoped to the conversation whose fork is being deleted.
    expect(calls[0]?.conversationId).toBe('c1');
  });

  it('is an idempotent no-op with no message deletion when the fork is already gone', async () => {
    const { calls, deleteMessages } = recordingDeleter();
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(writer) },
      forks: { list: () => okAsync([fork('main', 'Main', 'm2'), fork('f1', 'F1', 'f1b')]) },
    });

    const result = await deleteFork(
      stores,
      { conversationId: 'c1', forkId: 'gone', callerUserId: 'writer' },
      deleteMessages
    );

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
