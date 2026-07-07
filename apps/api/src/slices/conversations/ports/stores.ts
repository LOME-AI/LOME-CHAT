import type { MemberPrivilege } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Data access for the conversations slice (single-writer owner of
 * `conversations`, `conversation_members`, `epochs`, `epoch_members`,
 * `conversation_forks`; read-only on `users` and `messages`). Every method is
 * one statement (or one read), so the same factory binds to the raw client or
 * to an open transaction — multi-statement orchestration and every rule live
 * in domain functions, never here.
 */

export interface ConversationRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly title: Uint8Array;
  readonly titleEpochNumber: number;
  readonly currentEpoch: number;
  readonly nextSequence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ConversationListRecord {
  readonly conversation: ConversationRecord;
  readonly privilege: MemberPrivilege;
  readonly muted: boolean;
  readonly pinned: boolean;
  readonly acceptedAt: Date | null;
  readonly invitedByUsername: string | null;
}

export interface MemberRecord {
  readonly id: string;
  readonly userId: string | null;
  readonly privilege: MemberPrivilege;
  readonly visibleFromEpoch: number;
  readonly joinedAt: Date;
  readonly acceptedAt: Date | null;
  readonly muted: boolean;
  readonly pinned: boolean;
}

export interface MemberListRecord {
  readonly id: string;
  readonly userId: string | null;
  readonly username: string | null;
  readonly privilege: MemberPrivilege;
  readonly visibleFromEpoch: number;
  readonly joinedAt: Date;
  readonly acceptedAt: Date | null;
}

export interface ForkRecord {
  readonly id: string;
  readonly name: string;
  readonly tipMessageId: string | null;
  readonly createdAt: Date;
}

export interface EpochWrapRecord {
  readonly epochNumber: number;
  readonly wrap: Uint8Array;
  readonly confirmationHash: Uint8Array;
  readonly visibleFromEpoch: number;
}

export interface EpochChainLinkRecord {
  readonly epochNumber: number;
  readonly chainLink: Uint8Array;
  readonly confirmationHash: Uint8Array;
}

export interface ConversationsStore {
  /** `INSERT … ON CONFLICT (id) DO NOTHING`; null when the id already exists. */
  insert(params: {
    readonly id: string;
    readonly ownerUserId: string;
    readonly title: Uint8Array;
  }): ResultAsync<ConversationRecord | null, DomainError>;
  get(conversationId: string): ResultAsync<ConversationRecord | null, DomainError>;
  /**
   * `SELECT … FOR UPDATE` — the per-conversation serialization point every
   * member/epoch/fork-structure transaction takes FIRST (uniform lock order
   * prevents interleaved rotations and member-count races).
   */
  lockForUpdate(conversationId: string): ResultAsync<ConversationRecord | null, DomainError>;
  /**
   * `SELECT … FOR SHARE` — the settlement's epoch-at-persist re-read. FOR SHARE
   * blocks rotation's `currentEpoch` UPDATE (a writer) while allowing concurrent
   * readers, so the wrap-target assertion serializes against rotation without
   * taking an exclusive lock.
   */
  lockForShare(conversationId: string): ResultAsync<ConversationRecord | null, DomainError>;
  listForUser(params: {
    readonly userId: string;
    readonly limit: number;
    readonly cursor: { readonly updatedAt: Date; readonly id: string } | null;
  }): ResultAsync<ConversationListRecord[], DomainError>;
  /** Conditional owner-only hard delete; false when 0 rows matched. */
  deleteOwned(params: {
    readonly conversationId: string;
    readonly ownerUserId: string;
  }): ResultAsync<boolean, DomainError>;
  /**
   * The rotation claim: first-write-wins
   * `UPDATE … SET currentEpoch = expected + 1, title … WHERE currentEpoch = expected`.
   * False when the epoch moved underneath the caller (stale rotation).
   */
  claimRotation(params: {
    readonly conversationId: string;
    readonly expectedEpoch: number;
    readonly encryptedTitle: Uint8Array;
  }): ResultAsync<boolean, DomainError>;
  /**
   * Atomically bumps `nextSequence` by `count` and returns the reserved,
   * contiguous block (lowest first) — `UPDATE … SET nextSequence =
   * nextSequence + count RETURNING nextSequence - count`. The counter is
   * monotonic and reserved numbers are never reused, so message ordering never
   * collides after a delete. Null when the conversation row is absent.
   */
  reserveSequenceBlock(params: {
    readonly conversationId: string;
    readonly count: number;
  }): ResultAsync<readonly number[] | null, DomainError>;
}

