/**
 * Shared streaming pipeline used by both authenticated chat and link-guest
 * endpoints. Owns billing resolution and reservation, the SSE multi-model
 * fan-out, and the utility functions for pricing, broadcasting, and cost
 * computation that those flows share.
 */

import { streamSSE } from 'hono/streaming';
import {
  calculateBudget,
  applyFees,
  buildEligibleModels,
  buildSystemPrompt,
  estimateTokenCount,
  buildCostManifest,
  calculateBudgetFromManifest,
  SMART_MODEL_ID,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  ERROR_CODE_PREMIUM_REQUIRES_BALANCE,
  ERROR_CODE_STREAM_ERROR,
  ERROR_CODE_BILLING_ERROR,
  ERROR_CODE_CLASSIFIER_FAILED,
  parseTokenPrice,
  computeImageExactCents,
  computeVideoExactCents,
  computeAudioWorstCaseCents,
  worstCaseSearchCost,
  toBase64,
} from '@hushbox/shared';
import {
  type RawModel,
  type ImageAspectRatio,
  type VideoAspectRatio,
  type VideoResolution,
} from '@hushbox/shared/models';
import { createEvent } from '@hushbox/realtime/events';
import { getProcessedCatalog } from './processed-catalog.js';
import { buildPrompt } from '../services/prompt/builder.js';
import {
  calculateMessageCost,
  calculateMessageCostWithStages,
  recordBillingMismatchIfExceeded,
} from '../services/billing/index.js';
import { buildAIMessages, saveChatTurn } from '../services/chat/index.js';
import { treeActionUserMessageId, type TreeAction } from '../services/chat/tree-action.js';
import { computeSafeMaxTokens } from '../services/chat/max-tokens.js';
import { createEvidenceConfig } from './evidence-config.js';
import { executePreInferenceChain, resolveStagesForSlot } from './pre-inference/index.js';
import { createErrorResponse } from './error-response.js';
import { classifyStreamErrorCode } from './classify-stream-error.js';
import { createSSEEventWriter, handleStreamException } from './stream-handler.js';
import { collectMultiModelStreams } from './multi-stream.js';
import { executeMediaPipeline as executeMediaPipelineImpl } from './media-pipeline.js';
import { getStrategy } from './modality-strategies.js';
import { broadcastFireAndForget } from './broadcast.js';
import {
  decideFundingSource,
  reserveGroupBudgetWithGuard,
  reservePersonalBudgetWithGuard,
  reserveMediaBilling,
} from './billing-reservation.js';
import { safeExecutionCtx } from './safe-execution-ctx.js';
import { getActiveConversationUserIds } from './broadcast.js';
import { dispatchPushNotification } from '../services/push/index.js';
import { buildGroupBillingContext } from './billing-types.js';
import type { Model, ModelPricingResult, UserTier } from '@hushbox/shared';
import type { Context } from 'hono';
import type { EvidenceConfig } from '@hushbox/db';
import type {
  PreInferenceBilling,
  FundingSource,
  DenialReason,
  ResolveBillingInput,
} from '@hushbox/shared';
import type {
  AIClient,
  InferenceEvent,
  InferenceStream,
  TextRequest,
  ImageRequest,
  VideoRequest,
  AudioRequest,
} from '../services/ai/index.js';
import type { BuildBillingResult, MemberContext } from '../services/billing/index.js';
import type { PreInferenceBillingPersistence } from '../services/chat/message-persistence.js';
import type {
  SaveChatTurnResult,
  PersistedEnvelope,
  AssistantResult,
} from '../services/chat/index.js';
import type {
  InsertedTextContentItem,
  InsertedMediaContentItem,
} from '../services/chat/message-helpers.js';
import type { DoneContentItem, DoneMessageEnvelope, DoneModelEntry } from './stream-handler.js';
import type { ModelStreamEntry, MediaStreamResult } from './multi-stream.js';
import type { MediaPipelineInput } from './media-pipeline.js';
import type { GroupBudgetReservation } from './speculative-balance.js';
import type { ReservationResult, ReserveAfterDecisionInput } from './billing-reservation.js';
import type {
  AudioBillingValidationSuccess,
  ImageBillingValidationSuccess,
  VideoBillingValidationSuccess,
} from './billing-types.js';
import type { AppEnv, Bindings } from '../types.js';
export { type MediaPersistPricing } from './media-pipeline.js';
export type {
  AudioBillingValidationSuccess,
  ImageBillingValidationSuccess,
  VideoBillingValidationSuccess,
} from './billing-types.js';

function createAssistantIdLookup(models: string[]): (modelId: string) => string {
  const idMap = new Map<string, string>();
  for (const m of models) {
    idMap.set(m, crypto.randomUUID());
  }
  return (modelId: string): string => {
    const id = idMap.get(modelId);
    if (!id) throw new Error(`invariant: no assistantMessageId for model ${modelId}`);
    return id;
  };
}

export interface MessageForInference {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface BillingValidationSuccess {
  success: true;
  billingInput: ResolveBillingInput;
  budgetResult: ReturnType<typeof calculateBudget>;
  safeMaxTokens: number | undefined;
  gatewayModels: RawModel[];
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
  /**
   * Stage configuration for any Smart Model slots in the request. Present
   * when SMART_MODEL_ID was in `models` and the user could afford at least
   * one eligible model + classifier overhead. Consumed by the pipeline to
   * build the per-slot Smart Model stage before inference.
   */
  smartModelResolution?: SmartModelResolution;
}

/**
 * Pre-computed Smart Model stage configuration produced during billing
 * resolution. The pipeline uses it to construct a {@link SmartModelStage}
 * per Smart Model slot — the conversation context is filled in there since
 * messagesForInference is the same across all parallel slots.
 */
export interface SmartModelResolution {
  /** Cheapest eligible text model — used to make the classifier call. */
  classifierModelId: string;
  /** Eligible inference model ids the classifier may pick from. */
  eligibleInferenceIds: readonly string[];
  /** Worst-case cents (with fees) reserved for the classifier call itself. */
  classifierWorstCaseCents: number;
  /** Lookup for resolved model name + description (descriptions for prompt, name for SSE). */
  modelMetadataById: ReadonlyMap<string, { name: string; description: string }>;
}

export interface BillingValidationFailure {
  success: false;
  response: Response;
}

export interface BroadcastContext {
  env: Bindings;
  conversationId: string;
  assistantMessageId: string;
  modelName?: string;
  senderId?: string;
}

export interface StreamResult {
  fullContent: string;
  /** Generation ID from the gateway's finish event — used post-hoc to fetch exact cost. */
  generationId: string | undefined;
  error: Error | null;
}

type SSEEventWriter = ReturnType<typeof createSSEEventWriter>;

export const BATCH_INTERVAL_MS = 100;

export function lookupModelPricing(models: RawModel[], modelId: string): ModelPricingResult {
  const modelInfo = models.find((m) => m.id === modelId);
  const rawInput = modelInfo ? parseTokenPrice(modelInfo.pricing.prompt) : 0;
  const rawOutput = modelInfo ? parseTokenPrice(modelInfo.pricing.completion) : 0;
  return {
    inputPricePerToken: applyFees(rawInput),
    outputPricePerToken: applyFees(rawOutput),
    contextLength: modelInfo?.context_length ?? 128_000,
  };
}

/**
 * Worst-case cost for a message reservation in cents.
 * No Math.ceil — floor() in calculateBudget already guarantees worstCaseCents ≤ availableCents.
 * Redis INCRBYFLOAT handles floats natively.
 */
export function computeWorstCaseCents(
  estimatedInputCost: number,
  effectiveMaxOutputTokens: number,
  outputCostPerToken: number
): number {
  return (estimatedInputCost + effectiveMaxOutputTokens * outputCostPerToken) * 100;
}

function handleBillingDenial(
  c: Context<AppEnv>,
  reason: DenialReason,
  billingInput: ResolveBillingInput
): Response {
  switch (reason) {
    case 'premium_requires_balance': {
      return c.json(
        createErrorResponse(ERROR_CODE_PREMIUM_REQUIRES_BALANCE, {
          currentBalance: (billingInput.balanceCents / 100).toFixed(2),
        }),
        402
      );
    }
    case 'insufficient_balance': {
      return c.json(
        createErrorResponse(ERROR_CODE_INSUFFICIENT_BALANCE, {
          currentBalance: (billingInput.balanceCents / 100).toFixed(2),
        }),
        402
      );
    }
    case 'insufficient_free_allowance': {
      return c.json(
        createErrorResponse(ERROR_CODE_INSUFFICIENT_BALANCE, {
          currentBalance: (billingInput.freeAllowanceCents / 100).toFixed(2),
        }),
        402
      );
    }
    case 'trial_limit_exceeded':
    case 'guest_budget_exhausted': {
      return c.json(createErrorResponse(ERROR_CODE_INSUFFICIENT_BALANCE), 402);
    }
  }
}

/**
 * Pre-flight worst-case search cost in USD when web search is enabled.
 *
 * Returns `worstCaseSearchCost()` (MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL,
 * fee-inflated) so a single text request reserves enough budget to cover the
 * cap on Perplexity Search tool invocations. Post-flight billing pulls the
 * gateway's `totalCost`, which already includes search.
 *
 * The cap is per-request (one Perplexity tool call set shared across all N
 * selected models), so this returns the bare value — `buildCostManifest`
 * multiplies by `modelCount` internally. Doubling the multiplication here
 * inflates reservations to N², which is the bug regression-tested in
 * `chat.test.ts:reserves web-search cost as N × base, not N² × base`.
 */
export function resolveWebSearchCost(webSearchEnabled: boolean): number {
  if (!webSearchEnabled) return 0;
  return worstCaseSearchCost();
}

/**
 * Wraps an InferenceStream to broadcast text tokens to group chat members via WebSocket.
 * Passes events through unchanged — broadcast is a fire-and-forget side effect.
 * Only text-delta events contribute to the broadcast buffer; other events pass through silently.
 */
export function withBroadcast(
  stream: InferenceStream,
  broadcast: BroadcastContext
): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      const iterator = stream[Symbol.asyncIterator]();
      let tokenBuffer = '';
      let lastBroadcastTime = Date.now();
      let isDone = false;

