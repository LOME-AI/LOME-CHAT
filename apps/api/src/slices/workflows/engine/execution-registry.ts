import type {
  ChatHistoryMessage,
  CompletionTokens,
  ErrorCode,
  FilePartMapper,
  InferenceEvent,
  MediaGenerationFacts,
  Modality,
  ResolvedReasoningEffort,
} from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type { ValueNode } from '../compile/context.js';
import type { ValueStore } from './value-store.js';

/**
 * The injectable node-execution seam the interpreter runs against. Concrete
 * node implementations register through this shape (the runtime counterpart
 * of the compile module's `NodeRegistryContext`); tests inject fakes.
 * `NodeRunContext` is closed: a node may touch exactly what `NodeRunContext`
 * enumerates — `values`, `clock`, `rng`, `signal`, `emit` (streaming only),
 * `history` (run-scoped client context), `mapFilePart` (per-node opaque
 * media-forwarding closure), and `accrue` (mid-node cost accrual
 * toward the run's circuit) — raw `Date.now`/`Math.random` are banned in
 * engine and node code in favor of `ctx.clock`/`ctx.rng`.
 */

export interface EngineClock {
  now(): number;
}

export interface EngineRng {
  random(): number;
}

export interface NodeRunContext {
  readonly values: ValueStore;
  readonly clock: EngineClock;
  readonly rng: EngineRng;
  /** Aborted on stop, deadline, or a cost-circuit kill of sibling branches. */
  readonly signal: AbortSignal;
  /**
   * Present only on streaming executions: the engine allocates the
   * per-branch streamId and monotonic cursor; the node emits bare events.
   */
  readonly emit?: (event: InferenceEvent) => void;
  /**
   * Run-scoped, client-supplied prior conversation turns. Executions are
   * DO-scoped singletons resolved through the registry, so this ctx field is
   * the only per-run channel to them — history is never a graph value and
   * never baked into a definition. Absent means the node was handed none:
   * either the run carried none, or the engine withheld it because this node's
   * call is routing internals rather than an answer (see {@link routingOnly}).
   */
  readonly history?: readonly ChatHistoryMessage[];
  /**
   * Run-scoped, client-supplied plaintext custom instructions, on the same
   * per-run channel as `history` — never a graph value, never baked into a
   * definition (the definition must stay free of user content). The language
   * adapter folds it into the base system prompt. Absent on the same two
   * grounds as `history`: the run carried none, or the engine withheld it from
   * a routing call.
   */
  readonly customInstructions?: string;
  /**
   * Injected opaque per-run closure, resolved per node id from the start
   * request's `mapFilePartFor(nodeKey)`. The engine and nodes never construct
   * or introspect it — they only carry it and forward it to the provider
   * call, keeping storage and crypto outside the engine. Absent when the run
   * carries no resolver or the resolver yields nothing for this node.
   * Resolution uses the body node's unsuffixed id, so all `fanOut` branches
   * of one body share a single mapper even though their charges are
   * branch-suffixed; per-branch media under `fanOut` would need branch-keyed
   * resolution first.
   */
  readonly mapFilePart?: FilePartMapper;
  /**
   * True when this node's call is ROUTING INTERNALS rather than an answer —
   * the turn's classifier. DERIVED by the interpreter from the graph (the
   * decision reducer reads this call's answer), never declared on the node, so
   * it cannot contradict what the definition already fixes. It travels because
   * its consequence is something a withheld ctx member cannot express: the
   * provider request suppresses the base system preamble, which the adapter
   * would otherwise add to a call whose reserve prices only the truncated
   * context and the classifier template.
   */
  readonly routingOnly?: true;
  /**
   * Mid-node cost accrual toward the run's `hold × K` circuit, for an execution
   * that runs MORE THAN ONE generation and must be stoppable between them.
   * Crossing the limit trips the circuit and aborts `signal` synchronously, so
   * the execution can refuse its next provider call. Amounts accrued here must
   * NOT ride the final `NodeRunSuccess.costNanoUsd` (which the interpreter
   * accrues at node end) — they are charged through `auxiliaryCharges` instead.
   *
   * No shipped execution is multi-generation today: every node runs one
   * generation, so nothing calls this. It is the mechanism without a caller, kept
   * because the circuit's between-generations guarantee is only expressible here.
   * The interpreter always provides it; unit harnesses may omit it.
   */
  readonly accrue?: (costNanoUsd: bigint) => void;
}

/**
 * The per-generation billing facts a `modelCall` execution decides: the
 * serving model and provider, the generation's modality, and the terminal
 * gateway generation id. The interpreter lifts these into a `SettlementCharge`.
 * Absent on transform/control executions, which produce no billable generation.
 */
