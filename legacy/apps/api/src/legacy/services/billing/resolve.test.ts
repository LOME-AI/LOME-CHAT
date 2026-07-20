import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolveBillingInput } from '@hushbox/shared';
import type { ProcessedModels } from '@hushbox/shared/models';
import { buildBillingInput, buildGuestBillingInput } from './resolve.js';

vi.mock('./balance.js', () => ({
  getUserTierInfo: vi.fn(),
}));

vi.mock('../../lib/speculative-balance.js', () => ({
  getReservedTotal: vi.fn(),
  getGroupReservedTotals: vi.fn(),
}));

vi.mock('./budgets.js', () => ({
  getConversationBudgets: vi.fn(),
  computeGroupRemaining: vi.fn(),
}));

import { getReservedTotal, getGroupReservedTotals } from '../../lib/speculative-balance.js';
import { getUserTierInfo } from './balance.js';
import { getConversationBudgets, computeGroupRemaining } from './budgets.js';

const mockGetUserTierInfo = vi.mocked(getUserTierInfo);
const mockGetReservedTotal = vi.mocked(getReservedTotal);
const mockGetGroupReservedTotals = vi.mocked(getGroupReservedTotals);
const mockGetConversationBudgets = vi.mocked(getConversationBudgets);
const mockComputeGroupRemaining = vi.mocked(computeGroupRemaining);

let stubProcessedCatalog: Promise<ProcessedModels> = Promise.resolve({
  models: [],
  premiumIds: [],
});

const mockDb = {} as Parameters<typeof buildBillingInput>[0];
const mockRedis = {} as Parameters<typeof buildBillingInput>[1];

function setupPersonalMocks(overrides: {
  tier?: 'paid' | 'free' | 'trial' | 'guest';
  balanceCents?: number;
  freeAllowanceCents?: number;
  canAccessPremium?: boolean;
  reservedCents?: number;
  premiumIds?: string[];
}): void {
  const tier = overrides.tier ?? 'paid';
  const balanceCents = overrides.balanceCents ?? 1000;
  const freeAllowanceCents = overrides.freeAllowanceCents ?? 0;
  const canAccessPremium = overrides.canAccessPremium ?? tier === 'paid';
  const reservedCents = overrides.reservedCents ?? 0;
  const premiumIds = overrides.premiumIds ?? ['expensive/model'];

  mockGetUserTierInfo.mockResolvedValue({
    tier,
    balanceCents,
    freeAllowanceCents,
    canAccessPremium,
  });
  mockGetReservedTotal.mockResolvedValue(reservedCents);
  stubProcessedCatalog = Promise.resolve({ models: [], premiumIds });
}

