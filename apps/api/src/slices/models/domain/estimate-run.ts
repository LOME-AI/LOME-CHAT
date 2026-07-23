import { match } from 'ts-pattern';
import {
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  STORAGE_COST_PER_CHARACTER_NANO,
  callShapeFamilyFor,
  nanoUSD,
  outputCharsPerTokenForTier,
  reservationCeiling,
  smartModelClassifierDimensions,
} from '@hushbox/shared';
import {
  WORST_CASE_SEARCH_RESERVATION_NANO_USD,
  estimateRunCeilingNanoUsd,
  mediaCallUsageFor,
} from './estimate.js';
import { classifierReserveLineItems } from './smart-model-candidates.js';
import { WEB_SEARCH_TOOL_NAME } from './tool-registry.js';
import { validationError } from '../../../lib/errors/index.js';
import { Result, err, ok } from '../../../lib/result/index.js';
import type {
  CallShapeFamily,
  ModelDescriptor,
  NanoLineItem,
  NanoUSD,
  Node,
  StorageStamp,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { CallUsage, DeclaredCeiling, NodeStorage } from './estimate.js';
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

/**
 * The turn-level storage inputs a PERSISTING run adds to its admission ceiling
 * ride the definition's `storage` stamp — the shared {@link StorageStamp}
 * (`inputChars` + payer `tier`), read PER-RUN from the `WorkflowDefinition`,
 * never a per-caller argument: the payer tier is a route-time funding decision
 * that never reaches the conversation DO where the estimate is computed, so it
 * can only ride the definition the DO is handed. A chat turn stamps it; a general
 * or no-persist definition omits it, so storage is zero and the ceiling is
 * provider cost only. When present the estimator adds input storage ONCE (the
 * prompt, at the definition level), output storage per answer-producing node
 * (tier-sized), the classifier reserve's own storage, and media output storage —
 * the full, settlement-matching hold. This is why the estimator is no longer
 * purely structural: a persisting turn's hold must cover the storage it will be
 * billed.
 */

/** A token node's output-storage inputs for the given persisting-turn context. */
function tokenNodeStorage(storageContext: StorageStamp | undefined): NodeStorage | undefined {
  if (storageContext === undefined) return undefined;
  return {
    outputCharsPerToken: outputCharsPerTokenForTier(storageContext.tier),
    mediaStorageBytes: 0,
  };
}

/**
 * A media node's output-storage bytes: the structural, tier-independent estimate
 * legacy `computeImage/VideoExactCents` billed — one estimated image, or the
 * duration times the per-second video estimate. `× modelCount` is applied by the
 * core (one model per media node here).
 */
function mediaStorageBytesFor(family: CallShapeFamily, usage: CallUsage): number {
  if (family === 'image') return ESTIMATED_IMAGE_BYTES;
  return (usage.kind === 'media' ? usage.units : 0) * ESTIMATED_VIDEO_BYTES_PER_SECOND;
}

function mediaNodeStorage(
  storageContext: StorageStamp | undefined,
  family: CallShapeFamily,
  usage: CallUsage
): NodeStorage | undefined {
  if (storageContext === undefined) return undefined;
  return { outputCharsPerToken: 1, mediaStorageBytes: mediaStorageBytesFor(family, usage) };
}

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
  /**
   * The estimated prompt input-token count. When present it bounds the input
   * leg at `min(contextLength, promptInputTokens)` — the actual prompt, not the
   * full context window. Absent ⇒ the input leg is the full context window
   * (fail-closed over-reserve), which is the pre-stamp / trial behavior.
   */
  readonly promptInputTokens?: number;
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
  resolveModel: ModelPricingResolver,
  storageContext: StorageStamp | undefined
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
      estimateRunCeilingNanoUsd(
        descriptor.pricing,
        usage,
        ceiling,
        mediaNodeStorage(storageContext, family, usage)
      )
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
    inputTokens: inputTokenCeiling(call.promptInputTokens, contextLength),
    outputTokens: declaredOutputCeiling(params, contextLength),
  };
  return estimateRunCeilingNanoUsd(
    descriptor.pricing,
    usage,
    ceiling,
    tokenNodeStorage(storageContext)
  );
}

/**
 * The input-leg ceiling for a language call: the stamped prompt input-token
 * count when present (the actual prompt), bounded by the context window;
 * otherwise the full context window. Only ever SHRINKS the hold below the
 * context window — the pre-stamp worst case remains the fail-closed default.
 */