      function flushTokenBuffer(): void {
        if (tokenBuffer.length > 0) {
          broadcastFireAndForget(
            broadcast.env,
            broadcast.conversationId,
            createEvent('message:stream', {
              messageId: broadcast.assistantMessageId,
              token: tokenBuffer,
              ...(broadcast.modelName !== undefined && { modelName: broadcast.modelName }),
              ...(broadcast.senderId !== undefined && { senderId: broadcast.senderId }),
            })
          );
          tokenBuffer = '';
        }
      }

      return {
        async next(): Promise<IteratorResult<InferenceEvent>> {
          const result = await iterator.next();
          if (result.done) {
            if (!isDone) flushTokenBuffer();
            isDone = true;
            return { done: true, value: undefined };
          }

          if (result.value.kind === 'text-delta') {
            tokenBuffer += result.value.content;
            if (Date.now() - lastBroadcastTime >= BATCH_INTERVAL_MS) {
              flushTokenBuffer();
              lastBroadcastTime = Date.now();
            }
          }

          return { done: false, value: result.value };
        },
      };
    },
  };
}

interface HandleBillingOptions {
  c: Context<AppEnv>;
  billingPromise: Promise<SaveChatTurnResult>;
  assistantMessageId: string;
  userId: string;
  senderId: string;
  model: string;
  generationId: string | undefined;
}

export async function handleBillingResult(
  options: HandleBillingOptions
): Promise<SaveChatTurnResult | null> {
  const { c, billingPromise, assistantMessageId, userId, senderId, model, generationId } = options;

  try {
    // eslint-disable-next-line promise/prefer-await-to-then -- waitUntil requires a non-awaited promise; catch prevents unhandled rejection
    c.executionCtx.waitUntil(billingPromise.catch(() => null));
  } catch {
    // executionCtx unavailable outside Cloudflare Workers runtime
  }

  try {
    return await billingPromise;
  } catch (billingError) {
    console.error(
      JSON.stringify({
        event: 'billing_failed',
        messageId: assistantMessageId,
        userId,
        senderId,
        model,
        generationId,
        error: billingError instanceof Error ? billingError.message : String(billingError),
        timestamp: new Date().toISOString(),
      })
    );
    return null;
  }
}

interface BroadcastAndFinishOptions {
  c: Context<AppEnv>;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  billingResult: SaveChatTurnResult;
  writer: SSEEventWriter;
  modelName?: string;
}

function serializeTextContentItem(item: InsertedTextContentItem): DoneContentItem {
  return {
    id: item.id,
    contentType: item.contentType,
    position: item.position,
    encryptedBlob: toBase64(item.encryptedBlob),
    modelName: item.modelName,
    cost: item.cost,
    isSmartModel: item.isSmartModel,
  };
}

function serializeMediaContentItem(item: InsertedMediaContentItem): DoneContentItem {
  return {
    id: item.id,
    contentType: item.contentType,
    position: item.position,
    ...(item.downloadUrl === undefined ? {} : { downloadUrl: item.downloadUrl }),
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
    modelName: item.modelName,
    cost: item.cost,
    isSmartModel: item.isSmartModel,
  };
}

function serializeEnvelope(envelope: PersistedEnvelope): DoneMessageEnvelope {
  if ('contentItem' in envelope) {
    return {
      wrappedContentKey: toBase64(envelope.wrappedContentKey),
      contentItems: [serializeTextContentItem(envelope.contentItem)],
    };
  }
  return {
    wrappedContentKey: toBase64(envelope.wrappedContentKey),
    contentItems: envelope.contentItems.map((item) => serializeMediaContentItem(item)),
  };
}

function serializeAssistantResult(result: AssistantResult): DoneModelEntry {
  return {
    modelId: result.model,
    assistantMessageId: result.assistantMessageId,
    aiSequence: result.aiSequence,
    cost: result.cost,
    ...serializeEnvelope(result.envelope),
  };
}

export async function broadcastAndFinish(options: BroadcastAndFinishOptions): Promise<void> {
  const { c, conversationId, userMessageId, assistantMessageId, billingResult, writer, modelName } =
    options;

  broadcastFireAndForget(
    c.env,
    conversationId,
    createEvent('message:complete', {
      messageId: assistantMessageId,
      conversationId,
      sequenceNumber: billingResult.aiSequence,
      epochNumber: billingResult.epochNumber,
      ...(modelName !== undefined && { modelName }),
    }),
    safeExecutionCtx(c)
  );

  await writer.writeDone({
    userMessageId,
    assistantMessageId,
    ...(billingResult.userSequence !== undefined && { userSequence: billingResult.userSequence }),
    aiSequence: billingResult.aiSequence,
    epochNumber: billingResult.epochNumber,
    cost: billingResult.cost,
    ...(billingResult.userEnvelope !== undefined && {
      userEnvelope: serializeEnvelope(billingResult.userEnvelope),
    }),
    models: billingResult.assistantResults.map((r) => serializeAssistantResult(r)),
  });
}

/**
 * Post-persistence finalize for a streaming turn. Shared by text
 * (`stream-pipeline.ts`) and media (`media-pipeline.ts`):
 *   1. Optional `mutateBillingResult` hook (media uses it to attach presigned
 *      download URLs before serialization).
 *   2. Primary `broadcastAndFinish` — broadcasts `message:complete` AND
 *      writes the consolidated SSE `done` event.
 *   3. Per-non-primary `message:complete` broadcasts so other group members'
 *      WebSocket subscribers see every slot's result, not just the primary's.
 *   4. Fire-and-forget push notification.
 *
 * `resolveBroadcastModelName(modelId)` lets text return the Smart Model
 * classifier-resolved id; media passes the raw modelId.
 */
export interface FinalizeTurnOptions {
  c: Context<AppEnv>;
  conversationId: string;
  userMessageId: string;
  successfulModelIds: readonly string[];
  primaryModelId: string;
  getAssistantId: (modelId: string) => string;
  billingResult: SaveChatTurnResult;
  writer: SSEEventWriter;
  resolveBroadcastModelName: (modelId: string) => string;
  senderId: string;
  db: AppEnv['Variables']['db'];
  mutateBillingResult?: (result: SaveChatTurnResult) => void;
}

