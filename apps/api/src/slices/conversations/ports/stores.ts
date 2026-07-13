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
  /**
   * The durable, owner-set per-conversation spend cap in nano-USD; `0` means no
   * owner-funded conversation budget (NOT unlimited). At admission it contributes
   * 0 to `effective = min(member, conversation, owner)`, so owner-funding does not
   * engage until the owner sets a cap — a signed-in member self-funds (a guest is
   * refused upstream). See admission.
   */
  readonly conversationBudgetNanoUsd: bigint;
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
  /** The link a guest joined through (`userId` null); null for real user members. */
  readonly linkId: string | null;
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

/**
 * One active member's PUBLIC key material — the authoritative set a departing
 * member re-wraps the next epoch key against. `userId` is set for user members
 * (`publicKey` from `users`), `linkId` for link-guest members (`publicKey` from
 * `sharedLinks.linkPublicKey`); exactly one is non-null.
 */
export interface MemberKeyRecord {
  readonly memberId: string;
  readonly userId: string | null;
  readonly linkId: string | null;
  readonly publicKey: Uint8Array;
  readonly privilege: MemberPrivilege;
  readonly visibleFromEpoch: number;
}

/**
 * A stored content item, read-only for the history and public-share reads.
 * `content_items` is the chat slice's table; this slice reads it exactly as it
 * reads `messages` and `users`. Text items carry `encryptedBlob`; media items
 * carry null bytes and are fetched by presigning `id` separately.
 */
export interface ContentItemRow {
  readonly id: string;
  readonly messageId: string;
  readonly position: number;
  readonly contentType: 'text' | 'image' | 'audio' | 'video';
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly encryptedBlob: Uint8Array | null;
}

