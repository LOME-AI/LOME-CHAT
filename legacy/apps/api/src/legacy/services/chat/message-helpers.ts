import { eq, and, desc, sql, isNull } from 'drizzle-orm';
import {
  messages,
  contentItems,
  conversations,
  epochs,
  conversationForks,
  type Database,
  type DatabaseClient,
} from '@hushbox/db';
import { beginMessageEnvelope, encryptTextWithContentKey } from '@hushbox/crypto';
import { ERROR_CODE_FORK_TIP_CONFLICT, ERROR_CODE_INVALID_PARENT_MESSAGE } from '@hushbox/shared';
import { chargeForUsage, chargeForMediaGeneration } from '../billing/transaction-writer.js';
import { updateGroupSpending } from '../billing/budgets.js';

export class InvalidParentMessageError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'InvalidParentMessageError';
  }
}

/**
 * Validates that parentMessageId is correct before persisting a message.
 *
 * - null parentMessageId: only valid for the first message in a conversation
 * - non-null parentMessageId: must reference an existing message in the same conversation
 *
 * Runs inside a transaction to guarantee atomicity.
 */
export async function validateParentMessageId(
  tx: DatabaseClient,
  conversationId: string,
  parentMessageId: string | null
): Promise<void> {
  if (parentMessageId === null) {
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .limit(1);

    if (existing) {
      throw new InvalidParentMessageError(
        ERROR_CODE_INVALID_PARENT_MESSAGE,
        'parentMessageId is null but conversation already has messages'
      );
    }
    return;
  }

  const [parent] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, parentMessageId), eq(messages.conversationId, conversationId)));

  if (!parent) {
    throw new InvalidParentMessageError(
      ERROR_CODE_INVALID_PARENT_MESSAGE,
      `parentMessageId "${parentMessageId}" not found in conversation "${conversationId}"`
    );
  }
}

export interface AssignSequenceNumbersResult {
  sequences: number[];
  currentEpoch: number;
}

/**
 * Atomically increments `conversations.nextSequence` by `count` and returns
 * the assigned sequence numbers plus the current epoch.
 *
 * @param tx - Database transaction
 * @param conversationId - Conversation ID
 * @param count - Number of sequence numbers to assign (1 for user-only, 2 for chat turn)
 * @returns Array of assigned sequence numbers (lowest first) and current epoch
 * @throws Error('Conversation not found') if conversation does not exist
 */
export async function assignSequenceNumbers(
  tx: DatabaseClient,
  conversationId: string,
  count: number
): Promise<AssignSequenceNumbersResult> {
  const [updated] = await tx
    .update(conversations)
    .set({
      nextSequence: sql`${conversations.nextSequence} + ${count}`,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId))
    .returning({
      baseSeq: sql<number>`${conversations.nextSequence} - ${count}`,
      currentEpoch: conversations.currentEpoch,
    });

  if (!updated) {
    throw new Error('Conversation not found');
  }

  const sequences = Array.from({ length: count }, (_, index) => updated.baseSeq + index);

  return { sequences, currentEpoch: updated.currentEpoch };
}

export interface EpochKeyResult {
  epochPublicKey: Uint8Array;
  epochNumber: number;
}

/**
 * Fetches the epoch public key for a conversation's current epoch.
 *
 * @throws Error('Epoch not found') if epoch does not exist
 */
export async function fetchEpochPublicKey(
  tx: DatabaseClient,
  conversationId: string,
  currentEpoch: number
): Promise<EpochKeyResult> {
  const [epoch] = await tx
    .select({ epochPublicKey: epochs.epochPublicKey })
    .from(epochs)
    .where(
      sql`${epochs.conversationId} = ${conversationId} AND ${epochs.epochNumber} = ${currentEpoch}`
    );

  if (!epoch) {
    throw new Error('Epoch not found');
  }

  return { epochPublicKey: epoch.epochPublicKey, epochNumber: currentEpoch };
}

