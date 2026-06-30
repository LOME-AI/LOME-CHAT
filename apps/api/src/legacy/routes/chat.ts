import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { conversationForks } from '@hushbox/db';
import {
  streamChatRequestSchema,
  userOnlyMessageSchema,
  regenerateRequestSchema,
  ERROR_CODE_LAST_MESSAGE_NOT_USER,
  ERROR_CODE_REGENERATION_BLOCKED_BY_OTHER_USER,
  ERROR_CODE_FORK_NOT_FOUND,
  ERROR_CODE_MEDIA_TRIAL_BLOCKED,
  ERROR_CODE_MODEL_NOT_FOUND,
  ERROR_CODE_MODALITY_MISMATCH,
  ERROR_CODE_MODEL_TIER_LOCKED,
  ERROR_CODE_UNSUPPORTED_RESOLUTION,
  ERROR_CODE_UNSUPPORTED_DURATION,
  ERROR_CODE_AUDIO_DISABLED,
  ERROR_CODE_DUPLICATE_MESSAGE,
  ERROR_CODE_FORK_TIP_CONFLICT,
  FEATURE_FLAGS,
  assertNever,
} from '@hushbox/shared';
import { getSupportedVideoDurations, type LegacyModality } from '@hushbox/shared/models';
import { createEvent } from '@hushbox/realtime/events';
import { getProcessedCatalog } from '../lib/processed-catalog.js';
import { isUniqueViolation } from '../lib/unique-violation.js';
import { validateLastMessageIsFromUser, saveUserOnlyMessage } from '../services/chat/index.js';
import { canRegenerate } from '../services/chat/regeneration-guard.js';
import { createErrorResponse } from '../lib/error-response.js';
import { requirePrivilege, rateLimitByCaller } from '../middleware/index.js';
import { broadcastFireAndForget } from '../lib/broadcast.js';
import { buildBillingInput, buildGuestBillingInput } from '../services/billing/index.js';
import { getUserTierInfo } from '../services/billing/balance.js';
import { resolveParentMessageId, ForkTipConflictError } from '../services/chat/message-helpers.js';
import {
  releaseBudget,
  releaseGroupBudget,
  type GroupBudgetReservation,
} from '../lib/speculative-balance.js';
import {
  resolveAndReserveBilling,
  resolveAndReserveImageBilling,
  resolveAndReserveVideoBilling,
  resolveAndReserveAudioBilling,
  executeStreamPipeline,
  executeImagePipeline,
  executeVideoPipeline,
  executeAudioPipeline,
} from '../lib/stream-pipeline.js';
import { getStrategy } from '../lib/modality-strategies.js';
import { getPushClient, sendPushForNewMessage } from '../services/push/index.js';
import { fireAndForget } from '../lib/fire-and-forget.js';
import { safeExecutionCtx } from '../lib/safe-execution-ctx.js';
import type { TreeAction } from '../services/chat/tree-action.js';
import type { MemberContext } from '../services/billing/index.js';
import type { AppEnv } from '../types.js';
import type { FundingSource, ImageConfig, VideoConfig, AudioConfig } from '@hushbox/shared';

export { computeWorstCaseCents } from '../lib/stream-pipeline.js';

interface InferenceMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const noOpRelease = (): Promise<void> => Promise.resolve();

/** Retrieves the member from the members Map. Throws if not found (invariant after requirePrivilege). */
function getMember(
  c: Context<AppEnv>,
  conversationId: string
): { id: string; privilege: string; visibleFromEpoch: number } {
  const member = c.get('members').get(conversationId);
  if (!member) throw new Error('Member required after requirePrivilege');
  return member;
}

/** Picks the right budget release strategy based on billing context. */
function resolveReleaseReservation(
  redis: AppEnv['Variables']['redis'],
  groupBudget: GroupBudgetReservation | undefined,
  user: AppEnv['Variables']['user'],
  worstCaseCents: number
): () => Promise<void> {
  if (groupBudget) {
    return (): Promise<void> => releaseGroupBudget(redis, groupBudget);
  }
  if (user) {
    return (): Promise<void> => releaseBudget(redis, user.id, worstCaseCents);
  }
  return noOpRelease;
}

/**
 * Pre-billing tier gate: rejects requests where the caller has selected a
 * premium model but their tier (free/trial/guest) doesn't allow it. Returns
 * the locked model id when blocked, or null when the request can proceed.
 *
 * Distinct from the balance-based denial in `handleBillingDenial` (which
 * fires for paid users with insufficient funds): this one fires earlier with
 * a 403 + {@link ERROR_CODE_MODEL_TIER_LOCKED} so the client renders an
 * "upgrade your account" message rather than "top up your balance".
 *
 * Owner-paid group chats are not gated here — the owner's tier governs model
 * access via the existing `resolveBilling` group-billing path. This only
 * gates the personal-billing path.
 */
