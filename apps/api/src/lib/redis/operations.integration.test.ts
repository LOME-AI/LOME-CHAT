import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineKey } from './define-key.js';
import { redisDel, redisGet, redisSet } from './operations.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for redis integration tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// A client whose every call fails fast: nothing listens on the discard port.
const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

const PREFIX = `test:redis-registry:${crypto.randomUUID()}`;
const createdKeys: string[] = [];

function trackKey(key: string): string {
  createdKeys.push(key);
  return key;
}

const counterDefinition = defineKey({
  schema: z.object({ count: z.number(), firstAttempt: z.number() }),
  ttlSeconds: 60,
  buildKey: (id: string) => `${PREFIX}:counter:${id}`,
});

afterAll(async () => {
  if (createdKeys.length > 0) {
    await redis.del(...createdKeys);
  }
});

describe('redisGet', () => {
  it('returns null for a missing key', async () => {
    const result = await redisGet(redis, counterDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('returns the stored value validated through the schema', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(counterDefinition.buildKey(id)), { count: 2, firstAttempt: 5 });
    const result = await redisGet(redis, counterDefinition, id);
    expect(result._unsafeUnwrap()).toEqual({ count: 2, firstAttempt: 5 });
  });

  it('surfaces a validation error when the stored value fails the schema', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(counterDefinition.buildKey(id)), { wrong: true });
    const result = await redisGet(redis, counterDefinition, id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisGet(unreachableRedis, counterDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

const wordDefinition = defineKey({
  schema: z.string().min(5),
  ttlSeconds: 120,
  buildKey: (id: string) => `${PREFIX}:word:${id}`,
});

describe('redisSet', () => {
  it('round-trips a value readable by redisGet', async () => {
    const id = crypto.randomUUID();
    trackKey(counterDefinition.buildKey(id));
    const written = await redisSet(redis, counterDefinition, { count: 1, firstAttempt: 9 }, id);
    expect(written.isOk()).toBe(true);
    const read = await redisGet(redis, counterDefinition, id);
    expect(read._unsafeUnwrap()).toEqual({ count: 1, firstAttempt: 9 });
  });

  it('applies the definition ttlSeconds to the written key', async () => {
    const id = crypto.randomUUID();
    const key = trackKey(counterDefinition.buildKey(id));
    const written = await redisSet(redis, counterDefinition, { count: 1, firstAttempt: 9 }, id);
    expect(written.isOk()).toBe(true);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(counterDefinition.ttlSeconds);
  });

  it('rejects a schema-invalid value with a validation error', async () => {
    const id = crypto.randomUUID();
    const result = await redisSet(redis, wordDefinition, 'ab', id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('writes nothing when the value fails the schema', async () => {
    const id = crypto.randomUUID();
    const result = await redisSet(redis, wordDefinition, 'ab', id);
    expect(result.isErr()).toBe(true);
    expect(await redis.get(wordDefinition.buildKey(id))).toBeNull();
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisSet(
      unreachableRedis,
      counterDefinition,
      { count: 1, firstAttempt: 9 },
      crypto.randomUUID()
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('redisDel', () => {
  it('removes the key', async () => {
    const id = crypto.randomUUID();
    trackKey(counterDefinition.buildKey(id));
    const written = await redisSet(redis, counterDefinition, { count: 1, firstAttempt: 9 }, id);
    expect(written.isOk()).toBe(true);
    const deleted = await redisDel(redis, counterDefinition, id);
    expect(deleted.isOk()).toBe(true);
    const read = await redisGet(redis, counterDefinition, id);
    expect(read._unsafeUnwrap()).toBeNull();
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisDel(unreachableRedis, counterDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
