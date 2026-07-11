import { describe, expect, it } from 'vitest';
import { roadmapCache, roadmapIpRateLimit } from './platform-keys.js';

describe('platform redis keys', () => {
  it('roadmapIpRateLimit caps 30 requests per 60s window with a 60s TTL', () => {
    expect(roadmapIpRateLimit.rateLimitConfig).toEqual({ maxAttempts: 30, windowSeconds: 60 });
    expect(roadmapIpRateLimit.ttlSeconds).toBe(60);
    expect(roadmapIpRateLimit.buildKey('abc123')).toBe('roadmap:ip:ratelimit:abc123');
  });

  it('roadmapCache keys by lower-cased team key + schema version with a 1h TTL', () => {
    expect(roadmapCache.ttlSeconds).toBe(3600);
    expect(roadmapCache.buildKey('HUS', 'v2')).toBe('roadmap:hus:v2');
  });

  it('roadmapCache validates the stored value against the public response schema', () => {
    expect(roadmapCache.schema.safeParse({ nodes: [] }).success).toBe(true);
    expect(roadmapCache.schema.safeParse({ nodes: [{ bad: true }] }).success).toBe(false);
  });
});
