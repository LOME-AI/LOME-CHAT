import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  contentItems,
  conversationForks,
  conversationMembers,
  conversations,
  epochMembers,
  epochs,
  messages,
  sharedLinks,
  sharedMessages,
  users,
} from '@hushbox/db';
import { toBase64 } from '@hushbox/shared';
import { unavailableError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import type { MemberPrivilege } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  ConversationsStores,
  ContentItemRow,
  ForkRecord,
  HistoryMessageRow,
  MemberKeyRecord,
  SharedMessageRecord,
} from '../ports/index.js';

/** One mapper for every store query: infra rejections become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('conversations store query failed', cause);
}

const FORK_NAME_UNIQUE = 'conversation_forks_conversation_name_unique';

/** Postgres unique-violation (23505) on the named constraint, chain-walked. */
function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505') {
      return (
        candidate.constraint === constraintName ||
        (candidate.constraint === undefined &&
          current instanceof Error &&
          current.message.includes(constraintName))
      );
    }
    current = candidate.cause;
  }
  return false;
}

const conversationColumns = {
  id: conversations.id,
  ownerUserId: conversations.userId,
  title: conversations.title,
  titleEpochNumber: conversations.titleEpochNumber,
  currentEpoch: conversations.currentEpoch,
  nextSequence: conversations.nextSequence,
  conversationBudgetNanoUsd: conversations.conversationBudgetNanoUsd,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
} as const;

const forkColumns = {
  id: conversationForks.id,
  name: conversationForks.name,
  tipMessageId: conversationForks.tipMessageId,
  createdAt: conversationForks.createdAt,
} as const;

const sharedLinkColumns = {
  id: sharedLinks.id,
  conversationId: sharedLinks.conversationId,
  displayName: sharedLinks.displayName,
  revokedAt: sharedLinks.revokedAt,
  expiresAt: sharedLinks.expiresAt,
  createdAt: sharedLinks.createdAt,
} as const;

const memberColumns = {
  id: conversationMembers.id,
  userId: conversationMembers.userId,
  privilege: conversationMembers.privilege,
  visibleFromEpoch: conversationMembers.visibleFromEpoch,
  joinedAt: conversationMembers.joinedAt,
  acceptedAt: conversationMembers.acceptedAt,
  muted: conversationMembers.muted,
  pinned: conversationMembers.pinned,
} as const;

function activeMember(conversationId: string, userId: string): ReturnType<typeof and> {
  return and(
    eq(conversationMembers.conversationId, conversationId),
    eq(conversationMembers.userId, userId),
    isNull(conversationMembers.leftAt)
  );
}

/**
 * Drizzle implementation of the slice's stores. Bound to the request client
 * or an open transaction; every method is a single statement (or read), so
 * atomicity boundaries stay with the domain orchestration that owns them.
 */
