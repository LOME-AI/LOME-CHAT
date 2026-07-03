import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  users,
} from '@hushbox/db';
import { redisGet } from '../../../lib/redis/index.js';
import {
  MEMBERSHIP_CACHE_TTL_SECONDS,
  MEMBERSHIP_FRESHNESS_MS,
  MEMBERSHIP_LAST_KNOWN_GOOD_MS,
  createDbMembershipSource,
  createMembershipRevoker,
  createRedisMembershipCache,
  membershipCacheKey,
} from './membership.js';
import { composeMembershipVerifier } from './membership-verifier.js';
import type { MembershipSource } from '@hushbox/realtime';

// The realtime barrel transitively imports the workerd-only platform module;
// in node tests that platform seam is stubbed (the DO class itself is not
// under test here — the verifier composition is plain code).
vi.mock('cloudflare:workers', () => ({
  // Never instantiated here — the stub only satisfies `extends` at load time.
  DurableObject: class {
    constructor(protected readonly ctx: unknown) {}
  },
}));

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for membership tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
const createdRedisKeys: string[] = [];

function trackCacheKey(conversationId: string, principalId: string): void {
  createdRedisKeys.push(membershipCacheKey.buildKey(conversationId, principalId));
}

async function seedUser(): Promise<string> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@membership.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedConversationWithMember(userId: string): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(id);
  await db.insert(conversationMembers).values({
    conversationId: id,
    userId,
    privilege: 'owner',
    visibleFromEpoch: 1,
    acceptedAt: new Date(),
  });
  return id;
}

afterAll(async () => {
  if (createdRedisKeys.length > 0) await redis.del(...createdRedisKeys);
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('membership cache windows (design-ledger constraint)', () => {
  it('keeps the in-memory freshness window far below the cache TTL', () => {
    expect(MEMBERSHIP_FRESHNESS_MS).toBeLessThanOrEqual((MEMBERSHIP_CACHE_TTL_SECONDS * 1000) / 10);
  });

  it('bounds last-known-good below the cache TTL', () => {
    expect(MEMBERSHIP_LAST_KNOWN_GOOD_MS).toBeLessThan(MEMBERSHIP_CACHE_TTL_SECONDS * 1000);
  });
});

describe('createRedisMembershipCache', () => {
  it('returns null on a miss', async () => {
    const cache = createRedisMembershipCache(redis);
    expect(await cache.get(crypto.randomUUID(), crypto.randomUUID())).toBeNull();
  });

  it('round-trips a membership state', async () => {
    const cache = createRedisMembershipCache(redis);
    const conversationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    trackCacheKey(conversationId, principalId);
    await cache.set(conversationId, principalId, 'member', MEMBERSHIP_CACHE_TTL_SECONDS);
    expect(await cache.get(conversationId, principalId)).toBe('member');
  });

  it('rejects on get when the backend is unreachable (never silently un-revokes)', async () => {
    const cache = createRedisMembershipCache(unreachableRedis);
    await expect(cache.get('c', 'p')).rejects.toBeDefined();
  });

  it('rejects on set when the backend is unreachable', async () => {
    const cache = createRedisMembershipCache(unreachableRedis);
    await expect(cache.set('c', 'p', 'member', 1)).rejects.toBeDefined();
  });
});

describe('createDbMembershipSource', () => {
  it('answers true for an active member', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversationWithMember(userId);
    const source = createDbMembershipSource(db);
    expect(await source.isMember(conversationId, userId)).toBe(true);
  });

  it('answers false for a non-member', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversationWithMember(userId);
    const source = createDbMembershipSource(db);
    expect(await source.isMember(conversationId, crypto.randomUUID())).toBe(false);
  });

  it('answers false for a member who has left', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversationWithMember(userId);
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(inArray(conversationMembers.conversationId, [conversationId]));
    const source = createDbMembershipSource(db);
    expect(await source.isMember(conversationId, userId)).toBe(false);
  });
});

