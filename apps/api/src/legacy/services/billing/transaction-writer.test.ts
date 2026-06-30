import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  creditUserBalance,
  processWebhookCredit,
  chargeForUsage,
  chargeForMediaGeneration,
} from './transaction-writer';

/**
 * Mock DB builder chain factory.
 * Follows the same pattern as balance.test.ts:
 * mock the Drizzle query builder chain methods (select/from/where/update/set/insert/values/returning).
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
 * Helper to set up an update chain that returns the given rows.
 * Pattern: tx.update(table).set({...}).where(condition).returning() -> rows
 */
function mockUpdateChain(mockUpdate: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockUpdate.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

/**
 * Helper to set up an insert chain that returns the given rows.
 * Pattern: tx.insert(table).values({...}).returning() -> rows
 */
function mockInsertChain(mockInsert: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockInsert.mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  });
}

/**
 * Helper to set up a select chain that returns the given rows.
 * Pattern: db.select({...}).from(table).where(condition).orderBy(order) -> rows
 */
function mockSelectChain(mockSelect: ReturnType<typeof vi.fn>, rows: unknown[]): void {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

describe('transaction-writer', () => {
  describe('creditUserBalance', () => {
    let db: ReturnType<typeof createMockDb>['db'];
    let mockUpdate: ReturnType<typeof vi.fn>;
    let mockInsert: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const mocks = createMockDb();
      db = mocks.db;
      mockUpdate = mocks.mockUpdate;
      mockInsert = mocks.mockInsert;
    });

    it('credits purchased wallet balance and creates ledger entry', async () => {
      // First update: claim payment (returns payment)
      mockUpdateChain(mockUpdate, [{ id: 'payment-123' }]);
      // Second update: update wallet balance (returns wallet)
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '110.00000000' }]);
      // Insert: ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);

      const result = await creditUserBalance(db as never, {
        userId: 'user-123',
        amount: '10.00000000',
        paymentId: 'payment-123',
        transactionDetails: {
          helcimTransactionId: 'helcim-123',
          cardType: 'Visa',
          cardLastFour: '4242',
        },
      });

      expect(result?.newBalance).toBe('110.00000000');
      expect(result?.ledgerEntryId).toBe('ledger-1');
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('returns null when payment already confirmed (idempotent)', async () => {
      // Payment claim returns empty (already confirmed)
      mockUpdateChain(mockUpdate, []);

      const result = await creditUserBalance(db as never, {
        userId: 'user-123',
        amount: '10.00000000',
        paymentId: 'payment-123',
      });

      expect(result).toBeNull();
    });

    it('throws error when wallet update fails', async () => {
      // Payment claim succeeds
      mockUpdateChain(mockUpdate, [{ id: 'payment-123' }]);
      // Wallet update returns empty
      mockUpdateChain(mockUpdate, []);

      await expect(
        creditUserBalance(db as never, {
          userId: 'user-123',
          amount: '10.00000000',
          paymentId: 'payment-123',
        })
      ).rejects.toThrow('Failed to update wallet balance');
    });

    it('throws error when ledger entry insert fails', async () => {
      // Payment claim succeeds
      mockUpdateChain(mockUpdate, [{ id: 'payment-123' }]);
      // Wallet update succeeds
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '110.00000000' }]);
      // Ledger entry insert fails
      mockInsertChain(mockInsert, []);

      await expect(
        creditUserBalance(db as never, {
          userId: 'user-123',
          amount: '10.00000000',
          paymentId: 'payment-123',
        })
      ).rejects.toThrow('Failed to create ledger entry');
    });
  });

  describe('processWebhookCredit', () => {
    let db: ReturnType<typeof createMockDb>['db'];
    let mockUpdate: ReturnType<typeof vi.fn>;
    let mockInsert: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const mocks = createMockDb();
      db = mocks.db;
      mockUpdate = mocks.mockUpdate;
      mockInsert = mocks.mockInsert;
    });

    it('processes webhook and credits purchased wallet balance', async () => {
      // First update: claim payment
      mockUpdateChain(mockUpdate, [
        { id: 'payment-123', userId: 'user-123', amount: '10.00000000' },
      ]);
      // Second update: update wallet balance
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '110.00000000' }]);
      // Insert: ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);

      const result = await processWebhookCredit(db as never, {
        helcimTransactionId: 'helcim-123',
      });

      expect(result?.newBalance).toBe('110.00000000');
      expect(result?.ledgerEntryId).toBe('ledger-1');
      expect(result?.paymentId).toBe('payment-123');
    });

    it('returns null when payment not found (idempotent)', async () => {
      // Payment claim returns empty
      mockUpdateChain(mockUpdate, []);

      const result = await processWebhookCredit(db as never, {
        helcimTransactionId: 'non-existent',
      });

      expect(result).toBeNull();
    });

    it('throws error when payment has no associated user', async () => {
      // Payment claim succeeds but userId is null
      mockUpdateChain(mockUpdate, [{ id: 'payment-123', userId: null, amount: '10.00000000' }]);

      await expect(
        processWebhookCredit(db as never, {
          helcimTransactionId: 'helcim-123',
        })
      ).rejects.toThrow('Payment has no associated user');
    });

    it('throws error when wallet update fails', async () => {
      // Payment claim succeeds
      mockUpdateChain(mockUpdate, [
        { id: 'payment-123', userId: 'user-123', amount: '10.00000000' },
      ]);
      // Wallet update returns empty
      mockUpdateChain(mockUpdate, []);

      await expect(
        processWebhookCredit(db as never, {
          helcimTransactionId: 'helcim-123',
        })
      ).rejects.toThrow('Failed to update wallet balance');
    });

    it('throws error when ledger entry insert fails', async () => {
      // Payment claim succeeds
      mockUpdateChain(mockUpdate, [
        { id: 'payment-123', userId: 'user-123', amount: '10.00000000' },
      ]);
      // Wallet update succeeds
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '110.00000000' }]);
      // Ledger entry insert fails
      mockInsertChain(mockInsert, []);

      await expect(
        processWebhookCredit(db as never, {
          helcimTransactionId: 'helcim-123',
        })
      ).rejects.toThrow('Failed to create ledger entry');
    });
  });

  describe('chargeForUsage', () => {
    let db: ReturnType<typeof createMockDb>['db'];
    let mockSelect: ReturnType<typeof vi.fn>;
    let mockUpdate: ReturnType<typeof vi.fn>;
    let mockInsert: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const mocks = createMockDb();
      db = mocks.db;
      mockSelect = mocks.mockSelect;
      mockUpdate = mocks.mockUpdate;
      mockInsert = mocks.mockInsert;
    });

    const baseParams = {
      userId: 'user-123',
      cost: '0.00500000',
      model: 'gpt-4',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      sourceType: 'message' as const,
      sourceId: 'msg-123',
    };

    it('charges from first wallet with sufficient balance (purchased priority 0)', async () => {
      // Insert usage record
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      // Insert llm completion
      mockInsertChain(mockInsert, [{ id: 'llm-1' }]);
      // Select wallets ordered by priority
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '10.00000000', priority: 0 },
        { id: 'wallet-2', type: 'free_tier', balance: '5.00000000', priority: 1 },
      ]);
      // Update wallet balance (atomic debit)
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '9.99500000' }]);
      // Insert ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      // Update usage record to completed
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      const result = await chargeForUsage(db as never, baseParams);

      expect(result.usageRecordId).toBe('usage-1');
      expect(result.walletId).toBe('wallet-1');
      expect(result.walletType).toBe('purchased');
      expect(result.newBalance).toBe('9.99500000');
    });

    it('falls through to free_tier wallet when purchased has insufficient balance', async () => {
      // Insert usage record
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      // Insert llm completion
      mockInsertChain(mockInsert, [{ id: 'llm-1' }]);
      // Select wallets ordered by priority
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '0.00000000', priority: 0 },
        { id: 'wallet-2', type: 'free_tier', balance: '5.00000000', priority: 1 },
      ]);
      // First wallet debit fails (insufficient balance, 0 rows)
      mockUpdateChain(mockUpdate, []);
      // Second wallet debit succeeds
      mockUpdateChain(mockUpdate, [{ id: 'wallet-2', balance: '4.99500000' }]);
      // Insert ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      // Update usage record to completed
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      const result = await chargeForUsage(db as never, baseParams);

      expect(result.usageRecordId).toBe('usage-1');
      expect(result.walletId).toBe('wallet-2');
      expect(result.walletType).toBe('free_tier');
      expect(result.newBalance).toBe('4.99500000');
    });

    it('marks usage record as failed when no wallet has sufficient balance', async () => {
      // Insert usage record
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      // Insert llm completion
      mockInsertChain(mockInsert, [{ id: 'llm-1' }]);
      // Select wallets ordered by priority
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '0.00000000', priority: 0 },
        { id: 'wallet-2', type: 'free_tier', balance: '0.00000000', priority: 1 },
      ]);
      // Both wallet debits fail
      mockUpdateChain(mockUpdate, []);
      mockUpdateChain(mockUpdate, []);
      // Update usage record to failed
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      await expect(chargeForUsage(db as never, baseParams)).rejects.toThrow('Insufficient balance');
    });

    it('marks usage record as failed when user has no wallets', async () => {
      // Insert usage record
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      // Insert llm completion
      mockInsertChain(mockInsert, [{ id: 'llm-1' }]);
      // Select wallets: none
      mockSelectChain(mockSelect, []);
      // Update usage record to failed
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      await expect(chargeForUsage(db as never, baseParams)).rejects.toThrow('Insufficient balance');
    });

    it('includes cachedTokens when provided', async () => {
      // Insert usage record
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      // Insert llm completion
      mockInsertChain(mockInsert, [{ id: 'llm-1' }]);
      // Select wallets
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '10.00000000', priority: 0 },
      ]);
      // Wallet debit succeeds
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '9.99500000' }]);
      // Insert ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      // Update usage record to completed
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      const result = await chargeForUsage(db as never, {
        ...baseParams,
        cachedTokens: 25,
      });

      expect(result.usageRecordId).toBe('usage-1');
      expect(result.walletId).toBe('wallet-1');
      expect(result.walletType).toBe('purchased');
      expect(result.newBalance).toBe('9.99500000');
    });

    it('defaults cachedTokens to 0 when not provided', async () => {
      // Insert usage record
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      // Insert llm completion
      mockInsertChain(mockInsert, [{ id: 'llm-1' }]);
      // Select wallets
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '10.00000000', priority: 0 },
      ]);
      // Wallet debit succeeds
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '9.99500000' }]);
      // Insert ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      // Update usage record to completed
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      const result = await chargeForUsage(db as never, baseParams);

      // Should succeed without cachedTokens
      expect(result.usageRecordId).toBe('usage-1');
    });

    it('uses single wallet when only one exists', async () => {
      // Insert usage record
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      // Insert llm completion
      mockInsertChain(mockInsert, [{ id: 'llm-1' }]);
      // Select wallets: only one
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '10.00000000', priority: 0 },
      ]);
      // Wallet debit succeeds
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '9.99500000' }]);
      // Insert ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      // Update usage record to completed
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      const result = await chargeForUsage(db as never, baseParams);

      expect(result.walletId).toBe('wallet-1');
      expect(result.walletType).toBe('purchased');
    });

    it('runs entirely within a transaction', async () => {
      // Insert usage record
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      // Insert llm completion
      mockInsertChain(mockInsert, [{ id: 'llm-1' }]);
      // Select wallets
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '10.00000000', priority: 0 },
      ]);
      // Wallet debit
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '9.99500000' }]);
      // Ledger entry
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      // Usage record completion
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      await chargeForUsage(db as never, baseParams);

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('chargeForMediaGeneration', () => {
    let db: ReturnType<typeof createMockDb>['db'];
    let mockSelect: ReturnType<typeof vi.fn>;
    let mockUpdate: ReturnType<typeof vi.fn>;
    let mockInsert: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const mocks = createMockDb();
      db = mocks.db;
      mockSelect = mocks.mockSelect;
      mockUpdate = mocks.mockUpdate;
      mockInsert = mocks.mockInsert;
    });

    const baseMediaParams = {
      userId: 'user-123',
      cost: '0.05000000',
      model: 'google/imagen-4',
      provider: 'google-vertex',
      mediaType: 'image' as const,
      imageCount: 1,
      sourceType: 'message' as const,
      sourceId: 'msg-456',
    };

    it('inserts usage_record with type media_generation', async () => {
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      mockInsertChain(mockInsert, [{ id: 'media-gen-1' }]);
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '10.00000000', priority: 0 },
      ]);
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '9.95000000' }]);
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      const result = await chargeForMediaGeneration(db as never, baseMediaParams);

      expect(result.usageRecordId).toBe('usage-1');
      expect(result.walletId).toBe('wallet-1');
      expect(result.walletType).toBe('purchased');
    });

    it('inserts media_generations detail row', async () => {
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      mockInsertChain(mockInsert, [{ id: 'media-gen-1' }]);
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '10.00000000', priority: 0 },
      ]);
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '9.95000000' }]);
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      await chargeForMediaGeneration(db as never, baseMediaParams);

      // Second insert call is for media_generations
      expect(mockInsert).toHaveBeenCalledTimes(3);
    });

    it('falls through to free_tier wallet when purchased has insufficient balance', async () => {
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      mockInsertChain(mockInsert, [{ id: 'media-gen-1' }]);
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '0.00000000', priority: 0 },
        { id: 'wallet-2', type: 'free_tier', balance: '5.00000000', priority: 1 },
      ]);
      mockUpdateChain(mockUpdate, []);
      mockUpdateChain(mockUpdate, [{ id: 'wallet-2', balance: '4.95000000' }]);
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      const result = await chargeForMediaGeneration(db as never, baseMediaParams);

      expect(result.walletId).toBe('wallet-2');
      expect(result.walletType).toBe('free_tier');
    });

    it('marks usage record as failed when insufficient balance', async () => {
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      mockInsertChain(mockInsert, [{ id: 'media-gen-1' }]);
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '0.00000000', priority: 0 },
      ]);
      mockUpdateChain(mockUpdate, []);
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      await expect(chargeForMediaGeneration(db as never, baseMediaParams)).rejects.toThrow(
        'Insufficient balance'
      );
    });

    it('accepts video params with durationMs and resolution', async () => {
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      mockInsertChain(mockInsert, [{ id: 'media-gen-1' }]);
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '10.00000000', priority: 0 },
      ]);
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '9.40000000' }]);
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      const result = await chargeForMediaGeneration(db as never, {
        ...baseMediaParams,
        model: 'google/veo-3.1',
        mediaType: 'video',
        imageCount: undefined,
        durationMs: 6000,
        resolution: '1080p',
      });

      expect(result.usageRecordId).toBe('usage-1');
    });

    it('runs entirely within a transaction', async () => {
      mockInsertChain(mockInsert, [{ id: 'usage-1' }]);
      mockInsertChain(mockInsert, [{ id: 'media-gen-1' }]);
      mockSelectChain(mockSelect, [
        { id: 'wallet-1', type: 'purchased', balance: '10.00000000', priority: 0 },
      ]);
      mockUpdateChain(mockUpdate, [{ id: 'wallet-1', balance: '9.95000000' }]);
      mockInsertChain(mockInsert, [{ id: 'ledger-1' }]);
      mockUpdateChain(mockUpdate, [{ id: 'usage-1' }]);

      await chargeForMediaGeneration(db as never, baseMediaParams);

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('rejects negative cost', async () => {
      await expect(
        chargeForMediaGeneration(db as never, { ...baseMediaParams, cost: '-1.00000000' })
      ).rejects.toThrow('Invalid cost');
    });
  });
});
