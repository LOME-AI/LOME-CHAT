import type { Principal, SessionClaims } from '../../../lib/context/index.js';

/**
 * Narrows the pipeline's principal on a `session`-class route. The authorizer
 * guarantees a full principal before the handler runs, so any other kind here
 * is a pipeline-order defect — thrown, not returned (500 + Sentry by the
 * assembly's error mapping).
 */
export function fullSessionClaims(principal: Principal): SessionClaims {
  if (principal.kind !== 'full') {
    throw new Error('notifications: session-class route reached without a full principal');
  }
  return principal.claims;
}