export interface MembersStore {
  activeByUser(
    conversationId: string,
    userId: string
  ): ResultAsync<MemberRecord | null, DomainError>;
  /**
   * `activeByUser` with `SELECT … FOR SHARE` on the membership row. Taken by
   * membership-guarded share/link writes inside their transaction so the
   * guarded insert serializes against a concurrent member-removal UPDATE:
   * whichever side commits first is visible to the other, closing the
   * check-then-act window an unlocked read leaves open. Pure read paths stay
   * on `activeByUser`.
   */
  lockActiveByUser(
    conversationId: string,
    userId: string
  ): ResultAsync<MemberRecord | null, DomainError>;
  activeById(
    conversationId: string,
    memberId: string
  ): ResultAsync<MemberRecord | null, DomainError>;
  listActive(conversationId: string): ResultAsync<MemberListRecord[], DomainError>;
  countActive(conversationId: string): ResultAsync<number, DomainError>;
  /** Principal ids (user or link) of every active member — the eviction fan-out. */
  activePrincipalIds(conversationId: string): ResultAsync<string[], DomainError>;
  /**
   * `INSERT … ON CONFLICT DO NOTHING` on the active-unique index; null when
   * the user is already an active member.
   */
  insert(params: {
    readonly conversationId: string;
    readonly userId: string;
    readonly privilege: MemberPrivilege;
    readonly visibleFromEpoch: number;
    readonly acceptedAt: Date | null;
    readonly invitedByUserId: string | null;
  }): ResultAsync<{ readonly id: string; readonly joinedAt: Date } | null, DomainError>;
  /** Conditional `SET leftAt WHERE … leftAt IS NULL`; null when 0 rows. */
  markLeft(params: {
    readonly conversationId: string;
    readonly memberId: string;
  }): ResultAsync<{ readonly userId: string | null } | null, DomainError>;
  /** Caller-scoped flag write; false when the caller has no active row. */
  setMuted(params: {
    readonly conversationId: string;
    readonly userId: string;
    readonly muted: boolean;
  }): ResultAsync<boolean, DomainError>;
  setPinned(params: {
    readonly conversationId: string;
    readonly userId: string;
    readonly pinned: boolean;
  }): ResultAsync<boolean, DomainError>;
  /**
   * base64(member public key) → visibleFromEpoch for every ACTIVE member
   * (users and link guests) — the authoritative input to wrap-set planning.
   */
  activeVisibilityByKey(conversationId: string): ResultAsync<Map<string, number>, DomainError>;
}

export interface EpochsStore {
  byNumber(
    conversationId: string,
    epochNumber: number
  ): ResultAsync<{ readonly id: string } | null, DomainError>;
  insert(params: {
    readonly conversationId: string;
    readonly epochNumber: number;
    readonly previousEpochId: string | null;
    readonly epochPublicKey: Uint8Array;
    readonly confirmationHash: Uint8Array;
    readonly chainLink: Uint8Array | null;
  }): ResultAsync<{ readonly id: string }, DomainError>;
  /** Idempotent on (epochId, memberPublicKey): conflicts converge, not throw. */
  insertWraps(
    rows: readonly {
      readonly epochId: string;
      readonly memberPublicKey: Uint8Array;
      readonly wrap: Uint8Array;
      readonly visibleFromEpoch: number;
    }[]
  ): ResultAsync<void, DomainError>;
  deleteWraps(epochId: string): ResultAsync<void, DomainError>;
  wrapsForKey(
    conversationId: string,
    memberPublicKey: Uint8Array
  ): ResultAsync<EpochWrapRecord[], DomainError>;
  chainLinks(conversationId: string): ResultAsync<EpochChainLinkRecord[], DomainError>;
}

export interface UsersReader {
  byId(userId: string): ResultAsync<
    {
      readonly id: string;
      readonly username: string;
      readonly publicKey: Uint8Array;
    } | null,
    DomainError
  >;
}

export interface MessagesReader {
  inConversation(messageId: string, conversationId: string): ResultAsync<boolean, DomainError>;
  /** Highest-sequence message id — the Main fork's initial tip. */
  latestId(conversationId: string): ResultAsync<string | null, DomainError>;
  /**
   * Every message's `(id, parentMessageId)` for the conversation — the parent
   * index a fork deletion walks to find the deleted branch's exclusive
   * messages. Read-only on `messages`; the delete itself is the chat slice's.
   */
  parentChainRows(
    conversationId: string
  ): ResultAsync<
    readonly { readonly id: string; readonly parentMessageId: string | null }[],
    DomainError
  >;
  /**
   * Every message's identity and sender for the conversation — the input a
   * regenerate guard walks (tip → target, via `parentMessageId`) to detect an
   * OTHER user's message intervening between the current tip and the regenerate
   * target. Read-only on `messages`; the regenerate itself is the chat slice's.
   */
  senderChainRows(conversationId: string): ResultAsync<readonly SenderChainRow[], DomainError>;
}