async function findTierLockedModel(
  c: Context<AppEnv>,
  models: readonly string[],
  callerId: string | null
): Promise<string | null> {
  const db = c.get('db');
  const [tierInfo, { premiumIds }] = await Promise.all([
    getUserTierInfo(db, callerId),
    getProcessedCatalog(c),
  ]);
  if (tierInfo.canAccessPremium) return null;
  const premiumSet = new Set(premiumIds);
  for (const modelId of models) {
    if (premiumSet.has(modelId)) return modelId;
  }
  return null;
}

/** Subset of ModelInfo fields the lookup needs — only `pricing` is read. */
type ModelInfoForLookup = Awaited<
  ReturnType<AppEnv['Variables']['aiClient']['listModels']>
>[number];

/**
 * Per-modality extract callback for {@link lookupMediaModels}. Returns a
 * discriminated outcome: `ok` carries the per-model price datum to record;
 * `mismatch` and `unsupported-resolution` push the model id into the
 * matching reject bucket.
 */
type MediaExtractOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'mismatch' }
  | { kind: 'unsupported-resolution' };

type MediaPriceExtract<T> = (info: ModelInfoForLookup) => MediaExtractOutcome<T>;

interface MediaModelLookupResult<T> {
  perModelByModel: Map<string, T>;
  mismatches: string[];
  notFound: string[];
  unsupportedResolutions: string[];
}

/**
 * Generic media-model lookup. Walks selected model IDs, fetches the gateway's
 * model list once, and bins each model into a per-model price map, mismatches,
 * notFound, or unsupportedResolutions. Per-modality `extract` plugs in the
 * pricing rule (`pricing.image`, `pricing.perSecondByResolution[r]`,
 * `pricing.audio`).
 */
export async function lookupMediaModels<T>(
  aiClient: AppEnv['Variables']['aiClient'],
  models: string[],
  extract: MediaPriceExtract<T>
): Promise<MediaModelLookupResult<T>> {
  const allModels = await aiClient.listModels();
  const mismatches: string[] = [];
  const notFound: string[] = [];
  const unsupportedResolutions: string[] = [];
  const perModelByModel = new Map<string, T>();

  for (const modelId of models) {
    const info = allModels.find((m) => m.id === modelId);
    if (!info) {
      notFound.push(modelId);
      continue;
    }
    const outcome = extract(info);
    switch (outcome.kind) {
      case 'ok': {
        perModelByModel.set(modelId, outcome.value);
        break;
      }
      case 'mismatch': {
        mismatches.push(modelId);
        break;
      }
      case 'unsupported-resolution': {
        unsupportedResolutions.push(modelId);
        break;
      }
      default: {
        assertNever(outcome);
      }
    }
  }

  return { perModelByModel, mismatches, notFound, unsupportedResolutions };
}

const extractImagePrice: MediaPriceExtract<number> = (info) =>
  info.pricing.kind === 'image'
    ? { kind: 'ok', value: info.pricing.perImage }
    : { kind: 'mismatch' };

function buildVideoExtractor(resolution: string): MediaPriceExtract<number> {
  return (info) => {
    if (info.pricing.kind !== 'video') return { kind: 'mismatch' };
    const price = info.pricing.perSecondByResolution[resolution];
    return price === undefined ? { kind: 'unsupported-resolution' } : { kind: 'ok', value: price };
  };
}

const extractAudioPrice: MediaPriceExtract<number> = (info) =>
  info.pricing.kind === 'audio'
    ? { kind: 'ok', value: info.pricing.perSecond }
    : { kind: 'mismatch' };

interface MediaBranchInputBase {
  c: Context<AppEnv>;
  conversationId: string;
  callerId: string;
  user: AppEnv['Variables']['user'];
  billingContext: BillingContext;
  models: string[];
  prompt: string;
  treeAction: TreeAction;
  forkId: string | undefined;
}

interface ImageBranchInput extends MediaBranchInputBase {
  imageConfig: ImageConfig | undefined;
}

interface VideoBranchInput extends MediaBranchInputBase {
  videoConfig: VideoConfig;
}

interface AudioBranchInput extends MediaBranchInputBase {
  audioConfig: AudioConfig;
}

/**
 * Result of running a per-modality lookup. Either an early-return error
 * Response (model not found, modality mismatch, unsupported resolution) OR
 * the per-model price map needed by the modality-specific billing call.
 */
type LookupResult<T> = { ok: true; perModel: T } | { ok: false; response: Response };

/**
 * Build an ERROR_CODE_MODEL_NOT_FOUND / ERROR_CODE_MODALITY_MISMATCH response
 * shared by every media lookup. Returns null when the lookup succeeds.
 */
