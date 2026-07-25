import {
  ERROR_CODES,
  MediaValue,
  callShapeFamilyFor,
  compileParamSpec,
  serializeReasoningText,
} from '@hushbox/shared';
import { validationError } from '../../../lib/errors/index.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import { err, ok } from '../../../lib/result/index.js';
import { validateNodeInput } from './node-input.js';
import type {
  CallShapeFamily,
  CompletionTokens,
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  InputPart,
  MediaGenerationFacts,
  Modality,
  ModelDescriptor,
  Node,
  NodePortDeclaration,
  SchemaNameRegistry,
  Usage,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type {
  InferenceErrorCode,
  InferOptions,
  ModelProvider,
  ToolLoopOptions,
} from '../../models/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  NodeBillingMetadata,
  NodeExecution,
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
} from '../engine/execution-registry.js';

/**
 * The `modelCall` capability execution: one gateway generation (or an agentic
 * loop) over the `ModelProvider` port. It is streaming-terminal — when the
 * engine hands it an `emit` seam, every inference event rides the run's stream
 * to the client; otherwise the node resolves quietly to its value.
 *
 * Money never moves here, but the BILLABLE cost is decided here and carried up
 * for settlement to charge as-is. OpenRouter returns the authoritative inline
 * cost for text and video (summed across agentic steps on the terminal
 * finish); the injected port conversion turns it billable — the only markup
 * application on the money path — and it is charged directly
 * (`isEstimated=false`). Image carries no inline cost by design, so it always
 * bills the deterministic billable catalog estimate (`isEstimated=true`). A
 * missing text/video cost is pathological: it falls back to the billable
 * estimate, flags `isEstimated`, and fires a Sentry alert. A negative or
 * absurd provider cost takes the same fallback.
 */

type ModelCallNode = Extract<Node, { type: 'modelCall' }>;

/**
 * A provider cost more than this multiple of the catalog estimate is treated as
 * corrupt (e.g. a provider-side units bug) and rejected to the estimate path.
 * The bound is deliberately generous — the documented worst-case estimate
 * discrepancy is ~4.4×, so a legitimate cost never approaches this; only a
 * clearly-broken figure trips it. Only applied when an estimate exists.
 */
const PROVIDER_COST_SANITY_MULTIPLE = 1000n;

/** A model resolved from the catalog: its descriptor, declared ports, and pricer. */
export interface ModelBinding {
  readonly descriptor: ModelDescriptor;
  readonly ports: NodePortDeclaration;
  /**
   * The catalog token estimate for observed language/embedding usage, in
   * billable nano-USD (catalog rates are billable). Used as the billed cost
   * only on the missing/absurd-provider-cost fallback; settlement charges it
   * directly, with no further fee application.
   */
  readonly price: (usage: Usage) => Result<bigint, DomainError>;
  /**
   * Deterministic media price (billable nano-USD, from the billable catalog
   * rates) and the call's request parameters — image's billed amount, video's
   * fallback and sanity bound. Optional so language-only bindings (and their
   * test fakes) need not carry it; a media-family cost decision without it
   * fails closed.
   */
  readonly priceMedia?: (params: Record<string, unknown>) => Result<bigint, DomainError>;
}

/**
 * What one streamed provider call needs — the reusable core `smartModel`
 * shares for its classifier and answer generations.
 */
export interface ModelCallStreamDeps {
  readonly provider: ModelProvider;
  readonly binding: ModelBinding;
  /**
   * Injected port charge conversion (nodes stay pure — no slice-barrel value
   * imports). Converts the provider's inline USD cost to BILLABLE nano-USD —
   * the ModelProvider port seam, the only markup application on the money
   * path (BILLING.md §Fee Structure).
   */
  readonly usdToBillableNanoUsd: (usd: number) => bigint;
  /**
   * Best-effort alerting for the pathological missing/absurd provider-cost
   * path (never for image, whose estimate is expected). Optional so pure-logic
   * tests and unwired call sites run without it; production supplies it.
   */
  readonly telemetry?: Telemetry;
  /**
   * The agentic tool loop for this call: the resolved server-side tool registry
   * plus the step ceiling. Present only when the node declared tools (e.g. web
   * search); absent is a plain single-generation call. `smartModel` never sets
   * it, so its generations stay tool-free.
   */
  readonly tools?: ToolLoopOptions;
}

