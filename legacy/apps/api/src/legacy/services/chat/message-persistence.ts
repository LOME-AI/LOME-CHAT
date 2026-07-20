import { type Database, type DatabaseClient } from '@hushbox/db';
import {
  assignSequenceNumbers,
  fetchEpochPublicKey,
  insertEnvelopeTextMessage,
  insertEnvelopeMediaMessage,
  type InsertedTextContentItem,
  type InsertedMediaContentItem,
  type MediaContentItemInput,
  type MediaContentType,
  chargeAndTrackUsage,
  chargeAndTrackMediaUsage,
  updateForkTip,
  validateParentMessageId,
} from './message-helpers.js';
import { applyTreeAction, treeActionShouldAdvanceForkTip, type TreeAction } from './tree-action.js';
import type { StageId } from '@hushbox/shared';

/**
 * One pre-inference stage charge that the persistence layer must write
 * alongside the main inference's `usage_records` row. Same source_id, separate
 * row per stage. Used today for Smart Model's classifier call; the framework
 * supports any future stage that makes a billable LLM call.
 */
export interface PreInferenceBillingPersistence {
  stageId: StageId;
  modelId: string;
  /** Cost in dollars (with fees) — written verbatim to this stage's usage_records.cost. */
  costDollars: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when this stage's cost came from the gateway-lookup fallback
   * estimate rather than an exact gateway call. Persisted to
   * `usage_records.is_estimated` for this stage's row.
   */
  isEstimated: boolean;
}

export interface SaveUserOnlyMessageParams {
  conversationId: string;
  userId: string;
  senderId: string;
  messageId: string;
  content: string;
  parentMessageId: string | null;
  forkId?: string;
}

export interface PersistedTextEnvelope {
  messageId: string;
  wrappedContentKey: Uint8Array;
  contentItem: InsertedTextContentItem;
}

export interface PersistedMediaEnvelope {
  messageId: string;
  wrappedContentKey: Uint8Array;
  contentItems: InsertedMediaContentItem[];
}

export type PersistedEnvelope = PersistedTextEnvelope | PersistedMediaEnvelope;

export interface SaveUserOnlyMessageResult {
  sequenceNumber: number;
  epochNumber: number;
  envelope: PersistedEnvelope;
}

/**
 * Saves a single user message without triggering AI or billing.
 * Used in group chats when the AI toggle is off.
 * Free — no wallet charge, no usage records, no LLM completions.
 */
export async function saveUserOnlyMessage(
  db: Database,
  params: SaveUserOnlyMessageParams
): Promise<SaveUserOnlyMessageResult> {
  const { conversationId, senderId, messageId, content, parentMessageId, forkId } = params;

  return db.transaction(async (tx) => {
    await validateParentMessageId(tx, conversationId, parentMessageId);

    const { sequences, currentEpoch } = await assignSequenceNumbers(tx, conversationId, 1);
    const seq = sequences[0];
    if (seq === undefined) throw new Error('invariant: expected at least one sequence number');

    const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
      tx,
      conversationId,
      currentEpoch
    );

    const { wrappedContentKey, contentItem } = await insertEnvelopeTextMessage(tx, {
      id: messageId,
      conversationId,
      textContent: content,
      epochPublicKey,
      epochNumber,
      sequenceNumber: seq,
      senderType: 'user',
      senderId,
      parentMessageId,
    });

    if (forkId) {
      // parentMessageId IS the fork tip when forkId is set (resolved upstream
      // via resolveParentMessageId). Conditional update detects a concurrent
      // writer that beat us to advancing the tip.
      await updateForkTip(tx, forkId, messageId, parentMessageId);
    }

    return {
      sequenceNumber: seq,
      epochNumber,
      envelope: { messageId, wrappedContentKey, contentItem },
    };
  });
}

export interface TextAssistantMessageInput {
  modality: 'text';
  id: string;
  content: string;
  /**
   * Model id stored on `content_items.model_name`. For Smart Model slots, this
   * is the resolved (downstream) model id, NOT 'smart-model'.
   */
  model: string;
  /**
   * Cost in dollars of the MAIN inference call only (with fees + storage).
   * Becomes this slot's main `usage_records.cost`. The total cost displayed
   * in the UI (and stored on `content_items.cost`) is `cost + Σ
   * preInferenceBillings.costDollars`, derived inside the persistence layer.
   */
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  /**
   * True when this message's main cost came from the gateway-lookup fallback
   * estimate rather than an exact gateway call. Persisted to the main
   * `usage_records.is_estimated`. Per-stage flags live on `preInferenceBillings`.
   */
  isEstimated: boolean;
  /**
   * Marks the content item as produced via a routing stage (Smart Model).
   * Drives the "Smart" chip on the message nametag. Off by default.
   */
  isSmartModel?: boolean;
  /**
   * Pre-inference billing breadcrumbs — one extra `usage_records` row each.
   * Empty/undefined for slots that ran the main inference directly.
   */
  preInferenceBillings?: readonly PreInferenceBillingPersistence[];
}

