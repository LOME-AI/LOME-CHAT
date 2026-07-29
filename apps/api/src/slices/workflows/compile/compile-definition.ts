import { P, match } from 'ts-pattern';
import {
  consumedProducerIds,
  END_NODE_ID,
  formatTypeTag,
  isAssignable,
  listTag,
  optionalTag,
  TypeTagSchema,
  WorkflowDefinition,
} from '@hushbox/shared';
import { err, ok } from '../../../lib/result/index.js';
import { compileError } from './errors.js';
import { DEFAULT_COMPILE_LIMITS } from './context.js';
import {
  FAN_OUT_ELEMENT_PORT_ID,
  FAN_OUT_OVER_PORT_ID,
  LOOP_STATE_PORT_ID,
  positionalInputPortId,
  reservedOutPortId,
  SINGLE_INPUT_PORT_ID,
  WORKFLOW_INPUT_NODE_ID,
} from './conventions.js';
import type { Edge, Node, NodeId, PortRef, TypeTag } from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type { CompileContext, ValueNode } from './context.js';
import type { CompileError, CompileErrorRef, EdgeRefLike } from './errors.js';

/** One fed input port of a compiled node: where it comes from, what flows. */
export interface CompiledNodeInput {
  readonly from: PortRef;
  /** The channel tag runtime validation derives its schema from. */
  readonly tag: TypeTag;
}

export interface CompiledNode {
  readonly node: Node;
  /** Keyed by consumer port id. */
  readonly inputs: ReadonlyMap<string, CompiledNodeInput>;
  /** The node's effective producer tag (optional-wrapped for optional nodes). */
  readonly out: TypeTag;
}

export interface CompiledDefinition {
  readonly definition: WorkflowDefinition;
  readonly workflowInputs: Readonly<Record<string, TypeTag>>;
  /** Keyed by node id. */
  readonly nodes: ReadonlyMap<string, CompiledNode>;
  /** A topological execution order over dataflow and control edges. */
  readonly order: readonly NodeId[];
  /**
   * Every node id another node reads. The complement is the run's sinks — the
   * only values settlement persists — and the same set decides which nodes
   * admission reserves output storage for. Derived here, where a definition
   * becomes a compiled form, so the reserve and the persisted set are one value
   * rather than two answers to the same question.
   */
  readonly consumedProducers: ReadonlySet<string>;
}

/**
 * Validates a workflow definition against the node registry, the named
 * constraint registry, and the declared workflow inputs; returns the typed,
 * ordered graph the engine interprets. Collects every detectable defect as a
 * deterministic CompileError list — identical inputs always produce the
 * identical error sequence. Expected defects never throw.
 */
export function compileDefinition(
  definition: unknown,
  context: CompileContext
): Result<CompiledDefinition, CompileError[]> {
  const parsed = WorkflowDefinition.safeParse(definition);
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return err([compileError('invalid_definition', `definition does not parse: ${where}`)]);
  }
  return new Compilation(parsed.data, context).run();
}

type MaybeTag = TypeTag | undefined;

interface ResolvedPorts {
  readonly in: readonly MaybeTag[];
  readonly out: MaybeTag;
}

type FanOutNode = Extract<Node, { type: 'fanOut' }>;
type LoopNode = Extract<Node, { type: 'loop' }>;

interface TagResolution {
  status: 'resolving' | 'done';
  tag: MaybeTag;
}

/** Single-use state for one compileDefinition call. */
class Compilation {
  private readonly errors: CompileError[] = [];
  private readonly byId = new Map<string, Node>();
  private readonly inputTags = new Map<string, MaybeTag>();
  private readonly valuePorts = new Map<string, ResolvedPorts | undefined>();
  private readonly predicateInputs = new Map<string, MaybeTag>();
  private readonly reducerSignatures = new Map<string, ResolvedPorts | undefined>();
  /** Accepted feed per (consumer node, consumer port). */
  private readonly feeds = new Map<string, Map<string, Edge>>();
  /** Ports any edge targeted, valid or not — suppresses missing_input noise. */
  private readonly targeted = new Set<string>();
  private readonly outTags = new Map<string, TagResolution>();
  private tagCycleReported = false;

