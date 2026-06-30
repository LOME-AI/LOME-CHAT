import { match } from 'ts-pattern';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { notFoundError, validationError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  ContentItemReader,
  MediaTarget,
  MemberRef,
  MembershipReader,
  ShareReader,
} from '../ports/index.js';

/**
 * The two presign authorization paths.
 *
 * Member path: active conversation membership AND an epoch_members row for
 * the message's specific epoch. Membership alone would let a late-joiner
 * exfiltrate ciphertext from epochs they were never part of.
 *
 * Share carve-out: a valid shareId (unauthenticated; rate limiting is the
 * route's job) grants read for exactly that shared message's content items —
 * no membership, no epoch row. Without it, universal epoch-gating would
 * break shared messages containing media.
 *
 * Every deny is `not_found` (blind response — existence is never disclosed
 * to unauthorized callers); only an authorized caller learns the item is not
 * downloadable media (`validation`).
 */

export type PresignPrincipal =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'linkGuest'; readonly linkId: string }
  | { readonly kind: 'share'; readonly shareId: string };

export interface PresignAuthzDeps {
  contentItems: ContentItemReader;
  membership: MembershipReader;
  shares: ShareReader;
  now: () => Date;
}

const DOWNLOADABLE_CONTENT_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video']);

export function authorizePresign(
  principal: PresignPrincipal,
  contentItemId: string,
  deps: PresignAuthzDeps
): ResultAsync<{ storageKey: string }, DomainError> {
  return deps.contentItems.findMediaTarget(contentItemId).andThen((target) => {
    if (target === null) {
      return errAsync<{ storageKey: string }, DomainError>(notFoundError('content item not found'));
    }
    return principalAllows(principal, target, deps).andThen((allowed) => {
      if (!allowed) {
        return errAsync<{ storageKey: string }, DomainError>(
          notFoundError('content item not accessible')
        );
      }
      if (!DOWNLOADABLE_CONTENT_TYPES.has(target.contentType) || target.storageKey === null) {
        return errAsync<{ storageKey: string }, DomainError>(
          validationError('content item is not downloadable media')
        );
      }
      return okAsync({ storageKey: target.storageKey });
    });
  });
}

function principalAllows(
  principal: PresignPrincipal,
  target: MediaTarget,
  deps: PresignAuthzDeps
): ResultAsync<boolean, DomainError> {
  return match(principal)
    .with({ kind: 'user' }, (p) => memberAllows({ kind: 'user', userId: p.userId }, target, deps))
    .with({ kind: 'linkGuest' }, (p) =>
      memberAllows({ kind: 'linkGuest', linkId: p.linkId }, target, deps)
    )
    .with({ kind: 'share' }, (p) => shareAllows(p.shareId, target, deps))
    .exhaustive();
}

function memberAllows(
  member: MemberRef,
  target: MediaTarget,
  deps: PresignAuthzDeps
): ResultAsync<boolean, DomainError> {
  return deps.membership
    .isActiveMember(target.conversationId, member)
    .andThen((isMember) =>
      isMember ? deps.membership.isEpochMember(target.epochId, member) : okAsync(false)
    );
}

function shareAllows(
  shareId: string,
  target: MediaTarget,
  deps: PresignAuthzDeps
): ResultAsync<boolean, DomainError> {
  return deps.shares.findShare(shareId).map((share) => {
    if (share === null) return false;
    if (share.revokedAt !== null) return false;
    if (share.expiresAt !== null && share.expiresAt.getTime() <= deps.now().getTime()) {
      return false;
    }
    return share.contentItemIds.includes(target.contentItemId);
  });
}
