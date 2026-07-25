import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client';
import { chatKeys, useConversations } from '@/hooks/chat/chat';

/**
 * Tells the server how far the reader has got in the conversation they have
 * open. The durable cursor is what lets a conversation read here stop notifying
 * on the reader's other devices — nothing else advances it.
 *
 * The acknowledged sequence is the tip of the conversation list, the same list
 * the read-elsewhere dismissal reads back, so both halves of the feature agree
 * on what "fully read" means. Only a sequence the server has not already
 * recorded is written, and the effect turns on the two numbers rather than the
 * list object, so re-rendering the open conversation never re-sends: the write
 * is idempotent, but a per-render write would still be traffic for nothing.
 */
export function useAdvanceReadCursor(conversationId: string | null): void {
  const queryClient = useQueryClient();
  const { data: conversations } = useConversations();

  const { mutate } = useMutation({
    mutationFn: (variables: { conversationId: string; lastReadSeq: number }): Promise<unknown> =>
      fetchJson(
        client.conversations[':conversationId'].read.$patch({
          param: { conversationId: variables.conversationId },
          json: { lastReadSeq: variables.lastReadSeq },
        })
      ),
    onSuccess: async (): Promise<void> => {
      await queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });

  const open = conversations?.find((entry) => entry.id === conversationId);
  // `nextSequence` is the sequence the next message will take, so the newest
  // message sits one below it.
  const newestSeq = open === undefined ? null : open.nextSequence - 1;
  const recordedSeq = open?.lastReadSeq ?? null;

  useEffect(() => {
    if (conversationId === null || newestSeq === null || recordedSeq === null) return;
    if (newestSeq <= recordedSeq) return;
    // Best-effort by nature: a refused write leaves the cursor where it was and
    // the next message in the conversation asks again.
    mutate({ conversationId, lastReadSeq: newestSeq });
  }, [conversationId, newestSeq, recordedSeq, mutate]);
}
