import {
  buildClassifierMessages,
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  resolveClassifierOutput,
  truncateForClassifier,
  type TruncationInput,
} from '@hushbox/shared';

import type { TextRequest } from '../../services/ai/index.js';

import type { PreInferenceRunArgs, PreInferenceStage } from './types.js';
import type { PreInferenceBilling, PreInferenceOutcome } from '@hushbox/shared';

export interface SmartModelStageConfig {
  /** Cheapest eligible text model — used to make the classifier call. */
  classifierModelId: string;
  /** Models the classifier may resolve to — already filtered by tier and budget. */
  eligibleInferenceIds: readonly string[];
  /** Worst-case classifier cost in cents (with fees) for budget reservation. */
  classifierWorstCaseCents: number;
  /** Lookup for the model name + description used in the classifier prompt and SSE done payload. */
  modelMetadataById: ReadonlyMap<string, { name: string; description: string }>;
  /** Most recent user + assistant message used as the classifier's context. */
  conversationContext: TruncationInput;
}

/**
 * Concrete pre-inference stage that picks one model from a pre-filtered
 * eligible list by asking the cheapest-eligible model to act as a router.
 *
 * Short-circuit: when only one model is eligible, the classifier call is
 * skipped entirely — no billing, no waste — and the slot resolves directly
 * to that one id.
 *
 * Failure modes (classifier throws, no generationId, garbage output) all
 * fall back to the cheapest eligible model (`classifierModelId`). The user
 * still pays for the failed classifier attempt when one was made; we degrade
 * gracefully rather than aborting the slot.
 */
export function createSmartModelStage(config: SmartModelStageConfig): PreInferenceStage {
  return {
    id: 'smart-model',
    reserveCents: () => config.classifierWorstCaseCents,
    run: (args) => runSmartModelStage(config, args),
  };
}

function buildClassifierRequest(config: SmartModelStageConfig): {
  request: TextRequest;
  messages: ReturnType<typeof buildClassifierMessages>;
} {
  const eligibleWithDescriptions = config.eligibleInferenceIds.map((id) => ({
    id,
    description: config.modelMetadataById.get(id)?.description ?? '',
  }));
  const messages = buildClassifierMessages({
    truncatedContext: truncateForClassifier(config.conversationContext),
    eligibleModels: eligibleWithDescriptions,
  });
  const request: TextRequest = {
    modality: 'text',
    model: config.classifierModelId,
    messages,
    maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP,
  };
  return { request, messages };
}

interface ClassifierStreamResult {
  outputText: string;
  generationId: string | null;
}

async function consumeClassifierStream(
  aiClient: PreInferenceRunArgs['aiClient'],
  request: TextRequest
): Promise<ClassifierStreamResult> {
  let outputText = '';
  let generationId: string | null = null;
  for await (const event of aiClient.stream(request)) {
    if (event.kind === 'text-delta') {
      outputText += event.content;
    } else if (event.kind === 'finish') {
      generationId = event.providerMetadata?.generationId ?? null;
    }
  }
  return { outputText, generationId };
}

async function runSmartModelStage(
  config: SmartModelStageConfig,
  args: PreInferenceRunArgs
): Promise<PreInferenceOutcome> {
  const { aiClient, writer, assistantMessageId } = args;

  await writer.writeStageStart({ stageId: 'smart-model', assistantMessageId });

  // Single-eligible short-circuit: skip the classifier entirely — no billing.
  if (config.eligibleInferenceIds.length === 1) {
    const [onlyId] = config.eligibleInferenceIds;
    if (onlyId === undefined) throw new Error('invariant: eligibleInferenceIds[0] missing');
    return resolveOk({
      config,
      writer,
      assistantMessageId,
      resolvedId: onlyId,
      billing: null,
      fallbackOccurred: false,
    });
  }

  const { request, messages } = buildClassifierRequest(config);
  const fallbackId = config.classifierModelId;

  let result: ClassifierStreamResult;
  try {
    result = await consumeClassifierStream(aiClient, request);
  } catch (error) {
    // Throw → no generationId, nothing to bill. Fall back to cheapest eligible.
    // Preserve the upstream cause for Sentry/dev logs so the failure isn't
    // silently swallowed; downstream still degrades gracefully.
    console.error('Smart Model classifier failed', error);
    return resolveOk({
      config,
      writer,
      assistantMessageId,
      resolvedId: fallbackId,
      billing: null,
      fallbackOccurred: true,
    });
  }

  // Build the billing breadcrumb if we got a generationId — the call cost
  // something whether or not the output was usable.
  const billing: PreInferenceBilling | null =
    result.generationId === null
      ? null
      : {
          stageId: 'smart-model',
          modelId: config.classifierModelId,
          generationId: result.generationId,
          inputContent: messages.map((m) => m.content).join('\n\n'),
          outputContent: result.outputText,
        };

  const resolvedId = resolveClassifierOutput(result.outputText, config.eligibleInferenceIds);
  const fallbackOccurred = resolvedId === null;
  return resolveOk({
    config,
    writer,
    assistantMessageId,
    resolvedId: resolvedId ?? fallbackId,
    billing,
    fallbackOccurred,
  });
}

interface ResolveOkArgs {
  config: SmartModelStageConfig;
  writer: PreInferenceRunArgs['writer'];
  assistantMessageId: string;
  resolvedId: string;
  billing: PreInferenceBilling | null;
  fallbackOccurred: boolean;
}

async function resolveOk(args: ResolveOkArgs): Promise<PreInferenceOutcome> {
  const { config, writer, assistantMessageId, resolvedId, billing, fallbackOccurred } = args;
  const resolvedName = config.modelMetadataById.get(resolvedId)?.name ?? resolvedId;
  await writer.writeStageDone({
    assistantMessageId,
    payload: {
      stageId: 'smart-model',
      resolvedModelId: resolvedId,
      resolvedModelName: resolvedName,
      ...(fallbackOccurred && { fallbackOccurred: true }),
    },
  });

  return {
    ok: true,
    transformation: { resolvedModelId: resolvedId },
    billing,
  };
}
