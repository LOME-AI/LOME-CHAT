import { createGateway, stepCountIs, streamText, tool } from 'ai';
import { match, P } from 'ts-pattern';
import { z } from 'zod';
import { ZDR_PROVIDER_OPTIONS } from '@hushbox/shared';
import {
  abortedError,
  classifyInferenceFailure,
  emptyCompletionError,
  invalidRequestError,
  truncatedStreamError,
} from './inference-error.js';
import type { FinishReason, LanguageModelUsage, TextStreamPart, ToolSet } from 'ai';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
  Usage,
} from '@hushbox/shared';
import type { InferOptions, ModelProvider, ToolLoopOptions } from '../ports/index.js';

/**
 * The language-family adapter behind the ModelProvider port: ai v6
 * `streamText` against the Vercel AI Gateway. Multi-output models stream
 * `file` parts through this same call-shape — mapped to media events via the
 * injected FilePartMapper. Every call carries the gateway's per-request ZDR
 * flag (`providerOptions.gateway.zeroDataRetention`).
 */
export interface CreateLanguageAdapterOptions {
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
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
});

type CallParameters = z.infer<typeof callParametersSchema>;

function parseCallParameters(parameters: Record<string, unknown>): CallParameters {
  const parsed = callParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    const keys = Object.keys(parameters).join(', ');
    throw invalidRequestError(`Unsupported inference parameters (keys: ${keys})`);
  }
  return parsed.data;
}

interface TextContentPart {
  type: 'text';
  text: string;
}

function toUserContent(inputs: InferenceRequest['inputs']): TextContentPart[] {
  return inputs.map((part) => {
    if (part.modality !== 'text') {
      // Media inputs ride by reference (ciphertext in R2); resolving them is
      // the engine's ValueStore seam, which lands with the catalog/domain
      // work — the adapter never holds storage access.
      throw invalidRequestError(`Unsupported input modality for language call: ${part.modality}`);
    }
    return { type: 'text', text: part.text };
  });
}

/**
 * An adapter-internal invariant break — a defect, never an expected
 * inference failure. Must escape the InferenceError channel: callers
 * translate InferenceError into typed domain failures, while a defect
 * propagates as an exception (500 + Sentry). The stream-loop catch rethrows
 * these instead of classifying them.
 */
export class AdapterDefect extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterDefect';
  }
}

const gatewayMetadataSchema = z.looseObject({
  gateway: z.looseObject({ generationId: z.string() }).optional(),
});

/**
 * Pull `gateway.generationId` from provider metadata. The namespace being
 * present without a string generationId is schema drift — fail loud so an
 * SDK upgrade cannot silently lose the breadcrumb that keys per-generation
 * cost lookups.
 */
function extractGenerationId(metadata: unknown): string | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = gatewayMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    if ((metadata as { gateway?: unknown }).gateway !== undefined) {
      throw new AdapterDefect('Gateway generation metadata schema drift — generationId missing');
    }
    return undefined;
  }
  return parsed.data.gateway?.generationId;
}

function mapUsage(usage: LanguageModelUsage): Usage {
  const reasoningTokens = usage.outputTokenDetails.reasoningTokens;
  const cachedInputTokens = usage.inputTokenDetails.cacheReadTokens;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function buildToolset(loop: ToolLoopOptions): ToolSet {
  const tools: ToolSet = {};
  for (const [name, definition] of Object.entries(loop.registry)) {
    tools[name] = tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: (input: unknown) => definition.execute(input),
    });
  }
  return tools;
}

/** Per-kind slot indices: each distinct SDK stream id gets the next index. */
function indexFor(ids: Map<string, number>, id: string): number {
  const existing = ids.get(id);
  if (existing !== undefined) return existing;
  const assigned = ids.size;
  ids.set(id, assigned);
  return assigned;
}

interface StreamState {
  sawText: boolean;
  sawMedia: boolean;
  /**
   * A failed tool call is recoverable until turn end: with `stopWhen` the
   * model can answer on a later step. Held (wrapped so an `undefined`
   * payload stays distinguishable) and surfaced only if the turn ends empty.
   */
  toolError: { error: unknown } | undefined;
  finishPart: { finishReason: FinishReason; totalUsage: LanguageModelUsage } | undefined;
  stepGenerationIds: string[];
  step: number;
  textIds: Map<string, number>;
  reasoningIds: Map<string, number>;
  fileIndex: number;
}

