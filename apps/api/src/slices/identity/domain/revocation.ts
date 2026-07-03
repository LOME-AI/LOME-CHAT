import { okAsync } from '../../../lib/result/index.js';
import { redisGet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import type { SessionRevocationCheck } from '../../../lib/context/index.js';

/**
 * The pipeline's injected session-liveness check (composed at the entry
 * layer; the middleware never imports this slice). Two conditions revoke:
 * the sessionActive key is gone (logout, expiry, or admin revocation), or
 * the cookie was issued before the password last changed (the pw-changed
 * watermark is written by the password-change/recovery flows).
 */
export const checkSessionRevocation: SessionRevocationCheck = (redis, claims) =>
  redisGet(redis, IDENTITY_KEYS.sessionActive, claims.userId, claims.sessionId).andThen(
    (active) => {
      if (active === null) return okAsync('revoked' as const);
      return redisGet(redis, IDENTITY_KEYS.passwordChangedAt, claims.userId).map((changedAt) =>
        changedAt !== null && claims.createdAt < changedAt
          ? ('revoked' as const)
          : ('active' as const)
      );
    }
  );
