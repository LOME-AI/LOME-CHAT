import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import {
  ERROR_CODE_VALIDATION,
  ERROR_CODE_DAILY_LIMIT_EXCEEDED,
  ERROR_CODE_PREMIUM_REQUIRES_ACCOUNT,
  ERROR_CODE_AUTHENTICATED_ON_TRIAL,
  ERROR_CODE_TRIAL_MESSAGE_TOO_EXPENSIVE,
  ERROR_CODE_STREAM_ERROR,
  ERROR_CODE_FEATURE_REQUIRES_AUTH,
  SMART_MODEL_ID,
  calculateBudget,
  resolveBilling,
  buildSystemPrompt,
} from '@hushbox/shared';
import { getProcessedCatalog } from '../lib/processed-catalog.js';
import { buildPrompt } from '../services/prompt/builder.js';
import { consumeTrialMessage } from '../services/billing/index.js';
import { validateLastMessageIsFromUser, buildAIMessages } from '../services/chat/index.js';
import { computeSafeMaxTokens } from '../services/chat/max-tokens.js';
import { createErrorResponse } from '../lib/error-response.js';
import { createSSEEventWriter } from '../lib/stream-handler.js';
import {
  lookupModelPricing,
  buildSmartModelResolution,
  computeMaxEligibleFees,
  extractConversationContextForClassifier,
} from '../lib/stream-pipeline.js';
import { resolveStagesForSlot, executePreInferenceChain } from '../lib/pre-inference/index.js';
import { textStrategy } from '../lib/modality-strategies.js';
import { hashIp, getClientIp } from '../lib/client-ip.js';
import { rateLimitByIp } from '../middleware/rate-limit.js';
import type { SmartModelResolution } from '../lib/stream-pipeline.js';
import type { SSEEventWriter } from '../lib/stream-handler.js';
import type { AppEnv } from '../types.js';
import type { Model, ModelPricingResult } from '@hushbox/shared';
import type { RawModel } from '@hushbox/shared/models';
import type { Context } from 'hono';

interface TrialMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TrialValidationSuccess {
  success: true;
  usageCheck: Awaited<ReturnType<typeof consumeTrialMessage>>;
  safeMaxTokens: number | undefined;
  budgetResult: ReturnType<typeof calculateBudget>;
  /** Present only when the trial user selected Smart Model. */
  smartModelResolution?: SmartModelResolution;
}

interface TrialValidationFailure {
  success: false;
  response: Response;
}

type TrialQuotaResult =
  | { allowed: true; usageCheck: Awaited<ReturnType<typeof consumeTrialMessage>> }
  | { allowed: false; errorResponse: Response };

async function checkTrialQuota(
  c: Context<AppEnv>,
  trialToken: string | null,
  ipHash: string
): Promise<TrialQuotaResult> {
  const redis = c.get('redis');
  const usageCheck = await consumeTrialMessage(redis, trialToken, ipHash);

  if (!usageCheck.canSend) {
    return {
      allowed: false,
      errorResponse: c.json(
        createErrorResponse(ERROR_CODE_DAILY_LIMIT_EXCEEDED, {
          limit: usageCheck.limit,
          remaining: 0,
        }),
        429
      ),
    };
  }

  return { allowed: true, usageCheck };
}

function checkTrialModelAccess(
  c: Context<AppEnv>,
  model: string,
  premiumIds: string[]
): Response | null {
  if (premiumIds.includes(model)) {
    return c.json(createErrorResponse(ERROR_CODE_PREMIUM_REQUIRES_ACCOUNT), 403);
  }
  return null;
}

type TrialBudgetResult =
  | {
      allowed: true;
      budgetResult: ReturnType<typeof calculateBudget>;
      safeMaxTokens: number | undefined;
    }
  | { allowed: false; errorResponse: Response };

/** Total prompt characters a trial turn bills for: empty-instruction system prompt + history. */
function trialPromptCharacterCount(messages: TrialMessage[]): number {
  return buildSystemPrompt([]).length + messages.reduce((sum, m) => sum + m.content.length, 0);
}

