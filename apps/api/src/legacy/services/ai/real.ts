import {
  streamText,
  generateImage,
  experimental_generateVideo,
  gateway as gatewayTools,
  stepCountIs,
  createGateway,
} from 'ai';
import { z } from 'zod';
import {
  fetchModels,
  ZDR_PROVIDER_OPTIONS,
  getImagenSampleSize,
  type ImagenSampleSize,
} from '@hushbox/shared/models';
import { MAX_SEARCH_TOOL_CALLS, assertNever } from '@hushbox/shared';
import { recordServiceEvidence, SERVICE_NAMES, type EvidenceConfig } from '@hushbox/db';
import { rawModelToModelInfo } from './model-mapping.js';
import { buildModelViewsForModality, type ModelViewFor } from './model-view.js';
import type { RawModel } from '@hushbox/shared/models';
import type { ImagePart, TextPart, LanguageModelUsage, FinishReason } from 'ai';
import type {
  AIClient,
  InferenceEvent,
  InferenceRequest,
  InferenceStream,
  MessageContentPart,
  Modality,
  ModelInfo,
  ProviderMetadata,
  TextRequest,
  ImageRequest,
  VideoRequest,
  AudioRequest,
} from './types.js';

/**
 * Backoff delays before each retry of `gateway.getGenerationInfo`.
 *
 * The AI Gateway batches usage events to per-region Redis after the streaming
 * response closes, so `/v1/generation?id=…` can 404 for a brief window after a
 * generation completes. The SDK does no retry of its own for this method.
 *
 * Budget: 15.5s across 5 retries (6 total attempts). Cap on individual delay
 * keeps the worst-case wait reasonable for the user-facing chat path.
 */
const GATEWAY_LOOKUP_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;

/**
 * Whether a failed `getGenerationInfo` call is worth retrying.
 *
 * Status-code only — never matches on response body. Body strings are not
 * part of the gateway's contract and can change without notice.
 *   - `undefined` status → network / DNS / abort (no HTTP response): retry.
 *   - 404 → eventual-consistency window for /v1/generation: retry.
 *   - 408, 429 → transient client-side timeout / rate-limit: retry.
 *   - 5xx → gateway server error: retry.
 *   - any other 4xx → permanent (auth, malformed): fail fast.
 */
export function isRetryableGatewayError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (status === undefined) return true;
  if (typeof status !== 'number') return false;
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function imageProviderOptions(
  modelId: string
):
  | typeof ZDR_PROVIDER_OPTIONS
  | (typeof ZDR_PROVIDER_OPTIONS & { google: { sampleImageSize: ImagenSampleSize } }) {
  const sampleImageSize = getImagenSampleSize(modelId);
  if (sampleImageSize === undefined) return ZDR_PROVIDER_OPTIONS;
  // Imagen 4 needs `google.sampleImageSize` set; it rides alongside the
  // gateway ZDR options without disturbing them.
  return {
    ...ZDR_PROVIDER_OPTIONS,
    google: { sampleImageSize },
  };
}

/**
 * Provider-metadata Zod schema for the `gateway` namespace. The AI Gateway
 * docs declare `providerMetadata.gateway.generationId: string` (used for
 * `getGenerationInfo({ id })`).
 *
 * The `gateway` namespace itself is optional — some flows return metadata
 * without it. But once the namespace IS present, we require `generationId`
 * to be a string. If the SDK ever renames that field, parsing fails loudly
 * here rather than silently producing `undefined` and breaking cost lookups.
 */
const gatewayProviderMetaSchema = z.looseObject({
  gateway: z
    .looseObject({
      generationId: z.string(),
    })
    .optional(),
});

function extractGatewayMeta(metadata: unknown): { generationId?: string } | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = gatewayProviderMetaSchema.safeParse(metadata);
  if (!parsed.success) {
    // Drift guard: the gateway namespace exists but does not match the
    // documented shape. Fail loudly so upgrades cannot silently lose the
    // generationId breadcrumb that drives cost reconciliation.
    const candidate =
      typeof metadata === 'object' ? (metadata as { gateway?: unknown }).gateway : undefined;
    if (candidate !== undefined) {
      throw new Error('Gateway generation metadata schema drift — generationId missing');
    }
    return undefined;
  }
  const inner = parsed.data.gateway;
  if (inner === undefined) return undefined;
  return { generationId: inner.generationId };
}

