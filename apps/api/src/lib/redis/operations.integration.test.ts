import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineKey } from './define-key.js';
import {
  redisDel,
  redisGet,
  redisGetDel,
  redisIncr,
  redisMGet,
  redisMGetEntry,
  redisSet,
  redisSetNx,
  redisTtl,
} from './operations.js';

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

describe('redisGetDel', () => {
  it('returns null for a missing key', async () => {
    const result = await redisGetDel(redis, counterDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('returns the stored value validated through the schema and removes the key', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(counterDefinition.buildKey(id)), { count: 4, firstAttempt: 8 });
    const result = await redisGetDel(redis, counterDefinition, id);
    expect(result._unsafeUnwrap()).toEqual({ count: 4, firstAttempt: 8 });
    expect(await redis.get(counterDefinition.buildKey(id))).toBeNull();
  });

  it('surfaces a validation error when the stored value fails the schema', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(counterDefinition.buildKey(id)), { wrong: true });
    const result = await redisGetDel(redis, counterDefinition, id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisGetDel(unreachableRedis, counterDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('lets exactly one of two racing callers win the value', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(counterDefinition.buildKey(id)), { count: 7, firstAttempt: 1 });
    const [first, second] = await Promise.all([
      redisGetDel(redis, counterDefinition, id),
      redisGetDel(redis, counterDefinition, id),
    ]);
    const values = [first._unsafeUnwrap(), second._unsafeUnwrap()];
    const winners = values.filter((value) => value !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual({ count: 7, firstAttempt: 1 });
  });
});

const tallyDefinition = defineKey({
  schema: z.number(),
  ttlSeconds: 60,
  buildKey: (id: string) => `${PREFIX}:tally:${id}`,
});

describe('redisIncr', () => {
  it('returns 1 when the key did not exist', async () => {
    const id = crypto.randomUUID();
    trackKey(tallyDefinition.buildKey(id));
    const result = await redisIncr(redis, tallyDefinition, id);
    expect(result._unsafeUnwrap()).toBe(1);
  });

  it('returns the post-increment count on repeated calls', async () => {
    const id = crypto.randomUUID();
    trackKey(tallyDefinition.buildKey(id));
    const seeded = await redisIncr(redis, tallyDefinition, id);
    seeded._unsafeUnwrap();
    const second = await redisIncr(redis, tallyDefinition, id);
    expect(second._unsafeUnwrap()).toBe(2);
  });

  it('applies the definition ttlSeconds when the key is created', async () => {
    const id = crypto.randomUUID();
    const key = trackKey(tallyDefinition.buildKey(id));
    const seeded = await redisIncr(redis, tallyDefinition, id);
    seeded._unsafeUnwrap();
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(tallyDefinition.ttlSeconds);
  });

  it('never extends the ttl on subsequent increments', async () => {
    const id = crypto.randomUUID();
    const key = trackKey(tallyDefinition.buildKey(id));
    const seeded = await redisIncr(redis, tallyDefinition, id);
    seeded._unsafeUnwrap();
    await redis.expire(key, 5);
    const advanced = await redisIncr(redis, tallyDefinition, id);
    advanced._unsafeUnwrap();
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });

  it('counts N concurrent increments as exactly N', async () => {
    const id = crypto.randomUUID();
    trackKey(tallyDefinition.buildKey(id));
    const parallelism = 10;
    const results = await Promise.all(
      Array.from({ length: parallelism }, () => redisIncr(redis, tallyDefinition, id))
    );
    const counts = results.map((result) => result._unsafeUnwrap()).toSorted((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: parallelism }, (_, position) => position + 1));
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisIncr(unreachableRedis, tallyDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('redisSetNx', () => {
  it('claims a missing key and reports the claim won', async () => {
    const id = crypto.randomUUID();
    trackKey(counterDefinition.buildKey(id));
    const result = await redisSetNx(redis, counterDefinition, { count: 1, firstAttempt: 2 }, id);
    expect(result._unsafeUnwrap()).toBe(true);
    const read = await redisGet(redis, counterDefinition, id);
    expect(read._unsafeUnwrap()).toEqual({ count: 1, firstAttempt: 2 });
  });

  it('reports a lost claim without overwriting the existing value', async () => {
    const id = crypto.randomUUID();
    trackKey(counterDefinition.buildKey(id));
    const seeded = await redisSetNx(redis, counterDefinition, { count: 1, firstAttempt: 2 }, id);
    seeded._unsafeUnwrap();
    const second = await redisSetNx(redis, counterDefinition, { count: 9, firstAttempt: 9 }, id);
    expect(second._unsafeUnwrap()).toBe(false);
    const read = await redisGet(redis, counterDefinition, id);
    expect(read._unsafeUnwrap()).toEqual({ count: 1, firstAttempt: 2 });
  });

  it('lets exactly one of two racing claimants win', async () => {
    const id = crypto.randomUUID();
    trackKey(counterDefinition.buildKey(id));
    const [first, second] = await Promise.all([
      redisSetNx(redis, counterDefinition, { count: 1, firstAttempt: 1 }, id),
      redisSetNx(redis, counterDefinition, { count: 2, firstAttempt: 2 }, id),
    ]);
    const wins = [first._unsafeUnwrap(), second._unsafeUnwrap()].filter(Boolean);
    expect(wins).toHaveLength(1);
  });

  it('applies the definition ttlSeconds to a won claim', async () => {
    const id = crypto.randomUUID();
    const key = trackKey(counterDefinition.buildKey(id));
    const seeded = await redisSetNx(redis, counterDefinition, { count: 1, firstAttempt: 2 }, id);
    seeded._unsafeUnwrap();
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(counterDefinition.ttlSeconds);
  });

  it('rejects a schema-invalid value with a validation error', async () => {
    const id = crypto.randomUUID();
    const result = await redisSetNx(redis, wordDefinition, 'ab', id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisSetNx(
      unreachableRedis,
      counterDefinition,
      { count: 1, firstAttempt: 2 },
      crypto.randomUUID()
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

const numberDefinition = defineKey({
  schema: z.coerce.number(),
  ttlSeconds: 60,
  buildKey: (id: string) => `${PREFIX}:number:${id}`,
});

/**
 * Wraps a Redis client so `get`/`mget` invocations are counted, proving how
 * many network round-trips an operation issues. Spying on the Upstash client's
 * methods directly is unreliable (they are accessor-defined).
 */
function countingRedis(target: Redis): { redis: Redis; roundTrips: () => number } {
  let count = 0;
  const proxy = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if ((property === 'get' || property === 'mget') && typeof value === 'function') {
        return (...args: unknown[]): unknown => {
          count += 1;
          return (value as (...callArgs: unknown[]) => unknown).apply(object, args);
        };
      }
      return value;
    },
  });
  return { redis: proxy, roundTrips: () => count };
}

describe('redisMGet', () => {
  it('fetches heterogeneous keys in a single round-trip preserving order', async () => {
    const wordId = crypto.randomUUID();
    const numberId = crypto.randomUUID();
    trackKey(wordDefinition.buildKey(wordId));
    trackKey(numberDefinition.buildKey(numberId));
    const wordWritten = await redisSet(redis, wordDefinition, 'hello', wordId);
    wordWritten._unsafeUnwrap();
    const numberWritten = await redisSet(redis, numberDefinition, 42, numberId);
    numberWritten._unsafeUnwrap();
    const counting = countingRedis(redis);
    const result = await redisMGet(counting.redis, [
      redisMGetEntry(wordDefinition, wordId),
      redisMGetEntry(numberDefinition, numberId),
    ]);
    expect(result._unsafeUnwrap()).toEqual(['hello', 42]);
    expect(counting.roundTrips()).toBe(1);
  });

  it('returns null for a missing key while parsing present siblings', async () => {
    const wordId = crypto.randomUUID();
    trackKey(wordDefinition.buildKey(wordId));
    const written = await redisSet(redis, wordDefinition, 'world', wordId);
    written._unsafeUnwrap();
    const result = await redisMGet(redis, [
      redisMGetEntry(wordDefinition, wordId),
      redisMGetEntry(numberDefinition, crypto.randomUUID()),
    ]);
    expect(result._unsafeUnwrap()).toEqual(['world', null]);
  });

  it('surfaces a validation error when a stored value fails its schema', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(wordDefinition.buildKey(id)), 'ab');
    const result = await redisMGet(redis, [redisMGetEntry(wordDefinition, id)]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisMGet(unreachableRedis, [
      redisMGetEntry(wordDefinition, crypto.randomUUID()),
      redisMGetEntry(numberDefinition, crypto.randomUUID()),
    ]);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('redisTtl', () => {
  it('returns null for a missing key', async () => {
    const result = await redisTtl(redis, counterDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('returns the remaining seconds for a live key', async () => {
    const id = crypto.randomUUID();
    trackKey(counterDefinition.buildKey(id));
    const seeded = await redisSet(redis, counterDefinition, { count: 1, firstAttempt: 2 }, id);
    seeded._unsafeUnwrap();
    const result = await redisTtl(redis, counterDefinition, id);
    const remaining = result._unsafeUnwrap();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(counterDefinition.ttlSeconds);
  });

  it('returns null for a key without an expiry', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(counterDefinition.buildKey(id)), { count: 1, firstAttempt: 2 });
    const result = await redisTtl(redis, counterDefinition, id);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisTtl(unreachableRedis, counterDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