describe('buildBillingInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('personal path (no memberContext)', () => {
    it('builds input for paid user with balance and non-premium model', async () => {
      setupPersonalMocks({ tier: 'paid', balanceCents: 1000, reservedCents: 200 });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
      });

      expect(result.input).toEqual<ResolveBillingInput>({
        tier: 'paid',
        balanceCents: 800, // 1000 - 200 reserved
        freeAllowanceCents: -200, // 0 - 200 reserved (unused for paid tier billing)
        isPremiumModel: false,
        estimatedMinimumCostCents: 0, // Set by caller after tier-aware computation
      });
    });

    it('subtracts Redis reservations from balance', async () => {
      setupPersonalMocks({ tier: 'paid', balanceCents: 500, reservedCents: 300 });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
      });

      expect(result.input.balanceCents).toBe(200);
    });

    it('identifies premium model from processModels premiumIds', async () => {
      setupPersonalMocks({ premiumIds: ['expensive/model'] });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['expensive/model'],
      });

      expect(result.input.isPremiumModel).toBe(true);
    });

    it('returns non-premium when model not in premiumIds', async () => {
      setupPersonalMocks({ premiumIds: ['expensive/model'] });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
      });

      expect(result.input.isPremiumModel).toBe(false);
    });

    it('includes free allowance from tier info', async () => {
      setupPersonalMocks({ tier: 'free', balanceCents: 0, freeAllowanceCents: 50 });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
      });

      expect(result.input.freeAllowanceCents).toBe(50);
    });

    it('sets estimatedMinimumCostCents to 0 (caller computes with actual tier)', async () => {
      setupPersonalMocks({});

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
      });

      expect(result.input.estimatedMinimumCostCents).toBe(0);
    });

    it('does not include group when no memberContext', async () => {
      setupPersonalMocks({});

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
      });

      expect(result.input.group).toBeUndefined();
    });
  });

  describe('group path (with memberContext)', () => {
    it('includes group data when memberContext provided', async () => {
      setupPersonalMocks({ tier: 'free', balanceCents: 0 });

      // Owner tier info (second call to getUserTierInfo)
      mockGetUserTierInfo.mockResolvedValueOnce({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 0,
        canAccessPremium: false,
      });
      // Override for owner call
      mockGetUserTierInfo.mockResolvedValueOnce({
        tier: 'paid',
        balanceCents: 5000,
        freeAllowanceCents: 0,
        canAccessPremium: true,
      });

      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 100,
      });

      mockGetConversationBudgets.mockResolvedValue({
        conversationBudget: '20.00',
        totalSpent: '5.00',
        memberBudgets: [
          {
            memberId: 'member-1',
            userId: 'user-1',
            linkId: null,
            privilege: 'write',
            budget: '10.00',
            spent: '2.00',
          },
        ],
      });

      mockComputeGroupRemaining.mockReturnValue({
        conversationRemainingCents: 1500,
        memberRemainingCents: 800,
        ownerRemainingCents: 4900,
      });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
        memberContext: { memberId: 'member-1', ownerId: 'owner-1' },
        conversationId: 'conv-1',
      });

      expect(result.input.group).toBeDefined();
      expect(result.input.group!.ownerTier).toBe('paid');
      // ownerBalanceCents should have reservations subtracted (5000 - 100 payerTotal)
      expect(result.input.group!.ownerBalanceCents).toBe(4900);
    });

    it('subtracts Redis reservations from owner balance in group input', async () => {
      setupPersonalMocks({ tier: 'free', balanceCents: 0 });

      mockGetUserTierInfo
        .mockResolvedValueOnce({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          canAccessPremium: false,
        })
        .mockResolvedValueOnce({
          tier: 'paid',
          balanceCents: 3000,
          freeAllowanceCents: 0,
          canAccessPremium: true,
        });

      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 50,
        conversationTotal: 100,
        payerTotal: 500,
      });

      mockGetConversationBudgets.mockResolvedValue({
        conversationBudget: '20.00',
        totalSpent: '0',
        memberBudgets: [
          {
            memberId: 'member-1',
            userId: 'user-1',
            linkId: null,
            privilege: 'write',
            budget: '10.00',
            spent: '0',
          },
        ],
      });

      mockComputeGroupRemaining.mockReturnValue({
        conversationRemainingCents: 1900,
        memberRemainingCents: 950,
        ownerRemainingCents: 2500,
      });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
        memberContext: { memberId: 'member-1', ownerId: 'owner-1' },
        conversationId: 'conv-1',
      });

      // input.group.ownerBalanceCents should be adjusted (3000 - 500 reserved)
      expect(result.input.group!.ownerBalanceCents).toBe(2500);
      // groupBudgetContext.ownerBalanceCents stays raw for race guard
      expect(result.groupBudgetContext!.ownerBalanceCents).toBe(3000);
    });

    it('computes effectiveCents using computeGroupRemaining + effectiveBudgetCents', async () => {
      setupPersonalMocks({ tier: 'free', balanceCents: 0 });

      mockGetUserTierInfo
        .mockResolvedValueOnce({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          canAccessPremium: false,
        })
        .mockResolvedValueOnce({
          tier: 'paid',
          balanceCents: 3000,
          freeAllowanceCents: 0,
          canAccessPremium: true,
        });

      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 0,
      });

      mockGetConversationBudgets.mockResolvedValue({
        conversationBudget: '10.00',
        totalSpent: '0',
        memberBudgets: [
          {
            memberId: 'member-1',
            userId: 'user-1',
            linkId: null,
            privilege: 'write',
            budget: '5.00',
            spent: '0',
          },
        ],
      });

      // Return values that result in effectiveCents = 500 (min of all dimensions)
      mockComputeGroupRemaining.mockReturnValue({
        conversationRemainingCents: 1000,
        memberRemainingCents: 500,
        ownerRemainingCents: 3000,
      });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
        memberContext: { memberId: 'member-1', ownerId: 'owner-1' },
        conversationId: 'conv-1',
      });

      expect(result.input.group).toBeDefined();
      // effectiveBudgetCents returns min of the three remaining dimensions
      expect(result.input.group!.effectiveCents).toBe(500);
    });

    it('defaults member budget to 0 when member not found in budgets result', async () => {
      setupPersonalMocks({ tier: 'free', balanceCents: 0 });

      mockGetUserTierInfo
        .mockResolvedValueOnce({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          canAccessPremium: false,
        })
        .mockResolvedValueOnce({
          tier: 'paid',
          balanceCents: 2000,
          freeAllowanceCents: 0,
          canAccessPremium: true,
        });

      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 0,
      });

      mockGetConversationBudgets.mockResolvedValue({
        conversationBudget: '10.00',
        totalSpent: '0',
        memberBudgets: [], // No member budget row for this member
      });

      mockComputeGroupRemaining.mockReturnValue({
        conversationRemainingCents: 1000,
        memberRemainingCents: 0, // 0 budget - 0 spent
        ownerRemainingCents: 2000,
      });

      await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
        memberContext: { memberId: 'member-1', ownerId: 'owner-1' },
        conversationId: 'conv-1',
      });

      // computeGroupRemaining should have been called with memberBudget: '0.00'
      expect(mockComputeGroupRemaining).toHaveBeenCalledWith(
        expect.objectContaining({
          memberBudget: '0.00',
          memberSpent: '0',
        })
      );
    });

    it('includes groupBudgetContext with raw budget values for race guard', async () => {
      setupPersonalMocks({ tier: 'free', balanceCents: 0 });

      mockGetUserTierInfo
        .mockResolvedValueOnce({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          canAccessPremium: false,
        })
        .mockResolvedValueOnce({
          tier: 'paid',
          balanceCents: 5000,
          freeAllowanceCents: 0,
          canAccessPremium: true,
        });

      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 100,
      });

      mockGetConversationBudgets.mockResolvedValue({
        conversationBudget: '20.00',
        totalSpent: '5.00',
        memberBudgets: [
          {
            memberId: 'member-1',
            userId: 'user-1',
            linkId: null,
            privilege: 'write',
            budget: '10.00',
            spent: '2.00',
          },
        ],
      });

      mockComputeGroupRemaining.mockReturnValue({
        conversationRemainingCents: 1500,
        memberRemainingCents: 800,
        ownerRemainingCents: 4900,
      });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
        memberContext: { memberId: 'member-1', ownerId: 'owner-1' },
        conversationId: 'conv-1',
      });

      expect(result.groupBudgetContext).toBeDefined();
      expect(result.groupBudgetContext).toEqual({
        conversationBudget: '20.00',
        conversationSpent: '5.00',
        memberBudget: '10.00',
        memberSpent: '2.00',
        ownerBalanceCents: 5000,
      });
    });

    it('includes rawUserBalanceCents (DB balance before Redis subtraction)', async () => {
      setupPersonalMocks({ tier: 'free', balanceCents: 0 });

      mockGetUserTierInfo
        .mockResolvedValueOnce({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          canAccessPremium: false,
        })
        .mockResolvedValueOnce({
          tier: 'paid',
          balanceCents: 5000,
          freeAllowanceCents: 0,
          canAccessPremium: true,
        });

      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 100,
      });

      mockGetConversationBudgets.mockResolvedValue({
        conversationBudget: '20.00',
        totalSpent: '5.00',
        memberBudgets: [
          {
            memberId: 'member-1',
            userId: 'user-1',
            linkId: null,
            privilege: 'write',
            budget: '10.00',
            spent: '2.00',
          },
        ],
      });

      mockComputeGroupRemaining.mockReturnValue({
        conversationRemainingCents: 1500,
        memberRemainingCents: 800,
        ownerRemainingCents: 4900,
      });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
        memberContext: { memberId: 'member-1', ownerId: 'owner-1' },
        conversationId: 'conv-1',
      });

      // groupBudgetContext.ownerBalanceCents is raw DB balance (5000),
      // NOT adjusted by Redis reservations
      expect(result.groupBudgetContext!.ownerBalanceCents).toBe(5000);
    });

    it('omits groupBudgetContext for personal path', async () => {
      setupPersonalMocks({ tier: 'paid', balanceCents: 1000 });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
      });

      expect(result.groupBudgetContext).toBeUndefined();
    });

    it('includes rawUserBalanceCents for personal race guard', async () => {
      setupPersonalMocks({ tier: 'paid', balanceCents: 1000, reservedCents: 300 });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
      });

      // rawUserBalanceCents is the DB balance (1000), NOT the adjusted balance (700)
      expect(result.rawUserBalanceCents).toBe(1000);
      expect(result.input.balanceCents).toBe(700); // adjusted
    });

    it('includes rawFreeAllowanceCents for free-tier race guard', async () => {
      setupPersonalMocks({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 500,
        reservedCents: 200,
      });

      const result = await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
      });

      // rawFreeAllowanceCents is the DB value (500), NOT the adjusted value (300)
      expect(result.rawFreeAllowanceCents).toBe(500);
      expect(result.input.freeAllowanceCents).toBe(300); // adjusted
    });

    it('calls getUserTierInfo twice: once for user, once for owner', async () => {
      setupPersonalMocks({ tier: 'free', balanceCents: 0 });

      mockGetUserTierInfo
        .mockResolvedValueOnce({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          canAccessPremium: false,
        })
        .mockResolvedValueOnce({
          tier: 'paid',
          balanceCents: 2000,
          freeAllowanceCents: 0,
          canAccessPremium: true,
        });

      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 0,
      });

      mockGetConversationBudgets.mockResolvedValue({
        conversationBudget: '10.00',
        totalSpent: '0',
        memberBudgets: [],
      });

      mockComputeGroupRemaining.mockReturnValue({
        conversationRemainingCents: 1000,
        memberRemainingCents: 0,
        ownerRemainingCents: 2000,
      });

      await buildBillingInput(mockDb, mockRedis, {
        processedCatalog: stubProcessedCatalog,
        userId: 'user-1',
        models: ['cheap/model'],
        memberContext: { memberId: 'member-1', ownerId: 'owner-1' },
        conversationId: 'conv-1',
      });

      expect(mockGetUserTierInfo).toHaveBeenCalledTimes(2);
      expect(mockGetUserTierInfo).toHaveBeenCalledWith(mockDb, 'user-1');
      expect(mockGetUserTierInfo).toHaveBeenCalledWith(mockDb, 'owner-1');
    });
  });
});