function inputTokenCeiling(promptInputTokens: number | undefined, contextLength: number): number {
  if (promptInputTokens === undefined) return contextLength;
  return Math.min(contextLength, promptInputTokens);
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
  resolveModel: ModelPricingResolver,
  storageContext: StorageStamp | undefined
): Result<bigint, DomainError> {
  return modelCeiling(
    {
      modelId: node.model,
      params: node.params,
      maxSteps: node.maxSteps,
      ...(node.promptInputTokens === undefined
        ? {}
        : { promptInputTokens: node.promptInputTokens }),
    },
    enclosure,
    resolveModel,
    storageContext
  ).map((ceiling) => ceiling + webSearchReservation(node, enclosure));
}

/**
 * A smartModel node's ceiling: the classifier's BOUNDED worst-case reserve plus
 * the MAX over the candidates' ceilings — exactly ONE candidate answers, so
 * summing candidates would over-hold N×. The classifier is priced through the
 * SAME `classifierReserveLineItems` the candidate builder uses (its real
 * truncated-context + output-cap reserve, NOT a full-context modelCall).
 * `node.candidates` is the ELIGIBLE subset the builder derived over the payer's
 * effective balance, each carrying its OWN affordable `cap(m)` — so each answer
 * leg is priced at that candidate's own cap (not a single shared one), and the
 * MAX over the subset is `≤ effBalance` by construction (the caps were sized to
 * make it so, storage included). Each candidate answer leg honors the stamped
 * prompt input-token count and its own `maxOutputTokens`. Fail-closed on any
 * unpriceable classifier or candidate (eligibility excludes them upstream, so an
 * unpriceable name here means the definition is wrong).
 */
/**
 * The classifier reserve for a smartModel node, priced through the shared core.
 * The provider token item always rides the reserve; the pass-through storage item
 * rides it only when the turn persists (`storageContext` present), tier-sized on
 * its output leg. The reserve is FIXED (nothing scales with the main turn's
 * output), so `outputTokenCeiling` is 0; it scales by the enclosing fanOut/loop —
 * the classifier runs once per enclosing invocation — with the markup applied
 * once to the provider subtotal and storage added raw.
 */
/**
 * Guards the enclosure multipliers the classifier reserve passes straight to the
 * core `reservationCeiling`, which THROWS `RangeError` on a non-safe-integer
 * multiplier. `workflow.ts` bounds each container's `maxWidth`/`maxIterations` at
 * `.int().min(1)` with NO upper bound, so nested same-axis containers can
 * accumulate an enclosure product past `Number.MAX_SAFE_INTEGER` while every
 * individual bound stays schema-valid. This mirrors estimate.ts's `ceilingInput`
 * guard — same rule, same message — that the sibling modelCall path already
 * applies, so an over-range enclosure refuses the run on the domain `Result`
 * channel (a graceful validationError) instead of throwing an uncaught defect
 * (500 + Sentry). The two guards MUST stay in sync: both paths refuse identically
 * for the identical multiplier.
 */
function enclosureMultiplierError(
  fanOutWidth: number,
  maxSteps: number,
  maxIterations: number
): DomainError | undefined {
  const dimensions: readonly (readonly [string, number])[] = [
    ['maxFanOutWidth', fanOutWidth],
    ['maxSteps', maxSteps],
    ['maxIterations', maxIterations],
  ];
  for (const [label, value] of dimensions) {
    if (!Number.isSafeInteger(value) || value < 1) {
      return validationError(`Estimate ceiling ${label} must be a positive integer`);
    }
  }
  return undefined;
}

function classifierReserveNanoUsd(
  node: SmartModelNode,
  classifierDescriptor: ModelDescriptor,
  enclosure: EnclosureFactors,
  storageContext: StorageStamp | undefined
): Result<bigint, DomainError> {
  const outputCharsPerToken = outputCharsPerTokenForTier(storageContext?.tier ?? 'trial');
  const items = classifierReserveLineItems(
    classifierDescriptor,
    node.candidates,
    outputCharsPerToken
  );
  if (items === undefined) {
    return err(
      validationError(`smartModel classifier '${node.classifierModelId}' lacks a per-token rate`)
    );
  }
  // The classifier runs once per enclosing invocation (maxSteps is structurally
  // 1), so only the fanOut/loop enclosure product can be non-safe here.
  const multiplierError = enclosureMultiplierError(enclosure.fanOut, 1, enclosure.loop);
  if (multiplierError !== undefined) return err(multiplierError);
  const reserveItems: readonly NanoLineItem[] =
    storageContext === undefined ? items.filter((item) => item.marksUp) : items;
  return ok(
    reservationCeiling(
      { items: reserveItems },
      {
        outputTokenCeiling: 0n,
        fanOutWidth: enclosure.fanOut,
        maxSteps: 1,
        maxIterations: enclosure.loop,
      }
    )
  );
}