/** The slice of NodeRunContext one streamed call consumes. */
export interface ModelCallStreamContext {
  readonly signal: AbortSignal;
  readonly emit?: (event: InferenceEvent) => void;
  /**
   * Per-node mapper for provider-generated media files, injected by the engine
   * off `NodeRunContext`. Opaque here: the node forwards it to the provider
   * call untouched and never invokes or inspects it (engine purity).
   */
  readonly mapFilePart?: FilePartMapper;
  /**
   * The run's remaining ValueStore budget in bytes, forwarded to the provider
   * as the download byte cap so a media download aborts before it materializes
   * a blob the ValueStore would reject. A plain value, never the ValueStore
   * itself — the download stays outside the engine. Absent on non-modelCall
   * callers (e.g. smartModel's text generations), which download nothing.
   */
  readonly remainingBytes?: number;
}

export interface ModelCallExecutionDeps extends ModelCallStreamDeps {
  readonly schemas: SchemaNameRegistry;
}

export function createModelCallExecution(deps: ModelCallExecutionDeps): NodeExecution {
  return {
    streaming: true,
    run: (node, input, ctx) => runModelCall(deps, node as ModelCallNode, input, ctx),
  };
}

async function runModelCall(
  deps: ModelCallExecutionDeps,
  node: ModelCallNode,
  input: readonly unknown[],
  ctx: NodeRunContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const validated = validateNodeInput(deps.binding.ports, deps.schemas, input);
  if (validated.isErr()) return err(validated.error);
  const part = toInputPart(input[0]);
  if (part === undefined) return err({});
  // History and custom instructions are both run-scoped client context on the
  // ctx (the only per-run channel to DO-scoped executions), never baked into
  // the definition. Empty/absent normalizes so a bare run produces exactly the
  // pre-history request shape; custom instructions fold into the base system
  // prompt at the language adapter.
  const history = ctx.history;
  const customInstructions = ctx.customInstructions;
  const request: InferenceRequest = {
    model: node.model,
    inputs: [part],
    parameters: node.params,
    outputs: deps.binding.descriptor.outputs,
    ...(history === undefined || history.length === 0 ? {} : { history: [...history] }),
    ...(customInstructions === undefined ? {} : { customInstructions }),
  };
  // Per-model discrete video-duration pre-flight: a model that declares a
  // supported-duration set rejects an out-of-set requested duration here, before
  // any provider call — legacy's per-model UNSUPPORTED_DURATION. A model with no
  // declared set carries no such spec, so any duration passes (legacy's
  // "undefined ⇒ unconstrained"); only video declares it, so language/image are
  // never gated. smartModel's generations bypass this entry via streamModelCall.
  if (durationOutOfSupportedSet(deps.binding.descriptor, request.parameters)) {
    return err({ reason: ERROR_CODES.UNSUPPORTED_DURATION });
  }
  // The remaining ValueStore budget read straight off the engine's store —
  // `budgetBytes − usedBytes()` — becomes the download's byte cap so an
  // oversized video aborts mid-download rather than at the `store()` backstop.
  const remainingBytes = ctx.values.budgetBytes - ctx.values.usedBytes();
  return streamModelCall(deps, request, {
    signal: ctx.signal,
    remainingBytes,
    ...(ctx.emit === undefined ? {} : { emit: ctx.emit }),
    ...(ctx.mapFilePart === undefined ? {} : { mapFilePart: ctx.mapFilePart }),
  });
}

/**
 * True when the descriptor declares a discrete supported-duration set and the
 * requested `durationSeconds` falls outside it. Validated through the shared
 * ParamSpec compiler (the same enum-membership authority admission uses) against
 * the single duration field, so the check is scoped to duration alone — other
 * request params are left to the adapter. A descriptor with no `durationSeconds`
 * enum spec (a non-video model, or a video model that declared no durations)
 * returns false: the duration is unconstrained.
 */
function durationOutOfSupportedSet(
  descriptor: ModelDescriptor,
  params: Record<string, unknown>
): boolean {
  const spec = descriptor.parameters['durationSeconds'];
  if (spec?.type !== 'enum' || spec.values === undefined) return false;
  return !compileParamSpec({ durationSeconds: spec }).safeParse({
    durationSeconds: params['durationSeconds'],
  }).success;
}

