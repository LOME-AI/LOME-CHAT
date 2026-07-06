import { match } from 'ts-pattern';
import { ContentValue, DEADLINE_CLASS_MS, END_NODE_ID, ERROR_CODES, zodFor } from '@hushbox/shared';
import { compileDefinition } from '../compile/compile-definition.js';
import {
  FAN_OUT_ELEMENT_PORT_ID,
  LOOP_STATE_PORT_ID,
  reservedOutPortId,
  WORKFLOW_INPUT_NODE_ID,
} from '../compile/conventions.js';
import { channelValueOf, contentValueOf, inputTagOf } from './channel-values.js';
import { circuitReadoutOf } from './hooks.js';
import { createValueStore, VALUE_STORE_BYTE_BUDGET_BYTES } from './value-store.js';
import { runFailureCode } from './failures.js';
import type {
  FlowExecutor,
  FlowRunHandle,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStopReason,
  NanoUSD,
  Node,
  NodeId,
  SchemaNameRegistry,
  SettlementCharge,
  TypeTag,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  CompiledDefinition,
  CompiledNode,
  CompiledNodeInput,
} from '../compile/compile-definition.js';
import type { CompileContext, ValueNode } from '../compile/context.js';
import type {
  EngineClock,
  EngineExecutionRegistry,
  EngineRng,
  NodeRunContext,
  NodeRunSuccess,
  RegisteredPredicate,
} from './execution-registry.js';
import type { RunFailure } from './failures.js';
import type { ValueStore } from './value-store.js';

/**
 * The in-memory workflow interpreter: one continuous execution inside the
 * conversation DO, values passing through the byte-metered ValueStore,
 * nothing durable until the settlement hook commits. The engine owns run
 * sequencing — ingress validation, the server-computed estimate, admission,
 * the deadline, the `hold × K` cost circuit, and settlement ordering; no run
 * starts or settles except through the definition's declared policy hooks.
 *
 * One run per conversation is enforced upstream: the ConversationRoom DO
 * claims via RunControl and the idempotency-key row before `start()` — this
 * module runs exactly the one run it was handed.
 */

export interface WorkflowExecutorDeps {
  /** Compile-time registries: node port declarations + named constraints. */
  readonly registries: Omit<CompileContext, 'workflowInputs'>;
  readonly execution: EngineExecutionRegistry;
  /**
   * Prices the definition's declared ceiling (max width × steps ×
   * iterations). The admission hook only ever receives this server-computed
   * estimate — no path accepts a caller-supplied one.
   */
  readonly estimateRun: (definition: WorkflowDefinition) => Result<NanoUSD, DomainError>;
  readonly clock: EngineClock;
  readonly rng: EngineRng;
  readonly telemetry: Telemetry;
  readonly valueBudgetBytes?: number;
}

type NodeStep =
  | { readonly kind: 'ok' }
  | { readonly kind: 'end' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'failed'; readonly failure: RunFailure };

type BoundaryGate = 'continue' | 'stopped' | 'circuit';

type LoopGate =
  | { readonly action: 'break' }
  | { readonly action: 'iterate' }
  | { readonly action: 'terminal'; readonly step: NodeStep };

interface Scope {
  /** Channel writes land here; reads walk the parent chain. */
  readonly channels: Map<string, unknown>;
  /** Per-invocation virtual producer ports (fanOut element, loop state). */
  readonly virtual: ReadonlyMap<string, unknown>;
  readonly parent?: Scope;
}

function virtualKey(nodeId: string, port: string): string {
  return JSON.stringify([nodeId, port]);
}

/**
 * Declared input feeds in positional order. A clean compile guarantees every
 * declared port is fed, so the feed map is complete; positional ports
 * ('in0'…) sort numerically, single-port nodes are order-free.
 */
