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

interface Decision {
  state: MembershipState;
  verifiedAt: number;
}

export function createCachedMembershipVerifier(
  options: CachedMembershipVerifierOptions
): MembershipVerifier {
  const { cache, source, freshnessMs, lastKnownGoodMs, cacheTtlSeconds, now } = options;
  const memo = new Map<string, Decision>();

  function fallback(previous: Decision | undefined): MembershipDecision {
    if (previous?.state === 'revoked') {
      return 'revoked';
    }
    if (previous !== undefined && now() - previous.verifiedAt < lastKnownGoodMs) {
      return 'member';
    }
    return 'pause';
  }

  return {
    async verify(conversationId: string, principalId: string): Promise<MembershipDecision> {
      const key = `${conversationId}:${principalId}`;
      const previous = memo.get(key);
      if (previous !== undefined && now() - previous.verifiedAt < freshnessMs) {
        return previous.state;
      }

      let state: MembershipState | null;
      try {
        state = await cache.get(conversationId, principalId);
      } catch {
        return fallback(previous);
      }

      if (state === null) {
        let isMember: boolean;
        try {
          isMember = await source.isMember(conversationId, principalId);
        } catch {
          return fallback(previous);
        }
        state = isMember ? 'member' : 'revoked';
        try {
          await cache.set(conversationId, principalId, state, cacheTtlSeconds);
        } catch {
          // Write-back is best-effort: the decision below is already
          // authoritative; the next stale verify simply re-misses.
        }
      }

      memo.set(key, { state, verifiedAt: now() });
      return state;
    },
  };
}
