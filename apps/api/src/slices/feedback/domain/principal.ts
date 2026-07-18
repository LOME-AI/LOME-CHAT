import type { Principal } from '../../../lib/context/index.js';

/**
 * The caller's identity, taken ONLY from the pipeline principal — never from
 * client input. POST /feedback is `session`-class, so the authorizer guarantees
 * a full principal before the handler runs; anything else reaching this
 * function is a composition defect (throw → 500), not an expected error.
 */
export function callerUserId(principal: Principal): string {
  if (principal.kind !== 'full') {
    throw new Error('feedback: session route reached without a full principal');
  }
  return principal.claims.userId;
}
