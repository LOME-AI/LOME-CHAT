import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FREE_ALLOWANCE_DOLLARS, FREE_ALLOWANCE_CENTS_VALUE } from '@hushbox/shared';
import { checkUserBalance, getUserTierInfo } from './balance.js';

/**
 * Mock DB builder chain factory.
 * Follows the same pattern as transaction-writer.test.ts:
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
 * Helper for the max query pattern:
 * db.select({ maxCreatedAt: max(field) }).from(table).where(and(...))
 */
function mockMaxSelectChain(mockSelect: ReturnType<typeof vi.fn>, result: unknown[]): void {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(result),
    }),
  });
}

describe('checkUserBalance', () => {
  let db: ReturnType<typeof createMockDb>['db'];
  let mockSelect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mocks = createMockDb();
    db = mocks.db;
    mockSelect = mocks.mockSelect;
  });

  /**
   * Helper: set up wallet query + renewal check (returning today = no renewal needed).
   * checkUserBalance now triggers lazy renewal when a free_tier wallet exists.
   */
  function mockWalletsWithNoRenewal(walletRows: unknown[]): void {
    // First select: wallets query
    mockSelect.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(walletRows),
      }),
    });
    // Second select: max createdAt for renewal check - today (no renewal needed)
    const hasFreeTier = (walletRows as { type: string }[]).some((w) => w.type === 'free_tier');
    if (hasFreeTier) {
      mockMaxSelectChain(mockSelect, [{ maxCreatedAt: new Date() }]);
    }
  }

  it('returns true for user with positive purchased balance', async () => {
    mockWalletsWithNoRenewal([
      { type: 'purchased', balance: '10.00000000', id: 'wallet-1' },
      { type: 'free_tier', balance: FREE_ALLOWANCE_DOLLARS, id: 'wallet-2' },
    ]);

    const result = await checkUserBalance(db as never, 'user-123');

    expect(result.hasBalance).toBe(true);
    expect(result.currentBalance).toBe('10.00000000');
  });

  it('returns true for user with zero purchased balance but positive free allowance', async () => {
    mockWalletsWithNoRenewal([
      { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
      { type: 'free_tier', balance: FREE_ALLOWANCE_DOLLARS, id: 'wallet-2' },
    ]);

    const result = await checkUserBalance(db as never, 'user-123');

    expect(result.hasBalance).toBe(true);
    expect(result.currentBalance).toBe('0.00000000');
  });

  it('returns false for user with zero balance and zero free allowance', async () => {
    mockWalletsWithNoRenewal([
      { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
      { type: 'free_tier', balance: '0.00000000', id: 'wallet-2' },
    ]);

    const result = await checkUserBalance(db as never, 'user-123');

    expect(result.hasBalance).toBe(false);
    expect(result.currentBalance).toBe('0.00000000');
  });

  it('returns false for user with negative balance and zero free allowance', async () => {
    mockWalletsWithNoRenewal([
      { type: 'purchased', balance: '-5.00000000', id: 'wallet-1' },
      { type: 'free_tier', balance: '0.00000000', id: 'wallet-2' },
    ]);

    const result = await checkUserBalance(db as never, 'user-123');

    expect(result.hasBalance).toBe(false);
    expect(result.currentBalance).toBe('-5.00000000');
  });

  it('returns false and zero balance for user with no wallets', async () => {
    mockWalletsWithNoRenewal([]);

    const result = await checkUserBalance(db as never, 'non-existent-user-id');

    expect(result.hasBalance).toBe(false);
    expect(result.currentBalance).toBe('0.00000000');
  });

  it('handles very small positive purchased balance', async () => {
    mockWalletsWithNoRenewal([
      { type: 'purchased', balance: '0.00000001', id: 'wallet-1' },
      { type: 'free_tier', balance: '0.00000000', id: 'wallet-2' },
    ]);

    const result = await checkUserBalance(db as never, 'user-123');

    expect(result.hasBalance).toBe(true);
    expect(result.currentBalance).toBe('0.00000001');
  });

  it('handles large balance', async () => {
    mockWalletsWithNoRenewal([
      { type: 'purchased', balance: '999999.99999999', id: 'wallet-1' },
      { type: 'free_tier', balance: FREE_ALLOWANCE_DOLLARS, id: 'wallet-2' },
    ]);

    const result = await checkUserBalance(db as never, 'user-123');

    expect(result.hasBalance).toBe(true);
    expect(result.currentBalance).toBe('999999.99999999');
  });

  it('triggers free tier renewal when stale', async () => {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);

    const mocks = createMockDb();
    const localDb = mocks.db;

    // First select: wallets query
    mocks.mockSelect.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
          { type: 'free_tier', balance: '0.00000000', id: 'wallet-2' },
        ]),
      }),
    });

    // Second select: max renewal createdAt - yesterday
    mockMaxSelectChain(mocks.mockSelect, [{ maxCreatedAt: yesterday }]);

    // Update: atomic conditional wallet update
    mocks.mockUpdate.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([{ id: 'wallet-2', balance: FREE_ALLOWANCE_DOLLARS }]),
        }),
      }),
    });

    // Insert: ledger entry
    mocks.mockInsert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'ledger-1' }]),
      }),
    });

    const result = await checkUserBalance(localDb as never, 'user-123');

    expect(result.hasBalance).toBe(true);
    expect(mocks.mockUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.mockInsert).toHaveBeenCalledTimes(1);
  });

  it('sums multiple purchased wallets', async () => {
    mockWalletsWithNoRenewal([
      { type: 'purchased', balance: '5.00000000', id: 'wallet-1' },
      { type: 'purchased', balance: '3.00000000', id: 'wallet-2' },
      { type: 'free_tier', balance: '0.00000000', id: 'wallet-3' },
    ]);

    const result = await checkUserBalance(db as never, 'user-123');

    expect(result.hasBalance).toBe(true);
    expect(result.currentBalance).toBe('8.00000000');
  });
});

