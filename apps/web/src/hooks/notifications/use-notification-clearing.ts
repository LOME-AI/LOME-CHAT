import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notificationChannel } from '@/lib/notification-channel';
import { chatKeys, useConversations } from '@/hooks/chat/chat';
import type { ConversationListItem } from '@/lib/api';

function clear(conversationIds: readonly string[]): void {
  void (async (): Promise<void> => {
    try {
      await notificationChannel.clearDelivered(conversationIds);
    } catch {
      // Best-effort by nature: a shade that refuses to be tidied changes nothing.
    }
  })();
}

/**
 * Everything in the conversation has been acknowledged. `nextSequence` is the
 * sequence the next message will take, so the newest existing message is one
 * below it; a conversation with no messages is trivially read.
 */
function isFullyRead(conversation: ConversationListItem): boolean {
  return conversation.lastReadSeq >= conversation.nextSequence - 1;
}

/**
 * Dismisses this conversation's notifications while the user is reading it —
 * the local half of dismiss-on-read. Notifications are addressed by
 * conversation id, which is the tag the display point set.
 */
export function useClearConversationNotifications(conversationId: string | null): void {
  useEffect(() => {
    if (conversationId === null) return;
    clear([conversationId]);
  }, [conversationId]);
}

/**
 * Dismisses notifications for conversations the user has since read somewhere
 * else. The durable read cursor rides the conversation list, so returning to
 * the foreground refetches it and anything fully read stops nagging here.
 * Cross-device dismissal is eventual by design — there is no push-to-dismiss.
 */
export function useClearReadElsewhere(): void {
  const queryClient = useQueryClient();
  const { data: conversations } = useConversations();

  useEffect(() => {
    const onForeground = (): void => {
      if (document.visibilityState !== 'visible') return;
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    };
    document.addEventListener('visibilitychange', onForeground);
    return (): void => {
      document.removeEventListener('visibilitychange', onForeground);
    };
  }, [queryClient]);

  useEffect(() => {
    if (conversations === undefined) return;
    const readIds = conversations
      .filter((conversation) => isFullyRead(conversation))
      .map((conversation) => conversation.id);
    if (readIds.length === 0) return;
    // One call for the whole set: each adapter reads the delivered list once.
    clear(readIds);
  }, [conversations]);
}
