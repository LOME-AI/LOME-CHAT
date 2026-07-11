import { okAsync } from '../../../lib/result/index.js';
import { resolveLinkGuestPrincipal } from '../../identity/index.js';
import type { Principal } from '../../../lib/context/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { LinkResolutionPort } from '../../identity/index.js';
import type { ConversationsStores, MemberRecord } from '../ports/index.js';

/**
 * The client-presented shared-link credential (base64 link public key). The
 * HTTP route-class matrix admits no link-guest principal, so a guest-reachable
 * conversation read is a `public` route that resolves the credential itself and
 * authorizes by typed match — the same seam media presign uses.
 */
export const LINK_CREDENTIAL_HEADER = 'x-link-public-key';

/**
 * The authorized caller of a conversation read. A link guest carries the
 * conversation its credential resolved to, so the route can reject a guest of
 * one conversation pointing its credential at another (the typed match); the
 * domain reads use only `userId` / `linkId` and gate on the active member row.
 */
export type ConversationCaller =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'linkGuest'; readonly linkId: string; readonly conversationId: string };

export interface ResolveConversationCallerArgs {
  readonly principal: Principal;
  readonly linkCredential: string | undefined;
  readonly linkResolution: LinkResolutionPort;
}

/**
 * Resolves a guest-reachable conversation read's caller: a full session wins
 * outright; otherwise a presented link credential may resolve to a link guest
 * (carrying the conversation it grants). `null` means unauthenticated — no
 * session and no live credential (a malformed or dead credential degrades to
 * `null`, never an error). This does the typed conversation match at the route,
 * and the active-member gate is a SEPARATE check (the link-resolution port sees
 * only `shared_links` liveness, never the member row's `leftAt`).
 */
export function resolveConversationCaller(
  args: ResolveConversationCallerArgs
): ResultAsync<ConversationCaller | null, DomainError> {
  if (args.principal.kind === 'full') {
    return okAsync({ kind: 'user', userId: args.principal.claims.userId });
  }
  if (args.linkCredential === undefined) {
    return okAsync(null);
  }
  return resolveLinkGuestPrincipal({
    port: args.linkResolution,
    credential: args.linkCredential,
  }).map((resolution) =>
    resolution.kind === 'link-guest'
      ? { kind: 'linkGuest', linkId: resolution.linkId, conversationId: resolution.conversationId }
      : null
  );
}

/**
 * The caller's active `conversation_members` row (null when they hold none):
 * a user by `userId`, a link guest by `linkId`. This is the single membership
 * gate every guest-reachable read shares — a revoked guest (its row marked
 * left) resolves to `null` here and the read answers the indistinguishable
 * not-found, so link liveness alone never admits a departed guest.
 */
export function resolveCallerMember(
  stores: ConversationsStores,
  conversationId: string,
  caller: ConversationCaller
): ResultAsync<MemberRecord | null, DomainError> {
  return caller.kind === 'user'
    ? stores.members.activeByUser(conversationId, caller.userId)
    : stores.members
        .activeLinkGuest(conversationId, caller.linkId)
        .map((guest) => (guest === null ? null : guest.member));
}

/**
 * The caller's decryption public key IF they are an active member (null
 * otherwise): a user's `users.publicKey`, a link guest's
 * `sharedLinks.linkPublicKey`. Confirms membership and yields the key in one
 * step — the keychain read wraps its epoch material against it.
 */
export function resolveCallerPublicKey(
  stores: ConversationsStores,
  conversationId: string,
  caller: ConversationCaller
): ResultAsync<Uint8Array | null, DomainError> {
  if (caller.kind === 'user') {
    return stores.members.activeByUser(conversationId, caller.userId).andThen((member) => {
      if (member === null) return okAsync<Uint8Array | null, DomainError>(null);
      return stores.users.byId(caller.userId).map((user) => {
        if (user === null) {
          throw new Error('conversations: no users row for an authenticated principal');
        }
        return user.publicKey;
      });
    });
  }
  return stores.members
    .activeLinkGuest(conversationId, caller.linkId)
    .map((guest) => (guest === null ? null : guest.publicKey));
}