/** A conversation message with its content items — the history read's row. */
export interface HistoryMessageRow {
  readonly id: string;
  readonly parentMessageId: string | null;
  readonly sequenceNumber: number;
  readonly epochNumber: number;
  readonly senderType: 'user' | 'assistant' | 'system';
  readonly senderId: string | null;
  readonly wrappedContentKey: Uint8Array;
  readonly batchId: string;
  readonly contentItems: ContentItemRow[];
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
   * Owner-only title write: conditional
   * `UPDATE … SET title, titleEpochNumber WHERE id = … AND ownerUserId = …
   * RETURNING …`; null when 0 rows (missing or not the owner — the caller
   * disambiguates). The title is opaque ciphertext.
   */
  updateTitle(params: {
    readonly conversationId: string;
    readonly ownerUserId: string;
    readonly title: Uint8Array;
    readonly titleEpochNumber: number;
  }): ResultAsync<ConversationRecord | null, DomainError>;
  /**
   * Owner-only per-conversation budget write: conditional
   * `UPDATE … SET conversationBudgetNanoUsd WHERE id = … AND ownerUserId = …
   * RETURNING …`; null when 0 rows (missing or not the owner — the caller
   * disambiguates, exactly like `updateTitle`). The cap is the durable,
   * cumulative-forever per-conversation ceiling admission gates against.
   */
  updateBudget(params: {
    readonly conversationId: string;
    readonly ownerUserId: string;
    readonly budgetNanoUsd: bigint;
  }): ResultAsync<ConversationRecord | null, DomainError>;
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

/**
 * An active link-guest member joined to its link's public-key material. A link
 * guest is a first-class member (`userId` null, `linkId` set); its decryption
 * key and display name live on `shared_links`, so one read serves both the
 * membership gate and keychain. `displayName` is the link's own label (never a
 * `users.username`).
 */
export interface ActiveLinkGuest {
  readonly member: MemberRecord;
  readonly publicKey: Uint8Array;
  readonly displayName: string | null;
}

export interface MembersStore {
  activeByUser(
    conversationId: string,
    userId: string
  ): ResultAsync<MemberRecord | null, DomainError>;
  /**
   * The active link-guest member for a link (`leftAt IS NULL`), joined to
   * `shared_links` for its public key and display name; null when the link has
   * no active member (never seated, revoked, or left). Gates the guest-reachable
   * reads and the WS upgrade on the member row — never on link liveness alone.
   */
  activeLinkGuest(
    conversationId: string,
    linkId: string
  ): ResultAsync<ActiveLinkGuest | null, DomainError>;
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
  /**
   * Every active member's public key, ordered by `joinedAt` — the authoritative
   * wrap-set input every epoch rotation is validated against. Unions user
   * members (`users.publicKey`) and link members (`sharedLinks.linkPublicKey`).
   */
  activeKeysOrdered(conversationId: string): ResultAsync<MemberKeyRecord[], DomainError>;
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
  /**
   * Seats a link-guest member (`userId` null, `linkId` set, `acceptedAt` now):
   * `INSERT … ON CONFLICT DO NOTHING` on the link-active index; null when the
   * link already has an active member. A link guest participates exactly like a
   * user member and is revoked by its row being marked left.
   */
  insertLinkMember(params: {
    readonly conversationId: string;
    readonly linkId: string;
    readonly privilege: MemberPrivilege;
    readonly visibleFromEpoch: number;
  }): ResultAsync<{ readonly id: string } | null, DomainError>;
  /** Conditional `SET leftAt WHERE … leftAt IS NULL`; null when 0 rows. */
  markLeft(params: {
    readonly conversationId: string;
    readonly memberId: string;
  }): ResultAsync<{ readonly userId: string | null } | null, DomainError>;
  /**
   * Conditional link-guest departure: `SET leftAt = now() WHERE conversationId
   * = … AND linkId = … AND leftAt IS NULL RETURNING id`; null when 0 rows (no
   * active member for the link). Security-critical: the media presign member
   * path gates a link guest solely on `conversation_members.leftAt` (never
   * `shared_links.revokedAt`), so revoke MUST mark the guest left here or a
   * revoked guest still passes the presign gate.
   */
  markLeftByLink(params: {
    readonly conversationId: string;
    readonly linkId: string;
  }): ResultAsync<{ readonly id: string } | null, DomainError>;
  /**
   * Pending-only accept: `SET acceptedAt = now() WHERE … acceptedAt IS NULL
   * AND leftAt IS NULL`; false when 0 rows (already accepted, left, or not a
   * member — the caller disambiguates). Never check-then-act.
   */
  setAccepted(params: {
    readonly conversationId: string;
    readonly userId: string;
  }): ResultAsync<boolean, DomainError>;
  /**
   * Pending-only decline: `SET leftAt = now() WHERE … acceptedAt IS NULL AND
   * leftAt IS NULL RETURNING id`; null when 0 rows (accepted, already left, or
   * not a member). Returns the member id for the removal broadcast.
   */
  declinePending(params: {
    readonly conversationId: string;
    readonly userId: string;
  }): ResultAsync<{ readonly id: string } | null, DomainError>;
  /**
   * Admin-driven privilege change: conditional `SET privilege WHERE id = … AND
   * conversationId = … AND leftAt IS NULL`; false when 0 rows (the target
   * departed concurrently — the authz gates ran on a prior read).
   */
  updatePrivilege(params: {
    readonly conversationId: string;
    readonly memberId: string;
    readonly privilege: MemberPrivilege;
  }): ResultAsync<boolean, DomainError>;
  /**
   * Link-guest privilege change (the legacy `changeLinkPrivilege` write, whose
   * single source of truth is the member row): conditional
   * `SET privilege WHERE conversationId = … AND linkId = … AND leftAt IS NULL
   * RETURNING id`; null when the link has no active guest member. No key
   * rotation — a privilege change never revokes access.
   */
  updatePrivilegeByLink(params: {
    readonly conversationId: string;
    readonly linkId: string;
    readonly privilege: MemberPrivilege;
  }): ResultAsync<{ readonly id: string } | null, DomainError>;
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
  /**
   * True when `memberPublicKey` holds an `epoch_members` row for the
   * conversation's epoch NUMBER (joining `epochs → epoch_members`). The
   * authoritative wrap-set membership check for the settlement's member-keyed
   * epoch-at-persist gate: a non-member or stale key finds no row. Conversation
   * membership is not enough — only keys actually wrapped into this epoch pass.
   */
  memberInEpoch(params: {
    readonly conversationId: string;
    readonly epochNumber: number;
    readonly memberPublicKey: Uint8Array;
  }): ResultAsync<boolean, DomainError>;
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
  /**
   * A page of the conversation's messages at or above `minEpoch` (the caller's
   * visibility floor), ordered by `sequenceNumber`, each with its content items
   * ordered by `position`. `afterSequence` is the exclusive cursor (null for the
   * first page). Read-only on `messages`/`content_items`.
   */
  history(params: {
    readonly conversationId: string;
    readonly minEpoch: number;
    readonly afterSequence: number | null;
    readonly limit: number;
  }): ResultAsync<HistoryMessageRow[], DomainError>;
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

/**
 * A link plus its seated privilege, for the owner-facing list view. Privilege
 * lives on the link's guest `conversation_members` row (not on `shared_links`);
 * `listForConversation` joins the active guest to project it. A link with no
 * active guest (memberless or revoked) reports the column default `write`.
 */
export interface SharedLinkListRecord extends SharedLinkRecord {
  readonly privilege: MemberPrivilege;
}

export interface SharedMessageRecord {
  /**
   * The `shared_messages` row id — the public read's `:shareId`. The media
   * presign route keys `:shareId` on it too, so the capability stays scoped to
   * exactly this shared message's content items.
   */
  readonly id: string;
  readonly messageId: string;
  readonly wrappedContentKey: Uint8Array;
  readonly createdAt: Date;
  /** The shared message's content items (text bytes inline; media by id). */
  readonly contentItems: ContentItemRow[];
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
  /** Every link for the conversation (revoked and expired included; the read path filters), each with its seated privilege. */
  listForConversation(conversationId: string): ResultAsync<SharedLinkListRecord[], DomainError>;
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
  /**
   * Display-name write, gated to a live link: conditional
   * `UPDATE … SET displayName WHERE id = … AND conversationId = … AND
   * revokedAt IS NULL`; false when 0 rows matched (missing, wrong conversation,
   * or revoked — the caller answers not-found). Serves both the admin rename
   * and a guest renaming its own link.
   */
  updateDisplayName(params: {
    readonly conversationId: string;
    readonly linkId: string;
    readonly displayName: string;
  }): ResultAsync<boolean, DomainError>;
}

export interface SharedMessagesStore {
  insert(params: {
    readonly messageId: string;
    readonly createdBy: string;
    readonly wrappedContentKey: Uint8Array;
  }): ResultAsync<{ readonly id: string; readonly createdAt: Date }, DomainError>;
  /**
   * One standalone share by its id — the public read's scoping unit. Returns
   * exactly that share and its message's content items; null when the id
   * matches nothing.
   */
  byId(shareId: string): ResultAsync<SharedMessageRecord | null, DomainError>;
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
