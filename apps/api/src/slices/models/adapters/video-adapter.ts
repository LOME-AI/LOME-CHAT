import { experimental_generateVideo, NoVideoGeneratedError } from 'ai';
import { z } from 'zod';
import { mediaRoutingOptions } from '@hushbox/shared';
import {
  classifyInferenceFailure,
  emptyCompletionError,
  invalidRequestError,
} from './inference-error.js';
import {
  extractMediaCostUsd,
  mediaFinishEvent,
  mediaOutputEvents,
  mediaPromptFromInputs,
  validateMediaCall,
} from './media-generate.js';
import { createOpenRouterProvider } from './openrouter-provider.js';
import type { OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import type { GenerateVideoResult } from 'ai';
import type { InferenceEvent, InferenceRequest, ModelDescriptor } from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../ports/index.js';

/**
 * The video-family adapter behind the ModelProvider port: ai v6
 * `experimental_generateVideo` against OpenRouter's `/videos` endpoint. That is
 * a submit → poll → download job, which the SDK's `videoModel` hides behind one
 * `await`; `maxPollTimeMs` is raised toward the media deadline (within the DO
 * alarm cap). Every call pins the ZDR routing block via `mediaRoutingOptions()`
 * (carried in `extraBody.provider`) and reads the authoritative inline
 * `providerMetadata.openrouter.cost`.
 */
export interface CreateVideoAdapterOptions {
  readonly apiKey: string;
  /**
   * The cassette/fixture seam — tests inject a wrapped fetch here so calls
   * record/replay uniformly. Production omits it and the SDK uses
   * `globalThis.fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Poll interval between `/videos/{id}` status checks. Production uses the
   * SDK default (2s); tests inject a small value to keep replays fast.
   */
  readonly pollIntervalMs?: number;
}

/**
 * How long the video job may poll before giving up. Sized toward the media
 * deadline (~15 min) while staying inside the Durable Object alarm cap.
 */
const VIDEO_MAX_POLL_MS = 14 * 60 * 1000;

/**
 * The SDK downloads url-type videos through this function; routing it through
 * the adapter's injected fetch keeps the whole submit/poll/download flow on the
 * one cassette seam. Production omits it and the SDK uses its default download.
 */
function videoDownloadVia(fetchImpl: typeof globalThis.fetch): (options: {
  url: URL;
  abortSignal?: AbortSignal;
}) => Promise<{
  data: Uint8Array;
  mediaType: string | undefined;
}> {
  return async ({ url, abortSignal }) => {
    const response = await fetchImpl(url, abortSignal === undefined ? {} : { signal: abortSignal });
    if (!response.ok) {
      throw new Error(`Video download failed with status ${String(response.status)}`);
    }
    const buffer = await response.arrayBuffer();
    return {
      data: new Uint8Array(buffer),
      mediaType: response.headers.get('content-type') ?? undefined,
    };
  };
}

/**
 * The first-class call settings the adapter can wire today. The
 * ParamSpec→wire compiler (catalog work) replaces this closed set; until
 * then an unknown key is rejected at the boundary, never dropped silently.
 * `resolution` stays a free string: the SDK types it `${number}x${number}`
 * but providers accept shorthand like '720p'/'1080p'/'4k' at runtime —
 * the per-model vocabulary is ParamSpec data (OpenRouter catalog), not adapter
 * logic.
 */
const callParametersSchema = z.strictObject({
  n: z.number().int().positive().optional(),
  aspectRatio: z.templateLiteral([z.number(), ':', z.number()]).optional(),
  resolution: z.string().min(1).optional(),
  // Integer seconds: the deterministic per-second pricer multiplies whole
  // units, and providers accept whole-second durations.
  durationSeconds: z.number().int().positive().optional(),
});

type CallParameters = z.infer<typeof callParametersSchema>;

function parseCallParameters(parameters: Record<string, unknown>): CallParameters {
  const parsed = callParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    const keys = Object.keys(parameters).join(', ');
    throw invalidRequestError(`Unsupported video parameters (keys: ${keys})`);
  }
  return parsed.data;
}

