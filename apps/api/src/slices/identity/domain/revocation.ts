import { redisMGet, redisMGetEntry } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import type { SessionRevocationCheck } from '../../../lib/context/index.js';

/**
 * The three fields the session-liveness read needs, a subset of `SessionClaims`
 * — so the broadcast-time backstop can validate a socket's session snapshot
 * without carrying the full cookie shape.
 */
export interface SessionLivenessInputs {
  readonly userId: string;
  readonly sessionId: string;
  readonly createdAt: number;
}

/**
 * The single source of session-revocation truth (published so the realtime
 * broadcast-time session-liveness backstop reuses it rather than reimplementing
 * the semantics). Two conditions revoke: the sessionActive key is gone (logout,
 * expiry, or admin revocation), or the cookie was issued before the password
 * last changed (the pw-changed watermark is written by the
 * password-change/recovery flows).
 *
 * Both keys are fetched in ONE round-trip: on `'*'` across many workers a second
 * sequential GET doubles the load on the single Redis HTTP proxy. The decision
 * is unchanged — an absent sessionActive still revokes regardless of the
 * pw-changed value, any read failure still fails closed with an unavailable
 * error (the caller treats every error as a revoked session).
 */
export function checkSessionLiveness(
  redis: Parameters<SessionRevocationCheck>[0],
  inputs: SessionLivenessInputs
): ReturnType<SessionRevocationCheck> {
  return redisMGet(redis, [
    redisMGetEntry(IDENTITY_KEYS.sessionActive, inputs.userId, inputs.sessionId),
    redisMGetEntry(IDENTITY_KEYS.passwordChangedAt, inputs.userId),
  ]).map(([active, changedAt]) => {
    if (active === null) return 'revoked' as const;
    return changedAt !== null && inputs.createdAt < changedAt
      ? ('revoked' as const)
      : ('active' as const);
  });
}

/**
 * The pipeline's injected session-liveness check (composed at the entry
 * layer; the middleware never imports this slice). Delegates to
 * `checkSessionLiveness` so the pipeline and the broadcast backstop share one
 * implementation.
 */
export const checkSessionRevocation: SessionRevocationCheck = (redis, claims) =>
  checkSessionLiveness(redis, claims);
