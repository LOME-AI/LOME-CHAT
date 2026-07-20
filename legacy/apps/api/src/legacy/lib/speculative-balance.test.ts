import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  reserveBudget,
  releaseBudget,
  getReservedTotal,
  reserveGroupBudget,
  releaseGroupBudget,
  getGroupReservedTotals,
} from './speculative-balance.js';
import { REDIS_REGISTRY } from './redis-registry.js';
import type { Redis } from '@upstash/redis';

function createMockRedis(): {
  get: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn().mockResolvedValue(null),
    eval: vi.fn().mockResolvedValue('0'),
  };
}

describe('getReservedTotal', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('returns 0 when no reservation exists', async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await getReservedTotal(mockRedis as unknown as Redis, 'user-123');

    expect(result).toBe(0);
  });

  it('returns the stored reservation value', async () => {
    mockRedis.get.mockResolvedValue(15.5);

    const result = await getReservedTotal(mockRedis as unknown as Redis, 'user-123');

    expect(result).toBe(15.5);
  });

  it('reads from the correct Redis key', async () => {
    await getReservedTotal(mockRedis as unknown as Redis, 'user-456');

    expect(mockRedis.get).toHaveBeenCalledWith(
      REDIS_REGISTRY.chatReservedBalance.buildKey('user-456')
    );
  });
});

describe('reserveBudget', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('returns new total after reservation', async () => {
    mockRedis.eval.mockResolvedValue('8.5');

    const result = await reserveBudget(mockRedis as unknown as Redis, 'user-123', 8.5);

    expect(result).toBe(8.5);
  });

  it('calls eval with the correct key and positive increment', async () => {
    mockRedis.eval.mockResolvedValue('5');

    await reserveBudget(mockRedis as unknown as Redis, 'user-123', 5);

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    const [, keys, args] = mockRedis.eval.mock.calls[0] as [string, string[], string[]];
    expect(keys).toEqual([REDIS_REGISTRY.chatReservedBalance.buildKey('user-123')]);
    expect(args).toContain('5');
  });

  it('accumulates multiple reservations', async () => {
    mockRedis.eval.mockResolvedValueOnce('5');
    mockRedis.eval.mockResolvedValueOnce('13');

    const first = await reserveBudget(mockRedis as unknown as Redis, 'user-123', 5);
    const second = await reserveBudget(mockRedis as unknown as Redis, 'user-123', 8);

    expect(first).toBe(5);
    expect(second).toBe(13);
  });
});

describe('releaseBudget', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('calls eval with negative increment', async () => {
    mockRedis.eval.mockResolvedValue('0');

    await releaseBudget(mockRedis as unknown as Redis, 'user-123', 5);

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    const args = (mockRedis.eval.mock.calls[0] as [string, string[], string[]])[2];
    expect(args).toContain('-5');
  });

  it('releases from the correct Redis key', async () => {
    mockRedis.eval.mockResolvedValue('0');

    await releaseBudget(mockRedis as unknown as Redis, 'user-456', 3);

    const [, keys] = mockRedis.eval.mock.calls[0] as [string, string[], string[]];
    expect(keys).toEqual([REDIS_REGISTRY.chatReservedBalance.buildKey('user-456')]);
  });

  it('does not return a value', async () => {
    mockRedis.eval.mockResolvedValue('2');

    await expect(
      releaseBudget(mockRedis as unknown as Redis, 'user-123', 3)
    ).resolves.toBeUndefined();
  });
});

