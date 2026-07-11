import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { contentItems, messages } from '@hushbox/db';
import type { SettlementTx } from '../../../lib/idempotency/index.js';

/**
 * Chat's published surface for identity's account-deletion transaction
 * (single-writer: this slice owns `messages` and `content_items`). Both run
 * on the branded `SettlementTx` and THROW on failure, aborting the whole
 * deletion commit — a partial deletion can never persist.
 */

/**
 * The DISTINCT non-null storage keys of every content item in the given
 * conversations. The deletion transaction captures these from the user's
 * OWNED conversations BEFORE the `users` delete cascades the rows away — the
 * captured list becomes the reclaim job's payload, the only surviving map
 * from the account to its R2 ciphertext.
 */
export async function captureContentStorageKeysWithinTx(
  tx: SettlementTx,
  conversationIds: readonly string[]
): Promise<readonly string[]> {
  if (conversationIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ key: contentItems.storageKey })
    .from(contentItems)
    .innerJoin(messages, eq(contentItems.messageId, messages.id))
    .where(
      and(
        inArray(messages.conversationId, [...conversationIds]),
        isNotNull(contentItems.storageKey)
      )
    );
  return rows.flatMap((row) => (row.key === null ? [] : [row.key]));
}

/**
 * Nulls `messages.senderId` for the user's messages OUTSIDE the excluded
 * (owned) conversations. senderId deliberately has no FK — a sender may be a
 * link-guest with no users row — so the `users` delete would otherwise leave
 * dangling ids; owned conversations are excluded because their messages die
 * with the conversation cascade anyway. Backed by messages_sender_id_idx.
 */
export async function detachMessageSendersWithinTx(
  tx: SettlementTx,
  userId: string,
  excludedConversationIds: readonly string[]
): Promise<void> {
  const ownMessages = eq(messages.senderId, userId);
  await tx
    .update(messages)
    .set({ senderId: null })
    .where(
      excludedConversationIds.length === 0
        ? ownMessages
        : and(ownMessages, notInArray(messages.conversationId, [...excludedConversationIds]))
    );
}
