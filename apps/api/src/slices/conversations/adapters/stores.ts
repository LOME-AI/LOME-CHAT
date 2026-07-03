import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
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
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConversationsStores, ForkRecord } from '../ports/index.js';

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
            .select(sharedLinkColumns)
            .from(sharedLinks)
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
    },

    sharedMessages: {
      insert: ({ messageId, linkId, createdBy, wrappedContentKey }) =>
        fromPromise(
          db
            .insert(sharedMessages)
            .values({ messageId, linkId, createdBy, wrappedContentKey })
            .returning({ id: sharedMessages.id, createdAt: sharedMessages.createdAt }),
          storeFailure
        ).map((rows) => {
          const row = rows[0];
          if (row === undefined)
            throw new Error('conversations: shared message insert returned no row');
          return row;
        }),

      listForLink: (linkId) =>
        fromPromise(
          db
            .select({
              messageId: sharedMessages.messageId,
              wrappedContentKey: sharedMessages.wrappedContentKey,
              createdAt: sharedMessages.createdAt,
            })
            .from(sharedMessages)
            .where(eq(sharedMessages.linkId, linkId))
            .orderBy(asc(sharedMessages.createdAt), asc(sharedMessages.id)),
          storeFailure
        ),
    },
  };
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