function lookupRejectResponse(
  c: Context<AppEnv>,
  notFound: string[],
  mismatches: string[]
): Response | null {
  if (notFound.length > 0) {
    return c.json(createErrorResponse(ERROR_CODE_MODEL_NOT_FOUND, { models: notFound }), 400);
  }
  if (mismatches.length > 0) {
    return c.json(
      createErrorResponse(ERROR_CODE_MODALITY_MISMATCH, { invalidModels: mismatches }),
      400
    );
  }
  return null;
}

/**
 * Shared skeleton for media (image/video/audio) stream handlers. Three steps:
 * 1. Run modality-specific lookup → reject on `notFound` / `mismatches` /
 *    `unsupportedResolutions`.
 * 2. Run modality-specific billing reservation → reject on billing failure.
 * 3. Resolve the release-on-failure callback and dispatch the pipeline with
 *    the resolved billing.
 *
 * Each modality plugs in its `lookup`, `reserveBilling`, and `runPipeline`
 * callbacks. Behavior is identical to the inlined handlers — same SSE events,
 * same DB writes, same billing math, same error codes.
 */
async function runMediaBranch<
  TBilling extends { worstCaseCents: number; groupBudget?: unknown },
>(args: {
  input: MediaBranchInputBase;
  lookup: LookupResult<Map<string, number>>;
  reserveBilling: (
    perModel: Map<string, number>
  ) => Promise<({ success: true } & TBilling) | { success: false; response: Response }>;
  runPipeline: (billing: TBilling, release: () => Promise<void>) => Response;
}): Promise<Response> {
  const { input, lookup, reserveBilling, runPipeline } = args;
  if (!lookup.ok) return lookup.response;

  const billing = await reserveBilling(lookup.perModel);
  if (!billing.success) return billing.response;

  const release = resolveReleaseReservation(
    input.c.get('redis'),
    billing.groupBudget as GroupBudgetReservation | undefined,
    input.user,
    billing.worstCaseCents
  );

  return runPipeline(billing, release);
}

async function handleImageStreamRequest(input: ImageBranchInput): Promise<Response> {
  const { memberContext, billingUserId, clientFundingSource, billingResult } = input.billingContext;
  return runMediaBranch({
    input,
    lookup: await lookupImageBranch(input.c, input.models),
    reserveBilling: async (perImageByModel) =>
      resolveAndReserveImageBilling(input.c, {
        billingResult,
        userId: billingUserId,
        models: input.models,
        perImageByModel,
        clientFundingSource,
        ...(memberContext !== undefined && { memberContext }),
        conversationId: input.conversationId,
      }),
    runPipeline: (imageBilling, releaseReservation) =>
      executeImagePipeline({
        c: input.c,
        conversationId: input.conversationId,
        models: input.models,
        treeAction: input.treeAction,
        prompt: input.prompt,
        imageBilling,
        ...(memberContext !== undefined && { memberContext }),
        releaseReservation,
        senderId: input.callerId,
        ...(input.forkId !== undefined && { forkId: input.forkId }),
        ...(input.imageConfig?.aspectRatio !== undefined && {
          aspectRatio: input.imageConfig.aspectRatio,
        }),
      }),
  });
}

async function lookupImageBranch(
  c: Context<AppEnv>,
  models: string[]
): Promise<LookupResult<Map<string, number>>> {
  const { perModelByModel, mismatches, notFound } = await lookupMediaModels(
    c.get('aiClient'),
    models,
    extractImagePrice
  );
  const reject = lookupRejectResponse(c, notFound, mismatches);
  if (reject) return { ok: false, response: reject };
  return { ok: true, perModel: perModelByModel };
}

async function handleVideoStreamRequest(input: VideoBranchInput): Promise<Response> {
  const { memberContext, billingUserId, clientFundingSource, billingResult } = input.billingContext;
  return runMediaBranch({
    input,
    lookup: await lookupVideoBranch(
      input.c,
      input.models,
      input.videoConfig.resolution,
      input.videoConfig.durationSeconds
    ),
    reserveBilling: async (perSecondByModel) =>
      resolveAndReserveVideoBilling(input.c, {
        billingResult,
        userId: billingUserId,
        models: input.models,
        perSecondByModel,
        durationSeconds: input.videoConfig.durationSeconds,
        resolution: input.videoConfig.resolution,
        clientFundingSource,
        ...(memberContext !== undefined && { memberContext }),
        conversationId: input.conversationId,
      }),
    runPipeline: (videoBilling, releaseReservation) =>
      executeVideoPipeline({
        c: input.c,
        conversationId: input.conversationId,
        models: input.models,
        treeAction: input.treeAction,
        prompt: input.prompt,
        videoBilling,
        ...(memberContext !== undefined && { memberContext }),
        releaseReservation,
        senderId: input.callerId,
        ...(input.forkId !== undefined && { forkId: input.forkId }),
        aspectRatio: input.videoConfig.aspectRatio,
      }),
  });
}

