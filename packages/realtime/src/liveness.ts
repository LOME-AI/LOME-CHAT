/**
 * The shared broadcast-time revalidation core: a keyed in-memory memo over a
 * cache→source probe with a bounded last-known-good fail-closed window. Both
 * the membership verifier (revocation.ts) and the session-liveness verifier
 * (session-liveness.ts) are thin adapters over this one implementation, so the
 * memo/fallback discipline that keeps plaintext from a revoked target lives in
 * exactly one place.
 *
 * Two windows, sized by the caller:
 * - `freshnessMs` — the in-memory reuse window: a hot token stream re-probes at
 *   most once per window per key instead of once per frame, so a broadcast is
 *   never an unbounded backend read per token per socket.
 * - `lastKnownGoodMs` — the fail-closed window: when the probe throws (backend
 *   unreachable) a target verified within the window keeps receiving; beyond it
 *   delivery PAUSES rather than risk plaintext to a possibly-revoked target. A
 *   'dead' decision never un-revokes on failure regardless of the window.
 */

export type LivenessOutcome = 'live' | 'dead';

/** 'pause' = the target's state is unknown right now; skip delivery, keep the socket. */
export type LivenessDecision = LivenessOutcome | 'pause';

/**
 * The per-key cache→source probe. `readCache`/`readSource` REJECT when their
 * backend is unreachable (the fail-closed fallback depends on it); `writeCache`
 * is best-effort and its rejection is swallowed.
 */
export interface LivenessProbe {
  /** Resolves the cached outcome or null on a miss; rejects when the cache is unreachable. */
  readCache(): Promise<LivenessOutcome | null>;
  /** Authoritative recheck on a miss; rejects when the source is unreachable. */
  readSource(): Promise<LivenessOutcome>;
  /** Write-back of a source recheck; best-effort. */
  writeCache(outcome: LivenessOutcome): Promise<void>;
}

export interface CachedLivenessOptions {
  readonly freshnessMs: number;
  readonly lastKnownGoodMs: number;
  readonly now: () => number;
}

export interface CachedLiveness {
  decide(key: string, probe: LivenessProbe): Promise<LivenessDecision>;
}

interface Decision {
  outcome: LivenessOutcome;
  verifiedAt: number;
}

export function createCachedLiveness(options: CachedLivenessOptions): CachedLiveness {
  const { freshnessMs, lastKnownGoodMs, now } = options;
  const memo = new Map<string, Decision>();

  function fallback(previous: Decision | undefined): LivenessDecision {
    if (previous?.outcome === 'dead') {
      return 'dead';
    }
    if (previous !== undefined && now() - previous.verifiedAt < lastKnownGoodMs) {
      return 'live';
    }
    return 'pause';
  }

  return {
    async decide(key: string, probe: LivenessProbe): Promise<LivenessDecision> {
      const previous = memo.get(key);
      if (previous !== undefined && now() - previous.verifiedAt < freshnessMs) {
        return previous.outcome;
      }

      let outcome: LivenessOutcome | null;
      try {
        outcome = await probe.readCache();
      } catch {
        return fallback(previous);
      }

      if (outcome === null) {
        try {
          outcome = await probe.readSource();
        } catch {
          return fallback(previous);
        }
        try {
          await probe.writeCache(outcome);
        } catch {
          // Write-back is best-effort: the decision below is already
          // authoritative; the next stale probe simply re-misses.
        }
      }

      memo.set(key, { outcome, verifiedAt: now() });
      return outcome;
    },
  };
}
