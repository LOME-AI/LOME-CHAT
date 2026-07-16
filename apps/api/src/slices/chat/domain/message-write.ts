import { encryptContentEnvelope, generateContentKey, wrapContentKeyToEpoch } from '@hushbox/crypto';
import type { EpochPublicKey } from '@hushbox/crypto';
import type { DbTransaction } from '../../../lib/idempotency/index.js';
import type { ChatStores } from '../ports/stores.js';

/**
 * The ONE message+content insert primitive. Both writers of `messages` /
 * `content_items` — the run settlement (user prompt + assistant siblings) and
 * the runless Pattern-A user-only send — compose this exact function, so the
 * envelope crypto (fresh wrap-once content key, per-item AAD binding the full
 * location tuple and the sender) can never fork into divergent copies.
 */

const textEncoder = new TextEncoder();

export interface PersistItem {
  readonly text: string;
  readonly modelId: string | null;
  readonly providerName: string | null;
  readonly cost: bigint | null;
  /** True only for a Smart Model answer item (a classifier charge anchored to it). */
  readonly isSmartModel: boolean;
}

/** The write-target identity the caller's transaction is scoped to. */
export interface PersistMessageContext {
  readonly stores: ChatStores;
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly newId: () => string;
}

export interface PersistMessageParams {
  readonly messageId: string;
  readonly epochPublicKey: EpochPublicKey;
  readonly senderType: 'user' | 'assistant';
  readonly senderId: string;
  readonly sequenceNumber: number;
  readonly parentMessageId: string | null;
  readonly batchId: string;
  readonly items: readonly PersistItem[];
}

/**
 * Persist one message and its content items under a fresh, wrap-once content
 * key (each message is independently decryptable). The per-item AAD binds the
 * full location tuple and the message's sender, so ciphertext cannot be spliced
 * between messages. Returns the minted content-item ids in item order. Throws
 * on failure — the caller's transaction unwinds as a whole.
 */
export async function persistEncryptedMessage(
  tx: DbTransaction,
  ctx: PersistMessageContext,
  params: PersistMessageParams
): Promise<string[]> {
  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyToEpoch(params.epochPublicKey, contentKey);
  await ctx.stores.insertMessageWithinTx(tx, {
    id: params.messageId,
    conversationId: ctx.conversationId,
    senderType: params.senderType,
    senderId: params.senderId,
    wrappedContentKey,
    epochNumber: ctx.epochNumber,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
    batchId: params.batchId,
  });

  const contentItemIds: string[] = [];
  let position = 0;
  for (const item of params.items) {
    const contentItemId = ctx.newId();
    const encryptedBlob = encryptContentEnvelope(
      contentKey,
      wrappedContentKey,
      {
        conversationId: ctx.conversationId,
        messageId: params.messageId,
        contentItemId,
        position,
        epochNumber: ctx.epochNumber,
        senderId: params.senderId,
      },
      textEncoder.encode(item.text)
    );
    await ctx.stores.insertContentItemWithinTx(tx, {
      id: contentItemId,
      messageId: params.messageId,
      position,
      encryptedBlob,
      modelId: item.modelId,
      providerName: item.providerName,
      costNanoUsd: item.cost,
      isSmartModel: item.isSmartModel,
    });
    contentItemIds.push(contentItemId);
    position += 1;
  }
  return contentItemIds;
}