export async function finalizeTurn(options: FinalizeTurnOptions): Promise<void> {
  const {
    c,
    conversationId,
    userMessageId,
    successfulModelIds,
    primaryModelId,
    getAssistantId,
    billingResult,
    writer,
    resolveBroadcastModelName,
    senderId,
    db,
    mutateBillingResult,
  } = options;

  if (mutateBillingResult) mutateBillingResult(billingResult);

  await broadcastAndFinish({
    c,
    conversationId,
    userMessageId,
    assistantMessageId: getAssistantId(primaryModelId),
    billingResult,
    writer,
    modelName: resolveBroadcastModelName(primaryModelId),
  });

  for (const modelId of successfulModelIds) {
    if (modelId === primaryModelId) continue;
    broadcastFireAndForget(
      c.env,
      conversationId,
      createEvent('message:complete', {
        messageId: getAssistantId(modelId),
        conversationId,
        sequenceNumber: billingResult.aiSequence,
        epochNumber: billingResult.epochNumber,
        modelName: resolveBroadcastModelName(modelId),
      }),
      safeExecutionCtx(c)
    );
  }

  const executionCtx = safeExecutionCtx(c);
  const activeUserIds = await getActiveConversationUserIds(c.env, conversationId);
  dispatchPushNotification({
    env: c.env,
    db,
    conversationId,
    senderUserId: senderId,
    title: 'New Message',
    body: 'You have a new message',
    activeUserIds,
    ...(executionCtx !== undefined && { executionCtx }),
  });
}

export interface ResolveAndReserveBillingInput {
  billingResult: BuildBillingResult;
  userId: string;
  models: string[];
  messagesForInference: MessageForInference[];
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
  webSearchEnabled: boolean;
  customInstructions?: string;
}

/**
 * For group billing, the payer's effective balance is capped by both the
 * conversation budget remainder and the member budget remainder. For personal
 * billing, it's just the owner's wallet balance.
 */
function computeEffectivePayerBalance(
  billingResult: BuildBillingResult,
  isGroupBilling: boolean
): number {
  const group = billingResult.input.group;
  const rawPayerBalanceCents =
    isGroupBilling && group ? group.ownerBalanceCents : billingResult.input.balanceCents;
  if (!isGroupBilling || !billingResult.groupBudgetContext) return rawPayerBalanceCents;
  const ctx = billingResult.groupBudgetContext;
  const conversationRemainingCents =
    Number.parseFloat(ctx.conversationBudget) * 100 -
    Number.parseFloat(ctx.conversationSpent) * 100;
  const memberRemainingCents =
    Number.parseFloat(ctx.memberBudget) * 100 - Number.parseFloat(ctx.memberSpent) * 100;
  return Math.min(rawPayerBalanceCents, conversationRemainingCents, memberRemainingCents);
}

type ModelPricing = ReturnType<typeof lookupModelPricing>;

interface ResolveSmartModelPricingInput {
  c: Context<AppEnv>;
  models: string[];
  gatewayModels: RawModel[];
  allPricing: ModelPricing[];
  payerTier: BuildBillingResult['input']['tier'];
  payerBalanceCents: number;
  payerFreeAllowanceCents: number;
  promptCharacterCount: number;
}

type SmartModelPricingOutcome = { errorResponse: Response } | { resolution: SmartModelResolution };

export interface BuildSmartModelResolutionInput {
  /** Processed catalog models (includes the virtual Smart Model entry). */
  poolModels: Model[];
  /** Premium model ids the payer's tier may not access. */
  premiumIds: ReadonlySet<string>;
  /** Raw gateway catalog, for the classifier-prompt name/description lookup. */
  gatewayModels: RawModel[];
  payerTier: UserTier;
  payerBalanceCents: number;
  payerFreeAllowanceCents: number;
  promptCharacterCount: number;
}

/**
 * Pure Smart Model resolution: the eligible inference set, the classifier
 * model, the worst-case classifier cost, and the metadata lookup the stage
 * needs. Returns `null` when the payer can't afford even the cheapest eligible
 * model plus classifier overhead.
 *
 * Single source of truth for "what can this payer route Smart Model to?",
 * shared verbatim by authenticated billing resolution and the trial chat route
 * so neither path can diverge. The trial tier is a first-class payer here —
 * `getEffectiveBalance` maps it to the fixed per-message ceiling — so no
 * trial-specific branch is needed.
 */
export function buildSmartModelResolution(
  input: BuildSmartModelResolutionInput
): SmartModelResolution | null {
  const eligibility = buildEligibleModels({
    textModels: input.poolModels.filter((m) => m.modality === 'text' && !m.isSmartModel),
    premiumIds: input.premiumIds,
    payerTier: input.payerTier,
    payerBalanceCents: input.payerBalanceCents,
    payerFreeAllowanceCents: input.payerFreeAllowanceCents,
    promptCharacterCount: input.promptCharacterCount,
  });
  if (eligibility === null) return null;

  return {
    classifierModelId: eligibility.classifierModelId,
    eligibleInferenceIds: eligibility.eligibleInferenceIds,
    classifierWorstCaseCents: eligibility.classifierWorstCaseCents,
    modelMetadataById: buildSmartModelMetadata(
      input.gatewayModels,
      eligibility.eligibleInferenceIds
    ),
  };
}

/**
 * Mutates `allPricing` in place: every Smart Model slot has its per-token
 * fees overridden to the max of the eligible pool. Returns the resolution
 * metadata used by SmartModelStage, an error response when the payer can't
 * afford any eligible model, or `null` when no Smart Model slot is requested.
 */
async function resolveSmartModelPricing(
  input: ResolveSmartModelPricingInput
): Promise<SmartModelPricingOutcome | null> {
  const { c, models, gatewayModels, allPricing } = input;
  if (!models.includes(SMART_MODEL_ID)) return null;

  const { models: poolModels, premiumIds } = await getProcessedCatalog(c);
  const resolution = buildSmartModelResolution({
    poolModels,
    premiumIds: new Set(premiumIds),
    gatewayModels,
    payerTier: input.payerTier,
    payerBalanceCents: input.payerBalanceCents,
    payerFreeAllowanceCents: input.payerFreeAllowanceCents,
    promptCharacterCount: input.promptCharacterCount,
  });

  if (resolution === null) {
    return {
      errorResponse: c.json(
        createErrorResponse(ERROR_CODE_INSUFFICIENT_BALANCE, {
          currentBalance: (input.payerBalanceCents / 100).toFixed(2),
        }),
        402
      ),
    };
  }

  applySmartModelPricingOverride(poolModels, resolution.eligibleInferenceIds, models, allPricing);
  return { resolution };
}

/**
 * Pricing override: every Smart Model slot reserves at the most expensive
 * eligible model so the budget can absorb whichever model the classifier
 * picks. Mutates `allPricing` in place for slots whose model id is the
 * Smart Model sentinel.
 */
export function computeMaxEligibleFees(
  poolModels: Model[],
  eligibleInferenceIds: readonly string[]
): { maxInputFee: number; maxOutputFee: number } {
  const eligibleSet = new Set(eligibleInferenceIds);
  let maxInputFee = 0;
  let maxOutputFee = 0;
  for (const pm of poolModels) {
    if (!eligibleSet.has(pm.id)) continue;
    if (pm.pricePerInputToken > maxInputFee) maxInputFee = pm.pricePerInputToken;
    if (pm.pricePerOutputToken > maxOutputFee) maxOutputFee = pm.pricePerOutputToken;
  }
  return { maxInputFee, maxOutputFee };
}

function applySmartModelPricingOverride(
  poolModels: Model[],
  eligibleInferenceIds: readonly string[],
  models: string[],
  allPricing: ModelPricing[]
): void {
  const { maxInputFee, maxOutputFee } = computeMaxEligibleFees(poolModels, eligibleInferenceIds);
  for (const [index, modelId] of models.entries()) {
    if (modelId !== SMART_MODEL_ID) continue;
    const existing = allPricing[index];
    if (!existing) throw new Error(`invariant: allPricing missing entry ${String(index)}`);
    allPricing[index] = {
      inputPricePerToken: maxInputFee,
      outputPricePerToken: maxOutputFee,
      contextLength: existing.contextLength,
    };
  }
}