function calculateTrialBudget(
  c: Context<AppEnv>,
  messages: TrialMessage[],
  pricing: ModelPricingResult
): TrialBudgetResult {
  const promptCharacterCount = trialPromptCharacterCount(messages);

  const budgetResult = calculateBudget({
    tier: 'trial',
    balanceCents: 0,
    freeAllowanceCents: 0,
    promptCharacterCount,
    models: [
      {
        modelInputPricePerToken: pricing.inputPricePerToken,
        modelOutputPricePerToken: pricing.outputPricePerToken,
        contextLength: pricing.contextLength,
      },
    ],
  });

  const estimatedMinimumCostCents = Math.ceil(budgetResult.estimatedMinimumCost * 100);
  const billingResult = resolveBilling({
    tier: 'trial',
    balanceCents: 0,
    freeAllowanceCents: 0,
    isPremiumModel: false, // Premium already gated by checkTrialModelAccess()
    estimatedMinimumCostCents,
  });

  if (billingResult.fundingSource === 'denied') {
    return {
      allowed: false,
      errorResponse: c.json(createErrorResponse(ERROR_CODE_TRIAL_MESSAGE_TOO_EXPENSIVE), 402),
    };
  }

  const safeMaxTokens = computeSafeMaxTokens({
    budgetMaxTokens: budgetResult.maxOutputTokens,
    modelContextLength: pricing.contextLength,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
  });

  return { allowed: true, budgetResult, safeMaxTokens };
}

async function validateTrialRequest(
  c: Context<AppEnv>,
  messages: TrialMessage[],
  model: string
): Promise<TrialValidationSuccess | TrialValidationFailure> {
  const session = c.get('session');
  if (session) {
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_AUTHENTICATED_ON_TRIAL), 400),
    };
  }

  if (!validateLastMessageIsFromUser(messages)) {
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_VALIDATION), 400),
    };
  }

  const trialToken = c.req.header('x-trial-token') ?? null;
  const ipHash = hashIp(getClientIp(c));

  const quotaResult = await checkTrialQuota(c, trialToken, ipHash);
  if (!quotaResult.allowed) {
    return { success: false, response: quotaResult.errorResponse };
  }

  const [allModels, { models: poolModels, premiumIds }] = await Promise.all([
    c.var.aiClient.listRawModels(),
    getProcessedCatalog(c),
  ]);

  const modelError = checkTrialModelAccess(c, model, premiumIds);
  if (modelError) {
    return { success: false, response: modelError };
  }

  if (model === SMART_MODEL_ID) {
    return validateTrialSmartModel(c, messages, quotaResult.usageCheck, {
      gatewayModels: allModels,
      poolModels,
      premiumIds: new Set(premiumIds),
    });
  }

  const pricing = lookupModelPricing(allModels, model);
  const budgetCheck = calculateTrialBudget(c, messages, pricing);
  if (!budgetCheck.allowed) {
    return { success: false, response: budgetCheck.errorResponse };
  }

  return {
    success: true,
    usageCheck: quotaResult.usageCheck,
    safeMaxTokens: budgetCheck.safeMaxTokens,
    budgetResult: budgetCheck.budgetResult,
  };
}

/**
 * Promote the trial Smart Model selection to a concrete eligible set through
 * the same resolver the authenticated path uses ({@link buildSmartModelResolution}),
 * priced at the worst-case eligible model so the trial budget covers whichever
 * model the classifier picks at stream time. The classifier itself runs inside
 * the SSE stream (it emits stage events); this only sizes the budget and
 * guarantees at least one eligible model exists.
 */
function validateTrialSmartModel(
  c: Context<AppEnv>,
  messages: TrialMessage[],
  usageCheck: Awaited<ReturnType<typeof consumeTrialMessage>>,
  catalog: { gatewayModels: RawModel[]; poolModels: Model[]; premiumIds: ReadonlySet<string> }
): TrialValidationSuccess | TrialValidationFailure {
  const promptCharacterCount = trialPromptCharacterCount(messages);

  const smartModelResolution = buildSmartModelResolution({
    poolModels: catalog.poolModels,
    premiumIds: catalog.premiumIds,
    gatewayModels: catalog.gatewayModels,
    payerTier: 'trial',
    payerBalanceCents: 0,
    payerFreeAllowanceCents: 0,
    promptCharacterCount,
  });

  if (smartModelResolution === null) {
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_TRIAL_MESSAGE_TOO_EXPENSIVE), 402),
    };
  }

  const budgetCheck = calculateTrialBudget(
    c,
    messages,
    smartModelPricing(catalog.poolModels, smartModelResolution)
  );
  if (!budgetCheck.allowed) {
    return { success: false, response: budgetCheck.errorResponse };
  }

  return {
    success: true,
    usageCheck,
    safeMaxTokens: budgetCheck.safeMaxTokens,
    budgetResult: budgetCheck.budgetResult,
    smartModelResolution,
  };
}

/**
 * Worst-case Smart Model pricing: max per-token fees across the eligible pool
 * (the budget must absorb whichever model the classifier picks) paired with the
 * Smart Model entry's own context length. Mirrors `applySmartModelPricingOverride`
 * on the authenticated path.
 */
