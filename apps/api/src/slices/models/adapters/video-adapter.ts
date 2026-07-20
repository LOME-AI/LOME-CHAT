import { experimental_generateVideo, NoVideoGeneratedError } from 'ai';
import { DEFAULT_MAX_DOWNLOAD_SIZE, fetchWithValidatedRedirects } from '@ai-sdk/provider-utils';
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
 * Structural name marking a download aborted because it would exceed the run's
 * remaining ValueStore budget. The engine recognizes it by this name — a
 * cross-slice STRUCTURAL check, never a value import (mirroring how the node
 * layer recognizes `InferenceError`) — and maps it to the `byte-budget-exceeded`
 * run failure (→ VALIDATION).
 */
const DOWNLOAD_BYTE_CAP_EXCEEDED_NAME = 'DownloadByteCapExceeded';

class DownloadByteCapExceededError extends Error {
  constructor(capBytes: number) {
    super(`Video download exceeded the ${String(capBytes)}-byte budget cap`);
    this.name = DOWNLOAD_BYTE_CAP_EXCEEDED_NAME;
  }
}

/**
 * Walks the error (and its `cause` chain) for the byte-cap marker: the SDK may
 * wrap a thrown download error, so the marker is not always the top-level throw.
 */
function findDownloadByteCapExceeded(error: unknown): DownloadByteCapExceededError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.name === DOWNLOAD_BYTE_CAP_EXCEEDED_NAME) {
      return current as DownloadByteCapExceededError;
    }
    current = current.cause;
  }
  return undefined;
}

/** Fetches the download URL to a Response — the SSRF-safe fetch in production, the injected fetch under test. */
type ResponseFetcher = (url: URL, abortSignal: AbortSignal | undefined) => Promise<Response>;

/**
 * The SDK downloads url-type videos through this function, which fully replaces
 * the SDK's own download path — so the metering AND the redirect/SSRF hardening
 * are ours to supply (see `downloadOptionFor`).
 *
 * The video download is the one path where a whole media artifact materializes
 * in the isolate before the engine's `ValueStore` can meter it. `cap` is the
 * run's remaining byte budget: a declared content-length over it rejects before
 * a single body byte is read, and the streaming read aborts the instant the
 * running total would cross it — the full blob never materializes.
 */
function videoDownloadVia(fetchResponse: ResponseFetcher, cap: number): VideoDownload {
  return async ({ url, abortSignal }) => {
    const response = await fetchResponse(url, abortSignal);
    if (!response.ok) {
      throw new Error(`Video download failed with status ${String(response.status)}`);
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > cap) {
      throw new DownloadByteCapExceededError(cap);
    }
    const body = response.body;
    if (body === null) {
      throw new Error('Video download returned an empty body');
    }
    return {
      data: await readWithinCap(body, cap),
      mediaType: response.headers.get('content-type') ?? undefined,
    };
  };
}

/**
 * Reads the stream into one `Uint8Array`, aborting the moment the accumulated
 * bytes would exceed `cap` — the over-budget artifact is never fully read.
 */
async function readWithinCap(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > cap) {
      await reader.cancel();
      throw new DownloadByteCapExceededError(cap);
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
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
  /**
   * The adapter's injected fetch (cassette/fixture seam), or undefined in
   * production where the SDK's hardened default download applies. The metered
   * download is built per call so it captures this call's remaining byte cap.
   */
  customFetch?: typeof globalThis.fetch;
  request: InferenceRequest;
  options: InferOptions;
}

/**
 * The SDK `download` option for this call — always our metered download, so a
 * large video aborts before it materializes a blob the ValueStore would reject.
 * Supplying `download` fully replaces the SDK's built-in download, so we own its
 * hardening too:
 *
 * - Production (no injected fetch) fetches via `fetchWithValidatedRedirects`,
 *   which reproduces the SDK's exact SSRF guard — per-hop `validateDownloadUrl`
 *   with manual redirect following — then meters the body with `readWithinCap`.
 * - The cassette/fixture seam (injected fetch) replays the recorded download;
 *   record/replay needs no redirect validation.
 *
 * `cap` is bounded either way: the per-call remaining ValueStore budget when
 * threaded, else the SDK's 2 GiB floor so even an untracked call cannot OOM.
 */
function downloadOptionFor(
  customFetch: typeof globalThis.fetch | undefined,
  options: InferOptions
): { download: VideoDownload } {
  const cap = options.downloadByteCap ?? DEFAULT_MAX_DOWNLOAD_SIZE;
  const fetchResponse: ResponseFetcher =
    customFetch === undefined
      ? (url, abortSignal) =>
          fetchWithValidatedRedirects({
            url: url.toString(),
            ...(abortSignal === undefined ? {} : { abortSignal }),
          })
      : (url, abortSignal) =>
          customFetch(url, abortSignal === undefined ? {} : { signal: abortSignal });
  return { download: videoDownloadVia(fetchResponse, cap) };
}

async function* inferVideo(input: InferVideoInput): AsyncGenerator<InferenceEvent> {
  const { provider, videoSettings, customFetch, request, options } = input;
  const parameters = parseCallParameters(request.parameters);
  const prompt = mediaPromptFromInputs(request.inputs);
  const downloadOption = downloadOptionFor(customFetch, options);

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
    // The byte-cap breach is a validation refusal, not a provider failure:
    // surface it raw (the SDK may have wrapped it) so the engine maps it to
    // `byte-budget-exceeded` rather than reclassifying it as an upstream error.
    const capExceeded = findDownloadByteCapExceeded(error);
    if (capExceeded !== undefined) throw capExceeded;
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
  const customFetch = options.fetch;

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
        ...(customFetch === undefined ? {} : { customFetch }),
        request,
        options: inferOptions,
      });
    },
  };
}
