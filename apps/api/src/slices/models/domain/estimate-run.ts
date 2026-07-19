import { match } from 'ts-pattern';
import { callShapeFamilyFor, nanoUSD } from '@hushbox/shared';
import {
  WORST_CASE_SEARCH_RESERVATION_NANO_USD,
  estimateRunCeilingNanoUsd,
  mediaCallUsageFor,
} from './estimate.js';
import { WEB_SEARCH_TOOL_NAME } from './tool-registry.js';
import { validationError } from '../../../lib/errors/index.js';
import { Result, err, ok } from '../../../lib/result/index.js';
import type {
  CallShapeFamily,
  ModelDescriptor,
  NanoUSD,
  Node,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { CallUsage, DeclaredCeiling } from './estimate.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The whole-definition admission ceiling. Admission places a hold for a
 * run's WORST-CASE cost before it starts and refuses the run if the wallet
 * cannot cover it, so this is a deliberate over-estimate: a low-balance user
 * is briefly blocked from a run that would have been cheaper, whereas
 * under-estimating under-reserves and takes on real exposure. This number is
 * NOT what the run is charged — settlement bills the provider's actual cost;
 * this is only the pre-authorization ceiling and the basis for the mid-run
 * runaway-cost circuit. Fail-closed on any unpriceable node: a `Result` error
 * makes admission refuse, never a low estimate.
 */

/** Resolves a model id to its catalog descriptor, or `undefined` if absent. */
export type ModelPricingResolver = (modelId: string) => ModelDescriptor | undefined;

/** The injected estimator the interpreter receives as a single-arg dep. */
export type EstimateRun = (definition: WorkflowDefinition) => Result<NanoUSD, DomainError>;

const CONTEXT_LENGTH_LIMIT = 'contextLength';

type ModelCallNode = Extract<Node, { type: 'modelCall' }>;

type SmartModelNode = Extract<Node, { type: 'smartModel' }>;

/** Enclosing multipliers accumulated from a model node's ancestor containers. */
interface EnclosureFactors {
  readonly fanOut: number;
  readonly loop: number;
}

interface ParentLink {
  readonly parent: string;
  readonly fanOut: number;
  readonly loop: number;
}

/** One containment edge: a child node id and the enclosing container's link. */
interface ContainmentEdge {
  readonly child: string;
  readonly link: ParentLink;
}

/**
 * The containment edges a single node introduces. Containment is expressed by
 * `body`/`cases`/`else` references, not array nesting: a `fanOut`/`loop` names
 * its body head, a `branch` names its case targets. Node types that enclose no
 * node in THIS definition contribute nothing — enumerated exhaustively so a new
 * node type forces a containment decision here rather than silently defaulting.
 */
function containmentEdges(node: Node): readonly ContainmentEdge[] {
  return match(node)
    .with({ type: 'fanOut' }, (n) => [
      { child: n.body, link: { parent: n.id, fanOut: n.maxWidth, loop: 1 } },
    ])
    .with({ type: 'loop' }, (n) => [
      { child: n.body, link: { parent: n.id, fanOut: 1, loop: n.maxIterations } },
    ])
    .with({ type: 'branch' }, (n) =>
      // A branch selects one path; it multiplies nothing but still passes its
      // own enclosure down to its targets.
      [...Object.values(n.cases), n.else].map((child) => ({
        child,
        link: { parent: n.id, fanOut: 1, loop: 1 },
      }))
    )
    .with(
      { type: 'modelCall' },
      { type: 'transform' },
      { type: 'fanIn' },
      { type: 'subWorkflow' },
      { type: 'smartModel' },
      () => []
    )
    .exhaustive();
}

/**
 * Reverse containment index: child node id → the containers that enclose it,
 * each carrying that container's per-axis multiplier contribution. The `end`
 * sentinel is not a real node, so it is dropped.
 */
function buildParentIndex(nodes: readonly Node[]): Map<string, ParentLink[]> {
  const parents = new Map<string, ParentLink[]>();
  for (const node of nodes) {
    for (const edge of containmentEdges(node)) {
      if (edge.child === 'end') continue;
      const list = parents.get(edge.child) ?? [];
      list.push(edge.link);
      parents.set(edge.child, list);
    }
  }
  return parents;
}

/**
 * A node's enclosure = the product of every ancestor container's contribution
 * per axis. Container references form a DAG (validated acyclic before a
 * definition reaches admission), so the memoized recursion terminates; a node
 * with multiple enclosing paths takes the largest — never under-reserve.
 */
function enclosureFor(
  nodeId: string,
  parents: Map<string, ParentLink[]>,
  memo: Map<string, EnclosureFactors>
): EnclosureFactors {
  const cached = memo.get(nodeId);
  if (cached !== undefined) return cached;
  let best: EnclosureFactors = { fanOut: 1, loop: 1 };
  for (const link of parents.get(nodeId) ?? []) {
    const ancestor = enclosureFor(link.parent, parents, memo);
    const candidate: EnclosureFactors = {
      fanOut: ancestor.fanOut * link.fanOut,
      loop: ancestor.loop * link.loop,
    };
    if (candidate.fanOut * candidate.loop > best.fanOut * best.loop) best = candidate;
  }
  memo.set(nodeId, best);
  return best;
}

/**
 * One model node's ceiling. Language: its per-token cost at the model's full
 * context window on BOTH the input and output legs — a strict upper bound,
 * since neither prompt nor completion can exceed the context window.
 * Image/video: the DETERMINISTIC catalog price for the node's declared call
 * params (per-image rate × count; per-second-at-resolution rate × duration) —
 * exact, not an over-estimate, since media pricing has no usage variance.
 * Either way scaled by declared fan-out width, agentic steps, and loop
 * iterations. Fail-closed if the model is unknown, unpriced, declares no
 * context-token limit (language), or carries unpriceable call params (media):
 * any of those means no true ceiling can be derived, so the run must be
 * refused — never mid-run.
 */
interface ModelCeilingCall {
  readonly modelId: string;
  readonly params: Record<string, unknown>;
  readonly maxSteps: number;
}

/**
 * Mirror of the workflows engine's `VALUE_STORE_BYTE_BUDGET_BYTES` (the 20 MB
 * in-memory ValueStore ceiling, assuming a ≥3× real-memory multiplier). Kept
 * local because the models domain cannot import it: a direct reach into
 * `workflows/engine` breaks the slice boundary, and importing the workflows
 * barrel would create a bidirectional slice dependency (workflows already
 * depends on models via the injected `estimateRun`). The single-source fix is
 * to hoist the constant into `@hushbox/shared`; until then this copy MUST stay
 * in sync with the engine's value.
 */
const VALUE_STORE_BYTE_BUDGET_BYTES = 20 * 1024 * 1024;

/**
 * The minimum plausible video bitrate (bits/second) below which no realistic
 * codec produces usable video. Deliberately far under the ~5 MB/s realistic
 * estimate: the admission size gate rejects a media output ONLY when even the
 * most aggressive encoding cannot fit the in-memory ValueStore budget, so this
 * floor must never over-estimate and false-reject content that would actually
 * fit. Founder-tunable knob — raising it trips the gate on shorter/smaller
 * declarations. The true output size is enforced separately at generation time.
 */
const VIDEO_FLOOR_BITS_PER_SECOND = 250_000;

/**
 * The minimum plausible bytes-per-megapixel for a compressed still image — well
 * below any realistic JPEG/PNG encoding, so only a pathologically large image
 * declaration trips the gate. Founder-tunable knob (see the video floor).
 */
const IMAGE_FLOOR_BYTES_PER_MEGAPIXEL = 50_000;

/** 720p pixel area — the baseline the video floor's resolution scaling divides by. */
const VIDEO_BASELINE_AREA_PIXELS = 1280 * 720;

/**
 * Pixel area of each named video resolution tier. A Map (not a plain object) so
 * a hostile resolution like `'constructor'` resolves to `undefined` instead of
 * an inherited member. Kept local to the floor estimate — the shared catalog
 * carries the tier names, not their pixel dimensions.
 */
const VIDEO_RESOLUTION_AREA_PIXELS = new Map<string, number>([
  ['720p', 1280 * 720],
  ['1080p', 1920 * 1080],
  ['4k', 3840 * 2160],
]);

/**
 * Pixel area of a declared media resolution: a named video tier, or a literal
 * `<width>x<height>` string. An unrecognized value yields 0 so the caller can
 * treat it as "area unknown" — never inflate, which would risk a false reject.
 */
function resolutionAreaPixels(resolution: unknown): number {
  if (typeof resolution !== 'string') return 0;
  const named = VIDEO_RESOLUTION_AREA_PIXELS.get(resolution);
  if (named !== undefined) return named;
  const match = /^(\d+)x(\d+)$/i.exec(resolution);
  if (match === null) return 0;
  return Number(match[1]) * Number(match[2]);
}

function minVideoOutputBytes(params: Record<string, unknown>): number {
  const durationSeconds = params['durationSeconds'];
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return 0;
  }
  const area = resolutionAreaPixels(params['resolution']);
  // Unknown resolution → baseline factor: duration still governs and area is
  // never inflated (the safe direction — never false-reject an unknown tier).
  const areaFactor = area > 0 ? area / VIDEO_BASELINE_AREA_PIXELS : 1;
  const bytesPerSecond = VIDEO_FLOOR_BITS_PER_SECOND / 8;
  return Math.floor(bytesPerSecond * durationSeconds * areaFactor);
}

