import { eq, and, desc, asc, gte, lt, or, isNull, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  conversations,
  messages,
  contentItems,
  epochs,
  epochMembers,
  conversationMembers,
  users,
  type Database,
  type DatabaseClient,
  type Conversation,
  type Message,
  type ContentItem,
} from '@hushbox/db';

/**
 * A message row joined with all of its content_items rows.
 * Content items are ordered by `position` within each message.
 */
export interface MessageWithContent extends Message {
  contentItems: ContentItem[];
}

/**
 * Fetches messages for a conversation and groups their content_items.
 * One round-trip each for messages and content items; the second query
 * uses `IN (...)` to get all content items in bulk.
 */
function buildMessagesWhereClause(
  conversationId: string,
  visibleFromEpoch?: number
): ReturnType<typeof eq> {
  const base = eq(messages.conversationId, conversationId);
  if (visibleFromEpoch === undefined || visibleFromEpoch <= 1) return base;
  // and() returns SQL | undefined; this usage is always defined because base is defined
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- and() with two defined operands always returns defined
  return and(base, gte(messages.epochNumber, visibleFromEpoch))!;
}

function groupContentItemsByMessage(items: ContentItem[]): Map<string, ContentItem[]> {
  const grouped = new Map<string, ContentItem[]>();
  for (const item of items) {
    const bucket = grouped.get(item.messageId);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(item.messageId, [item]);
    }
  }
  return grouped;
}

export async function fetchMessagesWithContent(
  db: DatabaseClient,
  conversationId: string,
  visibleFromEpoch?: number
): Promise<MessageWithContent[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(buildMessagesWhereClause(conversationId, visibleFromEpoch))
    .orderBy(asc(messages.sequenceNumber));

  if (rows.length === 0) return [];

  const messageIds = rows.map((m) => m.id);
  const items = await db
    .select()
    .from(contentItems)
    .where(inArray(contentItems.messageId, messageIds))
    .orderBy(asc(contentItems.messageId), asc(contentItems.position));

  const itemsByMessage = groupContentItemsByMessage(items);

  return rows.map((msg) => ({
    ...msg,
    contentItems: itemsByMessage.get(msg.id) ?? [],
  }));
}

export interface ConversationListRow {
  conversation: Conversation;
  acceptedAt: Date | null;
  invitedByUsername: string | null;
  privilege: string;
  muted: boolean;
  pinned: boolean;
}

export interface UpdateConversationParams {
  title: Uint8Array;
  titleEpochNumber: number;
}

export interface CreateOrGetConversationParams {
  id: string;
  title?: Uint8Array | undefined; // encrypted title from client
  epochPublicKey: Uint8Array;
  confirmationHash: Uint8Array;
  memberWrap: Uint8Array;
  userPublicKey: Uint8Array;
}

export interface CreateOrGetConversationResult {
  conversation: Conversation;
  messages?: MessageWithContent[] | undefined; // All messages when returning existing
  isNew: boolean; // true = created, false = existing
}

// SYNC: Must match conversations schema columns (snake_case from raw SQL)
// plus virtual `is_new` from RETURNING clause. See packages/db/src/schema/conversations.ts.
interface ConversationRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  title: Uint8Array;
  project_id: string | null;
  title_epoch_number: number;
  current_epoch: number;
  next_sequence: number;
  conversation_budget: string;
  created_at: Date;
  updated_at: Date;
  is_new: boolean;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: new Uint8Array(row.title),
    projectId: row.project_id ?? null,
    titleEpochNumber: row.title_epoch_number,
    currentEpoch: row.current_epoch,
    nextSequence: row.next_sequence,
    conversationBudget: row.conversation_budget,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

/**
 * List all conversations for a user, ordered by most recently updated.
 * Includes both owned conversations and conversations the user was added to as a member.
 * Returns membership acceptance state and inviter username for each conversation.
 */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

export interface PaginatedConversations {
  rows: ConversationListRow[];
  nextCursor: string | null;
}

