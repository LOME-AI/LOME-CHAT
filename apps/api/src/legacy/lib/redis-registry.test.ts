import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

import {
  REDIS_REGISTRY,
  redisGet,
  redisSet,
  redisDel,
  redisIncrByFloat,
  defineKey,
} from './redis-registry.js';

function createMockRedis(): {
  store: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn().mockImplementation((...keys: string[]) => {
      for (const key of keys) {
        store.delete(key);
      }
      return Promise.resolve(keys.length);
    }),
    scan: vi.fn().mockResolvedValue([0, []]),
    eval: vi.fn().mockResolvedValue('0'),
  };
}

describe('redis-registry', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  describe('defineKey', () => {
    it('returns the entry with schema, ttl, and buildKey', () => {
      const entry = defineKey({
        schema: z.object({ count: z.number() }),
        ttl: 300,
        buildKey: (id: string) => `test:${id}`,
      });

      expect(entry.ttl).toBe(300);
      expect(entry.buildKey('abc')).toBe('test:abc');
      expect(entry.schema.parse({ count: 5 })).toEqual({ count: 5 });
    });

    it('requires ttl to be a positive number', () => {
      const entry = defineKey({
        schema: z.string(),
        ttl: 60,
        buildKey: () => 'static-key',
      });

      expect(entry.ttl).toBe(60);
    });
  });

  describe('REDIS_REGISTRY', () => {
    it('has all rate limit keys defined', () => {
      expect(REDIS_REGISTRY.loginUserRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.loginIpRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.registerEmailRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.registerIpRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.twoFactorUserRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.recoveryUserRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.recoveryIpRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.verifyTokenRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.verifyIpRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.resendVerifyEmailRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.resendVerifyIpRateLimit).toBeDefined();
    });

    it('has cost-amplification rate limit keys for chat/media/share endpoints', () => {
      // chat streaming — per-user cap on AI gateway calls
      expect(REDIS_REGISTRY.chatStreamUserRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.chatStreamUserRateLimit.rateLimitConfig.maxAttempts).toBe(30);
      expect(REDIS_REGISTRY.chatStreamUserRateLimit.rateLimitConfig.windowSeconds).toBe(60);

      // media presign — per-user cap on download URL minting
      expect(REDIS_REGISTRY.mediaDownloadUserRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.mediaDownloadUserRateLimit.rateLimitConfig.maxAttempts).toBe(60);
      expect(REDIS_REGISTRY.mediaDownloadUserRateLimit.rateLimitConfig.windowSeconds).toBe(60);

      // public share lookup — per-IP cap (UNAUTHENTICATED)
      expect(REDIS_REGISTRY.shareGetIpRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.shareGetIpRateLimit.rateLimitConfig.maxAttempts).toBe(30);
      expect(REDIS_REGISTRY.shareGetIpRateLimit.rateLimitConfig.windowSeconds).toBe(60);

      // share creation — per-user cap (writes a row)
      expect(REDIS_REGISTRY.shareCreateUserRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.shareCreateUserRateLimit.rateLimitConfig.maxAttempts).toBe(20);
      expect(REDIS_REGISTRY.shareCreateUserRateLimit.rateLimitConfig.windowSeconds).toBe(60);

      // trial chat stream — per-IP burst cap (UNAUTHENTICATED, daily cap separate)
      expect(REDIS_REGISTRY.trialChatStreamIpRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.trialChatStreamIpRateLimit.rateLimitConfig.maxAttempts).toBe(20);
      expect(REDIS_REGISTRY.trialChatStreamIpRateLimit.rateLimitConfig.windowSeconds).toBe(60);
    });

    it('builds correct keys for cost-amplification rate limits', () => {
      expect(REDIS_REGISTRY.chatStreamUserRateLimit.buildKey('user-123')).toBe(
        'chat:stream:user:ratelimit:user-123'
      );
      expect(REDIS_REGISTRY.mediaDownloadUserRateLimit.buildKey('user-123')).toBe(
        'media:download:user:ratelimit:user-123'
      );
      expect(REDIS_REGISTRY.shareGetIpRateLimit.buildKey('ip-hash-123')).toBe(
        'share:get:ip:ratelimit:ip-hash-123'
      );
      expect(REDIS_REGISTRY.shareCreateUserRateLimit.buildKey('user-123')).toBe(
        'share:create:user:ratelimit:user-123'
      );
      expect(REDIS_REGISTRY.trialChatStreamIpRateLimit.buildKey('ip-hash-456')).toBe(
        'trial:chat:stream:ip:ratelimit:ip-hash-456'
      );
    });

    it('has all lockout keys defined', () => {
      expect(REDIS_REGISTRY.loginLockout).toBeDefined();
      expect(REDIS_REGISTRY.twoFactorLockout).toBeDefined();
      expect(REDIS_REGISTRY.recoveryLockout).toBeDefined();
    });

    it('has all OPAQUE state keys defined', () => {
      expect(REDIS_REGISTRY.opaquePendingRegistration).toBeDefined();
      expect(REDIS_REGISTRY.opaquePendingLogin).toBeDefined();
      expect(REDIS_REGISTRY.opaquePendingChangePassword).toBeDefined();
      expect(REDIS_REGISTRY.opaquePending2FADisable).toBeDefined();
      expect(REDIS_REGISTRY.opaquePendingDeleteAccount).toBeDefined();
    });

    it('has delete-account rate-limit and lockout keys', () => {
      expect(REDIS_REGISTRY.deleteAccountUserRateLimit).toBeDefined();
      expect(REDIS_REGISTRY.deleteAccountUserRateLimit.rateLimitConfig.maxAttempts).toBe(3);
      expect(REDIS_REGISTRY.deleteAccountUserRateLimit.rateLimitConfig.windowSeconds).toBe(3600);

      expect(REDIS_REGISTRY.deleteAccountLockout).toBeDefined();
      expect(REDIS_REGISTRY.deleteAccountLockout.ttl).toBe(24 * 60 * 60);
    });

    it('builds correct keys for delete-account entries', () => {
      // OPAQUE handshakes key by a server-issued sessionId (UUID).
      expect(REDIS_REGISTRY.opaquePendingDeleteAccount.buildKey('sess-uuid-1')).toBe(
        'opaque:delete-account:sess-uuid-1'
      );
      expect(REDIS_REGISTRY.deleteAccountUserRateLimit.buildKey('user-123')).toBe(
        'delete-account:user:ratelimit:user-123'
      );
      expect(REDIS_REGISTRY.deleteAccountLockout.buildKey('user-123')).toBe(
        'delete-account:lockout:user-123'
      );
    });

    it('opaquePendingDeleteAccount schema matches the same shape as opaquePendingChangePassword', () => {
      const sample = { userId: 'u-1', expectedSerialized: [1, 2, 3] };
      expect(REDIS_REGISTRY.opaquePendingDeleteAccount.schema.parse(sample)).toEqual(sample);
      expect(REDIS_REGISTRY.opaquePendingDeleteAccount.ttl).toBe(300);
    });

    it('has all TOTP keys defined', () => {
      expect(REDIS_REGISTRY.totpPendingSetup).toBeDefined();
      expect(REDIS_REGISTRY.totpUsedCode).toBeDefined();
    });

    it('has session tracking key defined', () => {
      expect(REDIS_REGISTRY.sessionActive).toBeDefined();
    });

    it('has passwordChangedAt key defined', () => {
      expect(REDIS_REGISTRY.passwordChangedAt).toBeDefined();
    });

    it('has trial usage keys defined', () => {
      expect(REDIS_REGISTRY.trialTokenUsage).toBeDefined();
      expect(REDIS_REGISTRY.trialIpUsage).toBeDefined();
    });

    it('has chatReservedBalance key defined', () => {
      expect(REDIS_REGISTRY.chatReservedBalance).toBeDefined();
    });

    it('has groupMemberReserved key defined', () => {
      expect(REDIS_REGISTRY.groupMemberReserved).toBeDefined();
    });

    it('has conversationReserved key defined', () => {
      expect(REDIS_REGISTRY.conversationReserved).toBeDefined();
    });

    it('every entry has a required ttl', () => {
      for (const [name, entry] of Object.entries(REDIS_REGISTRY)) {
        expect(entry.ttl, `${name} must have a ttl`).toBeGreaterThan(0);
      }
    });

    it('builds correct key patterns', () => {
      expect(REDIS_REGISTRY.loginUserRateLimit.buildKey('user@test.com')).toBe(
        'login:user:ratelimit:user@test.com'
      );
      expect(REDIS_REGISTRY.loginIpRateLimit.buildKey('abc123')).toBe('login:ip:ratelimit:abc123');
      expect(REDIS_REGISTRY.loginLockout.buildKey('user@test.com')).toBe(
        'login:lockout:user@test.com'
      );
      expect(REDIS_REGISTRY.twoFactorLockout.buildKey('user-123')).toBe('2fa:lockout:user-123');
      expect(REDIS_REGISTRY.recoveryLockout.buildKey('user@test.com')).toBe(
        'recovery:lockout:user@test.com'
      );
      // OPAQUE handshakes key by server-issued sessionId (a UUID), not by the
      // identifier/userId — that moves into the stored value. Prevents concurrent
      // handshakes for the same user from clobbering each other's `expected`.
      expect(REDIS_REGISTRY.opaquePendingRegistration.buildKey('sess-register')).toBe(
        'opaque:pending:sess-register'
      );
      expect(REDIS_REGISTRY.opaquePendingLogin.buildKey('sess-login')).toBe(
        'opaque:login:sess-login'
      );
      expect(REDIS_REGISTRY.opaquePendingChangePassword.buildKey('sess-change-pw')).toBe(
        'opaque:change-pw:sess-change-pw'
      );
      expect(REDIS_REGISTRY.opaquePending2FADisable.buildKey('sess-2fa-disable')).toBe(
        'opaque:2fa-disable:sess-2fa-disable'
      );
      expect(REDIS_REGISTRY.totpPendingSetup.buildKey('user-123')).toBe('totp:pending:user-123');
      expect(REDIS_REGISTRY.totpUsedCode.buildKey('user-123', '123456')).toBe(
        'totp:used:user-123:123456'
      );
      expect(REDIS_REGISTRY.sessionActive.buildKey('user-123', 'session-abc')).toBe(
        'sessions:user:active:user-123:session-abc'
      );
      expect(REDIS_REGISTRY.passwordChangedAt.buildKey('user-123')).toBe(
        'auth:pw-changed:user-123'
      );
      expect(REDIS_REGISTRY.trialTokenUsage.buildKey('token-abc')).toBe('trial:token:token-abc');
      expect(REDIS_REGISTRY.trialIpUsage.buildKey('ip-hash-123')).toBe('trial:ip:ip-hash-123');
      expect(REDIS_REGISTRY.chatReservedBalance.buildKey('user-123')).toBe(
        'chat:reserved:user-123'
      );
      expect(REDIS_REGISTRY.groupMemberReserved.buildKey('conv-abc', 'member-xyz')).toBe(
        'chat:group-reserved:conv-abc:member-xyz'
      );
      expect(REDIS_REGISTRY.conversationReserved.buildKey('conv-abc')).toBe(
        'chat:conversation-reserved:conv-abc'
      );
    });

    it('lowercases email in key builders that accept emails', () => {
      expect(REDIS_REGISTRY.loginUserRateLimit.buildKey('User@Test.COM')).toBe(
        'login:user:ratelimit:user@test.com'
      );
      expect(REDIS_REGISTRY.loginLockout.buildKey('User@Test.COM')).toBe(
        'login:lockout:user@test.com'
      );
      expect(REDIS_REGISTRY.registerEmailRateLimit.buildKey('User@Test.COM')).toBe(
        'register:email:ratelimit:user@test.com'
      );
    });
  });

  describe('redisGet', () => {
    it('returns null when key does not exist', async () => {
      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'loginUserRateLimit',
        'user@test.com'
      );

      expect(result).toBeNull();
    });

    it('returns validated data when key exists', async () => {
      const data = { count: 3, firstAttempt: Date.now() };
      const key = REDIS_REGISTRY.loginUserRateLimit.buildKey('user@test.com');
      mockRedis.store.set(key, data);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'loginUserRateLimit',
        'user@test.com'
      );

      expect(result).toEqual(data);
    });

    it('throws on invalid data shape', async () => {
      const key = REDIS_REGISTRY.loginUserRateLimit.buildKey('user@test.com');
      mockRedis.store.set(key, { wrong: 'shape' });

      await expect(
        redisGet(
          mockRedis as unknown as Parameters<typeof redisGet>[0],
          'loginUserRateLimit',
          'user@test.com'
        )
      ).rejects.toThrow();
    });

    it('builds the correct Redis key from arguments', async () => {
      await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'loginUserRateLimit',
        'user@test.com'
      );

      expect(mockRedis.get).toHaveBeenCalledWith('login:user:ratelimit:user@test.com');
    });
  });

  describe('redisSet', () => {
    it('stores data with auto TTL from registry', async () => {
      const data = { count: 1, firstAttempt: Date.now() };

      await redisSet(
        mockRedis as unknown as Parameters<typeof redisSet>[0],
        'loginUserRateLimit',
        data,
        'user@test.com'
      );

      expect(mockRedis.set).toHaveBeenCalledWith('login:user:ratelimit:user@test.com', data, {
        ex: REDIS_REGISTRY.loginUserRateLimit.ttl,
      });
    });

    it('validates data before storing', async () => {
      await expect(
        redisSet(
          mockRedis as unknown as Parameters<typeof redisSet>[0],
          'loginUserRateLimit',
          { wrong: 'shape' } as unknown as { count: number; firstAttempt: number },
          'user@test.com'
        )
      ).rejects.toThrow();

      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('allows overriding TTL', async () => {
      const data = { count: 1, firstAttempt: Date.now() };

      await redisSet(
        mockRedis as unknown as Parameters<typeof redisSet>[0],
        'loginUserRateLimit',
        data,
        'user@test.com',
        { ttlOverride: 60 }
      );

      expect(mockRedis.set).toHaveBeenCalledWith('login:user:ratelimit:user@test.com', data, {
        ex: 60,
      });
    });
  });

  describe('redisDel', () => {
    it('deletes the correct key', async () => {
      await redisDel(
        mockRedis as unknown as Parameters<typeof redisDel>[0],
        'loginUserRateLimit',
        'user@test.com'
      );

      expect(mockRedis.del).toHaveBeenCalledWith('login:user:ratelimit:user@test.com');
    });
  });

  describe('OPAQUE state schemas', () => {
    it('validates pending registration data', async () => {
      const data = { email: 'user@test.com', username: 'test_user', userId: 'user-123' };
      const key = REDIS_REGISTRY.opaquePendingRegistration.buildKey('sess-register');
      mockRedis.store.set(key, data);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'opaquePendingRegistration',
        'sess-register'
      );

      expect(result).toEqual(data);
    });

    it('validates pending login data with nullable userId', async () => {
      const data = {
        identifier: 'user@test.com',
        userId: null,
        expectedSerialized: [1, 2, 3],
      };
      const key = REDIS_REGISTRY.opaquePendingLogin.buildKey('sess-login-1');
      mockRedis.store.set(key, data);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'opaquePendingLogin',
        'sess-login-1'
      );

      expect(result).toEqual(data);
    });

    it('validates pending login data with string userId', async () => {
      const data = {
        identifier: 'user@test.com',
        userId: 'user-123',
        expectedSerialized: [1, 2, 3],
      };
      const key = REDIS_REGISTRY.opaquePendingLogin.buildKey('sess-login-2');
      mockRedis.store.set(key, data);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'opaquePendingLogin',
        'sess-login-2'
      );

      expect(result).toEqual(data);
    });
  });

  describe('session active key', () => {
    it('stores and retrieves session marker', async () => {
      await redisSet(
        mockRedis as unknown as Parameters<typeof redisSet>[0],
        'sessionActive',
        '1',
        'user-123',
        'session-abc'
      );

      expect(mockRedis.set).toHaveBeenCalledWith('sessions:user:active:user-123:session-abc', '1', {
        ex: REDIS_REGISTRY.sessionActive.ttl,
      });
    });

    it('handles numeric value from Upstash REST API deserialization', async () => {
      const key = REDIS_REGISTRY.sessionActive.buildKey('user-123', 'session-abc');
      // Upstash REST API deserializes '1' as the number 1
      mockRedis.store.set(key, 1);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'sessionActive',
        'user-123',
        'session-abc'
      );

      expect(result).toBe('1');
    });
  });

  describe('lockout key schemas handle Upstash type coercion', () => {
    it('handles numeric timestamp from Upstash for loginLockout', async () => {
      const timestamp = Date.now() + 900_000;
      const key = REDIS_REGISTRY.loginLockout.buildKey('user@test.com');
      // Upstash REST API deserializes String(timestamp) as a number
      mockRedis.store.set(key, timestamp);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'loginLockout',
        'user@test.com'
      );

      expect(result).toBe(String(timestamp));
    });

    it('handles numeric timestamp from Upstash for twoFactorLockout', async () => {
      const timestamp = Date.now() + 900_000;
      const key = REDIS_REGISTRY.twoFactorLockout.buildKey('user-123');
      mockRedis.store.set(key, timestamp);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'twoFactorLockout',
        'user-123'
      );

      expect(result).toBe(String(timestamp));
    });

    it('handles numeric timestamp from Upstash for recoveryLockout', async () => {
      const timestamp = Date.now() + 3_600_000;
      const key = REDIS_REGISTRY.recoveryLockout.buildKey('user@test.com');
      mockRedis.store.set(key, timestamp);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'recoveryLockout',
        'user@test.com'
      );

      expect(result).toBe(String(timestamp));
    });
  });

  describe('totpUsedCode TTL covers epochTolerance window', () => {
    it('has TTL >= 120 seconds to cover ±30s tolerance (3 time steps × 30s + buffer)', () => {
      expect(REDIS_REGISTRY.totpUsedCode.ttl).toBeGreaterThanOrEqual(120);
    });
  });

  describe('totpUsedCode key handles Upstash type coercion', () => {
    it('handles numeric value from Upstash REST API deserialization', async () => {
      const key = REDIS_REGISTRY.totpUsedCode.buildKey('user-123', '654321');
      // Upstash REST API deserializes '1' as the number 1
      mockRedis.store.set(key, 1);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'totpUsedCode',
        'user-123',
        '654321'
      );

      expect(result).toBe('1');
    });
  });

  describe('passwordChangedAt key', () => {
    it('stores and retrieves timestamp', async () => {
      const timestamp = Date.now();
      await redisSet(
        mockRedis as unknown as Parameters<typeof redisSet>[0],
        'passwordChangedAt',
        timestamp,
        'user-123'
      );

      expect(mockRedis.set).toHaveBeenCalledWith('auth:pw-changed:user-123', timestamp, {
        ex: REDIS_REGISTRY.passwordChangedAt.ttl,
      });
    });

    it('retrieves null when not set', async () => {
      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'passwordChangedAt',
        'user-123'
      );

      expect(result).toBeNull();
    });

    it('retrieves stored timestamp', async () => {
      const timestamp = Date.now();
      const key = REDIS_REGISTRY.passwordChangedAt.buildKey('user-123');
      mockRedis.store.set(key, timestamp);

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'passwordChangedAt',
        'user-123'
      );

      expect(result).toBe(timestamp);
    });

    it('coerces string timestamp from Upstash REST API to number', async () => {
      const timestamp = Date.now();
      const key = REDIS_REGISTRY.passwordChangedAt.buildKey('user-456');
      mockRedis.store.set(key, String(timestamp));

      const result = await redisGet(
        mockRedis as unknown as Parameters<typeof redisGet>[0],
        'passwordChangedAt',
        'user-456'
      );

      expect(result).toBe(timestamp);
    });
  });

  describe('redisIncrByFloat', () => {
    it('calls redis.eval with the correct key and increment', async () => {
      mockRedis.eval.mockResolvedValue('5.5');

      await redisIncrByFloat(
        mockRedis as unknown as Parameters<typeof redisIncrByFloat>[0],
        'chatReservedBalance',
        5.5,
        'user-123'
      );

      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      const [script, keys, args] = mockRedis.eval.mock.calls[0] as [string, string[], string[]];
      expect(keys).toEqual(['chat:reserved:user-123']);
      expect(args).toContain('5.5');
      expect(args).toContain('180');
      expect(script).toContain('INCRBYFLOAT');
    });

    it('returns the new value as a number', async () => {
      mockRedis.eval.mockResolvedValue('12.75');

      const result = await redisIncrByFloat(
        mockRedis as unknown as Parameters<typeof redisIncrByFloat>[0],
        'chatReservedBalance',
        5.5,
        'user-123'
      );

      expect(result).toBe(12.75);
    });

    it('uses registry TTL for EXPIRE', async () => {
      mockRedis.eval.mockResolvedValue('1');

      await redisIncrByFloat(
        mockRedis as unknown as Parameters<typeof redisIncrByFloat>[0],
        'chatReservedBalance',
        1,
        'user-123'
      );

      const args = (mockRedis.eval.mock.calls[0] as [string, string[], string[]])[2];
      expect(args).toContain(String(REDIS_REGISTRY.chatReservedBalance.ttl));
    });

    it('deletes key when result is zero or negative (Lua script handles this)', async () => {
      mockRedis.eval.mockResolvedValue('0');

      const result = await redisIncrByFloat(
        mockRedis as unknown as Parameters<typeof redisIncrByFloat>[0],
        'chatReservedBalance',
        -5,
        'user-123'
      );

      expect(result).toBe(0);
      const script = (mockRedis.eval.mock.calls[0] as [string, string[], string[]])[0];
      expect(script).toContain('redis.call("DEL"');
    });

    it('coerces string result from Upstash REST API to number', async () => {
      mockRedis.eval.mockResolvedValue('7.25');

      const result = await redisIncrByFloat(
        mockRedis as unknown as Parameters<typeof redisIncrByFloat>[0],
        'chatReservedBalance',
        7.25,
        'user-123'
      );

      expect(typeof result).toBe('number');
      expect(result).toBe(7.25);
    });
  });

  describe('chatReservedBalance key', () => {
    it('has 180 second TTL', () => {
      expect(REDIS_REGISTRY.chatReservedBalance.ttl).toBe(180);
    });

    it('coerces string values to number via schema', () => {
      const parsed = REDIS_REGISTRY.chatReservedBalance.schema.parse('42.5');
      expect(parsed).toBe(42.5);
    });
  });

  describe('groupMemberReserved key', () => {
    it('has 180 second TTL', () => {
      expect(REDIS_REGISTRY.groupMemberReserved.ttl).toBe(180);
    });

    it('builds correct key with conversationId and memberId', () => {
      expect(REDIS_REGISTRY.groupMemberReserved.buildKey('conv-123', 'member-456')).toBe(
        'chat:group-reserved:conv-123:member-456'
      );
    });

    it('coerces string values to number via schema', () => {
      const parsed = REDIS_REGISTRY.groupMemberReserved.schema.parse('7.25');
      expect(parsed).toBe(7.25);
    });
  });

  describe('conversationReserved key', () => {
    it('has 180 second TTL', () => {
      expect(REDIS_REGISTRY.conversationReserved.ttl).toBe(180);
    });

    it('builds correct key with conversationId', () => {
      expect(REDIS_REGISTRY.conversationReserved.buildKey('conv-789')).toBe(
        'chat:conversation-reserved:conv-789'
      );
    });

    it('coerces string values to number via schema', () => {
      const parsed = REDIS_REGISTRY.conversationReserved.schema.parse('3.5');
      expect(parsed).toBe(3.5);
    });
  });
});