  constructor(
    private readonly definition: WorkflowDefinition,
    private readonly context: CompileContext
  ) {}

  run(): Result<CompiledDefinition, CompileError[]> {
    const limits = this.context.limits ?? DEFAULT_COMPILE_LIMITS;
    this.validateWorkflowInputs();
    this.checkIdentity(limits.maxNodes);
    if (this.errors.some((error) => IDENTITY_CODES.has(error.code))) return err(this.errors);
    this.resolveRegistrations(limits);
    this.checkStructuralRefs();
    this.checkWiring();
    const order = this.topologicalOrder();
    if (order === undefined) return err(this.errors);
    this.checkTypes();
    if (this.errors.length > 0) return err(this.errors);
    return ok(this.buildArtifact(order));
  }

  private validateWorkflowInputs(): void {
    for (const [name, tag] of Object.entries(this.context.workflowInputs)) {
      this.inputTags.set(name, this.validateTag(tag, `workflow input '${name}'`, {}));
    }
  }

  private checkIdentity(maxNodes: number): void {
    for (const node of this.definition.nodes) {
      if (node.id === WORKFLOW_INPUT_NODE_ID || (node.id as string) === (END_NODE_ID as string)) {
        this.report('reserved_node_id', `node id '${node.id}' is reserved`, { nodeId: node.id });
      }
      if (this.byId.has(node.id)) {
        this.report('duplicate_node_id', `node id '${node.id}' is declared twice`, {
          nodeId: node.id,
        });
      } else {
        this.byId.set(node.id, node);
      }
      const reserved = reservedOutPortId(node);
      if (reserved !== undefined && node.out === reserved) {
        this.report(
          'reserved_port_id',
          `out port '${node.out}' shadows the reserved '${reserved}' port`,
          { nodeId: node.id }
        );
      }
    }
    if (this.definition.nodes.length > maxNodes) {
      this.report(
        'node_count_exceeded',
        `definition declares ${String(this.definition.nodes.length)} nodes; the ceiling is ${String(maxNodes)}`
      );
    }
  }

  private resolveRegistrations(limits: NonNullable<CompileContext['limits']>): void {
    for (const node of this.definition.nodes) {
      if (!this.context.nodes.hasNode(node.type, node.version)) {
        this.report(
          'unknown_node_version',
          `no registered implementation for (${node.type}, ${String(node.version)})`,
          { nodeId: node.id }
        );
        continue;
      }
      match(node)
        .with({ type: 'modelCall' }, (modelCall) => {
          this.resolveValueNode(modelCall, true);
          if (modelCall.maxSteps > limits.maxModelCallSteps) {
            this.report(
              'model_steps_exceeded',
              `maxSteps ${String(modelCall.maxSteps)} exceeds the ceiling ${String(limits.maxModelCallSteps)}`,
              { nodeId: modelCall.id }
            );
          }
        })
        .with({ type: 'transform' }, (transform) => {
          this.resolveValueNode(transform, true);
        })
        .with({ type: 'subWorkflow' }, (subWorkflow) => {
          this.resolveValueNode(subWorkflow, false);
        })
        .with({ type: 'smartModel' }, (smartModel) => {
          this.resolveValueNode(smartModel, true);
        })
        .with({ type: 'fanOut' }, (fanOut) => {
          if (fanOut.maxWidth > limits.maxFanOutWidth) {
            this.report(
              'fan_out_width_exceeded',
              `maxWidth ${String(fanOut.maxWidth)} exceeds the ceiling ${String(limits.maxFanOutWidth)}`,
              { nodeId: fanOut.id }
            );
          }
        })
        .with({ type: 'loop' }, (loop) => {
          if (loop.maxIterations > limits.maxLoopIterations) {
            this.report(
              'loop_iterations_exceeded',
              `maxIterations ${String(loop.maxIterations)} exceeds the ceiling ${String(limits.maxLoopIterations)}`,
              { nodeId: loop.id }
            );
          }
          this.resolvePredicate(loop.id, loop.until);
        })
        .with({ type: 'branch' }, (branch) => {
          this.resolvePredicate(branch.id, branch.predicate);
        })
        .with({ type: 'fanIn' }, (fanIn) => {
          const reducer = this.context.constraints.resolve('reducer', fanIn.reducer);
          if (reducer === undefined) {
            this.report('unknown_reducer', `reducer '${fanIn.reducer}' is not registered`, {
              nodeId: fanIn.id,
            });
            this.reducerSignatures.set(fanIn.id, undefined);
            return;
          }
          if (reducer.in.length !== fanIn.ins.length) {
            this.report(
              'reducer_arity_mismatch',
              `reducer '${fanIn.reducer}' takes ${String(reducer.in.length)} inputs; node wires ${String(fanIn.ins.length)}`,
              { nodeId: fanIn.id }
            );
            this.reducerSignatures.set(fanIn.id, undefined);
            return;
          }
          const ref = { nodeId: fanIn.id };
          this.reducerSignatures.set(fanIn.id, {
            in: reducer.in.map((tag, index) =>
              this.validateTag(tag, `reducer '${fanIn.reducer}' input ${String(index)}`, ref)
            ),
            out: this.validateTag(reducer.out, `reducer '${fanIn.reducer}' output`, ref),
          });
        })
        .exhaustive();
    }
  }

