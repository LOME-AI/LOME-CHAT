import { createConversationsStores } from '../slices/conversations/index.js';
import type { DbWriter } from '../lib/idempotency/index.js';
import type { LinkResolutionPort } from '../slices/identity/index.js';

/**
 * The composition-root adapter behind identity's LinkResolutionPort, bound to
 * the conversations barrel's shared-link store. Liveness is enforced lazily
 * at read, mirroring the public share read exactly: missing, revoked, and
 * expired all answer null (no oracle), and expiry is inclusive of the exact
 * instant — a link expiring at `now` is already gone. Only an unanswerable
 * store surfaces on the error channel, so authorization fails closed on an
 * outage instead of mistaking it for a dead link.
 */
export function createLinkResolutionAdapter(
  db: DbWriter,
  now: () => Date = () => new Date()
): LinkResolutionPort {
  return {
    resolveLinkCredential(linkPublicKey) {
      return createConversationsStores(db)
        .sharedLinks.byPublicKey(linkPublicKey)
        .map((link) => {
          if (link === null) return null;
          if (link.revokedAt !== null) return null;
          if (link.expiresAt !== null && link.expiresAt.getTime() <= now().getTime()) return null;
          return { linkId: link.id, conversationId: link.conversationId };
        });
    },
  };
}
