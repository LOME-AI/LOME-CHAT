import { match } from 'ts-pattern';
import { nanoUSD } from '@hushbox/shared';
import { estimateRunCeilingNanoUsd } from './estimate.js';
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
 * One model node's ceiling: its per-token cost at the model's full context
 * window on BOTH the input and output legs — a strict upper bound, since
 * neither prompt nor completion can exceed the context window — scaled by its
 * declared fan-out width, agentic steps, and loop iterations. Fail-closed if
 * the model is unknown, unpriced, or declares no context-token limit: any of
 * those means no true ceiling can be derived, so the run must be refused.
 */
function estimateModelNode(
  node: ModelCallNode,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver
): Result<bigint, DomainError> {
  const descriptor = resolveModel(node.model);
  if (descriptor === undefined) {
    return err(validationError(`Estimate references model '${node.model}' unknown to the catalog`));
  }
  const contextLength = descriptor.limits[CONTEXT_LENGTH_LIMIT];
  if (contextLength === undefined) {
    return err(
      validationError(`Model '${node.model}' declares no context-token limit to bound the estimate`)
    );
  }
  const usage: CallUsage = {
    kind: 'tokens',
    inputTokens: contextLength,
    outputTokens: contextLength,
  };
  const ceiling: DeclaredCeiling = {
    maxFanOutWidth: enclosure.fanOut,
    maxSteps: node.maxSteps,
    maxIterations: enclosure.loop,
  };
  return estimateRunCeilingNanoUsd(descriptor.pricing, usage, ceiling);
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