describe('composeMembershipVerifier', () => {
  function countingSource(inner: MembershipSource): MembershipSource & { calls: () => number } {
    let calls = 0;
    return {
      isMember: (conversationId, principalId) => {
        calls += 1;
        return inner.isMember(conversationId, principalId);
      },
      calls: () => calls,
    };
  }

  it('rechecks the database on a cache miss and caches the answer in redis', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversationWithMember(userId);
    trackCacheKey(conversationId, userId);
    const source = countingSource(createDbMembershipSource(db));
    const verifier = composeMembershipVerifier({
      cache: createRedisMembershipCache(redis),
      source,
    });
    expect(await verifier.verify(conversationId, userId)).toBe('member');
    expect(source.calls()).toBe(1);
    const cached = await redisGet(redis, membershipCacheKey, conversationId, userId);
    expect(cached._unsafeUnwrap()).toBe('member');
  });

  it('serves a repeat check inside the freshness window without re-consulting the source', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversationWithMember(userId);
    trackCacheKey(conversationId, userId);
    const source = countingSource(createDbMembershipSource(db));
    const verifier = composeMembershipVerifier({
      cache: createRedisMembershipCache(redis),
      source,
    });
    await verifier.verify(conversationId, userId);
    await verifier.verify(conversationId, userId);
    expect(source.calls()).toBe(1);
  });

  it('answers from the redis cache after the freshness window without a source recheck', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversationWithMember(userId);
    trackCacheKey(conversationId, userId);
    let now = 1_000_000;
    const source = countingSource(createDbMembershipSource(db));
    const verifier = composeMembershipVerifier({
      cache: createRedisMembershipCache(redis),
      source,
      now: () => now,
    });
    await verifier.verify(conversationId, userId);
    now += MEMBERSHIP_FRESHNESS_MS + 1;
    expect(await verifier.verify(conversationId, userId)).toBe('member');
    expect(source.calls()).toBe(1);
  });

  it('answers revoked for a removed member once the cache entry is invalidated', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversationWithMember(userId);
    trackCacheKey(conversationId, userId);
    let now = 1_000_000;
    const verifier = composeMembershipVerifier({
      cache: createRedisMembershipCache(redis),
      source: createDbMembershipSource(db),
      now: () => now,
    });
    expect(await verifier.verify(conversationId, userId)).toBe('member');

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(inArray(conversationMembers.conversationId, [conversationId]));
    const revoker = createMembershipRevoker(redis);
    const invalidated = await revoker.invalidate(conversationId, userId);
    invalidated._unsafeUnwrap();

    now += MEMBERSHIP_FRESHNESS_MS + 1;
    expect(await verifier.verify(conversationId, userId)).toBe('revoked');
  });

  it('keeps delivering inside the last-known-good window when the source fails', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversationWithMember(userId);
    trackCacheKey(conversationId, userId);
    let now = 1_000_000;
    let failing = false;
    const source: MembershipSource = {
      isMember: (c, p) => {
        if (failing) return Promise.reject(new Error('source down'));
        return createDbMembershipSource(db).isMember(c, p);
      },
    };
    const verifier = composeMembershipVerifier({
      cache: createRedisMembershipCache(redis),
      source,
      now: () => now,
    });
    expect(await verifier.verify(conversationId, userId)).toBe('member');

    failing = true;
    const invalidated = await createMembershipRevoker(redis).invalidate(conversationId, userId);
    invalidated._unsafeUnwrap();
    now += MEMBERSHIP_FRESHNESS_MS + 1;
    expect(await verifier.verify(conversationId, userId)).toBe('member');
  });

  it('pauses delivery beyond the last-known-good window when the source fails', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversationWithMember(userId);
    trackCacheKey(conversationId, userId);
    let now = 1_000_000;
    let failing = false;
    const source: MembershipSource = {
      isMember: (c, p) => {
        if (failing) return Promise.reject(new Error('source down'));
        return createDbMembershipSource(db).isMember(c, p);
      },
    };
    const verifier = composeMembershipVerifier({
      cache: createRedisMembershipCache(redis),
      source,
      now: () => now,
    });
    expect(await verifier.verify(conversationId, userId)).toBe('member');

    failing = true;
    const invalidated = await createMembershipRevoker(redis).invalidate(conversationId, userId);
    invalidated._unsafeUnwrap();
    now += MEMBERSHIP_LAST_KNOWN_GOOD_MS + 1;
    expect(await verifier.verify(conversationId, userId)).toBe('pause');
  });
});

describe('createMembershipRevoker', () => {
  it('deletes the cache entry so the next check rechecks the database', async () => {
    const conversationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    trackCacheKey(conversationId, principalId);
    const cache = createRedisMembershipCache(redis);
    await cache.set(conversationId, principalId, 'member', MEMBERSHIP_CACHE_TTL_SECONDS);
    const invalidated = await createMembershipRevoker(redis).invalidate(
      conversationId,
      principalId
    );
    invalidated._unsafeUnwrap();
    expect(await cache.get(conversationId, principalId)).toBeNull();
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await createMembershipRevoker(unreachableRedis).invalidate('c', 'p');
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
