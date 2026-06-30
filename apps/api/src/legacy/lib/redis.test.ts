import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@upstash/redis', () => {
  return {
    Redis: class MockRedis {
      url: string;
      token: string;

      constructor(config: { url: string; token: string }) {
        this.url = config.url;
        this.token = config.token;
      }
    },
  };
});

import { Redis } from '@upstash/redis';
import { createRedisClient } from './redis.js';

describe('createRedisClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a Redis client with provided url and token', () => {
    const url = 'http://localhost:8079';
    const token = 'test-token';

    const client = createRedisClient(url, token);

    expect(client).toBeInstanceOf(Redis);
  });

  it('returns a Redis instance with correct configuration', () => {
    const url = 'https://redis.upstash.com';
    const token = 'production-token';

    const client = createRedisClient(url, token);

    expect(client).toBeDefined();
    expect((client as unknown as { url: string }).url).toBe(url);
    expect((client as unknown as { token: string }).token).toBe(token);
  });
});
