import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { redisDel } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import { consumeRateLimit, evaluateWindow } from './rate-limit.js';

const CONFIG = { maxAttempts: 3, windowSeconds: 60 };
const NOW = 1_700_000_000_000;

describe('evaluateWindow', () => {
  it('opens a fresh window on the first attempt', () => {
    expect(evaluateWindow(null, CONFIG, NOW)).toEqual({
      decision: { allowed: true },
      nextState: { count: 1, firstAttempt: NOW },
    });
  });

  it('counts attempts inside the window', () => {
    expect(evaluateWindow({ count: 1, firstAttempt: NOW - 1000 }, CONFIG, NOW)).toEqual({
      decision: { allowed: true },
      nextState: { count: 2, firstAttempt: NOW - 1000 },
    });
  });

  it('denies once the attempt cap is reached with the window remainder as retry-after', () => {
    const firstAttempt = NOW - 10_000;
    expect(evaluateWindow({ count: 3, firstAttempt }, CONFIG, NOW)).toEqual({
      decision: { allowed: false, retryAfterSeconds: 50 },
      nextState: null,
    });
  });

  it('reopens the window after it expires', () => {
    const firstAttempt = NOW - 61_000;
    expect(evaluateWindow({ count: 3, firstAttempt }, CONFIG, NOW)).toEqual({
      decision: { allowed: true },
      nextState: { count: 1, firstAttempt: NOW },
    });
  });

  it('rounds a fractional window remainder up to whole seconds', () => {
    const firstAttempt = NOW - 59_500;
    const evaluation = evaluateWindow({ count: 3, firstAttempt }, CONFIG, NOW);
    expect(evaluation.decision).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

describe('consumeRateLimit (integration: real Redis)', () => {
  const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

  function uniqueIdentifier(): string {
    return `rl-${crypto.randomUUID()}@identity.test`;
  }

  it('allows attempts up to the configured cap and then denies', async () => {
    const identifier = uniqueIdentifier();
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.registerRateLimit.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const result = await consumeRateLimit(
        redis,
        IDENTITY_KEYS.registerRateLimit,
        identifier,
        Date.now()
      );
      expect(result._unsafeUnwrap()).toEqual({ allowed: true });
    }
    const denied = await consumeRateLimit(
      redis,
      IDENTITY_KEYS.registerRateLimit,
      identifier,
      Date.now()
    );
    const decision = denied._unsafeUnwrap();
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
      expect(decision.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
    }
  });

  it('reopens a rate limit after its key is cleared', async () => {
    const identifier = uniqueIdentifier();
    const { maxAttempts } = IDENTITY_KEYS.registerRateLimit.rateLimitConfig;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      const consumed = await consumeRateLimit(
        redis,
        IDENTITY_KEYS.registerRateLimit,
        identifier,
        Date.now()
      );
      expect(consumed.isOk()).toBe(true);
    }
    const cleared = await redisDel(redis, IDENTITY_KEYS.registerRateLimit, identifier);
    expect(cleared.isOk()).toBe(true);
    const retry = await consumeRateLimit(
      redis,
      IDENTITY_KEYS.registerRateLimit,
      identifier,
      Date.now()
    );
    expect(retry._unsafeUnwrap()).toEqual({ allowed: true });
  });

  it('answers unavailable when Redis is unreachable', async () => {
    const deadRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });
    const result = await consumeRateLimit(
      deadRedis,
      IDENTITY_KEYS.registerRateLimit,
      uniqueIdentifier(),
      Date.now()
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