function mapTextDelta(part: { id: string; text: string }, state: StreamState): InferenceEvent[] {
  if (part.text.length === 0) return [];
  state.sawText = true;
  return [{ kind: 'text-delta', index: indexFor(state.textIds, part.id), content: part.text }];
}

function mapReasoningDelta(
  part: { id: string; text: string },
  state: StreamState
): InferenceEvent[] {
  if (part.text.length === 0) return [];
  return [
    { kind: 'reasoning-delta', index: indexFor(state.reasoningIds, part.id), content: part.text },
  ];
}

function mapToolCall(part: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}): InferenceEvent[] {
  return [{ kind: 'tool-call', id: part.toolCallId, name: part.toolName, args: part.input }];
}

function mapToolResult(part: {
  toolCallId: string;
  toolName: string;
  output: unknown;
}): InferenceEvent[] {
  return [{ kind: 'tool-result', id: part.toolCallId, name: part.toolName, result: part.output }];
}

function mapFile(
  file: { mediaType: string; uint8Array: Uint8Array },
  state: StreamState,
  mapFilePart: FilePartMapper | undefined
): InferenceEvent[] {
  if (mapFilePart === undefined) {
    // Defect, not an expected failure: the caller invoked a multi-output
    // model without supplying the FilePartMapper contract.
    throw new AdapterDefect('language adapter: file part received without a mapFilePart contract');
  }
  state.sawMedia = true;
  const index = state.fileIndex;
  state.fileIndex += 1;
  // The SDK types GeneratedFile bytes as Uint8Array<ArrayBufferLike> but
  // constructs them from plain buffers (base64/binary payloads), never
  // SharedArrayBuffer-backed views — the narrowing is safe and zero-copy.
  const [start, done] = mapFilePart(
    { mediaType: file.mediaType, data: file.uint8Array as Uint8Array<ArrayBuffer> },
    index
  );
  return [start, done];
}

function mapStepStart(state: StreamState): InferenceEvent[] {
  state.step += 1;
  return [{ kind: 'step-start', step: state.step }];
}

function mapStepFinish(providerMetadata: unknown, state: StreamState): InferenceEvent[] {
  const generationId = extractGenerationId(providerMetadata);
  if (generationId === undefined) {
    // A step without its gateway generation metadata cannot be billed or
    // reconciled — treat as a truncated stream.
    throw truncatedStreamError();
  }
  state.stepGenerationIds.push(generationId);
  return [{ kind: 'step-finish', step: state.step, generationId }];
}

function mapPart(
  part: TextStreamPart<ToolSet>,
  state: StreamState,
  mapFilePart: FilePartMapper | undefined
): InferenceEvent[] {
  return (
    match(part)
      .with({ type: 'text-delta' }, (p) => mapTextDelta(p, state))
      .with({ type: 'reasoning-delta' }, (p) => mapReasoningDelta(p, state))
      .with({ type: 'tool-call' }, (p) => mapToolCall(p))
      .with({ type: 'tool-result' }, (p) => mapToolResult(p))
      .with({ type: 'tool-error' }, (p): InferenceEvent[] => {
        state.toolError = { error: p.error };
        return [];
      })
      .with({ type: 'file' }, (p) => mapFile(p.file, state, mapFilePart))
      .with({ type: 'start-step' }, () => mapStepStart(state))
      .with({ type: 'finish-step' }, (p) => mapStepFinish(p.providerMetadata, state))
      .with({ type: 'finish' }, (p): InferenceEvent[] => {
        state.finishPart = { finishReason: p.finishReason, totalUsage: p.totalUsage };
        return [];
      })
      .with({ type: 'error' }, (p) => {
        throw classifyInferenceFailure(p.error);
      })
      .with({ type: 'abort' }, (p) => {
        throw abortedError(p.reason);
      })
      // Deliberately unmapped — no InferenceEvent leaves the adapter:
      // start / text-start / text-end / reasoning-start / reasoning-end are
      // lifecycle markers (the deltas carry the content; slot indices come
      // from part ids); tool-input-start/delta/end stream the input the
      // terminal tool-call part already carries whole; source / raw carry no
      // content or billing payload the port models; tool-output-denied /
      // tool-approval-request belong to the SDK's tool-approval flow —
      // ToolDefinition exposes no approval contract, so nothing upstream
      // could answer one. `.exhaustive()` makes any future SDK part kind a
      // compile error here instead of a silent swallow.
      .with(
        {
          type: P.union(
            'start',
            'text-start',
            'text-end',
            'reasoning-start',
            'reasoning-end',
            'tool-input-start',
            'tool-input-delta',
            'tool-input-end',
            'source',
            'raw',
            'tool-output-denied',
            'tool-approval-request'
          ),
        },
        (): InferenceEvent[] => []
      )
      .exhaustive()
  );
}

