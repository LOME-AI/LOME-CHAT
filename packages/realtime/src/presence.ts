import type { PresenceUpdateEvent } from './events.js';
import type { SocketAttachment } from './protocol.js';

/**
 * Presence is derived state: the open sockets' attachments are the record.
 * The legacy room emitted `conversationId: ''` because it never knew its
 * conversation — here the id is required (it rides every attachment) and an
 * empty value is rejected as a defect rather than broadcast.
 */
export function buildPresenceEvent(
  conversationId: string,
  attachments: readonly SocketAttachment[],
  now: number
): PresenceUpdateEvent {
  if (conversationId === '') {
    throw new Error('presence: conversationId is required');
  }
  return {
    type: 'presence:update',
    timestamp: now,
    conversationId,
    members: attachments.map((attachment) => ({
      ...(attachment.isGuest ? {} : { userId: attachment.principalId }),
      ...(attachment.displayName === undefined ? {} : { displayName: attachment.displayName }),
      isGuest: attachment.isGuest,
      connectedAt: attachment.connectedAt,
    })),
  };
}

/**
 * Deduplicated authenticated userIds with an open socket — the worker's
 * push-suppression read. Guests are omitted: they have no userId a push
 * lookup could key on.
 */
export function connectedUserIds(attachments: readonly SocketAttachment[]): string[] {
  const userIds = new Set<string>();
  for (const attachment of attachments) {
    if (!attachment.isGuest) {
      userIds.add(attachment.principalId);
    }
  }
  return [...userIds];
}
