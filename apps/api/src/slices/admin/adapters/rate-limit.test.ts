import { describe, expect, it } from 'vitest';
import {
  adminAuditSearchRateLimit,
  adminCustomer360RateLimit,
  adminSqlPanelRateLimit,
} from './rate-limit.js';

const ENTRIES = [adminCustomer360RateLimit, adminAuditSearchRateLimit, adminSqlPanelRateLimit];

describe('admin read-volume rate-limit entries', () => {
  it('build distinct admin-prefixed keys per actor hash', () => {
    const keys = ENTRIES.map((entry) => entry.buildKey('abc123'));
    expect(new Set(keys).size).toBe(ENTRIES.length);
    for (const key of keys) {
      expect(key).toMatch(/^admin:read:[a-z0-9-]+:ratelimit:abc123$/);
    }
  });

  it('carry a window config whose TTL covers the window', () => {
    for (const entry of ENTRIES) {
      expect(entry.rateLimitConfig.maxAttempts).toBeGreaterThan(0);
      expect(entry.ttlSeconds).toBeGreaterThanOrEqual(entry.rateLimitConfig.windowSeconds);
    }
  });
});
