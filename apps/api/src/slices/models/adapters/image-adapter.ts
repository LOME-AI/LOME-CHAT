import { createGateway, generateImage, NoImageGeneratedError } from 'ai';
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
import type { GenerateImageResult, ImageModelUsage } from 'ai';
import type { InferenceEvent, InferenceRequest, ModelDescriptor, Usage } from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../ports/index.js';

/**
 * The image-family adapter behind the ModelProvider port: ai v6
 * `generateImage` against the Vercel AI Gateway's image-model endpoint
 * (non-streaming generate). Every call carries the gateway's per-request ZDR
 * flag (`providerOptions.gateway.zeroDataRetention`).
 */
export interface CreateImageAdapterOptions {
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
 */
const callParametersSchema = z.strictObject({
  n: z.number().int().positive().optional(),
  size: z.templateLiteral([z.number(), 'x', z.number()]).optional(),
  aspectRatio: z.templateLiteral([z.number(), ':', z.number()]).optional(),
});

type CallParameters = z.infer<typeof callParametersSchema>;

function parseCallParameters(parameters: Record<string, unknown>): CallParameters {
  const parsed = callParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    const keys = Object.keys(parameters).join(', ');
    throw invalidRequestError(`Unsupported image parameters (keys: ${keys})`);
  }
  return parsed.data;
}

/**
 * The inputs billing's estimate flow prices against the per-size pricing
 * matrix (modelOverrides data). Exposed here so estimation never re-derives
 * the adapter's parameter contract; this module does not price.
 */
export interface ImageEstimateInputs {
  readonly n: number;
  readonly size?: `${number}x${number}`;
  readonly aspectRatio?: `${number}:${number}`;
}

export function imageEstimateInputs(request: InferenceRequest): ImageEstimateInputs {
  const parameters = parseCallParameters(request.parameters);
  return {
    n: parameters.n ?? 1,
    ...(parameters.size === undefined ? {} : { size: parameters.size }),
    ...(parameters.aspectRatio === undefined ? {} : { aspectRatio: parameters.aspectRatio }),
  };
}

function mapImageUsage(usage: ImageModelUsage): Usage {
  return { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
}

interface InferImageInput {
  gateway: ReturnType<typeof createGateway>;
  request: InferenceRequest;
  options: InferOptions;
}

async function* inferImage(input: InferImageInput): AsyncGenerator<InferenceEvent> {
  const { gateway, request, options } = input;
  const parameters = parseCallParameters(request.parameters);
  const prompt = mediaPromptFromInputs(request.inputs);

  let result: GenerateImageResult;
  try {
    result = await generateImage({
      model: gateway.imageModel(request.model),
      prompt,
      // Retry policy lives with callers via the lib/resilience policy factory —
      // the SDK's built-in retry would be a second mechanism.
      maxRetries: 0,
      providerOptions: ZDR_PROVIDER_OPTIONS,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      ...(parameters.n === undefined ? {} : { n: parameters.n }),
      ...(parameters.size === undefined ? {} : { size: parameters.size }),
      ...(parameters.aspectRatio === undefined ? {} : { aspectRatio: parameters.aspectRatio }),
    });
  } catch (error) {
    // The SDK throws this after a successful call that yielded zero images —
    // the media analogue of the language adapter's empty completion.
    if (NoImageGeneratedError.isInstance(error)) throw emptyCompletionError();
    throw classifyInferenceFailure(error);
  }

  yield* mediaOutputEvents(result.images, options.mapFilePart);
  yield mediaFinishEvent(result.providerMetadata, mapImageUsage(result.usage));
}

export function createImageAdapter(options: CreateImageAdapterOptions): ModelProvider {
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
      return inferImage({ gateway, request, options: inferOptions });
    },
  };
}
