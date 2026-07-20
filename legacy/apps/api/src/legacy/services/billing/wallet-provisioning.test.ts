import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ensureWalletsExist } from './wallet-provisioning';

/**
 * Mock DB builder chain factory.
 * Follows the same pattern as transaction-writer.test.ts.
 */
function createMockDb() {
  const mockInsert = vi.fn();

  const db = {
    insert: mockInsert,
  };

  return { db, mockInsert };
}

/**
 * Helper to set up an insert chain with ON CONFLICT DO NOTHING + returning.
 * Pattern: db.insert(table).values({...}).onConflictDoNothing({...}).returning() -> rows
 */
function mockInsertOnConflictChain(
  mockInsert: ReturnType<typeof vi.fn>,
  rows: unknown[]
): { valuesSpy: ReturnType<typeof vi.fn> } {
  const valuesSpy = vi.fn();
  mockInsert.mockReturnValueOnce({
    values: valuesSpy.mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
  return { valuesSpy };
}

/**
 * Helper for ledger entry inserts (no onConflictDoNothing).
 * Pattern: db.insert(table).values({...}).returning() -> rows
 */
function mockInsertChain(mockInsert: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockInsert.mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  });
}

describe('wallet-provisioning', () => {
  describe('ensureWalletsExist', () => {
    let db: ReturnType<typeof createMockDb>['db'];
    let mockInsert: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const mocks = createMockDb();
      db = mocks.db;
      mockInsert = mocks.mockInsert;
    });

    it('creates both purchased and free_tier wallets for a new user', async () => {
      // Purchased wallet insert - returns new wallet (was created)
      const { valuesSpy: purchasedValuesSpy } = mockInsertOnConflictChain(mockInsert, [
        { id: 'wallet-purchased' },
      ]);
      // Purchased wallet ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-purchased' }]);
      // Free tier wallet insert - returns new wallet (was created)
      const { valuesSpy: freeValuesSpy } = mockInsertOnConflictChain(mockInsert, [
        { id: 'wallet-free' },
      ]);
      // Free tier wallet ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-free' }]);

      await ensureWalletsExist(db as never, 'user-123');

      // Verify wallet values
      const purchasedValues = purchasedValuesSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(purchasedValues).toMatchObject({
        userId: 'user-123',
        type: 'purchased',
        priority: 0,
      });

      const freeValues = freeValuesSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(freeValues).toMatchObject({
        userId: 'user-123',
        type: 'free_tier',
        priority: 1,
      });
    });

    it('sets correct balances from shared constants', async () => {
      const { valuesSpy: purchasedValuesSpy } = mockInsertOnConflictChain(mockInsert, [
        { id: 'wallet-purchased' },
      ]);
      mockInsertChain(mockInsert, [{ id: 'ledger-purchased' }]);
      const { valuesSpy: freeValuesSpy } = mockInsertOnConflictChain(mockInsert, [
        { id: 'wallet-free' },
      ]);
      mockInsertChain(mockInsert, [{ id: 'ledger-free' }]);

      await ensureWalletsExist(db as never, 'user-123');

      const purchasedValues = purchasedValuesSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(purchasedValues['balance']).toBe('0.20000000');

      const freeValues = freeValuesSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(freeValues['balance']).toBe('0.05000000');
    });

    it('creates welcome_credit ledger entries for newly created wallets', async () => {
      // Both wallets newly created
      mockInsertOnConflictChain(mockInsert, [{ id: 'wallet-purchased' }]);
      mockInsertChain(mockInsert, [{ id: 'ledger-purchased' }]);
      mockInsertOnConflictChain(mockInsert, [{ id: 'wallet-free' }]);
      mockInsertChain(mockInsert, [{ id: 'ledger-free' }]);

      await ensureWalletsExist(db as never, 'user-123');

      // 4 inserts total: 2 wallets + 2 ledger entries
      expect(mockInsert).toHaveBeenCalledTimes(4);
    });

    it('is idempotent - skips ledger entries when wallets already exist', async () => {
      // Both wallets already exist (ON CONFLICT DO NOTHING returns empty)
      mockInsertOnConflictChain(mockInsert, []);
      mockInsertOnConflictChain(mockInsert, []);

      await ensureWalletsExist(db as never, 'user-123');

      // Only 2 inserts: wallet attempts only, no ledger entries
      expect(mockInsert).toHaveBeenCalledTimes(2);
    });

    it('creates ledger entry only for newly created wallet when one already exists', async () => {
      // Purchased wallet already exists
      mockInsertOnConflictChain(mockInsert, []);
      // Free tier wallet is new
      mockInsertOnConflictChain(mockInsert, [{ id: 'wallet-free' }]);
      mockInsertChain(mockInsert, [{ id: 'ledger-free' }]);

      await ensureWalletsExist(db as never, 'user-123');

      // 3 inserts: 2 wallet attempts + 1 ledger entry for the new wallet
      expect(mockInsert).toHaveBeenCalledTimes(3);
    });
  });
});
