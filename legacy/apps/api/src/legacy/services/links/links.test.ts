import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSubmitRotation = vi.hoisted(() => vi.fn());

vi.mock('../keys/keys.js', () => ({
  submitRotation: (...args: unknown[]) => mockSubmitRotation(...args),
  StaleEpochError: class StaleEpochError extends Error {
    currentEpoch: number;
    constructor(currentEpoch: number) {
      super(`Stale epoch: expected rotation from epoch ${String(currentEpoch)}`);
      this.name = 'StaleEpochError';
      this.currentEpoch = currentEpoch;
    }
  },
}));

import { listLinks, createLink, revokeLink, changeLinkPrivilege } from './links.js';
import { StaleEpochError, type SubmitRotationParams } from '../keys/keys.js';

/**
 * Mock DB builder chain factory for link service unit tests.
 * Follows the same pattern as balance.test.ts / members.test.ts:
 * mock Drizzle query builder chain methods.
 */
function createMockDb() {
  const mockSelect = vi.fn();
  const mockUpdate = vi.fn();
  const mockInsert = vi.fn();

  const db = {
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
    transaction: vi
      .fn()
      .mockImplementation((callback: (tx: typeof db) => Promise<unknown>) => callback(db)),
  };

  return { db, mockSelect, mockUpdate, mockInsert };
}

/**
 * Helper to set up a select chain without orderBy:
 * db.select().from(table).where(cond) -> rows
 */
function mockSelectChainNoOrder(mockSelect: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  });
}

/**
 * Helper to set up a select chain with innerJoin:
 * db.select().from(table).innerJoin(joined, cond).where(cond).orderBy(ord) -> rows
 */
function mockSelectChainWithJoin(mockSelect: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  });
}

/**
 * Helper to set up a select chain with limit (no orderBy):
 * db.select().from(table).where(cond).limit(n) -> rows
 */
function mockSelectChainWithLimit(mockSelect: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

/**
 * Helper to set up a select chain with FOR UPDATE:
 * db.select().from(table).where(cond).for('update') -> rows
 */
function mockSelectChainWithFor(mockSelect: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        for: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

/**
 * Helper to set up an insert chain with onConflictDoUpdate:
 * db.insert(table).values(data).onConflictDoUpdate(config).returning(cols) -> rows
 */
function mockInsertUpsertChain(
  mockInsert: ReturnType<typeof vi.fn>,
  returnedRows: unknown[]
): void {
  mockInsert.mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returnedRows),
      }),
    }),
  });
}

/**
 * Helper to set up an insert chain with onConflictDoUpdate but no returning:
 * db.insert(table).values(data).onConflictDoUpdate(config) -> void
 */
function mockInsertUpsertChainNoReturn(mockInsert: ReturnType<typeof vi.fn>): void {
  mockInsert.mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

/**
 * Helper to set up an update chain without returning:
 * db.update(table).set(data).where(cond) -> void
 */
function mockUpdateChain(mockUpdate: ReturnType<typeof vi.fn>): void {
  mockUpdate.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => Promise.resolve()),
    }),
  });
}

/**
 * Helper to set up an update chain with returning:
 * db.update(table).set(data).where(cond).returning() -> rows
 */
function mockUpdateChainReturning(mockUpdate: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockUpdate.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

describe('listLinks', () => {
  let db: ReturnType<typeof createMockDb>['db'];
  let mockSelect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mocks = createMockDb();
    db = mocks.db;
    mockSelect = mocks.mockSelect;
  });

  it('returns active links for a conversation', async () => {
    const fakeLinks = [
      {
        id: 'link-1',
        linkPublicKey: new Uint8Array(32).fill(1),
        privilege: 'read',
        displayName: null,
        createdAt: new Date('2026-01-15'),
      },
      {
        id: 'link-2',
        linkPublicKey: new Uint8Array(32).fill(2),
        privilege: 'write',
        displayName: 'Team Invite',
        createdAt: new Date('2026-01-10'),
      },
    ];

    mockSelectChainWithJoin(mockSelect, fakeLinks);

    const result = await listLinks(db as never, 'conv-1');

    expect(result).toEqual(fakeLinks);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when no active links exist', async () => {
    mockSelectChainWithJoin(mockSelect, []);

    const result = await listLinks(db as never, 'conv-1');

    expect(result).toEqual([]);
  });

  it('orders by createdAt descending', async () => {
    mockSelectChainWithJoin(mockSelect, []);

    await listLinks(db as never, 'conv-1');

    expect(mockSelect).toHaveBeenCalledTimes(1);
    const firstResult = mockSelect.mock.results[0];
    if (!firstResult) throw new Error('Expected at least one select call');
    const fromFunction = firstResult.value.from;
    expect(fromFunction).toHaveBeenCalledTimes(1);
    const innerJoinFunction = fromFunction.mock.results[0].value.innerJoin;
    expect(innerJoinFunction).toHaveBeenCalledTimes(1);
    const whereFunction = innerJoinFunction.mock.results[0].value.where;
    expect(whereFunction).toHaveBeenCalledTimes(1);
    const orderByFunction = whereFunction.mock.results[0].value.orderBy;
    expect(orderByFunction).toHaveBeenCalledTimes(1);
  });
});

