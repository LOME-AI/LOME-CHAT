import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import {
  sharedLinks,
  conversationMembers,
  epochMembers,
  conversations,
  epochs,
  type Database,
  type DatabaseClient,
} from '@hushbox/db';
import { submitRotation, StaleEpochError, type SubmitRotationParams } from '../keys/keys.js';

export interface LinkListItem {
  id: string;
  linkPublicKey: Uint8Array;
  privilege: string;
  displayName: string | null;
  createdAt: Date;
}

export interface CreateLinkParams {
  conversationId: string;
  linkPublicKey: Uint8Array;
  memberWrap: Uint8Array;
  privilege: string;
  visibleFromEpoch: number;
  currentEpochId: string;
  displayName?: string;
  rotation?: SubmitRotationParams;
}

export interface CreateLinkResult {
  linkId: string;
  memberId: string;
}

export interface RevokeResult {
  revoked: boolean;
  memberId: string | null;
}

export interface ChangeLinkPrivilegeParams {
  conversationId: string;
  linkId: string;
  privilege: string;
}

export interface ChangeLinkPrivilegeResult {
  changed: boolean;
  memberId: string | null;
}

/**
 * Returns all active (non-revoked) shared links for a conversation,
 * with privilege sourced from conversationMembers (single source of truth).
 * Ordered by createdAt descending.
 */
export async function listLinks(db: Database, conversationId: string): Promise<LinkListItem[]> {
  return db
    .select({
      id: sharedLinks.id,
      linkPublicKey: sharedLinks.linkPublicKey,
      privilege: conversationMembers.privilege,
      displayName: sharedLinks.displayName,
      createdAt: sharedLinks.createdAt,
    })
    .from(sharedLinks)
    .innerJoin(
      conversationMembers,
      and(eq(conversationMembers.linkId, sharedLinks.id), isNull(conversationMembers.leftAt))
    )
    .where(and(eq(sharedLinks.conversationId, conversationId), isNull(sharedLinks.revokedAt)))
    .orderBy(desc(sharedLinks.createdAt));
}

/** Resolves the display name for a link, generating "Guest N" if not provided. */
async function resolveDisplayName(
  txDb: DatabaseClient,
  conversationId: string,
  providedName?: string
): Promise<string> {
  if (providedName !== undefined) return providedName;
  const [row] = await txDb
    .select({ count: sql<number>`count(*)::int` })
    .from(sharedLinks)
    .where(eq(sharedLinks.conversationId, conversationId));
  return `Guest ${String((row?.count ?? 0) + 1)}`;
}

/**
 * Atomically creates a shared link with its associated epoch member
 * and conversation member rows.
 */

export async function createLink(
  db: Database,
  params: CreateLinkParams
): Promise<CreateLinkResult> {
  return db.transaction(async (tx) => {
    const txDb = tx;

    // Step 0: Lock conversation row and verify epoch freshness.
    const [conv] = await txDb
      .select({ currentEpoch: conversations.currentEpoch })
      .from(conversations)
      .where(eq(conversations.id, params.conversationId))
      .for('update');

    if (!conv) {
      throw new Error('Conversation not found');
    }

    const [epoch] = await txDb
      .select({ id: epochs.id })
      .from(epochs)
      .where(
        and(
          eq(epochs.conversationId, params.conversationId),
          eq(epochs.epochNumber, conv.currentEpoch)
        )
      );

    if (!epoch?.id || epoch.id !== params.currentEpochId) {
      throw new StaleEpochError(conv.currentEpoch);
    }

    const displayName = await resolveDisplayName(txDb, params.conversationId, params.displayName);

    // 2. Upsert sharedLinks row — idempotent on duplicate linkPublicKey
    const [link] = await tx
      .insert(sharedLinks)
      .values({
        conversationId: params.conversationId,
        linkPublicKey: params.linkPublicKey,
        displayName,
      })
      .onConflictDoUpdate({
        target: sharedLinks.linkPublicKey,
        set: { id: sql`shared_links.id` },
      })
      .returning({ id: sharedLinks.id });

    if (!link) {
      throw new Error('Failed to insert shared link');
    }

    const [member] = await tx
      .insert(conversationMembers)
      .values({
        conversationId: params.conversationId,
        linkId: link.id,
        userId: null,
        privilege: params.privilege,
        visibleFromEpoch: params.visibleFromEpoch,
        acceptedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [conversationMembers.conversationId, conversationMembers.linkId],
        targetWhere: isNull(conversationMembers.leftAt),
        set: { id: sql`conversation_members.id` },
      })
      .returning({ id: conversationMembers.id });

    if (!member) {
      throw new Error('Failed to insert conversation member');
    }

    if (params.rotation) {
      await submitRotation(txDb, params.rotation);
    } else {
      await tx
        .insert(epochMembers)
        .values({
          epochId: params.currentEpochId,
          memberPublicKey: params.linkPublicKey,
          wrap: params.memberWrap,
          visibleFromEpoch: params.visibleFromEpoch,
        })
        .onConflictDoUpdate({
          target: [epochMembers.epochId, epochMembers.memberPublicKey],
          set: { id: sql`epoch_members.id` },
        });
    }

    return { linkId: link.id, memberId: member.id };
  });
}

/**
 * Changes the privilege of a shared link and its associated conversation member.
 * No key rotation — privilege changes don't revoke access.
 * Returns { changed: false, memberId: null } if the link is not found or already revoked.
 */
export async function changeLinkPrivilege(
  db: Database,
  params: ChangeLinkPrivilegeParams
): Promise<ChangeLinkPrivilegeResult> {
  const [link] = await db
    .select({ id: sharedLinks.id })
    .from(sharedLinks)
    .where(
      and(
        eq(sharedLinks.id, params.linkId),
        eq(sharedLinks.conversationId, params.conversationId),
        isNull(sharedLinks.revokedAt)
      )
    )
    .limit(1);

  if (!link) {
    return { changed: false, memberId: null };
  }

  // Update conversationMembers.privilege (single source of truth)
  const [member] = await db
    .update(conversationMembers)
    .set({ privilege: params.privilege })
    .where(and(eq(conversationMembers.linkId, params.linkId), isNull(conversationMembers.leftAt)))
    .returning({ id: conversationMembers.id });

  return { changed: true, memberId: member?.id ?? null };
}

/**
 * Revokes a shared link and triggers key rotation.
 * Returns { revoked: false, memberId: null } if the link is not found or already revoked.
 */
export async function revokeLink(
  db: Database,
  linkId: string,
  conversationId: string,
  rotationParams: SubmitRotationParams
): Promise<RevokeResult> {
  return db.transaction(async (tx) => {
    const now = new Date();

    // Step 1: Atomic idempotency — only revoke if revokedAt IS NULL
    const [link] = await tx
      .update(sharedLinks)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sharedLinks.id, linkId),
          eq(sharedLinks.conversationId, conversationId),
          isNull(sharedLinks.revokedAt)
        )
      )
      .returning({ id: sharedLinks.id });

    if (!link) {
      return { revoked: false, memberId: null };
    }

    const [member] = await tx
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.linkId, linkId), isNull(conversationMembers.leftAt)));

    if (!member) {
      return { revoked: true, memberId: null };
    }

    await tx
      .update(conversationMembers)
      .set({ leftAt: now })
      .where(and(eq(conversationMembers.linkId, linkId), isNull(conversationMembers.leftAt)));

    // Step 4: Rotate epoch to revoke access
    await submitRotation(tx, rotationParams);

    return { revoked: true, memberId: member.id };
  });
}