/**
 * Build metadata lookup for the eligible models — used by SmartModelStage
 * when constructing the classifier prompt and reporting the resolved name.
 */
function buildSmartModelMetadata(
  gatewayModels: RawModel[],
  eligibleInferenceIds: readonly string[]
): Map<string, { name: string; description: string }> {
  const metadata = new Map<string, { name: string; description: string }>();
  for (const id of eligibleInferenceIds) {
    const raw = gatewayModels.find((m) => m.id === id);
    if (!raw) continue;
    metadata.set(id, { name: raw.name, description: raw.description });
  }
  return metadata;
}

interface ComputeBudgetAndWorstCaseInput {
  payerTier: BuildBillingResult['input']['tier'];
  payerBalanceCents: number;
  payerFreeAllowanceCents: number;
  promptCharacterCount: number;
  allPricing: ModelPricing[];
  webSearchCostDollars: number;
  stageReservationCents: number;
}

interface ComputeBudgetAndWorstCaseOutput {
  budgetResult: ReturnType<typeof calculateBudget>;
  safeMaxTokens: number | undefined;
  worstCaseCents: number;
}

/**
 * Wraps the budget calculation + max-tokens cap + worst-case reservation
 * math. The stage reservation (Smart Model classifier today) is pre-deducted
 * inside `calculateBudget` so the inference token sizing already accounts
 * for it, then added back to the final reservation so the sum reflects the
 * full call.
 */
function computeBudgetAndWorstCase(
  input: ComputeBudgetAndWorstCaseInput
): ComputeBudgetAndWorstCaseOutput {
  const budgetResult = calculateBudget({
    tier: input.payerTier,
    balanceCents: input.payerBalanceCents,
    freeAllowanceCents: input.payerFreeAllowanceCents,
    promptCharacterCount: input.promptCharacterCount,
    models: input.allPricing.map((p) => ({
      modelInputPricePerToken: p.inputPricePerToken,
      modelOutputPricePerToken: p.outputPricePerToken,
      contextLength: p.contextLength,
    })),
    webSearchCost: input.webSearchCostDollars,
    preReservedCents: input.stageReservationCents,
  });

  const minContextLength = Math.min(...input.allPricing.map((p) => p.contextLength));
  const safeMaxTokens = computeSafeMaxTokens({
    budgetMaxTokens: budgetResult.maxOutputTokens,
    modelContextLength: minContextLength,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
  });

  const effectiveMaxOutputTokens =
    safeMaxTokens ?? minContextLength - budgetResult.estimatedInputTokens;
  const inferenceWorstCaseCents = computeWorstCaseCents(
    budgetResult.estimatedInputCost,
    effectiveMaxOutputTokens,
    budgetResult.outputCostPerToken
  );

  return {
    budgetResult,
    safeMaxTokens,
    worstCaseCents: inferenceWorstCaseCents + input.stageReservationCents,
  };
}

interface ExecuteReservationInput {
  c: Context<AppEnv>;
  redis: AppEnv['Variables']['redis'];
  billingResult: BuildBillingResult;
  worstCaseCents: number;
  payerTier: BuildBillingResult['input']['tier'];
  isGroupBilling: boolean;
  memberContext: MemberContext | undefined;
  conversationId: string | undefined;
  userId: string;
  resolvedFundingSource: FundingSource;
}

/**
 * Reserve budget — same group/personal race-guard flow as media; the only
 * difference is the additional text-specific fields (budget, gatewayModels,
 * smartModelResolution) that the caller layers onto the success result.
 */
async function executeReservation(input: ExecuteReservationInput): Promise<ReservationResult> {
  const reservationCtx = {
    redis: input.redis,
    c: input.c,
    billingResult: input.billingResult,
    worstCaseCents: input.worstCaseCents,
    payerTier: input.payerTier,
  };
  if (input.isGroupBilling && input.memberContext && input.conversationId) {
    return reserveGroupBudgetWithGuard(reservationCtx, input.memberContext, input.conversationId);
  }
  return reservePersonalBudgetWithGuard(reservationCtx, input.userId, input.resolvedFundingSource);
}

/**
 * Resolve billing decision, compute budget, and reserve balance.
 *
 * Takes a pre-built `BuildBillingResult` (from either `buildBillingInput` or
 * `buildGuestBillingInput`) and does everything that `validateBilling` did
 * after the billing input was gathered.
 */
export async function resolveAndReserveBilling(
  c: Context<AppEnv>,
  input: ResolveAndReserveBillingInput
): Promise<BillingValidationSuccess | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    models,
    messagesForInference,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;
  const redis = c.get('redis');

  const gatewayModels = await c.var.aiClient.listRawModels();
  const allPricing = models.map((m) => lookupModelPricing(gatewayModels, m));

  // Per-request cost — `buildCostManifest` multiplies by `modelCount` internally.
  // Multiplying again here would inflate the reservation to N² × base.
  const webSearchCostDollars = resolveWebSearchCost(input.webSearchEnabled);

  const systemPromptForBudget = buildSystemPrompt([], input.customInstructions);
  const historyCharacters = messagesForInference.reduce((sum, m) => sum + m.content.length, 0);
  const promptCharacterCount = systemPromptForBudget.length + historyCharacters;

  const minCostManifest = buildCostManifest({
    tier: billingResult.input.tier,
    promptCharacterCount,
    models: allPricing.map((p) => ({
      modelInputPricePerToken: p.inputPricePerToken,
      modelOutputPricePerToken: p.outputPricePerToken,
    })),
    webSearchCost: webSearchCostDollars,
  });
  const estimatedMinimumCostCents =
    calculateBudgetFromManifest(minCostManifest, 0).estimatedMinimumCost * 100;

  const decision = decideFundingSource({
    c,
    billingResult,
    worstCaseCents: estimatedMinimumCostCents,
    clientFundingSource,
    handleBillingDenial,
  });
  if (!decision.success) return decision;
  const { fundingSource: resolvedFundingSource, isGroupBilling, payerTier } = decision;

  const payerBalanceCents = computeEffectivePayerBalance(billingResult, isGroupBilling);
  const payerFreeAllowanceCents = isGroupBilling ? 0 : billingResult.input.freeAllowanceCents;

  // 7. Smart Model: resolve eligible models and override per-slot pricing
  //    to max-of-eligible. Runs after payer resolution so affordability uses
  //    the actual payer's balance. The classifier worst-case is added to the
  //    final reservation below; per-stage logic lives in `SmartModelStage`.
  const smartModelOutcome = await resolveSmartModelPricing({
    c,
    models,
    gatewayModels,
    allPricing,
    payerTier,
    payerBalanceCents,
    payerFreeAllowanceCents,
    promptCharacterCount,
  });
  if (smartModelOutcome !== null && 'errorResponse' in smartModelOutcome) {
    return { success: false, response: smartModelOutcome.errorResponse };
  }
  const smartModelResolution = smartModelOutcome?.resolution;

  const budget = computeBudgetAndWorstCase({
    payerTier,
    payerBalanceCents,
    payerFreeAllowanceCents,
    promptCharacterCount,
    allPricing,
    webSearchCostDollars,
    stageReservationCents: smartModelResolution?.classifierWorstCaseCents ?? 0,
  });
  const { budgetResult, safeMaxTokens, worstCaseCents } = budget;

  const reservation = await executeReservation({
    c,
    redis,
    billingResult,
    worstCaseCents,
    payerTier,
    isGroupBilling,
    memberContext,
    conversationId,
    userId,
    resolvedFundingSource,
  });
  if (!reservation.success) return reservation;

  return buildBillingSuccess({
    billingResult,
    budgetResult,
    safeMaxTokens,
    gatewayModels,
    reservation,
    smartModelResolution,
  });
}

interface BuildBillingSuccessInput {
  billingResult: BuildBillingResult;
  budgetResult: ReturnType<typeof calculateBudget>;
  safeMaxTokens: number | undefined;
  gatewayModels: RawModel[];
  reservation: Extract<ReservationResult, { success: true }>;
  smartModelResolution: SmartModelResolution | undefined;
}