function setupGuestMocks(overrides: {
  ownerTier?: 'paid' | 'free';
  ownerBalanceCents?: number;
  premiumIds?: string[];
  conversationBudget?: string;
  totalSpent?: string;
  memberBudget?: string;
  memberSpent?: string;
  reserved?: { memberTotal: number; conversationTotal: number; payerTotal: number };
  groupRemaining?: {
    conversationRemainingCents: number;
    memberRemainingCents: number;
    ownerRemainingCents: number;
  };
}): void {
  const ownerTier = overrides.ownerTier ?? 'paid';
  const ownerBalanceCents = overrides.ownerBalanceCents ?? 5000;
  const premiumIds = overrides.premiumIds ?? ['expensive/model'];
  const conversationBudget = overrides.conversationBudget ?? '20.00';
  const totalSpent = overrides.totalSpent ?? '0';
  const memberBudget = overrides.memberBudget ?? '10.00';
  const memberSpent = overrides.memberSpent ?? '0';
  const reserved = overrides.reserved ?? { memberTotal: 0, conversationTotal: 0, payerTotal: 0 };
  const groupRemaining = overrides.groupRemaining ?? {
    conversationRemainingCents: 2000,
    memberRemainingCents: 1000,
    ownerRemainingCents: 5000,
  };

  mockGetUserTierInfo.mockResolvedValue({
    tier: ownerTier,
    balanceCents: ownerBalanceCents,
    freeAllowanceCents: 0,
    canAccessPremium: ownerTier === 'paid',
  });

  mockGetGroupReservedTotals.mockResolvedValue(reserved);

  mockGetConversationBudgets.mockResolvedValue({
    conversationBudget,
    totalSpent,
    memberBudgets: [
      {
        memberId: 'member-1',
        userId: null,
        linkId: 'link-1',
        privilege: 'write' as const,
        budget: memberBudget,
        spent: memberSpent,
      },
    ],
  });

  mockComputeGroupRemaining.mockReturnValue(groupRemaining);

  stubProcessedCatalog = Promise.resolve({ models: [], premiumIds });
}

