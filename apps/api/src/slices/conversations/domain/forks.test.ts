import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { createFork, nextAutoName, renameFork } from './forks.js';
import { conversationRecord, fakeStores, memberRecord } from './test-fixtures.js';
import type { ForkRecord } from '../ports/index.js';

const writer = memberRecord({ userId: 'writer', privilege: 'write' });

function forkRecord(overrides: Partial<ForkRecord> = {}): ForkRecord {
  return { id: 'f1', name: 'Main', tipMessageId: 'msg1', createdAt: new Date(0), ...overrides };
}

describe('nextAutoName', () => {
  it('starts at Fork 1 when no auto-names exist', () => {
    expect(nextAutoName(['Main', 'Alt take'])).toBe('Fork 1');
  });

  it('continues one past the highest existing auto-name', () => {
    expect(nextAutoName(['Main', 'Fork 2', 'Fork 9'])).toBe('Fork 10');
  });

  it('ignores names that merely resemble the pattern', () => {
    expect(nextAutoName(['Fork x', 'fork 3', 'Fork 07b'])).toBe('Fork 1');
  });
});

/**
 * The name pre-checks run under the conversation lock, so a unique-violation
 * surfacing from the store afterwards is an invariant break — stageable only
 * with fakes.
 */
describe('createFork collision defects under the lock', () => {
  function createParams(): Parameters<typeof createFork>[1] {
    return {
      conversationId: 'c1',
      callerUserId: 'writer',
      id: 'f-new',
      fromMessageId: 'msg1',
      name: 'Alt',
    };
  }

  function baseOverrides(): Parameters<typeof fakeStores>[0] {
    return {
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(writer) },
      messages: { inConversation: () => okAsync(true), latestId: () => okAsync('msg2') },
    };
  }

  it('treats a Main-fork collision in an empty fork set as a defect', async () => {
    const stores = fakeStores({
      ...baseOverrides(),
      forks: {
        byId: () => okAsync(null),
        list: () => okAsync([]),
        insert: () => okAsync('name-taken' as const),
      },
    });
    await expect(createFork(stores, createParams())).rejects.toThrow(/Main fork collided/);
  });

  it('treats a first-branch name collision after the pre-check as a defect', async () => {
    let inserts = 0;
    const stores = fakeStores({
      ...baseOverrides(),
      forks: {
        byId: () => okAsync(null),
        list: () => okAsync([]),
        insert: () => {
          inserts += 1;
          return okAsync(inserts === 1 ? forkRecord() : ('name-taken' as const));
        },
      },
    });
    await expect(createFork(stores, createParams())).rejects.toThrow(
      /collided under the conversation lock/
    );
  });

  it('treats an additional-fork name collision after the pre-check as a defect', async () => {
    const stores = fakeStores({
      ...baseOverrides(),
      forks: {
        byId: () => okAsync(null),
        list: () => okAsync([forkRecord()]),
        insert: () => okAsync('name-taken' as const),
      },
    });
    await expect(createFork(stores, createParams())).rejects.toThrow(
      /collided under the conversation lock/
    );
  });
});

describe('renameFork collision defect under the lock', () => {
  it('treats a rename collision after the pre-check as a defect', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(writer) },
      forks: {
        list: () => okAsync([forkRecord({ id: 'f1', name: 'Alt' })]),
        rename: () => okAsync('name-taken' as const),
      },
    });
    await expect(
      renameFork(stores, {
        conversationId: 'c1',
        forkId: 'f1',
        callerUserId: 'writer',
        name: 'Renamed',
      })
    ).rejects.toThrow(/rename collided under the conversation lock/);
  });
});
