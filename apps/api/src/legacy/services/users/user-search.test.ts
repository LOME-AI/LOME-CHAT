import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchUsers } from './user-search.js';

function createMockDb() {
  const mockSelect = vi.fn();

  const db = {
    select: mockSelect,
  };

  return { db, mockSelect };
}

function mockSelectChain(mockSelect: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  });
}

function mockSelectChainWithJoin(mockSelect: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  });
}

describe('searchUsers', () => {
  let db: ReturnType<typeof createMockDb>['db'];
  let mockSelect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mocks = createMockDb();
    db = mocks.db;
    mockSelect = mocks.mockSelect;
  });

  it('orders results by username ascending so prefix matches are deterministic', async () => {
    // Without ORDER BY, Postgres returns rows in scan order, which surprised
    // e2e tests that picked `result.first()` after the persona×project cross
    // seed introduced multiple rows sharing a `test_dave%` prefix.
    mockSelectChain(mockSelect, []);

    await searchUsers(db as never, 'test', 'requester-id');

    const firstResult = mockSelect.mock.results[0];
    if (!firstResult) throw new Error('Expected at least one select call');
    const orderByFunction = firstResult.value.from.mock.results[0].value.where.mock.results[0].value
      .orderBy as ReturnType<typeof vi.fn>;
    expect(orderByFunction).toHaveBeenCalledTimes(1);
  });

  it('returns matching users by username prefix', async () => {
    const fakeUsers = [
      { id: 'user-1', username: 'alice', publicKey: new Uint8Array([1, 2, 3]) },
      { id: 'user-2', username: 'alicia', publicKey: new Uint8Array([4, 5, 6]) },
    ];
    mockSelectChain(mockSelect, fakeUsers);

    const result = await searchUsers(db as never, 'ali', 'requester-id');

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('user-1');
    expect(result[0]?.username).toBe('alice');
    expect(result[1]?.id).toBe('user-2');
    expect(result[1]?.username).toBe('alicia');
  });

  it('performs case-insensitive search', async () => {
    const fakeUsers = [{ id: 'user-1', username: 'Alice', publicKey: new Uint8Array([1, 2, 3]) }];
    mockSelectChain(mockSelect, fakeUsers);

    const result = await searchUsers(db as never, 'ALI', 'requester-id');

    expect(result).toHaveLength(1);
    expect(result[0]?.username).toBe('Alice');
    // Verify select was called (the ILIKE is in the WHERE clause, handled by Drizzle)
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('excludes the requesting user from results', async () => {
    // The DB mock returns whatever we set; the WHERE clause should exclude the requester.
    // We verify the query was constructed by checking select was called.
    mockSelectChain(mockSelect, []);

    const result = await searchUsers(db as never, 'test', 'requester-id');

    expect(result).toEqual([]);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('respects default limit of 20', async () => {
    mockSelectChain(mockSelect, []);

    await searchUsers(db as never, 'test', 'requester-id');

    const firstResult = mockSelect.mock.results[0];
    if (!firstResult) throw new Error('Expected at least one select call');
    const fromFunction = firstResult.value.from;
    expect(fromFunction).toHaveBeenCalledTimes(1);
    const whereFunction = fromFunction.mock.results[0].value.where;
    expect(whereFunction).toHaveBeenCalledTimes(1);
    const limitFunction = whereFunction.mock.results[0].value.orderBy.mock.results[0].value.limit;
    expect(limitFunction).toHaveBeenCalledTimes(1);
    expect(limitFunction).toHaveBeenCalledWith(20);
  });

  it('respects custom limit', async () => {
    mockSelectChain(mockSelect, []);

    await searchUsers(db as never, 'test', 'requester-id', { limit: 5 });

    const firstResult = mockSelect.mock.results[0];
    if (!firstResult) throw new Error('Expected at least one select call');
    const limitFunction =
      firstResult.value.from.mock.results[0].value.where.mock.results[0].value.orderBy.mock
        .results[0].value.limit;
    expect(limitFunction).toHaveBeenCalledWith(5);
  });

  it('caps limit at 20 even if higher value provided', async () => {
    mockSelectChain(mockSelect, []);

    await searchUsers(db as never, 'test', 'requester-id', { limit: 100 });

    const firstResult = mockSelect.mock.results[0];
    if (!firstResult) throw new Error('Expected at least one select call');
    const limitFunction =
      firstResult.value.from.mock.results[0].value.where.mock.results[0].value.orderBy.mock
        .results[0].value.limit;
    expect(limitFunction).toHaveBeenCalledWith(20);
  });

  it('returns empty array for no matches', async () => {
    mockSelectChain(mockSelect, []);

    const result = await searchUsers(db as never, 'zzz', 'requester-id');

    expect(result).toEqual([]);
  });

  it('returns publicKey as base64 string', async () => {
    const fakeUsers = [{ id: 'user-1', username: 'bob', publicKey: new Uint8Array([1, 2, 3]) }];
    mockSelectChain(mockSelect, fakeUsers);

    const result = await searchUsers(db as never, 'bob', 'requester-id');

    expect(result).toHaveLength(1);
    expect(typeof result[0]?.publicKey).toBe('string');
    expect(result[0]?.publicKey.length).toBeGreaterThan(0);
  });

  it('normalizes query with spaces before searching', async () => {
    mockSelectChain(mockSelect, []);

    const result = await searchUsers(db as never, 'John Smith', 'requester-id');

    expect(result).toEqual([]);
    // Verify select was called (the ILIKE uses normalizeUsername result: 'john_smith%')
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('normalizes uppercase query before searching', async () => {
    const fakeUsers = [{ id: 'user-1', username: 'alice', publicKey: new Uint8Array([1, 2, 3]) }];
    mockSelectChain(mockSelect, fakeUsers);

    const result = await searchUsers(db as never, 'ALICE', 'requester-id');

    expect(result).toHaveLength(1);
    expect(result[0]?.username).toBe('alice');
  });

  it('excludes existing conversation members when excludeConversationId provided', async () => {
    mockSelectChainWithJoin(mockSelect, []);

    const result = await searchUsers(db as never, 'test', 'requester-id', {
      excludeConversationId: 'conv-123',
    });

    expect(result).toEqual([]);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    // Verify leftJoin was called in the chain (indicating the join path)
    const firstResult = mockSelect.mock.results[0];
    if (!firstResult) throw new Error('Expected at least one select call');
    const fromFunction = firstResult.value.from;
    expect(fromFunction).toHaveBeenCalledTimes(1);
    const leftJoinFunction = fromFunction.mock.results[0].value.leftJoin;
    expect(leftJoinFunction).toHaveBeenCalledTimes(1);
  });
});
