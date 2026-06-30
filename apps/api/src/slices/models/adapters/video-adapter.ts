import { createGateway, experimental_generateVideo, NoVideoGeneratedError } from 'ai';
import { z } from 'zod';
import { ZDR_PROVIDER_OPTIONS } from '@hushbox/shared';
import {
  classifyInferenceFailure,
  emptyCompletionError,
  invalidRequestError,
} from './inference-error.js';
import {
  mediaFinishEvent,
  mediaOutputEvents,
  mediaPromptFromInputs,
  validateMediaCall,
} from './media-generate.js';
import type { GenerateVideoResult } from 'ai';
import type { InferenceEvent, InferenceRequest, ModelDescriptor } from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../ports/index.js';

/**
 * The video-family adapter behind the ModelProvider port: ai v6
 * `experimental_generateVideo` against the Vercel AI Gateway's video-model
 * endpoint (non-streaming generate over a single-event SSE wire). Every call
 * carries the gateway's per-request ZDR flag
 * (`providerOptions.gateway.zeroDataRetention`).
 */
export interface CreateVideoAdapterOptions {
  readonly apiKey: string;
  /**
   * The cassette/fixture seam — tests inject a wrapped fetch here so gateway
   * calls record/replay uniformly. Production omits it and the SDK uses
   * `globalThis.fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The first-class call settings the adapter can wire today. The
 * ParamSpec→wire compiler (catalog work) replaces this closed set; until
 * then an unknown key is rejected at the boundary, never dropped silently.
 * `resolution` stays a free string: the SDK types it `${number}x${number}`
 * but providers accept shorthand like '720p'/'1080p'/'4k' at runtime —
 * the per-model vocabulary is ParamSpec data (modelOverrides), not adapter
 * logic.
 */
const callParametersSchema = z.strictObject({
  n: z.number().int().positive().optional(),
  aspectRatio: z.templateLiteral([z.number(), ':', z.number()]).optional(),
  resolution: z.string().min(1).optional(),
  durationSeconds: z.number().positive().optional(),
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
 * per-second pricing matrix (modelOverrides data). Exposed here so
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

interface InferVideoInput {
  gateway: ReturnType<typeof createGateway>;
  request: InferenceRequest;
  options: InferOptions;
}

async function* inferVideo(input: InferVideoInput): AsyncGenerator<InferenceEvent> {
  const { gateway, request, options } = input;
  const parameters = parseCallParameters(request.parameters);
  const prompt = mediaPromptFromInputs(request.inputs);

  let result: GenerateVideoResult;
  try {
    result = await experimental_generateVideo({
      model: gateway.videoModel(request.model),
      prompt,
      // Retry policy lives with callers via the lib/resilience policy factory —
      // the SDK's built-in retry would be a second mechanism.
      maxRetries: 0,
      providerOptions: ZDR_PROVIDER_OPTIONS,
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
  // The video wire carries no token usage; pricing is dimension/duration
  // based (the estimate inputs above) with gateway cost as billing truth.
  yield mediaFinishEvent(result.providerMetadata, { inputTokens: 0, outputTokens: 0 });
}

export function createVideoAdapter(options: CreateVideoAdapterOptions): ModelProvider {
  const gateway = createGateway({
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    infer(
      request: InferenceRequest,
      descriptor: ModelDescriptor,
      inferOptions: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      validateMediaCall(request, descriptor);
      return inferVideo({ gateway, request, options: inferOptions });
    },
  };
}