  private resolveValueNode(node: ValueNode, singleInput: boolean): void {
    const declared = this.context.nodes.resolveValuePorts(node);
    if (declared === undefined) {
      this.report(
        'node_config_unresolved',
        `${node.type} config does not resolve to declared ports`,
        {
          nodeId: node.id,
        }
      );
      this.valuePorts.set(node.id, undefined);
      return;
    }
    if (singleInput && declared.in.length !== 1) {
      this.report(
        'node_config_unresolved',
        `${node.type} declares ${String(declared.in.length)} input ports; expected exactly one`,
        { nodeId: node.id }
      );
      this.valuePorts.set(node.id, undefined);
      return;
    }
    const ref = { nodeId: node.id };
    this.valuePorts.set(node.id, {
      in: declared.in.map((tag, index) =>
        this.validateTag(tag, `declared input port ${String(index)}`, ref)
      ),
      out: this.validateTag(declared.out, 'declared output port', ref),
    });
  }

  private resolvePredicate(nodeId: string, name: string): void {
    const predicate = this.context.constraints.resolve('predicate', name);
    if (predicate === undefined) {
      this.report('unknown_predicate', `predicate '${name}' is not registered`, { nodeId });
      this.predicateInputs.set(nodeId, undefined);
      return;
    }
    this.predicateInputs.set(
      nodeId,
      this.validateTag(predicate.input, `predicate '${name}' input`, { nodeId })
    );
  }

  private checkStructuralRefs(): void {
    for (const node of this.definition.nodes) {
      if ((node.type === 'fanOut' || node.type === 'loop') && !this.byId.has(node.body)) {
        this.report('unknown_node_ref', `body '${node.body}' names no node`, { nodeId: node.id });
      }
      if (node.type === 'branch') {
        for (const [label, target] of Object.entries(node.cases)) {
          this.checkBranchTarget(node.id, `case '${label}'`, target);
        }
        this.checkBranchTarget(node.id, 'else', node.else);
      }
    }
  }

  private checkBranchTarget(nodeId: string, label: string, target: NodeId): void {
    if ((target as string) !== (END_NODE_ID as string) && !this.byId.has(target)) {
      this.report('unknown_node_ref', `branch ${label} target '${target}' names no node`, {
        nodeId,
      });
    }
  }

  private checkWiring(): void {
    for (const edge of this.definition.edges) {
      this.checkEdge(edge);
    }
    for (const node of this.definition.nodes) {
      this.checkEmbeddedRefs(node);
      this.checkInputCompleteness(node);
    }
  }