export interface InsertEnvelopeTextMessageParams {
  id: string;
  conversationId: string;
  textContent: string;
  epochPublicKey: Uint8Array;
  epochNumber: number;
  sequenceNumber: number;
  senderType: 'user' | 'ai';
  senderId?: string;
  modelName?: string;
  cost?: string;
  isSmartModel?: boolean;
  parentMessageId: string | null;
  /**
   * Per-turn identifier. `saveChatTurn` mints one UUID per turn and forwards
   * it to every message persisted in that turn so the fork-filter can tell
   * multi-model peers from fork-preserve orphans. Omitted → schema default
   * (`gen_random_uuid()`) writes a unique id, which yields the legacy
   * "treat each message as its own batch" semantics for callers that
   * haven't been updated yet (dev seeds, single-message inserts).
   */
  batchId?: string;
}

export interface InsertedTextContentItem {
  id: string;
  contentType: 'text';
  position: number;
  encryptedBlob: Uint8Array;
  modelName: string | null;
  cost: string | null;
  isSmartModel: boolean;
}

export interface InsertEnvelopeTextMessageResult {
  wrappedContentKey: Uint8Array;
  contentItem: InsertedTextContentItem;
}

/**
 * Persists a single-text-content message under the wrap-once envelope model.
 *
 * Generates a fresh content key, wraps it under the epoch public key, encrypts the
 * plaintext under the content key, and inserts one `messages` row plus one
 * `content_items` row with `content_type = 'text'`. The content key is discarded
 * from memory after the inserts.
 *
 * Returns the `wrappedContentKey` and the inserted content item so the caller can
 * forward them to the client via the SSE `done` event.
 */
export async function insertEnvelopeTextMessage(
  tx: DatabaseClient,
  params: InsertEnvelopeTextMessageParams
): Promise<InsertEnvelopeTextMessageResult> {
  const { contentKey, wrappedContentKey } = beginMessageEnvelope(params.epochPublicKey);
  const encryptedBlob = encryptTextWithContentKey(contentKey, params.textContent);

  await tx.insert(messages).values({
    id: params.id,
    conversationId: params.conversationId,
    wrappedContentKey,
    senderType: params.senderType,
    senderId: params.senderId,
    epochNumber: params.epochNumber,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
    ...(params.batchId !== undefined && { batchId: params.batchId }),
  });

  const contentItemId = crypto.randomUUID();
  const modelName = params.modelName ?? null;
  const cost = params.cost ?? null;
  const isSmartModel = params.isSmartModel ?? false;

  await tx.insert(contentItems).values({
    id: contentItemId,
    messageId: params.id,
    contentType: 'text',
    position: 0,
    encryptedBlob,
    modelName,
    cost,
    isSmartModel,
  });

  return {
    wrappedContentKey,
    contentItem: {
      id: contentItemId,
      contentType: 'text',
      position: 0,
      encryptedBlob,
      modelName,
      cost,
      isSmartModel,
    },
  };
}

export interface ChargeAndTrackUsageParams {
  userId: string;
  cost: string;
  model: string;
  assistantMessageId: string;
  conversationId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  groupBillingContext?: { memberId: string };
  /**
   * True when `cost` came from the gateway-lookup fallback estimate rather
   * than an exact gateway call. Propagated to `usage_records.is_estimated`.
   */
  isEstimated?: boolean;
}

export interface ChargeAndTrackUsageResult {
  usageRecordId: string;
}

/**
 * Updates per-member group spending when the charge belongs to a group
 * conversation. No-op for solo conversations (no group billing context).
 */
async function applyGroupSpending(
  tx: DatabaseClient,
  conversationId: string,
  groupBillingContext: { memberId: string } | undefined,
  cost: string
): Promise<void> {
  if (groupBillingContext === undefined) return;
  await updateGroupSpending(tx, {
    conversationId,
    memberId: groupBillingContext.memberId,
    costDollars: cost,
  });
}

/**
 * Charges the user's wallet for usage and optionally updates group spending tables.
 */
