import { describe, expect, it } from 'vitest';
import { TRIAL_BURST_RATE_LIMIT, consumeTrialBurst, evaluateTrialBurst } from './rate-limit.js';

type Redis = Parameters<typeof consumeTrialBurst>[0];

const CONFIG = TRIAL_BURST_RATE_LIMIT.rateLimitConfig;

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

describe('TRIAL_BURST_RATE_LIMIT', () => {
  it('caps the trial send at 20 requests per 60-second window per hashed IP', () => {
    expect(TRIAL_BURST_RATE_LIMIT.rateLimitConfig).toEqual({ maxAttempts: 20, windowSeconds: 60 });
    expect(TRIAL_BURST_RATE_LIMIT.ttlSeconds).toBe(60);
    expect(TRIAL_BURST_RATE_LIMIT.buildKey('ip-hash')).toBe('trial:burst:ip:ratelimit:ip-hash');
  });
});

describe('evaluateTrialBurst', () => {
  it('admits a count at the cap', () => {
    expect(evaluateTrialBurst(20, 30, CONFIG)).toEqual({ allowed: true });
  });

  it('admits a count below the cap', () => {
    expect(evaluateTrialBurst(1, 30, CONFIG)).toEqual({ allowed: true });
  });

  it('denies a count past the cap with the remaining window', () => {
    expect(evaluateTrialBurst(21, 30, CONFIG)).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it('falls back to the full window when the counter carries no expiry', () => {
    expect(evaluateTrialBurst(21, null, CONFIG)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });
});

describe('consumeTrialBurst', () => {
  it('admits the first twenty sends within the window and denies the twenty-first', async () => {
    const redis = countingRedis();
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const admitted = await consumeTrialBurst(redis, 'ip');
      expect(admitted._unsafeUnwrap()).toEqual({ allowed: true });
    }
    const denied = await consumeTrialBurst(redis, 'ip');
    expect(denied._unsafeUnwrap()).toEqual({ allowed: false, retryAfterSeconds: 42 });
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const redis = { incr: () => Promise.reject(new Error('down')) } as unknown as Redis;
    const result = await consumeTrialBurst(redis, 'ip');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });
});
