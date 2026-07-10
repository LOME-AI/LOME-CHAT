import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REALTIME_REDIS_KEYS, defineKey, defineRateLimitKey } from './define-key.js';

describe('defineKey', () => {
  it('returns the definition with schema, ttlSeconds, and buildKey intact', () => {
    const schema = z.object({ count: z.number() });
    const definition = defineKey({
      schema,
      ttlSeconds: 300,
      buildKey: (userId: string) => `example:${userId}`,
    });
    expect(definition.schema).toBe(schema);
    expect(definition.ttlSeconds).toBe(300);
    expect(definition.buildKey('u-1')).toBe('example:u-1');
  });

  it('infers multi-argument buildKey signatures', () => {
    const definition = defineKey({
      schema: z.coerce.string(),
      ttlSeconds: 60,
      buildKey: (userId: string, code: string) => `example:${userId}:${code}`,
    });
    expect(definition.buildKey('u-1', '123456')).toBe('example:u-1:123456');
  });
});

describe('defineRateLimitKey', () => {
  it('carries the rateLimitConfig in the returned definition', () => {
    const definition = defineRateLimitKey({
      schema: z.object({ count: z.number(), firstAttempt: z.number() }),
      ttlSeconds: 900,
      buildKey: (ipHash: string) => `example:ratelimit:${ipHash}`,
      rateLimitConfig: { maxAttempts: 5, windowSeconds: 900, lockoutSeconds: 1800 },
    });
    expect(definition.rateLimitConfig).toEqual({
      maxAttempts: 5,
      windowSeconds: 900,
      lockoutSeconds: 1800,
    });
    expect(definition.ttlSeconds).toBe(900);
    expect(definition.buildKey('ip-1')).toBe('example:ratelimit:ip-1');
  });

  it('allows omitting the optional lockoutSeconds', () => {
    const definition = defineRateLimitKey({
      schema: z.object({ count: z.number(), firstAttempt: z.number() }),
      ttlSeconds: 60,
      buildKey: (userId: string) => `example:ratelimit:user:${userId}`,
      rateLimitConfig: { maxAttempts: 10, windowSeconds: 60 },
    });
    expect(definition.rateLimitConfig.lockoutSeconds).toBeUndefined();
  });
});

describe('REALTIME_REDIS_KEYS.userActiveRooms', () => {
  it('scopes the active-room set per user id', () => {
    expect(REALTIME_REDIS_KEYS.userActiveRooms.buildKey('u-1')).toBe(
      'realtime:user-active-rooms:u-1'
    );
  });

  it('carries a long crash-orphan backstop TTL rather than a per-connection expiry', () => {
    expect(REALTIME_REDIS_KEYS.userActiveRooms.ttlSeconds).toBe(24 * 60 * 60);
  });
});