function buildBillingSuccess(input: BuildBillingSuccessInput): BillingValidationSuccess {
  return {
    success: true,
    billingInput: input.billingResult.input,
    budgetResult: input.budgetResult,
    safeMaxTokens: input.safeMaxTokens,
    gatewayModels: input.gatewayModels,
    worstCaseCents: input.reservation.worstCaseCents,
    ...(input.reservation.groupBudget !== undefined && {
      groupBudget: input.reservation.groupBudget,
    }),
    billingUserId: input.reservation.billingUserId,
    ...(input.smartModelResolution !== undefined && {
      smartModelResolution: input.smartModelResolution,
    }),
  };
}

export interface ResolveAndReserveImageBillingInput {
  billingResult: BuildBillingResult;
  userId: string;
  models: string[];
  /** Actual per-image price for each selected model (pre-fee, USD). */
  perImageByModel: Map<string, number>;
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
}

/**
 * Common pre-reservation checks shared by image/video/audio billing resolvers.
 * Lives in `billing-reservation.ts`; this thin alias keeps the historical
 * call sites readable while the core logic is reusable for any modality that
 * lands at the same gate.
 */
async function resolveAndReserveMediaBilling(
  c: Context<AppEnv>,
  input: ReserveAfterDecisionInput
): Promise<ReservationResult> {
  return reserveMediaBilling(c, input, handleBillingDenial);
}

/**
 * Resolve billing for image generation. Flat cost — no token math.
 * Reserves the exact sum of per-model prices plus per-model storage; the
 * pipeline bills each model at its own price after generation.
 */
export async function resolveAndReserveImageBilling(
  c: Context<AppEnv>,
  input: ResolveAndReserveImageBillingInput
): Promise<ImageBillingValidationSuccess | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    perImageByModel,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;

  const exactCents = computeImageExactCents([...perImageByModel.values()]);

  const base = await resolveAndReserveMediaBilling(c, {
    billingResult,
    userId,
    worstCaseCents: exactCents,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    ...(conversationId !== undefined && { conversationId }),
  });
  if (!base.success) return base;

  return {
    ...base,
    perImageByModel,
  };
}

export interface ResolveAndReserveVideoBillingInput {
  billingResult: BuildBillingResult;
  userId: string;
  models: string[];
  /** Actual per-second price at the chosen resolution for each selected video model. */
  perSecondByModel: Map<string, number>;
  durationSeconds: number;
  resolution: VideoResolution;
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
}

/**
 * Resolve billing for video generation. Flat cost — no token math.
 * Computes worst-case as N × (perSecond × duration + storage) per model, reserves budget.
 */
export async function resolveAndReserveVideoBilling(
  c: Context<AppEnv>,
  input: ResolveAndReserveVideoBillingInput
): Promise<VideoBillingValidationSuccess | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    perSecondByModel,
    durationSeconds,
    resolution,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;

  const exactCents = computeVideoExactCents([...perSecondByModel.values()], durationSeconds);

  const base = await resolveAndReserveMediaBilling(c, {
    billingResult,
    userId,
    worstCaseCents: exactCents,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    ...(conversationId !== undefined && { conversationId }),
  });
  if (!base.success) return base;

  return {
    ...base,
    perSecondByModel,
    durationSeconds,
    resolution,
  };
}

export interface StreamPipelineInput {
  c: Context<AppEnv>;
  conversationId: string;
  models: string[];
  treeAction: TreeAction;
  messagesForInference: MessageForInference[];
  billingValidation: BillingValidationSuccess;
  memberContext?: MemberContext;
  webSearchEnabled: boolean;
  customInstructions?: string;
  releaseReservation: () => Promise<void>;
  senderId: string;
  forkId?: string;
}

/**
 * Writes the first model error to the SSE writer when every model in the
 * batch failed. Shared between the text and media pipelines: text passes
 * `classifyCode` so context-length failures get their dedicated code; media
 * leaves it as the default `ERROR_CODE_STREAM_ERROR`. The fallback message
 * differs per modality (no content / no image / no video / no audio).
 */
async function writeFirstError<T extends { error: Error | null }>(
  results: Map<string, T>,
  writer: SSEEventWriter,
  options: {
    fallbackMessage: string;
    classifyCode?: (error: Error) => string;
  }
): Promise<void> {
  const firstError = [...results.values()].find((r) => r.error !== null)?.error;
  if (firstError) {
    const code = options.classifyCode?.(firstError) ?? ERROR_CODE_STREAM_ERROR;
    await writer.writeError({ message: firstError.message, code });
    return;
  }
  await writer.writeError({
    message: options.fallbackMessage,
    code: ERROR_CODE_STREAM_ERROR,
  });
}

/** Writes the first stream error to the SSE writer when all models fail. */
async function writeFirstStreamError(
  multiResults: Map<string, StreamResult>,
  writer: SSEEventWriter
): Promise<void> {
  await writeFirstError(multiResults, writer, {
    fallbackMessage: 'No content generated',
    classifyCode: classifyStreamErrorCode,
  });
}

/**
 * Extract the most recent user message and assistant message from the
 * inference history, for the Smart Model classifier's truncation algorithm.
 * Both are plain strings — empty when no message of that role exists.
 *
 * Pure helper; lives next to the pipeline that consumes it. Future stages
 * that need conversation context can reuse this.
 */
function findLatestByRole(
  messages: readonly MessageForInference[],
  role: MessageForInference['role']
): string {
  return messages.findLast((m) => m.role === role)?.content ?? '';
}

export function extractConversationContextForClassifier(
  messagesForInference: readonly MessageForInference[]
): { latestUserMessage: string; latestAssistantMessage: string } {
  return {
    latestUserMessage: findLatestByRole(messagesForInference, 'user'),
    latestAssistantMessage: findLatestByRole(messagesForInference, 'assistant'),
  };
}

interface BuildAssistantMessagesOptions {
  successfulModels: [string, StreamResult][];
  getAssistantId: (modelId: string) => string;
  aiClient: AIClient;
  lastInferenceMessage: { content: string } | undefined;
  /**
   * Per-slot metadata produced by pre-inference. Keyed by the slot's user-facing
   * modelId (the same key used for SSE events). Slots without metadata behave
   * as before — no stages, no Smart Model badge, model id is the selection.
   */
  slotMetadataByModelId: ReadonlyMap<string, SlotPreInferenceMetadata>;
  /**
   * Per-slot pre-flight reservation estimate in USD. Compared against the
   * post-flight gateway-reported cost to record a `billing-mismatch` evidence
   * row when the deviation exceeds the threshold. Allocated as
   * `worstCaseDollars / models.length` from the turn-level reservation.
   */
  slotEstimateUsd: number;
  /**
   * Evidence config for the billing-mismatch comparison. `recordServiceEvidence`
   * itself gates the DB write on `isCI`, so production stays a no-op even when
   * supplied.
   */
  evidence: EvidenceConfig;
}

interface AssistantPersistInput {
  modality: 'text';
  id: string;
  content: string;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  isEstimated: boolean;
  isSmartModel?: boolean;
  preInferenceBillings?: PreInferenceBillingPersistence[];
}

interface SlotAssistantInput {
  assistantMessageId: string;
  result: StreamResult;
  /** Always present — buildAssistantMessages synthesises a no-stage default for slots without pre-inference. */
  meta: SlotPreInferenceMetadata;
  inputContent: string;
  aiClient: AIClient;
  /** Reservation estimate (USD) for this slot, used by the billing-mismatch comparison. */
  slotEstimateUsd: number;
  /** Evidence config so the comparison can persist a row when CI is detected. */
  evidence: EvidenceConfig;
}

function baseAssistantPersist(input: {
  assistantMessageId: string;
  fullContent: string;
  persistedModelId: string;
  cost: number;
  inputContent: string;
  isSmartModel: boolean;
  isEstimated: boolean;
}): AssistantPersistInput {
  return {
    modality: 'text' as const,
    id: input.assistantMessageId,
    content: input.fullContent,
    model: input.persistedModelId,
    cost: input.cost,
    inputTokens: estimateTokenCount(input.inputContent),
    outputTokens: estimateTokenCount(input.fullContent),
    isEstimated: input.isEstimated,
    ...(input.isSmartModel && { isSmartModel: true }),
  };
}