  private checkEdge(edge: Edge): void {
    const ref = { edge: edgeRef(edge) };
    const consumer = this.byId.get(edge.to.node);
    if (consumer === undefined) {
      this.report('unknown_node_ref', `edge targets unknown node '${edge.to.node}'`, ref);
      return;
    }
    const ports = this.consumerPorts(consumer);
    if (ports !== undefined && !ports.includes(edge.to.port)) {
      this.report('unknown_port', `'${consumer.id}' declares no input port '${edge.to.port}'`, ref);
      return;
    }
    this.targeted.add(feedKey(edge.to.node, edge.to.port));
    if (!this.checkEdgeProducer(edge, ref)) return;
    const nodeFeeds = this.feeds.get(edge.to.node) ?? new Map<string, Edge>();
    if (nodeFeeds.has(edge.to.port)) {
      this.report(
        'duplicate_input_edge',
        `input port '${edge.to.port}' of '${edge.to.node}' is fed more than once`,
        ref
      );
      return;
    }
    nodeFeeds.set(edge.to.port, edge);
    this.feeds.set(edge.to.node, nodeFeeds);
  }

  private checkEdgeProducer(edge: Edge, ref: CompileErrorRef): boolean {
    if (edge.from.node === WORKFLOW_INPUT_NODE_ID) {
      if (!(edge.from.port in this.context.workflowInputs)) {
        this.report(
          'unknown_workflow_input',
          `workflow input '${edge.from.port}' is not declared`,
          ref
        );
        return false;
      }
      return true;
    }
    const producer = this.byId.get(edge.from.node);
    if (producer === undefined) {
      this.report('unknown_node_ref', `edge leaves unknown node '${edge.from.node}'`, ref);
      return false;
    }
    if (edge.from.port === producer.out) return true;
    const reserved = reservedOutPortId(producer);
    if (reserved !== undefined && edge.from.port === reserved) {
      const body = (producer as FanOutNode | LoopNode).body;
      if (edge.to.node !== body) {
        this.report(
          'unknown_port',
          `port '${reserved}' of '${producer.id}' is visible only to its body '${body}'`,
          ref
        );
        return false;
      }
      return true;
    }
    this.report(
      'unknown_port',
      `'${producer.id}' declares no output port '${edge.from.port}'`,
      ref
    );
    return false;
  }

  private checkEmbeddedRefs(node: Node): void {
    const expectations = match<Node, readonly (readonly [string, PortRef])[]>(node)
      .with({ type: 'modelCall' }, (n) => [[SINGLE_INPUT_PORT_ID, n.in]])
      .with({ type: 'transform' }, (n) => [[SINGLE_INPUT_PORT_ID, n.in]])
      .with({ type: 'smartModel' }, (n) => [[SINGLE_INPUT_PORT_ID, n.in]])
      .with({ type: 'fanOut' }, (n) => [[FAN_OUT_OVER_PORT_ID, n.over]])
      .with({ type: 'fanIn' }, (n) =>
        n.ins.map((portRef, index) => [positionalInputPortId(index), portRef] as const)
      )
      .with({ type: P.union('branch', 'loop', 'subWorkflow') }, () => [])
      .exhaustive();
    for (const [port, embedded] of expectations) {
      const feed = this.feeds.get(node.id)?.get(port);
      if (feed === undefined) continue;
      if (feed.from.node !== embedded.node || feed.from.port !== embedded.port) {
        this.report(
          'port_ref_mismatch',
          `embedded ref for '${port}' expects ${embedded.node}.${embedded.port}`,
          { nodeId: node.id, edge: edgeRef(feed) }
        );
      }
    }
  }

  private checkInputCompleteness(node: Node): void {
    const ports = this.consumerPorts(node);
    if (ports === undefined) return;
    for (const port of ports) {
      if (!this.targeted.has(feedKey(node.id, port))) {
        this.report('missing_input', `input port '${port}' is not fed`, { nodeId: node.id });
      }
    }
  }

  /** Declared input port ids; undefined while the declaration is unresolvable. */
  private consumerPorts(node: Node): readonly string[] | undefined {
    return match<Node, readonly string[] | undefined>(node)
      .with({ type: 'fanOut' }, () => [FAN_OUT_OVER_PORT_ID])
      .with({ type: 'fanIn' }, (n) => n.ins.map((_, index) => positionalInputPortId(index)))
      .with({ type: 'subWorkflow' }, (n) => {
        const ports = this.valuePorts.get(n.id);
        if (ports === undefined) return;
        return ports.in.map((_, index) => positionalInputPortId(index));
      })
      .with({ type: P.union('modelCall', 'transform', 'branch', 'loop', 'smartModel') }, () => [
        SINGLE_INPUT_PORT_ID,
      ])
      .exhaustive();
  }

