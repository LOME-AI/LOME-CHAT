import { and, eq, isNull } from 'drizzle-orm';
import {
  conversations,
  conversationMembers,
  payments,
  sharedLinks,
  type Database,
} from '@hushbox/db';

export class ResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = 'ResourceNotFoundError';
  }
}

export async function getOwnedConversation(
  db: Database,
  conversationId: string,
  userId: string
): Promise<typeof conversations.$inferSelect> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));

  if (!conversation) {
    throw new ResourceNotFoundError('Conversation');
  }

  return conversation;
}

export async function getOwnedPayment(
  db: Database,
  paymentId: string,
  userId: string
): Promise<typeof payments.$inferSelect> {
  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.userId, userId)));

  if (!payment) {
    throw new ResourceNotFoundError('Payment');
  }

  return payment;
}

export interface ActiveMember {
  id: string;
  privilege: string;
  userId: string | null;
}

/** Finds an active (not left) conversation member by memberId and conversationId. */
export async function findActiveMember(
  db: Database,
  memberId: string,
  conversationId: string
): Promise<ActiveMember | undefined> {
  const rows = await db
    .select({
      id: conversationMembers.id,
      privilege: conversationMembers.privilege,
      userId: conversationMembers.userId,
    })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.id, memberId),
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.leftAt)
      )
    )
    .limit(1);
  return rows[0];
}

export interface ActiveSharedLink {
  id: string;
  displayName: string | null;
}

/** Finds an active (not revoked) shared link by conversationId and linkPublicKey. */
export async function findActiveSharedLink(
  db: Database,
  conversationId: string,
  linkPublicKey: Uint8Array
): Promise<ActiveSharedLink | undefined> {
  const rows = await db
    .select({
      id: sharedLinks.id,
      displayName: sharedLinks.displayName,
    })
    .from(sharedLinks)
    .where(
      and(
        eq(sharedLinks.conversationId, conversationId),
        eq(sharedLinks.linkPublicKey, linkPublicKey),
        isNull(sharedLinks.revokedAt)
      )
    )
    .limit(1);
  return rows[0];
}
