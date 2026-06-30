import { eq, and, isNull, isNotNull, asc, inArray } from 'drizzle-orm';
import {
  conversations,
  epochs,
  epochMembers,
  conversationMembers,
  users,
  sharedLinks,
  type Database,
  type DatabaseClient,
} from '@hushbox/db';
import {
  toBase64,
  fromBase64,
  ERROR_CODE_STALE_EPOCH,
  ERROR_CODE_WRAP_SET_MISMATCH,
} from '@hushbox/shared';
import { createErrorResponse } from '../../lib/error-response.js';
import type { Context } from 'hono';
import type { AppEnv } from '../../types.js';

export interface KeyChainWrap {
  epochNumber: number;
  wrap: Uint8Array;
  confirmationHash: Uint8Array;
  visibleFromEpoch: number;
}

export interface KeyChainLink {
  epochNumber: number;
  chainLink: Uint8Array;
  confirmationHash: Uint8Array;
}

export interface KeyChainResult {
  wraps: KeyChainWrap[];
  chainLinks: KeyChainLink[];
  currentEpoch: number;
}

export interface MemberKey {
  memberId: string;
  userId: string | null;
  linkId: string | null;
  publicKey: Uint8Array;
  privilege: string;
  visibleFromEpoch: number;
}

/**
 * Returns everything the client needs to build its epoch key chain in a single query set.
 * Returns null if the user has no wraps (not a member).
 */
export async function getKeyChain(
  db: Database,
  conversationId: string,
  userPublicKey: Uint8Array
): Promise<KeyChainResult | null> {
  const wrapsRows = await db
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
        eq(epochMembers.memberPublicKey, userPublicKey)
      )
    )
    .orderBy(asc(epochs.epochNumber));

  if (wrapsRows.length === 0) {
    return null;
  }

  const chainLinksRows = await db
    .select({
      epochNumber: epochs.epochNumber,
      chainLink: epochs.chainLink,
      confirmationHash: epochs.confirmationHash,
    })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), isNotNull(epochs.chainLink)))
    .orderBy(asc(epochs.epochNumber));

  const [conversation] = await db
    .select({ currentEpoch: conversations.currentEpoch })
    .from(conversations)
    .where(eq(conversations.id, conversationId));

  return assembleKeyChain(wrapsRows, chainLinksRows, conversation?.currentEpoch);
}

function groupBy<T>(items: T[], keyFunction: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFunction(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

function assembleKeyChain(
  wraps: KeyChainWrap[],
  chainLinks: { epochNumber: number; chainLink: Uint8Array | null; confirmationHash: Uint8Array }[],
  currentEpoch: number | undefined
): KeyChainResult | null {
  if (wraps.length === 0 || currentEpoch === undefined) return null;

  const visibleFromEpoch = Math.min(...wraps.map((w) => w.visibleFromEpoch));
  const filteredWraps = wraps.filter((w) => w.epochNumber >= visibleFromEpoch);
  const filteredChainLinks = chainLinks.filter((cl) => cl.epochNumber > visibleFromEpoch);

  return {
    wraps: filteredWraps,
    chainLinks: filteredChainLinks as KeyChainLink[],
    currentEpoch,
  };
}

/**
 * Batch version of getKeyChain: fetches key chains for multiple conversations
 * in 3 DB queries total (not N×3). Returns a Map keyed by conversationId.
 * Conversations where the user has no wraps are omitted from the result.
 */
export async function getKeyChainBatch(
  db: Database,
  conversationIds: string[],
  userPublicKey: Uint8Array
): Promise<Map<string, KeyChainResult>> {
  if (conversationIds.length === 0) return new Map();

  const allWraps = await db
    .select({
      conversationId: epochs.conversationId,
      epochNumber: epochs.epochNumber,
      wrap: epochMembers.wrap,
      confirmationHash: epochs.confirmationHash,
      visibleFromEpoch: epochMembers.visibleFromEpoch,
    })
    .from(epochMembers)
    .innerJoin(epochs, eq(epochMembers.epochId, epochs.id))
    .where(
      and(
        inArray(epochs.conversationId, conversationIds),
        eq(epochMembers.memberPublicKey, userPublicKey)
      )
    )
    .orderBy(asc(epochs.conversationId), asc(epochs.epochNumber));

  const allChainLinks = await db
    .select({
      conversationId: epochs.conversationId,
      epochNumber: epochs.epochNumber,
      chainLink: epochs.chainLink,
      confirmationHash: epochs.confirmationHash,
    })
    .from(epochs)
    .where(and(inArray(epochs.conversationId, conversationIds), isNotNull(epochs.chainLink)))
    .orderBy(asc(epochs.conversationId), asc(epochs.epochNumber));

  const allConversations = await db
    .select({ id: conversations.id, currentEpoch: conversations.currentEpoch })
    .from(conversations)
    .where(inArray(conversations.id, conversationIds));

  const currentEpochMap = new Map(allConversations.map((c) => [c.id, c.currentEpoch]));

  const wrapsByConv = groupBy(allWraps, (w) => w.conversationId);
  const chainLinksByConv = groupBy(allChainLinks, (cl) => cl.conversationId);

  const results = new Map<string, KeyChainResult>();
  for (const convId of conversationIds) {
    const result = assembleKeyChain(
      wrapsByConv.get(convId) ?? [],
      chainLinksByConv.get(convId) ?? [],
      currentEpochMap.get(convId)
    );
    if (result) results.set(convId, result);
  }
  return results;
}

/**
 * Returns public keys of all active members (leftAt IS NULL).
 * Includes both user members (publicKey from users table) and
 * link members (linkPublicKey from sharedLinks table).
 * Ordered by joinedAt ASC.
 */
export async function getMemberKeys(db: Database, conversationId: string): Promise<MemberKey[]> {
  const userMembers = await db
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
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.leftAt),
        isNotNull(conversationMembers.userId)
      )
    );

  const linkMembers = await db
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
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.leftAt),
        isNotNull(conversationMembers.linkId)
      )
    );

  const all: ((typeof userMembers)[number] | (typeof linkMembers)[number])[] = [
    ...userMembers,
    ...linkMembers,
  ];
  all.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());

  return all.map(
    (m): MemberKey => ({
      memberId: m.memberId,
      userId: 'userId' in m ? (m.userId ?? null) : null,
      linkId: 'linkId' in m ? (m.linkId ?? null) : null,
      publicKey: m.publicKey,
      privilege: m.privilege,
      visibleFromEpoch: m.visibleFromEpoch,
    })
  );
}

