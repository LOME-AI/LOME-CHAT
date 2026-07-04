import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { unwrap } from '../adapters/test-fixtures.js';
import { MEDIA_RATE_LIMITS, evaluateRemint, reserveShareRemint } from './rate-limit.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_* are required for media rate-limit tests — run via pnpm test:api'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

describe('media rate-limit registry entries', () => {
  it('caps presign minting per caller at the legacy window', () => {
    const entry = MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit;
    expect(entry.rateLimitConfig).toEqual({ maxAttempts: 60, windowSeconds: 60 });
    expect(entry.buildKey('caller-1')).toBe('media:download:user:ratelimit:caller-1');
  });

  it('caps unauthenticated share presign per IP at the public-share window', () => {
    const entry = MEDIA_RATE_LIMITS.sharePresignIpRateLimit;
    expect(entry.rateLimitConfig).toEqual({ maxAttempts: 30, windowSeconds: 60 });
    expect(entry.buildKey('ip-hash')).toBe('media:share:presign:ip:ratelimit:ip-hash');
  });

  it('caps presign re-mints per shareId', () => {
    const entry = MEDIA_RATE_LIMITS.sharePresignRemintRateLimit;
    expect(entry.rateLimitConfig).toEqual({ maxAttempts: 30, windowSeconds: 60 });
    expect(entry.buildKey('share-1')).toBe('media:share:presign:remint:ratelimit:share-1');
  });
});

describe('per-shareId re-mint reservation against Redis', () => {
  const max = MEDIA_RATE_LIMITS.sharePresignRemintRateLimit.rateLimitConfig.maxAttempts;

  it('admits exactly the configured number of re-mints in a window', async () => {
    const shareId = crypto.randomUUID();
    for (let attempt = 0; attempt < max; attempt += 1) {
      const decision = await unwrap(reserveShareRemint(redis, shareId));
      expect(decision.allowed).toBe(true);
    }

    const denied = await unwrap(reserveShareRemint(redis, shareId));

    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('counts each shareId in its own window', async () => {
    const exhausted = crypto.randomUUID();
    for (let attempt = 0; attempt <= max; attempt += 1) {
      await unwrap(reserveShareRemint(redis, exhausted));
    }

    const other = await unwrap(reserveShareRemint(redis, crypto.randomUUID()));

    expect(other.allowed).toBe(true);
  });
});

describe('re-mint decision arithmetic', () => {
  const config = { maxAttempts: 3, windowSeconds: 60 };

  it('admits a count at the cap', () => {
    expect(evaluateRemint(3, 10, config)).toEqual({ allowed: true });
  });

  it('denies a count past the cap with the remaining window', () => {
    expect(evaluateRemint(4, 10, config)).toEqual({ allowed: false, retryAfterSeconds: 10 });
  });

  it('falls back to the full window when the counter carries no expiry', () => {
    expect(evaluateRemint(4, null, config)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });
});