/** Parses a base64-encoded cursor into {updatedAt, id}. Returns null if invalid. */
function parseCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64').toString());
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['updatedAt'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['id'] !== 'string'
    ) {
      return null;
    }
    const { updatedAt, id } = parsed as { updatedAt: string; id: string };
    const cursorDate = new Date(updatedAt);
    if (Number.isNaN(cursorDate.getTime())) return null;
    return { updatedAt: cursorDate, id };
  } catch {
    return null;
  }
}

export async function listConversations(
  db: Database,
  userId: string,
  options?: { limit?: number; cursor?: string }
): Promise<PaginatedConversations> {
  const inviter = alias(users, 'inviter');
  const limit = Math.min(options?.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);

  const conditions = [eq(conversationMembers.userId, userId), isNull(conversationMembers.leftAt)];

  if (options?.cursor) {
    const cursor = parseCursor(options.cursor);
    if (!cursor) return { rows: [], nextCursor: null };
    // (updatedAt, id) < (cursorDate, cursorId) for DESC ordering
    const cursorCondition = or(
      lt(conversations.updatedAt, cursor.updatedAt),
      and(eq(conversations.updatedAt, cursor.updatedAt), lt(conversations.id, cursor.id))
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = await db
    .select({
      id: conversations.id,
      userId: conversations.userId,
      title: conversations.title,
      projectId: conversations.projectId,
      titleEpochNumber: conversations.titleEpochNumber,
      currentEpoch: conversations.currentEpoch,
      nextSequence: conversations.nextSequence,
      conversationBudget: conversations.conversationBudget,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      acceptedAt: conversationMembers.acceptedAt,
      invitedByUsername: inviter.username,
      privilege: conversationMembers.privilege,
      muted: conversationMembers.muted,
      pinned: conversationMembers.pinned,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversationMembers.conversationId, conversations.id))
    .leftJoin(inviter, eq(conversationMembers.invitedByUserId, inviter.id))
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore) {
    const lastRow = pageRows.at(-1);
    if (!lastRow) throw new Error('invariant: hasMore but pageRows is empty');
    nextCursor = Buffer.from(
      JSON.stringify({ updatedAt: lastRow.updatedAt.toISOString(), id: lastRow.id })
    ).toString('base64');
  }

  return {
    rows: pageRows.map((row) => ({
      conversation: {
        id: row.id,
        userId: row.userId,
        title: row.title,
        projectId: row.projectId,
        titleEpochNumber: row.titleEpochNumber,
        currentEpoch: row.currentEpoch,
        nextSequence: row.nextSequence,
        conversationBudget: row.conversationBudget,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      acceptedAt: row.acceptedAt,
      invitedByUsername: row.invitedByUsername,
      privilege: row.privilege,
      muted: row.muted,
      pinned: row.pinned,
    })),
    nextCursor,
  };
}

/**
 * Creates a conversation or returns existing if ID already exists for this user.
 * Returns null if ID exists but belongs to different user (caller should return 404).
 *
 * On INSERT, atomically creates:
 * - The conversation row
 * - Epoch #1 with the provided public key and confirmation hash
 * - An epoch member linking the user's public key to the epoch
 * - A conversation member linking the user to the conversation
 *
 * Title is client-encrypted (Uint8Array). If not provided, inserts empty bytes.
 *
 * IMPORTANT: Entire operation wrapped in transaction so that:
 * - On retry, CTE will create fresh (not return empty existing)
 * - Epoch/member creation is atomic with conversation creation
 */
export async function createOrGetConversation(
  db: Database,
  userId: string,
  params: CreateOrGetConversationParams
): Promise<CreateOrGetConversationResult | null> {
  const conversationId = params.id;
  const title = params.title ?? new Uint8Array(0);

  return db.transaction(async (tx) => {
    // Single atomic query with row-level locking for concurrent requests.
    // ON CONFLICT DO UPDATE with no-op (id = EXCLUDED.id) ensures:
    // 1. If row doesn't exist: INSERT succeeds, xmax = 0
    // 2. If row exists AND same user: waits for lock, returns row with xmax != 0
    // 3. If row exists AND different user: WHERE fails, returns 0 rows
    // The WHERE clause ensures we never touch or return another user's data.
    const result = await tx.execute<ConversationRow>(sql`
      INSERT INTO ${conversations} (id, user_id, title, title_epoch_number, current_epoch, next_sequence)
      VALUES (${conversationId}, ${userId}, ${title}, 1, 1, 1)
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
        WHERE ${conversations}.user_id = EXCLUDED.user_id
      RETURNING *, (xmax = 0) AS is_new
    `);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const conversation = rowToConversation(row);
    const isNew = row.is_new;

    if (!isNew) {
      const existingMessages = await fetchMessagesWithContent(tx, conversation.id);

      return { conversation, messages: existingMessages, isNew: false };
    }

    const [epoch] = await tx
      .insert(epochs)
      .values({
        conversationId,
        epochNumber: 1,
        epochPublicKey: params.epochPublicKey,
        confirmationHash: params.confirmationHash,
        chainLink: null,
      })
      .returning();

    if (!epoch) {
      throw new Error('Failed to create epoch');
    }

    await tx.insert(epochMembers).values({
      epochId: epoch.id,
      memberPublicKey: params.userPublicKey,
      wrap: params.memberWrap,
      visibleFromEpoch: 1,
    });

    await tx.insert(conversationMembers).values({
      conversationId,
      userId,
      privilege: 'owner',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
      invitedByUserId: null,
    });

    return { conversation, isNew: true };
  });
}

export interface ConversationForMember {
  conversation: Conversation;
  messages: MessageWithContent[];
  acceptedAt: Date | null;
  invitedByUsername: string | null;
}

/**
 * Get a single conversation with messages, using a pre-resolved visibleFromEpoch.
 * Used when membership is already verified by middleware (e.g. requirePrivilege).
 * Returns null if conversation not found.
 *
 * If userId is provided, queries membership for acceptedAt and invitedByUsername.
 * If userId is NOT provided (link guest), returns acceptedAt as current date and invitedByUsername as null.
 */
export async function getConversationForMember(
  db: Database,
  conversationId: string,
  visibleFromEpoch: number,
  userId?: string
): Promise<ConversationForMember | null> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conversation) {
    return null;
  }

  const conversationMessages = await fetchMessagesWithContent(db, conversationId, visibleFromEpoch);

  if (!userId) {
    return {
      conversation,
      messages: conversationMessages,
      acceptedAt: new Date(),
      invitedByUsername: null,
    };
  }

  const inviter = alias(users, 'inviter');
  const memberRows = await db
    .select({
      acceptedAt: conversationMembers.acceptedAt,
      invitedByUsername: inviter.username,
    })
    .from(conversationMembers)
    .leftJoin(inviter, eq(conversationMembers.invitedByUserId, inviter.id))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
        isNull(conversationMembers.leftAt)
      )
    )
    .limit(1);

  const memberRow = memberRows[0];

  return {
    conversation,
    messages: conversationMessages,
    acceptedAt: memberRow?.acceptedAt ?? null,
    invitedByUsername: memberRow?.invitedByUsername ?? null,
  };
}

/**
 * Update a conversation's title.
 * Returns null if conversation not found or user doesn't own it.
 * Uses atomic conditional update - no check-then-act.
 */
export async function updateConversation(
  db: Database,
  conversationId: string,
  userId: string,
  params: UpdateConversationParams
): Promise<Conversation | null> {
  const [updated] = await db
    .update(conversations)
    .set({
      title: params.title,
      titleEpochNumber: params.titleEpochNumber,
      updatedAt: new Date(),
    })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning();

  return updated ?? null;
}

/**
 * Delete a conversation.
 * Returns true if deleted, false if not found or user doesn't own it.
 * Messages, epochs, epoch members, and conversation members are cascade-deleted via FK constraints.
 * Uses atomic conditional delete - no check-then-act.
 */
export async function deleteConversation(
  db: Database,
  conversationId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning({ id: conversations.id });

  return result.length > 0;
}
