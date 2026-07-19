import { encryptContentEnvelope, generateContentKey, wrapContentKeyToEpoch } from '@hushbox/crypto';
import type { ContentKey, EpochPublicKey, WrappedSecret } from '@hushbox/crypto';
import type { DbTransaction } from '../../../lib/idempotency/index.js';
import type { ChatContentItemInput, ChatStores } from '../ports/stores.js';

/**
 * The ONE message+content insert primitive. Both writers of `messages` /
 * `content_items` — the run settlement (user prompt + assistant siblings) and
 * the runless Pattern-A user-only send — compose this exact function, so the
 * envelope crypto (fresh wrap-once content key, per-item AAD binding the full
 * location tuple and the sender) can never fork into divergent copies.
 */

const textEncoder = new TextEncoder();

/**
 * Every media storage key must be EXACTLY
 * `media/{conversationId}/{messageId}/{contentItemId}` for this persist's
 * location — the same tuple the stored bytes' AAD binds — so a key pointing
 * anywhere else (other conversation, other message, foreign prefix) is a
 * defect. Checked before any row is written.
 */
function assertMediaStorageKeys(
  items: readonly PersistItem[],
  conversationId: string,
  messageId: string
): void {
  for (const item of items) {
    if (
      'contentType' in item &&
      item.storageKey !== `media/${conversationId}/${messageId}/${item.id}`
    ) {
      throw new Error(
        'chat message write: media storage key is not the expected key for this location tuple'
      );
    }
  }
}

export interface PersistTextItem {
  readonly text: string;
  readonly modelId: string | null;
  readonly providerName: string | null;
  readonly cost: bigint | null;
  /** True only for a Smart Model answer item (a classifier charge anchored to it). */
  readonly isSmartModel: boolean;
}

/**
 * A media item's bytes are already encrypted in R2 by the time persist runs:
 * its content-item `id` was pre-minted (the R2 key and AAD bind it) and the
 * message's content key was wrapped at run start — so the media path never
 * mints a key or encrypts, it writes the row straight from these fields.
 */
export interface PersistMediaItem {
  readonly contentType: 'image' | 'video';
  /** Pre-minted content-item id — the final segment of the exact expected `storageKey`. */
  readonly id: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly modelId: string | null;
  readonly providerName: string | null;
  readonly cost: bigint | null;
  readonly isSmartModel: boolean;
}

export type PersistItem = PersistTextItem | PersistMediaItem;

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
  /**
   * Pre-supplied wrapped content key (media persist: the key was wrapped at
   * run start, before the R2 writes). When set, no fresh content key is minted
   * — so the call cannot carry text items, which need one to encrypt under.
   */
  readonly wrappedContentKey?: WrappedSecret;
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
  assertMediaStorageKeys(params.items, ctx.conversationId, params.messageId);
  let contentKey: ContentKey | null = null;
  let wrappedContentKey = params.wrappedContentKey;
  if (wrappedContentKey === undefined) {
    contentKey = generateContentKey();
    wrappedContentKey = wrapContentKeyToEpoch(params.epochPublicKey, contentKey);
  }

  // All validation and crypto run BEFORE any row is written: a throw from this
  // loop leaves nothing behind even without the caller's rollback.
  const inputs: ChatContentItemInput[] = [];
  const contentItemIds: string[] = [];
  let position = 0;
  for (const item of params.items) {
    if ('contentType' in item) {
      inputs.push({
        id: item.id,
        messageId: params.messageId,
        position,
        contentType: item.contentType,
        storageKey: item.storageKey,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        width: item.width ?? null,
        height: item.height ?? null,
        durationMs: item.durationMs ?? null,
        modelId: item.modelId,
        providerName: item.providerName,
        costNanoUsd: item.cost,
        isSmartModel: item.isSmartModel,
      });
      contentItemIds.push(item.id);
      position += 1;
      continue;
    }
    if (contentKey === null) {
      throw new Error(
        'chat message write: a text item requires a minted content key — a pre-supplied wrapped key carries none to encrypt under'
      );
    }
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
    inputs.push({
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
  for (const input of inputs) {
    await ctx.stores.insertContentItemWithinTx(tx, input);
  }
  return contentItemIds;
}
