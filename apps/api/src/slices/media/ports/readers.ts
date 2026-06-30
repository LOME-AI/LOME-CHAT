import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * Narrow query interfaces the presign authorization depends on. The owning
 * slices' repositories (conversations: membership/epochs/shares; this slice:
 * content items) implement these at wiring time; the domain never touches a
 * table directly (single-writer-per-table).
 */

/** A content item resolved to everything presign authorization needs. */
export interface MediaTarget {
  readonly contentItemId: string;
  readonly conversationId: string;
  /** The epoch row id for the item's message epoch (conversationId + epochNumber resolved). */
  readonly epochId: string;
  readonly contentType: string;
  readonly storageKey: string | null;
}

export interface ContentItemReader {
  findMediaTarget(contentItemId: string): ResultAsync<MediaTarget | null, DomainError>;
}

/** Conversation membership is keyed by userId for users, linkId for link guests. */
export type MemberRef =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'linkGuest'; readonly linkId: string };

export interface MembershipReader {
  /** True when the member has an active (not left) conversation_members row. */
  isActiveMember(conversationId: string, member: MemberRef): ResultAsync<boolean, DomainError>;
  /**
   * True when the authenticated member holds an epoch_members row for the
   * given epoch. epoch_members is keyed by public key in the schema, so
   * implementations resolve identity → public key server-side
   * (conversation_members/users → publicKey → epoch_members). The key is
   * never taken from the caller: public keys are not secrets (every member
   * receives the others' keys for key-wrapping), so a caller-supplied key
   * would let any active member pass the gate with another member's key for
   * an epoch they were never in.
   */
  isEpochMember(epochId: string, member: MemberRef): ResultAsync<boolean, DomainError>;
}

/**
 * A message share's authorization-relevant facts. Revocation and expiry are
 * enforced lazily at read by the domain (never by a cleanup job).
 */
export interface MessageShare {
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  /** The share is scoped to exactly its message's content items. */
  readonly contentItemIds: readonly string[];
}

export interface ShareReader {
  findShare(shareId: string): ResultAsync<MessageShare | null, DomainError>;
}