/**
 * Checks if a user is an active member of a conversation.
 * Returns the conversationMembers row or null.
 */
export async function verifyMembership(
  db: Database,
  conversationId: string,
  userId: string
): Promise<typeof conversationMembers.$inferSelect | null> {
  const [member] = await db
    .select()
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
        isNull(conversationMembers.leftAt)
      )
    );

  return member ?? null;
}

export class StaleEpochError extends Error {
  constructor(public readonly currentEpoch: number) {
    super(`Stale epoch: expected rotation from epoch ${String(currentEpoch)}`);
    this.name = 'StaleEpochError';
  }
}

export class WrapSetMismatchError extends Error {
  constructor(
    public readonly expectedCount: number,
    public readonly providedCount: number
  ) {
    super(
      `Wrap set mismatch: expected ${String(expectedCount)} members, got ${String(providedCount)}`
    );
    this.name = 'WrapSetMismatchError';
  }
}

export interface SubmitRotationParams {
  conversationId: string;
  expectedEpoch: number;
  epochPublicKey: Uint8Array;
  confirmationHash: Uint8Array;
  chainLink: Uint8Array;
  memberWraps: {
    memberPublicKey: Uint8Array;
    wrap: Uint8Array;
  }[];
  encryptedTitle: Uint8Array;
}

export interface SubmitRotationResult {
  newEpochNumber: number;
  newEpochId: string;
}

/**
 * Converts a Zod-parsed rotation schema (base64 strings) to SubmitRotationParams (Uint8Arrays).
 */
export function toRotationParams(
  conversationId: string,
  rotation: {
    expectedEpoch: number;
    epochPublicKey: string;
    confirmationHash: string;
    chainLink: string;
    memberWraps: {
      memberPublicKey: string;
      wrap: string;
    }[];
    encryptedTitle: string;
  }
): SubmitRotationParams {
  return {
    conversationId,
    expectedEpoch: rotation.expectedEpoch,
    epochPublicKey: fromBase64(rotation.epochPublicKey),
    confirmationHash: fromBase64(rotation.confirmationHash),
    chainLink: fromBase64(rotation.chainLink),
    memberWraps: rotation.memberWraps.map((mw) => ({
      memberPublicKey: fromBase64(mw.memberPublicKey),
      wrap: fromBase64(mw.wrap),
    })),
    encryptedTitle: fromBase64(rotation.encryptedTitle),
  };
}

