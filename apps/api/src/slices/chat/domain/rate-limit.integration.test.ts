import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { TRIAL_BURST_RATE_LIMIT, consumeTrialBurst } from './rate-limit.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_* required for the trial burst rate-limit tests — run via pnpm test:api'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

async function drainToCap(ipHash: string): Promise<void> {
  for (
    let attempt = 1;
    attempt <= TRIAL_BURST_RATE_LIMIT.rateLimitConfig.maxAttempts;
    attempt += 1
  ) {
    const decision = await consumeTrialBurst(redis, ipHash);
    expect(decision._unsafeUnwrap().allowed).toBe(true);
  }
}

describe('consumeTrialBurst (real Redis)', () => {
  it('admits the cap then denies, anchoring the window at the first increment', async () => {
    const ipHash = `burst-${crypto.randomUUID()}`;
    const key = TRIAL_BURST_RATE_LIMIT.buildKey(ipHash);
    await drainToCap(ipHash);
    // The window's TTL right after the cap is reached; EXPIRE NX must never re-arm it.
    const ttlAtCap = await redis.ttl(key);

    const deniedResult = await consumeTrialBurst(redis, ipHash);
    const denied = deniedResult._unsafeUnwrap();
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    }

    // The over-cap increment did not extend the window: its TTL is not larger
    // than at the cap (a re-armed window would jump back toward the full 60s).
    const ttlAfterDeny = await redis.ttl(key);
    expect(ttlAtCap).toBeGreaterThan(0);
    expect(ttlAtCap).toBeLessThanOrEqual(60);
    expect(ttlAfterDeny).toBeLessThanOrEqual(ttlAtCap);
    await redis.del(key);
  });

  it('counts each IP independently', async () => {
    const first = `burst-a-${crypto.randomUUID()}`;
    const second = `burst-b-${crypto.randomUUID()}`;
    await drainToCap(first);
    const firstDenied = await consumeTrialBurst(redis, first);
    expect(firstDenied._unsafeUnwrap().allowed).toBe(false);

    // A different IP has its own counter, so its first send is still admitted.
    const secondFresh = await consumeTrialBurst(redis, second);
    expect(secondFresh._unsafeUnwrap().allowed).toBe(true);

    await redis.del(TRIAL_BURST_RATE_LIMIT.buildKey(first));
    await redis.del(TRIAL_BURST_RATE_LIMIT.buildKey(second));
  });
});
