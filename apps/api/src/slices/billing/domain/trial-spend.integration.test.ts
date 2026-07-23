import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { secondsUntilNextUtcMidnight } from '@hushbox/shared';
import { TRIAL_DAILY_SPEND_CAP_NANO_USD } from './constants.js';
import { BILLING_KEYS } from './keys.js';
import { utcDayKey } from './period.js';
import { admitTrialSpend, incrementTrialSpend } from './trial-spend.js';

/**
 * The daily cumulative trial-spend counter against real Redis: increments sum
 * into one period-keyed total, admission reads and compares it to the cap, the
 * single increment that crosses the cap is reported once, and the counter's
 * expiry is anchored to the next UTC midnight (NX — never extended, no reset
 * job).
 */

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for trial-spend tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token', retry: false });
const createdDays: string[] = [];

/**
 * A distinct UTC day per test so counters never collide. Both the counter's
 * key-day and its TTL derive from the injected `now` (a single clock source),
 * so the fake day isolates the key and anchors the TTL deterministically at
 * noon → next midnight, independent of the wall clock the suite runs under.
 */
let dayOffset = 0;
function freshNow(): Date {
  dayOffset += 1;
  const now = new Date(Date.UTC(2030, 0, dayOffset, 12, 0, 0));
  createdDays.push(utcDayKey(now));
  return now;
}

afterAll(async () => {
  if (createdDays.length > 0) {
    await Promise.all(
      createdDays.map((day) => redis.del(BILLING_KEYS.trialDailySpend.buildKey(day)))
    );
  }
});

async function increment(amountNanoUsd: bigint, now: Date) {
  const result = await incrementTrialSpend({ redis }, { amountNanoUsd, now });
  return result._unsafeUnwrap();
}

async function admit(now: Date) {
  const result = await admitTrialSpend({ redis }, { now });
  return result._unsafeUnwrap();
}

describe('incrementTrialSpend', () => {
  it('sums successive increments into one cumulative daily total', async () => {
    const now = freshNow();
    const first = await increment(400n, now);
    const second = await increment(600n, now);
    expect(first.total).toBe(400n);
    expect(second.total).toBe(1000n);
    expect(first.crossed).toBe(false);
    expect(second.crossed).toBe(false);
  });

  it('reports the crossing exactly once — never below, never again above', async () => {
    const now = freshNow();
    const below = await increment(TRIAL_DAILY_SPEND_CAP_NANO_USD - 10n, now);
    const crossing = await increment(20n, now);
    const above = await increment(5n, now);

    expect(below.crossed).toBe(false);
    expect(crossing.crossed).toBe(true);
    expect(crossing.total).toBe(TRIAL_DAILY_SPEND_CAP_NANO_USD + 10n);
    expect(above.crossed).toBe(false);
    expect(above.total).toBe(TRIAL_DAILY_SPEND_CAP_NANO_USD + 15n);
  });

  it('anchors the counter TTL to the next UTC midnight', async () => {
    const now = freshNow();
    await increment(100n, now);
    const ttl = await redis.ttl(BILLING_KEYS.trialDailySpend.buildKey(utcDayKey(now)));
    const untilMidnight = secondsUntilNextUtcMidnight(now);
    // Midnight-anchored to the injected clock, not a rolling 24h window: the TTL
    // tracks seconds-until-midnight from `now` (< 86400 except exactly at
    // midnight), never resets to a full day.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(untilMidnight + 2);
    expect(ttl).toBeGreaterThan(untilMidnight - 10);
  });

  it('does not extend the TTL on a later increment (NX, no reset job)', async () => {
    const now = freshNow();
    const key = BILLING_KEYS.trialDailySpend.buildKey(utcDayKey(now));
    await increment(100n, now);
    // Force a short expiry, then increment again: the increment's EXPIRE ... NX
    // must be a no-op because an expiry already exists, so the short TTL stands.
    await redis.expire(key, 50);
    await increment(100n, now);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(50);
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const now = freshNow();
    const result = await incrementTrialSpend({ redis: deadRedis }, { amountNanoUsd: 1n, now });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });
});

describe('admitTrialSpend', () => {
  it('admits while the day is below the cap and refuses once it reaches it', async () => {
    const now = freshNow();
    const belowCap = await admit(now);
    expect(belowCap.admitted).toBe(true);

    await increment(TRIAL_DAILY_SPEND_CAP_NANO_USD, now);

    const atCap = await admit(now);
    expect(atCap.admitted).toBe(false);
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const now = freshNow();
    const result = await admitTrialSpend({ redis: deadRedis }, { now });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });
});
