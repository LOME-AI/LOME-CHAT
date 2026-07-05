import { MediaValue, callShapeFamilyFor } from '@hushbox/shared';
import { err, ok } from '../../../lib/result/index.js';
import { validateNodeInput } from './node-input.js';
import type {
  InferenceEvent,
  InferenceRequest,
  InputPart,
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
   * The catalog estimate for the observed usage, in base (pre-markup) nano-USD.
   * Used as the billed cost only on the estimate paths (image, missing/absurd
   * provider cost); settlement applies the markup once.
   */
  readonly price: (usage: Usage) => Result<bigint, DomainError>;
}

export interface ModelCallExecutionDeps {
  readonly provider: ModelProvider;
  readonly binding: ModelBinding;
  readonly schemas: SchemaNameRegistry;
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
  const request: InferenceRequest = {
    model: node.model,
    inputs: [part],
    parameters: node.params,
    outputs: deps.binding.descriptor.outputs,
  };
  return streamCall(deps, request, ctx);
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
}

async function streamCall(
  deps: ModelCallExecutionDeps,
  request: InferenceRequest,
  ctx: NodeRunContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const accumulator: CallAccumulator = {
    text: '',
    media: undefined,
    usage: undefined,
    terminalCostUsd: undefined,
    stepCostSumUsd: 0,
    sawStepCost: false,
  };
  try {
    for await (const event of deps.provider.infer(request, deps.binding.descriptor, {
      signal: ctx.signal,
    })) {
      ctx.emit?.(event);
      absorb(accumulator, event);
    }
  } catch (error) {
    if (isInferenceError(error)) return err({});
    throw error;
  }
  const value = accumulator.media ?? accumulator.text;
  return decideCost(deps, request, accumulator).map((charge) => ({
    value,
    costNanoUsd: charge.costNanoUsd,
    isEstimated: charge.isEstimated,
  }));
}

/**
 * The inline-cost decision. Image always bills the estimate (no inline cost by
 * design), no alert. Text/video/embedding bill the authoritative inline cost;
 * when it is missing, negative, or absurd, they fall back to the estimate,
 * flag `isEstimated`, and fire a Sentry alert.
 */
function decideCost(
  deps: ModelCallExecutionDeps,
  request: InferenceRequest,
  accumulator: CallAccumulator
): Result<{ costNanoUsd: bigint; isEstimated: boolean }, NodeRunError> {
  const estimate = accumulator.usage === undefined ? ok(0n) : deps.binding.price(accumulator.usage);
  const family = callShapeFamilyFor(deps.binding.descriptor.outputs);

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
    if (event.providerCostUsd !== undefined) {
      accumulator.stepCostSumUsd += event.providerCostUsd;
      accumulator.sawStepCost = true;
    }
    return;
  }
  if (event.kind === 'finish') {
    accumulator.usage = event.metadata.usage;
    accumulator.terminalCostUsd = event.metadata.providerCostUsd;
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
