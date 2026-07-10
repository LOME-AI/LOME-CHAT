import { createCachedLiveness } from './liveness.js';
import type { LivenessDecision, LivenessOutcome } from './liveness.js';

/**
 * Broadcast-time membership revalidation (the no-zombie-sockets guarantee).
 *
 * The verifier answers per (conversationId, principalId): a short-TTL cache
 * of AUTHORITATIVE membership with a DB recheck on miss — never an expiring
 * "revoked" marker, whose TTL lapse would un-revoke. On infrastructure
 * failure delivery fails closed with a bounded last-known-good window:
 * a member verified within `lastKnownGoodMs` keeps receiving; beyond it
 * delivery pauses rather than risk plaintext to an evicted member. A failure
 * never un-revokes. The cache and source implementations are injected
 * (Redis/Drizzle live in the worker — packages never import apps).
 *
 * The memo/fallback discipline itself lives in the shared `createCachedLiveness`
 * core (liveness.ts); this module only maps membership's cache/source onto it.
 */

export type MembershipState = 'member' | 'revoked';

/** 'pause' = identity unknown right now; skip delivery but keep the socket. */
export type MembershipDecision = MembershipState | 'pause';

export interface MembershipVerifier {
  verify(conversationId: string, principalId: string): Promise<MembershipDecision>;
}

export interface MembershipCache {
  /** Resolves null on miss; rejects when the cache backend is unreachable. */
  get(conversationId: string, principalId: string): Promise<MembershipState | null>;
  set(
    conversationId: string,
    principalId: string,
    state: MembershipState,
    ttlSeconds: number
  ): Promise<void>;
}

export interface MembershipSource {
  /** Authoritative membership read; rejects when the store is unreachable. */
  isMember(conversationId: string, principalId: string): Promise<boolean>;
}

export interface CachedMembershipVerifierOptions {
  readonly cache: MembershipCache;
  readonly source: MembershipSource;
  /** Reuse window for an in-memory decision before re-consulting the cache. */
  readonly freshnessMs: number;
  /** Failure window: a 'member' decision older than this pauses delivery. */
  readonly lastKnownGoodMs: number;
  /** TTL written back to the cache after a source recheck. */
  readonly cacheTtlSeconds: number;
  readonly now: () => number;
}

function membershipOf(decision: LivenessDecision): MembershipDecision {
  if (decision === 'live') return 'member';
  if (decision === 'dead') return 'revoked';
  return 'pause';
}

export function createCachedMembershipVerifier(
  options: CachedMembershipVerifierOptions
): MembershipVerifier {
  const { cache, source, freshnessMs, lastKnownGoodMs, cacheTtlSeconds, now } = options;
  const cached = createCachedLiveness({ freshnessMs, lastKnownGoodMs, now });

  return {
    async verify(conversationId: string, principalId: string): Promise<MembershipDecision> {
      const decision = await cached.decide(`${conversationId}:${principalId}`, {
        readCache: async (): Promise<LivenessOutcome | null> => {
          const state = await cache.get(conversationId, principalId);
          if (state === null) return null;
          return state === 'member' ? 'live' : 'dead';
        },
        readSource: async (): Promise<LivenessOutcome> => {
          const isMember = await source.isMember(conversationId, principalId);
          return isMember ? 'live' : 'dead';
        },
        writeCache: (outcome) =>
          cache.set(
            conversationId,
            principalId,
            outcome === 'live' ? 'member' : 'revoked',
            cacheTtlSeconds
          ),
      });
      return membershipOf(decision);
    },
  };
}