export async function chargeAndTrackUsage(
  tx: DatabaseClient,
  params: ChargeAndTrackUsageParams
): Promise<ChargeAndTrackUsageResult> {
  const chargeResult = await chargeForUsage(tx, {
    userId: params.userId,
    cost: params.cost,
    model: params.model,
    provider: 'ai-gateway',
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cachedTokens: params.cachedTokens,
    sourceType: 'message',
    sourceId: params.assistantMessageId,
    ...(params.isEstimated !== undefined && { isEstimated: params.isEstimated }),
  });

  await applyGroupSpending(tx, params.conversationId, params.groupBillingContext, params.cost);

  return { usageRecordId: chargeResult.usageRecordId };
}

export type MediaContentType = 'image' | 'audio' | 'video';

export interface MediaContentItemInput {
  id: string;
  contentType: MediaContentType;
  position: number;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  modelName: string;
  cost: string;
  isSmartModel: boolean;
}

export interface InsertedMediaContentItem {
  id: string;
  contentType: MediaContentType;
  position: number;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  modelName: string;
  cost: string;
  isSmartModel: boolean;
  /** Presigned download URL, populated by the pipeline after R2 upload. Not persisted in DB. */
  downloadUrl?: string;
}

export interface InsertEnvelopeMediaMessageParams {
  id: string;
  conversationId: string;
  /** Supply epochPublicKey to generate a fresh envelope, OR supply wrappedContentKey to use a pre-created one. */
  epochPublicKey?: Uint8Array;
  wrappedContentKey?: Uint8Array;
  epochNumber: number;
  sequenceNumber: number;
  senderType: 'ai';
  parentMessageId: string | null;
  mediaItems: MediaContentItemInput[];
  /** See {@link InsertEnvelopeTextMessageParams.batchId}. */
  batchId?: string;
}

export interface InsertEnvelopeMediaMessageResult {
  wrappedContentKey: Uint8Array;
  contentItems: InsertedMediaContentItem[];
}

function resolveWrappedContentKey(
  params: Pick<InsertEnvelopeMediaMessageParams, 'wrappedContentKey' | 'epochPublicKey'>
): Uint8Array {
  if (params.wrappedContentKey !== undefined) return params.wrappedContentKey;
  if (params.epochPublicKey !== undefined) {
    return beginMessageEnvelope(params.epochPublicKey).wrappedContentKey;
  }
  throw new Error('Either wrappedContentKey or epochPublicKey must be provided');
}

/**
 * Persists a media message under the wrap-once envelope model.
 *
 * If `wrappedContentKey` is provided, uses it directly (caller already
 * created the envelope for R2 encryption). Otherwise generates a fresh one
 * from `epochPublicKey`.
 */
export async function insertEnvelopeMediaMessage(
  tx: DatabaseClient,
  params: InsertEnvelopeMediaMessageParams
): Promise<InsertEnvelopeMediaMessageResult> {
  const wrappedContentKey = resolveWrappedContentKey(params);

  await tx.insert(messages).values({
    id: params.id,
    conversationId: params.conversationId,
    wrappedContentKey,
    senderType: params.senderType,
    epochNumber: params.epochNumber,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
    ...(params.batchId !== undefined && { batchId: params.batchId }),
  });

  const insertedItems: InsertedMediaContentItem[] = [];

  for (const item of params.mediaItems) {
    const resolved: InsertedMediaContentItem = {
      id: item.id,
      contentType: item.contentType,
      position: item.position,
      storageKey: item.storageKey,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      width: item.width ?? null,
      height: item.height ?? null,
      durationMs: item.durationMs ?? null,
      modelName: item.modelName,
      cost: item.cost,
      isSmartModel: item.isSmartModel,
    };

    await tx.insert(contentItems).values({
      ...resolved,
      messageId: params.id,
    });

    insertedItems.push(resolved);
  }

  return { wrappedContentKey, contentItems: insertedItems };
}