/**
 * The inputs billing's estimate flow prices against the per-resolution /
 * per-second pricing matrix (OpenRouter catalog pricing). Exposed here so
 * estimation never re-derives the adapter's parameter contract; this module
 * does not price.
 */
export interface VideoEstimateInputs {
  readonly n: number;
  readonly aspectRatio?: `${number}:${number}`;
  readonly resolution?: string;
  readonly durationSeconds?: number;
}

export function videoEstimateInputs(request: InferenceRequest): VideoEstimateInputs {
  const parameters = parseCallParameters(request.parameters);
  return {
    n: parameters.n ?? 1,
    ...(parameters.aspectRatio === undefined ? {} : { aspectRatio: parameters.aspectRatio }),
    ...(parameters.resolution === undefined ? {} : { resolution: parameters.resolution }),
    ...(parameters.durationSeconds === undefined
      ? {}
      : { durationSeconds: parameters.durationSeconds }),
  };
}

type VideoDownload = (options: { url: URL; abortSignal?: AbortSignal }) => Promise<{
  data: Uint8Array;
  mediaType: string | undefined;
}>;

interface InferVideoInput {
  provider: OpenRouterProvider;
  videoSettings: Parameters<OpenRouterProvider['videoModel']>[1];
  /** Pre-resolved download option (empty in production, where the SDK default applies). */
  downloadOption: { download?: VideoDownload };
  request: InferenceRequest;
  options: InferOptions;
}

async function* inferVideo(input: InferVideoInput): AsyncGenerator<InferenceEvent> {
  const { provider, videoSettings, downloadOption, request, options } = input;
  const parameters = parseCallParameters(request.parameters);
  const prompt = mediaPromptFromInputs(request.inputs);

  let result: GenerateVideoResult;
  try {
    result = await experimental_generateVideo({
      model: provider.videoModel(request.model, videoSettings),
      prompt,
      // Retry policy lives with callers via the lib/resilience policy factory —
      // the SDK's built-in retry would be a second mechanism.
      maxRetries: 0,
      ...downloadOption,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      ...(parameters.n === undefined ? {} : { n: parameters.n }),
      ...(parameters.aspectRatio === undefined ? {} : { aspectRatio: parameters.aspectRatio }),
      ...(parameters.resolution === undefined
        ? {}
        : // Verbatim pass-through of provider shorthand; see the schema note.
          { resolution: parameters.resolution as `${number}x${number}` }),
      ...(parameters.durationSeconds === undefined ? {} : { duration: parameters.durationSeconds }),
    });
  } catch (error) {
    // The SDK throws this after a successful call that yielded zero videos —
    // the media analogue of the language adapter's empty completion.
    if (NoVideoGeneratedError.isInstance(error)) throw emptyCompletionError();
    throw classifyInferenceFailure(error);
  }

  yield* mediaOutputEvents(result.videos, options.mapFilePart);
  // The video wire carries no token usage; pricing is dimension/duration based
  // (the estimate inputs above) with OpenRouter's inline cost as billing truth.
  yield mediaFinishEvent(
    result.providerMetadata,
    { inputTokens: 0, outputTokens: 0 },
    extractMediaCostUsd(result.providerMetadata)
  );
}

export function createVideoAdapter(options: CreateVideoAdapterOptions): ModelProvider {
  const provider = createOpenRouterProvider(options);
  const videoSettings: Parameters<OpenRouterProvider['videoModel']>[1] = {
    ...mediaRoutingOptions(),
    maxPollTimeMs: VIDEO_MAX_POLL_MS,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  };
  // In production (no injected fetch) the SDK's hardened default download
  // applies (redirect validation, size cap); the injected fetch routes the
  // download through the cassette seam. Resolved once, at construction.
  const downloadOption: { download?: VideoDownload } =
    options.fetch === undefined ? {} : { download: videoDownloadVia(options.fetch) };

  return {
    infer(
      request: InferenceRequest,
      descriptor: ModelDescriptor,
      inferOptions: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      validateMediaCall(request, descriptor);
      return inferVideo({
        provider,
        videoSettings,
        downloadOption,
        request,
        options: inferOptions,
      });
    },
  };
}
