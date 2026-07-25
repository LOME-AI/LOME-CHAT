import { useEffect } from 'react';
import { useNotificationActivityStore } from '@/stores/notification-activity';
import type { ConversationWebSocket } from '@/lib/ws-client';

/**
 * The in-app feed for the activity badge: messages arriving over the open
 * conversation's socket while the user is looking elsewhere. Sockets are
 * per-conversation, so this only ever sees the conversation on screen; activity
 * anywhere else reaches the user as an OS notification instead.
 */
export function useConversationActivity(
  ws: ConversationWebSocket | null,
  currentUserId: string | null
): void {
  useEffect(() => {
    if (ws === null) return;
    return ws.on('message:new', (event) => {
      useNotificationActivityStore.getState().recordActivity({
        selfAuthored: currentUserId !== null && event.senderId === currentUserId,
      });
    });
  }, [ws, currentUserId]);
}
