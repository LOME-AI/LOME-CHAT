import { describe, expect, it } from 'vitest';
import { createConversationsStores } from './stores.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';

/**
 * Arms the schema constraints make unreachable against real Postgres: the
 * member-identity CHECK forbids an active row naming neither principal, a
 * count query always returns one row, and a plain INSERT always returns its
 * row. The store's contract still has to answer those shapes, so they are
 * staged through a minimal fake client.
 */

function selectDb(rows: unknown[]): DbWriter {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as DbWriter;
}

function insertDb(outcome: Promise<unknown[]>): DbWriter {
  return {
    insert: () => ({ values: () => ({ returning: () => outcome }) }),
  } as unknown as DbWriter;
}

describe('members.countActive', () => {
  it('answers zero when the count query yields no row', async () => {
    const stores = createConversationsStores(selectDb([]));
    const count = await stores.members.countActive('c1');
    expect(count._unsafeUnwrap()).toBe(0);
  });
});

describe('members.activePrincipalIds', () => {
  it('collects user and link principals and drops identity-less rows', async () => {
    const stores = createConversationsStores(
      selectDb([
        { userId: 'u1', linkId: null },
        { userId: null, linkId: 'l1' },
        { userId: null, linkId: null },
      ])
    );
    const principals = await stores.members.activePrincipalIds('c1');
    expect(principals._unsafeUnwrap()).toEqual(['u1', 'l1']);
  });
});

function updateDb(outcome: Promise<unknown[]>): DbWriter {
  return {
    update: () => ({ set: () => ({ where: () => ({ returning: () => outcome }) }) }),
  } as unknown as DbWriter;
}

describe('epochs.insert', () => {
  it('treats an insert returning no row as unavailable', async () => {
    const stores = createConversationsStores(insertDb(Promise.resolve([])));
    const result = await stores.epochs.insert({
      conversationId: 'c1',
      epochNumber: 2,
      previousEpochId: 'e1',
      epochPublicKey: new Uint8Array(1),
      confirmationHash: new Uint8Array(1),
      chainLink: null,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('epochs.insertWraps', () => {
  it('answers ok for an empty wrap batch without touching the database', async () => {
    const stores = createConversationsStores(selectDb([]));
    const result = await stores.epochs.insertWraps([]);
    expect(result.isOk()).toBe(true);
  });
});

describe('members.markLeft', () => {
  it('answers null when the conditional update matches no active row', async () => {
    const stores = createConversationsStores(updateDb(Promise.resolve([])));
    const result = await stores.members.markLeft({ conversationId: 'c1', memberId: 'm1' });
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe('sharedMessages.insert', () => {
  it('throws a defect when the insert returns no row', async () => {
    const stores = createConversationsStores(insertDb(Promise.resolve([])));
    await expect(
      stores.sharedMessages.insert({
        messageId: 'm1',
        linkId: 'l1',
        createdBy: 'u1',
        wrappedContentKey: new Uint8Array(1),
      })
    ).rejects.toThrow(/shared message insert returned no row/);
  });
});

describe('forks.rename failure mapping', () => {
  it('re-throws a non-unique rename failure as unavailable', async () => {
    const stores = createConversationsStores(updateDb(Promise.reject(new Error('boom'))));
    const result = await stores.forks.rename({ conversationId: 'c1', forkId: 'f1', name: 'x' });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('forks.insert failure mapping', () => {
  it('treats an insert returning no row as unavailable (defect wrapped at the seam)', async () => {
    const stores = createConversationsStores(insertDb(Promise.resolve([])));
    const result = await stores.forks.insert({
      id: 'f1',
      conversationId: 'c1',
      name: 'Alt',
      tipMessageId: null,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a 23505 naming the fork-name constraint only in its message', async () => {
    const error = Object.assign(
      new Error('duplicate key violates "conversation_forks_conversation_name_unique"'),
      { code: '23505' }
    );
    const stores = createConversationsStores(insertDb(Promise.reject(error)));
    const result = await stores.forks.insert({
      id: 'f1',
      conversationId: 'c1',
      name: 'Alt',
      tipMessageId: null,
    });
    expect(result._unsafeUnwrap()).toBe('name-taken');
  });

  it('re-throws a 23505 on a different constraint as unavailable', async () => {
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'conversation_forks_pkey',
    });
    const stores = createConversationsStores(insertDb(Promise.reject(error)));
    const result = await stores.forks.insert({
      id: 'f1',
      conversationId: 'c1',
      name: 'Alt',
      tipMessageId: null,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('re-throws a non-object rejection as unavailable', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the chain-walk must terminate on non-object rejection reasons
    const stores = createConversationsStores(insertDb(Promise.reject('boom')));
    const result = await stores.forks.insert({
      id: 'f1',
      conversationId: 'c1',
      name: 'Alt',
      tipMessageId: null,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