export function createConversationsStores(db: DbWriter): ConversationsStores {
  const inviter = alias(users, 'inviter');

  return {
    conversations: {
      insert: ({ id, ownerUserId, title }) =>
        fromPromise(
          db
            .insert(conversations)
            .values({ id, userId: ownerUserId, title })
            .onConflictDoNothing({ target: conversations.id })
            .returning(conversationColumns),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      get: (conversationId) =>
        fromPromise(
          db
            .select(conversationColumns)
            .from(conversations)
            .where(eq(conversations.id, conversationId)),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      lockForUpdate: (conversationId) =>
        fromPromise(
          db
            .select(conversationColumns)
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .for('update'),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      lockForShare: (conversationId) =>
        fromPromise(
          db
            .select(conversationColumns)
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .for('share'),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      listForUser: ({ userId, limit, cursor }) => {
        // `and()` drops undefined members, so the no-cursor case needs no guard.
        const conditions = and(
          eq(conversationMembers.userId, userId),
          isNull(conversationMembers.leftAt),
          cursor === null
            ? undefined
            : or(
                lt(conversations.updatedAt, cursor.updatedAt),
                and(eq(conversations.updatedAt, cursor.updatedAt), lt(conversations.id, cursor.id))
              )
        );
        return fromPromise(
          db
            .select({
              conversation: conversationColumns,
              privilege: conversationMembers.privilege,
              muted: conversationMembers.muted,
              pinned: conversationMembers.pinned,
              acceptedAt: conversationMembers.acceptedAt,
              invitedByUsername: inviter.username,
            })
            .from(conversationMembers)
            .innerJoin(conversations, eq(conversationMembers.conversationId, conversations.id))
            .leftJoin(inviter, eq(conversationMembers.invitedByUserId, inviter.id))
            .where(conditions)
            .orderBy(desc(conversations.updatedAt), desc(conversations.id))
            .limit(limit),
          storeFailure
        );
      },

      deleteOwned: ({ conversationId, ownerUserId }) =>
        fromPromise(
          db
            .delete(conversations)
            .where(and(eq(conversations.id, conversationId), eq(conversations.userId, ownerUserId)))
            .returning({ id: conversations.id }),
          storeFailure
        ).map((rows) => rows.length > 0),

      updateTitle: ({ conversationId, ownerUserId, title, titleEpochNumber }) =>
        fromPromise(
          db
            .update(conversations)
            .set({ title, titleEpochNumber, updatedAt: new Date() })
            .where(and(eq(conversations.id, conversationId), eq(conversations.userId, ownerUserId)))
            .returning(conversationColumns),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      updateBudget: ({ conversationId, ownerUserId, budgetNanoUsd }) =>
        fromPromise(
          db
            .update(conversations)
            .set({ conversationBudgetNanoUsd: budgetNanoUsd, updatedAt: new Date() })
            .where(and(eq(conversations.id, conversationId), eq(conversations.userId, ownerUserId)))
            .returning(conversationColumns),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      claimRotation: ({ conversationId, expectedEpoch, encryptedTitle }) =>
        fromPromise(
          db
            .update(conversations)
            .set({
              currentEpoch: expectedEpoch + 1,
              title: encryptedTitle,
              titleEpochNumber: expectedEpoch + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(conversations.id, conversationId),
                eq(conversations.currentEpoch, expectedEpoch)
              )
            )
            .returning({ id: conversations.id }),
          storeFailure
        ).map((rows) => rows.length > 0),

      reserveSequenceBlock: ({ conversationId, count }) =>
        fromPromise(
          db
            .update(conversations)
            .set({
              nextSequence: sql`${conversations.nextSequence} + ${count}`,
              updatedAt: new Date(),
            })
            .where(eq(conversations.id, conversationId))
            // RETURNING sees the post-update value, so `nextSequence - count`
            // recovers the pre-update base — the block's lowest number.
            .returning({ base: sql<number>`${conversations.nextSequence} - ${count}` }),
          storeFailure
        ).map((rows) => {
          const base = rows[0]?.base;
          return base === undefined
            ? null
            : Array.from({ length: count }, (_, index) => base + index);
        }),
    },

    members: {
      activeByUser: (conversationId, userId) =>
        fromPromise(
          db
            .select(memberColumns)
            .from(conversationMembers)
            .where(activeMember(conversationId, userId)),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      activeLinkGuest: (conversationId, linkId) =>
        fromPromise(
          db
            .select({
              ...memberColumns,
              publicKey: sharedLinks.linkPublicKey,
              displayName: sharedLinks.displayName,
            })
            .from(conversationMembers)
            .innerJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                eq(conversationMembers.linkId, linkId),
                isNull(conversationMembers.leftAt)
              )
            ),
          storeFailure
        ).map((rows) => {
          const row = rows[0];
          return row === undefined
            ? null
            : {
                member: {
                  id: row.id,
                  userId: row.userId,
                  privilege: row.privilege,
                  visibleFromEpoch: row.visibleFromEpoch,
                  joinedAt: row.joinedAt,
                  acceptedAt: row.acceptedAt,
                  muted: row.muted,
                  pinned: row.pinned,
                },
                publicKey: row.publicKey,
                displayName: row.displayName,
              };
        }),

      lockActiveByUser: (conversationId, userId) =>
        fromPromise(
          db
            .select(memberColumns)
            .from(conversationMembers)
            .where(activeMember(conversationId, userId))
            .for('share'),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      activeById: (conversationId, memberId) =>
        fromPromise(
          db
            .select(memberColumns)
            .from(conversationMembers)
            .where(
              and(
                eq(conversationMembers.id, memberId),
                eq(conversationMembers.conversationId, conversationId),
                isNull(conversationMembers.leftAt)
              )
            ),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      listActive: (conversationId) =>
        fromPromise(
          db
            .select({
              id: conversationMembers.id,
              userId: conversationMembers.userId,
              linkId: conversationMembers.linkId,
              username: users.username,
              privilege: conversationMembers.privilege,
              visibleFromEpoch: conversationMembers.visibleFromEpoch,
              joinedAt: conversationMembers.joinedAt,
              acceptedAt: conversationMembers.acceptedAt,
            })
            .from(conversationMembers)
            .leftJoin(users, eq(conversationMembers.userId, users.id))
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                isNull(conversationMembers.leftAt)
              )
            )
            .orderBy(asc(conversationMembers.joinedAt)),
          storeFailure
        ),

      activeKeysOrdered: (conversationId) => selectActiveMemberKeys(db, conversationId),

      countActive: (conversationId) =>
        fromPromise(
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(conversationMembers)
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                isNull(conversationMembers.leftAt)
              )
            ),
          storeFailure
        ).map((rows) => rows[0]?.count ?? 0),

      activePrincipalIds: (conversationId) =>
        fromPromise(
          db
            .select({
              userId: conversationMembers.userId,
              linkId: conversationMembers.linkId,
            })
            .from(conversationMembers)
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                isNull(conversationMembers.leftAt)
              )
            ),
          storeFailure
        ).map((rows) =>
          rows.flatMap((row) => {
            const principalId = row.userId ?? row.linkId;
            return principalId === null ? [] : [principalId];
          })
        ),

      insert: ({
        conversationId,
        userId,
        privilege,
        visibleFromEpoch,
        acceptedAt,
        invitedByUserId,
      }) =>
        fromPromise(
          db
            .insert(conversationMembers)
            .values({
              conversationId,
              userId,
              privilege,
              visibleFromEpoch,
              acceptedAt,
              invitedByUserId,
            })
            .onConflictDoNothing({
              target: [conversationMembers.conversationId, conversationMembers.userId],
              where: isNull(conversationMembers.leftAt),
            })
            .returning({ id: conversationMembers.id, joinedAt: conversationMembers.joinedAt }),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      insertLinkMember: ({ conversationId, linkId, privilege, visibleFromEpoch }) =>
        fromPromise(
          db
            .insert(conversationMembers)
            .values({
              conversationId,
              linkId,
              userId: null,
              privilege,
              visibleFromEpoch,
              acceptedAt: new Date(),
            })
            .onConflictDoNothing({
              target: [conversationMembers.conversationId, conversationMembers.linkId],
              where: isNull(conversationMembers.leftAt),
            })
            .returning({ id: conversationMembers.id }),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      markLeft: ({ conversationId, memberId }) =>
        fromPromise(
          db
            .update(conversationMembers)
            .set({ leftAt: new Date() })
            .where(
              and(
                eq(conversationMembers.id, memberId),
                eq(conversationMembers.conversationId, conversationId),
                isNull(conversationMembers.leftAt)
              )
            )
            .returning({ userId: conversationMembers.userId }),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      markLeftByLink: ({ conversationId, linkId }) =>
        fromPromise(
          db
            .update(conversationMembers)
            .set({ leftAt: new Date() })
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                eq(conversationMembers.linkId, linkId),
                isNull(conversationMembers.leftAt)
              )
            )
            .returning({ id: conversationMembers.id }),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      setAccepted: ({ conversationId, userId }) =>
        fromPromise(
          db
            .update(conversationMembers)
            .set({ acceptedAt: new Date() })
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                eq(conversationMembers.userId, userId),
                isNull(conversationMembers.acceptedAt),
                isNull(conversationMembers.leftAt)
              )
            )
            .returning({ id: conversationMembers.id }),
          storeFailure
        ).map((rows) => rows.length > 0),

      declinePending: ({ conversationId, userId }) =>
        fromPromise(
          db
            .update(conversationMembers)
            .set({ leftAt: new Date() })
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                eq(conversationMembers.userId, userId),
                isNull(conversationMembers.acceptedAt),
                isNull(conversationMembers.leftAt)
              )
            )
            .returning({ id: conversationMembers.id }),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      updatePrivilege: ({ conversationId, memberId, privilege }) =>
        fromPromise(
          db
            .update(conversationMembers)
            .set({ privilege })
            .where(
              and(
                eq(conversationMembers.id, memberId),
                eq(conversationMembers.conversationId, conversationId),
                isNull(conversationMembers.leftAt)
              )
            )
            .returning({ id: conversationMembers.id }),
          storeFailure
        ).map((rows) => rows.length > 0),

      updatePrivilegeByLink: ({ conversationId, linkId, privilege }) =>
        fromPromise(
          db
            .update(conversationMembers)
            .set({ privilege })
            .where(
              and(
                eq(conversationMembers.linkId, linkId),
                eq(conversationMembers.conversationId, conversationId),
                isNull(conversationMembers.leftAt)
              )
            )
            .returning({ id: conversationMembers.id }),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      setMuted: ({ conversationId, userId, muted }) =>
        fromPromise(
          db
            .update(conversationMembers)
            .set({ muted })
            .where(activeMember(conversationId, userId))
            .returning({ id: conversationMembers.id }),
          storeFailure
        ).map((rows) => rows.length > 0),

      setPinned: ({ conversationId, userId, pinned }) =>
        fromPromise(
          db
            .update(conversationMembers)
            .set({ pinned })
            .where(activeMember(conversationId, userId))
            .returning({ id: conversationMembers.id }),
          storeFailure
        ).map((rows) => rows.length > 0),

      activeVisibilityByKey: (conversationId) => {
        const active = and(
          eq(conversationMembers.conversationId, conversationId),
          isNull(conversationMembers.leftAt)
        );
        const userRows = fromPromise(
          db
            .select({
              publicKey: users.publicKey,
              visibleFromEpoch: conversationMembers.visibleFromEpoch,
            })
            .from(conversationMembers)
            .innerJoin(users, eq(conversationMembers.userId, users.id))
            .where(active),
          storeFailure
        );
        const linkRows = fromPromise(
          db
            .select({
              publicKey: sharedLinks.linkPublicKey,
              visibleFromEpoch: conversationMembers.visibleFromEpoch,
            })
            .from(conversationMembers)
            .innerJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
            .where(active),
          storeFailure
        );
        return userRows.andThen((fromUsers) =>
          linkRows.map((fromLinks) => {
            const map = new Map<string, number>();
            for (const row of [...fromUsers, ...fromLinks]) {
              map.set(toBase64(row.publicKey), row.visibleFromEpoch);
            }
            return map;
          })
        );
      },
    },

    epochs: {
      byNumber: (conversationId, epochNumber) =>
        fromPromise(
          db
            .select({ id: epochs.id })
            .from(epochs)
            .where(
              and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber))
            ),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      insert: ({
        conversationId,
        epochNumber,
        previousEpochId,
        epochPublicKey,
        confirmationHash,
        chainLink,
      }) =>
        fromPromise(
          db
            .insert(epochs)
            .values({
              conversationId,
              epochNumber,
              previousEpochId,
              epochPublicKey,
              confirmationHash,
              chainLink,
            })
            .returning({ id: epochs.id }),
          storeFailure
        ).andThen((rows) => {
          const row = rows[0];
          return row === undefined
            ? errAsync(storeFailure(new Error('epoch insert returned no row')))
            : okAsync(row);
        }),

      insertWraps: (rows) =>
        rows.length === 0
          ? okAsync()
          : fromPromise(
              db
                .insert(epochMembers)
                .values([...rows])
                .onConflictDoNothing({
                  target: [epochMembers.epochId, epochMembers.memberPublicKey],
                }),
              storeFailure
            ).map((): void => undefined),

      deleteWraps: (epochId) =>
        fromPromise(
          db.delete(epochMembers).where(eq(epochMembers.epochId, epochId)),
          storeFailure
        ).map((): void => undefined),

      memberInEpoch: ({ conversationId, epochNumber, memberPublicKey }) =>
        fromPromise(
          db
            .select({ id: epochMembers.id })
            .from(epochMembers)
            .innerJoin(epochs, eq(epochMembers.epochId, epochs.id))
            .where(
              and(
                eq(epochs.conversationId, conversationId),
                eq(epochs.epochNumber, epochNumber),
                eq(epochMembers.memberPublicKey, memberPublicKey)
              )
            )
            .limit(1),
          storeFailure
        ).map((rows) => rows.length > 0),

      wrapsForKey: (conversationId, memberPublicKey) =>
        fromPromise(
          db
            .select({
              epochNumber: epochs.epochNumber,
              wrap: epochMembers.wrap,
              confirmationHash: epochs.confirmationHash,
              visibleFromEpoch: epochMembers.visibleFromEpoch,
            })
            .from(epochMembers)
            .innerJoin(epochs, eq(epochMembers.epochId, epochs.id))
            .where(
              and(
                eq(epochs.conversationId, conversationId),
                eq(epochMembers.memberPublicKey, memberPublicKey)
              )
            )
            .orderBy(asc(epochs.epochNumber)),
          storeFailure
        ),

      chainLinks: (conversationId) =>
        fromPromise(
          db
            .select({
              epochNumber: epochs.epochNumber,
              chainLink: epochs.chainLink,
              confirmationHash: epochs.confirmationHash,
            })
            .from(epochs)
            .where(eq(epochs.conversationId, conversationId))
            .orderBy(asc(epochs.epochNumber)),
          storeFailure
        ).map((rows) =>
          rows.flatMap((row) =>
            row.chainLink === null ? [] : [{ ...row, chainLink: row.chainLink }]
          )
        ),
    },

    users: {
      byId: (userId) =>
        fromPromise(
          db
            .select({ id: users.id, username: users.username, publicKey: users.publicKey })
            .from(users)
            .where(eq(users.id, userId)),
          storeFailure
        ).map((rows) => rows[0] ?? null),
    },

    messages: {
      inConversation: (messageId, conversationId) =>
        fromPromise(
          db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId))),
          storeFailure
        ).map((rows) => rows.length > 0),

      latestId: (conversationId) =>
        fromPromise(
          db
            .select({ id: messages.id })
            .from(messages)
            .where(eq(messages.conversationId, conversationId))
            .orderBy(desc(messages.sequenceNumber))
            .limit(1),
          storeFailure
        ).map((rows) => rows[0]?.id ?? null),

      parentChainRows: (conversationId) =>
        fromPromise(
          db
            .select({ id: messages.id, parentMessageId: messages.parentMessageId })
            .from(messages)
            .where(eq(messages.conversationId, conversationId)),
          storeFailure
        ),

      senderChainRows: (conversationId) =>
        fromPromise(
          db
            .select({
              id: messages.id,
              parentMessageId: messages.parentMessageId,
              senderType: messages.senderType,
              senderId: messages.senderId,
            })
            .from(messages)
            .where(eq(messages.conversationId, conversationId)),
          storeFailure
        ),

      history: (params) => selectMessageHistory(db, params),
    },

    forks: {
      list: (conversationId) =>
        fromPromise(
          db
            .select(forkColumns)
            .from(conversationForks)
            .where(eq(conversationForks.conversationId, conversationId))
            .orderBy(asc(conversationForks.createdAt), asc(conversationForks.id)),
          storeFailure
        ),

      byId: (conversationId, forkId) =>
        fromPromise(
          db
            .select(forkColumns)
            .from(conversationForks)
            .where(
              and(
                eq(conversationForks.id, forkId),
                eq(conversationForks.conversationId, conversationId)
              )
            ),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      lockById: (conversationId, forkId) =>
        fromPromise(
          db
            .select(forkColumns)
            .from(conversationForks)
            .where(
              and(
                eq(conversationForks.id, forkId),
                eq(conversationForks.conversationId, conversationId)
              )
            )
            .for('update'),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      insert: ({ id, conversationId, name, tipMessageId, createdAt }) =>
        insertFork(db, { id, conversationId, name, tipMessageId, createdAt }),

      rename: (params) => fromPromise(renameForkRow(db, params), storeFailure),

      updateTip: ({ conversationId, forkId, expectedTipMessageId, tipMessageId }) =>
        fromPromise(
          db
            .update(conversationForks)
            .set({ tipMessageId })
            .where(
              and(
                eq(conversationForks.id, forkId),
                eq(conversationForks.conversationId, conversationId),
                sql`${conversationForks.tipMessageId} IS NOT DISTINCT FROM ${expectedTipMessageId}`
              )
            )
            .returning(forkColumns),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      remove: ({ conversationId, forkId }) =>
        fromPromise(
          db
            .delete(conversationForks)
            .where(
              and(
                eq(conversationForks.id, forkId),
                eq(conversationForks.conversationId, conversationId)
              )
            )
            .returning({ id: conversationForks.id }),
          storeFailure
        ).map((rows) => rows.length > 0),

      removeAll: (conversationId) =>
        fromPromise(
          db.delete(conversationForks).where(eq(conversationForks.conversationId, conversationId)),
          storeFailure
        ).map((): void => undefined),
    },

    sharedLinks: {
      insert: ({ conversationId, linkPublicKey, displayName, expiresAt }) =>
        fromPromise(
          db
            .insert(sharedLinks)
            .values({ conversationId, linkPublicKey, displayName, expiresAt })
            .onConflictDoNothing({ target: sharedLinks.linkPublicKey })
            .returning(sharedLinkColumns),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      byPublicKey: (linkPublicKey) =>
        fromPromise(
          db
            .select(sharedLinkColumns)
            .from(sharedLinks)
            .where(eq(sharedLinks.linkPublicKey, linkPublicKey)),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      listForConversation: (conversationId) =>
        fromPromise(
          db
            .select({
              ...sharedLinkColumns,
              // Privilege lives on the link's guest member row, not on `shared_links`.
              // The link-active partial unique bounds the join to one active guest; a
              // memberless or revoked link (no active guest) reports the column default.
              privilege: sql<MemberPrivilege>`coalesce(${conversationMembers.privilege}, 'write')`,
            })
            .from(sharedLinks)
            .leftJoin(
              conversationMembers,
              and(
                eq(conversationMembers.linkId, sharedLinks.id),
                isNull(conversationMembers.leftAt)
              )
            )
            .where(eq(sharedLinks.conversationId, conversationId))
            .orderBy(asc(sharedLinks.createdAt), asc(sharedLinks.id)),
          storeFailure
        ),

      byId: (linkId) =>
        fromPromise(
          db.select(sharedLinkColumns).from(sharedLinks).where(eq(sharedLinks.id, linkId)),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      revoke: ({ conversationId, linkId }) =>
        fromPromise(
          db
            .update(sharedLinks)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(sharedLinks.id, linkId),
                eq(sharedLinks.conversationId, conversationId),
                isNull(sharedLinks.revokedAt)
              )
            )
            .returning(sharedLinkColumns),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      unrevoke: ({ conversationId, linkId }) =>
        fromPromise(
          db
            .update(sharedLinks)
            .set({ revokedAt: null })
            .where(
              and(
                eq(sharedLinks.id, linkId),
                eq(sharedLinks.conversationId, conversationId),
                isNotNull(sharedLinks.revokedAt)
              )
            )
            .returning(sharedLinkColumns),
          storeFailure
        ).map((rows) => rows[0] ?? null),

      updateDisplayName: ({ conversationId, linkId, displayName }) =>
        fromPromise(
          db
            .update(sharedLinks)
            .set({ displayName })
            .where(
              and(
                eq(sharedLinks.id, linkId),
                eq(sharedLinks.conversationId, conversationId),
                isNull(sharedLinks.revokedAt)
              )
            )
            .returning({ id: sharedLinks.id }),
          storeFailure
        ).map((rows) => rows.length > 0),
    },

    sharedMessages: {
      insert: ({ messageId, createdBy, wrappedContentKey }) =>
        fromPromise(
          db
            .insert(sharedMessages)
            .values({ messageId, createdBy, wrappedContentKey })
            .returning({ id: sharedMessages.id, createdAt: sharedMessages.createdAt }),
          storeFailure
        ).map((rows) => {
          const row = rows[0];
          if (row === undefined)
            throw new Error('conversations: shared message insert returned no row');
          return row;
        }),

      byId: (shareId) => selectSharedMessage(db, shareId),
    },
  };
}

/**
 * Content items for a set of message ids, grouped by message and ordered by
 * position. Shared by the history read and the public-share read so the
 * `content_items` projection lives in exactly one place.
 */
function contentItemsByMessage(
  db: DbWriter,
  messageIds: readonly string[]
): ResultAsync<Map<string, ContentItemRow[]>, DomainError> {
  if (messageIds.length === 0) return okAsync(new Map<string, ContentItemRow[]>());
  return fromPromise(
    db
      .select({
        id: contentItems.id,
        messageId: contentItems.messageId,
        position: contentItems.position,
        contentType: contentItems.contentType,
        mimeType: contentItems.mimeType,
        sizeBytes: contentItems.sizeBytes,
        encryptedBlob: contentItems.encryptedBlob,
      })
      .from(contentItems)
      .where(inArray(contentItems.messageId, [...messageIds]))
      .orderBy(asc(contentItems.position), asc(contentItems.id)),
    storeFailure
  ).map((rows) => {
    const byMessage = new Map<string, ContentItemRow[]>();
    for (const row of rows) {
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  });
}

/**
 * The active-member public-key set, ordered by `joinedAt`. The union of user
 * members and link members cannot be a single ORDER BY, so the merge sorts in
 * memory (legacy parity). Extracted to module scope so its query nesting stays
 * shallow.
 */
function selectActiveMemberKeys(
  db: DbWriter,
  conversationId: string
): ResultAsync<MemberKeyRecord[], DomainError> {
  const active = and(
    eq(conversationMembers.conversationId, conversationId),
    isNull(conversationMembers.leftAt)
  );
  const userRows = fromPromise(
    db
      .select({
        memberId: conversationMembers.id,
        userId: conversationMembers.userId,
        publicKey: users.publicKey,
        privilege: conversationMembers.privilege,
        visibleFromEpoch: conversationMembers.visibleFromEpoch,
        joinedAt: conversationMembers.joinedAt,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(conversationMembers.userId, users.id))
      .where(active),
    storeFailure
  );
  const linkRows = fromPromise(
    db
      .select({
        memberId: conversationMembers.id,
        linkId: conversationMembers.linkId,
        publicKey: sharedLinks.linkPublicKey,
        privilege: conversationMembers.privilege,
        visibleFromEpoch: conversationMembers.visibleFromEpoch,
        joinedAt: conversationMembers.joinedAt,
      })
      .from(conversationMembers)
      .innerJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
      .where(active),
    storeFailure
  );
  return userRows.andThen((fromUsers) =>
    linkRows.map((fromLinks) => mergeMemberKeys(fromUsers, fromLinks))
  );
}

type SortableKey = MemberKeyRecord & { readonly joinedAt: Date };

function mergeMemberKeys(
  fromUsers: readonly Omit<SortableKey, 'linkId'>[],
  fromLinks: readonly Omit<SortableKey, 'userId'>[]
): MemberKeyRecord[] {
  const all: SortableKey[] = [
    ...fromUsers.map((row) => ({ ...row, linkId: null })),
    ...fromLinks.map((row) => ({ ...row, userId: null })),
  ];
  all.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  return all.map((row) => ({
    memberId: row.memberId,
    userId: row.userId,
    linkId: row.linkId,
    publicKey: row.publicKey,
    privilege: row.privilege,
    visibleFromEpoch: row.visibleFromEpoch,
  }));
}

/** A page of message history with content items attached per message. */
function selectMessageHistory(
  db: DbWriter,
  params: {
    readonly conversationId: string;
    readonly minEpoch: number;
    readonly afterSequence: number | null;
    readonly limit: number;
  }
): ResultAsync<HistoryMessageRow[], DomainError> {
  return fromPromise(
    db
      .select({
        id: messages.id,
        parentMessageId: messages.parentMessageId,
        sequenceNumber: messages.sequenceNumber,
        epochNumber: messages.epochNumber,
        senderType: messages.senderType,
        senderId: messages.senderId,
        wrappedContentKey: messages.wrappedContentKey,
        batchId: messages.batchId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, params.conversationId),
          gte(messages.epochNumber, params.minEpoch),
          params.afterSequence === null
            ? undefined
            : gt(messages.sequenceNumber, params.afterSequence)
        )
      )
      .orderBy(asc(messages.sequenceNumber))
      .limit(params.limit),
    storeFailure
  ).andThen((rows) =>
    contentItemsByMessage(
      db,
      rows.map((row) => row.id)
    ).map((byMessage) => rows.map((row) => ({ ...row, contentItems: byMessage.get(row.id) ?? [] })))
  );
}

/** One standalone share by id, with its message's content items attached. */
function selectSharedMessage(
  db: DbWriter,
  shareId: string
): ResultAsync<SharedMessageRecord | null, DomainError> {
  return fromPromise(
    db
      .select({
        id: sharedMessages.id,
        messageId: sharedMessages.messageId,
        wrappedContentKey: sharedMessages.wrappedContentKey,
        createdAt: sharedMessages.createdAt,
      })
      .from(sharedMessages)
      .where(eq(sharedMessages.id, shareId)),
    storeFailure
  ).andThen((rows) => {
    const row = rows[0];
    if (row === undefined) return okAsync<SharedMessageRecord | null, DomainError>(null);
    return contentItemsByMessage(db, [row.messageId]).map((byMessage) => ({
      ...row,
      contentItems: byMessage.get(row.messageId) ?? [],
    }));
  });
}

function insertFork(
  db: DbWriter,
  params: {
    readonly id: string | null;
    readonly conversationId: string;
    readonly name: string;
    readonly tipMessageId: string | null;
    readonly createdAt?: Date | undefined;
  }
): ResultAsync<ForkRecord | 'name-taken', DomainError> {
  return fromPromise(insertForkRow(db, params), storeFailure);
}

async function insertForkRow(
  db: DbWriter,
  params: {
    readonly id: string | null;
    readonly conversationId: string;
    readonly name: string;
    readonly tipMessageId: string | null;
    readonly createdAt?: Date | undefined;
  }
): Promise<ForkRecord | 'name-taken'> {
  const values = {
    conversationId: params.conversationId,
    name: params.name,
    tipMessageId: params.tipMessageId,
    ...(params.id === null ? {} : { id: params.id }),
    ...(params.createdAt === undefined ? {} : { createdAt: params.createdAt }),
  };
  try {
    const rows = await db.insert(conversationForks).values(values).returning(forkColumns);
    const row = rows[0];
    if (row === undefined) throw new Error('fork insert returned no row');
    return row;
  } catch (error) {
    if (isUniqueViolationOn(error, FORK_NAME_UNIQUE)) return 'name-taken';
    throw error;
  }
}

async function renameForkRow(
  db: DbWriter,
  params: { readonly conversationId: string; readonly forkId: string; readonly name: string }
): Promise<ForkRecord | 'name-taken' | null> {
  try {
    const rows = await db
      .update(conversationForks)
      .set({ name: params.name })
      .where(
        and(
          eq(conversationForks.id, params.forkId),
          eq(conversationForks.conversationId, params.conversationId)
        )
      )
      .returning(forkColumns);
    return rows[0] ?? null;
  } catch (error) {
    if (isUniqueViolationOn(error, FORK_NAME_UNIQUE)) return 'name-taken';
    throw error;
  }
}
