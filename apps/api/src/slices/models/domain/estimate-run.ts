import { match } from 'ts-pattern';
import { callShapeFamilyFor, nanoUSD } from '@hushbox/shared';
import { estimateRunCeilingNanoUsd, mediaCallUsageFor } from './estimate.js';
import { validationError } from '../../../lib/errors/index.js';
import { Result, err, ok } from '../../../lib/result/index.js';
import type { ModelDescriptor, NanoUSD, Node, WorkflowDefinition } from '@hushbox/shared';
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

function estimateModelNode(
  node: ModelCallNode,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver
): Result<bigint, DomainError> {
  return modelCeiling(
    { modelId: node.model, params: node.params, maxSteps: node.maxSteps },
    enclosure,
    resolveModel
  );
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