async function lookupVideoBranch(
  c: Context<AppEnv>,
  models: string[],
  resolution: string,
  durationSeconds: number
): Promise<LookupResult<Map<string, number>>> {
  const { perModelByModel, mismatches, notFound, unsupportedResolutions } = await lookupMediaModels(
    c.get('aiClient'),
    models,
    buildVideoExtractor(resolution)
  );
  const reject = lookupRejectResponse(c, notFound, mismatches);
  if (reject) return { ok: false, response: reject };
  if (unsupportedResolutions.length > 0) {
    return {
      ok: false,
      response: c.json(
        createErrorResponse(ERROR_CODE_UNSUPPORTED_RESOLUTION, {
          invalidModels: unsupportedResolutions,
          resolution,
        }),
        400
      ),
    };
  }

  // Per-model discrete-duration check. Models without declared capability
  // data (`undefined` from the lookup) are allowed through — they're newer
  // entries the catalog hasn't pinned yet; the gateway is then the
  // authoritative gate. Veo entries always have data so this matches today.
  const invalidDurationModels = models.filter((id) => {
    const supported = getSupportedVideoDurations(id);
    return supported !== undefined && !supported.includes(durationSeconds);
  });
  if (invalidDurationModels.length > 0) {
    return {
      ok: false,
      response: c.json(
        createErrorResponse(ERROR_CODE_UNSUPPORTED_DURATION, {
          invalidModels: invalidDurationModels,
          durationSeconds,
        }),
        400
      ),
    };
  }

  return { ok: true, perModel: perModelByModel };
}

async function handleAudioStreamRequest(input: AudioBranchInput): Promise<Response> {
  const { memberContext, billingUserId, clientFundingSource, billingResult } = input.billingContext;
  return runMediaBranch({
    input,
    lookup: await lookupAudioBranch(input.c, input.models),
    reserveBilling: async (perSecondByModel) =>
      resolveAndReserveAudioBilling(input.c, {
        billingResult,
        userId: billingUserId,
        models: input.models,
        perSecondByModel,
        maxDurationSeconds: input.audioConfig.maxDurationSeconds,
        clientFundingSource,
        ...(memberContext !== undefined && { memberContext }),
        conversationId: input.conversationId,
      }),
    runPipeline: (audioBilling, releaseReservation) =>
      executeAudioPipeline({
        c: input.c,
        conversationId: input.conversationId,
        models: input.models,
        treeAction: input.treeAction,
        prompt: input.prompt,
        audioBilling,
        ...(memberContext !== undefined && { memberContext }),
        releaseReservation,
        senderId: input.callerId,
        ...(input.forkId !== undefined && { forkId: input.forkId }),
        format: input.audioConfig.format,
        ...(input.audioConfig.voice !== undefined && { voice: input.audioConfig.voice }),
      }),
  });
}

async function lookupAudioBranch(
  c: Context<AppEnv>,
  models: string[]
): Promise<LookupResult<Map<string, number>>> {
  const { perModelByModel, mismatches, notFound } = await lookupMediaModels(
    c.get('aiClient'),
    models,
    extractAudioPrice
  );
  const reject = lookupRejectResponse(c, notFound, mismatches);
  if (reject) return { ok: false, response: reject };
  return { ok: true, perModel: perModelByModel };
}

interface TextBranchInput {
  c: Context<AppEnv>;
  conversationId: string;
  callerId: string;
  user: AppEnv['Variables']['user'];
  billingContext: BillingContext;
  models: string[];
  treeAction: TreeAction;
  messagesForInference: InferenceMessage[];
  forkId: string | undefined;
  webSearchEnabled: boolean;
  customInstructions: string | undefined;
}

async function handleTextStreamRequest(input: TextBranchInput): Promise<Response> {
  const {
    c,
    conversationId,
    callerId,
    user,
    billingContext,
    models,
    treeAction,
    messagesForInference,
    forkId,
    webSearchEnabled,
    customInstructions,
  } = input;
  const { memberContext, billingUserId, clientFundingSource, billingResult } = billingContext;
  const redis = c.get('redis');

  const billingValidation = await resolveAndReserveBilling(c, {
    billingResult,
    userId: billingUserId,
    models,
    messagesForInference,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    conversationId,
    webSearchEnabled,
    ...(customInstructions !== undefined && { customInstructions }),
  });
  if (!billingValidation.success) {
    return billingValidation.response;
  }

  const { worstCaseCents, groupBudget } = billingValidation;
  const releaseReservation = resolveReleaseReservation(redis, groupBudget, user, worstCaseCents);

  return executeStreamPipeline({
    c,
    conversationId,
    models,
    treeAction,
    messagesForInference,
    billingValidation,
    ...(memberContext !== undefined && { memberContext }),
    webSearchEnabled,
    ...(customInstructions !== undefined && { customInstructions }),
    releaseReservation,
    senderId: callerId,
    ...(forkId !== undefined && { forkId }),
  });
}

