import { z } from 'zod';
import { and, eq, isNull, or } from 'drizzle-orm';
import { conversationMembers } from '@hushbox/db';
import { defineKey, redisDel, redisGet, redisSet } from '../../../lib/redis/index.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { MembershipCache, MembershipSource, MembershipState } from '@hushbox/realtime';
import type { DomainError } from '../../../lib/errors/index.js';
import type { MembershipRevoker } from '../ports/revocation.js';

/**
 * The broadcast-time membership verifier composition: a short-TTL Redis
 * cache of AUTHORITATIVE membership over a Drizzle source (active membership
 * = `leftAt IS NULL`). Window sizing (the design-ledger constraint is
 * freshness ≪ cache TTL):
 *
 * - `MEMBERSHIP_CACHE_TTL_SECONDS` (30 s) — the Redis entry. Revocation
 *   deletes the entry eagerly, so the TTL only bounds staleness when that
 *   delete itself failed.
 * - `MEMBERSHIP_FRESHNESS_MS` (2 s) — the verifier's in-memory reuse window;
 *   a token stream re-consults Redis at most every 2 s instead of per frame.
 *   15× under the TTL, so the memo can never outlive the cache entry.
 * - `MEMBERSHIP_LAST_KNOWN_GOOD_MS` (15 s) — the Redis/DB-failure delivery
 *   window; beyond it delivery pauses rather than risk plaintext to an
 *   evicted member. A 'revoked' decision never un-revokes on failure.
 */
export const MEMBERSHIP_CACHE_TTL_SECONDS = 30;
export const MEMBERSHIP_FRESHNESS_MS = 2000;
export const MEMBERSHIP_LAST_KNOWN_GOOD_MS = 15_000;

const membershipStateSchema: z.ZodType<MembershipState> = z.enum(['member', 'revoked']);

export const membershipCacheKey = defineKey({
  schema: membershipStateSchema,
  ttlSeconds: MEMBERSHIP_CACHE_TTL_SECONDS,
  buildKey: (conversationId: string, principalId: string) =>
    `conversations:membership:${conversationId}:${principalId}`,
});

/**
 * `MembershipCache` over the typed key-registry entry. The contract requires
 * rejection on backend failure (the verifier's fail-closed fallback depends
 * on it), so Result errors are rethrown here. The registry entry's TTL is
 * authoritative for writes; the verifier is composed with the same constant.
 */
/** The cache contract wants a rejection; DomainError is a value, so wrap it. */
function cacheUnavailable(error: DomainError): Error {
  return new Error(`membership cache unavailable: ${error.code}`, { cause: error });
}

export function createRedisMembershipCache(redis: Redis): MembershipCache {
  return {
    async get(conversationId: string, principalId: string): Promise<MembershipState | null> {
      const result = await redisGet(redis, membershipCacheKey, conversationId, principalId);
      if (result.isErr()) throw cacheUnavailable(result.error);
      return result.value;
    },
    async set(conversationId: string, principalId: string, state: MembershipState): Promise<void> {
      const result = await redisSet(redis, membershipCacheKey, state, conversationId, principalId);
      if (result.isErr()) throw cacheUnavailable(result.error);
    },
  };
}

/** Authoritative membership: an active row for the principal as user or link. */
export function createDbMembershipSource(db: Database): MembershipSource {
  return {
    async isMember(conversationId: string, principalId: string): Promise<boolean> {
      const rows = await db
        .select({ id: conversationMembers.id })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            isNull(conversationMembers.leftAt),
            or(
              eq(conversationMembers.userId, principalId),
              eq(conversationMembers.linkId, principalId)
            )
          )
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}

/** The eager cache invalidation paired with `RealtimeBroadcast.evict`. */
export function createMembershipRevoker(redis: Redis): MembershipRevoker {
  return {
    invalidate: (conversationId, principalId) =>
      redisDel(redis, membershipCacheKey, conversationId, principalId),
  };
}
