import { eq, sql } from 'drizzle-orm';
import { contentItems, messages } from '@hushbox/db';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ChatContentItemInput, ChatMessageInput, ChatStores } from '../ports/stores.js';

/**
 * The chat slice's single-writer adapter over `messages` and `content_items`.
 * Raw Drizzle lives only here; the settlement domain composes these writes
 * inside the one settlement transaction. Every write runs on the branded
 * `SettlementTx`, so a throw here aborts the whole commit.
 */
export function createChatStores(): ChatStores {
  return {
    async nextSequenceWithinTx(tx: SettlementTx, conversationId: string): Promise<number> {
      const rows = await tx
        .select({
          next: sql<number>`coalesce(max(${messages.sequenceNumber}), -1) + 1`,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversationId));
      /* v8 ignore next -- coalesce(max(),-1)+1 aggregate always returns exactly one non-null row */
      return rows[0]?.next ?? 0;
    },

    async insertMessageWithinTx(tx: SettlementTx, input: ChatMessageInput): Promise<void> {
      await tx.insert(messages).values({
        id: input.id,
        conversationId: input.conversationId,
        senderType: input.senderType,
        senderId: input.senderId,
        wrappedContentKey: input.wrappedContentKey,
        epochNumber: input.epochNumber,
        sequenceNumber: input.sequenceNumber,
      });
    },

    async insertContentItemWithinTx(tx: SettlementTx, input: ChatContentItemInput): Promise<void> {
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
  };
}