function buildFinishMetadata(
  gatewayMeta: { generationId?: string } | undefined,
  usage?: { inputTokens?: number | null; outputTokens?: number | null }
): ProviderMetadata {
  const result: ProviderMetadata = {};
  if (gatewayMeta?.generationId !== undefined) result.generationId = gatewayMeta.generationId;
  if (usage) {
    result.usage = {
      ...(usage.inputTokens == null ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens == null ? {} : { outputTokens: usage.outputTokens }),
    };
  }
  return result;
}

/**
 * Build the terminal `finish` InferenceEvent from the gateway's post-stream
 * metadata and usage. Kept out of the stream loop so the iterator stays within
 * its complexity budget; `?? null` maps the SDK's optional token counts onto
 * buildFinishMetadata's `number | null` contract.
 */
function buildTextFinishEvent(metadata: unknown, usage: LanguageModelUsage): InferenceEvent {
  return {
    kind: 'finish',
    providerMetadata: buildFinishMetadata(extractGatewayMeta(metadata), {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    }),
  };
}

/**
 * Coerce an unknown error payload from a `fullStream` error/tool-error part
 * into an Error. Preserves an existing Error instance so its `name`/`status`
 * survive for classifyStreamErrorCode; wraps a string; falls back otherwise.
 */
function asInferenceError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error('Inference stream error');
}

function abortError(reason: string | undefined): Error {
  return new Error(reason === undefined ? 'Inference aborted' : `Inference aborted: ${reason}`);
}

/**
 * Guard a completed turn that produced no visible text. The turn is a failure
 * only when the model never had a chance to answer: an unrecovered tool call
 * (surface it, preserving the original error for classifyStreamErrorCode), or
 * an empty finish from tool-call exhaustion / content filter / bare stop. A
 * `length` finish with no tool error is ordinary truncation — the model hit its
 * output-token budget — which is a valid, billable terminal state, so the
 * caller emits the finish event instead. No-ops when text was produced.
 */
function throwForEmptyTurn(
  sawText: boolean,
  toolError: { error: unknown } | undefined,
  finishReason: FinishReason | undefined
): void {
  if (sawText) return;
  if (toolError) throw asInferenceError(toolError.error);
  if (finishReason === 'length') return;
  throw new Error(`Model returned no text (finishReason: ${finishReason ?? 'unknown'})`);
}

/**
 * Convert our internal `MessageContentPart` to the AI SDK v6 wire shape.
 *
 * The return type is constrained by the `TextPart` / `ImagePart` imports from
 * the `ai` package (re-exported from `@ai-sdk/provider-utils`) so a future
 * SDK rename of `mediaType` (or any other ImagePart field) fails compilation
 * here rather than silently breaking image inputs at runtime. AI SDK v6
 * declares the field as `mediaType?: string` — NOT `mimeType` — so we map
 * our internal `mimeType` onto the SDK's `mediaType`.
 */
function convertContentPart(
  part: MessageContentPart
): TextPart | (Pick<ImagePart, 'type' | 'mediaType'> & { image: Uint8Array }) {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  return { type: 'image', image: part.data, mediaType: part.mimeType };
}