interface BillingContext {
  memberContext: MemberContext | undefined;
  billingUserId: string;
  clientFundingSource: FundingSource;
  billingResult: Awaited<ReturnType<typeof buildBillingInput>>;
}

async function resolveGuestBillingContext(
  db: AppEnv['Variables']['db'],
  redis: AppEnv['Variables']['redis'],
  params: {
    member: { id: string };
    ownerId: string;
    models: string[];
    conversationId: string;
    processedCatalog: ReturnType<typeof getProcessedCatalog>;
  }
): Promise<BillingContext> {
  const billingResult = await buildGuestBillingInput(db, redis, {
    ownerId: params.ownerId,
    memberId: params.member.id,
    models: params.models,
    conversationId: params.conversationId,
    processedCatalog: params.processedCatalog,
  });
  return {
    memberContext: { memberId: params.member.id, ownerId: params.ownerId },
    billingUserId: params.ownerId,
    clientFundingSource: 'owner_balance',
    billingResult,
  };
}

async function resolveUserBillingContext(
  db: AppEnv['Variables']['db'],
  redis: AppEnv['Variables']['redis'],
  params: {
    callerId: string;
    ownerId: string;
    member: { id: string };
    models: string[];
    conversationId: string;
    fundingSource: FundingSource;
    processedCatalog: ReturnType<typeof getProcessedCatalog>;
  }
): Promise<BillingContext> {
  const isOwner = params.callerId === params.ownerId;
  const memberContext: MemberContext | undefined = isOwner
    ? undefined
    : { memberId: params.member.id, ownerId: params.ownerId };
  const billingResult = await buildBillingInput(db, redis, {
    userId: params.callerId,
    models: params.models,
    ...(memberContext !== undefined && { memberContext }),
    conversationId: params.conversationId,
    processedCatalog: params.processedCatalog,
  });
  return {
    memberContext,
    billingUserId: params.callerId,
    clientFundingSource: params.fundingSource,
    billingResult,
  };
}

/** Resolves fork tip message ID. Returns null if fork doesn't exist, undefined if no forkId. */
async function resolveForkTipMessageId(
  db: AppEnv['Variables']['db'],
  forkId: string | undefined
): Promise<string | null | undefined> {
  if (!forkId) return undefined;

  const [fork] = await db
    .select({ tipMessageId: conversationForks.tipMessageId })
    .from(conversationForks)
    .where(eq(conversationForks.id, forkId));

  if (!fork) return null;
  return fork.tipMessageId ?? undefined;
}

interface DispatchModalityInput {
  modality: LegacyModality;
  c: Context<AppEnv>;
  conversationId: string;
  callerId: string;
  user: AppEnv['Variables']['user'];
  billingContext: BillingContext;
  models: string[];
  treeAction: TreeAction;
  prompt: string;
  messagesForInference: InferenceMessage[];
  forkId: string | undefined;
  webSearchEnabled: boolean;
  customInstructions: string | undefined;
  imageConfig: ImageConfig | undefined;
  videoConfig: VideoConfig | undefined;
  audioConfig: AudioConfig | undefined;
}

/** Dispatches a stream request to the modality-specific handler. */
export async function dispatchModalityRequest(input: DispatchModalityInput): Promise<Response> {
  // `getStrategy` owns the canonical LegacyModality switch with an `assertNever`
  // exhaustiveness guard. Calling it here is the runtime gate against rogue
  // values that bypass strict typing (e.g. test casts). The dispatch switch
  // below has no `default` because every LegacyModality case returns; adding a new
  // modality fails typecheck in BOTH places.
  getStrategy(input.modality);
  switch (input.modality) {
    case 'image': {
      return handleImageStreamRequest({
        c: input.c,
        conversationId: input.conversationId,
        callerId: input.callerId,
        user: input.user,
        billingContext: input.billingContext,
        models: input.models,
        treeAction: input.treeAction,
        prompt: input.prompt,
        forkId: input.forkId,
        imageConfig: input.imageConfig,
      });
    }
    case 'video': {
      if (!input.videoConfig) {
        throw new Error('invariant: videoConfig required for video modality');
      }
      return handleVideoStreamRequest({
        c: input.c,
        conversationId: input.conversationId,
        callerId: input.callerId,
        user: input.user,
        billingContext: input.billingContext,
        models: input.models,
        treeAction: input.treeAction,
        prompt: input.prompt,
        forkId: input.forkId,
        videoConfig: input.videoConfig,
      });
    }
    case 'audio': {
      if (!input.audioConfig) {
        throw new Error('invariant: audioConfig required for audio modality');
      }
      return handleAudioStreamRequest({
        c: input.c,
        conversationId: input.conversationId,
        callerId: input.callerId,
        user: input.user,
        billingContext: input.billingContext,
        models: input.models,
        treeAction: input.treeAction,
        prompt: input.prompt,
        forkId: input.forkId,
        audioConfig: input.audioConfig,
      });
    }
    case 'text': {
      return handleTextStreamRequest({
        c: input.c,
        conversationId: input.conversationId,
        callerId: input.callerId,
        user: input.user,
        billingContext: input.billingContext,
        models: input.models,
        treeAction: input.treeAction,
        messagesForInference: input.messagesForInference,
        forkId: input.forkId,
        webSearchEnabled: input.webSearchEnabled,
        customInstructions: input.customInstructions,
      });
    }
  }
}