  /**
   * Kahn's algorithm over dataflow plus control edges (branch targets, body
   * membership). Loop iteration is interpreted inside the loop node, so a
   * well-formed loop contributes no back edge. Returns undefined on a cycle.
   */
  private topologicalOrder(): readonly NodeId[] | undefined {
    const { successors, indegree } = this.buildAdjacency();
    const order: NodeId[] = [];
    for (const node of this.definition.nodes) {
      if (countOf(indegree, node.id) === 0) order.push(node.id);
    }
    // The array iterator observes ids appended mid-walk, so `order` doubles
    // as Kahn's work queue.
    for (const id of order) {
      for (const successor of successorsOf(successors, id)) {
        const remaining = countOf(indegree, successor) - 1;
        indegree.set(successor, remaining);
        if (remaining === 0) order.push(successor);
      }
    }
    if (order.length === this.byId.size) return order;
    const stuck = this.definition.nodes
      .filter((node) => !order.includes(node.id))
      .map((node) => node.id);
    this.report('cycle_detected', `cycle through ${stuck.join(', ')}`);
    return undefined;
  }

  /** Sparse adjacency: only nodes with successors or predecessors hold entries. */
  private buildAdjacency(): {
    successors: ReadonlyMap<string, ReadonlySet<NodeId>>;
    indegree: Map<string, number>;
  } {
    const successors = new Map<string, Set<NodeId>>();
    const indegree = new Map<string, number>();
    const addEdge = (from: string, to: NodeId): void => {
      if (!this.byId.has(to)) return;
      const set = successors.get(from) ?? new Set<NodeId>();
      if (set.has(to)) return;
      set.add(to);
      successors.set(from, set);
      indegree.set(to, countOf(indegree, to) + 1);
    };
    for (const nodeFeeds of this.feeds.values()) {
      for (const edge of nodeFeeds.values()) {
        if (edge.from.node !== WORKFLOW_INPUT_NODE_ID) addEdge(edge.from.node, edge.to.node);
      }
    }
    for (const node of this.definition.nodes) {
      for (const target of controlTargets(node)) addEdge(node.id, target);
    }
    return { successors, indegree };
  }

  private checkTypes(): void {
    for (const node of this.definition.nodes) {
      this.checkFedPortTypes(node);
      if (node.type === 'fanOut') this.checkFanOutCollection(node);
      if (node.type === 'loop') this.checkLoopState(node);
    }
  }

  private checkFedPortTypes(node: Node): void {
    for (const port of this.consumerPorts(node) ?? []) {
      const feed = this.feeds.get(node.id)?.get(port);
      if (feed === undefined) continue;
      const producer = this.producerTag(feed.from);
      const expected = this.expectedTag(node, port);
      if (producer !== undefined && expected !== undefined && !isAssignable(producer, expected)) {
        this.report(
          'type_mismatch',
          `${formatTypeTag(producer)} is not assignable to ${formatTypeTag(expected)}`,
          { nodeId: node.id, edge: edgeRef(feed) }
        );
      }
    }
  }

  private checkFanOutCollection(node: FanOutNode): void {
    const over = this.overTag(node);
    if (over !== undefined && over.kind !== 'list') {
      this.report(
        'fan_out_over_not_list',
        `'over' is fed ${formatTypeTag(over)}; fanOut iterates a list`,
        { nodeId: node.id }
      );
    }
  }

  private checkLoopState(node: LoopNode): void {
    const state = this.stateTag(node);
    const predicate = this.predicateInputs.get(node.id);
    if (state !== undefined && predicate !== undefined && !isAssignable(state, predicate)) {
      this.report(
        'type_mismatch',
        `until-predicate input ${formatTypeTag(predicate)} cannot accept state ${formatTypeTag(state)}`,
        { nodeId: node.id }
      );
    }
    const body = this.byId.get(node.body);
    if (body === undefined || state === undefined) return;
    const bodyOut = this.effectiveOut(body);
    if (bodyOut !== undefined && !isAssignable(bodyOut, state)) {
      this.report(
        'body_type_mismatch',
        `body output ${formatTypeTag(bodyOut)} cannot re-enter state ${formatTypeTag(state)}`,
        { nodeId: node.id }
      );
    }
  }

