import { stepCountIs, streamText, tool } from 'ai';
import { match, P } from 'ts-pattern';
import { z } from 'zod';
import { ReasoningWire, buildTurnSystemPrompt, languageRoutingOptions } from '@hushbox/shared';
import {
  abortedError,
  classifyInferenceFailure,
  emptyCompletionError,
  invalidRequestError,
  noReasoningEndpointsError,
  truncatedStreamError,
} from './inference-error.js';
import { createOpenRouterProvider } from './openrouter-provider.js';
import type { OpenRouterProvider } from '@openrouter/ai-sdk-provider';
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
 * `streamText` against OpenRouter (`openrouter.chat`). Multi-output models
 * stream `file` parts through this same call-shape — mapped to media events via
 * the injected FilePartMapper. Every call pins the ZDR routing block via the
 * shared `languageRoutingOptions()` and reads the authoritative inline
 * `providerMetadata.openrouter.usage.cost` off each step and the finish.
 */
export interface CreateLanguageAdapterOptions {
  readonly apiKey: string;
  /**
   * The cassette/fixture seam — tests inject a wrapped fetch here so calls
   * record/replay uniformly. Production omits it and the SDK uses
   * `globalThis.fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The clock feeding the base system prompt's current date. Injected so the
   * assembled request (and its cassette hash) is deterministic under test;
   * production omits it and reads the wall clock.
   */
  readonly now?: () => Date;
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
  // The shared wire schema is composed, never re-typed: its strict
  // discriminated union makes `effort` + `max_tokens` together unparseable,
  // so an invalid pair is refused here instead of reaching the gateway.
  reasoning: ReasoningWire.optional(),
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

/**
 * Prior turns as wire messages, oldest first; the current turn is appended
 * after them. A future system prompt slots in ahead of this list without
 * touching the mapping. Absent history maps to [] — the request body is then
 * byte-identical to the pre-history adapter, keeping every recorded cassette
 * replayable.
 */
function toHistoryMessages(
  history: InferenceRequest['history']
): { role: 'user' | 'assistant'; content: string }[] {
  return (history ?? []).map((message) => ({ role: message.role, content: message.content }));
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

const openrouterUsageMetadataSchema = z.looseObject({
  openrouter: z
    .looseObject({
      usage: z.looseObject({ cost: z.number().nullish() }).nullish(),
    })
    .nullish(),
});

/**
 * Pull the authoritative inline `openrouter.usage.cost` (USD) off a step's
 * provider metadata. Absent (or malformed) means the step reported no inline
 * cost — settlement falls back to the estimate; it is never a failure here.
 */
export function extractStepCost(metadata?: unknown): number | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = openrouterUsageMetadataSchema.safeParse(metadata);
  if (!parsed.success) return undefined;
  const cost = parsed.data.openrouter?.usage?.cost;
  return typeof cost === 'number' ? cost : undefined;
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

export function buildToolset(loop: ToolLoopOptions, provider: OpenRouterProvider): ToolSet {
  const tools: ToolSet = {};
  for (const [name, definition] of Object.entries(loop.registry)) {
    // A providerTool is executed server-side inside OpenRouter (e.g.
    // `openrouter:web_search`); its `args` (an engine pin, result cap, …) are
    // forwarded verbatim to the SDK's provider-tool factory. A plain definition
    // becomes a client-executed function tool whose `execute` the loop invokes.
    tools[name] =
      definition.providerTool === undefined
        ? tool({
            description: definition.description,
            inputSchema: definition.inputSchema,
            execute: (input: unknown) => definition.execute(input),
          })
        : provider.tools.webSearch(definition.providerTool.args);
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
  /** Run total of the per-step inline costs; the terminal finish carries the sum. */
  totalCostUsd: number;
  sawCost: boolean;
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

function mapStepFinish(
  part: { response: { id: string }; providerMetadata: unknown },
  state: StreamState
): InferenceEvent[] {
  // OpenRouter's `gen-…` id rides the response metadata as `response.id` (its
  // chat providerMetadata carries no generation id); the SDK guarantees it is
  // present. The inline per-step cost rides `providerMetadata.openrouter.usage`.
  const generationId = part.response.id;
  state.stepGenerationIds.push(generationId);
  const cost = extractStepCost(part.providerMetadata);
  if (cost !== undefined) {
    state.totalCostUsd += cost;
    state.sawCost = true;
  }
  return [
    {
      kind: 'step-finish',
      step: state.step,
      generationId,
      ...(cost === undefined ? {} : { providerCostUsd: cost }),
    },
  ];
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
      .with({ type: 'finish-step' }, (p) => mapStepFinish(p, state))
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
  provider: OpenRouterProvider;
  request: InferenceRequest;
  options: InferOptions;
  now: () => Date;
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
  providerOptions?: { openrouter: { reasoning: ReasoningWire } };
}

/** Conditional spreads so an absent option never lands as an explicit undefined. */
function callSettingsFor(
  parameters: CallParameters,
  options: InferOptions,
  provider: OpenRouterProvider
): OptionalCallSettings {
  return {
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    ...(parameters.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: parameters.maxOutputTokens }),
    ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature }),
    ...(parameters.topP === undefined ? {} : { topP: parameters.topP }),
    // Call-level `providerOptions.openrouter` spreads OVER the model-settings
    // args in the provider's doStream, so this is the reasoning config's
    // authoritative wire path.
    ...(parameters.reasoning === undefined
      ? {}
      : { providerOptions: { openrouter: { reasoning: parameters.reasoning } } }),
    ...(options.tools === undefined
      ? {}
      : {
          tools: buildToolset(options.tools, provider),
          stopWhen: stepCountIs(options.tools.maxSteps),
        }),
  };
}

/**
 * The stream-loop failure disposition: adapter defects stay exceptions;
 * everything else classifies to a typed InferenceError. With the
 * require-parameters routing guard pinned on reasoning calls, a no-providers
 * refusal on one means the reasoning config itself narrowed the endpoint
 * pool to zero — re-typed so callers can render a targeted next action.
 */
function streamFailure(error: unknown, parameters: CallParameters): Error {
  if (error instanceof AdapterDefect) return error;
  const classified = classifyInferenceFailure(error);
  if (classified.code === 'no_providers_available' && parameters.reasoning !== undefined) {
    return noReasoningEndpointsError(classified);
  }
  return classified;
}

/**
 * The turn's system prompt, or none at all.
 *
 * The server-owned base preamble rides every ANSWER turn (paid and trial), and
 * client custom instructions fold into it. A ROUTING-ONLY call carries no
 * preamble: its own prompt is the whole instruction, and its reserve prices
 * exactly that — the preamble would be input no reservation covered.
 */
function systemPromptFor(request: InferenceRequest, now: () => Date): string | undefined {
  if (request.routingOnly === true) return undefined;
  return buildTurnSystemPrompt({
    now: now(),
    ...(request.customInstructions === undefined
      ? {}
      : { customInstructions: request.customInstructions }),
  });
}

async function* inferLanguage(input: InferStreamInput): AsyncGenerator<InferenceEvent> {
  const { provider, request, options, now } = input;
  const parameters = parseCallParameters(request.parameters);
  const content = toUserContent(request.inputs);

  const system = systemPromptFor(request, now);

  const result = streamText({
    // `.chat()` (not the callable `openrouter(model)`, whose overloads infer
    // the completion model). The routing settings pin ZDR + no-collection +
    // no-fallbacks and enable inline usage/cost accounting; a reasoning call
    // additionally pins the require-parameters routing guard so an endpoint
    // can never silently drop the reasoning config.
    model: provider.chat(
      request.model,
      languageRoutingOptions({ reasoning: parameters.reasoning !== undefined })
    ),
    ...(system === undefined ? {} : { system }),
    messages: [...toHistoryMessages(request.history), { role: 'user', content }],
    // Retry policy lives with callers via the lib/resilience policy factory —
    // the SDK's built-in retry would be a second mechanism, and its RetryError
    // buries the provider error in an array the classifier cannot chain-walk.
    maxRetries: 0,
    // The SDK's default onError is console.error; errors already reach the
    // caller as typed throws from the fullStream loop, and raw console output
    // is banned (telemetry rides the SafeLogFields logger).
    onError: noopOnError,
    ...callSettingsFor(parameters, options, provider),
  });

  const state: StreamState = {
    sawText: false,
    sawMedia: false,
    toolError: undefined,
    finishPart: undefined,
    stepGenerationIds: [],
    totalCostUsd: 0,
    sawCost: false,
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
    throw streamFailure(error, parameters);
  }

  const finishPart = state.finishPart;
  if (finishPart === undefined) throw truncatedStreamError();
  throwForEmptyTurn(state, finishPart.finishReason);

  // Single-step runs carry the generationId on the terminal finish; on
  // multi-step runs each step-finish already carried its own. The terminal
  // cost is the sum of the per-step inline costs — the run's billing truth.
  const generationId =
    state.stepGenerationIds.length === 1 ? state.stepGenerationIds[0] : undefined;
  const providerCostUsd = state.sawCost ? state.totalCostUsd : undefined;
  yield {
    kind: 'finish',
    metadata: {
      ...(generationId === undefined ? {} : { generationId }),
      ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
      usage: mapUsage(finishPart.totalUsage),
      finishReason: finishPart.finishReason,
    },
  };
}

export function createLanguageAdapter(options: CreateLanguageAdapterOptions): ModelProvider {
  const provider = createOpenRouterProvider(options);
  const now = options.now ?? ((): Date => new Date());

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
      return inferLanguage({ provider, request, options: inferOptions, now });
    },
  };
}