export interface MediaAssistantMessageInput {
  modality: MediaContentType;
  id: string;
  /** Pre-created wrappedContentKey from the pipeline (used when bytes were encrypted externally before persistence). */
  wrappedContentKey?: Uint8Array;
  contentItems: MediaContentItemInput[];
  model: string;
  cost: number;
  mediaType: MediaContentType;
  imageCount?: number;
  durationMs?: number;
  resolution?: string;
}

export type AssistantMessageInput = TextAssistantMessageInput | MediaAssistantMessageInput;

interface SaveChatTurnCommonFields {
  conversationId: string;
  userId: string;
  senderId: string;
  /** When present, atomically increments group spending tables. Only set when a member uses the owner's balance. */
  groupBillingContext?: { memberId: string };
  forkId?: string;
}

interface SaveChatTurnLegacyUserFields {
  userMessageId: string;
  userContent: string;
  parentMessageId: string | null;
}

interface SaveChatTurnTreeActionFields {
  treeAction: TreeAction;
}

interface SaveChatTurnLegacyAssistantFields {
  assistantMessageId: string;
  assistantContent: string;
  model: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

interface SaveChatTurnMultiAssistantFields {
  assistantMessages: AssistantMessageInput[];
}

export type SaveChatTurnParams = SaveChatTurnCommonFields &
  (SaveChatTurnLegacyUserFields | SaveChatTurnTreeActionFields) &
  (SaveChatTurnLegacyAssistantFields | SaveChatTurnMultiAssistantFields);

export interface AssistantResult {
  /** The canonical assistant message id (also present on envelope.messageId). */
  assistantMessageId: string;
  /** The AI model id (e.g. `openai/gpt-4o`). Needed by SSE done-event construction. */
  model: string;
  aiSequence: number;
  cost: string;
  usageRecordId: string;
  envelope: PersistedEnvelope;
}

export interface SaveChatTurnResult {
  /** Undefined for `kind: 'regenerate'` (no new user row inserted). */
  userSequence: number | undefined;
  aiSequence: number;
  epochNumber: number;
  cost: string;
  usageRecordId: string;
  /** Undefined for `kind: 'regenerate'` (existing user msg preserved). */
  userEnvelope: PersistedEnvelope | undefined;
  assistantResults: AssistantResult[];
}

function normalizeAssistantMessages(params: SaveChatTurnParams): AssistantMessageInput[] {
  if ('assistantMessages' in params) {
    return params.assistantMessages;
  }
  return [
    {
      modality: 'text' as const,
      id: params.assistantMessageId,
      content: params.assistantContent,
      model: params.model,
      cost: params.totalCost,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      isEstimated: false,
      ...(params.cachedTokens !== undefined && { cachedTokens: params.cachedTokens }),
    },
  ];
}

function resolveTreeAction(params: SaveChatTurnParams): TreeAction {
  if ('treeAction' in params) {
    return params.treeAction;
  }
  return {
    kind: 'fresh-send',
    userMessage: { id: params.userMessageId, content: params.userContent },
    parentMessageId: params.parentMessageId,
  };
}

interface PersistAssistantContext {
  conversationId: string;
  epochPublicKey: Uint8Array;
  epochNumber: number;
  sequenceNumber: number;
  userMessageId: string;
  userId: string;
  groupBillingContext?: { memberId: string };
  /**
   * Per-turn id shared by every message this `saveChatTurn` call persists.
   * Forwarded to {@link insertEnvelopeTextMessage} / {@link insertEnvelopeMediaMessage}
   * so multi-model peers (same parent, same batch) can be distinguished from
   * fork-preserve orphans (same parent, different batch) in the fork-filter.
   */
  batchId: string;
}

async function persistTextAssistant(
  tx: DatabaseClient,
  msg: TextAssistantMessageInput,
  context: PersistAssistantContext
): Promise<AssistantResult> {
  const stageBillings = msg.preInferenceBillings ?? [];
  const stageCostDollars = stageBillings.reduce((sum, b) => sum + b.costDollars, 0);
  const totalCostDollars = msg.cost + stageCostDollars;
  const totalCostAmount = totalCostDollars.toFixed(8);
  const mainCostAmount = msg.cost.toFixed(8);

  const persisted = await insertEnvelopeTextMessage(tx, {
    id: msg.id,
    conversationId: context.conversationId,
    textContent: msg.content,
    epochPublicKey: context.epochPublicKey,
    epochNumber: context.epochNumber,
    sequenceNumber: context.sequenceNumber,
    senderType: 'ai',
    modelName: msg.model,
    cost: totalCostAmount,
    isSmartModel: msg.isSmartModel ?? false,
    parentMessageId: context.userMessageId,
    batchId: context.batchId,
  });

  const { usageRecordId } = await chargeAndTrackUsage(tx, {
    userId: context.userId,
    cost: mainCostAmount,
    model: msg.model,
    assistantMessageId: msg.id,
    conversationId: context.conversationId,
    inputTokens: msg.inputTokens,
    outputTokens: msg.outputTokens,
    isEstimated: msg.isEstimated,
    ...(msg.cachedTokens !== undefined && { cachedTokens: msg.cachedTokens }),
    ...(context.groupBillingContext !== undefined && {
      groupBillingContext: context.groupBillingContext,
    }),
  });

  // Each stage produces its own usage_records row, sharing the source_id.
  // The wallet sees the sum (main + stages) as the message's total charge.
  for (const billing of stageBillings) {
    await chargeAndTrackUsage(tx, {
      userId: context.userId,
      cost: billing.costDollars.toFixed(8),
      model: billing.modelId,
      assistantMessageId: msg.id,
      conversationId: context.conversationId,
      inputTokens: billing.inputTokens,
      outputTokens: billing.outputTokens,
      isEstimated: billing.isEstimated,
      ...(context.groupBillingContext !== undefined && {
        groupBillingContext: context.groupBillingContext,
      }),
    });
  }

  return {
    assistantMessageId: msg.id,
    model: msg.model,
    aiSequence: context.sequenceNumber,
    cost: totalCostAmount,
    usageRecordId,
    envelope: {
      messageId: msg.id,
      wrappedContentKey: persisted.wrappedContentKey,
      contentItem: persisted.contentItem,
    },
  };
}

async function persistMediaAssistant(
  tx: DatabaseClient,
  msg: MediaAssistantMessageInput,
  context: PersistAssistantContext
): Promise<AssistantResult> {
  const costAmount = msg.cost.toFixed(8);
  const persisted = await insertEnvelopeMediaMessage(tx, {
    id: msg.id,
    conversationId: context.conversationId,
    ...(msg.wrappedContentKey === undefined
      ? { epochPublicKey: context.epochPublicKey }
      : { wrappedContentKey: msg.wrappedContentKey }),
    epochNumber: context.epochNumber,
    sequenceNumber: context.sequenceNumber,
    senderType: 'ai',
    parentMessageId: context.userMessageId,
    mediaItems: msg.contentItems,
    batchId: context.batchId,
  });

  const { usageRecordId } = await chargeAndTrackMediaUsage(tx, {
    userId: context.userId,
    cost: costAmount,
    model: msg.model,
    assistantMessageId: msg.id,
    conversationId: context.conversationId,
    mediaType: msg.mediaType,
    ...(msg.imageCount !== undefined && { imageCount: msg.imageCount }),
    ...(msg.durationMs !== undefined && { durationMs: msg.durationMs }),
    ...(msg.resolution !== undefined && { resolution: msg.resolution }),
    ...(context.groupBillingContext !== undefined && {
      groupBillingContext: context.groupBillingContext,
    }),
  });

  return {
    assistantMessageId: msg.id,
    model: msg.model,
    aiSequence: context.sequenceNumber,
    cost: costAmount,
    usageRecordId,
    envelope: {
      messageId: msg.id,
      wrappedContentKey: persisted.wrappedContentKey,
      contentItems: persisted.contentItems,
    },
  };
}

function logNegativeCosts(
  msgs: AssistantMessageInput[],
  conversationId: string,
  userId: string
): void {
  for (const msg of msgs) {
    if (msg.cost < 0) {
      console.error(
        JSON.stringify({
          event: 'negative_cost_detected',
          totalCost: msg.cost,
          costAmount: msg.cost.toFixed(8),
          conversationId,
          model: msg.model,
          userId,
        })
      );
    }
  }
}

interface PersistAllAssistantsContext extends Omit<PersistAssistantContext, 'sequenceNumber'> {
  /** `0` when no user message was inserted (regenerate), else `1`. */
  sequenceOffset: number;
}

async function persistAllAssistants(
  tx: DatabaseClient,
  assistantMsgs: AssistantMessageInput[],
  sequences: number[],
  context: PersistAllAssistantsContext
): Promise<AssistantResult[]> {
  const { sequenceOffset, ...persistContextBase } = context;
  const results: AssistantResult[] = [];

  for (const [index, assistantMsg] of assistantMsgs.entries()) {
    const aiSeq = sequences[sequenceOffset + index];
    if (aiSeq === undefined) {
      throw new Error(
        `invariant: expected sequence number at index ${String(sequenceOffset + index)}`
      );
    }

    const persistContext = { ...persistContextBase, sequenceNumber: aiSeq };

    const result =
      assistantMsg.modality === 'text'
        ? await persistTextAssistant(tx, assistantMsg, persistContext)
        : await persistMediaAssistant(tx, assistantMsg, persistContext);

    results.push(result);
  }

  return results;
}

/**
 * Atomically applies a {@link TreeAction}, assigns sequence numbers, persists
 * each message under a wrap-once envelope, charges the user's wallet per
 * assistant, and (when `forkId` is set) advances the fork tip with optimistic-
 * concurrency guard. Single transaction: any step failing rolls everything
 * back.
 */
export async function saveChatTurn(
  db: Database,
  params: SaveChatTurnParams
): Promise<SaveChatTurnResult> {
  const { conversationId, userId, senderId, groupBillingContext, forkId } = params;
  const treeAction = resolveTreeAction(params);
  const assistantMsgs = normalizeAssistantMessages(params);
  logNegativeCosts(assistantMsgs, conversationId, userId);

  // One batch id per turn — every message persisted in this call (the new
  // user message if any, plus every assistant) shares it. The fork-filter
  // uses it to tell a multi-model fan-out from a retry-with-fork-preserved
  // orphan that left a same-parent assistant behind.
  const batchId = crypto.randomUUID();

  return db.transaction(async (tx) => {
    const treeResult = await applyTreeAction(tx, conversationId, treeAction);

    const userMsgCount = treeResult.userMessageInsert ? 1 : 0;
    const totalCount = userMsgCount + assistantMsgs.length;
    const { sequences, currentEpoch } = await assignSequenceNumbers(tx, conversationId, totalCount);

    const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
      tx,
      conversationId,
      currentEpoch
    );

    let userSequence: number | undefined;
    let userEnvelope: PersistedEnvelope | undefined;
    if (treeResult.userMessageInsert) {
      const userSeq = sequences[0];
      if (userSeq === undefined) {
        throw new Error('invariant: expected sequence number for user message');
      }
      const userPersisted = await insertEnvelopeTextMessage(tx, {
        id: treeResult.userMessageInsert.id,
        conversationId,
        textContent: treeResult.userMessageInsert.content,
        epochPublicKey,
        epochNumber,
        sequenceNumber: userSeq,
        senderType: 'user',
        senderId,
        parentMessageId: treeResult.userMessageInsert.parentMessageId,
        batchId,
      });
      userSequence = userSeq;
      userEnvelope = {
        messageId: treeResult.userMessageInsert.id,
        wrappedContentKey: userPersisted.wrappedContentKey,
        contentItem: userPersisted.contentItem,
      };
    }

    const assistantResults = await persistAllAssistants(tx, assistantMsgs, sequences, {
      conversationId,
      epochPublicKey,
      epochNumber,
      userMessageId: treeResult.parentMessageIdForAssistants,
      userId,
      sequenceOffset: userMsgCount,
      batchId,
      ...(groupBillingContext !== undefined && { groupBillingContext }),
    });

    if (forkId && treeActionShouldAdvanceForkTip(treeAction)) {
      const lastAssistant = assistantMsgs.at(-1);
      if (!lastAssistant) throw new Error('invariant: assistantMsgs must not be empty');
      // Conditional update: a concurrent writer that already advanced the tip
      // surfaces ERROR_CODE_FORK_TIP_CONFLICT.
      await updateForkTip(tx, forkId, lastAssistant.id, treeResult.forkTipExpectedMessageId);
    }

    const firstResult = assistantResults[0];
    if (!firstResult) throw new Error('invariant: assistantResults must not be empty');

    return {
      userSequence,
      aiSequence: firstResult.aiSequence,
      epochNumber,
      cost: firstResult.cost,
      usageRecordId: firstResult.usageRecordId,
      userEnvelope,
      assistantResults,
    };
  });
}
