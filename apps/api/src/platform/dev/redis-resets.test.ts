import { describe, expect, it, vi } from 'vitest';
import type { Redis } from '@upstash/redis';
import { resetAuthRateLimits, resetUsageRateLimits } from './redis-resets.js';

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

describe('resetUsageRateLimits', () => {
  it('clears the authenticated share-create per-caller rate-limit bucket', async () => {
    // The E2E `clearUsageRateLimits` helper claims share creation is reset, so
    // the key template registered in the conversations slice
    // (`share:create:user:ratelimit:${callerId}`) must be among the cleared
    // prefixes.
    const { redis, matches } = stubScanRedis();

    await resetUsageRateLimits(redis);

    expect(matches).toContain('share:create:user:ratelimit:*');
  });

  it('clears the chat-stream and media usage rate-limit buckets', async () => {
    const { redis, matches } = stubScanRedis();

    await resetUsageRateLimits(redis);

    expect(matches).toEqual(
      expect.arrayContaining([
        'chat:stream:user:ratelimit:*',
        'media:download:user:ratelimit:*',
        'media:share:presign:ip:ratelimit:*',
        'media:share:presign:remint:ratelimit:*',
        'conversations:share:read:ip:ratelimit:*',
      ])
    );
  });
});