function estimateSmartModelNode(
  node: SmartModelNode,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver,
  storageContext: StorageStamp | undefined
): Result<bigint, DomainError> {
  const classifierDescriptor = resolveModel(node.classifierModelId);
  if (classifierDescriptor === undefined) {
    return err(
      validationError(
        `Estimate references model '${node.classifierModelId}' unknown to the catalog`
      )
    );
  }
  // The classifier reserve is held iff a classifier generation can happen —
  // the SAME shared dimension authority the node execution short-circuits on
  // (`Smart Model routing ∨ effort=auto`), so reserve and charge can never
  // disagree: a single-candidate model-only node bills no classifier and
  // holds none; a pinned+auto (effort-dimension) node bills one and holds one.
  const dimensions = smartModelClassifierDimensions(node);
  const classifierReserve =
    dimensions.model || dimensions.effort
      ? classifierReserveNanoUsd(node, classifierDescriptor, enclosure, storageContext)
      : ok(0n);
  return Result.combine([
    classifierReserve,
    // Each candidate answers at its OWN affordable cap — the reservation is the
    // MAX over the eligible subset of per-candidate cost, so a cheap model's
    // larger cap and a pricey model's smaller cap are each priced at that
    // model's own rate (never a single shared cap). The candidate cap overrides
    // any node-level `maxOutputTokens`; the reasoning-off wire (node.params)
    // still rides every answer leg. The classifier call never sees these params.
    ...node.candidates.map((candidate) =>
      modelCeiling(
        {
          modelId: candidate.id,
          params:
            candidate.maxOutputTokens === undefined
              ? node.params
              : { ...node.params, maxOutputTokens: candidate.maxOutputTokens },
          maxSteps: 1,
          ...(node.promptInputTokens === undefined
            ? {}
            : { promptInputTokens: node.promptInputTokens }),
        },
        enclosure,
        resolveModel,
        storageContext
      )
    ),
  ]).map(([classifierReserve, ...candidateCeilings]) => {
    // Math.max cannot take bigints; a plain scan keeps the money math integral.
    let maxCandidateCeiling = 0n;
    for (const candidateCeiling of candidateCeilings) {
      if (candidateCeiling > maxCandidateCeiling) maxCandidateCeiling = candidateCeiling;
    }
    return classifierReserve + maxCandidateCeiling;
  });
}

/**
 * Prices a definition's declared worst case: every `modelCall` node's ceiling,
 * summed. A single-model turn is one node; a data-driven `fanOut` is the sum
 * at its declared max width. The per-call math (base × ceiling multiplier,
 * markup once) is `estimateRunCeilingNanoUsd`, reused — never re-derived here.
 *
 * The storage stamp rides the DEFINITION and is read per-run: absent (general
 * workflows, and every no-persist definition) the ceiling is provider cost only;
 * a persisting chat turn stamps it (from the TurnBudget, via `withStorageStamp`)
 * and the ceiling additionally covers input storage ONCE (the prompt), output
 * storage per answer-producing node, the classifier reserve's storage, and media
 * output storage — matching what settlement bills, so admission never
 * under-reserves. Storage is pass-through and never marked up. One estimator
 * instance serves every run; the per-run storage difference is the stamp, not a
 * closed-over argument (the tier cannot reach this factory — it is built once per
 * DO from env, before any turn's payer is known).
 */
export function createEstimateRun(resolveModel: ModelPricingResolver): EstimateRun {
  return (definition) => {
    const storageContext: StorageStamp | undefined = definition.storage;
    const parents = buildParentIndex(definition.nodes);
    const memo = new Map<string, EnclosureFactors>();
    const perNode: Result<bigint, DomainError>[] = [];
    for (const node of definition.nodes) {
      const contribution: Result<bigint, DomainError> = match(node)
        .with({ type: 'modelCall' }, (n) =>
          estimateModelNode(n, enclosureFor(n.id, parents, memo), resolveModel, storageContext)
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
          estimateSmartModelNode(n, enclosureFor(n.id, parents, memo), resolveModel, storageContext)
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
    // Input storage is a per-TURN cost (the prompt is stored once), so it is
    // added once at the definition level, never per node — pass-through, unmarked.
    const inputStorageNano =
      storageContext === undefined
        ? 0n
        : BigInt(storageContext.inputChars) * STORAGE_COST_PER_CHARACTER_NANO;
    return Result.combine(perNode).map((amounts) =>
      nanoUSD(amounts.reduce((total, amount) => total + amount, inputStorageNano))
    );
  };
}