export interface NodeBillingMetadata {
  readonly modelId: string;
  readonly providerName: string;
  readonly modality: Modality;
  readonly generationId?: string;
  /** Language token dimension (feeds `llm_completions`); absent on media generations. */
  readonly tokens?: CompletionTokens;
  /** Media dimension (feeds `media_generations`); absent on language generations. */
  readonly media?: MediaGenerationFacts;
  /**
   * The reasoning level the generation ran at (feeds `llm_completions` beside
   * the reasoning tokens it spent). Absent when the call carried no reasoning
   * wire at all — a different fact from `off`, which records reasoning
   * deliberately disabled.
   */
  readonly reasoningEffort?: ResolvedReasoningEffort;
}

/**
 * One additional billable generation a multi-generation execution produced
 * under its node. The interpreter lifts each into its own `SettlementCharge`,
 * keyed `<node key>#<keySuffix>` so its charge idempotency key never collides
 * with the node's own. Its cost is accrued by the execution through `ctx.accrue`
 * when it happens, never re-accrued at node end.
 *
 * Nothing produces one today — the turn's classifier is its own node with its own
 * top-level charge key, not an auxiliary of the Smart Model slot.
 */
export interface NodeGenerationCharge {
  /** Distinguishes this generation's charge key from the node's own. */
  readonly keySuffix: string;
  readonly billing: NodeBillingMetadata;
  readonly billableCostNanoUsd: bigint;
  readonly isEstimated: boolean;
}

export interface NodeRunSuccess {
  readonly value: unknown;
  /**
   * The BILLABLE cost this generation is charged: the port-converted inline
   * provider cost for text/video, or the billable catalog estimate for image
   * and the pathological missing-cost path. Also accrued toward the `hold × K`
   * cost circuit. Settlement charges it as-is — no further fee application.
   */
  readonly costNanoUsd: bigint;
  /**
   * True when `costNanoUsd` is the catalog estimate rather than the provider's
   * inline cost (image by design; text/video only on the missing-cost path).
   * Absent on non-modelCall executions, which carry no billable generation.
   */
  readonly isEstimated?: boolean;
  /**
   * Present only on `modelCall` executions: the generation's billing facts the
   * settlement charge is built from. Absent on transform/control executions.
   */
  readonly billing?: NodeBillingMetadata;
  /**
   * Additional generations billed under this node beyond the primary one
   * (`billing` + `costNanoUsd`). Present only on multi-generation executions.
   */
  readonly auxiliaryCharges?: readonly NodeGenerationCharge[];
  /**
   * The smartModel routing pipeline ran for this generation, independent of what
   * any classifier did. The slot sets it from the turn's own declared shape — a
   * model-routing slot badges, a pinned-model slot does not — so an answer that
   * fell back to its declared candidate because no decision reached the slot
   * badges just the same. Legacy's `stagesRun`-driven "Smart Model" chip needs
   * exactly that: the interpreter lifts this onto the primary settlement charge
   * so the display chip reads "ran", never "billed".
   */
  readonly smartModelRan?: boolean;
}

export interface NodeRunError {
  /**
   * Priced spend observed before the failure, accrued toward the circuit.
   * Absent when the failure leaves the spend un-priceable (e.g. pricing itself
   * failed, so no catalog rate resolved) or when no spend was observed.
   */
  readonly costNanoUsd?: bigint;
  /**
   * The specific client wire code for a provider failure with a targeted next
   * action (content policy, context length, network). Absent leaves the
   * engine's generic node-failure code (`UNAVAILABLE`). Carries a code, never
   * content.
   */
  readonly reason?: ErrorCode;
}

export interface NodeExecution {
  /** Streaming-terminal capability flag the engine dispatches on. */
  readonly streaming: boolean;
  run(
    node: ValueNode,
    input: readonly unknown[],
    ctx: NodeRunContext
  ): Promise<Result<NodeRunSuccess, NodeRunError>>;
}

/** Branch predicates return a case label; loop conditions return a boolean. */
export type RegisteredPredicate = (input: unknown) => unknown;

export type RegisteredReducer = (inputs: readonly unknown[]) => unknown;

/**
 * Runtime lookups for everything the definition names: executable value
 * nodes plus the named-constraint registry's predicate and reducer code.
 * A clean compile guarantees the names exist as declarations; a missing
 * runtime registration here is a wiring defect, not a domain failure.
 */
export interface EngineExecutionRegistry {
  resolveExecution(node: ValueNode): NodeExecution | undefined;
  resolvePredicate(name: string): RegisteredPredicate | undefined;
  resolveReducer(name: string): RegisteredReducer | undefined;
}
