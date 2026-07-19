import { describe, expect, it } from 'vitest';
import {
  CHAT_STREAM_USER_RATE_LIMIT,
  consumeChatStreamUserLimit,
  evaluateReservation,
} from './rate-limit.js';

type Redis = Parameters<typeof consumeChatStreamUserLimit>[0];

const CONFIG = CHAT_STREAM_USER_RATE_LIMIT.rateLimitConfig;

/** An in-memory Redis double: a real INCR counter, a no-op EXPIRE, a fixed TTL. */
function countingRedis(ttlSeconds = 42): Redis {
  let count = 0;
  return {
    incr: () => {
      count += 1;
      return Promise.resolve(count);
    },
    expire: () => Promise.resolve(1),
    ttl: () => Promise.resolve(ttlSeconds),
  } as unknown as Redis;
}

describe('evaluateReservation', () => {
  it('admits a count at the cap', () => {
    expect(evaluateReservation(30, 25, CONFIG)).toEqual({ allowed: true });
  });

  it('admits a count below the cap', () => {
    expect(evaluateReservation(1, 25, CONFIG)).toEqual({ allowed: true });
  });

  it('denies a count past the cap with the remaining window', () => {
    expect(evaluateReservation(31, 25, CONFIG)).toEqual({ allowed: false, retryAfterSeconds: 25 });
  });

  it('falls back to the full window when the counter carries no expiry', () => {
    expect(evaluateReservation(31, null, CONFIG)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });
});

describe('CHAT_STREAM_USER_RATE_LIMIT', () => {
  it('caps a paid chat send at 30 requests per 60-second window per user', () => {
    expect(CHAT_STREAM_USER_RATE_LIMIT.rateLimitConfig).toEqual({
      maxAttempts: 30,
      windowSeconds: 60,
    });
    expect(CHAT_STREAM_USER_RATE_LIMIT.ttlSeconds).toBe(60);
    expect(CHAT_STREAM_USER_RATE_LIMIT.buildKey('u-1')).toBe('chat:stream:user:ratelimit:u-1');
  });
});

describe('consumeChatStreamUserLimit', () => {
  it('admits the first thirty sends within the window and denies the thirty-first', async () => {
    const redis = countingRedis();
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const admitted = await consumeChatStreamUserLimit(redis, 'user');
      expect(admitted._unsafeUnwrap()).toEqual({ allowed: true });
    }
    const denied = await consumeChatStreamUserLimit(redis, 'user');
    expect(denied._unsafeUnwrap()).toEqual({ allowed: false, retryAfterSeconds: 42 });
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const redis = { incr: () => Promise.reject(new Error('down')) } as unknown as Redis;
    const result = await consumeChatStreamUserLimit(redis, 'user');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });
});