function streamTextRequest(
  gateway: ReturnType<typeof createGateway>,
  request: TextRequest
): InferenceStream {
  const systemMessage = request.messages.find((m) => m.role === 'system');
  const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

  const mappedMessages = nonSystemMessages.map((m) => {
    if (m.role === 'assistant') {
      // Assistant messages only support text content in the AI SDK
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map((p) => p.text)
              .join('');
      return { role: 'assistant' as const, content: text };
    }
    const content =
      typeof m.content === 'string' ? m.content : m.content.map((p) => convertContentPart(p));
    return { role: 'user' as const, content };
  });

  const searchTools =
    request.webSearchEnabled === true
      ? { perplexitySearch: gatewayTools.tools.perplexitySearch() }
      : undefined;

  const result = streamText({
    model: gateway(request.model),
    ...(systemMessage === undefined
      ? {}
      : { system: typeof systemMessage.content === 'string' ? systemMessage.content : '' }),
    messages: mappedMessages,
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    providerOptions: ZDR_PROVIDER_OPTIONS,
    ...(searchTools === undefined
      ? {}
      : { tools: searchTools, stopWhen: stepCountIs(MAX_SEARCH_TOOL_CALLS) }),
  });

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      let sawText = false;
      let finishReason: FinishReason | undefined;
      // A failed tool call is not necessarily fatal: with `stopWhen` the model
      // can recover from a failed search and still answer on a later step. Hold
      // the last tool error and surface it only if the turn ends with no text.
      // Wrapped in an object so a tool error whose payload is `undefined` is
      // still distinguishable from "no tool error".
      let toolError: { error: unknown } | undefined;

      // v6 surfaces stream and tool failures as data parts on `fullStream`
      // rather than throwing. Rethrow them so collectSingleSlot records a real
      // error (which classifyStreamErrorCode then buckets) instead of the
      // pipeline reporting the generic "No content generated" fallback.
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta': {
            // v6 TextStreamTextDeltaPart: { type: 'text-delta'; text: string; ... }
            if (part.text.length > 0) {
              sawText = true;
              yield { kind: 'text-delta', content: part.text };
            }
            break;
          }
          case 'error': {
            throw asInferenceError(part.error);
          }
          case 'abort': {
            throw abortError(part.reason);
          }
          case 'tool-error': {
            toolError = { error: part.error };
            break;
          }
          case 'finish': {
            finishReason = part.finishReason;
            break;
          }
        }
      }

      throwForEmptyTurn(sawText, toolError, finishReason);

      const metadata = await result.providerMetadata;
      const usage = await result.totalUsage;

      yield buildTextFinishEvent(metadata, usage);
    },
  };
}

function streamImageRequest(
  gateway: ReturnType<typeof createGateway>,
  request: ImageRequest
): InferenceStream {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      const result = await generateImage({
        model: gateway.imageModel(request.model),
        prompt: request.prompt,
        ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
        ...(request.size === undefined ? {} : { size: request.size as `${number}x${number}` }),
        ...(request.n === undefined ? {} : { n: request.n }),
        providerOptions: imageProviderOptions(request.model),
      });

      const file = result.images[0];
      if (file === undefined) throw new Error('Empty image generation result');
      const bytes = file.uint8Array;
      const mimeType = file.mediaType;

      yield { kind: 'media-start', mediaType: 'image', mimeType };
      yield { kind: 'media-done', bytes, mimeType };

      const imageGatewayMeta = extractGatewayMeta(result.providerMetadata);
      yield { kind: 'finish', providerMetadata: buildFinishMetadata(imageGatewayMeta) };
    },
  };
}

function streamVideoRequest(
  gateway: ReturnType<typeof createGateway>,
  request: VideoRequest
): InferenceStream {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      const result = await experimental_generateVideo({
        model: gateway.video(request.model),
        prompt: request.prompt,
        ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
        // SDK types `resolution` as `${number}x${number}` but Veo accepts
        // shorthand like '720p' / '1080p' / '4k' at runtime — passed through
        // verbatim to the provider. Our `VideoResolution` is the SoT.
        ...(request.resolution === undefined
          ? {}
          : { resolution: request.resolution as unknown as `${number}x${number}` }),
        ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
        providerOptions: ZDR_PROVIDER_OPTIONS,
      });

      const file = result.videos[0];
      if (file === undefined) throw new Error('Empty video generation result');
      const bytes = file.uint8Array;
      const mimeType = file.mediaType;

      yield { kind: 'media-start', mediaType: 'video', mimeType };
      yield { kind: 'media-done', bytes, mimeType };

      const videoGatewayMeta = extractGatewayMeta(result.providerMetadata);
      yield { kind: 'finish', providerMetadata: buildFinishMetadata(videoGatewayMeta) };
    },
  };
}

/**
 * Audio output is not yet supported by the Vercel AI Gateway. This function
 * is dead-coded behind `FEATURE_FLAGS.AUDIO_ENABLED`. When the gateway adds
 * speech-model support, replace the throw with the same pattern as
 * `streamImageRequest` / `streamVideoRequest`. The strategy and types are
 * already shaped correctly; flipping the flag should be sufficient.
 *
 * Until then, fail loud rather than emit a silent finish that downstream
 * pipelines would mistake for a successful generation. The route's flag
 * check plus the missing ZDR audio model list together guarantee this is
 * unreachable in production.
 */
