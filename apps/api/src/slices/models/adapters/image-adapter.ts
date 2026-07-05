import { generateImage, NoContentGeneratedError, NoImageGeneratedError } from 'ai';
import { z } from 'zod';
import { mediaRoutingOptions } from '@hushbox/shared';
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
import { createOpenRouterProvider } from './openrouter-provider.js';
import type { OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import type { GenerateImageResult, ImageModelUsage } from 'ai';
import type { InferenceEvent, InferenceRequest, ModelDescriptor, Usage } from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../ports/index.js';

/**
 * The image-family adapter behind the ModelProvider port: ai v6
 * `generateImage` against OpenRouter's `/images` endpoint (non-streaming
 * generate). Every call pins the ZDR routing block via `mediaRoutingOptions()`
 * (carried in `extraBody.provider`). OpenRouter's dedicated images API returns
 * NO inline cost, so the finish carries none — settlement falls back to the
 * deterministic estimate.
 */
export interface CreateImageAdapterOptions {
  readonly apiKey: string;
  /**
   * The cassette/fixture seam — tests inject a wrapped fetch here so calls
   * record/replay uniformly. Production omits it and the SDK uses
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
 * matrix (OpenRouter catalog pricing). Exposed here so estimation never re-derives
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
  provider: OpenRouterProvider;
  request: InferenceRequest;
  options: InferOptions;
}

async function* inferImage(input: InferImageInput): AsyncGenerator<InferenceEvent> {
  const { provider, request, options } = input;
  const parameters = parseCallParameters(request.parameters);
  const prompt = mediaPromptFromInputs(request.inputs);

  let result: GenerateImageResult;
  try {
    result = await generateImage({
      model: provider.imageModel(request.model, mediaRoutingOptions()),
      prompt,
      // Retry policy lives with callers via the lib/resilience policy factory —
      // the SDK's built-in retry would be a second mechanism.
      maxRetries: 0,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      ...(parameters.n === undefined ? {} : { n: parameters.n }),
      ...(parameters.size === undefined ? {} : { size: parameters.size }),
      ...(parameters.aspectRatio === undefined ? {} : { aspectRatio: parameters.aspectRatio }),
    });
  } catch (error) {
    // A successful call that yielded zero images — the media analogue of the
    // language adapter's empty completion. OpenRouter's image model raises
    // NoContentGeneratedError from doGenerate; generateImage raises
    // NoImageGeneratedError when it gathers none.
    if (NoContentGeneratedError.isInstance(error) || NoImageGeneratedError.isInstance(error)) {
      throw emptyCompletionError();
    }
    throw classifyInferenceFailure(error);
  }

  yield* mediaOutputEvents(result.images, options.mapFilePart);
  // No cost argument: OpenRouter's images API returns no inline cost.
  yield mediaFinishEvent(result.providerMetadata, mapImageUsage(result.usage));
}

export function createImageAdapter(options: CreateImageAdapterOptions): ModelProvider {
  const provider = createOpenRouterProvider(options);

  return {
    infer(
      request: InferenceRequest,
      descriptor: ModelDescriptor,
      inferOptions: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      validateMediaCall(request, descriptor);
      return inferImage({ provider, request, options: inferOptions });
    },
  };
}