/**
 * Slot ran pre-inference stages (Smart Model classifier today). Cost
 * calculator returns the total + per-stage breakdown; persistence writes
 * the main usage_records row plus one row per stage.
 */
async function buildStagedPersistInput(
  input: SlotAssistantInput,
  modelId: string,
  generationId: string
): Promise<AssistantPersistInput> {
  const { assistantMessageId, result, meta, inputContent, aiClient } = input;
  const costResult = await calculateMessageCostWithStages({
    aiClient,
    mainGenerationId: generationId,
    mainModelId: modelId,
    stageBillings: meta.preInferenceBillings,
    inputContent,
    outputContent: result.fullContent,
  });
  const stagePersistence: PreInferenceBillingPersistence[] = costResult.stageBreakdown.map((b) => ({
    stageId: b.billing.stageId,
    modelId: b.billing.modelId,
    costDollars: b.costDollars,
    inputTokens: estimateTokenCount(b.billing.inputContent),
    outputTokens: estimateTokenCount(b.billing.outputContent),
    isEstimated: b.wasEstimated,
  }));
  return {
    ...baseAssistantPersist({
      assistantMessageId,
      fullContent: result.fullContent,
      persistedModelId: modelId,
      cost: costResult.mainCostDollars,
      inputContent,
      isSmartModel: true,
      isEstimated: costResult.mainWasEstimated,
    }),
    preInferenceBillings: stagePersistence,
  };
}

async function buildSlotPersistInput(input: SlotAssistantInput): Promise<AssistantPersistInput> {
  const { assistantMessageId, result, meta, inputContent, aiClient } = input;

  // generationId is required to compute exact cost — fall back to 0 if missing
  // (only happens for failed/incomplete streams that still produced content).
  if (!result.generationId) {
    return baseAssistantPersist({
      assistantMessageId,
      fullContent: result.fullContent,
      persistedModelId: meta.resolvedModelId,
      cost: 0,
      inputContent,
      isSmartModel: meta.isSmartModel,
      isEstimated: false,
    });
  }

  if (meta.preInferenceBillings.length > 0) {
    const persisted = await buildStagedPersistInput(
      input,
      meta.resolvedModelId,
      result.generationId
    );
    // Compare the slot's reservation estimate against the realized total
    // (main + stages, fees and storage included). Non-blocking; never throws.
    await recordBillingMismatchIfExceeded({
      estimateUsd: input.slotEstimateUsd,
      actualUsd: persisted.cost,
      evidence: input.evidence,
    });
    return persisted;
  }

  const { totalDollars, wasEstimated } = await calculateMessageCost({
    aiClient,
    generationId: result.generationId,
    modelId: meta.resolvedModelId,
    inputContent,
    outputContent: result.fullContent,
  });
  await recordBillingMismatchIfExceeded({
    estimateUsd: input.slotEstimateUsd,
    actualUsd: totalDollars,
    evidence: input.evidence,
  });
  return baseAssistantPersist({
    assistantMessageId,
    fullContent: result.fullContent,
    persistedModelId: meta.resolvedModelId,
    cost: totalDollars,
    inputContent,
    isSmartModel: meta.isSmartModel,
    isEstimated: wasEstimated,
  });
}

/** Builds the assistant message array from successful model results for persistence. */
async function buildAssistantMessages(
  options: BuildAssistantMessagesOptions
): Promise<AssistantPersistInput[]> {
  const {
    successfulModels,
    getAssistantId,
    aiClient,
    lastInferenceMessage,
    slotMetadataByModelId,
    slotEstimateUsd,
    evidence,
  } = options;
  const inputContent = lastInferenceMessage?.content ?? '';
  return Promise.all(
    successfulModels.map(([modelId, result]) =>
      buildSlotPersistInput({
        assistantMessageId: getAssistantId(modelId),
        result,
        meta: slotMetadataByModelId.get(modelId) ?? {
          modelId,
          assistantMessageId: getAssistantId(modelId),
          resolvedModelId: modelId,
          isSmartModel: false,
          preInferenceBillings: [],
        },
        inputContent,
        aiClient,
        slotEstimateUsd,
        evidence,
      })
    )
  );
}

/**
 * Pre-inference outcome for a single slot, captured before stream entries are
 * built. Successful slots contribute streamEntries; failed slots are reported
 * via `writeModelError` and excluded.
 */
interface SlotPreInferenceMetadata {
  modelId: string;
  assistantMessageId: string;
  resolvedModelId: string;
  isSmartModel: boolean;
  preInferenceBillings: PreInferenceBilling[];
}

interface RunPreInferenceForSlotsArgs {
  models: readonly string[];
  getAssistantId: (modelId: string) => string;
  smartModelResolution: SmartModelResolution | undefined;
  conversationContext: { latestUserMessage: string; latestAssistantMessage: string };
  aiClient: AIClient;
  writer: SSEEventWriter;
}

/**
 * The `is_smart_model` flag must be tied to the routing stage specifically,
 * not "any stage that produces a `resolvedModelId`" — future stages (model
 * fallback, safety redirect) might also rewrite the model id without being
 * routing. Driven by the list of stages that actually ran, NOT by billings:
 * a classifier failure that falls back to the cheapest eligible model
 * produces no billing entry yet the smart-model stage did run, so the chip
 * still belongs on the response.
 */
export function derivedIsSmartModel(stagesRun: readonly string[]): boolean {
  return stagesRun.includes('smart-model');
}

async function runPreInferenceForSlot(
  modelId: string,
  args: RunPreInferenceForSlotsArgs
): Promise<SlotPreInferenceMetadata | null> {
  const { getAssistantId, smartModelResolution, conversationContext, aiClient, writer } = args;
  const assistantMsgId = getAssistantId(modelId);
  const stages = resolveStagesForSlot({
    modality: 'text',
    selectedModelId: modelId,
    ...(smartModelResolution !== undefined && {
      smartModelResolution: { ...smartModelResolution, conversationContext },
    }),
  });

  if (stages.length === 0) {
    return {
      modelId,
      assistantMessageId: assistantMsgId,
      resolvedModelId: modelId,
      isSmartModel: false,
      preInferenceBillings: [],
    };
  }

  const chainResult = await executePreInferenceChain({
    stages,
    aiClient,
    writer,
    assistantMessageId: assistantMsgId,
  });

  if (!chainResult.ok) {
    await writer.writeModelError({
      modelId,
      message: 'Pre-inference stage failed',
      code: chainResult.errorCode,
    });
    return null;
  }

  return {
    modelId,
    assistantMessageId: assistantMsgId,
    resolvedModelId: chainResult.transformation.resolvedModelId ?? modelId,
    isSmartModel: derivedIsSmartModel(chainResult.stagesRun),
    preInferenceBillings: chainResult.billings,
  };
}

/**
 * Per-slot pre-inference: each slot runs its stage chain (currently only Smart
 * Model). Successful slots produce a {@link SlotPreInferenceMetadata}; failed
 * slots emit `model:error` and are excluded so sibling slots stream
 * independently.
 *
 * Sequential by design today — Smart Model is the only stage and the user can
 * select it at most once, so at most one slot has stages and parallelism would
 * add no value. Switch to `Promise.all` when multiple slots ever carry stages
 * (e.g., per-slot prompt enhancers).
 */
async function runPreInferenceForSlots(
  args: RunPreInferenceForSlotsArgs
): Promise<Map<string, SlotPreInferenceMetadata>> {
  const slotMetadataByModelId = new Map<string, SlotPreInferenceMetadata>();
  for (const modelId of args.models) {
    const meta = await runPreInferenceForSlot(modelId, args);
    if (meta !== null) slotMetadataByModelId.set(modelId, meta);
  }
  return slotMetadataByModelId;
}

interface BuildSlotStreamEntriesArgs {
  models: readonly string[];
  slotMetadataByModelId: ReadonlyMap<string, SlotPreInferenceMetadata>;
  aiMessages: ReturnType<typeof buildAIMessages>;
  safeMaxTokens: number | undefined;
  webSearchEnabled: boolean;
  aiClient: AIClient;
  envBindings: Bindings;
  conversationId: string;
  senderId: string;
}