function streamAudioRequest(_request: AudioRequest): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          return Promise.reject(new Error('Audio output is not yet supported by the AI Gateway'));
        },
      };
    },
  };
}

export interface CreateRealAIClientOptions {
  apiKey: string;
  /** URL of the unauthenticated `/v1/models` endpoint for media pricing. */
  publicModelsUrl: string;
  evidence?: EvidenceConfig;
  /**
   * Optional fetch implementation passed to both `createGateway` and
   * `fetchModels`. The HTTP cassette layer injects a wrapped fetch here in
   * integration tests so the gateway calls and the catalog read are recorded
   * uniformly. Production omits this and the SDK uses `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch;
}

export function createRealAIClient(options: CreateRealAIClientOptions): AIClient {
  const { apiKey, publicModelsUrl, evidence, fetch: customFetch } = options;
  const gateway = createGateway({
    apiKey,
    ...(customFetch !== undefined && { fetch: customFetch }),
  });

  const recordEvidence = async (): Promise<void> => {
    if (!evidence) return;
    await recordServiceEvidence(evidence.db, evidence.isCI, SERVICE_NAMES.AI_GATEWAY);
  };

  /** Wrap an upstream InferenceStream so evidence is recorded after the first successful event. */
  const withEvidenceOnStream = (upstream: InferenceStream): InferenceStream => {
    if (!evidence) return upstream;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
        let recorded = false;
        for await (const event of upstream) {
          if (!recorded) {
            recorded = true;
            await recordEvidence();
          }
          yield event;
        }
      },
    };
  };

  return {
    isMock: false,

    listRawModels(): Promise<RawModel[]> {
      // Single boundary for raw catalog data — every caller (chat tier-gate,
      // billing premium-id check, /api/models route) flows through here. The
      // catalog source is the unauthenticated public `/v1/models` endpoint;
      // `apiKey` is only used for inference (`createGateway`).
      return fetchModels({
        publicModelsUrl,
        ...(customFetch !== undefined && { fetch: customFetch }),
      });
    },

    async listModels(): Promise<ModelInfo[]> {
      const rawModels = await this.listRawModels();
      const models = rawModels.map((m) => rawModelToModelInfo(m));
      await recordEvidence();
      return models;
    },

    async listModelsForModality<M extends Modality>(
      modality: M
    ): Promise<readonly ModelViewFor<M>[]> {
      const rawModels = await this.listRawModels();
      return buildModelViewsForModality(rawModels, modality);
    },

    async getModel(id: string): Promise<ModelInfo> {
      const models = await this.listModels();
      const model = models.find((m) => m.id === id);
      if (!model) throw new Error(`Model not found: ${id}`);
      return model;
    },

    stream(request: InferenceRequest): InferenceStream {
      switch (request.modality) {
        case 'text': {
          return withEvidenceOnStream(streamTextRequest(gateway, request));
        }
        case 'image': {
          return withEvidenceOnStream(streamImageRequest(gateway, request));
        }
        case 'video': {
          return withEvidenceOnStream(streamVideoRequest(gateway, request));
        }
        case 'audio': {
          return withEvidenceOnStream(streamAudioRequest(request));
        }
        default: {
          return assertNever(request);
        }
      }
    },

    async getGenerationStats(generationId: string): Promise<{ costUsd: number }> {
      let warned = false;
      for (let attempt = 0; ; attempt++) {
        try {
          const info = await gateway.getGenerationInfo({ id: generationId });
          const result = { costUsd: info.totalCost };
          await recordEvidence();
          return result;
        } catch (error) {
          const nextDelayMs = GATEWAY_LOOKUP_RETRY_DELAYS_MS[attempt];
          if (nextDelayMs === undefined || !isRetryableGatewayError(error)) throw error;
          if (!warned) {
            warned = true;
            const status = (error as { statusCode?: number }).statusCode;
            console.warn('[ai-gateway] getGenerationInfo retryable failure, retrying', {
              generationId,
              statusCode: status,
            });
          }
          await sleep(nextDelayMs);
        }
      }
    },
  };
}