function minImageOutputBytes(params: Record<string, unknown>): number {
  const area = resolutionAreaPixels(params['resolution']);
  if (area <= 0) return 0;
  const megapixels = area / 1_000_000;
  const n = params['n'];
  const count = typeof n === 'number' && Number.isFinite(n) && n >= 1 ? n : 1;
  return Math.floor(IMAGE_FLOOR_BYTES_PER_MEGAPIXEL * megapixels * count);
}

/**
 * A conservative LOWER BOUND on a media call's output size in bytes — the
 * minimum any realistic encoding could plausibly produce for the declared
 * resolution/duration/count. Text calls have no size axis and return 0.
 * Admission rejects a run only when this floor exceeds the ValueStore budget,
 * i.e. when the output cannot possibly fit; the exact runtime size is enforced
 * separately during generation.
 */
export function estimateMinMediaOutputBytes(
  family: CallShapeFamily | undefined,
  params: Record<string, unknown>
): number {
  if (family === 'video') return minVideoOutputBytes(params);
  if (family === 'image') return minImageOutputBytes(params);
  return 0;
}

function modelCeiling(
  call: ModelCeilingCall,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver
): Result<bigint, DomainError> {
  const { modelId, params, maxSteps } = call;
  const descriptor = resolveModel(modelId);
  if (descriptor === undefined) {
    return err(validationError(`Estimate references model '${modelId}' unknown to the catalog`));
  }
  const ceiling: DeclaredCeiling = {
    maxFanOutWidth: enclosure.fanOut,
    maxSteps,
    maxIterations: enclosure.loop,
  };
  const family = callShapeFamilyFor(descriptor.outputs);
  if (family === 'image' || family === 'video') {
    // Pre-run size gate: a media output whose minimum-plausible size cannot fit
    // the in-memory ValueStore is doomed to be killed mid-run, so refuse it at
    // admission — before any provider spend — via the same fail-closed VALIDATION
    // channel as any unpriceable node.
    const minOutputBytes = estimateMinMediaOutputBytes(family, params);
    if (minOutputBytes > VALUE_STORE_BYTE_BUDGET_BYTES) {
      return err(
        validationError(
          `Media call '${modelId}' declares an output whose minimum size (${String(minOutputBytes)} bytes) exceeds the ${String(VALUE_STORE_BYTE_BUDGET_BYTES)}-byte in-memory value-store budget`
        )
      );
    }
    return mediaCallUsageFor(family, params).andThen((usage) =>
      estimateRunCeilingNanoUsd(descriptor.pricing, usage, ceiling)
    );
  }
  const contextLength = descriptor.limits[CONTEXT_LENGTH_LIMIT];
  if (contextLength === undefined) {
    return err(
      validationError(`Model '${modelId}' declares no context-token limit to bound the estimate`)
    );
  }
  const usage: CallUsage = {
    kind: 'tokens',
    inputTokens: contextLength,
    outputTokens: declaredOutputCeiling(params, contextLength),
  };
  return estimateRunCeilingNanoUsd(descriptor.pricing, usage, ceiling);
}

