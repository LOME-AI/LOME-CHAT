import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createRateLimiter,
  checkRateLimit,
  recordFailedAttempt,
  isLockedOut,
  clearLockout,
  checkDualRateLimit,
  recordDualFailedAttempt,
} from './rate-limit.js';
import { REDIS_REGISTRY } from './redis-registry.js';
import type { RateLimitConfig } from './rate-limit.js';

function createMockRedis(): {
  store: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, unknown>();
  return {
    store,
    // Upstash Redis auto-deserializes JSON, so get() returns the parsed value
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    incr: vi.fn().mockImplementation((key: string) => {
      const current = Number.parseInt((store.get(key) as string | undefined) ?? '0', 10);
      const next = current + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    }),
    del: vi.fn().mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    expire: vi.fn().mockResolvedValue(1),
  };
}

describe('rate-limit', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  describe('createRateLimiter', () => {
    it('creates a rate limiter with the given config', () => {
      const config: RateLimitConfig = {
        maxAttempts: 5,
        windowSeconds: 900, // 15 minutes
        lockoutSeconds: 900,
      };

      const limiter = createRateLimiter(config);

      expect(limiter.config).toEqual(config);
    });
  });

  describe('checkRateLimit', () => {
    it('throws error for non-rate-limit keys', async () => {
      await expect(
        checkRateLimit(
          mockRedis as unknown as Parameters<typeof checkRateLimit>[0],
          'loginLockout' as 'loginUserRateLimit',
          'test@example.com'
        )
      ).rejects.toThrow('not a rate limit key');
    });

    it('allows first request', async () => {
      const result = await checkRateLimit(
        mockRedis as unknown as Parameters<typeof checkRateLimit>[0],
        'loginUserRateLimit',
        'test@example.com'
      );

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it('tracks multiple requests within window', async () => {
      // Simulate 3 previous attempts (Upstash auto-deserializes, so store object directly)
      const key = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      mockRedis.store.set(key, { count: 3, firstAttempt: Date.now() });

      const result = await checkRateLimit(
        mockRedis as unknown as Parameters<typeof checkRateLimit>[0],
        'loginUserRateLimit',
        'test@example.com'
      );

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it('blocks when limit exceeded', async () => {
      // Simulate 5 previous attempts
      const key = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      mockRedis.store.set(key, { count: 5, firstAttempt: Date.now() });

      const result = await checkRateLimit(
        mockRedis as unknown as Parameters<typeof checkRateLimit>[0],
        'loginUserRateLimit',
        'test@example.com'
      );

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('resets after window expires', async () => {
      // Simulate 5 attempts from 20 minutes ago
      const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
      const key = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      mockRedis.store.set(key, { count: 5, firstAttempt: twentyMinutesAgo });

      const result = await checkRateLimit(
        mockRedis as unknown as Parameters<typeof checkRateLimit>[0],
        'loginUserRateLimit',
        'test@example.com'
      );

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });
  });

  describe('recordFailedAttempt', () => {
    it('throws error for non-rate-limit keys', async () => {
      await expect(
        recordFailedAttempt(
          mockRedis as unknown as Parameters<typeof recordFailedAttempt>[0],
          'loginLockout' as 'loginUserRateLimit',
          'test@example.com'
        )
      ).rejects.toThrow('not a rate limit key');
    });

    it('increments attempt count', async () => {
      const result = await recordFailedAttempt(
        mockRedis as unknown as Parameters<typeof recordFailedAttempt>[0],
        'loginUserRateLimit',
        'test@example.com'
      );

      const key = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      const stored = mockRedis.store.get(key) as { count: number } | undefined;
      expect(stored).toBeDefined();
      expect(stored?.count).toBe(1);
      expect(result.lockoutTriggered).toBe(false);
    });

    it('resets count when window expires', async () => {
      const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
      const key = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      mockRedis.store.set(key, { count: 4, firstAttempt: twentyMinutesAgo });

      const result = await recordFailedAttempt(
        mockRedis as unknown as Parameters<typeof recordFailedAttempt>[0],
        'loginUserRateLimit',
        'test@example.com'
      );

      const stored = mockRedis.store.get(key) as { count: number } | undefined;
      expect(stored).toBeDefined();
      expect(stored?.count).toBe(1);
      expect(result.lockoutTriggered).toBe(false);
    });

    it('sets lockout when max attempts reached', async () => {
      // Simulate 4 previous attempts
      const rateLimitKey = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      mockRedis.store.set(rateLimitKey, { count: 4, firstAttempt: Date.now() });

      const result = await recordFailedAttempt(
        mockRedis as unknown as Parameters<typeof recordFailedAttempt>[0],
        'loginUserRateLimit',
        'test@example.com',
        'loginLockout'
      );

      const lockoutKey = REDIS_REGISTRY.loginLockout.buildKey('test@example.com');
      const lockout = mockRedis.store.get(lockoutKey);
      expect(lockout).toBeDefined();
      expect(result.lockoutTriggered).toBe(true);
    });

    it('does not set lockout when no lockout key provided', async () => {
      const rateLimitKey = REDIS_REGISTRY.registerEmailRateLimit.buildKey('test@example.com');
      mockRedis.store.set(rateLimitKey, { count: 2, firstAttempt: Date.now() });

      const result = await recordFailedAttempt(
        mockRedis as unknown as Parameters<typeof recordFailedAttempt>[0],
        'registerEmailRateLimit',
        'test@example.com'
      );

      expect(result.lockoutTriggered).toBe(false);
    });
  });

  describe('isLockedOut', () => {
    it('returns false when no lockout exists', async () => {
      const result = await isLockedOut(
        mockRedis as unknown as Parameters<typeof isLockedOut>[0],
        'loginLockout',
        'test@example.com'
      );

      expect(result.lockedOut).toBe(false);
    });

    it('returns true when lockout exists', async () => {
      const lockoutUntil = Date.now() + 15 * 60 * 1000; // 15 minutes from now
      const key = REDIS_REGISTRY.loginLockout.buildKey('test@example.com');
      mockRedis.store.set(key, String(lockoutUntil));

      const result = await isLockedOut(
        mockRedis as unknown as Parameters<typeof isLockedOut>[0],
        'loginLockout',
        'test@example.com'
      );

      expect(result.lockedOut).toBe(true);
      if (result.lockedOut) {
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it('returns false when lockout has expired', async () => {
      const lockoutUntil = Date.now() - 1000; // 1 second ago
      const key = REDIS_REGISTRY.loginLockout.buildKey('test@example.com');
      mockRedis.store.set(key, String(lockoutUntil));

      const result = await isLockedOut(
        mockRedis as unknown as Parameters<typeof isLockedOut>[0],
        'loginLockout',
        'test@example.com'
      );

      expect(result.lockedOut).toBe(false);
    });
  });

  describe('clearLockout', () => {
    it('removes the lockout key', async () => {
      const key = REDIS_REGISTRY.loginLockout.buildKey('test@example.com');
      mockRedis.store.set(key, String(Date.now() + 900_000));

      await clearLockout(
        mockRedis as unknown as Parameters<typeof clearLockout>[0],
        'loginLockout',
        'test@example.com'
      );

      expect(mockRedis.del).toHaveBeenCalledWith(key);
    });

    it('also clears the rate limit counter', async () => {
      const lockoutKey = REDIS_REGISTRY.loginLockout.buildKey('test@example.com');
      const rateLimitKey = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      mockRedis.store.set(lockoutKey, String(Date.now() + 900_000));
      mockRedis.store.set(rateLimitKey, { count: 5, firstAttempt: Date.now() });

      await clearLockout(
        mockRedis as unknown as Parameters<typeof clearLockout>[0],
        'loginLockout',
        'test@example.com',
        'loginUserRateLimit'
      );

      expect(mockRedis.del).toHaveBeenCalledWith(lockoutKey);
      expect(mockRedis.del).toHaveBeenCalledWith(rateLimitKey);
    });
  });

  describe('checkDualRateLimit', () => {
    it('allows request when both limits have room', async () => {
      const result = await checkDualRateLimit({
        redis: mockRedis as unknown as Parameters<typeof checkDualRateLimit>[0]['redis'],
        userKeyName: 'loginUserRateLimit',
        ipKeyName: 'loginIpRateLimit',
        userIdentifier: 'test@example.com',
        ipHash: 'iphash123',
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it('blocks when email limit exceeded', async () => {
      const emailKey = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      mockRedis.store.set(emailKey, { count: 5, firstAttempt: Date.now() });

      const result = await checkDualRateLimit({
        redis: mockRedis as unknown as Parameters<typeof checkDualRateLimit>[0]['redis'],
        userKeyName: 'loginUserRateLimit',
        ipKeyName: 'loginIpRateLimit',
        userIdentifier: 'test@example.com',
        ipHash: 'iphash123',
      });

      expect(result.allowed).toBe(false);
    });

    it('blocks when IP limit exceeded', async () => {
      const ipKey = REDIS_REGISTRY.loginIpRateLimit.buildKey('iphash123');
      mockRedis.store.set(ipKey, { count: 20, firstAttempt: Date.now() });

      const result = await checkDualRateLimit({
        redis: mockRedis as unknown as Parameters<typeof checkDualRateLimit>[0]['redis'],
        userKeyName: 'loginUserRateLimit',
        ipKeyName: 'loginIpRateLimit',
        userIdentifier: 'test@example.com',
        ipHash: 'iphash123',
      });

      expect(result.allowed).toBe(false);
    });
  });

  describe('recordDualFailedAttempt', () => {
    it('records on both email and IP keys', async () => {
      const result = await recordDualFailedAttempt({
        redis: mockRedis as unknown as Parameters<typeof recordDualFailedAttempt>[0]['redis'],
        userKeyName: 'loginUserRateLimit',
        ipKeyName: 'loginIpRateLimit',
        userIdentifier: 'test@example.com',
        ipHash: 'iphash123',
      });

      const emailKey = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      const ipKey = REDIS_REGISTRY.loginIpRateLimit.buildKey('iphash123');
      const emailData = mockRedis.store.get(emailKey) as { count: number } | undefined;
      const ipData = mockRedis.store.get(ipKey) as { count: number } | undefined;

      expect(emailData?.count).toBe(1);
      expect(ipData?.count).toBe(1);
      expect(result.lockoutTriggered).toBe(false);
    });

    it('triggers lockout when email limit reached', async () => {
      const emailKey = REDIS_REGISTRY.loginUserRateLimit.buildKey('test@example.com');
      mockRedis.store.set(emailKey, { count: 4, firstAttempt: Date.now() });

      const result = await recordDualFailedAttempt({
        redis: mockRedis as unknown as Parameters<typeof recordDualFailedAttempt>[0]['redis'],
        userKeyName: 'loginUserRateLimit',
        ipKeyName: 'loginIpRateLimit',
        userIdentifier: 'test@example.com',
        ipHash: 'iphash123',
        lockoutKeyName: 'loginLockout',
      });

      const lockoutKey = REDIS_REGISTRY.loginLockout.buildKey('test@example.com');
      const lockout = mockRedis.store.get(lockoutKey);
      expect(lockout).toBeDefined();
      expect(result.lockoutTriggered).toBe(true);
    });

    it('does not trigger lockout when only IP limit reached', async () => {
      const ipKey = REDIS_REGISTRY.loginIpRateLimit.buildKey('iphash123');
      mockRedis.store.set(ipKey, { count: 19, firstAttempt: Date.now() });

      const result = await recordDualFailedAttempt({
        redis: mockRedis as unknown as Parameters<typeof recordDualFailedAttempt>[0]['redis'],
        userKeyName: 'loginUserRateLimit',
        ipKeyName: 'loginIpRateLimit',
        userIdentifier: 'test@example.com',
        ipHash: 'iphash123',
        lockoutKeyName: 'loginLockout',
      });

      expect(result.lockoutTriggered).toBe(false);
    });
  });
});