interface StreamRequestGatesParams {
  c: Context<AppEnv>;
  modality: 'text' | 'image' | 'video' | 'audio';
  linkGuest: AppEnv['Variables']['linkGuest'];
  callerId: string;
  ownerId: string;
  models: string[];
  messagesForInference: InferenceMessage[];
}

/**
 * Tier gate: free/trial/guest users picking a premium model get a dedicated
 * 403 + MODEL_TIER_LOCKED so the UI can render an "upgrade your account"
 * message rather than the balance-focused PREMIUM_REQUIRES_BALANCE that fires
 * later in handleBillingDenial.
 *
 * Only applied to direct-billing requests (caller is conversation owner, not
 * a link guest). Group-billed and link-guest paths defer model-access
 * decisions to `resolveBilling`, which evaluates the OWNER's tier — those
 * paths still surface PREMIUM_REQUIRES_BALANCE / GROUP_BUDGET_EXHAUSTED via
 * `handleBillingDenial`.
 */
interface TierLockParams {
  c: Context<AppEnv>;
  linkGuest: AppEnv['Variables']['linkGuest'];
  callerId: string;
  ownerId: string;
  models: string[];
}

async function enforceTierLock(params: TierLockParams): Promise<Response | null> {
  const { c, linkGuest, callerId, ownerId, models } = params;
  const isDirectBilling = !linkGuest && callerId === ownerId;
  if (!isDirectBilling) return null;
  const lockedModel = await findTierLockedModel(c, models, callerId);
  if (lockedModel === null) return null;
  return c.json(createErrorResponse(ERROR_CODE_MODEL_TIER_LOCKED, { modelId: lockedModel }), 403);
}

/**
 * Runs all preconditions for POST /:conversationId/stream and returns the
 * matching error response if any gate fails. Returns null when every gate
 * passes so the caller can proceed to billing resolution and dispatch.
 *
 * Gates (in order):
 *   - last message is user-authored (LAST_MESSAGE_NOT_USER, 400)
 *   - link guests can't request media generation (MEDIA_TRIAL_BLOCKED, 403)
 *   - audio modality respects FEATURE_FLAGS.AUDIO_ENABLED (AUDIO_DISABLED, 503)
 *   - direct-billing callers can't pick a premium model their tier locks
 *     (MODEL_TIER_LOCKED, 403) — see {@link enforceTierLock}.
 */
async function validateStreamRequestGates(
  params: StreamRequestGatesParams
): Promise<Response | null> {
  const { c, modality, linkGuest, callerId, ownerId, models, messagesForInference } = params;

  if (!validateLastMessageIsFromUser(messagesForInference)) {
    return c.json(createErrorResponse(ERROR_CODE_LAST_MESSAGE_NOT_USER), 400);
  }

  const isMediaModality = modality === 'image' || modality === 'video' || modality === 'audio';
  if (isMediaModality && linkGuest) {
    return c.json(createErrorResponse(ERROR_CODE_MEDIA_TRIAL_BLOCKED), 403);
  }

  // Audio is dead-coded behind FEATURE_FLAGS.AUDIO_ENABLED until the AI
  // Gateway ships speech-model support. 503 (Service Unavailable) is the
  // right code: the request is well-formed; the feature is temporarily
  // off and will return when the gateway adds speech support.
  if (modality === 'audio' && !FEATURE_FLAGS.AUDIO_ENABLED) {
    return c.json(createErrorResponse(ERROR_CODE_AUDIO_DISABLED), 503);
  }

  return enforceTierLock({ c, linkGuest, callerId, ownerId, models });
}

const conversationIdParameterSchema = z.object({ conversationId: z.string().min(1) });