/**
 * The output-leg ceiling for a language call: the call's declared
 * `maxOutputTokens` param when it is a valid positive integer (the adapter
 * forwards it, so the provider cannot generate past it), bounded by the
 * context window; otherwise the full-context worst case. Only ever SHRINKS the
 * hold — an invalid declaration falls back to the worst case, never under-reserves.
 */
function declaredOutputCeiling(params: Record<string, unknown>, contextLength: number): number {
  const declared = params['maxOutputTokens'];
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) {
    return Math.min(contextLength, declared);
  }
  return contextLength;
}

/**
 * The flat web-search reservation a modelCall contributes when it enabled the
 * search tool: the per-call worst case scaled by the node's enclosing fanOut
 * width and loop iterations (each fanned/looped invocation can search up to the
 * cap), and by nothing else — `maxSteps` is the search loop's OWN step cap,
 * already folded into `WORST_CASE_SEARCH_RESERVATION_NANO_USD`, so multiplying
 * by it too would double-count. Zero when the node declared no search tool.
 */
function webSearchReservation(node: ModelCallNode, enclosure: EnclosureFactors): bigint {
  if (!node.tools.includes(WEB_SEARCH_TOOL_NAME)) return 0n;
  return WORST_CASE_SEARCH_RESERVATION_NANO_USD * BigInt(enclosure.fanOut) * BigInt(enclosure.loop);
}