export interface ChargeAndTrackMediaUsageParams {
  userId: string;
  cost: string;
  model: string;
  assistantMessageId: string;
  conversationId: string;
  mediaType: MediaContentType;
  imageCount?: number;
  durationMs?: number;
  resolution?: string;
  groupBillingContext?: { memberId: string };
}

export interface ChargeAndTrackMediaUsageResult {
  usageRecordId: string;
}

/**
 * Charges the user's wallet for media generation usage and optionally updates group spending.
 */
export async function chargeAndTrackMediaUsage(
  tx: DatabaseClient,
  params: ChargeAndTrackMediaUsageParams
): Promise<ChargeAndTrackMediaUsageResult> {
  const chargeResult = await chargeForMediaGeneration(tx, {
    userId: params.userId,
    cost: params.cost,
    model: params.model,
    provider: 'ai-gateway',
    mediaType: params.mediaType,
    imageCount: params.imageCount,
    durationMs: params.durationMs,
    resolution: params.resolution,
    sourceType: 'message',
    sourceId: params.assistantMessageId,
  });

  await applyGroupSpending(tx, params.conversationId, params.groupBillingContext, params.cost);

  return { usageRecordId: chargeResult.usageRecordId };
}

/**
 * Resolves the parentMessageId for a new user message.
 *
 * - With forkId: returns the fork's tipMessageId
 * - Without forkId: returns the latest message in the conversation by sequence number
 * - Empty conversation: returns null (first message has no parent)
 */
export async function resolveParentMessageId(
  db: Database,
  conversationId: string,
  forkId?: string
): Promise<string | null> {
  if (forkId) {
    const [fork] = await db
      .select({ tipMessageId: conversationForks.tipMessageId })
      .from(conversationForks)
      .where(eq(conversationForks.id, forkId));
    return fork?.tipMessageId ?? null;
  }

  const [lastMsg] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.sequenceNumber))
    .limit(1);
  return lastMsg?.id ?? null;
}

export class ForkTipConflictError extends Error {
  constructor(
    public readonly code: string,
    public readonly forkId: string,
    public readonly expectedTipMessageId: string | null
  ) {
    super(
      `fork tip conflict: fork ${forkId} expected tip ${
        expectedTipMessageId ?? 'null'
      } but actual tip differs`
    );
    this.name = 'ForkTipConflictError';
  }
}

/**
 * Atomically advances a fork's tip message id.
 *
 * Uses a conditional UPDATE: the row is updated only when the current
 * `tip_message_id` matches `expectedTipMessageId`. A concurrent writer that
 * already advanced the tip will cause this call to affect zero rows, which we
 * treat as a conflict and surface to the route as
 * {@link ERROR_CODE_FORK_TIP_CONFLICT}. The caller decides whether to retry.
 *
 * If the fork doesn't exist at all, this remains a no-op (matches prior
 * behaviour: no fork = nothing to update; the caller already validated
 * existence upstream when needed).
 */
export async function updateForkTip(
  tx: DatabaseClient,
  forkId: string,
  newTipMessageId: string,
  expectedTipMessageId: string | null
): Promise<void> {
  // Fast-path: if the fork is gone, do nothing (preserves no-op semantics).
  const [existing] = await tx
    .select({ id: conversationForks.id, tipMessageId: conversationForks.tipMessageId })
    .from(conversationForks)
    .where(eq(conversationForks.id, forkId));
  if (!existing) return;

  const tipCondition =
    expectedTipMessageId === null
      ? isNull(conversationForks.tipMessageId)
      : eq(conversationForks.tipMessageId, expectedTipMessageId);

  const result = await tx
    .update(conversationForks)
    .set({ tipMessageId: newTipMessageId })
    .where(and(eq(conversationForks.id, forkId), tipCondition))
    .returning({ id: conversationForks.id });

  if (result.length === 0) {
    throw new ForkTipConflictError(ERROR_CODE_FORK_TIP_CONFLICT, forkId, expectedTipMessageId);
  }
}
