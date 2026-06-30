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
}

export interface MembersStore {
  activeByUser(
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
  activeVisibilityByKey(
    conversationId: string
  ): ResultAsync<Map<string, number>, DomainError>;
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
}

export interface ForksStore {
  list(conversationId: string): ResultAsync<ForkRecord[], DomainError>;
  byId(conversationId: string, forkId: string): ResultAsync<ForkRecord | null, DomainError>;
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

export interface ConversationsStores {
  readonly conversations: ConversationsStore;
  readonly members: MembersStore;
  readonly epochs: EpochsStore;
  readonly users: UsersReader;
  readonly messages: MessagesReader;
  readonly forks: ForksStore;
}

/** Bound per call site: the pipeline's `c.var.db` or an open transaction. */
export type ConversationsStoresFactory = (db: DbWriter) => ConversationsStores;
