import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaStorage } from '../storage/index.js';
import type { EmailClient } from '../email/index.js';

interface MockOrder {
  log: string[];
}

interface MockDbBuilders {
  selectImpl: () => unknown;
  selectDistinctImpl: () => unknown;
  insertImpl: () => unknown;
  updateImpl: () => unknown;
  deleteImpl: () => unknown;
}

/**
 * Build a mock db.transaction-capable database whose query builder chains
 * record their order of invocation into `order.log`.
 *
 * Each query builder uses `selectImpl` etc. as factories so tests can stub
 * different responses per-call by replacing the impl between calls. The
 * builders intentionally accept any method calls and short-circuit on the
 * shape of the responses returned by these impls.
 */
function createMockDb(
  builders: MockDbBuilders,
  order: MockOrder
): {
  db: never;
  selectMock: ReturnType<typeof vi.fn>;
  selectDistinctMock: ReturnType<typeof vi.fn>;
  insertMock: ReturnType<typeof vi.fn>;
  updateMock: ReturnType<typeof vi.fn>;
  deleteMock: ReturnType<typeof vi.fn>;
  transactionMock: ReturnType<typeof vi.fn>;
} {
  const selectMock = vi.fn(() => {
    order.log.push('select');
    return builders.selectImpl();
  });
  const selectDistinctMock = vi.fn(() => {
    order.log.push('selectDistinct');
    return builders.selectDistinctImpl();
  });
  const insertMock = vi.fn(() => {
    order.log.push('insert');
    return builders.insertImpl();
  });
  const updateMock = vi.fn(() => {
    order.log.push('update');
    return builders.updateImpl();
  });
  const deleteMock = vi.fn(() => {
    order.log.push('delete');
    return builders.deleteImpl();
  });
  const db: Record<string, unknown> = {
    select: selectMock,
    selectDistinct: selectDistinctMock,
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
  };
  const transactionMock = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    order.log.push('transaction:begin');
    const result = await callback(db);
    order.log.push('transaction:commit');
    return result;
  });
  db['transaction'] = transactionMock;
  return {
    db: db as unknown as never,
    selectMock,
    selectDistinctMock,
    insertMock,
    updateMock,
    deleteMock,
    transactionMock,
  };
}

/**
 * Build a sequence of select chain responses. The first call returns the
 * first response, the second call returns the second response, etc. Each
 * chain supports `.from(...).where(...).for('update')` and also
 * `.from(...).innerJoin(...).innerJoin(...).where(...)` for the R2 key
 * enumeration query.
 */
function selectSequence(responses: unknown[][]): () => unknown {
  let index = 0;
  return () => {
    const rows = responses[index] ?? [];
    index += 1;
    return {
      from: () => ({
        where: () => ({
          for: () => Promise.resolve(rows),
        }),
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve(rows),
          }),
        }),
      }),
    };
  };
}

function selectDistinctSequence(responses: unknown[][]): () => unknown {
  let index = 0;
  return () => {
    const rows = responses[index] ?? [];
    index += 1;
    return {
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve(rows),
          }),
        }),
      }),
    };
  };
}

function noopUpdate(): unknown {
  return {
    set: () => ({
      where: () => Promise.resolve(),
    }),
  };
}

function noopDelete(): unknown {
  return {
    where: () => Promise.resolve(),
  };
}

function noopInsert(): unknown {
  return {
    values: () => Promise.resolve(),
  };
}

function defaultBuilders(selects: unknown[][], selectsDistinct: unknown[][] = []): MockDbBuilders {
  return {
    selectImpl: selectSequence(selects),
    selectDistinctImpl: selectDistinctSequence(selectsDistinct),
    insertImpl: noopInsert,
    updateImpl: noopUpdate,
    deleteImpl: noopDelete,
  };
}