  /** Expected consumer tag for a fed port; undefined when unconstrained or unknown. */
  private expectedTag(node: Node, port: string): MaybeTag {
    switch (node.type) {
      case 'modelCall':
      case 'transform':
      case 'subWorkflow':
      case 'smartModel': {
        return this.declaredInputTag(node, port);
      }
      case 'fanIn': {
        return this.reducerSignatures.get(node.id)?.in[positionalIndex(port)];
      }
      case 'branch': {
        return this.predicateInputs.get(node.id);
      }
      // fanOut 'over' and loop 'in' are unconstrained; their shape checks
      // (list kind, state agreement) run separately.
      case 'fanOut':
      case 'loop': {
        return;
      }
    }
  }

  private declaredInputTag(node: ValueNode, port: string): MaybeTag {
    const index = node.type === 'subWorkflow' ? positionalIndex(port) : 0;
    return this.valuePorts.get(node.id)?.in[index];
  }

  /** Tag flowing out of a producer port reference. */
  private producerTag(from: PortRef): MaybeTag {
    if (from.node === WORKFLOW_INPUT_NODE_ID) return this.inputTags.get(from.port);
    const node = this.byId.get(from.node);
    if (node === undefined) return undefined;
    if (from.port === node.out) return this.effectiveOut(node);
    if (node.type === 'fanOut' && from.port === FAN_OUT_ELEMENT_PORT_ID) {
      const over = this.overTag(node);
      return over?.kind === 'list' ? over.inner : undefined;
    }
    if (node.type === 'loop' && from.port === LOOP_STATE_PORT_ID) return this.stateTag(node);
    return undefined;
  }

  private overTag(node: FanOutNode): MaybeTag {
    const feed = this.feeds.get(node.id)?.get(FAN_OUT_OVER_PORT_ID);
    return feed === undefined ? undefined : this.producerTag(feed.from);
  }

  private stateTag(node: LoopNode): MaybeTag {
    const feed = this.feeds.get(node.id)?.get(SINGLE_INPUT_PORT_ID);
    return feed === undefined ? undefined : this.producerTag(feed.from);
  }

  /**
   * The node's effective producer tag, optional-wrapped for optional nodes.
   * Memoized with an in-progress guard: a tag that depends on itself (a
   * fanOut collecting a body whose state re-enters it) is a typed-channel
   * cycle the node-graph sort cannot see.
   */
  private effectiveOut(node: Node): MaybeTag {
    const existing = this.outTags.get(node.id);
    if (existing !== undefined) {
      if (existing.status === 'resolving') {
        if (!this.tagCycleReported) {
          this.tagCycleReported = true;
          this.report('cycle_detected', `typed channel of '${node.id}' depends on itself`, {
            nodeId: node.id,
          });
        }
        return undefined;
      }
      return existing.tag;
    }
    const resolution: TagResolution = { status: 'resolving', tag: undefined };
    this.outTags.set(node.id, resolution);
    const base = match<Node, MaybeTag>(node)
      .with({ type: 'modelCall' }, (n) => this.valuePorts.get(n.id)?.out)
      .with({ type: 'transform' }, (n) => this.valuePorts.get(n.id)?.out)
      .with({ type: 'subWorkflow' }, (n) => this.valuePorts.get(n.id)?.out)
      .with({ type: 'smartModel' }, (n) => this.valuePorts.get(n.id)?.out)
      .with({ type: 'branch' }, (n) => this.predicateInputs.get(n.id))
      .with({ type: 'fanIn' }, (n) => this.reducerSignatures.get(n.id)?.out)
      .with({ type: 'loop' }, (n) => this.stateTag(n))
      .with({ type: 'fanOut' }, (n) => {
        const body = this.byId.get(n.body);
        const bodyOut = body === undefined ? undefined : this.effectiveOut(body);
        return bodyOut === undefined ? undefined : listTag(bodyOut);
      })
      .exhaustive();
    resolution.status = 'done';
    resolution.tag = base !== undefined && node.optional ? optionalTag(base) : base;
    return resolution.tag;
  }

