import { ResultAsync, err, ok } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { MembershipRevoker, RealtimeBroadcast } from '../ports/index.js';

export interface EvictionDeps {
  readonly revoker: MembershipRevoker;
  readonly realtime: RealtimeBroadcast;
}

/**
 * The membership-change eviction pair: delete the Redis membership-cache
 * entry (so the verifier's next check goes back to the database) and close
 * the principal's sockets on the conversation DO. Runs post-commit; every
 * principal is attempted even after a failure (a half-evicted set must not
 * leave the remainder live), and the first error is surfaced for the route
 * to log. Recovery is in-mechanism: the cache TTL and broadcast-time
 * revalidation bound any missed eviction.
 */
export function evictPrincipals(
  deps: EvictionDeps,
  conversationId: string,
  principalIds: readonly string[]
): ResultAsync<void, DomainError> {
  return new ResultAsync(
    (async () => {
      let firstError: DomainError | null = null;
      for (const principalId of principalIds) {
        const invalidated = await deps.revoker.invalidate(conversationId, principalId);
        if (invalidated.isErr() && firstError === null) firstError = invalidated.error;
        const evicted = await deps.realtime.evict(conversationId, principalId);
        if (evicted.isErr() && firstError === null) firstError = evicted.error;
      }
      return firstError === null ? ok(undefined) : err(firstError);
    })()
  );
}