function feedsInPortOrder(compiledNode: CompiledNode): readonly CompiledNodeInput[] {
  return [...compiledNode.inputs.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
    .map(([, feed]) => feed);
}

const FAILED_DEFECT: NodeStep = { kind: 'failed', failure: { kind: 'defect' } };

/** Single-use state and logic for one run. */
class RunExecution {
  private readonly store: ValueStore;
  private readonly controller = new AbortController();
  private readonly rootScope: Scope = { channels: new Map(), virtual: new Map() };
  private readonly inputChannels = new Map<string, unknown>();
  private readonly schemaRegistry: SchemaNameRegistry;
  /** Set by a clean ingest; walk and finalize run only after it. */
  private compiled!: CompiledDefinition;
  private childDriven: ReadonlySet<string> = new Set();
  private skipped = new Set<string>();
  private accruedNanoUsd = 0n;
  /**
   * One per-generation billing record per successful modelCall, keyed for
   * content pairing (single-settlement: charges materialize only at
   * settlement). Handed to the settlement hook on both the success and the
   * stopped-partial paths.
   */
  private readonly charges: SettlementCharge[] = [];
  private limitNanoUsd = 0n;
  private stopReason: FlowStopReason | undefined;
  private circuitTripped = false;
  private deadlineAtMs: number;
  private streamSequence = 0;

  constructor(
    private readonly deps: WorkflowExecutorDeps,
    private readonly request: FlowStartRequest
  ) {
    this.store = createValueStore(deps.valueBudgetBytes ?? VALUE_STORE_BYTE_BUDGET_BYTES);
    this.schemaRegistry = {
      resolveSchema: (name) => deps.registries.constraints.resolve('schema', name)?.schema,
    };
    this.deadlineAtMs = deps.clock.now() + DEADLINE_CLASS_MS[request.definition.deadlineClass];
  }

  stop(reason: FlowStopReason): void {
    this.stopReason ??= reason;
    this.controller.abort();
  }

  async run(): Promise<FlowRunOutcome> {
    const ingress = this.ingest();
    if (ingress !== undefined) return this.finalizeFailed(ingress);
    const estimate = this.deps.estimateRun(this.request.definition);
    if (estimate.isErr()) return this.finalizeFailed({ kind: 'inputs-invalid' });
    const decision = await this.request.hooks.admission({
      definition: this.request.definition,
      estimate: estimate.value,
    });
    if (!decision.admitted) {
      return this.finalizeFailed({ kind: 'admission-refused', code: decision.code });
    }
    const circuit = circuitReadoutOf(decision);
    if (circuit === undefined) {
      this.deps.telemetry.warn('workflow admission grant carried no circuit readout', {
        runId: this.request.runKey,
      });
      return this.finalizeFailed({ kind: 'defect' });
    }
    this.limitNanoUsd = circuit.costCircuitLimitNanoUsd;
    return this.walk();
  }

  /** Validates, tags, and byte-meters the supplied inputs — before admission. */
  private ingest(): RunFailure | undefined {
    // Null-prototype accumulator: an input port name is any non-empty string,
    // so a port named '__proto__' would reparent a plain `{}` instead of adding
    // an own key, and inherited members ('__proto__', 'constructor', …) would
    // answer compile's `port in workflowInputs` existence check spuriously true
    // — silently masking a missing required input. Keyed as pure data here.
    const workflowInputs = Object.create(null) as Record<string, TypeTag>;
    for (const [name, supplied] of Object.entries(this.request.inputs)) {
      const parsed = ContentValue.safeParse(supplied);
      if (!parsed.success) return { kind: 'inputs-invalid' };
      const tag = inputTagOf(parsed.data);
      if (tag === undefined) return { kind: 'inputs-invalid' };
      const channelValue = channelValueOf(parsed.data);
      if (!zodFor(tag, this.schemaRegistry).safeParse(channelValue).success) {
        return { kind: 'inputs-invalid' };
      }
      const stored = this.store.store(channelValue);
      if (stored.isErr()) return { kind: 'byte-budget-exceeded' };
      this.inputChannels.set(name, stored.value);
      workflowInputs[name] = tag;
    }
    const compiled = compileDefinition(this.request.definition, {
      ...this.deps.registries,
      workflowInputs,
    });
    if (compiled.isErr()) return { kind: 'inputs-invalid' };
    this.compiled = compiled.value;
    this.childDriven = new Set(
      compiled.value.definition.nodes
        .filter((node) => node.type === 'fanOut' || node.type === 'loop')
        .map((node) => node.body as string)
    );
    return undefined;
  }

  // Precedence is stop > circuit (mirrored at the coincident fan-out boundary
  // in runFanOut): an explicit stop settles its billable partial, and it halts
  // accrual at the same boundary, so the circuit's exposure bound is unaffected.
  private boundary(): BoundaryGate {
    if (this.stopReason !== undefined) return 'stopped';
    if (this.deps.clock.now() >= this.deadlineAtMs) {
      this.stop('deadline');
      return 'stopped';
    }
    if (this.circuitTripped || this.accruedNanoUsd > this.limitNanoUsd) {
      this.circuitTripped = true;
      return 'circuit';
    }
    return 'continue';
  }

  private async walk(): Promise<FlowRunOutcome> {
    for (const nodeId of this.compiled.order) {
      if (this.childDriven.has(nodeId) || this.skipped.has(nodeId)) continue;
      const gated = await this.boundaryOutcome();
      if (gated !== undefined) return gated;
      const step = await this.executeNode(this.compiledNode(nodeId), this.rootScope);
      if (step.kind === 'end') break;
      const outcome = await this.stepOutcome(step);
      if (outcome !== undefined) return outcome;
    }
    const gated = await this.boundaryOutcome();
    if (gated !== undefined) return gated;
    return this.finalizeSuccess();
  }

  /** The step/branch/node boundary check, as a terminal outcome when it fires. */
  private async boundaryOutcome(): Promise<FlowRunOutcome | undefined> {
    const gate = this.boundary();
    if (gate === 'stopped') return this.finalizeStopped();
    if (gate === 'circuit') return this.finalizeFailed({ kind: 'cost-circuit-tripped' });
    return undefined;
  }

  private async stepOutcome(step: NodeStep): Promise<FlowRunOutcome | undefined> {
    if (step.kind === 'failed') return this.finalizeFailed(step.failure);
    if (step.kind === 'stopped') return this.finalizeStopped();
    return undefined;
  }

  /**
   * `chargeKey` overrides the key a produced charge is tagged with — set only
   * for a fanOut body (the node id + branch element index) so N multi-model
   * branches map to N content items. Undefined on the main walk and loop
   * iterations, where a charge is keyed by the producing node id alone.
   */
  private async executeNode(
    compiledNode: CompiledNode,
    scope: Scope,
    chargeKey?: string
  ): Promise<NodeStep> {
    const node = compiledNode.node;
    return match(node)
      .with({ type: 'modelCall' }, (valueNode) =>
        this.runValueNode(compiledNode, valueNode, scope, chargeKey)
      )
      .with({ type: 'transform' }, (valueNode) =>
        this.runValueNode(compiledNode, valueNode, scope, chargeKey)
      )
      .with({ type: 'subWorkflow' }, (valueNode) =>
        this.runValueNode(compiledNode, valueNode, scope, chargeKey)
      )
      .with({ type: 'branch' }, (branchNode) =>
        Promise.resolve(this.runBranch(compiledNode, branchNode, scope))
      )
      .with({ type: 'fanIn' }, (fanInNode) =>
        Promise.resolve(this.runFanIn(compiledNode, fanInNode, scope))
      )
      .with({ type: 'fanOut' }, (fanOutNode) => this.runFanOut(compiledNode, fanOutNode, scope))
      .with({ type: 'loop' }, (loopNode) => this.runLoop(compiledNode, loopNode, scope))
      .exhaustive();
  }

  private async runValueNode(
    compiledNode: CompiledNode,
    node: ValueNode,
    scope: Scope,
    chargeKey?: string
  ): Promise<NodeStep> {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'ok' };
    const execution = this.deps.execution.resolveExecution(node);
    if (execution === undefined) {
      return this.unregisteredDefect();
    }
    const context = this.nodeContext(node.id, execution.streaming);
    let result;
    try {
      result = await execution.run(node, resolved, context);
    } catch (error) {
      this.deps.telemetry.captureError(
        error instanceof Error ? error : new Error(String(error)),
        'workflow_node_defect'
      );
      return FAILED_DEFECT;
    }
    if (result.isErr()) {
      this.accruedNanoUsd += result.error.costNanoUsd ?? 0n;
      if (this.stopReason !== undefined) return { kind: 'stopped' };
      return this.applyNodeFailure(node, scope);
    }
    this.accruedNanoUsd += result.value.costNanoUsd;
    this.collectCharge(chargeKey ?? node.id, result.value);
    return this.commitValue(compiledNode, node, scope, result.value.value);
  }

  /**
   * Lifts a modelCall's per-generation facts into a keyed settlement charge.
   * Only modelCall executions carry `billing`; transform/control successes
   * produce no billable generation, so this is a no-op for them. A failing
   * generation produces no content and is never charged (saved ⟺ billed).
   */
  private collectCharge(key: string, success: NodeRunSuccess): void {
    const billing = success.billing;
    if (billing === undefined) return;
    this.charges.push({
      key,
      modelId: billing.modelId,
      providerName: billing.providerName,
      modality: billing.modality,
      ...(billing.generationId === undefined ? {} : { generationId: billing.generationId }),
      baseCostNanoUsd: success.costNanoUsd,
      isEstimated: success.isEstimated ?? false,
    });
  }

  /** Output validation is THE runtime type check: zodFor over the declared tag. */
  private commitValue(
    compiledNode: CompiledNode,
    node: Node,
    scope: Scope,
    value: unknown
  ): NodeStep {
    if (!zodFor(compiledNode.out, this.schemaRegistry).safeParse(value).success) {
      return this.applyNodeFailure(node, scope);
    }
    const stored = this.store.store(value);
    if (stored.isErr()) {
      return { kind: 'failed', failure: { kind: 'byte-budget-exceeded' } };
    }
    scope.channels.set(node.id, stored.value);
    return { kind: 'ok' };
  }

  private applyNodeFailure(node: Node, scope: Scope): NodeStep {
    if (node.onError === 'skip') {
      scope.channels.set(node.id, undefined);
      return { kind: 'ok' };
    }
    return { kind: 'failed', failure: { kind: 'node-failed', nodeId: node.id } };
  }

  private runBranch(
    compiledNode: CompiledNode,
    node: Extract<Node, { type: 'branch' }>,
    scope: Scope
  ): NodeStep {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'ok' };
    const predicate = this.deps.execution.resolvePredicate(node.predicate);
    if (predicate === undefined) {
      return this.unregisteredDefect();
    }
    const verdict = predicate(resolved[0]);
    if (typeof verdict !== 'string') {
      this.deps.telemetry.warn('workflow branch verdict was not a case label', {
        runId: this.request.runKey,
      });
      return FAILED_DEFECT;
    }
    // Own-property guard: a branch verdict is model-influenceable, and a bare
    // lookup returns inherited Object.prototype members ('constructor',
    // '__proto__', 'hasOwnProperty', …) as spurious case hits — a bare `??`
    // never falls through to `else`, so every declared target dead-paths and
    // the run finalizes SUCCEEDED with empty outputs. Only a declared own case
    // may divert from `else`.
    const chosen = Object.hasOwn(node.cases, verdict) ? node.cases[verdict] : node.else;
    for (const target of new Set([...Object.values(node.cases), node.else])) {
      if (target !== chosen && (target as string) !== (END_NODE_ID as string)) {
        this.skipped.add(target);
      }
    }
    scope.channels.set(node.id, resolved[0]);
    if ((chosen as string) === (END_NODE_ID as string)) return { kind: 'end' };
    return { kind: 'ok' };
  }

  private runFanIn(
    compiledNode: CompiledNode,
    node: Extract<Node, { type: 'fanIn' }>,
    scope: Scope
  ): NodeStep {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'ok' };
    const reducer = this.deps.execution.resolveReducer(node.reducer);
    if (reducer === undefined) {
      return this.unregisteredDefect();
    }
    return this.commitValue(compiledNode, node, scope, reducer(resolved));
  }

  private async runFanOut(
    compiledNode: CompiledNode,
    node: Extract<Node, { type: 'fanOut' }>,
    scope: Scope
  ): Promise<NodeStep> {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'ok' };
    const elements = resolved[0] as readonly unknown[];
    if (elements.length > node.maxWidth) {
      return this.applyNodeFailure(node, scope);
    }
    const body = this.compiledNode(node.body);
    const branches = await Promise.all(
      elements.map((element, index) => this.runFanBranch(node, body, { element, index }, scope))
    );
    const failed = branches.find(
      (outcome): outcome is { step: NodeStep & { kind: 'failed' }; value: unknown } =>
        outcome.step.kind === 'failed'
    );
    // Coincident-boundary precedence, consistent with boundary(): stop >
    // circuit > branch failure. An explicit stop is a documented settlement
    // path — a WS-blocked user aborts a paid run and is billed for the partial
    // — and it halts accrual at the same boundary, so the circuit's exposure
    // bound is unaffected; the run stops and the partial settles. Absent a
    // stop, a circuit trip outranks a plain branch failure: its
    // INSUFFICIENT_ADMISSION is the more specific, actionable signal.
    if (
      this.stopReason !== undefined ||
      branches.some((outcome) => outcome.step.kind === 'stopped')
    ) {
      return { kind: 'stopped' };
    }
    if (this.circuitTripped) return { kind: 'failed', failure: { kind: 'cost-circuit-tripped' } };
    if (failed !== undefined) return failed.step;
    return this.commitValue(
      compiledNode,
      node,
      scope,
      branches.map((outcome) => outcome.value)
    );
  }

  /** Branch completion is a circuit boundary: a crossing kills the siblings. */
  private async runFanBranch(
    node: Extract<Node, { type: 'fanOut' }>,
    body: CompiledNode,
    branch: { readonly element: unknown; readonly index: number },
    scope: Scope
  ): Promise<{ step: NodeStep; value: unknown }> {
    const branchScope: Scope = {
      channels: new Map(),
      virtual: new Map([[virtualKey(node.id, FAN_OUT_ELEMENT_PORT_ID), branch.element]]),
      parent: scope,
    };
    // A per-branch charge key pairs each branch's generation to its own
    // content item (N multi-model branches → N content items).
    const step = await this.executeNode(
      body,
      branchScope,
      `${body.node.id}#${String(branch.index)}`
    );
    if (!this.circuitTripped && this.accruedNanoUsd > this.limitNanoUsd) {
      this.circuitTripped = true;
      this.controller.abort();
    }
    // The end sentinel inside a fan branch ends that branch, not the run:
    // the branch's passthrough value is already in its scope.
    const localized: NodeStep = step.kind === 'end' ? { kind: 'ok' } : step;
    return { step: localized, value: branchScope.channels.get(body.node.id) };
  }

  private async runLoop(
    compiledNode: CompiledNode,
    node: Extract<Node, { type: 'loop' }>,
    scope: Scope
  ): Promise<NodeStep> {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'ok' };
    const predicate = this.deps.execution.resolvePredicate(node.until);
    if (predicate === undefined) {
      return this.unregisteredDefect();
    }
    const body = this.compiledNode(node.body);
    let state = resolved[0];
    for (let iteration = 0; iteration < node.maxIterations; iteration += 1) {
      const gate = this.loopGate(predicate, state);
      if (gate.action === 'break') break;
      if (gate.action === 'terminal') return gate.step;
      const iterated = await this.runLoopIteration(node, body, scope, state);
      if (iterated.step !== undefined) return iterated.step;
      state = iterated.state;
    }
    scope.channels.set(node.id, state);
    return { kind: 'ok' };
  }

  /** Every iteration is a step boundary before the condition is consulted. */
  private loopGate(predicate: RegisteredPredicate, state: unknown): LoopGate {
    const gate = this.boundary();
    if (gate === 'stopped') return { action: 'terminal', step: { kind: 'stopped' } };
    if (gate === 'circuit') {
      return {
        action: 'terminal',
        step: { kind: 'failed', failure: { kind: 'cost-circuit-tripped' } },
      };
    }
    const verdict = predicate(state);
    if (typeof verdict !== 'boolean') {
      this.deps.telemetry.warn('workflow loop condition was not a boolean', {
        runId: this.request.runKey,
      });
      return { action: 'terminal', step: FAILED_DEFECT };
    }
    return verdict ? { action: 'break' } : { action: 'iterate' };
  }

  private async runLoopIteration(
    node: Extract<Node, { type: 'loop' }>,
    body: CompiledNode,
    scope: Scope,
    state: unknown
  ): Promise<{ readonly step?: NodeStep; readonly state: unknown }> {
    const iterationScope: Scope = {
      channels: new Map(),
      virtual: new Map([[virtualKey(node.id, LOOP_STATE_PORT_ID), state]]),
      parent: scope,
    };
    const step = await this.executeNode(body, iterationScope);
    if (step.kind !== 'ok') return { step, state };
    // A skip-on-error iteration keeps the previous state; the bound still
    // terminates the loop.
    return { state: iterationScope.channels.get(body.node.id) ?? state };
  }

  /**
   * Resolves declared inputs; undefined means a required feed comes from an
   * untaken path, so the node itself joins the skipped set (dead-path
   * propagation).
   */
  private resolveLiveInputs(compiledNode: CompiledNode, scope: Scope): unknown[] | undefined {
    const values: unknown[] = [];
    for (const feed of feedsInPortOrder(compiledNode)) {
      const resolution = this.resolveFeed(feed, scope);
      if (resolution.kind === 'dead') {
        this.skipped.add(compiledNode.node.id);
        return undefined;
      }
      values.push(resolution.value);
    }
    return values;
  }

  /** A definition naming an unregistered implementation is a wiring defect. */
  private unregisteredDefect(): NodeStep {
    this.deps.telemetry.warn('workflow definition names an unregistered runtime implementation', {
      runId: this.request.runKey,
    });
    return FAILED_DEFECT;
  }

  private resolveFeed(
    feed: CompiledNodeInput,
    scope: Scope
  ): { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'dead' } {
    if (feed.from.node === WORKFLOW_INPUT_NODE_ID) {
      return { kind: 'value', value: this.inputChannels.get(feed.from.port) };
    }
    const key = virtualKey(feed.from.node, feed.from.port);
    for (let current: Scope | undefined = scope; current !== undefined; current = current.parent) {
      if (current.virtual.has(key)) {
        return { kind: 'value', value: current.virtual.get(key) };
      }
      if (current.channels.has(feed.from.node)) {
        return { kind: 'value', value: this.store.resolve(current.channels.get(feed.from.node)) };
      }
    }
    // The producer never ran: it sits on a branch path the run did not take.
    if (feed.tag.kind === 'optional') return { kind: 'value', value: undefined };
    return { kind: 'dead' };
  }

  private nodeContext(nodeId: string, streaming: boolean): NodeRunContext {
    const base = {
      values: this.store,
      clock: this.deps.clock,
      rng: this.deps.rng,
      signal: this.controller.signal,
    };
    if (!streaming) return base;
    const streamId = `${nodeId}#${String(this.streamSequence)}`;
    this.streamSequence += 1;
    let cursor = 0;
    return {
      ...base,
      emit: (event): void => {
        this.request.emit({ streamId, cursor, event });
        cursor += 1;
      },
    };
  }

  /**
   * Run outputs: values of sink nodes — nodes no dataflow edge consumes
   * (virtual body feeds excluded), bodies and control nodes aside.
   */
  private sinkOutputs(): Record<string, ContentValue> {
    const consumed = this.consumedProducers();
    // Null-prototype accumulator: a NodeId is any non-empty string, so a node
    // named '__proto__' (or another reserved prototype name) would set this
    // object's prototype instead of an own key on a plain `{}`, silently
    // dropping its billable output from settlement. Keyed as pure data here.
    const outputs = Object.create(null) as Record<string, ContentValue>;
    for (const nodeId of this.compiled.order) {
      if (!this.isSink(nodeId, consumed)) continue;
      const value = this.rootScope.channels.get(nodeId);
      if (value !== undefined) outputs[nodeId] = contentValueOf(value);
    }
    return outputs;
  }

  private consumedProducers(): ReadonlySet<string> {
    const consumed = new Set<string>();
    for (const compiledNode of this.compiled.nodes.values()) {
      for (const input of compiledNode.inputs.values()) {
        if (input.from.node === WORKFLOW_INPUT_NODE_ID) continue;
        // Virtual body feeds (fanOut element, loop state) are not
        // consumption of the parent's out channel.
        const producer = this.compiledNode(input.from.node).node;
        if (input.from.port === reservedOutPortId(producer)) continue;
        consumed.add(input.from.node);
      }
    }
    return consumed;
  }

  private isSink(nodeId: string, consumed: ReadonlySet<string>): boolean {
    return (
      !consumed.has(nodeId) &&
      !this.childDriven.has(nodeId) &&
      this.compiledNode(nodeId).node.type !== 'branch'
    );
  }

  private async settle(outputs: Record<string, ContentValue>): Promise<RunFailure | undefined> {
    try {
      await this.request.hooks.settlement({
        runKey: this.request.runKey,
        outputs,
        charges: this.charges,
      });
      return undefined;
    } catch (error) {
      this.deps.telemetry.captureError(
        error instanceof Error ? error : new Error(String(error)),
        'workflow_settlement_defect'
      );
      return { kind: 'defect' };
    }
  }

  private async finalizeSuccess(): Promise<FlowRunOutcome> {
    const failure = await this.settle(this.sinkOutputs());
    if (failure !== undefined) return this.finalizeFailed(failure);
    return { outcome: 'succeeded' };
  }

  /**
   * A stopped run settles its billable partial — exactly like an explicit
   * stop; a stop with nothing produced leaves zero committed effects (the
   * hold TTLs out, the key-row lease lapses).
   */
  private async finalizeStopped(): Promise<FlowRunOutcome> {
    const outputs = this.sinkOutputs();
    if (Object.keys(outputs).length > 0) {
      const failure = await this.settle(outputs);
      if (failure !== undefined) return this.finalizeFailed(failure);
    }
    return { outcome: 'stopped' };
  }

  private finalizeFailed(failure: RunFailure): FlowRunOutcome {
    const code = runFailureCode(failure);
    this.deps.telemetry.warn('workflow run failed', {
      runId: this.request.runKey,
      errorCode: code,
    });
    return { outcome: 'failed', code };
  }

  private compiledNode(nodeId: NodeId | string): CompiledNode {
    const found = this.compiled.nodes.get(nodeId as string);
    if (found === undefined) {
      // Unreachable after a clean compile: every ordered/referenced id
      // registers a compiled node.
      throw new Error('workflow interpreter referenced a node the compile did not register');
    }
    return found;
  }
}

async function runContained(
  execution: RunExecution,
  deps: WorkflowExecutorDeps
): Promise<FlowRunOutcome> {
  try {
    return await execution.run();
  } catch (error) {
    deps.telemetry.captureError(
      error instanceof Error ? error : new Error(String(error)),
      'workflow_run_defect'
    );
    return { outcome: 'failed', code: ERROR_CODES.INTERNAL };
  }
}

export function createWorkflowExecutor(deps: WorkflowExecutorDeps): FlowExecutor {
  return {
    start: (request: FlowStartRequest): FlowRunHandle => {
      const execution = new RunExecution(deps, request);
      return {
        runId: request.runKey,
        done: runContained(execution, deps),
        stop: (reason: FlowStopReason): void => {
          execution.stop(reason);
        },
      };
    },
  };
}