export interface SenderChainRow {
  readonly id: string;
  readonly parentMessageId: string | null;
  readonly senderType: 'user' | 'assistant' | 'system';
  readonly senderId: string | null;
}

export interface ForksStore {
  list(conversationId: string): ResultAsync<ForkRecord[], DomainError>;
  byId(conversationId: string, forkId: string): ResultAsync<ForkRecord | null, DomainError>;
  /**
   * `byId` with `SELECT … FOR UPDATE` on the fork row. Taken by a settling
   * chat turn before it resolves the fork's tip so the turn and a concurrent
   * `PUT /forks/:id/tip` (both tip movers) serialize on the fork row: whichever
   * takes the lock first commits, the other re-reads and its CAS fails. Pure
   * read paths stay on `byId`.
   */
  lockById(conversationId: string, forkId: string): ResultAsync<ForkRecord | null, DomainError>;
  /** 'name-taken' maps the (conversationId, name) unique violation. */
  insert(params: {
    readonly id: string | null;
    readonly conversationId: string;
    readonly name: string;
    readonly tipMessageId: string | null;
    readonly createdAt?: Date;
  }): ResultAsync<ForkRecord | 'name-taken', DomainError>;
  rename(params: {
    readonly conversationId: string;
    readonly forkId: string;
    readonly name: string;
  }): ResultAsync<ForkRecord | 'name-taken' | null, DomainError>;
  /**
   * The fork-tip CAS: `UPDATE … WHERE tipMessageId IS NOT DISTINCT FROM
   * expected`; null when the expected state did not hold.
   */
  updateTip(params: {
    readonly conversationId: string;
    readonly forkId: string;
    readonly expectedTipMessageId: string | null;
    readonly tipMessageId: string;
  }): ResultAsync<ForkRecord | null, DomainError>;
  remove(params: {
    readonly conversationId: string;
    readonly forkId: string;
  }): ResultAsync<boolean, DomainError>;
  removeAll(conversationId: string): ResultAsync<void, DomainError>;
}

export interface SharedLinkRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly displayName: string | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface SharedMessageRecord {
  readonly messageId: string;
  readonly wrappedContentKey: Uint8Array;
  readonly createdAt: Date;
}

export interface SharedLinksStore {
  /**
   * `INSERT … ON CONFLICT (link_public_key) DO NOTHING`; null when the public
   * key already exists (the client-generated key is the natural dedupe guard,
   * so racing mints of the same key converge on one row).
   */
  insert(params: {
    readonly conversationId: string;
    readonly linkPublicKey: Uint8Array;
    readonly displayName: string | null;
    readonly expiresAt: Date | null;
  }): ResultAsync<SharedLinkRecord | null, DomainError>;
  byPublicKey(linkPublicKey: Uint8Array): ResultAsync<SharedLinkRecord | null, DomainError>;
  /** Every link for the conversation (revoked and expired included; the read path filters). */
  listForConversation(conversationId: string): ResultAsync<SharedLinkRecord[], DomainError>;
  /** Public read: a link by id, with no conversation scope (the reader is unauthenticated). */
  byId(linkId: string): ResultAsync<SharedLinkRecord | null, DomainError>;
  /**
   * The revoke claim: `UPDATE … SET revokedAt = now() WHERE id = … AND
   * conversationId = … AND revokedAt IS NULL`; null when 0 rows matched
   * (already revoked, wrong conversation, or missing — the caller
   * disambiguates).
   */
  revoke(params: {
    readonly conversationId: string;
    readonly linkId: string;
  }): ResultAsync<SharedLinkRecord | null, DomainError>;
}

export interface SharedMessagesStore {
  insert(params: {
    readonly messageId: string;
    readonly linkId: string;
    readonly createdBy: string;
    readonly wrappedContentKey: Uint8Array;
  }): ResultAsync<{ readonly id: string; readonly createdAt: Date }, DomainError>;
  /**
   * The messages shared through one link — the public read's scoping unit;
   * shares minted into other links of the same conversation never appear.
   */
  listForLink(linkId: string): ResultAsync<SharedMessageRecord[], DomainError>;
}

export interface ConversationsStores {
  readonly conversations: ConversationsStore;
  readonly members: MembersStore;
  readonly epochs: EpochsStore;
  readonly users: UsersReader;
  readonly messages: MessagesReader;
  readonly forks: ForksStore;
  readonly sharedLinks: SharedLinksStore;
  readonly sharedMessages: SharedMessagesStore;
}

/** Bound per call site: the pipeline's `c.var.db` or an open transaction. */
export type ConversationsStoresFactory = (db: DbWriter) => ConversationsStores;