function createMockStorage(): {
  storage: MediaStorage;
  deleteSpy: ReturnType<typeof vi.fn>;
} {
  const deleteSpy = vi.fn((_key: string) => Promise.resolve());
  const storage: MediaStorage = {
    put: vi.fn(),
    delete: deleteSpy,
    mintDownloadUrl: vi.fn(),
    list: vi.fn(),
  };
  return { storage, deleteSpy };
}

function createMockEmail(): {
  email: EmailClient;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const sendSpy = vi.fn(() => Promise.resolve());
  const email: EmailClient = {
    sendEmail: sendSpy,
  };
  return { email, sendSpy };
}

const FIXED_NOW = new Date('2026-05-15T12:00:00.000Z');

describe('deleteUser', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns user-not-found when no user matches the id', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(defaultBuilders([[]]), order);
    const { storage, deleteSpy } = createMockStorage();
    const { email, sendSpy } = createMockEmail();

    const result = await deleteUser({
      db,
      storage,
      email,
      userId: 'missing-user',
      ipAddress: '1.2.3.4',
      userAgent: 'agent',
      now: FIXED_NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'user-not-found' });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('runs the saga in the documented order and returns ok', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const builders = defaultBuilders(
      [[{ email: 'user@example.com' }]],
      [[{ key: 'media/a.enc' }, { key: 'media/b.enc' }]]
    );
    const updatedValues: unknown[] = [];
    builders.updateImpl = () => ({
      set: (input: unknown) => {
        updatedValues.push(input);
        return {
          where: () => Promise.resolve(),
        };
      },
    });
    const { db, selectMock, selectDistinctMock, insertMock, updateMock, deleteMock } = createMockDb(
      builders,
      order
    );
    const { storage, deleteSpy } = createMockStorage();
    const { email, sendSpy } = createMockEmail();

    const result = await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: '1.2.3.4',
      userAgent: 'agent',
      now: FIXED_NOW,
    });

    expect(result).toEqual({ ok: true });
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(selectDistinctMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(order.log).toEqual([
      'transaction:begin',
      'select',
      'selectDistinct',
      'update',
      'update',
      'insert',
      'delete',
      'transaction:commit',
    ]);
    expect(updatedValues[0]).toEqual({ leftAt: FIXED_NOW });
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenNthCalledWith(1, 'media/a.enc');
    expect(deleteSpy).toHaveBeenNthCalledWith(2, 'media/b.enc');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [emailCall] = sendSpy.mock.calls;
    expect(emailCall).toBeDefined();
    expect(emailCall![0]).toMatchObject({
      to: 'user@example.com',
      subject: expect.stringMatching(/HushBox account/),
    });
  });

  it('enumerates R2 keys before deleting the user (otherwise content_items cascade loses them)', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(
      defaultBuilders([[{ email: 'user@example.com' }]], [[{ key: 'media/x.enc' }]]),
      order
    );
    const { storage } = createMockStorage();
    const { email } = createMockEmail();

    await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    const selectDistinctIndex = order.log.indexOf('selectDistinct');
    const deleteIndex = order.log.indexOf('delete');
    expect(selectDistinctIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(selectDistinctIndex).toBeLessThan(deleteIndex);
  });

  it('captures the email before the user is deleted', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(defaultBuilders([[{ email: 'user@example.com' }]], [[]]), order);
    const { storage } = createMockStorage();
    const { email, sendSpy } = createMockEmail();

    await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    const selectIndex = order.log.indexOf('select');
    const deleteIndex = order.log.indexOf('delete');
    expect(selectIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(selectIndex).toBeLessThan(deleteIndex);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ to: 'user@example.com' }));
  });

  it('runs R2 storage deletes only AFTER the transaction has committed', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(
      defaultBuilders([[{ email: 'user@example.com' }]], [[{ key: 'media/x.enc' }]]),
      order
    );
    const { storage } = createMockStorage();
    storage.delete = vi.fn(async (_key: string) => {
      order.log.push('storage:delete');
      await Promise.resolve();
    });
    const { email } = createMockEmail();

    await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    const commitIndex = order.log.indexOf('transaction:commit');
    const storageDeleteIndex = order.log.indexOf('storage:delete');
    expect(commitIndex).toBeGreaterThan(-1);
    expect(storageDeleteIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeLessThan(storageDeleteIndex);
  });

  it('sends the completion email only AFTER the transaction has committed', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(defaultBuilders([[{ email: 'user@example.com' }]], [[]]), order);
    const { storage } = createMockStorage();
    const { email } = createMockEmail();
    email.sendEmail = vi.fn(async () => {
      order.log.push('email:send');
      await Promise.resolve();
    });

    await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    const commitIndex = order.log.indexOf('transaction:commit');
    const sendIndex = order.log.indexOf('email:send');
    expect(commitIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeLessThan(sendIndex);
  });

  it('sends the deletion email BEFORE starting R2 cleanup', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(
      defaultBuilders([[{ email: 'user@example.com' }]], [[{ key: 'media/x.enc' }]]),
      order
    );
    const { storage } = createMockStorage();
    storage.delete = vi.fn(async (_key: string) => {
      order.log.push('storage:delete');
      await Promise.resolve();
    });
    const { email } = createMockEmail();
    email.sendEmail = vi.fn(async () => {
      order.log.push('email:send');
      await Promise.resolve();
    });

    await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    const sendIndex = order.log.indexOf('email:send');
    const storageDeleteIndex = order.log.indexOf('storage:delete');
    expect(sendIndex).toBeGreaterThan(-1);
    expect(storageDeleteIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeLessThan(storageDeleteIndex);
  });

  it('caps R2 deletes at maxR2Deletes; remainder is left to the GC and a warn is logged', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const keys = Array.from({ length: 60 }, (_v, index) => ({
      key: `media/${String(index)}.enc`,
    }));
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(defaultBuilders([[{ email: 'user@example.com' }]], [keys]), order);
    const { storage, deleteSpy } = createMockStorage();
    const { email } = createMockEmail();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // suppress
    });

    const result = await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
      maxR2Deletes: 25,
    });

    expect(result).toEqual({ ok: true });
    expect(deleteSpy).toHaveBeenCalledTimes(25);
    expect(
      warnSpy.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('delete-user') && call[0].includes('cap')
      )
    ).toBe(true);
  });

  it('logs and swallows R2 storage failures, still returning ok and sending email', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(
      defaultBuilders([[{ email: 'user@example.com' }]], [[{ key: 'media/x.enc' }]]),
      order
    );
    const { storage } = createMockStorage();
    (storage.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('r2 down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // intentionally suppress
    });
    const { email, sendSpy } = createMockEmail();

    const result = await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    expect(result).toEqual({ ok: true });
    expect(warnSpy).toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows email send failures, still returning ok', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(defaultBuilders([[{ email: 'user@example.com' }]], [[]]), order);
    const { storage } = createMockStorage();
    const { email } = createMockEmail();
    (email.sendEmail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('email down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // intentionally suppress
    });

    const result = await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    expect(result).toEqual({ ok: true });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('runs all DB ops via the tx handle — never the outer db — inside the transaction', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const builders = defaultBuilders([[{ email: 'user@example.com' }]], [[]]);
    const txSelect = vi.fn(() => builders.selectImpl());
    const txSelectDistinct = vi.fn(() => builders.selectDistinctImpl());
    const txInsert = vi.fn(() => builders.insertImpl());
    const txUpdate = vi.fn(() => builders.updateImpl());
    const txDelete = vi.fn(() => builders.deleteImpl());
    const tx = {
      select: txSelect,
      selectDistinct: txSelectDistinct,
      insert: txInsert,
      update: txUpdate,
      delete: txDelete,
    };
    const forbid = (name: string) =>
      vi.fn(() => {
        throw new Error(`outer db.${name} called inside tx`);
      });
    const outerDb: Record<string, unknown> = {
      select: forbid('select'),
      selectDistinct: forbid('selectDistinct'),
      insert: forbid('insert'),
      update: forbid('update'),
      delete: forbid('delete'),
      transaction: vi.fn(async (callback: (txArgument: unknown) => Promise<unknown>) => {
        order.log.push('transaction:begin');
        const result = await callback(tx);
        order.log.push('transaction:commit');
        return result;
      }),
    };
    const { storage } = createMockStorage();
    const { email } = createMockEmail();

    const result = await deleteUser({
      db: outerDb as unknown as never,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    expect(result).toEqual({ ok: true });
    expect(txSelect).toHaveBeenCalled();
    expect(txSelectDistinct).toHaveBeenCalled();
    expect(txUpdate).toHaveBeenCalled();
    expect(txInsert).toHaveBeenCalled();
    expect(txDelete).toHaveBeenCalled();
  });

  it('propagates DB transaction failures without touching R2 or email', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db, transactionMock } = createMockDb(
      defaultBuilders([[{ email: 'user@example.com' }]], [[]]),
      order
    );
    const sagaError = new Error('db blew up');
    transactionMock.mockRejectedValueOnce(sagaError);
    const { storage, deleteSpy } = createMockStorage();
    const { email, sendSpy } = createMockEmail();

    await expect(
      deleteUser({
        db,
        storage,
        email,
        userId: 'user-1',
        ipAddress: null,
        userAgent: null,
        now: FIXED_NOW,
      })
    ).rejects.toBe(sagaError);

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('skips email and R2 cleanup work entirely on user-not-found', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db, selectDistinctMock, updateMock, insertMock, deleteMock } = createMockDb(
      defaultBuilders([[]], []),
      order
    );
    const { storage, deleteSpy } = createMockStorage();
    const { email, sendSpy } = createMockEmail();

    const result = await deleteUser({
      db,
      storage,
      email,
      userId: 'ghost',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'user-not-found' });
    expect(selectDistinctMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('chunks R2 deletes when there are more than the batch size', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const keys = Array.from({ length: 120 }, (_v, index) => ({
      key: `media/${String(index)}.enc`,
    }));
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(defaultBuilders([[{ email: 'user@example.com' }]], [keys]), order);
    const { storage, deleteSpy } = createMockStorage();
    const { email } = createMockEmail();

    await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    expect(deleteSpy).toHaveBeenCalledTimes(120);
    const callKeys = deleteSpy.mock.calls.map((call) => call[0]);
    expect(new Set(callKeys).size).toBe(120);
  });

  it('does not send an email when the user has no email on record', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const { db } = createMockDb(defaultBuilders([[{ email: null }]], [[]]), order);
    const { storage } = createMockStorage();
    const { email, sendSpy } = createMockEmail();

    const result = await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      now: FIXED_NOW,
    });

    expect(result).toEqual({ ok: true });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('records the saga event with ipAddress and userAgent from args', async () => {
    const { deleteUser } = await import('./delete-user.js');
    const order: MockOrder = { log: [] };
    const builders = defaultBuilders([[{ email: 'user@example.com' }]], [[]]);
    const insertedValues: unknown[] = [];
    builders.insertImpl = () => ({
      values: (input: unknown) => {
        insertedValues.push(input);
        return Promise.resolve();
      },
    });
    const { db } = createMockDb(builders, order);
    const { storage } = createMockStorage();
    const { email } = createMockEmail();

    await deleteUser({
      db,
      storage,
      email,
      userId: 'user-1',
      ipAddress: '203.0.113.5',
      userAgent: 'Mozilla/5.0',
      now: FIXED_NOW,
    });

    expect(insertedValues).toEqual([
      {
        deletedAt: FIXED_NOW,
        ipAddress: '203.0.113.5',
        userAgent: 'Mozilla/5.0',
      },
    ]);
  });
});