/**
 * Terminal decision table for a turn that produced no visible output: an
 * unrecovered tool error surfaces as the original failure; an empty `length`
 * finish is BILLABLE TRUNCATION — a valid terminal state the caller persists
 * and charges — so it falls through to the finish event; anything else
 * (tool-call exhaustion, content filter, bare stop) is an empty completion.
 */
function throwForEmptyTurn(state: StreamState, finishReason: FinishReason): void {
  if (state.sawText || state.sawMedia) return;
  if (state.toolError !== undefined) throw classifyInferenceFailure(state.toolError.error);
  if (finishReason === 'length') return;
  throw emptyCompletionError(finishReason);
}

interface InferStreamInput {
  gateway: ReturnType<typeof createGateway>;
  request: InferenceRequest;
  options: InferOptions;
}

function noopOnError(): void {
  // deliberate: see the onError comment at the streamText call
}

interface OptionalCallSettings {
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  tools?: ToolSet;
  stopWhen?: ReturnType<typeof stepCountIs>;
}

/** Conditional spreads so an absent option never lands as an explicit undefined. */
function callSettingsFor(parameters: CallParameters, options: InferOptions): OptionalCallSettings {
  return {
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    ...(parameters.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: parameters.maxOutputTokens }),
    ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature }),
    ...(parameters.topP === undefined ? {} : { topP: parameters.topP }),
    ...(options.tools === undefined
      ? {}
      : { tools: buildToolset(options.tools), stopWhen: stepCountIs(options.tools.maxSteps) }),
  };
}

async function* inferLanguage(input: InferStreamInput): AsyncGenerator<InferenceEvent> {
  const { gateway, request, options } = input;
  const parameters = parseCallParameters(request.parameters);
  const content = toUserContent(request.inputs);

  const result = streamText({
    model: gateway(request.model),
    messages: [{ role: 'user', content }],
    // Retry policy lives with callers via the lib/resilience policy factory —
    // the SDK's built-in retry would be a second mechanism, and its RetryError
    // buries the gateway error in an array the classifier cannot chain-walk.
    maxRetries: 0,
    // The SDK's default onError is console.error; errors already reach the
    // caller as typed throws from the fullStream loop, and raw console output
    // is banned (telemetry rides the SafeLogFields logger).
    onError: noopOnError,
    providerOptions: ZDR_PROVIDER_OPTIONS,
    ...callSettingsFor(parameters, options),
  });

  const state: StreamState = {
    sawText: false,
    sawMedia: false,
    toolError: undefined,
    finishPart: undefined,
    stepGenerationIds: [],
    step: -1,
    textIds: new Map(),
    reasoningIds: new Map(),
    fileIndex: 0,
  };

  // v6 surfaces stream and tool failures as data parts on `fullStream`
  // rather than throwing; anything thrown by iteration itself is classified
  // the same way — except adapter defects, which must stay exceptions rather
  // than masquerade as expected upstream failures.
  try {
    for await (const part of result.fullStream) {
      yield* mapPart(part, state, options.mapFilePart);
    }
  } catch (error) {
    if (error instanceof AdapterDefect) throw error;
    throw classifyInferenceFailure(error);
  }

  const finishPart = state.finishPart;
  if (finishPart === undefined) throw truncatedStreamError();
  throwForEmptyTurn(state, finishPart.finishReason);

  // Single-step runs carry the generationId on the terminal finish; on
  // multi-step runs each step-finish already carried its own.
  const generationId =
    state.stepGenerationIds.length === 1 ? state.stepGenerationIds[0] : undefined;
  yield {
    kind: 'finish',
    metadata: {
      ...(generationId === undefined ? {} : { generationId }),
      usage: mapUsage(finishPart.totalUsage),
      finishReason: finishPart.finishReason,
    },
  };
}

export function createLanguageAdapter(options: CreateLanguageAdapterOptions): ModelProvider {
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
      if (request.model !== descriptor.id) {
        throw invalidRequestError(
          `Request model does not match descriptor (${request.model} vs ${descriptor.id})`
        );
      }
      return inferLanguage({ gateway, request, options: inferOptions });
    },
  };
}
