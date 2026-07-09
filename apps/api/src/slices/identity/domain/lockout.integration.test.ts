import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { redisGet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import { clearLockout, evaluateLockout, reserveAttempt } from './lockout.js';

const CONFIG = { maxAttempts: 3, windowSeconds: 60 };

// `count` includes the attempt under decision (reservation semantics).
describe('evaluateLockout', () => {
  it('admits an attempt whose reserved count is below the cap', () => {
    expect(evaluateLockout(2, 50, CONFIG)).toEqual({ lockedOut: false });
  });

  it('admits the attempt that exactly fills the cap', () => {
    expect(evaluateLockout(3, 50, CONFIG)).toEqual({ lockedOut: false });
  });

  it('locks the attempt that first crosses the cap and flags it just-triggered', () => {
    expect(evaluateLockout(4, 50, CONFIG)).toEqual({
      lockedOut: true,
      retryAfterSeconds: 50,
      justTriggered: true,
    });
  });

  it('stays locked far past the cap without re-flagging just-triggered', () => {
    expect(evaluateLockout(9, 50, CONFIG)).toEqual({
      lockedOut: true,
      retryAfterSeconds: 50,
      justTriggered: false,
    });
  });

  it('falls back to the full window when the expiry is unobservable', () => {
    expect(evaluateLockout(4, null, CONFIG)).toEqual({
      lockedOut: true,
      retryAfterSeconds: 60,
      justTriggered: true,
    });
  });
});

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

describe('lockout (integration: real Redis)', () => {
  const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  const definition = IDENTITY_KEYS.twoFactorLockout;

  function uniqueId(): string {
    return `lock-${crypto.randomUUID()}`;
  }

  it('admits reservations up to the cap and locks the next', async () => {
    const id = uniqueId();
    const { maxAttempts } = definition.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const reserved = await reserveAttempt(redis, definition, id);
      expect(reserved._unsafeUnwrap().lockedOut).toBe(false);
    }
    const denied = await reserveAttempt(redis, definition, id);
    const decision = denied._unsafeUnwrap();
    expect(decision.lockedOut).toBe(true);
    if (decision.lockedOut) {
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
      expect(decision.retryAfterSeconds).toBeLessThanOrEqual(
        definition.rateLimitConfig.windowSeconds
      );
    }
  });

  it('admits exactly the cap under concurrent reservations (racers cannot shed attempts)', async () => {
    const id = uniqueId();
    const { maxAttempts } = definition.rateLimitConfig;
    const results = await Promise.all(
      Array.from({ length: maxAttempts + 5 }, () => reserveAttempt(redis, definition, id))
    );
    const decisions = results.map((result) => result._unsafeUnwrap());
    expect(decisions.filter((decision) => !decision.lockedOut)).toHaveLength(maxAttempts);
    expect(decisions.filter((decision) => decision.lockedOut)).toHaveLength(5);
  });

  it('clears a lockout, wiping the reserved attempts', async () => {
    const id = uniqueId();
    const { maxAttempts } = definition.rateLimitConfig;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      const reserved = await reserveAttempt(redis, definition, id);
      reserved._unsafeUnwrap();
    }
    const cleared = await clearLockout(redis, definition, id);
    cleared._unsafeUnwrap();
    const stored = await redisGet(redis, definition, id);
    expect(stored._unsafeUnwrap()).toBeNull();
    const rechecked = await reserveAttempt(redis, definition, id);
    expect(rechecked._unsafeUnwrap().lockedOut).toBe(false);
  });

  it('answers unavailable when Redis is unreachable', async () => {
    const deadRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });
    const result = await reserveAttempt(deadRedis, definition, uniqueId());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
