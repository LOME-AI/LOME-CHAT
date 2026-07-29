import { match } from 'ts-pattern';
import {
  ContentValue,
  DEADLINE_CLASS_MS,
  END_NODE_ID,
  ERROR_CODES,
  isTurnClassifierNode,
  VALUE_STORE_BYTE_BUDGET_BYTES,
  zodFor,
} from '@hushbox/shared';
import { domainWireCode } from '../../../lib/errors/index.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import { compileDefinition } from '../compile/compile-definition.js';
import {
  FAN_OUT_ELEMENT_PORT_ID,
  LOOP_STATE_PORT_ID,
  WORKFLOW_INPUT_NODE_ID,
} from '../compile/conventions.js';
import { channelValueOf, contentValueOf, inputTagOf } from './channel-values.js';
import { circuitReadoutOf } from './hooks.js';
import { createValueStore } from './value-store.js';
import {
  AllBranchesFailedError,
  SettlementConflictError,
  StorageUnavailableError,
  runFailureCode,
} from './failures.js';
import { DEFAULT_COMPILE_LIMITS } from '../compile/context.js';
import type {
  FlowAdmissionOutcome,
  FlowExecutor,
  FlowRunHandle,
  FlowRunOutcome,
  FlowStartRequest,
  ErrorCode,
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
  NodeBillingMetadata,
  NodeRunError,
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

/**
 * The video adapter aborts an over-budget download by throwing an error with
 * this name (see `models/adapters/video-adapter.ts`). It is recognized
 * STRUCTURALLY here — a cross-slice name check, never a value import (the engine
 * must not depend on the models slice) — mirroring how the node layer recognizes
 * `InferenceError`.
 */
const DOWNLOAD_BYTE_CAP_EXCEEDED_NAME = 'DownloadByteCapExceeded';

function isDownloadByteCapExceeded(error: unknown): boolean {
  return error instanceof Error && error.name === DOWNLOAD_BYTE_CAP_EXCEEDED_NAME;
}

/**
 * The bound on how many sibling nodes stream at once within one topological
 * level. It is the platform's 6-simultaneous-outbound-connections cap — the
 * same fact the compile fan-out-width default encodes (see its doc comment):
 * a wider level queues at the socket layer rather than open a 7th connection.
 */
const LEVEL_STREAM_CONCURRENCY = DEFAULT_COMPILE_LIMITS.maxFanOutWidth;

/**
 * Runs `run` over `items` with at most `limit` in flight, returning results in
 * input order (never completion order) so the caller can apply them
 * deterministically. Index handout is synchronous, so no two workers claim the
 * same item.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await run(item, index);
    }
  };
  const width = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

function isValueNode(node: Node): node is ValueNode {
  return (
    node.type === 'modelCall' ||
    node.type === 'transform' ||
    node.type === 'subWorkflow' ||
    node.type === 'smartModel'
  );
}

/**
 * The execution-ordering successors a node imposes beyond dataflow — a branch's
 * case/else targets and a fanOut/loop body. Level layering must honor these so
 * a branch's targets never share the branch's level (their skip is decided only
 * after the branch runs). Mirrors the compiler's own control-edge set.
 */
function controlTargetsOf(node: Node): readonly string[] {
  if (node.type === 'branch') {
    return [...Object.values(node.cases), node.else].filter(
      (target) => (target as string) !== (END_NODE_ID as string)
    );
  }
  if (node.type === 'fanOut' || node.type === 'loop') return [node.body as string];
  return [];
}

/** A node's produced work, split so value-node charges apply in level order. */
type Produced =
  | { readonly kind: 'step'; readonly step: NodeStep }
  | {
      readonly kind: 'value';
      readonly compiledNode: CompiledNode;
      readonly node: ValueNode;
      readonly result: Result<NodeRunSuccess, NodeRunError>;
    };

type ProducedValue =
  | { readonly kind: 'step'; readonly step: NodeStep }
  | { readonly kind: 'result'; readonly result: Result<NodeRunSuccess, NodeRunError> };

/**
 * The outcome of committing a produced value: whether it reached its channel,
 * and the step that follows. The two are separate because they are separate
 * facts — a `skip`-declared node that failed validation continues the run (`ok`)
 * having committed nothing, and only `committed` distinguishes it.
 */
interface CommitOutcome {
  readonly committed: boolean;
  readonly step: NodeStep;
}

/** Everything the ordered apply of a value node needs, bundled to keep params low. */
interface ValueTarget {
  readonly compiledNode: CompiledNode;
  readonly node: ValueNode;
  readonly scope: Scope;
  readonly chargeKey?: string | undefined;
}

/** How a completed level resolves the walk: nothing (continue), end, or terminal. */
type LevelResolution =
  | { readonly kind: 'end' }
  | { readonly kind: 'outcome'; readonly outcome: FlowRunOutcome };

/** Single-use state and logic for one run. */
class RunExecution {
  private readonly store: ValueStore;
  private readonly controller = new AbortController();
  private admittedResolve!: (outcome: FlowAdmissionOutcome) => void;
  readonly admitted: Promise<FlowAdmissionOutcome>;
  private readonly rootScope: Scope = { channels: new Map(), virtual: new Map() };
  private readonly inputChannels = new Map<string, unknown>();
  private readonly schemaRegistry: SchemaNameRegistry;
  /** Set by a clean ingest; walk and finalize run only after it. */
  private compiled!: CompiledDefinition;
  private childDriven: ReadonlySet<string> = new Set();
  private skipped = new Set<string>();
  /** Topological order grouped into levels of mutually-independent nodes. */
  private levels: readonly (readonly string[])[] = [];
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
    this.admitted = new Promise<FlowAdmissionOutcome>((resolve) => {
      this.admittedResolve = resolve;
    });
  }

  stop(reason: FlowStopReason): void {
    this.stopReason ??= reason;
    this.controller.abort();
  }

  /**
   * The admission decision, surfaced on the run handle (`FlowRunHandle.admitted`)
   * so the DO answers the start request synchronously and learns the hold
   * identity its terminal sink releases. Resolving twice is a harmless no-op
   * (promise semantics), which is what makes the post-`done` fallback safe.
   */
  resolveAdmitted(outcome: FlowAdmissionOutcome): void {
    this.admittedResolve(outcome);
  }

  /**
   * The post-`done` backstop: a defect that escaped before the admission
   * decision must still settle `admitted` or the DO's start request would hang.
   */
  settleAdmittedFromOutcome(outcome: FlowRunOutcome): void {
    this.admittedResolve({
      admitted: false,
      code: outcome.outcome === 'failed' ? outcome.code : ERROR_CODES.INTERNAL,
    });
  }

  /** A failure before the admission hook ran: the refusal code IS the failure code. */
  private failBeforeAdmission(failure: RunFailure): FlowRunOutcome {
    this.resolveAdmitted({ admitted: false, code: runFailureCode(failure) });
    return this.finalizeFailed(failure);
  }

  async run(): Promise<FlowRunOutcome> {
    const ingress = this.ingest();
    if (ingress !== undefined) return this.failBeforeAdmission(ingress);
    const estimate = this.deps.estimateRun(this.request.definition);
    if (estimate.isErr()) {
      const wireCode = estimate.error.wireCode;
      return this.failBeforeAdmission({
        kind: 'inputs-invalid',
        ...(wireCode === undefined ? {} : { code: wireCode }),
      });
    }
    const decision = await this.request.hooks.admission({
      definition: this.request.definition,
      estimate: estimate.value,
    });
    if (!decision.admitted) {
      this.resolveAdmitted({ admitted: false, code: decision.code });
      return this.finalizeFailed({ kind: 'admission-refused', code: decision.code });
    }
    // Resolved BEFORE the circuit-readout check: once the hook granted, a hold
    // may exist, and the terminal sink must learn its identity even when a
    // malformed grant fails the run one line later.
    this.resolveAdmitted({
      admitted: true,
      ...(decision.hold === undefined ? {} : { hold: decision.hold }),
    });
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
    this.levels = this.computeLevels();
    return undefined;
  }

  /**
   * Groups the topological order into levels where every node's producers and
   * control parents sit in strictly earlier levels. Nodes sharing a level are
   * mutually independent, so the walk streams them concurrently.
   */
  private computeLevels(): readonly (readonly string[])[] {
    const predecessors = this.buildPredecessors();
    const levelOf = new Map<string, number>();
    const buckets: string[][] = [];
    for (const id of this.compiled.order) {
      let level = 0;
      for (const dep of predecessors.get(id) ?? []) {
        level = Math.max(level, (levelOf.get(dep) ?? 0) + 1);
      }
      levelOf.set(id, level);
      const bucket = buckets[level] ?? [];
      buckets[level] = bucket;
      bucket.push(id);
    }
    return buckets;
  }

  /** The dataflow + control-edge predecessors of every node, by node id. */
  private buildPredecessors(): ReadonlyMap<string, ReadonlySet<string>> {
    const predecessors = new Map<string, Set<string>>();
    const addEdge = (from: string, to: string): void => {
      /* v8 ignore next -- unreachable: the compile validates every edge endpoint, so `to` is always a registered node */
      if (!this.compiled.nodes.has(to)) return;
      const set = predecessors.get(to) ?? new Set<string>();
      set.add(from);
      predecessors.set(to, set);
    };
    for (const compiledNode of this.compiled.nodes.values()) {
      for (const input of compiledNode.inputs.values()) {
        if (input.from.node === WORKFLOW_INPUT_NODE_ID) continue;
        addEdge(input.from.node, compiledNode.node.id);
      }
      for (const target of controlTargetsOf(compiledNode.node)) {
        addEdge(compiledNode.node.id, target);
      }
    }
    return predecessors;
  }

  // Precedence is stop > circuit (mirrored at the coincident fan-out boundary
  // in runFanOut): an explicit stop settles its billable partial, and it halts
  // accrual at the same boundary, so the circuit's exposure bound is unaffected.
  //
  // Under bounded-concurrency streaming the cost-circuit exposure bound is
  // `hold × K + (concurrent width) × max-step-cost`, not `hold × K + max-step-cost`.
  // The circuit only fires at a level/branch boundary, so up to `width` provider
  // calls may be in flight when it trips, and an in-flight call's cost cannot be
  // un-spent — hence `× width`, not `× 1` as a sequential walk would bound it.
  // The `hold` already scales with the declared fan-out width, so the bound stays
  // finite and admission-proportional.
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
    for (const level of this.levels) {
      // Skipped/child-driven nodes never execute and consume no boundary check;
      // an all-inert level is a no-op, exactly as a sequential walk skips them.
      const executable = level.filter((nodeId) => this.isExecutable(nodeId));
      if (executable.length === 0) continue;
      const gated = await this.boundaryOutcome();
      if (gated !== undefined) return gated;
      const resolution = await this.runLevel(executable);
      if (resolution?.kind === 'outcome') return resolution.outcome;
      if (resolution?.kind === 'end') break;
    }
    const gated = await this.boundaryOutcome();
    if (gated !== undefined) return gated;
    return this.finalizeSuccess();
  }

  private isExecutable(nodeId: string): boolean {
    return !this.childDriven.has(nodeId) && !this.skipped.has(nodeId);
  }

  /**
   * Streams a level's independent nodes concurrently (bounded), then applies
   * each in topological order — value-node charges and channel writes land in
   * declaration order regardless of which stream finished first, so a
   * multi-model turn's per-sibling charges pair with the right content.
   */
  private async runLevel(nodeIds: readonly string[]): Promise<LevelResolution | undefined> {
    const produced = await mapWithConcurrency(nodeIds, LEVEL_STREAM_CONCURRENCY, (nodeId) =>
      this.produceNode(this.compiledNode(nodeId))
    );
    for (const item of produced) {
      const step = this.applyProduced(item);
      if (step.kind === 'end') return { kind: 'end' };
      const outcome = await this.stepOutcome(step);
      if (outcome !== undefined) return { kind: 'outcome', outcome };
    }
    return undefined;
  }

  /**
   * Runs one top-level node. Value nodes defer their state application (accrue,
   * charge, channel write) to `applyProduced` so a whole level applies in order;
   * control nodes self-apply here (their side effects touch only their own
   * channel and later-level targets, never a same-level sibling).
   */
  private async produceNode(compiledNode: CompiledNode): Promise<Produced> {
    const node = compiledNode.node;
    if (isValueNode(node)) {
      const produced = await this.produceValue(compiledNode, node, this.rootScope);
      if (produced.kind === 'step') return { kind: 'step', step: produced.step };
      return { kind: 'value', compiledNode, node, result: produced.result };
    }
    return { kind: 'step', step: await this.executeNode(compiledNode, this.rootScope) };
  }

  private applyProduced(item: Produced): NodeStep {
    if (item.kind === 'step') return item.step;
    return this.applyValueResult(
      { compiledNode: item.compiledNode, node: item.node, scope: this.rootScope },
      item.result
    );
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
      .with({ type: 'smartModel' }, (valueNode) =>
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
    const produced = await this.produceValue(compiledNode, node, scope);
    if (produced.kind === 'step') return produced.step;
    return this.applyValueResult({ compiledNode, node, scope, chargeKey }, produced.result);
  }

  /** Resolves inputs and invokes the node's execution — the streaming happens here. */
  private async produceValue(
    compiledNode: CompiledNode,
    node: ValueNode,
    scope: Scope
  ): Promise<ProducedValue> {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'step', step: { kind: 'ok' } };
    const execution = this.deps.execution.resolveExecution(node);
    if (execution === undefined) {
      return { kind: 'step', step: this.unregisteredDefect() };
    }
    // Streaming is withheld from any node whose output is CONSUMED rather than
    // displayed (`docs/BILLING.md` §Reasoning Effort 6): a classifier is an
    // ordinary model call, and without this it would emit its routing internals
    // into the user's conversation. The disposition is read off the compiled
    // consumed set — the same value that decides which outputs settlement
    // persists — so it cannot contradict what the definition already fixes, the
    // way a declared per-node flag could.
    // The turn's classifier is derived from the graph the same way — the
    // decision reducer reading this call's answer IS what makes it the
    // classifier — and what follows from it is a withholding, not a flag: the
    // client's conversation context never reaches a routing call, so the
    // request cannot bill input the classifier reserve did not price.
    const context = this.nodeContext(
      node.id,
      execution.streaming && !this.compiled.consumedProducers.has(node.id),
      isTurnClassifierNode(node, this.request.definition.nodes)
    );
    try {
      return { kind: 'result', result: await execution.run(node, resolved, context) };
    } catch (error) {
      // A media download that would exceed the run's remaining ValueStore budget
      // aborts before the artifact materializes; the video adapter surfaces it as
      // an error named 'DownloadByteCapExceeded'. It is an expected validation
      // refusal — the same byte-budget-exceeded outcome the `store()` backstop
      // produces — not a defect, so it never reaches Sentry.
      if (isDownloadByteCapExceeded(error)) {
        return {
          kind: 'step',
          step: { kind: 'failed', failure: { kind: 'byte-budget-exceeded' } },
        };
      }
      // A ciphertext storage put failed for an availability reason: the chat
      // file-part mapper rethrows the recorded StorageUnavailableError on its
      // next invocation. Infra unavailability is not a defect — fail the run
      // UNAVAILABLE without capturing it to Sentry.
      if (error instanceof StorageUnavailableError) {
        return {
          kind: 'step',
          step: { kind: 'failed', failure: { kind: 'storage-unavailable' } },
        };
      }
      this.deps.telemetry.captureError(
        error instanceof Error ? error : new Error(String(error)),
        FINGERPRINT_CODES.workflowNodeDefect
      );
      return { kind: 'step', step: FAILED_DEFECT };
    }
  }

  /** Accrues, commits, and charges a produced value — the only ordered mutation. */
  private applyValueResult(
    target: ValueTarget,
    result: Result<NodeRunSuccess, NodeRunError>
  ): NodeStep {
    const { compiledNode, node, scope, chargeKey } = target;
    if (result.isErr()) {
      this.accruedNanoUsd += result.error.costNanoUsd ?? 0n;
      if (this.stopReason !== undefined) return { kind: 'stopped' };
      // A mid-node accrual (ctx.accrue) that crossed the limit aborted the
      // node's signal; its failure is the circuit's, not the node's.
      if (this.circuitTripped) {
        return { kind: 'failed', failure: { kind: 'cost-circuit-tripped' } };
      }
      return this.applyNodeFailure(node, scope, result.error.reason);
    }
    // ACCRUAL STAYS ABOVE THE COMMIT. Only BILLING is gated on the value
    // committing (below); the spend accrues whatever becomes of the value,
    // because the money left the platform either way. Moving this line into the
    // committed branch to match the charge looks like tidying and is not: a model
    // returning malformed output would then cost real provider money on every
    // attempt while contributing nothing to the circuit that exists to stop that,
    // so exposure would stop being bounded by `hold × K`. Absorbed-but-counted is
    // the intended asymmetry, and it is pinned in `interpreter.test.ts`
    // ("counts an uncommitted generation's spend toward the circuit").
    this.accruedNanoUsd += result.value.costNanoUsd;
    // BILLABLE ⟺ THE VALUE WAS COMMITTED, and this ordering is the whole
    // guarantee: charge after the commit, only on success. A generation whose
    // provider call succeeded but whose value fails `commitValue`'s runtime
    // `zodFor(out)` gate is not in the successful subset settlement bills
    // (`docs/BILLING.md` §Multi-Model 4) — a rejected output is our schema or a
    // malformed model return, so the spend is absorbed as platform loss like a
    // cost-circuit trip. Charging first made that unbillable spend billable the
    // moment a run-level anchor existed to attach it to, and a `skip`-declared
    // sibling reaches it without failing the run.
    const commit = this.commitValue(compiledNode, node, scope, result.value.value);
    if (commit.committed) this.collectCharge(chargeKey ?? node.id, result.value);
    return commit.step;
  }

  /**
   * Lifts a modelCall's per-generation facts into a keyed settlement charge.
   * Only modelCall executions carry `billing`; transform/control successes
   * produce no billable generation, so this is a no-op for them.
   *
   * Its caller invokes it only for a generation whose value committed, which is
   * the invariant settlement's run-level anchor rests on: a charge reaching
   * settlement always names a generation the run accepted, so anchoring one that
   * persisted no content OF ITS OWN — a consumed value, such as the turn's
   * classifier — onto the run's content bills real, accepted work.
   */
  private collectCharge(key: string, success: NodeRunSuccess): void {
    const billing = success.billing;
    if (billing !== undefined) {
      // Only the primary answer charge carries the smartModel chip signal; the
      // display chip reads "the routing pipeline ran", never "the classifier
      // billed", so an unrouted fallback answer still badges.
      this.pushCharge(key, billing, {
        billableCostNanoUsd: success.costNanoUsd,
        isEstimated: success.isEstimated ?? false,
        smartModelRan: success.smartModelRan === true,
      });
    }
    // An auxiliary generation charges under the node key plus its suffix, so its
    // DB idempotency key never collides with the node's own. No node execution
    // produces one today — the turn's classifier is its own node with its own
    // top-level key — so this loop is the mechanism without a producer.
    for (const auxiliary of success.auxiliaryCharges ?? []) {
      this.pushCharge(`${key}#${auxiliary.keySuffix}`, auxiliary.billing, {
        billableCostNanoUsd: auxiliary.billableCostNanoUsd,
        isEstimated: auxiliary.isEstimated,
      });
    }
  }

  private pushCharge(
    key: string,
    billing: NodeBillingMetadata,
    facts: {
      readonly billableCostNanoUsd: bigint;
      readonly isEstimated: boolean;
      readonly smartModelRan?: boolean;
    }
  ): void {
    this.charges.push({
      key,
      modelId: billing.modelId,
      providerName: billing.providerName,
      modality: billing.modality,
      ...(billing.generationId === undefined ? {} : { generationId: billing.generationId }),
      billableCostNanoUsd: facts.billableCostNanoUsd,
      isEstimated: facts.isEstimated,
      ...(billing.tokens === undefined ? {} : { tokens: billing.tokens }),
      ...(billing.media === undefined ? {} : { media: billing.media }),
      ...(billing.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: billing.reasoningEffort }),
      ...(facts.smartModelRan === true ? { smartModelRan: true } : {}),
    });
  }

  /**
   * Output validation is THE runtime type check: zodFor over the declared tag.
   *
   * `committed` says whether the value reached its channel, which a `NodeStep`
   * alone cannot: a `skip`-declared node whose output failed validation also
   * yields `ok`, and telling those apart is what keeps an unaccepted
   * generation's spend unbilled.
   */
  private commitValue(
    compiledNode: CompiledNode,
    node: Node,
    scope: Scope,
    value: unknown
  ): CommitOutcome {
    if (!zodFor(compiledNode.out, this.schemaRegistry).safeParse(value).success) {
      return { committed: false, step: this.applyNodeFailure(node, scope) };
    }
    const stored = this.store.store(value);
    if (stored.isErr()) {
      return {
        committed: false,
        step: { kind: 'failed', failure: { kind: 'byte-budget-exceeded' } },
      };
    }
    scope.channels.set(node.id, stored.value);
    return { committed: true, step: { kind: 'ok' } };
  }

  private applyNodeFailure(node: Node, scope: Scope, code?: ErrorCode): NodeStep {
    if (node.onError === 'skip') {
      scope.channels.set(node.id, undefined);
      return { kind: 'ok' };
    }
    return {
      kind: 'failed',
      failure: { kind: 'node-failed', nodeId: node.id, ...(code === undefined ? {} : { code }) },
    };
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
    // A fanIn produces no billable generation, so only its step matters here.
    return this.commitValue(compiledNode, node, scope, reducer(resolved)).step;
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
    // A fanOut's own value is the joined branch list, not a billable generation
    // (each branch charged inside its own body), so only its step matters here.
    return this.commitValue(
      compiledNode,
      node,
      scope,
      branches.map((outcome) => outcome.value)
    ).step;
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

  private nodeContext(nodeId: string, streaming: boolean, routingOnly = false): NodeRunContext {
    const mapper = this.request.mapFilePartFor?.(nodeId);
    const base = {
      values: this.store,
      clock: this.deps.clock,
      rng: this.deps.rng,
      signal: this.controller.signal,
      // Mid-node accrual for multi-generation executions: crossing the limit
      // trips the circuit and aborts synchronously (mirrors the fan-branch
      // post-completion check), so the node refuses its next provider call.
      accrue: (costNanoUsd: bigint): void => {
        this.accruedNanoUsd += costNanoUsd;
        if (!this.circuitTripped && this.accruedNanoUsd > this.limitNanoUsd) {
          this.circuitTripped = true;
          this.controller.abort();
        }
      },
      ...clientContextFor(this.request, routingOnly),
      ...(mapper === undefined ? {} : { mapFilePart: mapper }),
    };
    if (!streaming) return base;
    const streamId = `${nodeId}#${String(this.streamSequence)}`;
    this.streamSequence += 1;
    let cursor = 1;
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
    const consumed = this.compiled.consumedProducers;
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
      // An all-branches-failed turn — no branch produced content the turn could
      // persist — is a real "providers unavailable" outcome, not an engine
      // defect: the chat settlement hook signals it by throwing the typed
      // AllBranchesFailedError sentinel (imported intra-slice from ./failures —
      // never from the chat slice, which depends on the engine). It reroutes to
      // UNAVAILABLE and is never captured to Sentry; every other throw is a
      // genuine defect.
      if (error instanceof AllBranchesFailedError) {
        return { kind: 'all-branches-failed' };
      }
      // A ciphertext storage put failed for an availability reason while
      // persisting generated media: the media put barrier rejects settlement
      // with the typed StorageUnavailableError. Infra unavailability is not a
      // defect — reroute to UNAVAILABLE and never capture it to Sentry.
      if (error instanceof StorageUnavailableError) {
        return { kind: 'storage-unavailable' };
      }
      // An ordinary settlement concurrency conflict — the fork tip moved, the
      // fork vanished mid-run, or the epoch wrapped (rotation / membership
      // change). The chat settlement hook signals it with the typed
      // SettlementConflictError, carrying a DomainError whose `wireCode`
      // override names the chat-specific client code (FORK_TIP_CONFLICT /
      // CONFLICT). Expected under group-chat concurrency, not a defect: project
      // the code through `domainWireCode` and never capture it to Sentry.
      if (error instanceof SettlementConflictError) {
        return { kind: 'settlement-conflict', code: domainWireCode(error.domainError) };
      }
      this.deps.telemetry.captureError(
        error instanceof Error ? error : new Error(String(error)),
        FINGERPRINT_CODES.workflowSettlementDefect
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
    if (failure.kind === 'cost-circuit-tripped') this.captureCostCircuitTrip();
    return { outcome: 'failed', code };
  }

  /**
   * The cost circuit tripped: observed provider spend crossed the admission
   * hold's `× K` ceiling, so the run is killed and — unlike a deadline stop,
   * which settles its billable partial — settlement writes nothing. The
   * already-incurred provider spend (`accruedNanoUsd`) is absorbed as platform
   * loss; that no-bill posture is deliberate. But a trip means the admission
   * estimate was exceeded K-fold (a systematically-low estimate or abuse), so
   * exactly one Sentry event fires — routine domain failures never reach here —
   * carrying only the DO-minted runId and the absorbed nano-USD (no content, no
   * PII) so a human can see which run overshot and by how much.
   */
  private captureCostCircuitTrip(): void {
    const error = new Error(
      `cost circuit tripped: run ${String(this.request.runId)} absorbed ${this.accruedNanoUsd.toString()} nano-USD unbilled`
    );
    error.name = 'CostCircuitTripped';
    // The allowlist scrub drops the message; these two non-PII properties are
    // the only path the runId and absorbed loss survive to the Sentry wire — the
    // scrub lifts them into tags. `runId` is the DO-minted uuidv7 run id
    // (`idempotency_keys.id` / `usage_records.runId`), NOT the client-supplied
    // `runKey` — a client value in an allowlisted tag would bypass the scrub.
    // The amount is the nano-USD bigint as a string (money is never
    // Number()-coerced; a Sentry tag is a string regardless). See sentry-scrub.ts
    // (`costCircuitTags`).
    Object.assign(error, {
      runId: this.request.runId,
      absorbedNanoUsd: this.accruedNanoUsd.toString(),
    });
    this.deps.telemetry.captureError(error, FINGERPRINT_CODES.workflowCostCircuitTripped);
  }

  private compiledNode(nodeId: NodeId | string): CompiledNode {
    const found = this.compiled.nodes.get(nodeId as string);
    /* v8 ignore next 5 -- unreachable after a clean compile: every ordered/referenced id registers a compiled node */
    if (found === undefined) {
      // Unreachable after a clean compile: every ordered/referenced id
      // registers a compiled node.
      throw new Error('workflow interpreter referenced a node the compile did not register');
    }
    return found;
  }
}

/**
 * The run-scoped client context a node's execution is handed: the conversation
 * history and the custom instructions, plus the routing disposition itself.
 *
 * A ROUTING-ONLY node — the turn's classifier, derived from the graph — is
 * handed neither, so a routing call cannot bill input the classifier reserve
 * did not price. The disposition also travels as a value, because its third
 * consequence is one no withholding can express: the provider request must
 * suppress the base system preamble the adapter would otherwise add.
 */
function clientContextFor(
  request: FlowStartRequest,
  routingOnly: boolean
): Partial<Pick<NodeRunContext, 'history' | 'customInstructions' | 'routingOnly'>> {
  if (routingOnly) return { routingOnly: true };
  return {
    ...(request.history === undefined ? {} : { history: request.history }),
    ...(request.customInstructions === undefined
      ? {}
      : { customInstructions: request.customInstructions }),
  };
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
      FINGERPRINT_CODES.workflowRunDefect
    );
    return { outcome: 'failed', code: ERROR_CODES.INTERNAL };
  }
}

export function createWorkflowExecutor(deps: WorkflowExecutorDeps): FlowExecutor {
  return {
    start: (request: FlowStartRequest): FlowRunHandle => {
      const execution = new RunExecution(deps, request);
      const done = (async (): Promise<FlowRunOutcome> => {
        const outcome = await runContained(execution, deps);
        // Backstop, not the primary path: `admitted` normally resolved at the
        // decision; a defect that escaped earlier settles it here (a second
        // resolve is a no-op) so the handle's promise can never hang.
        execution.settleAdmittedFromOutcome(outcome);
        return outcome;
      })();
      return {
        runId: request.runKey,
        done,
        admitted: execution.admitted,
        stop: (reason: FlowStopReason): void => {
          execution.stop(reason);
        },
      };
    },
  };
}
