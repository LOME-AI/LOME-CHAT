import { eq, ne, and, desc, inArray } from 'drizzle-orm';
import { conversationForks, messages, type Database } from '@hushbox/db';
import {
  MAX_FORKS_PER_CONVERSATION,
  ERROR_CODE_FORK_LIMIT_REACHED,
  ERROR_CODE_FORK_NAME_TAKEN,
} from '@hushbox/shared';
import { isUniqueViolation } from '../../lib/unique-violation.js';

export class ForkError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ForkError';
  }
}

export interface CreateForkParams {
  id: string;
  conversationId: string;
  fromMessageId: string;
  name?: string;
}

export interface ForkRecord {
  id: string;
  conversationId: string;
  name: string;
  tipMessageId: string | null;
  createdAt: Date;
}

export interface CreateForkResult {
  forks: ForkRecord[];
  isNew: boolean;
}

export interface DeleteForkParams {
  conversationId: string;
  forkId: string;
}

export interface DeleteForkResult {
  remainingForks: { id: string; name: string; tipMessageId: string | null }[];
}

export interface RenameForkParams {
  forkId: string;
  conversationId: string;
  name: string;
}

/**
 * Fetches all fork records for a conversation, ordered by creation time.
 */
async function fetchAllForks(db: Database, conversationId: string): Promise<ForkRecord[]> {
  return db
    .select({
      id: conversationForks.id,
      conversationId: conversationForks.conversationId,
      name: conversationForks.name,
      tipMessageId: conversationForks.tipMessageId,
      createdAt: conversationForks.createdAt,
    })
    .from(conversationForks)
    .where(eq(conversationForks.conversationId, conversationId))
    .orderBy(conversationForks.createdAt);
}

/**
 * Generates the next auto-name for a fork.
 * Scans existing fork names of the form "Fork N" and picks the next sequential number.
 */
function nextAutoName(existingForks: ForkRecord[]): string {
  let maxNumber = 0;
  for (const fork of existingForks) {
    const match = /^Fork (\d+)$/.exec(fork.name);
    if (match) {
      const matchedDigits = match[1];
      if (!matchedDigits) continue;
      const number_ = Number.parseInt(matchedDigits, 10);
      if (number_ > maxNumber) {
        maxNumber = number_;
      }
    }
  }
  return `Fork ${String(maxNumber + 1)}`;
}

/**
 * Collects the ancestor chain from a given message ID to the root,
 * following parentMessageId links. Returns the set of message IDs.
 */
async function collectAncestorChain(
  db: Database,
  conversationId: string,
  tipMessageId: string | null
): Promise<Set<string>> {
  const chain = new Set<string>();
  let currentId = tipMessageId;

  while (currentId) {
    chain.add(currentId);
    const [msg] = await db
      .select({ parentMessageId: messages.parentMessageId })
      .from(messages)
      .where(and(eq(messages.id, currentId), eq(messages.conversationId, conversationId)));
    currentId = msg?.parentMessageId ?? null;
  }

  return chain;
}

/** Wraps an insert with unique-violation → ForkError re-throw. */
async function insertWithUniqueCheck(
  insertFunction: () => PromiseLike<unknown>,
  forkName: string
): Promise<void> {
  try {
    await insertFunction();
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw new ForkError(ERROR_CODE_FORK_NAME_TAKEN, `Fork name "${forkName}" already taken`);
    }
    throw error;
  }
}

interface InsertForksParams {
  db: Database;
  conversationId: string;
  id: string;
  forkName: string;
  fromMessageId: string;
}

/** Creates the initial "Main" + new fork when no forks exist yet. */
async function insertFirstForks(params: InsertForksParams): Promise<void> {
  const { db, conversationId, id, forkName, fromMessageId } = params;
  const [latestMessage] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.sequenceNumber))
    .limit(1);

  const mainTip = latestMessage?.id ?? null;
  const now = new Date();

  await insertWithUniqueCheck(
    () =>
      db.insert(conversationForks).values([
        { conversationId, name: 'Main', tipMessageId: mainTip, createdAt: now },
        {
          id,
          conversationId,
          name: forkName,
          tipMessageId: fromMessageId,
          createdAt: new Date(now.getTime() + 1),
        },
      ]),
    forkName
  );
}

/** Creates a subsequent fork when forks already exist. */
async function insertAdditionalFork(params: InsertForksParams): Promise<void> {
  const { db, conversationId, id, forkName, fromMessageId } = params;
  await insertWithUniqueCheck(
    () =>
      db.insert(conversationForks).values({
        id,
        conversationId,
        name: forkName,
        tipMessageId: fromMessageId,
      }),
    forkName
  );
}

/**
 * Creates a new fork in a conversation. Idempotent on fork ID.
 *
 * When no forks exist yet, creates both a "Main" fork (pointing to the
 * latest message by sequence number) and the new fork (pointing to fromMessageId).
 *
 * When forks already exist, creates only the new fork record.
 */