/**
 * The provider `infer` options for one streamed call: the run signal, the
 * optional agentic tool loop, the per-node file mapper, and the download byte
 * cap (the run's remaining ValueStore budget). Each rides only when present.
 */
function inferOptionsOf(deps: ModelCallStreamDeps, ctx: ModelCallStreamContext): InferOptions {
  return {
    signal: ctx.signal,
    ...(deps.tools === undefined ? {} : { tools: deps.tools }),
    ...(ctx.mapFilePart === undefined ? {} : { mapFilePart: ctx.mapFilePart }),
    ...(ctx.remainingBytes === undefined ? {} : { downloadByteCap: ctx.remainingBytes }),
  };
}

interface CallAccumulator {
  text: string;
  /**
   * Streamed reasoning text, embedded ahead of the answer in the resolved
   * value via the shared canonical inline format (same-field storage doctrine:
   * assistant text persists exactly as received, reasoning included). Models
   * that reason without streaming text (o-series) leave this empty and resolve
   * the answer verbatim — the serializer never wraps an empty reasoning.
   */
  reasoning: string;
  media: MediaValue | undefined;
  usage: Usage | undefined;
  /**
   * The run's authoritative inline provider cost (USD). The terminal finish
   * carries it — already summed across agentic steps by the adapter — so it is
   * the single source; `stepCostSumUsd` is the fallback if only per-step costs
   * were emitted.
   */
  terminalCostUsd: number | undefined;
  stepCostSumUsd: number;
  sawStepCost: boolean;
  /**
   * The terminal gateway generation id: the last step-finish's id, or the
   * finish metadata's id when the provider carries one there (which wins). Keys
   * the settlement charge's per-generation record.
   */
  generationId: string | undefined;
}

/**
 * One streamed generation over the ModelProvider port, from request to the
 * cost decision: events optionally ride `ctx.emit`, the resolved value and
 * base cost come back for the caller to lift. Shared by the `modelCall`
 * execution and both of `smartModel`'s generations.
 */
export async function streamModelCall(
  deps: ModelCallStreamDeps,
  request: InferenceRequest,
  ctx: ModelCallStreamContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const accumulator: CallAccumulator = {
    text: '',
    reasoning: '',
    media: undefined,
    usage: undefined,
    terminalCostUsd: undefined,
    stepCostSumUsd: 0,
    sawStepCost: false,
    generationId: undefined,
  };
  // Every client-visible stream labels itself first: `request.model` is the
  // provider-facing id actually called (smartModel passes its RESOLVED
  // candidate here; its classifier runs with no emit and stays invisible).
  // Emitted, never absorbed — the label can't touch the accumulated value,
  // cost, or billing facts.
  ctx.emit?.(streamStartEvent(deps.binding.descriptor, request.model));
  try {
    for await (const event of deps.provider.infer(
      request,
      deps.binding.descriptor,
      inferOptionsOf(deps, ctx)
    )) {
      ctx.emit?.(event);
      absorb(accumulator, event);
    }
  } catch (error) {
    // Doctrine: an explicit stop or a deadline breach with streamed partial
    // output settles like a normal partial and IS billed; only a run that
    // produced nothing bills nothing.
    if (isAborted(error)) return settleAbortedPartial(deps, request, accumulator);
    if (isInferenceError(error)) return err(inferenceNodeError(error));
    throw error;
  }
  const value = accumulator.media ?? textValueOf(accumulator);
  const billing = billingMetadataOf(deps.binding.descriptor, request, accumulator);
  return decideCost(deps, request, accumulator).map((charge) => ({
    value,
    costNanoUsd: charge.costNanoUsd,
    isEstimated: charge.isEstimated,
    billing,
  }));
}

/**
 * The stop/deadline abort outcome: the accumulated partial resolves as a
 * normal node success so the run settles and bills it. With nothing
 * accumulated the node fails — a stopped run that produced nothing stays
 * "stopped, zero billed". Cost precedence: a completed step's inline cost is
 * exact (`isEstimated=false`); a fully-accumulated media artifact with no
 * inline cost bills its deterministic catalog estimate (`isEstimated=true`) —
 * the artifact is complete, so the deterministic price is the real cost. A
 * text partial with no observed cost bills 0n flagged `isEstimated` — a
 * deliberate tradeoff (no token estimation is invented for an interrupted
 * stream), and expected, so no alert fires. A pricing failure never fails the
 * abort settlement — it falls back to the 0n path.
 */