function estimateModelNode(
  node: ModelCallNode,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver
): Result<bigint, DomainError> {
  return modelCeiling(
    { modelId: node.model, params: node.params, maxSteps: node.maxSteps },
    enclosure,
    resolveModel
  ).map((ceiling) => ceiling + webSearchReservation(node, enclosure));
}

/**
 * A smartModel node's ceiling: the classifier's full-context ceiling plus the
 * MAX over the candidates' full-context ceilings — exactly ONE candidate
 * answers, so summing candidates would over-hold N×. Fail-closed on any
 * unpriceable classifier or candidate (eligibility excludes them upstream, so
 * an unpriceable name here means the definition is wrong).
 */
function estimateSmartModelNode(
  node: SmartModelNode,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver
): Result<bigint, DomainError> {
  return Result.combine([
    // smartModel routes among language models; it declares no per-call media
    // params, so empty params reach the (nonsensical) media case here.
    modelCeiling(
      { modelId: node.classifierModelId, params: {}, maxSteps: 1 },
      enclosure,
      resolveModel
    ),
    // The answer generation runs with the node's params (the classifier call
    // never sees them), so each candidate's ceiling honors a declared
    // maxOutputTokens while the classifier stays at its full-context ceiling.
    ...node.candidates.map((candidate) =>
      modelCeiling(
        { modelId: candidate.id, params: node.params, maxSteps: 1 },
        enclosure,
        resolveModel
      )
    ),
  ]).map(([classifierCeiling, ...candidateCeilings]) => {
    // Math.max cannot take bigints; a plain scan keeps the money math integral.
    let maxCandidateCeiling = 0n;
    for (const candidateCeiling of candidateCeilings) {
      if (candidateCeiling > maxCandidateCeiling) maxCandidateCeiling = candidateCeiling;
    }
    return classifierCeiling + maxCandidateCeiling;
  });
}

/**
 * Prices a definition's declared worst case: every `modelCall` node's ceiling,
 * summed. A single-model turn is one node; a data-driven `fanOut` is the sum
 * at its declared max width. The per-call math (base × ceiling multiplier,
 * markup once) is `estimateRunCeilingNanoUsd`, reused — never re-derived here.
 */
export function createEstimateRun(resolveModel: ModelPricingResolver): EstimateRun {
  return (definition) => {
    const parents = buildParentIndex(definition.nodes);
    const memo = new Map<string, EnclosureFactors>();
    const perNode: Result<bigint, DomainError>[] = [];
    for (const node of definition.nodes) {
      const contribution: Result<bigint, DomainError> = match(node)
        .with({ type: 'modelCall' }, (n) =>
          estimateModelNode(n, enclosureFor(n.id, parents, memo), resolveModel)
        )
        // Fail-closed: a subWorkflow runs a nested definition whose modelCall
        // nodes incur real provider cost, but its `ref` cannot be resolved
        // here to price them. Omitting it would under-reserve the hold — an
        // unpriceable node must refuse the run, never contribute a silent 0.
        .with({ type: 'subWorkflow' }, (n) =>
          err(
            validationError(
              `Estimate cannot price subWorkflow '${n.ref}' — a nested definition is not resolvable here`
            )
          )
        )
        .with({ type: 'smartModel' }, (n) =>
          estimateSmartModelNode(n, enclosureFor(n.id, parents, memo), resolveModel)
        )
        // No direct inference cost; any enclosed modelCall nodes are already
        // priced through the enclosure walker. Enumerated exhaustively so a
        // new node type forces a pricing decision here rather than silently
        // contributing 0.
        .with(
          { type: 'transform' },
          { type: 'fanIn' },
          { type: 'branch' },
          { type: 'loop' },
          { type: 'fanOut' },
          () => ok(0n)
        )
        .exhaustive();
      perNode.push(contribution);
    }
    return Result.combine(perNode).map((amounts) =>
      nanoUSD(amounts.reduce((total, amount) => total + amount, 0n))
    );
  };
}