/**
 * Build one stream entry per slot that survived pre-inference. The SSE key
 * remains the user-facing modelId (e.g., 'smart-model'); the actual
 * `aiClient.stream` call uses the resolved model id when stages produced one.
 */
function buildSlotStreamEntries(args: BuildSlotStreamEntriesArgs): ModelStreamEntry[] {
  const entries: ModelStreamEntry[] = [];
  for (const modelId of args.models) {
    const meta = args.slotMetadataByModelId.get(modelId);
    if (!meta) continue;
    const textRequest: TextRequest = getStrategy('text').buildRequest({
      modelId: meta.resolvedModelId,
      messages: args.aiMessages,
      webSearchEnabled: args.webSearchEnabled,
      ...(args.safeMaxTokens !== undefined && { maxOutputTokens: args.safeMaxTokens }),
    });
    const rawStream = args.aiClient.stream(textRequest);
    entries.push({
      modelId,
      assistantMessageId: meta.assistantMessageId,
      stream: withBroadcast(rawStream, {
        env: args.envBindings,
        conversationId: args.conversationId,
        assistantMessageId: meta.assistantMessageId,
        modelName: meta.resolvedModelId,
        senderId: args.senderId,
      }),
    });
  }
  return entries;
}

/**
 * Execute the full SSE streaming pipeline: generate IDs, build prompt,
 * broadcast user message, stream AI responses, calculate costs, persist,
 * broadcast completion, and release reservation.
 */

export function executeStreamPipeline(input: StreamPipelineInput): Response {
  const {
    c,
    conversationId,
    models,
    treeAction,
    messagesForInference,
    billingValidation,
    memberContext,
    webSearchEnabled,
    customInstructions,
    releaseReservation,
    senderId,
    forkId,
  } = input;
  const { safeMaxTokens, billingUserId, smartModelResolution } = billingValidation;
  const model = models[0];
  if (!model) throw new Error('invariant: models must have at least one entry');
  const db = c.get('db');
  const aiClient = c.get('aiClient');
  const userMessageId = treeActionUserMessageId(treeAction);

  const getAssistantId = createAssistantIdLookup(models);

  const { systemPrompt } = buildPrompt({
    modelId: model,
    supportedCapabilities: [],
    ...(customInstructions !== undefined && { customInstructions }),
  });

  const aiMessages = buildAIMessages(systemPrompt, messagesForInference);
  const lastInferenceMessage = messagesForInference.at(-1);
  const conversationContext = extractConversationContextForClassifier(messagesForInference);

  // Regenerate / edit don't broadcast `message:new` — the user message
  // already exists (regenerate) or the client optimistically prunes and
  // re-renders (edit). Group viewers learn about it via `message:complete`.
  if (treeAction.kind === 'fresh-send') {
    const lastContent = lastInferenceMessage?.content ?? '';
    broadcastFireAndForget(
      c.env,
      conversationId,
      createEvent('message:new', {
        messageId: userMessageId,
        conversationId,
        senderType: 'user',
        senderId,
        content: lastContent,
      }),
      safeExecutionCtx(c)
    );
  }

  return streamSSE(c, async (stream) => {
    const writer = createSSEEventWriter(stream);
    try {
      await runStreamingTurn({
        writer,
        models,
        getAssistantId,
        smartModelResolution,
        conversationContext,
        aiMessages,
        safeMaxTokens,
        webSearchEnabled,
        lastInferenceMessage,
        aiClient,
        db,
        c,
        treeAction,
        userMessageId,
        billingValidation,
        memberContext,
        forkId,
        senderId,
        conversationId,
        billingUserId,
        primaryModel: model,
      });
    } catch (error) {
      // Structural catch: any uncaught exception in `runStreamingTurn` would
      // otherwise close the SSE socket cleanly after the last successful
      // event and leave the client hung on STREAM_TIMEOUT_MS.
      //
      // `handleStreamException` branches on whether `writeDone` already ran:
      // pre-done, it surfaces the error to the client; post-done, it logs
      // server-side without retracting the success the client already saw.
      await handleStreamException(writer, error);
    } finally {
      await releaseReservation();
    }
  });
}

interface RunStreamingTurnArgs {
  writer: SSEEventWriter;
  models: string[];
  getAssistantId: (modelId: string) => string;
  smartModelResolution: SmartModelResolution | undefined;
  conversationContext: { latestUserMessage: string; latestAssistantMessage: string };
  aiMessages: ReturnType<typeof buildAIMessages>;
  safeMaxTokens: number | undefined;
  webSearchEnabled: boolean;
  lastInferenceMessage: MessageForInference | undefined;
  aiClient: AIClient;
  db: AppEnv['Variables']['db'];
  c: Context<AppEnv>;
  treeAction: TreeAction;
  /** Pre-resolved from {@link treeAction} so the helpers don't re-derive it. */
  userMessageId: string;
  billingValidation: BillingValidationSuccess;
  memberContext: MemberContext | undefined;
  forkId: string | undefined;
  senderId: string;
  conversationId: string;
  billingUserId: string;
  primaryModel: string;
}

/**
 * Drive the per-turn SSE streaming flow inside the streamSSE callback. Pulled
 * out so the outer pipeline only owns the writer lifecycle and reservation
 * release; this function owns event emission, pre-inference, multi-model
 * collection, persistence, and broadcast.
 */
async function runStreamingTurn(args: RunStreamingTurnArgs): Promise<void> {
  const { writer, models, getAssistantId, userMessageId } = args;

  await writer.writeStart({
    userMessageId,
    models: models.map((modelId) => ({
      modelId,
      assistantMessageId: getAssistantId(modelId),
    })),
  });

  const slotMetadataByModelId = await runPreInferenceForSlots({
    models,
    getAssistantId,
    smartModelResolution: args.smartModelResolution,
    conversationContext: args.conversationContext,
    aiClient: args.aiClient,
    writer,
  });

  const streamEntries = buildSlotStreamEntries({
    models,
    slotMetadataByModelId,
    aiMessages: args.aiMessages,
    safeMaxTokens: args.safeMaxTokens,
    webSearchEnabled: args.webSearchEnabled,
    aiClient: args.aiClient,
    envBindings: args.c.env,
    conversationId: args.conversationId,
    senderId: args.senderId,
  });

  if (streamEntries.length === 0) {
    await writer.writeError({
      message: 'All slots failed pre-inference',
      code: ERROR_CODE_CLASSIFIER_FAILED,
    });
    return;
  }

  const multiResults = await collectMultiModelStreams(streamEntries, writer);
  const successfulModels = [...multiResults.entries()].filter(
    ([, r]) => r.error === null && r.fullContent.length > 0
  );

  if (successfulModels.length === 0) {
    await writeFirstStreamError(multiResults, writer);
    return;
  }

  await persistAndBroadcastTurn({
    ...args,
    successfulModels,
    multiResults,
    slotMetadataByModelId,
  });
}

interface PersistAndBroadcastArgs extends RunStreamingTurnArgs {
  successfulModels: [string, StreamResult][];
  multiResults: Map<string, StreamResult>;
  slotMetadataByModelId: ReadonlyMap<string, SlotPreInferenceMetadata>;
}