function settleAbortedPartial(
  deps: ModelCallStreamDeps,
  request: InferenceRequest,
  accumulator: CallAccumulator
): Result<NodeRunSuccess, NodeRunError> {
  const value = accumulator.media ?? textValueOf(accumulator);
  if (value === '') return err({});
  const billing = billingMetadataOf(deps.binding.descriptor, request, accumulator);
  const inlineUsd = usableAbortCostUsd(accumulator);
  if (inlineUsd !== undefined) {
    return ok({
      value,
      costNanoUsd: deps.usdToBillableNanoUsd(inlineUsd),
      isEstimated: false,
      billing,
    });
  }
  if (accumulator.media !== undefined && deps.binding.priceMedia !== undefined) {
    const estimate = deps.binding.priceMedia(request.parameters);
    if (estimate.isOk()) {
      return ok({ value, costNanoUsd: estimate.value, isEstimated: true, billing });
    }
  }
  return ok({ value, costNanoUsd: 0n, isEstimated: true, billing });
}

/**
 * The resolved text value of a generation: streamed reasoning embedded ahead
 * of the answer in the shared canonical inline format, or the answer verbatim
 * when none streamed. Built ONLY through the shared serializer — the delimiter
 * never appears outside `@hushbox/shared`'s reasoning-format module. Applies to
 * the success and aborted-partial paths alike, so a reasoning-only partial is
 * non-empty accumulated content (billable under the partial-settle doctrine).
 */
function textValueOf(accumulator: CallAccumulator): string {
  return serializeReasoningText(accumulator.reasoning, accumulator.text);
}

/** The observed cost an aborted partial may bill: finite and non-negative. */
function usableAbortCostUsd(accumulator: CallAccumulator): number | undefined {
  const inlineUsd = inlineCostUsdOf(accumulator);
  if (inlineUsd === undefined || !Number.isFinite(inlineUsd) || inlineUsd < 0) return undefined;
  return inlineUsd;
}

/**
 * The generation's billing facts: the serving model + provider, the terminal
 * generation id, the billing modality — the first declared non-text output
 * (the media/embedding artifact drives the billing category), else text — and
 * the dimension the charge records: token counts for a language generation, the
 * declared image/video dimensions for a media one. A concrete modality every
 * time, derived from the descriptor's declared outputs.
 */
function billingMetadataOf(
  descriptor: ModelDescriptor,
  request: InferenceRequest,
  accumulator: CallAccumulator
): NodeBillingMetadata {
  const modality = billingModalityOf(descriptor.outputs);
  const tokens = modality === 'text' ? tokensOf(accumulator.usage) : undefined;
  const media = mediaFactsOf(modality, request.parameters);
  return {
    modelId: descriptor.id,
    providerName: descriptor.provider,
    modality,
    ...(accumulator.generationId === undefined ? {} : { generationId: accumulator.generationId }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(media === undefined ? {} : { media }),
  };
}

/**
 * The stream label. A media-family (image/video) call additionally carries its
 * output modality — the EARLY per-node media signal (the provider call is one
 * long non-streaming await, so nothing else reaches the client until
 * completion; clients swap the tile to "Generating…" on it, and the chat
 * runtime's video progress sweep keys on it). Language/embedding stream-starts
 * stay modality-free.
 */
function streamStartEvent(descriptor: ModelDescriptor, modelId: string): InferenceEvent {
  const family = callShapeFamilyFor(descriptor.outputs);
  const outputModality =
    family === 'image' || family === 'video' ? billingModalityOf(descriptor.outputs) : undefined;
  return {
    kind: 'stream-start',
    modelId,
    ...(outputModality === undefined ? {} : { outputModality }),
  };
}

function billingModalityOf(outputs: readonly Modality[]): Modality {
  return outputs.find((modality) => modality !== 'text') ?? 'text';
}

/** The observed token dimension of a language generation, absent when none was reported. */
function tokensOf(usage: Usage | undefined): CompletionTokens | undefined {
  if (usage === undefined) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
  };
}

