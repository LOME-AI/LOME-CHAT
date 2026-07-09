import { MediaValue, callShapeFamilyFor } from '@hushbox/shared';
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import { validateNodeInput } from './node-input.js';
import type {
  CallShapeFamily,
  InferenceEvent,
  InferenceRequest,
  InputPart,
  Modality,
  ModelDescriptor,
  Node,
  NodePortDeclaration,
  SchemaNameRegistry,
  Usage,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { ModelProvider } from '../../models/index.js';
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
 * Money never moves here, but the base (pre-markup) cost is decided here and
 * carried up for settlement to charge once. OpenRouter returns the
 * authoritative inline cost for text and video (summed across agentic steps on
 * the terminal finish), which is charged directly (`isEstimated=false`). Image
 * carries no inline cost by design, so it always bills the deterministic
 * catalog estimate (`isEstimated=true`). A missing text/video cost is
 * pathological: it falls back to the estimate, flags `isEstimated`, and fires a
 * Sentry alert. A negative or absurd provider cost takes the same fallback.
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
   * The catalog token estimate for observed language/embedding usage, in base
   * (pre-markup) nano-USD. Used as the billed cost only on the
   * missing/absurd-provider-cost fallback; settlement applies the markup once.
   */
  readonly price: (usage: Usage) => Result<bigint, DomainError>;
  /**
   * Deterministic media price (base, pre-markup nano-USD) from catalog rates
   * and the call's request parameters — image's billed amount, video's
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
   * Injected money conversion (nodes stay pure — no slice-barrel value imports).
   * Converts the provider's inline USD cost to base (pre-markup) nano-USD.
   */
  readonly usdToNanoUsd: (usd: number) => bigint;
  /**
   * Best-effort alerting for the pathological missing/absurd provider-cost
   * path (never for image, whose estimate is expected). Optional so pure-logic
   * tests and unwired call sites run without it; production supplies it.
   */
  readonly telemetry?: Telemetry;
}

/** The slice of NodeRunContext one streamed call consumes. */
export interface ModelCallStreamContext {
  readonly signal: AbortSignal;
  readonly emit?: (event: InferenceEvent) => void;
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
  // Run-scoped client history rides the ctx (the only per-run channel to
  // DO-scoped executions); empty normalizes to absent so a history-free run
  // produces exactly the pre-history request shape.
  const history = ctx.history;
  const request: InferenceRequest = {
    model: node.model,
    inputs: [part],
    parameters: node.params,
    outputs: deps.binding.descriptor.outputs,
    ...(history === undefined || history.length === 0 ? {} : { history: [...history] }),
  };
  return streamModelCall(deps, request, ctx);
}

interface CallAccumulator {
  text: string;
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
    media: undefined,
    usage: undefined,
    terminalCostUsd: undefined,
    stepCostSumUsd: 0,
    sawStepCost: false,
    generationId: undefined,
  };
  try {
    for await (const event of deps.provider.infer(request, deps.binding.descriptor, {
      signal: ctx.signal,
    })) {
      ctx.emit?.(event);
      absorb(accumulator, event);
    }
  } catch (error) {
    // Doctrine: an explicit stop or a deadline breach with streamed partial
    // output settles like a normal partial and IS billed; only a run that
    // produced nothing bills nothing.
    if (isAborted(error)) return settleAbortedPartial(deps, request, accumulator);
    if (isInferenceError(error)) return err({});
    throw error;
  }
  const value = accumulator.media ?? accumulator.text;
  const billing = billingMetadataOf(deps.binding.descriptor, accumulator.generationId);
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
  const value = accumulator.media ?? accumulator.text;
  if (value === '') return err({});
  const billing = billingMetadataOf(deps.binding.descriptor, accumulator.generationId);
  const inlineUsd = usableAbortCostUsd(accumulator);
  if (inlineUsd !== undefined) {
    return ok({ value, costNanoUsd: deps.usdToNanoUsd(inlineUsd), isEstimated: false, billing });
  }
  if (accumulator.media !== undefined && deps.binding.priceMedia !== undefined) {
    const estimate = deps.binding.priceMedia(request.parameters);
    if (estimate.isOk()) {
      return ok({ value, costNanoUsd: estimate.value, isEstimated: true, billing });
    }
  }
  return ok({ value, costNanoUsd: 0n, isEstimated: true, billing });
}

/** The observed cost an aborted partial may bill: finite and non-negative. */
function usableAbortCostUsd(accumulator: CallAccumulator): number | undefined {
  const inlineUsd = inlineCostUsdOf(accumulator);
  if (inlineUsd === undefined || !Number.isFinite(inlineUsd) || inlineUsd < 0) return undefined;
  return inlineUsd;
}

/**
 * The generation's billing facts: the serving model + provider, the terminal
 * generation id, and the billing modality — the first declared non-text output
 * (the media/embedding artifact drives the billing category), else text. A
 * concrete modality every time, derived from the descriptor's declared outputs.
 */
function billingMetadataOf(
  descriptor: ModelDescriptor,
  generationId: string | undefined
): NodeBillingMetadata {
  return {
    modelId: descriptor.id,
    providerName: descriptor.provider,
    modality: billingModalityOf(descriptor.outputs),
    ...(generationId === undefined ? {} : { generationId }),
  };
}

function billingModalityOf(outputs: readonly Modality[]): Modality {
  return outputs.find((modality) => modality !== 'text') ?? 'text';
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
    const inlineBase = validInlineBase(inlineCostUsdOf(accumulator), estimate, deps.usdToNanoUsd);
    if (inlineBase !== undefined) {
      return ok({ costNanoUsd: inlineBase, isEstimated: false });
    }
    // Pathological — a missing, negative, or absurd cost. Alert (model id only,
    // never content), then bill the estimate: never charge 0, never skip.
    deps.telemetry?.warn('inference provider cost unavailable; billing catalog estimate', {
      modelName: request.model,
    });
    deps.telemetry?.captureError(
      new Error('inference provider cost unavailable; settlement billed the catalog estimate'),
      'inference_provider_cost_unavailable'
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
 * The base nano-USD to charge for a valid inline cost, or undefined when it is
 * missing, negative/non-finite, or absurdly large relative to the estimate
 * (each routed to the estimate+alert fallback).
 */
function validInlineBase(
  inlineUsd: number | undefined,
  estimate: Result<bigint, DomainError>,
  usdToNanoUsd: (usd: number) => bigint
): bigint | undefined {
  if (inlineUsd === undefined || !Number.isFinite(inlineUsd) || inlineUsd < 0) return undefined;
  const base = usdToNanoUsd(inlineUsd);
  if (
    estimate.isOk() &&
    estimate.value > 0n &&
    base > estimate.value * PROVIDER_COST_SANITY_MULTIPLE
  ) {
    return undefined;
  }
  return base;
}

function absorb(accumulator: CallAccumulator, event: InferenceEvent): void {
  if (event.kind === 'text-delta') {
    accumulator.text += event.content;
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
