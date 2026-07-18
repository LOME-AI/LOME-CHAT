import { describe, expect, it, vi } from 'vitest';
import type { Redis } from '@upstash/redis';
import { resetAuthRateLimits } from './redis-resets.js';

/**
 * A Redis stub that records every `match` prefix passed to `scan` and returns
 * an empty, single-page result so the reset walks each prefix exactly once.
 */
function stubScanRedis(): { redis: Redis; matches: string[] } {
  const matches: string[] = [];
  const scan = vi.fn((_cursor: string | number, options: { match: string; count: number }) => {
    matches.push(options.match);
    return Promise.resolve(['0', [] as string[]] as [string, string[]]);
  });
  const del = vi.fn(() => Promise.resolve(0));
  return { redis: { scan, del } as unknown as Redis, matches };
}

describe('resetAuthRateLimits', () => {
  it('clears the per-IP auth limiter buckets', async () => {
    const { redis, matches } = stubScanRedis();

    await resetAuthRateLimits(redis);

    expect(matches).toEqual(
      expect.arrayContaining([
        'login:ip:ratelimit:*',
        'register:ip:ratelimit:*',
        'recovery:ip:ratelimit:*',
        'recovery:getkey:ip:ratelimit:*',
        'verify:ip:ratelimit:*',
        'resend-verify:ip:ratelimit:*',
      ])
    );
  });

  it('retains the per-email, lockout, and TOTP replay prefixes', async () => {
    const { redis, matches } = stubScanRedis();

    await resetAuthRateLimits(redis);

    expect(matches).toEqual(
      expect.arrayContaining([
        'login:lockout:*',
        '2fa:lockout:*',
        'register:email:ratelimit:*',
        'resend-verify:email:ratelimit:*',
        'recovery:getkey:lockout:*',
        'recovery:reset:lockout:*',
        'delete-account:lockout:*',
        'totp:used:*',
      ])
    );
  });
});