describe('reserveGroupBudget', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('returns member, conversation, and payer totals', async () => {
    mockRedis.eval
      .mockResolvedValueOnce('5')
      .mockResolvedValueOnce('10')
      .mockResolvedValueOnce('15');

    const result = await reserveGroupBudget(mockRedis as unknown as Redis, {
      conversationId: 'conv-1',
      memberId: 'member-1',
      payerId: 'owner-1',
      costCents: 5,
    });

    expect(result).toEqual({
      memberTotal: 5,
      conversationTotal: 10,
      payerTotal: 15,
    });
  });

  it('calls eval with correct keys for all three caps', async () => {
    mockRedis.eval.mockResolvedValueOnce('3').mockResolvedValueOnce('3').mockResolvedValueOnce('3');

    await reserveGroupBudget(mockRedis as unknown as Redis, {
      conversationId: 'conv-1',
      memberId: 'member-1',
      payerId: 'owner-1',
      costCents: 3,
    });

    expect(mockRedis.eval).toHaveBeenCalledTimes(3);

    const call0Keys = (mockRedis.eval.mock.calls[0] as [string, string[], string[]])[1];
    const call1Keys = (mockRedis.eval.mock.calls[1] as [string, string[], string[]])[1];
    const call2Keys = (mockRedis.eval.mock.calls[2] as [string, string[], string[]])[1];

    expect(call0Keys).toEqual([REDIS_REGISTRY.groupMemberReserved.buildKey('conv-1', 'member-1')]);
    expect(call1Keys).toEqual([REDIS_REGISTRY.conversationReserved.buildKey('conv-1')]);
    expect(call2Keys).toEqual([REDIS_REGISTRY.chatReservedBalance.buildKey('owner-1')]);
  });

  it('uses the SAME chat:reserved:{payerId} key as reserveBudget', async () => {
    mockRedis.eval.mockResolvedValueOnce('5').mockResolvedValueOnce('5').mockResolvedValueOnce('5');

    await reserveGroupBudget(mockRedis as unknown as Redis, {
      conversationId: 'conv-1',
      memberId: 'member-1',
      payerId: 'owner-1',
      costCents: 5,
    });

    const groupPayerKey = (mockRedis.eval.mock.calls[2] as [string, string[], string[]])[1][0];

    mockRedis.eval.mockClear();
    mockRedis.eval.mockResolvedValueOnce('10');

    await reserveBudget(mockRedis as unknown as Redis, 'owner-1', 5);

    const personalKey = (mockRedis.eval.mock.calls[0] as [string, string[], string[]])[1][0];

    expect(groupPayerKey).toBe(personalKey);
  });

  it('accumulates with reserveBudget on the same payer wallet key', async () => {
    // Owner reserves 5 for their own personal message
    mockRedis.eval.mockResolvedValueOnce('5');
    await reserveBudget(mockRedis as unknown as Redis, 'owner-1', 5);

    // Guest triggers group reservation for 3 more against owner's wallet
    mockRedis.eval
      .mockResolvedValueOnce('3') // member cap
      .mockResolvedValueOnce('3') // conversation cap
      .mockResolvedValueOnce('8'); // payer wallet: 5 + 3 = 8

    const result = await reserveGroupBudget(mockRedis as unknown as Redis, {
      conversationId: 'conv-1',
      memberId: 'member-1',
      payerId: 'owner-1',
      costCents: 3,
    });

    // Payer total reflects cumulative: personal (5) + group (3) = 8
    expect(result.payerTotal).toBe(8);

    // All 4 eval calls used the same payer wallet key for calls 0 and 3
    const personalKey = (mockRedis.eval.mock.calls[0] as [string, string[], string[]])[1][0];
    const groupPayerKey = (mockRedis.eval.mock.calls[3] as [string, string[], string[]])[1][0];
    expect(personalKey).toBe(groupPayerKey);
  });
});

describe('releaseGroupBudget', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('calls eval with negative increment on all three keys', async () => {
    mockRedis.eval.mockResolvedValueOnce('0').mockResolvedValueOnce('0').mockResolvedValueOnce('0');

    await releaseGroupBudget(mockRedis as unknown as Redis, {
      conversationId: 'conv-1',
      memberId: 'member-1',
      payerId: 'owner-1',
      costCents: 4,
    });

    expect(mockRedis.eval).toHaveBeenCalledTimes(3);

    for (let index = 0; index < 3; index++) {
      const args = (mockRedis.eval.mock.calls[index] as [string, string[], string[]])[2];
      expect(args).toContain('-4');
    }
  });

  it('returns undefined', async () => {
    mockRedis.eval.mockResolvedValueOnce('0').mockResolvedValueOnce('0').mockResolvedValueOnce('0');

    await expect(
      releaseGroupBudget(mockRedis as unknown as Redis, {
        conversationId: 'conv-1',
        memberId: 'member-1',
        payerId: 'owner-1',
        costCents: 4,
      })
    ).resolves.toBeUndefined();
  });
});

describe('getGroupReservedTotals', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('returns 0 for all when no reservations exist', async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await getGroupReservedTotals(
      mockRedis as unknown as Redis,
      'conv-1',
      'member-1',
      'owner-1'
    );

    expect(result).toEqual({
      memberTotal: 0,
      conversationTotal: 0,
      payerTotal: 0,
    });
  });

  it('returns stored values for each', async () => {
    mockRedis.get.mockResolvedValueOnce(7.5).mockResolvedValueOnce(12).mockResolvedValueOnce(20);

    const result = await getGroupReservedTotals(
      mockRedis as unknown as Redis,
      'conv-1',
      'member-1',
      'owner-1'
    );

    expect(result).toEqual({
      memberTotal: 7.5,
      conversationTotal: 12,
      payerTotal: 20,
    });
  });

  it('reads from correct Redis keys', async () => {
    mockRedis.get.mockResolvedValue(null);

    await getGroupReservedTotals(mockRedis as unknown as Redis, 'conv-1', 'member-1', 'owner-1');

    expect(mockRedis.get).toHaveBeenCalledTimes(3);
    expect(mockRedis.get).toHaveBeenCalledWith(
      REDIS_REGISTRY.groupMemberReserved.buildKey('conv-1', 'member-1')
    );
    expect(mockRedis.get).toHaveBeenCalledWith(
      REDIS_REGISTRY.conversationReserved.buildKey('conv-1')
    );
    expect(mockRedis.get).toHaveBeenCalledWith(
      REDIS_REGISTRY.chatReservedBalance.buildKey('owner-1')
    );
  });
});
