import type { InferenceEvent, Modality } from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type { ValueNode } from '../compile/context.js';
import type { ValueStore } from './value-store.js';

/**
 * The injectable node-execution seam the interpreter runs against. Concrete
 * node implementations register through this shape (the runtime counterpart
 * of the compile module's `NodeRegistryContext`); tests inject fakes.
 * `WorkflowCtx` is closed: a node may touch exactly what `NodeRunContext`
 * enumerates — raw `Date.now`/`Math.random` are banned in engine and node
 * code in favor of `ctx.clock`/`ctx.rng`.
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
}

export interface NodeRunSuccess {
  readonly value: unknown;
  /**
   * The base (pre-markup) cost this generation is charged: the authoritative
   * inline provider cost for text/video, or the catalog estimate for image and
   * the pathological missing-cost path. Also accrued toward the `hold × K` cost
   * circuit. Settlement applies the markup once.
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
}

export interface NodeRunError {
  /**
   * Priced spend observed before the failure, accrued toward the circuit.
   * Absent when the failure leaves the spend un-priceable (e.g. pricing itself
   * failed, so no catalog rate resolved) or when no spend was observed.
   */
  readonly costNanoUsd?: bigint;
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