export const chatRoute = new Hono<AppEnv>()

  .post(
    '/:conversationId/stream',
    zValidator('param', conversationIdParameterSchema),
    zValidator('json', streamChatRequestSchema),
    requirePrivilege('write', { allowLinkGuest: true, includeOwnerId: true }),
    rateLimitByCaller('chatStreamUserRateLimit'),

    async (c) => {
      const { conversationId } = c.req.param();
      const callerId = c.get('callerId');
      const member = getMember(c, conversationId);
      const linkGuest = c.get('linkGuest');
      const ownerId = c.get('conversationOwnerId');
      const db = c.get('db');
      const redis = c.get('redis');

      const {
        modality,
        models,
        userMessage,
        messagesForInference,
        fundingSource,
        webSearchEnabled = false,
        customInstructions,
        forkId,
        imageConfig,
        videoConfig,
        audioConfig,
      } = c.req.valid('json');

      const gateError = await validateStreamRequestGates({
        c,
        modality,
        linkGuest,
        callerId,
        ownerId,
        models,
        messagesForInference,
      });
      if (gateError) return gateError;

      const billingContext = linkGuest
        ? await resolveGuestBillingContext(db, redis, {
            member,
            ownerId,
            models,
            conversationId,
            processedCatalog: getProcessedCatalog(c),
          })
        : await resolveUserBillingContext(db, redis, {
            callerId,
            ownerId,
            member,
            models,
            conversationId,
            fundingSource,
            processedCatalog: getProcessedCatalog(c),
          });
      const user = c.get('user');

      const parentMessageId = await resolveParentMessageId(db, conversationId, forkId);

      return dispatchModalityRequest({
        modality,
        c,
        conversationId,
        callerId,
        user,
        billingContext,
        models,
        treeAction: { kind: 'fresh-send', userMessage, parentMessageId },
        prompt: userMessage.content,
        messagesForInference,
        forkId,
        webSearchEnabled,
        customInstructions,
        imageConfig,
        videoConfig,
        audioConfig,
      });
    }
  )
  .post(
    '/:conversationId/message',
    zValidator('param', conversationIdParameterSchema),
    zValidator('json', userOnlyMessageSchema),
    requirePrivilege('write', { includeOwnerId: true }),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const { conversationId } = c.req.param();
      const { messageId, content } = c.req.valid('json');
      const db = c.get('db');

      const parentMessageId = await resolveParentMessageId(db, conversationId);

      // Save message — free, no billing. A retry that hits the same messageId
      // surfaces 409 instead of crashing on the PK collision; a concurrent
      // writer that advanced the (conversation, sequence) pair surfaces 409
      // via the unique index. Either way, the client should refresh.
      let result;
      try {
        result = await saveUserOnlyMessage(db, {
          conversationId,
          userId: user.id,
          senderId: user.id,
          messageId,
          content,
          parentMessageId,
        });
      } catch (error) {
        if (error instanceof ForkTipConflictError) {
          return c.json(createErrorResponse(ERROR_CODE_FORK_TIP_CONFLICT), 409);
        }
        if (isUniqueViolation(error)) {
          return c.json(createErrorResponse(ERROR_CODE_DUPLICATE_MESSAGE), 409);
        }
        throw error;
      }

      broadcastFireAndForget(
        c.env,
        conversationId,
        createEvent('message:new', {
          messageId,
          conversationId,
          senderType: 'user',
          senderId: user.id,
        }),
        safeExecutionCtx(c)
      );

      fireAndForget(
        sendPushForNewMessage({
          db,
          pushClient: getPushClient(c.env),
          conversationId,
          senderUserId: user.id,
          title: 'New Message',
          body: 'You have a new message',
        }),
        'send push notifications for user message',
        safeExecutionCtx(c)
      );

      return c.json({
        messageId,
        sequenceNumber: result.sequenceNumber,
        epochNumber: result.epochNumber,
      });
    }
  )

  .post(
    '/:conversationId/regenerate',
    zValidator('param', conversationIdParameterSchema),
    zValidator('json', regenerateRequestSchema),
    requirePrivilege('write', { includeOwnerId: true }),
    rateLimitByCaller('chatStreamUserRateLimit'),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const { conversationId } = c.req.param();
      const db = c.get('db');
      const redis = c.get('redis');

      const requestBody = c.req.valid('json');
      const { targetMessageId, action, modality, models, replaceAssistantId, userMessage, forkId } =
        requestBody;

      const gateOutcome = await runRegenerateGates({
        c,
        db,
        userId: user.id,
        conversationId,
        targetMessageId,
        modality,
        models,
        messagesForInference: requestBody.messagesForInference,
        forkId,
      });
      if ('errorResponse' in gateOutcome) return gateOutcome.errorResponse;

      const treeAction = buildRegenerateTreeAction({
        action,
        targetMessageId,
        newUserMessage: userMessage,
        replaceAssistantId,
        forkId,
        forkTipMessageId: gateOutcome.forkTipMessageId,
      });

      const billingContext = await resolveUserBillingContext(db, redis, {
        callerId: user.id,
        ownerId: c.get('conversationOwnerId'),
        member: getMember(c, conversationId),
        models,
        conversationId,
        fundingSource: requestBody.fundingSource,
        processedCatalog: getProcessedCatalog(c),
      });

      return dispatchModalityRequest({
        modality,
        c,
        conversationId,
        callerId: user.id,
        user,
        billingContext,
        models,
        treeAction,
        prompt: userMessage.content,
        messagesForInference: requestBody.messagesForInference,
        forkId,
        webSearchEnabled: requestBody.webSearchEnabled ?? false,
        customInstructions: requestBody.customInstructions,
        imageConfig: requestBody.imageConfig,
        videoConfig: requestBody.videoConfig,
        audioConfig: requestBody.audioConfig,
      });
    }
  );

