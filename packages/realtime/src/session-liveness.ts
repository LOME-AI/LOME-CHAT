import { createCachedLiveness } from './liveness.js';
import type { LivenessOutcome } from './liveness.js';

/**
 * Broadcast-time SESSION-liveness revalidation — the correctness backstop that
 * closes the push-eviction under-inclusion window (a socket held continuously
 * past the active-room-set TTL that an all-session revocation would otherwise
 * miss). It runs ALONGSIDE the membership check (revocation.ts): a broadcast
 * reaches a socket only if its session is still valid AND its principal is
 * still a member.
 *
 * The authoritative session state (the `sessionActive` key plus the
 * password-changed watermark) lives in the identity slice; this verifier is
 * injected that read as a `SessionSource` (packages never import apps). It has
 * no separate cache tier because the source is already Redis — a
 * Redis-in-front-of-Redis layer would buy nothing — so the shared
 * `createCachedLiveness` core's in-memory memo is the cache: it bounds the
 * source to at most one read per `freshnessMs` per session (never per token),
 * with the same fail-closed last-known-good window the membership verifier uses.
 */

/** Authoritative session state: live, or revoked (logged out / password changed). */
export type SessionState = 'live' | 'revoked';

/** 'pause' = the session's state is unknown right now; skip delivery, keep the socket. */
export type SessionDecision = SessionState | 'pause';

/** The per-socket session identity a broadcast is validated against. */
export interface SessionSnapshot {
  readonly userId: string;
  readonly sessionId: string;
  /** The authorizing cookie's issue time, compared against the password-changed watermark. */
  readonly sessionCreatedAt: number;
}

export interface SessionSource {
  /**
   * Authoritative session liveness (identity's revocation semantics). REJECTS
   * when the backing store is unreachable — the verifier's fail-closed fallback
   * depends on it (a rejection pauses, never delivers).
   */
  liveness(snapshot: SessionSnapshot): Promise<SessionState>;
}

export interface SessionVerifier {
  verify(snapshot: SessionSnapshot): Promise<SessionDecision>;
}

export interface CachedSessionVerifierOptions {
  readonly source: SessionSource;
  /** In-memory reuse window: at most one source read per session per window. */
  readonly freshnessMs: number;
  /** Failure window: a live decision older than this pauses delivery. */
  readonly lastKnownGoodMs: number;
  readonly now: () => number;
}

export function createCachedSessionVerifier(
  options: CachedSessionVerifierOptions
): SessionVerifier {
  const { source, freshnessMs, lastKnownGoodMs, now } = options;
  const cached = createCachedLiveness({ freshnessMs, lastKnownGoodMs, now });

  return {
    async verify(snapshot: SessionSnapshot): Promise<SessionDecision> {
      const key = `${snapshot.userId}:${snapshot.sessionId}:${String(snapshot.sessionCreatedAt)}`;
      const decision = await cached.decide(key, {
        // No separate cache tier: the source IS Redis, so the memo above is
        // the only cache. Every memo miss reads the authoritative source.
        readCache: () => Promise.resolve(null),
        readSource: async (): Promise<LivenessOutcome> => {
          const state = await source.liveness(snapshot);
          return state === 'live' ? 'live' : 'dead';
        },
        writeCache: () => Promise.resolve(),
      });
      if (decision === 'live') return 'live';
      if (decision === 'dead') return 'revoked';
      return 'pause';
    },
  };
}
