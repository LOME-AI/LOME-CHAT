import { describe, expect, it } from 'vitest';
import { publicShareReadRateLimit, shareCreateRateLimit } from './rate-limit.js';

/**
 * Nothing enforces this cap yet — enforcement lands with the edge/IP
 * rate-limit enforcer. The contract pinned here is that the registry entry
 * EXISTS and is shaped correctly so that enforcer has a typed key to consume.
 */
describe('publicShareReadRateLimit', () => {
  it('caps the unauthenticated public share read at 30 per 60s (mirrors legacy)', () => {
    expect(publicShareReadRateLimit.rateLimitConfig.maxAttempts).toBe(30);
    expect(publicShareReadRateLimit.rateLimitConfig.windowSeconds).toBe(60);
    expect(publicShareReadRateLimit.ttlSeconds).toBe(60);
  });

  it('keys per client-IP hash', () => {
    expect(publicShareReadRateLimit.buildKey('ip-hash-abc')).toBe(
      'conversations:share:read:ip:ratelimit:ip-hash-abc'
    );
  });

  it('validates the stored counter shape', () => {
    expect(publicShareReadRateLimit.schema.safeParse({ count: 3, firstAttempt: 1 }).success).toBe(
      true
    );
    expect(publicShareReadRateLimit.schema.safeParse({ count: 'x' }).success).toBe(false);
  });
});

describe('shareCreateRateLimit', () => {
  it('caps authenticated shared-message creation at 20 per 60s (mirrors legacy)', () => {
    expect(shareCreateRateLimit.rateLimitConfig.maxAttempts).toBe(20);
    expect(shareCreateRateLimit.rateLimitConfig.windowSeconds).toBe(60);
    expect(shareCreateRateLimit.ttlSeconds).toBe(60);
  });

  it('keys per resolved caller id', () => {
    expect(shareCreateRateLimit.buildKey('user-123')).toBe('share:create:user:ratelimit:user-123');
  });
});