describe('getUserTierInfo', () => {
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

  it('returns trial tier for null userId', async () => {
    const result = await getUserTierInfo(db as never, null);

    expect(result.tier).toBe('trial');
    expect(result.canAccessPremium).toBe(false);
    expect(result.balanceCents).toBe(0);
    expect(result.freeAllowanceCents).toBe(0);
  });

  it('returns paid tier for user with positive purchased balance', async () => {
    // First select: wallets query
    mockSelect.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { type: 'purchased', balance: '10.00000000', id: 'wallet-1' },
          { type: 'free_tier', balance: FREE_ALLOWANCE_DOLLARS, id: 'wallet-2' },
        ]),
      }),
    });

    // Second select: max createdAt for renewal check (not needed for purchased but needed for free_tier)
    mockMaxSelectChain(mockSelect, [{ maxCreatedAt: new Date() }]);

    const result = await getUserTierInfo(db as never, 'user-123');

    expect(result.tier).toBe('paid');
    expect(result.canAccessPremium).toBe(true);
    expect(result.balanceCents).toBe(1000); // $10 = 1000 cents
  });

  it('returns free tier for user with zero purchased balance', async () => {
    // First select: wallets query
    mockSelect.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
          { type: 'free_tier', balance: FREE_ALLOWANCE_DOLLARS, id: 'wallet-2' },
        ]),
      }),
    });

    // Second select: renewal check - last renewal is today (no renewal needed)
    mockMaxSelectChain(mockSelect, [{ maxCreatedAt: new Date() }]);

    const result = await getUserTierInfo(db as never, 'user-123');

    expect(result.tier).toBe('free');
    expect(result.canAccessPremium).toBe(false);
    expect(result.balanceCents).toBe(0);
    expect(result.freeAllowanceCents).toBe(FREE_ALLOWANCE_CENTS_VALUE);
  });

  it('includes free allowance in tier info', async () => {
    mockSelect.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
          { type: 'free_tier', balance: '0.03000000', id: 'wallet-2' },
        ]),
      }),
    });

    // Renewal check: already renewed today
    mockMaxSelectChain(mockSelect, [{ maxCreatedAt: new Date() }]);

    const result = await getUserTierInfo(db as never, 'user-123');

    expect(result.freeAllowanceCents).toBe(3);
  });

  it('returns free tier when user has no wallets', async () => {
    mockSelect.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await getUserTierInfo(db as never, 'user-123');

    expect(result.tier).toBe('free');
    expect(result.canAccessPremium).toBe(false);
    expect(result.balanceCents).toBe(0);
    expect(result.freeAllowanceCents).toBe(0);
  });

  describe('lazy renewal of free allowance', () => {
    it('renews free allowance when last renewal is before today UTC midnight', async () => {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      yesterday.setUTCHours(0, 0, 0, 0);

      // First select: wallets query
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
            { type: 'free_tier', balance: '0.02000000', id: 'wallet-2' },
          ]),
        }),
      });

      // Second select: max renewal createdAt - yesterday
      mockMaxSelectChain(mockSelect, [{ maxCreatedAt: yesterday }]);

      // Update: atomic conditional wallet update (returns updated row)
      mockUpdate.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValue([{ id: 'wallet-2', balance: FREE_ALLOWANCE_DOLLARS }]),
          }),
        }),
      });

      // Insert: ledger entry for renewal
      mockInsert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'ledger-1' }]),
        }),
      });

      const result = await getUserTierInfo(db as never, 'user-123');

      // After renewal, free allowance should be full
      expect(result.freeAllowanceCents).toBe(FREE_ALLOWANCE_CENTS_VALUE);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });

    it('does not renew if already renewed today', async () => {
      const now = new Date();

      // First select: wallets query
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
            { type: 'free_tier', balance: '0.02000000', id: 'wallet-2' },
          ]),
        }),
      });

      // Second select: max renewal createdAt - today
      mockMaxSelectChain(mockSelect, [{ maxCreatedAt: now }]);

      const result = await getUserTierInfo(db as never, 'user-123');

      // Should NOT be renewed - still has partial allowance
      expect(result.freeAllowanceCents).toBe(2);
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('renews if no renewal exists (first time)', async () => {
      // First select: wallets query
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
            { type: 'free_tier', balance: '0.03000000', id: 'wallet-2' },
          ]),
        }),
      });

      // Second select: no renewal exists
      mockMaxSelectChain(mockSelect, [{ maxCreatedAt: null }]);

      // Update: atomic conditional wallet update
      mockUpdate.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValue([{ id: 'wallet-2', balance: FREE_ALLOWANCE_DOLLARS }]),
          }),
        }),
      });

      // Insert: ledger entry
      mockInsert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'ledger-1' }]),
        }),
      });

      const result = await getUserTierInfo(db as never, 'user-123');

      expect(result.freeAllowanceCents).toBe(FREE_ALLOWANCE_CENTS_VALUE);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });

    it('does not renew for new user with welcome_credit on same day', async () => {
      // A brand-new user who signed up today has a welcome_credit entry but no renewal entry.
      // The welcome_credit should count as the initial provisioning marker — no renewal today.
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
            { type: 'free_tier', balance: '0.04000000', id: 'wallet-2' },
          ]),
        }),
      });

      // Second select: welcome_credit entry from today (no renewal entries, but welcome_credit counts)
      mockMaxSelectChain(mockSelect, [{ maxCreatedAt: new Date() }]);

      const result = await getUserTierInfo(db as never, 'user-123');

      // Should NOT be renewed — welcome_credit from today prevents renewal
      expect(result.freeAllowanceCents).toBe(4);
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('handles idempotent renewal when race condition prevents update', async () => {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      yesterday.setUTCHours(0, 0, 0, 0);

      // First select: wallets query - balance already at max (another request renewed first)
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { type: 'purchased', balance: '0.00000000', id: 'wallet-1' },
            { type: 'free_tier', balance: FREE_ALLOWANCE_DOLLARS, id: 'wallet-2' },
          ]),
        }),
      });

      // Second select: renewal check shows yesterday
      mockMaxSelectChain(mockSelect, [{ maxCreatedAt: yesterday }]);

      // Update: WHERE balance < FREE_ALLOWANCE_DOLLARS returns 0 rows (already at max)
      mockUpdate.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await getUserTierInfo(db as never, 'user-123');

      // Should still return correct values even though update was no-op
      expect(result.freeAllowanceCents).toBe(FREE_ALLOWANCE_CENTS_VALUE);
      // No insert should happen since update returned 0 rows
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('sums multiple purchased wallets correctly for tier determination', async () => {
      // First select: wallets query - multiple purchased wallets
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { type: 'purchased', balance: '5.00000000', id: 'wallet-1' },
            { type: 'purchased', balance: '3.00000000', id: 'wallet-2' },
            { type: 'free_tier', balance: FREE_ALLOWANCE_DOLLARS, id: 'wallet-3' },
          ]),
        }),
      });

      // Second select: renewal check - today
      mockMaxSelectChain(mockSelect, [{ maxCreatedAt: new Date() }]);

      const result = await getUserTierInfo(db as never, 'user-123');

      expect(result.tier).toBe('paid');
      expect(result.balanceCents).toBe(800); // $5 + $3 = $8 = 800 cents
    });

    it('converts balance from dollars to cents correctly', async () => {
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { type: 'purchased', balance: '0.20000000', id: 'wallet-1' },
            { type: 'free_tier', balance: FREE_ALLOWANCE_DOLLARS, id: 'wallet-2' },
          ]),
        }),
      });

      mockMaxSelectChain(mockSelect, [{ maxCreatedAt: new Date() }]);

      const result = await getUserTierInfo(db as never, 'user-123');

      expect(result.tier).toBe('paid');
      expect(result.balanceCents).toBe(20); // $0.20 = 20 cents
    });
  });
});
