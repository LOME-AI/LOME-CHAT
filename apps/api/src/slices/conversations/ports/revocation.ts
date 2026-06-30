import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Invalidates the broadcast-time membership cache for one principal in one
 * conversation. Paired with `RealtimeBroadcast.evict` on every membership
 * change: the cache delete forces the verifier's next check back to the
 * authoritative source, the eviction closes the live sockets. Deleting (not
 * writing 'revoked') keeps the cache a pure cache — a TTL lapse can never
 * un-revoke, and a re-added member is readmitted by the DB recheck.
 */
export interface MembershipRevoker {
  invalidate(conversationId: string, principalId: string): ResultAsync<void, DomainError>;
}
