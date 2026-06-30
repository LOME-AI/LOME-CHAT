import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRIAL_MESSAGE_LIMIT } from '@hushbox/shared';
import { consumeTrialMessage } from './trial-usage.js';

vi.mock('@hushbox/shared', async () => {
  const actual = await vi.importActual<typeof import('@hushbox/shared')>('@hushbox/shared');
  return {
    ...actual,
    secondsUntilNextUtcMidnight: vi.fn().mockReturnValue(3600),
  };
});

function createMockRedis(): {
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
} {
  return {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
  };
}

describe('trial usage service (Redis)', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  describe('consumeTrialMessage', () => {
    it('returns canSend=true for first message (incr returns 1)', async () => {
      mockRedis.incr.mockResolvedValue(1);

      const result = await consumeTrialMessage(
        mockRedis as unknown as Parameters<typeof consumeTrialMessage>[0],
        'token-abc',
        'ip-hash-123'
      );

      expect(result.canSend).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(result.limit).toBe(TRIAL_MESSAGE_LIMIT);
    });

    it('returns canSend=true for 5th message (incr returns 5)', async () => {
      mockRedis.incr.mockResolvedValue(5);

      const result = await consumeTrialMessage(
        mockRedis as unknown as Parameters<typeof consumeTrialMessage>[0],
        'token-abc',
        'ip-hash-123'
      );

      expect(result.canSend).toBe(true);
      expect(result.messageCount).toBe(5);
    });

    it('returns canSend=false for 6th message (incr returns 6)', async () => {
      mockRedis.incr.mockResolvedValue(6);

      const result = await consumeTrialMessage(
        mockRedis as unknown as Parameters<typeof consumeTrialMessage>[0],
        'token-abc',
        'ip-hash-123'
      );

      expect(result.canSend).toBe(false);
      expect(result.messageCount).toBe(6);
    });

    it('increments both token and IP keys', async () => {
      mockRedis.incr.mockResolvedValue(1);

      await consumeTrialMessage(
        mockRedis as unknown as Parameters<typeof consumeTrialMessage>[0],
        'token-abc',
        'ip-hash-123'
      );

      expect(mockRedis.incr).toHaveBeenCalledWith('trial:token:token-abc');
      expect(mockRedis.incr).toHaveBeenCalledWith('trial:ip:ip-hash-123');
    });

    it('handles null trialToken by incrementing only IP key', async () => {
      mockRedis.incr.mockResolvedValue(2);

      const result = await consumeTrialMessage(
        mockRedis as unknown as Parameters<typeof consumeTrialMessage>[0],
        null,
        'ip-hash-123'
      );

      expect(mockRedis.incr).toHaveBeenCalledTimes(1);
      expect(mockRedis.incr).toHaveBeenCalledWith('trial:ip:ip-hash-123');
      expect(result.messageCount).toBe(2);
      expect(result.canSend).toBe(true);
    });

    it('uses MAX of token and IP counts for dual-identity anti-evasion', async () => {
      mockRedis.incr
        .mockResolvedValueOnce(2) // token
        .mockResolvedValueOnce(6); // ip

      const result = await consumeTrialMessage(
        mockRedis as unknown as Parameters<typeof consumeTrialMessage>[0],
        'token-abc',
        'ip-hash-123'
      );

      expect(result.messageCount).toBe(6);
      expect(result.canSend).toBe(false);
    });

    it('sets TTL on first increment', async () => {
      mockRedis.incr.mockResolvedValue(1);

      await consumeTrialMessage(
        mockRedis as unknown as Parameters<typeof consumeTrialMessage>[0],
        'token-abc',
        'ip-hash-123'
      );

      expect(mockRedis.expire).toHaveBeenCalledWith('trial:token:token-abc', 3600);
      expect(mockRedis.expire).toHaveBeenCalledWith('trial:ip:ip-hash-123', 3600);
    });

    it('does not set TTL on subsequent increments', async () => {
      mockRedis.incr.mockResolvedValue(3);

      await consumeTrialMessage(
        mockRedis as unknown as Parameters<typeof consumeTrialMessage>[0],
        'token-abc',
        'ip-hash-123'
      );

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('propagates Redis errors instead of swallowing them', async () => {
      mockRedis.incr.mockRejectedValue(new Error('Redis connection failed'));

      await expect(
        consumeTrialMessage(
          mockRedis as unknown as Parameters<typeof consumeTrialMessage>[0],
          'token-abc',
          'ip-hash-123'
        )
      ).rejects.toThrow('Redis connection failed');
    });
  });
});
