import { describe, expect, it, vi } from 'vitest';
import { createForkMessageDeleter, deleteForkMessagesWithinTx } from './fork-messages.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';

/** A tx double whose `delete(...).where(...)` resolves or rejects on demand. */
function fakeTx(where: () => PromiseLike<unknown>): { tx: DbWriter; deleteCalls: number } {
  let deleteCalls = 0;
  const tx = {
    delete: () => {
      deleteCalls += 1;
      return { where };
    },
  } as unknown as DbWriter;
  return {
    tx,
    get deleteCalls() {
      return deleteCalls;
    },
  };
}

describe('deleteForkMessagesWithinTx', () => {
  it('is a no-op that issues no query for an empty id set', async () => {
    const where = vi.fn();
    const { tx } = fakeTx(where);
    const result = await deleteForkMessagesWithinTx(tx, 'conv', []);
    expect(result.isOk()).toBe(true);
    expect(where).not.toHaveBeenCalled();
  });

  it('deletes the given message ids', async () => {
    const captured: unknown[] = [];
    const { tx } = fakeTx(() => {
      captured.push('deleted');
      return Promise.resolve();
    });
    const result = await deleteForkMessagesWithinTx(tx, 'conv', ['a', 'b']);
    expect(result.isOk()).toBe(true);
    expect(captured).toEqual(['deleted']);
  });

  it('maps a delete failure to an unavailable domain error', async () => {
    const { tx } = fakeTx(() => Promise.reject(new Error('db down')));
    const result = await deleteForkMessagesWithinTx(tx, 'conv', ['a']);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('createForkMessageDeleter', () => {
  it('binds the transaction and forwards the conversation scope to the deleter', async () => {
    const fake = fakeTx(() => Promise.resolve());
    const result = await createForkMessageDeleter(fake.tx)('conv', ['a']);
    expect(result.isOk()).toBe(true);
    // The bound deleter issued exactly one scoped delete for the ids.
    expect(fake.deleteCalls).toBe(1);
  });

  it('returns a deleter whose empty-id call stays a no-op', async () => {
    const where = vi.fn();
    const { tx } = fakeTx(where);
    const result = await createForkMessageDeleter(tx)('conv', []);
    expect(result.isOk()).toBe(true);
    expect(where).not.toHaveBeenCalled();
  });
});