interface RunRegenerateGatesParams {
  c: Context<AppEnv>;
  db: AppEnv['Variables']['db'];
  userId: string;
  conversationId: string;
  targetMessageId: string;
  modality: LegacyModality;
  models: string[];
  messagesForInference: InferenceMessage[];
  forkId: string | undefined;
}

type RunRegenerateGatesOutcome =
  | { errorResponse: Response }
  | { forkTipMessageId: string | undefined };

async function runRegenerateGates(
  params: RunRegenerateGatesParams
): Promise<RunRegenerateGatesOutcome> {
  const { c, db, userId, conversationId, targetMessageId, modality, models, forkId } = params;

  const gateError = validateRegenerateGates({
    c,
    modality,
    models,
    messagesForInference: params.messagesForInference,
  });
  if (gateError) return { errorResponse: gateError };

  const forkTipMessageId = await resolveForkTipMessageId(db, forkId);
  if (forkTipMessageId === null) {
    return { errorResponse: c.json(createErrorResponse(ERROR_CODE_FORK_NOT_FOUND), 404) };
  }

  const allowed = await canRegenerate(db, {
    conversationId,
    targetMessageId,
    userId,
    ...(forkTipMessageId !== undefined && { forkTipMessageId }),
  });
  if (!allowed) {
    return {
      errorResponse: c.json(
        createErrorResponse(ERROR_CODE_REGENERATION_BLOCKED_BY_OTHER_USER),
        403
      ),
    };
  }

  return { forkTipMessageId };
}

interface BuildRegenerateTreeActionParams {
  action: 'retry' | 'edit';
  targetMessageId: string;
  newUserMessage: { id: string; content: string };
  replaceAssistantId: string | undefined;
  forkId: string | undefined;
  forkTipMessageId: string | undefined;
}

/**
 * 'retry' keeps the anchor user message and swaps the AI reply(s); 'edit'
 * replaces the user message too. `replaceAssistantId` (retry only)
 * discriminates retry-all from regenerate-one — see TreeAction docstring for
 * the deletion semantics that follow from each.
 *
 * Passing `forkId` makes applyTreeAction lock the fork row up-front
 * (SELECT FOR UPDATE) and validate the expected tip atomically. Without
 * this, our own delete cascade would null the tip mid-transaction and
 * the downstream optimistic UPDATE in updateForkTip would mismatch and
 * throw ForkTipConflictError on every regenerate that targets a fork
 * tip message.
 */
function buildRegenerateTreeAction(params: BuildRegenerateTreeActionParams): TreeAction {
  const { action, targetMessageId, newUserMessage, replaceAssistantId, forkId, forkTipMessageId } =
    params;
  const forkSpread = {
    ...(forkId !== undefined && { forkId }),
    ...(forkTipMessageId !== undefined && { forkTipMessageId }),
  };
  if (action === 'edit') {
    return {
      kind: 'edit',
      anchorUserMessageId: targetMessageId,
      newUserMessage,
      ...forkSpread,
    };
  }
  return {
    kind: 'regenerate',
    anchorUserMessageId: targetMessageId,
    ...(replaceAssistantId !== undefined && { replaceAssistantId }),
    ...forkSpread,
  };
}

interface RegenerateGatesParams {
  c: Context<AppEnv>;
  modality: LegacyModality;
  models: string[];
  messagesForInference: InferenceMessage[];
}

/**
 * Mirrors {@link validateStreamRequestGates} but skips the premium tier
 * lock — the user already chose this model when the original message was
 * sent, so re-blocking on tier here would be surprising.
 */
function validateRegenerateGates(params: RegenerateGatesParams): Response | null {
  const { c, modality, messagesForInference } = params;

  if (modality === 'text' && !validateLastMessageIsFromUser(messagesForInference)) {
    return c.json(createErrorResponse(ERROR_CODE_LAST_MESSAGE_NOT_USER), 400);
  }

  if (modality === 'audio' && !FEATURE_FLAGS.AUDIO_ENABLED) {
    return c.json(createErrorResponse(ERROR_CODE_AUDIO_DISABLED), 503);
  }

  return null;
}