function smartModelPricing(
  poolModels: Model[],
  resolution: SmartModelResolution
): ModelPricingResult {
  const { maxInputFee, maxOutputFee } = computeMaxEligibleFees(
    poolModels,
    resolution.eligibleInferenceIds
  );
  const smartEntry = poolModels.find((m) => m.id === SMART_MODEL_ID);
  if (!smartEntry) {
    throw new Error('invariant: Smart Model entry missing from processed catalog');
  }
  return {
    inputPricePerToken: maxInputFee,
    outputPricePerToken: maxOutputFee,
    contextLength: smartEntry.contextLength,
  };
}

interface ResolveTrialModelArgs {
  model: string;
  smartModelResolution: SmartModelResolution | undefined;
  messages: TrialMessage[];
  aiClient: AppEnv['Variables']['aiClient'];
  writer: SSEEventWriter;
  assistantMessageId: string;
}

/**
 * Resolve the model the inference call will use. For Smart Model this runs the
 * exact pre-inference chain the authenticated path runs ({@link resolveStagesForSlot}
 * + {@link executePreInferenceChain}), which makes the classifier call and emits
 * its stage events on `writer`. Every other model resolves to itself.
 */
async function resolveTrialModel(args: ResolveTrialModelArgs): Promise<string> {
  const { model, smartModelResolution, messages, aiClient, writer, assistantMessageId } = args;
  if (smartModelResolution === undefined) return model;

  const conversationContext = extractConversationContextForClassifier(messages);
  const stages = resolveStagesForSlot({
    modality: 'text',
    selectedModelId: model,
    smartModelResolution: { ...smartModelResolution, conversationContext },
  });
  const chainResult = await executePreInferenceChain({
    stages,
    aiClient,
    writer,
    assistantMessageId,
  });
  // Forward-compat guard: today's only stage (Smart Model) always degrades to a
  // fallback rather than failing the chain, so this is unreachable now; a future
  // stage that can hard-fail surfaces here as a stream error.
  if (!chainResult.ok) {
    throw new Error(`Pre-inference stage failed: ${chainResult.errorCode}`);
  }
  return chainResult.transformation.resolvedModelId ?? model;
}

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const trialStreamRequestSchema = z.object({
  messages: z.array(messageSchema).min(1),
  model: z.string(),
  webSearchEnabled: z.boolean().optional(),
});

export const trialChatRoute = new Hono<AppEnv>().post(
  '/stream',
  rateLimitByIp('trialChatStreamIpRateLimit'),
  zValidator('json', trialStreamRequestSchema),
  async (c) => {
    const { messages, model, webSearchEnabled } = c.req.valid('json');
    const aiClient = c.get('aiClient');

    // Defense-in-depth: trial users have no reserved budget for the search
    // tool cap, so reject hand-crafted requests that try to enable it. The
    // frontend already gates this for trial users.
    if (webSearchEnabled === true) {
      return c.json(createErrorResponse(ERROR_CODE_FEATURE_REQUIRES_AUTH), 403);
    }

    const validation = await validateTrialRequest(c, messages, model);
    if (!validation.success) {
      return validation.response;
    }
    const { safeMaxTokens, smartModelResolution } = validation;

    const assistantMessageId = crypto.randomUUID();

    return streamSSE(c, async (stream) => {
      const writer = createSSEEventWriter(stream);

      await writer.writeStart({
        userMessageId: crypto.randomUUID(),
        models: [{ modelId: model, assistantMessageId }],
      });

      let streamError: Error | null = null;

      try {
        // Smart Model resolves to a concrete model through the same
        // pre-inference stage the authenticated path runs (it emits its own
        // classifier stage events on `writer`); every other model passes
        // through untouched. The SSE key stays the user-facing `model`; only
        // the inference call uses the resolved id.
        const resolvedModelId = await resolveTrialModel({
          model,
          smartModelResolution,
          messages,
          aiClient,
          writer,
          assistantMessageId,
        });

        const { systemPrompt } = buildPrompt({
          modelId: resolvedModelId,
          supportedCapabilities: [],
        });
        const aiMessages = buildAIMessages(systemPrompt, messages);

        const inferenceStream = aiClient.stream(
          textStrategy.buildRequest({
            modelId: resolvedModelId,
            messages: aiMessages,
            ...(safeMaxTokens !== undefined && { maxOutputTokens: safeMaxTokens }),
          })
        );

        for await (const event of inferenceStream) {
          if (event.kind === 'text-delta' && event.content.length > 0) {
            await writer.writeModelToken({ modelId: model, content: event.content });
          }
        }
      } catch (error) {
        streamError = error instanceof Error ? error : new Error('Unknown error');
      }

      if (streamError) {
        await writer.writeError({ message: streamError.message, code: ERROR_CODE_STREAM_ERROR });
      } else {
        await writer.writeDone();
      }
    });
  }
);