async function persistAndBroadcastTurn(args: PersistAndBroadcastArgs): Promise<void> {
  // Per-slot reservation estimate in USD. The turn-level reservation
  // (`worstCaseCents`) covers every slot, so dividing by the slot count gives
  // the budget the billing-mismatch comparison should test against.
  const slotEstimateUsd =
    args.models.length > 0 ? args.billingValidation.worstCaseCents / 100 / args.models.length : 0;

  const assistantMessages = await buildAssistantMessages({
    successfulModels: args.successfulModels,
    getAssistantId: args.getAssistantId,
    aiClient: args.aiClient,
    lastInferenceMessage: args.lastInferenceMessage,
    slotMetadataByModelId: args.slotMetadataByModelId,
    slotEstimateUsd,
    evidence: createEvidenceConfig(args.c),
  });

  const groupBillingContext = buildGroupBillingContext(
    args.memberContext,
    args.billingValidation.groupBudget
  );
  const billingPromise = saveChatTurn(args.db, {
    treeAction: args.treeAction,
    conversationId: args.conversationId,
    userId: args.billingUserId,
    senderId: args.senderId,
    assistantMessages,
    ...(groupBillingContext !== undefined && { groupBillingContext }),
    ...(args.forkId !== undefined && { forkId: args.forkId }),
  });

  const billingResult = await handleBillingResult({
    c: args.c,
    billingPromise,
    assistantMessageId: args.getAssistantId(args.primaryModel),
    userId: args.billingUserId,
    senderId: args.senderId,
    model: args.primaryModel,
    generationId: args.multiResults.get(args.primaryModel)?.generationId,
  });

  if (!billingResult) {
    await args.writer.writeError({
      message: 'Failed to save message',
      code: ERROR_CODE_BILLING_ERROR,
    });
    return;
  }

  // Broadcast events use the RESOLVED model id — what `content_items.model_name`
  // stores — so other group members see the actual model that produced the
  // response, not the user-facing slot id (e.g., 'smart-model').
  const resolveBroadcastModelName = (modelId: string): string =>
    args.slotMetadataByModelId.get(modelId)?.resolvedModelId ?? modelId;

  await finalizeTurn({
    c: args.c,
    conversationId: args.conversationId,
    userMessageId: args.userMessageId,
    successfulModelIds: args.successfulModels.map(([modelId]) => modelId),
    primaryModelId: args.primaryModel,
    getAssistantId: args.getAssistantId,
    billingResult,
    writer: args.writer,
    resolveBroadcastModelName,
    senderId: args.senderId,
    db: args.db,
  });
}

export interface ImagePipelineInput {
  c: Context<AppEnv>;
  conversationId: string;
  models: string[];
  treeAction: TreeAction;
  prompt: string;
  imageBilling: ImageBillingValidationSuccess;
  memberContext?: MemberContext;
  releaseReservation: () => Promise<void>;
  senderId: string;
  forkId?: string;
  aspectRatio?: ImageAspectRatio;
}

/**
 * Shared pipeline for image/video/audio generation. Lives in
 * `media-pipeline.ts`; this module wires the modality-agnostic dependencies
 * (writeFirstMediaError, handleBillingResult, finalizeTurn,
 * createAssistantIdLookup) and forwards the per-modality input through.
 */
function executeMediaPipeline(input: MediaPipelineInput): Response {
  return executeMediaPipelineImpl(input, {
    writeFirstMediaError,
    handleBillingResult,
    finalizeTurn,
    createAssistantIdLookup,
  });
}

/** Writes the first media error to the SSE writer when all models fail. */
async function writeFirstMediaError(
  mediaResults: Map<string, MediaStreamResult>,
  writer: SSEEventWriter,
  noContentMessage: string
): Promise<void> {
  await writeFirstError(mediaResults, writer, {
    fallbackMessage: noContentMessage,
  });
}

/**
 * Execute the full image generation pipeline: generate images from N models in parallel,
 * encrypt, store in R2, compute costs, persist, and emit SSE done events.
 */
export function executeImagePipeline(input: ImagePipelineInput): Response {
  const {
    c,
    conversationId,
    models,
    treeAction,
    prompt,
    imageBilling,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    aspectRatio,
  } = input;

  const imageStrategy = getStrategy('image');
  return executeMediaPipeline({
    c,
    conversationId,
    models,
    treeAction,
    prompt,
    billingUserId: imageBilling.billingUserId,
    groupBudget: imageBilling.groupBudget,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    mediaType: imageStrategy.modality,
    pricingFor: (modelId, result) => imageStrategy.pricingFor(modelId, result, imageBilling),
    buildRequest: (modelId): ImageRequest =>
      imageStrategy.buildRequest({
        modelId,
        billing: imageBilling,
        extras: {
          prompt,
          ...(aspectRatio !== undefined && { aspectRatio }),
        },
      }),
    noContentErrorMessage: imageStrategy.noContentErrorMessage,
  });
}

export interface VideoPipelineInput {
  c: Context<AppEnv>;
  conversationId: string;
  models: string[];
  treeAction: TreeAction;
  prompt: string;
  videoBilling: VideoBillingValidationSuccess;
  memberContext?: MemberContext;
  releaseReservation: () => Promise<void>;
  senderId: string;
  forkId?: string;
  aspectRatio: VideoAspectRatio;
}

/**
 * Execute the full video generation pipeline: generate videos from N models in parallel,
 * encrypt, store in R2, compute costs (duration × perSecond), persist, and emit SSE done events.
 */
export function executeVideoPipeline(input: VideoPipelineInput): Response {
  const {
    c,
    conversationId,
    models,
    treeAction,
    prompt,
    videoBilling,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    aspectRatio,
  } = input;

  const videoStrategy = getStrategy('video');
  return executeMediaPipeline({
    c,
    conversationId,
    models,
    treeAction,
    prompt,
    billingUserId: videoBilling.billingUserId,
    groupBudget: videoBilling.groupBudget,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    mediaType: videoStrategy.modality,
    pricingFor: (modelId, result) => videoStrategy.pricingFor(modelId, result, videoBilling),
    buildRequest: (modelId): VideoRequest =>
      videoStrategy.buildRequest({
        modelId,
        billing: videoBilling,
        extras: { prompt, aspectRatio },
      }),
    noContentErrorMessage: videoStrategy.noContentErrorMessage,
  });
}

export interface ResolveAndReserveAudioBillingInput {
  billingResult: BuildBillingResult;
  userId: string;
  models: string[];
  /** Per-second USD price for each selected audio model. */
  perSecondByModel: Map<string, number>;
  /** Cap on the synthesized audio duration; reservation uses this as the upper bound. */
  maxDurationSeconds: number;
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
}

/**
 * Resolve billing for audio (TTS) generation.
 *
 * Audio differs from image and video in that the output duration is not
 * user-specified — it emerges from synthesizing the input text. We can't
 * compute an exact pre-flight cost, so we reserve against `maxDurationSeconds`
 * and rebill at the actual generated duration.
 */
export async function resolveAndReserveAudioBilling(
  c: Context<AppEnv>,
  input: ResolveAndReserveAudioBillingInput
): Promise<AudioBillingValidationSuccess | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    perSecondByModel,
    maxDurationSeconds,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;

  const worstCaseCents = computeAudioWorstCaseCents(
    [...perSecondByModel.values()],
    maxDurationSeconds
  );

  const base = await resolveAndReserveMediaBilling(c, {
    billingResult,
    userId,
    worstCaseCents,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    ...(conversationId !== undefined && { conversationId }),
  });
  if (!base.success) return base;

  return {
    ...base,
    perSecondByModel,
    maxDurationSeconds,
  };
}

export interface AudioPipelineInput {
  c: Context<AppEnv>;
  conversationId: string;
  models: string[];
  treeAction: TreeAction;
  prompt: string;
  audioBilling: AudioBillingValidationSuccess;
  memberContext?: MemberContext;
  releaseReservation: () => Promise<void>;
  senderId: string;
  forkId?: string;
  format: 'mp3' | 'wav' | 'ogg';
  voice?: string;
}

/**
 * Execute the full audio (TTS) generation pipeline.
 *
 * Audio billing is post-hoc per-model: each model's actual cost is its
 * `perSecond × actualDurationMs/1000`, computed in `pricingFor` once the
 * generation completes. The pre-flight reservation (in
 * `resolveAndReserveAudioBilling`) covers worst-case via `maxDurationSeconds`.
 */
export function executeAudioPipeline(input: AudioPipelineInput): Response {
  const {
    c,
    conversationId,
    models,
    treeAction,
    prompt,
    audioBilling,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    format,
    voice,
  } = input;

  const audioStrategy = getStrategy('audio');
  return executeMediaPipeline({
    c,
    conversationId,
    models,
    treeAction,
    prompt,
    billingUserId: audioBilling.billingUserId,
    groupBudget: audioBilling.groupBudget,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    mediaType: audioStrategy.modality,
    pricingFor: (modelId, result) => audioStrategy.pricingFor(modelId, result, audioBilling),
    buildRequest: (modelId): AudioRequest =>
      audioStrategy.buildRequest({
        modelId,
        billing: audioBilling,
        extras: {
          prompt,
          format,
          ...(voice !== undefined && { voice }),
        },
      }),
    noContentErrorMessage: audioStrategy.noContentErrorMessage,
  });
}