describe('buildGuestBillingInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns tier guest with zero personal balance', async () => {
    setupGuestMocks({});

    const result = await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(result.input.tier).toBe('guest');
    expect(result.input.balanceCents).toBe(0);
    expect(result.input.freeAllowanceCents).toBe(0);
  });

  it('returns rawUserBalanceCents and rawFreeAllowanceCents as zero', async () => {
    setupGuestMocks({});

    const result = await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(result.rawUserBalanceCents).toBe(0);
    expect(result.rawFreeAllowanceCents).toBe(0);
  });

  it('includes group context with owner tier and budget data', async () => {
    setupGuestMocks({
      ownerTier: 'paid',
      ownerBalanceCents: 5000,
      groupRemaining: {
        conversationRemainingCents: 2000,
        memberRemainingCents: 1000,
        ownerRemainingCents: 4900,
      },
    });

    const result = await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(result.input.group).toBeDefined();
    expect(result.input.group!.ownerTier).toBe('paid');
    expect(result.input.group!.effectiveCents).toBe(1000);
  });

  it('subtracts Redis reservations from owner balance in group context', async () => {
    setupGuestMocks({
      ownerBalanceCents: 3000,
      reserved: { memberTotal: 0, conversationTotal: 0, payerTotal: 500 },
      groupRemaining: {
        conversationRemainingCents: 2000,
        memberRemainingCents: 1000,
        ownerRemainingCents: 2500,
      },
    });

    const result = await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(result.input.group!.ownerBalanceCents).toBe(2500);
  });

  it('identifies premium model from processModels premiumIds', async () => {
    setupGuestMocks({ premiumIds: ['expensive/model'] });

    const result = await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['expensive/model'],
      conversationId: 'conv-1',
    });

    expect(result.input.isPremiumModel).toBe(true);
  });

  it('returns non-premium when model not in premiumIds', async () => {
    setupGuestMocks({ premiumIds: ['expensive/model'] });

    const result = await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(result.input.isPremiumModel).toBe(false);
  });

  it('defaults member budget to 0 when member not found in budgets result', async () => {
    setupGuestMocks({});

    // Override with empty member budgets
    mockGetConversationBudgets.mockResolvedValue({
      conversationBudget: '20.00',
      totalSpent: '0',
      memberBudgets: [],
    });

    await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(mockComputeGroupRemaining).toHaveBeenCalledWith(
      expect.objectContaining({
        memberBudget: '0.00',
        memberSpent: '0',
      })
    );
  });

  it('includes groupBudgetContext with raw budget values for race guard', async () => {
    setupGuestMocks({
      ownerBalanceCents: 5000,
      conversationBudget: '20.00',
      totalSpent: '5.00',
      memberBudget: '10.00',
      memberSpent: '2.00',
      reserved: { memberTotal: 0, conversationTotal: 0, payerTotal: 100 },
    });

    const result = await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(result.groupBudgetContext).toEqual({
      conversationBudget: '20.00',
      conversationSpent: '5.00',
      memberBudget: '10.00',
      memberSpent: '2.00',
      ownerBalanceCents: 5000,
    });
  });

  it('does not call getReservedTotal (no personal reservations for guests)', async () => {
    setupGuestMocks({});

    await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(mockGetReservedTotal).not.toHaveBeenCalled();
  });

  it('calls getUserTierInfo once for owner only', async () => {
    setupGuestMocks({});

    await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(mockGetUserTierInfo).toHaveBeenCalledTimes(1);
    expect(mockGetUserTierInfo).toHaveBeenCalledWith(mockDb, 'owner-1');
  });

  it('sets estimatedMinimumCostCents to 0 (caller computes)', async () => {
    setupGuestMocks({});

    const result = await buildGuestBillingInput(mockDb, mockRedis, {
      processedCatalog: stubProcessedCatalog,
      ownerId: 'owner-1',
      memberId: 'member-1',
      models: ['cheap/model'],
      conversationId: 'conv-1',
    });

    expect(result.input.estimatedMinimumCostCents).toBe(0);
  });
});