/**
 * The media dimension read off the call's declared parameters — image count +
 * size for an image generation, resolution + duration for a video one (the same
 * parameter names the image/video adapters consume). Only defined for the media
 * families; language/embedding generations carry no media dimension.
 */
function mediaFactsOf(
  modality: Modality,
  params: Record<string, unknown>
): MediaGenerationFacts | undefined {
  if (modality === 'image') {
    const n = numberParameter(params['n']);
    const size = stringParameter(params['size']);
    return {
      imageCount: n ?? 1,
      ...(size === undefined ? {} : { resolution: size }),
    };
  }
  if (modality === 'video') {
    const durationSeconds = numberParameter(params['durationSeconds']);
    const resolution = stringParameter(params['resolution']);
    const facts: MediaGenerationFacts = {
      ...(durationSeconds === undefined ? {} : { durationMs: Math.round(durationSeconds * 1000) }),
      ...(resolution === undefined ? {} : { resolution }),
    };
    // No declared dimensions → carry none (the media_generations row still lands
    // on modality alone). Image always carries a count, so it never reaches here.
    return Object.keys(facts).length === 0 ? undefined : facts;
  }
  return undefined;
}

function numberParameter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringParameter(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The inline-cost decision. Image always bills the estimate (no inline cost by
 * design), no alert. Text/video/embedding bill the authoritative inline cost;
 * when it is missing, negative, or absurd, they fall back to the estimate,
 * flag `isEstimated`, and fire a Sentry alert.
 */
function decideCost(
  deps: ModelCallStreamDeps,
  request: InferenceRequest,
  accumulator: CallAccumulator
): Result<{ costNanoUsd: bigint; isEstimated: boolean }, NodeRunError> {
  const family = callShapeFamilyFor(deps.binding.descriptor.outputs);
  const estimate = estimateOf(deps, request, accumulator, family);

  // Image never carries an inline cost by design; it always bills the estimate,
  // and that is expected — no alert. Every other family should carry the
  // authoritative inline cost; use it when valid.
  if (family !== 'image') {
    const inlineBillable = validInlineBillable(
      inlineCostUsdOf(accumulator),
      estimate,
      deps.usdToBillableNanoUsd
    );
    if (inlineBillable !== undefined) {
      return ok({ costNanoUsd: inlineBillable, isEstimated: false });
    }
    // Pathological — a missing, negative, or absurd cost. Alert (model id only,
    // never content), then bill the estimate: never charge 0, never skip.
    deps.telemetry?.warn('inference provider cost unavailable; billing catalog estimate', {
      modelName: request.model,
    });
    deps.telemetry?.captureError(
      new Error('inference provider cost unavailable; settlement billed the catalog estimate'),
      FINGERPRINT_CODES.inferenceProviderCostUnavailable
    );
  }

  // The estimate path (image, or the missing/absurd fallback). A pricing failure
  // leaves no priceable amount — the error carries none (see the
  // NodeRunError.costNanoUsd contract).
  if (estimate.isErr()) return err({});
  return ok({ costNanoUsd: estimate.value, isEstimated: true });
}

/**
 * The estimate feeding the cost decision. Media families (image/video) price
 * DETERMINISTICALLY from catalog rates + the call's request parameters —
 * observed token usage cannot price them; language/embedding price observed
 * usage at catalog token rates. A media binding without a media pricer fails
 * closed (production bindings always carry one).
 */
function estimateOf(
  deps: ModelCallStreamDeps,
  request: InferenceRequest,
  accumulator: CallAccumulator,
  family: CallShapeFamily | undefined
): Result<bigint, DomainError> {
  if (family === 'image' || family === 'video') {
    return deps.binding.priceMedia === undefined
      ? err(validationError('Model binding carries no media pricer for a media-family call'))
      : deps.binding.priceMedia(request.parameters);
  }
  return accumulator.usage === undefined ? ok(0n) : deps.binding.price(accumulator.usage);
}

/** The authoritative inline cost: the terminal sum, else the per-step fallback. */
function inlineCostUsdOf(accumulator: CallAccumulator): number | undefined {
  if (accumulator.terminalCostUsd !== undefined) return accumulator.terminalCostUsd;
  if (accumulator.sawStepCost) return accumulator.stepCostSumUsd;
  return undefined;
}

/**
 * The billable nano-USD to charge for a valid inline cost, or undefined when
 * it is missing, negative/non-finite, or absurdly large relative to the
 * billable catalog estimate (each routed to the estimate+alert fallback). The
 * sanity bound compares billable to billable — both sides carry the same
 * baked fee, so the ratio is fee-free.
 */
function validInlineBillable(
  inlineUsd: number | undefined,
  estimate: Result<bigint, DomainError>,
  usdToBillableNanoUsd: (usd: number) => bigint
): bigint | undefined {
  if (inlineUsd === undefined || !Number.isFinite(inlineUsd) || inlineUsd < 0) return undefined;
  const billable = usdToBillableNanoUsd(inlineUsd);
  if (
    estimate.isOk() &&
    estimate.value > 0n &&
    billable > estimate.value * PROVIDER_COST_SANITY_MULTIPLE
  ) {
    return undefined;
  }
  return billable;
}

function absorb(accumulator: CallAccumulator, event: InferenceEvent): void {
  if (event.kind === 'text-delta') {
    accumulator.text += event.content;
    return;
  }
  if (event.kind === 'reasoning-delta') {
    accumulator.reasoning += event.content;
    return;
  }
  if (event.kind === 'media-done') {
    accumulator.media = event.value;
    return;
  }
  if (event.kind === 'step-finish') {
    // Last step wins: an agentic run's terminal generation is its final step.
    accumulator.generationId = event.generationId;
    if (event.providerCostUsd !== undefined) {
      accumulator.stepCostSumUsd += event.providerCostUsd;
      accumulator.sawStepCost = true;
    }
    return;
  }
  if (event.kind === 'finish') {
    accumulator.usage = event.metadata.usage;
    accumulator.terminalCostUsd = event.metadata.providerCostUsd;
    // A generation id on the terminal finish is the authoritative terminal id;
    // it wins over the last step-finish's.
    if (event.metadata.generationId !== undefined) {
      accumulator.generationId = event.metadata.generationId;
    }
  }
}

const REF_MODALITIES: ReadonlySet<string> = new Set(['image', 'audio', 'video']);

function toInputPart(value: unknown): InputPart | undefined {
  if (typeof value === 'string') return { modality: 'text', text: value };
  const media = MediaValue.safeParse(value);
  if (media.success && REF_MODALITIES.has(media.data.modality)) {
    return {
      modality: media.data.modality as 'image' | 'audio' | 'video',
      ref: {
        ref: media.data.ref,
        mimeType: media.data.mimeType,
        byteLength: media.data.byteLength,
      },
    };
  }
  return undefined;
}

/**
 * Expected inference failures surface as thrown `InferenceError`s (the port's
 * stream has no error variant). Recognized structurally so node code stays
 * free of a slice-barrel value import; anything else rethrows to the
 * interpreter's defect path.
 */
function isInferenceError(error: unknown): boolean {
  return error instanceof Error && error.name === 'InferenceError';
}

/** A user-stop/deadline abort: the InferenceError the adapters code 'aborted'. */
function isAborted(error: unknown): boolean {
  return isInferenceError(error) && (error as { code?: unknown }).code === 'aborted';
}

/**
 * The node's failure result for a thrown `InferenceError`. A reason with a
 * targeted client next action (content policy, context length, network) is
 * carried as the run's wire code; every other reason leaves it absent so the
 * engine keeps its generic node-failure code (`UNAVAILABLE`). The reason is a
 * code, never content — this stays inside node purity (no slice-barrel value
 * import; the InferenceError code is read structurally).
 */
function inferenceNodeError(error: unknown): NodeRunError {
  const code = (error as { code?: InferenceErrorCode }).code;
  if (code === 'content_policy') return { reason: ERROR_CODES.CONTENT_POLICY };
  if (code === 'context_length') return { reason: ERROR_CODES.CONTEXT_LENGTH_EXCEEDED };
  if (code === 'network') return { reason: ERROR_CODES.NETWORK_ERROR };
  if (code === 'no_reasoning_endpoints') return { reason: ERROR_CODES.NO_REASONING_ENDPOINTS };
  return {};
}
