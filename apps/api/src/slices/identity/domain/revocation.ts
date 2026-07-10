import { okAsync } from '../../../lib/result/index.js';
import { redisGet } from '../../../lib/redis/index.js';
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
 */
export function checkSessionLiveness(
  redis: Parameters<SessionRevocationCheck>[0],
  inputs: SessionLivenessInputs
): ReturnType<SessionRevocationCheck> {
  return redisGet(redis, IDENTITY_KEYS.sessionActive, inputs.userId, inputs.sessionId).andThen(
    (active) => {
      if (active === null) return okAsync('revoked' as const);
      return redisGet(redis, IDENTITY_KEYS.passwordChangedAt, inputs.userId).map((changedAt) =>
        changedAt !== null && inputs.createdAt < changedAt
          ? ('revoked' as const)
          : ('active' as const)
      );
    }
  );
}

/**
 * The pipeline's injected session-liveness check (composed at the entry
 * layer; the middleware never imports this slice). Delegates to
 * `checkSessionLiveness` so the pipeline and the broadcast backstop share one
 * implementation.
 */
export const checkSessionRevocation: SessionRevocationCheck = (redis, claims) =>
  checkSessionLiveness(redis, claims);
