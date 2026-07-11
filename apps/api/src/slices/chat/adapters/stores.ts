import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { contentItems, messages } from '@hushbox/db';
import type { DbTransaction, SettlementTx } from '../../../lib/idempotency/index.js';
import type { ChatContentItemInput, ChatMessageInput, ChatStores } from '../ports/stores.js';

/**
 * The chat slice's single-writer adapter over `messages` and `content_items`.
 * Raw Drizzle lives only here; the domain composes these writes inside the
 * caller's transaction (the run settlement, or the runless Pattern-A user-only
 * send), so a throw here aborts the whole commit. The regenerate DELETE
 * methods stay on the branded `SettlementTx` — settlement-exclusive.
 */
export function createChatStores(): ChatStores {
  return {
    async latestMessageIdWithinTx(
      tx: DbTransaction,
      conversationId: string
    ): Promise<string | null> {
      const rows = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.sequenceNumber))
        .limit(1);
      return rows[0]?.id ?? null;
    },

    async insertMessageWithinTx(tx: DbTransaction, input: ChatMessageInput): Promise<void> {
      await tx.insert(messages).values({
        id: input.id,
        conversationId: input.conversationId,
        senderType: input.senderType,
        senderId: input.senderId,
        wrappedContentKey: input.wrappedContentKey,
        epochNumber: input.epochNumber,
        sequenceNumber: input.sequenceNumber,
        parentMessageId: input.parentMessageId,
        batchId: input.batchId,
      });
    },

    async insertContentItemWithinTx(tx: DbTransaction, input: ChatContentItemInput): Promise<void> {
      await tx.insert(contentItems).values({
        id: input.id,
        messageId: input.messageId,
        contentType: 'text',
        position: input.position,
        encryptedBlob: input.encryptedBlob,
        modelId: input.modelId,
        providerName: input.providerName,
        costNanoUsd: input.costNanoUsd,
      });
    },

    async messageRefWithinTx(
      tx: SettlementTx,
      conversationId: string,
      messageId: string
    ): Promise<{
      readonly sequenceNumber: number;
      readonly parentMessageId: string | null;
    } | null> {
      const rows = await tx
        .select({
          sequenceNumber: messages.sequenceNumber,
          parentMessageId: messages.parentMessageId,
        })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)));
      return rows[0] ?? null;
    },

    async deleteAfterSequenceWithinTx(
      tx: SettlementTx,
      conversationId: string,
      sequenceNumber: number
    ): Promise<void> {
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            gt(messages.sequenceNumber, sequenceNumber)
          )
        );
    },

    async deleteMessagesByIdWithinTx(
      tx: SettlementTx,
      conversationId: string,
      ids: readonly string[]
    ): Promise<void> {
      if (ids.length === 0) return;
      await tx
        .delete(messages)
        .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, [...ids])));
    },
  };
}
