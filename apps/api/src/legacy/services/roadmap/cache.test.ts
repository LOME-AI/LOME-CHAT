import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from '@upstash/redis';
import { roadmapResponseSchema, type RoadmapResponse } from '@hushbox/shared';
import { RoadmapCache } from './cache.js';

interface RedisCall {
  op: 'get' | 'set';
  key: string;
  value?: unknown;
  options?: unknown;
}

function makeStubRedis(): { redis: Redis; calls: RedisCall[]; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const calls: RedisCall[] = [];
  const redis = {
    get: (key: string) => {
      calls.push({ op: 'get', key });
      return Promise.resolve(store.has(key) ? store.get(key) : null);
    },
    set: (key: string, value: unknown, options: unknown) => {
      calls.push({ op: 'set', key, value, options });
      store.set(key, value);
      return Promise.resolve('OK');
    },
  } as unknown as Redis;
  return { redis, calls, store };
}

const validId = '0123456789ab';

function makeResponse(): RoadmapResponse {
  return roadmapResponseSchema.parse({
    nodes: [
      {
        id: validId,
        kind: 'project',
        parentId: null,
        title: 'P',
        status: 'in_progress',
        type: null,
        progress: { done: 0, total: 1 },
      },
    ],
  });
}

describe('RoadmapCache', () => {
  let stub: ReturnType<typeof makeStubRedis>;
  beforeEach(() => {
    stub = makeStubRedis();
  });

  it('returns null on a cold cache', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    expect(await cache.get()).toBeNull();
  });

  it('writes the response under a key that lower-cases the team key', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    await cache.set(makeResponse());
    const written = [...stub.store.keys()];
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(':hus:');
  });

  it('lowercases the team key for consistency', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    await cache.set(makeResponse());
    const lower = new RoadmapCache(stub.redis, 'hus');
    const value = await lower.get();
    expect(value).not.toBeNull();
  });

  it('round-trips a response through get/set', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    const response = makeResponse();
    await cache.set(response);
    const retrieved = await cache.get();
    expect(retrieved).toEqual(response);
  });

  it('uses a 1h TTL on writes', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    await cache.set(makeResponse());
    const setCall = stub.calls.find((c) => c.op === 'set');
    expect(setCall?.options).toEqual({ ex: 60 * 60 });
  });

  it('the cache key differs from other tenants', async () => {
    const a = new RoadmapCache(stub.redis, 'HUS');
    const b = new RoadmapCache(stub.redis, 'OTHER');
    await a.set(makeResponse());
    expect(await b.get()).toBeNull();
  });
});