describe('createLink', () => {
  let db: ReturnType<typeof createMockDb>['db'];
  let mockSelect: ReturnType<typeof vi.fn>;
  let mockInsert: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mocks = createMockDb();
    db = mocks.db;
    mockSelect = mocks.mockSelect;
    mockInsert = mocks.mockInsert;
  });

  it('creates sharedLink, epochMember, and conversationMember atomically', async () => {
    mockSelectChainWithFor(mockSelect, [{ currentEpoch: 1 }]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'epoch-current-1' }]);
    mockSelectChainNoOrder(mockSelect, [{ count: 0 }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'link-new-1' }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'member-new-1' }]);
    mockInsertUpsertChainNoReturn(mockInsert);

    await createLink(db as never, {
      conversationId: 'conv-1',
      linkPublicKey: new Uint8Array(32).fill(5),
      memberWrap: new Uint8Array(48).fill(6),
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: 'epoch-current-1',
    });

    expect(mockInsert).toHaveBeenCalledTimes(3);
  });

  it('returns linkId and memberId', async () => {
    mockSelectChainWithFor(mockSelect, [{ currentEpoch: 2 }]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'epoch-current-2' }]);
    mockSelectChainNoOrder(mockSelect, [{ count: 0 }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'link-abc' }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'member-def' }]);
    mockInsertUpsertChainNoReturn(mockInsert);

    const result = await createLink(db as never, {
      conversationId: 'conv-1',
      linkPublicKey: new Uint8Array(32).fill(7),
      memberWrap: new Uint8Array(48).fill(8),
      privilege: 'write',
      visibleFromEpoch: 2,
      currentEpochId: 'epoch-current-2',
    });

    expect(result.linkId).toBe('link-abc');
    expect(result.memberId).toBe('member-def');
  });

  it('uses transaction for atomicity', async () => {
    mockSelectChainWithFor(mockSelect, [{ currentEpoch: 1 }]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'epoch-1' }]);
    mockSelectChainNoOrder(mockSelect, [{ count: 0 }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'link-tx' }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'member-tx' }]);
    mockInsertUpsertChainNoReturn(mockInsert);

    await createLink(db as never, {
      conversationId: 'conv-1',
      linkPublicKey: new Uint8Array(32).fill(9),
      memberWrap: new Uint8Array(48).fill(10),
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: 'epoch-1',
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('returns existing link on duplicate linkPublicKey', async () => {
    mockSelectChainWithFor(mockSelect, [{ currentEpoch: 1 }]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'epoch-1' }]);
    mockSelectChainNoOrder(mockSelect, [{ count: 0 }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'existing-link' }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'existing-member' }]);
    mockInsertUpsertChainNoReturn(mockInsert);

    const result = await createLink(db as never, {
      conversationId: 'conv-1',
      linkPublicKey: new Uint8Array(32).fill(5),
      memberWrap: new Uint8Array(48).fill(6),
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: 'epoch-1',
    });

    expect(result.linkId).toBe('existing-link');
    expect(result.memberId).toBe('existing-member');
  });

  it('includes displayName in sharedLinks insert when provided', async () => {
    mockSelectChainWithFor(mockSelect, [{ currentEpoch: 1 }]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'epoch-1' }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'link-named' }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'member-named' }]);
    mockInsertUpsertChainNoReturn(mockInsert);

    await createLink(db as never, {
      conversationId: 'conv-1',
      linkPublicKey: new Uint8Array(32).fill(11),
      memberWrap: new Uint8Array(48).fill(12),
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: 'epoch-1',
      displayName: 'Guest Reader',
    });

    const firstInsertResult = mockInsert.mock.results[0];
    expect(firstInsertResult).toBeDefined();
    const valuesFunction = firstInsertResult!.value.values;
    expect(valuesFunction).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Guest Reader' })
    );
  });

  it('generates default displayName when not provided', async () => {
    mockSelectChainWithFor(mockSelect, [{ currentEpoch: 1 }]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'epoch-1' }]);
    mockSelectChainNoOrder(mockSelect, [{ count: 2 }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'link-auto-name' }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'member-auto-name' }]);
    mockInsertUpsertChainNoReturn(mockInsert);

    await createLink(db as never, {
      conversationId: 'conv-1',
      linkPublicKey: new Uint8Array(32).fill(13),
      memberWrap: new Uint8Array(48).fill(14),
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: 'epoch-1',
    });

    const firstInsertResult = mockInsert.mock.results[0];
    expect(firstInsertResult).toBeDefined();
    const valuesFunction = firstInsertResult!.value.values;
    expect(valuesFunction).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Guest 3' })
    );
  });

  it('throws StaleEpochError when epoch has rotated between query and transaction', async () => {
    mockSelectChainWithFor(mockSelect, [{ currentEpoch: 5 }]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'epoch-rotated' }]);

    await expect(
      createLink(db as never, {
        conversationId: 'conv-1',
        linkPublicKey: new Uint8Array(32).fill(5),
        memberWrap: new Uint8Array(48).fill(6),
        privilege: 'read',
        visibleFromEpoch: 1,
        currentEpochId: 'epoch-original',
      })
    ).rejects.toThrow('Stale epoch');

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('calls submitRotation instead of epochMembers insert when rotation is provided', async () => {
    mockSelectChainWithFor(mockSelect, [{ currentEpoch: 1 }]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'epoch-current-1' }]);
    mockSelectChainNoOrder(mockSelect, [{ count: 0 }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'link-rot-1' }]);
    mockInsertUpsertChain(mockInsert, [{ id: 'member-rot-1' }]);

    const testRotation: SubmitRotationParams = {
      conversationId: 'conv-1',
      expectedEpoch: 1,
      epochPublicKey: new Uint8Array(32).fill(1),
      confirmationHash: new Uint8Array(32).fill(2),
      chainLink: new Uint8Array(32).fill(3),
      memberWraps: [
        { memberPublicKey: new Uint8Array(32).fill(4), wrap: new Uint8Array(48).fill(5) },
      ],
      encryptedTitle: new Uint8Array(64).fill(6),
    };

    const result = await createLink(db as never, {
      conversationId: 'conv-1',
      linkPublicKey: new Uint8Array(32).fill(15),
      memberWrap: new Uint8Array(48).fill(16),
      privilege: 'read',
      visibleFromEpoch: 2,
      currentEpochId: 'epoch-current-1',
      rotation: testRotation,
    });

    expect(result.linkId).toBe('link-rot-1');
    expect(result.memberId).toBe('member-rot-1');
    expect(mockSubmitRotation).toHaveBeenCalledTimes(1);
    // Only 2 inserts (sharedLinks + conversationMembers), not 3
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });
});

