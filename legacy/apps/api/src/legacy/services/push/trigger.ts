import { and, eq, isNull, ne, inArray } from 'drizzle-orm';
import { conversationMembers, deviceTokens, type Database } from '@hushbox/db';
import type { PushClient } from './types.js';

interface SendPushParams {
  db: Database;
  pushClient: PushClient;
  conversationId: string;
  senderUserId: string;
  title: string;
  body: string;
  /**
   * User ids currently connected to this conversation's Durable Object via
   * WebSocket. Members in this set have the conversation open and will see
   * the message inline; the push notification is suppressed for them so they
   * don't double-notify. Pass `undefined` (or omit) to skip the filter.
   */
  activeUserIds?: Set<string>;
}

/**
 * Sends push notifications to all active, unmuted conversation members
 * (excluding the sender) who have registered device tokens.
 *
 * This is a fire-and-forget operation — errors are caught and logged,
 * never propagated to the caller.
 */
export async function sendPushForNewMessage(params: SendPushParams): Promise<void> {
  const { db, pushClient, conversationId, senderUserId, title, body, activeUserIds } = params;

  try {
    const members = await db
      .select({
        userId: conversationMembers.userId,
        muted: conversationMembers.muted,
      })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          isNull(conversationMembers.leftAt),
          ne(conversationMembers.userId, senderUserId)
        )
      );

    const recipientUserIds: string[] = [];
    for (const m of members) {
      if (m.muted || m.userId === null) continue;
      if (activeUserIds?.has(m.userId)) continue;
      recipientUserIds.push(m.userId);
    }

    if (recipientUserIds.length === 0) {
      return;
    }

    const tokens = await db
      .select({
        token: deviceTokens.token,
      })
      .from(deviceTokens)
      .where(inArray(deviceTokens.userId, recipientUserIds));

    const tokenStrings = tokens.map((t) => t.token);

    if (tokenStrings.length === 0) {
      return;
    }

    await pushClient.send({
      tokens: tokenStrings,
      title,
      body,
      data: { conversationId },
    });
  } catch {
    // Silently swallow — push notifications are best-effort
  }
}
