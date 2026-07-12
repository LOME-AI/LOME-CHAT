import { and, eq, isNull } from 'drizzle-orm';
import {
  contentItems,
  conversationMembers,
  epochMembers,
  epochs,
  sharedLinks,
  sharedMessages,
  users,
} from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The conversations slice's published presign reads. This slice is the single
 * writer of `epochs`, `epoch_members`, `conversation_members`, `shared_links`,
 * and `shared_messages`; media's presign authorization composes these through
 * the composition root rather than reaching into the tables itself.
 */

/** A conversation member is either a user or a link guest (never both). */
export type PresignMemberRef =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'linkGuest'; readonly linkId: string };

/**
 * A shared message's authorization-relevant facts. Standalone message-shares
 * carry no revoke or expiry (legacy parity), so `revokedAt`/`expiresAt` are
 * always null; the presign authz guards short-circuit to allowed and the scope
 * is the share's own message content items.
 */
export interface PresignMessageShare {
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly contentItemIds: readonly string[];
}

function storeFailure(cause: unknown): DomainError {
  return unavailableError('conversations presign read failed', cause);
}

/** The epoch row id for a conversation's epoch number; null when absent. */
export function resolveEpochRowId(
  db: DbWriter,
  conversationId: string,
  epochNumber: number
): ResultAsync<string | null, DomainError> {
  return fromPromise(
    db
      .select({ id: epochs.id })
      .from(epochs)
      .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber))),
    storeFailure
  ).map((rows) => rows[0]?.id ?? null);
}

/**
 * True when the member holds an active (not left) `conversation_members` row.
 * User members are keyed by `userId`, link guests by `linkId` — a link guest
 * participates exactly like a member and is revoked by its row being left.
 */
export function isActiveConversationMember(
  db: DbWriter,
  conversationId: string,
  member: PresignMemberRef
): ResultAsync<boolean, DomainError> {
  const predicate =
    member.kind === 'user'
      ? and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, member.userId),
          isNull(conversationMembers.leftAt)
        )
      : and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.linkId, member.linkId),
          isNull(conversationMembers.leftAt)
        );
  return fromPromise(
    db.select({ id: conversationMembers.id }).from(conversationMembers).where(predicate).limit(1),
    storeFailure
  ).map((rows) => rows.length > 0);
}

/**
 * The member's public key, resolved SERVER-SIDE from identity — never from the
 * caller. `epoch_members` is keyed by public key, and public keys are not
 * secrets (every member holds the others' for key-wrapping), so a
 * caller-supplied key would let any member pass the gate with another's key.
 */
function memberPublicKey(
  db: DbWriter,
  member: PresignMemberRef
): ResultAsync<Uint8Array | null, DomainError> {
  if (member.kind === 'user') {
    return fromPromise(
      db.select({ publicKey: users.publicKey }).from(users).where(eq(users.id, member.userId)),
      storeFailure
    ).map((rows) => rows[0]?.publicKey ?? null);
  }
  return fromPromise(
    db
      .select({ publicKey: sharedLinks.linkPublicKey })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, member.linkId)),
    storeFailure
  ).map((rows) => rows[0]?.publicKey ?? null);
}

/**
 * True when the member's server-resolved public key holds an `epoch_members`
 * row for the given epoch. Membership in the conversation is NOT enough: only
 * the epochs a member was actually wrapped into are readable, so a late joiner
 * cannot exfiltrate ciphertext from epochs it was never part of.
 */
export function isEpochMember(
  db: DbWriter,
  epochId: string,
  member: PresignMemberRef
): ResultAsync<boolean, DomainError> {
  return memberPublicKey(db, member).andThen((key) =>
    key === null
      ? okAsync(false)
      : fromPromise(
          db
            .select({ id: epochMembers.id })
            .from(epochMembers)
            .where(and(eq(epochMembers.epochId, epochId), eq(epochMembers.memberPublicKey, key)))
            .limit(1),
          storeFailure
        ).map((rows) => rows.length > 0)
  );
}

/**
 * A standalone shared message resolved to the presign facts: its message's
 * content items for the share's scope. Standalone shares have no minting link,
 * so revoke/expiry are always null (legacy parity). Null when the shared
 * message id matches nothing.
 */
export function findMessageShare(
  db: DbWriter,
  sharedMessageId: string
): ResultAsync<PresignMessageShare | null, DomainError> {
  return fromPromise(
    db
      .select({ messageId: sharedMessages.messageId })
      .from(sharedMessages)
      .where(eq(sharedMessages.id, sharedMessageId)),
    storeFailure
  ).andThen((rows) => {
    const row = rows[0];
    if (row === undefined) return okAsync<PresignMessageShare | null, DomainError>(null);
    return fromPromise(
      db
        .select({ id: contentItems.id })
        .from(contentItems)
        .where(eq(contentItems.messageId, row.messageId)),
      storeFailure
    ).map((items) => ({
      revokedAt: null,
      expiresAt: null,
      contentItemIds: items.map((item) => item.id),
    }));
  });
}
