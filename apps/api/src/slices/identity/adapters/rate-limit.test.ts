import { describe, expect, it } from 'vitest';
import {
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  verifyEmailIpRateLimit,
} from './rate-limit.js';

/**
 * Enforcement lands at the edge/IP rate-limit middleware the app assembly
 * mounts; the contract pinned here is that each per-IP registry entry EXISTS,
 * is shaped as a `{count, firstAttempt}` window, and carries the legacy limit.
 */
describe('identity per-IP edge rate-limit entries', () => {
  it('caps login start at 20 per 15 minutes, keyed per IP hash', () => {
    expect(loginIpRateLimit.rateLimitConfig).toEqual({ maxAttempts: 20, windowSeconds: 900 });
    expect(loginIpRateLimit.ttlSeconds).toBe(900);
    expect(loginIpRateLimit.buildKey('ip-abc')).toBe('login:ip:ratelimit:ip-abc');
  });

  it('caps registration start at 10 per hour, keyed per IP hash', () => {
    expect(registerIpRateLimit.rateLimitConfig).toEqual({ maxAttempts: 10, windowSeconds: 3600 });
    expect(registerIpRateLimit.ttlSeconds).toBe(3600);
    expect(registerIpRateLimit.buildKey('ip-abc')).toBe('register:ip:ratelimit:ip-abc');
  });

  it('caps recovery reset start at 10 per hour, keyed per IP hash', () => {
    expect(recoveryResetIpRateLimit.rateLimitConfig).toEqual({
      maxAttempts: 10,
      windowSeconds: 3600,
    });
    expect(recoveryResetIpRateLimit.buildKey('ip-abc')).toBe('recovery:ip:ratelimit:ip-abc');
  });

  it('caps recovery wrapped-key retrieval at 10 per hour, keyed per IP hash', () => {
    expect(recoveryGetKeyIpRateLimit.rateLimitConfig).toEqual({
      maxAttempts: 10,
      windowSeconds: 3600,
    });
    expect(recoveryGetKeyIpRateLimit.buildKey('ip-abc')).toBe(
      'recovery:getkey:ip:ratelimit:ip-abc'
    );
  });

  it('caps email-verification consume at 30 per hour, keyed per IP hash', () => {
    expect(verifyEmailIpRateLimit.rateLimitConfig).toEqual({
      maxAttempts: 30,
      windowSeconds: 3600,
    });
    expect(verifyEmailIpRateLimit.buildKey('ip-abc')).toBe('verify:ip:ratelimit:ip-abc');
  });

  it('caps verification-email resend at 5 per 60s, keyed per IP hash', () => {
    expect(resendVerifyIpRateLimit.rateLimitConfig).toEqual({ maxAttempts: 5, windowSeconds: 60 });
    expect(resendVerifyIpRateLimit.ttlSeconds).toBe(60);
    expect(resendVerifyIpRateLimit.buildKey('ip-abc')).toBe('resend-verify:ip:ratelimit:ip-abc');
  });

  it('validates the stored counter shape', () => {
    expect(loginIpRateLimit.schema.safeParse({ count: 3, firstAttempt: 1 }).success).toBe(true);
    expect(loginIpRateLimit.schema.safeParse({ count: 'x' }).success).toBe(false);
  });
});