describe('revokeLink', () => {
  let db: ReturnType<typeof createMockDb>['db'];
  let mockSelect: ReturnType<typeof vi.fn>;
  let mockUpdate: ReturnType<typeof vi.fn>;

  const testRotationParams: SubmitRotationParams = {
    conversationId: 'conv-1',
    expectedEpoch: 1,
    epochPublicKey: new Uint8Array(32).fill(1),
    confirmationHash: new Uint8Array(32).fill(2),
    chainLink: new Uint8Array(32).fill(3),
    memberWraps: [
      {
        memberPublicKey: new Uint8Array(32).fill(4),
        wrap: new Uint8Array(48).fill(5),
      },
    ],
    encryptedTitle: new Uint8Array(64).fill(6),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    const mocks = createMockDb();
    db = mocks.db;
    mockSelect = mocks.mockSelect;
    mockUpdate = mocks.mockUpdate;
  });

  it('revokes link and calls submitRotation', async () => {
    mockUpdateChainReturning(mockUpdate, [
      { id: 'link-1', conversationId: 'conv-1', revokedAt: null },
    ]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'member-1', linkId: 'link-1', leftAt: null }]);
    mockUpdateChain(mockUpdate);

    const result = await revokeLink(db as never, 'link-1', 'conv-1', testRotationParams);

    expect(result.revoked).toBe(true);
    expect(result.memberId).toBe('member-1');
    expect(mockSubmitRotation).toHaveBeenCalledTimes(1);
    expect(mockSubmitRotation).toHaveBeenCalledWith(db, testRotationParams);
  });

  it('returns { revoked: false, memberId: null } when link not found', async () => {
    mockUpdateChainReturning(mockUpdate, []);

    const result = await revokeLink(db as never, 'nonexistent', 'conv-1', testRotationParams);

    expect(result).toEqual({ revoked: false, memberId: null });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockSubmitRotation).not.toHaveBeenCalled();
  });

  it('returns { revoked: false, memberId: null } when link already revoked', async () => {
    // Atomic UPDATE returns empty — revokedAt IS NULL condition fails for already-revoked link
    mockUpdateChainReturning(mockUpdate, []);

    const result = await revokeLink(db as never, 'link-revoked', 'conv-1', testRotationParams);

    expect(result).toEqual({ revoked: false, memberId: null });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockSubmitRotation).not.toHaveBeenCalled();
  });

  it('returns { revoked: true, memberId: null } when link has no active member', async () => {
    mockUpdateChainReturning(mockUpdate, [{ id: 'link-orphan' }]);
    mockSelectChainNoOrder(mockSelect, []);

    const result = await revokeLink(db as never, 'link-orphan', 'conv-1', testRotationParams);

    expect(result).toEqual({ revoked: true, memberId: null });
    expect(mockSubmitRotation).not.toHaveBeenCalled();
  });

  it('propagates StaleEpochError from submitRotation', async () => {
    mockUpdateChainReturning(mockUpdate, [
      { id: 'link-1', conversationId: 'conv-1', revokedAt: null },
    ]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'member-1', linkId: 'link-1', leftAt: null }]);
    mockUpdateChain(mockUpdate);

    mockSubmitRotation.mockRejectedValueOnce(new StaleEpochError(2));

    await expect(revokeLink(db as never, 'link-1', 'conv-1', testRotationParams)).rejects.toThrow(
      'Stale epoch'
    );
  });

  it('uses transaction for atomic revocation', async () => {
    mockUpdateChainReturning(mockUpdate, [
      { id: 'link-tx', conversationId: 'conv-1', revokedAt: null },
    ]);
    mockSelectChainNoOrder(mockSelect, [{ id: 'member-tx', linkId: 'link-tx', leftAt: null }]);
    mockUpdateChain(mockUpdate);

    await revokeLink(db as never, 'link-tx', 'conv-1', testRotationParams);

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('changeLinkPrivilege', () => {
  let db: ReturnType<typeof createMockDb>['db'];
  let mockSelect: ReturnType<typeof vi.fn>;
  let mockUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mocks = createMockDb();
    db = mocks.db;
    mockSelect = mocks.mockSelect;
    mockUpdate = mocks.mockUpdate;
  });

  it('updates conversationMembers privilege when link exists', async () => {
    mockSelectChainWithLimit(mockSelect, [{ id: 'link-1' }]);
    mockUpdateChainReturning(mockUpdate, [{ id: 'member-1' }]);

    const result = await changeLinkPrivilege(db as never, {
      conversationId: 'conv-1',
      linkId: 'link-1',
      privilege: 'write',
    });

    expect(result).toEqual({ changed: true, memberId: 'member-1' });
  });

  it('returns { changed: false, memberId: null } when link not found', async () => {
    mockSelectChainWithLimit(mockSelect, []);

    const result = await changeLinkPrivilege(db as never, {
      conversationId: 'conv-1',
      linkId: 'nonexistent',
      privilege: 'write',
    });

    expect(result).toEqual({ changed: false, memberId: null });
  });

  it('returns { changed: true, memberId: null } when link has no active member', async () => {
    mockSelectChainWithLimit(mockSelect, [{ id: 'link-orphan' }]);
    mockUpdateChainReturning(mockUpdate, []);

    const result = await changeLinkPrivilege(db as never, {
      conversationId: 'conv-1',
      linkId: 'link-orphan',
      privilege: 'read',
    });

    expect(result).toEqual({ changed: true, memberId: null });
  });
});