export async function createFork(
  db: Database,
  params: CreateForkParams
): Promise<CreateForkResult> {
  const { id, conversationId, fromMessageId, name } = params;

  // Idempotency: check if fork with this ID already exists
  const [existingFork] = await db
    .select({ id: conversationForks.id })
    .from(conversationForks)
    .where(eq(conversationForks.id, id));

  if (existingFork) {
    const forks = await fetchAllForks(db, conversationId);
    return { forks, isNew: false };
  }

  const existingForks = await fetchAllForks(db, conversationId);

  if (existingForks.length >= MAX_FORKS_PER_CONVERSATION) {
    throw new ForkError(
      ERROR_CODE_FORK_LIMIT_REACHED,
      `Maximum of ${String(MAX_FORKS_PER_CONVERSATION)} forks per conversation reached`
    );
  }

  const forkName = name ?? nextAutoName(existingForks);

  const insertParams: InsertForksParams = { db, conversationId, id, forkName, fromMessageId };
  if (existingForks.length === 0) {
    await insertFirstForks(insertParams);
  } else {
    await insertAdditionalFork(insertParams);
  }

  const forks = await fetchAllForks(db, conversationId);
  return { forks, isNew: true };
}

/**
 * Deletes a fork and its exclusive messages.
 *
 * "Exclusive messages" are messages whose only path to any fork tip goes
 * through the deleted fork. These are identified by walking the deleted
 * fork's tip chain and checking each message against all other fork chains.
 *
 * If only one fork remains after deletion, that fork is also removed
 * (reverting the conversation to linear mode).
 *
 * Idempotent: if the fork is already deleted, returns remaining forks.
 */
export async function deleteFork(
  db: Database,
  params: DeleteForkParams
): Promise<DeleteForkResult> {
  const { conversationId, forkId } = params;

  // Get the fork to delete (may not exist if already deleted)
  const [targetFork] = await db
    .select({
      id: conversationForks.id,
      tipMessageId: conversationForks.tipMessageId,
    })
    .from(conversationForks)
    .where(
      and(eq(conversationForks.id, forkId), eq(conversationForks.conversationId, conversationId))
    );

  if (!targetFork) {
    // Already deleted — return remaining forks (idempotent)
    const remaining = await fetchAllForks(db, conversationId);
    return {
      remainingForks: remaining.map((f) => ({
        id: f.id,
        name: f.name,
        tipMessageId: f.tipMessageId,
      })),
    };
  }

  const otherForks = await db
    .select({
      id: conversationForks.id,
      tipMessageId: conversationForks.tipMessageId,
    })
    .from(conversationForks)
    .where(
      and(eq(conversationForks.conversationId, conversationId), ne(conversationForks.id, forkId))
    );

  const otherChains = new Set<string>();
  for (const otherFork of otherForks) {
    const chain = await collectAncestorChain(db, conversationId, otherFork.tipMessageId);
    for (const msgId of chain) {
      otherChains.add(msgId);
    }
  }

  const deletedChain = await collectAncestorChain(db, conversationId, targetFork.tipMessageId);

  // Find exclusive messages: in deleted chain but not in any other chain
  const exclusiveMessageIds: string[] = [];
  for (const msgId of deletedChain) {
    if (!otherChains.has(msgId)) {
      exclusiveMessageIds.push(msgId);
    }
  }

  if (exclusiveMessageIds.length > 0) {
    await db.delete(messages).where(inArray(messages.id, exclusiveMessageIds));
  }

  await db.delete(conversationForks).where(eq(conversationForks.id, forkId));

  const remaining = await fetchAllForks(db, conversationId);

  // If only one fork remains, revert to linear (delete all fork records)
  if (remaining.length === 1) {
    await db.delete(conversationForks).where(eq(conversationForks.conversationId, conversationId));
    return { remainingForks: [] };
  }

  return {
    remainingForks: remaining.map((f) => ({
      id: f.id,
      name: f.name,
      tipMessageId: f.tipMessageId,
    })),
  };
}

/**
 * Renames a fork. Atomic UPDATE with WHERE clause.
 * Unique constraint on (conversation_id, name) catches duplicates.
 * Renaming to the same name is a no-op (UPDATE sets same value).
 */

export async function renameFork(db: Database, params: RenameForkParams): Promise<void> {
  const { forkId, conversationId, name } = params;

  try {
    await db
      .update(conversationForks)
      .set({ name })
      .where(
        and(eq(conversationForks.id, forkId), eq(conversationForks.conversationId, conversationId))
      );
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw new ForkError(ERROR_CODE_FORK_NAME_TAKEN, `Fork name "${name}" already taken`);
    }
    throw error;
  }
}