/**
 * Validates that the provided member wraps match the active members exactly.
 * Throws WrapSetMismatchError if there are extra or missing wraps.
 */
function validateWrapSet(
  visibilityByKey: Map<string, number>,
  memberWraps: SubmitRotationParams['memberWraps']
): void {
  const expectedKeys = new Set(visibilityByKey.keys());
  const providedKeys = new Set(memberWraps.map((mw) => toBase64(mw.memberPublicKey)));

  if (
    expectedKeys.size !== providedKeys.size ||
    ![...expectedKeys].every((k) => providedKeys.has(k))
  ) {
    throw new WrapSetMismatchError(expectedKeys.size, providedKeys.size);
  }
}

/**
 * Handles rotation-related errors in route catch blocks.
 */
export function handleRotationError(error: unknown, c: Context<AppEnv>): Response {
  if (error instanceof StaleEpochError) {
    return c.json(
      createErrorResponse(ERROR_CODE_STALE_EPOCH, {
        currentEpoch: error.currentEpoch,
      }),
      409
    );
  }
  if (error instanceof WrapSetMismatchError) {
    return c.json(createErrorResponse(ERROR_CODE_WRAP_SET_MISMATCH), 400);
  }
  throw error;
}

/**
 * Atomically rotates a conversation to a new epoch.
 * Accepts a transaction handle (or regular Database) so it can be called
 * from within saveChatTurn()'s existing transaction.
 */
export async function submitRotation(
  tx: DatabaseClient,
  params: SubmitRotationParams
): Promise<SubmitRotationResult> {
  const { conversationId, expectedEpoch } = params;
  const newEpochNumber = expectedEpoch + 1;

  // Step 1: First-write-wins concurrency guard
  const updated = await tx
    .update(conversations)
    .set({
      currentEpoch: newEpochNumber,
      updatedAt: new Date(),
    })
    .where(and(eq(conversations.id, conversationId), eq(conversations.currentEpoch, expectedEpoch)))
    .returning({ currentEpoch: conversations.currentEpoch });

  if (updated.length === 0) {
    const [current] = await tx
      .select({ currentEpoch: conversations.currentEpoch })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    throw new StaleEpochError(current?.currentEpoch ?? expectedEpoch);
  }

  const [newEpoch] = await tx
    .insert(epochs)
    .values({
      conversationId,
      epochNumber: newEpochNumber,
      epochPublicKey: params.epochPublicKey,
      confirmationHash: params.confirmationHash,
      chainLink: params.chainLink,
    })
    .returning({ id: epochs.id });

  if (!newEpoch) {
    throw new Error('Failed to insert new epoch');
  }

  const newEpochId = newEpoch.id;

  // Step 3: Look up authoritative visibleFromEpoch from conversationMembers
  const userVisibility = await tx
    .select({
      publicKey: users.publicKey,
      visibleFromEpoch: conversationMembers.visibleFromEpoch,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(conversationMembers.userId, users.id))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.leftAt)
      )
    );

  const linkVisibility = await tx
    .select({
      publicKey: sharedLinks.linkPublicKey,
      visibleFromEpoch: conversationMembers.visibleFromEpoch,
    })
    .from(conversationMembers)
    .innerJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.leftAt)
      )
    );

  const visibilityByKey = new Map<string, number>();
  for (const row of [...userVisibility, ...linkVisibility]) {
    visibilityByKey.set(toBase64(row.publicKey), row.visibleFromEpoch);
  }

  validateWrapSet(visibilityByKey, params.memberWraps);

  // Step 4: Insert new epochMembers rows with server-enforced visibleFromEpoch
  await tx.insert(epochMembers).values(
    params.memberWraps.map((mw) => {
      const vfe = visibilityByKey.get(toBase64(mw.memberPublicKey));
      if (vfe === undefined) throw new Error('invariant: visibility missing for member key');
      return {
        epochId: newEpochId,
        memberPublicKey: mw.memberPublicKey,
        wrap: mw.wrap,
        visibleFromEpoch: vfe,
      };
    })
  );

  const [oldEpoch] = await tx
    .select({ id: epochs.id })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, expectedEpoch)));

  if (oldEpoch) {
    await tx.delete(epochMembers).where(eq(epochMembers.epochId, oldEpoch.id));
  }

  await tx
    .update(conversations)
    .set({
      title: params.encryptedTitle,
      titleEpochNumber: newEpochNumber,
    })
    .where(eq(conversations.id, conversationId));

  return { newEpochNumber, newEpochId };
}