  private buildArtifact(order: readonly NodeId[]): CompiledDefinition {
    const nodes = new Map<string, CompiledNode>();
    for (const node of this.definition.nodes) {
      const inputs = new Map<string, CompiledNodeInput>();
      for (const port of this.consumerPorts(node) ?? []) {
        const feed = this.feeds.get(node.id)?.get(port);
        if (feed === undefined) continue;
        const tag = this.expectedTag(node, port) ?? this.producerTag(feed.from);
        inputs.set(port, { from: feed.from, tag: mustResolve(tag, node.id, port) });
      }
      nodes.set(node.id, {
        node,
        inputs,
        out: mustResolve(this.effectiveOut(node), node.id, node.out),
      });
    }
    return {
      definition: this.definition,
      workflowInputs: this.context.workflowInputs,
      nodes,
      order,
      consumedProducers: consumedProducerIds(this.definition),
    };
  }

  /**
   * Validates a registry- or caller-supplied tag at the boundary; a forged
   * bare json or malformed tag becomes invalid_type_tag, a dangling schema
   * name unknown_schema_name. Returns undefined so dependent checks skip
   * instead of cascading.
   */
  private validateTag(tag: TypeTag, label: string, ref: CompileErrorRef): MaybeTag {
    const parsed = TypeTagSchema.safeParse(tag);
    if (!parsed.success) {
      this.report('invalid_type_tag', `${label} is not a well-formed type tag`, ref);
      return undefined;
    }
    const dangling = unresolvedSchemaNames(parsed.data, this.context);
    if (dangling.length > 0) {
      for (const name of dangling) {
        this.report(
          'unknown_schema_name',
          `${label} references unregistered schema '${name}'`,
          ref
        );
      }
      return undefined;
    }
    return parsed.data;
  }

  private report(code: CompileError['code'], detail: string, ref: CompileErrorRef = {}): void {
    this.errors.push(compileError(code, detail, ref));
  }
}

const IDENTITY_CODES: ReadonlySet<string> = new Set([
  'reserved_node_id',
  'duplicate_node_id',
  'reserved_port_id',
]);

function feedKey(nodeId: string, port: string): string {
  return JSON.stringify([nodeId, port]);
}

function countOf(map: ReadonlyMap<string, number>, key: string): number {
  return map.get(key) ?? 0;
}

const NO_SUCCESSORS: ReadonlySet<NodeId> = new Set();

function successorsOf(
  map: ReadonlyMap<string, ReadonlySet<NodeId>>,
  key: string
): ReadonlySet<NodeId> {
  return map.get(key) ?? NO_SUCCESSORS;
}

function edgeRef(edge: Edge): EdgeRefLike {
  return {
    from: { node: edge.from.node, port: edge.from.port },
    to: { node: edge.to.node, port: edge.to.port },
  };
}

function positionalIndex(port: string): number {
  return Number(port.slice(2));
}

/** Execution-ordering edges a node imposes beyond dataflow. */
function controlTargets(node: Node): readonly NodeId[] {
  switch (node.type) {
    case 'fanOut':
    case 'loop': {
      return [node.body];
    }
    case 'branch': {
      return [...Object.values(node.cases), node.else].filter((target) => target !== END_NODE_ID);
    }
    case 'modelCall':
    case 'transform':
    case 'fanIn':
    case 'subWorkflow':
    case 'smartModel': {
      return [];
    }
  }
}

function unresolvedSchemaNames(tag: TypeTag, context: CompileContext): string[] {
  switch (tag.kind) {
    case 'json': {
      return context.constraints.resolve('schema', tag.schemaName) === undefined
        ? [tag.schemaName]
        : [];
    }
    case 'optional':
    case 'list': {
      return unresolvedSchemaNames(tag.inner, context);
    }
    case 'text':
    case 'media': {
      return [];
    }
  }
}

function mustResolve(tag: MaybeTag, nodeId: string, port: string): TypeTag {
  if (tag === undefined) {
    throw new Error(`unresolved tag survived a clean compile at ${nodeId}.${port}`);
  }
  return tag;
}
