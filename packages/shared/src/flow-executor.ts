import type { ContentValue } from './content-value.js';
import type { ErrorCode } from './error-codes.js';
import type { InferenceEvent } from './inference.js';
import type { Modality } from './modality.js';
import type { NanoUSD } from './nano-usd.js';
import type { WorkflowDefinition } from './workflow.js';

/**
 * The DO↔engine composition seam: the ConversationRoom DO in
 * `packages/realtime` is parameterized over this interface; `apps/api` binds
 * the in-process interpreter to it. Types only — no implementation
 * lives in shared.
 */

/** Named run inputs, all supplied at send (no client involvement after send). */
export type FlowInputs = Readonly<Record<string, ContentValue>>;

/**
 * The event-emission contract: every streamed event rides a `streamId` with
 * a per-stream monotonic `cursor` — the DO's `Last-Event-ID` replay unit for
 * multi-stream runs.
 */
export interface FlowStreamEvent {
  readonly streamId: string;
  readonly cursor: number;
  readonly event: InferenceEvent;
}

export interface AdmissionRequest {
  readonly definition: WorkflowDefinition;
  /** Priced at the declared ceiling: max width × max steps × max iterations. */
  readonly estimate: NanoUSD;
}

/** Refusals carry the typed code (INSUFFICIENT_ADMISSION, ADMISSION_UNAVAILABLE, …). */
export type AdmissionDecision =
  | { readonly admitted: true; readonly holdRef: string }
  | { readonly admitted: false; readonly code: ErrorCode };

export type AdmissionHook = (request: AdmissionRequest) => Promise<AdmissionDecision>;

/**
 * The per-generation billing facts one `modelCall` node produces, collected by
 * the interpreter and handed to the settlement hook. These are ONLY the
 * generation's own facts: who pays and what epoch it wraps to ride RunContext,
 * the persisted `contentItemId` is minted at persist time (the `key` pairs this
 * charge to that content), and the idempotency key + timestamp are derived at
 * settlement. `baseCostNanoUsd` is pre-markup — the 15% markup lands once,
 * downstream in `chargeWithinTx`.
 */
export interface SettlementCharge {
  /**
   * The stable per-generation identifier the persist step joins its minted
   * content item on: the producing node id, suffixed with the branch element
   * index when the node runs inside a `fanOut`, so N multi-model branches map
   * to N content items.
   */
  readonly key: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly modality: Modality;
  readonly generationId?: string;
  readonly baseCostNanoUsd: bigint;
  readonly isEstimated: boolean;
}

export interface SettlementRequest {
  /** The idempotency-key referee for the run (there is no run table). */
  readonly runKey: string;
  /** The run's final outputs, wrapped and persisted inside the settlement transaction. */
  readonly outputs: Readonly<Record<string, ContentValue>>;
  /**
   * One record per billable `modelCall` generation, keyed for content pairing.
   * Rides both the success and stopped-partial settle paths — a billable
   * partial charges what it produced.
   */
  readonly charges: readonly SettlementCharge[];
}

export type SettlementHook = (request: SettlementRequest) => Promise<void>;

/**
 * The two typed policy hooks a definition declares by name, resolved
 * to bound implementations by the binder. The engine owns sequencing; no run
 * starts or settles except through these.
 */
export interface FlowHookBindings {
  readonly admission: AdmissionHook;
  readonly settlement: SettlementHook;
}

/**
 * The completion-fence identity captured when the DO claims the run referee:
 * the claimed idempotency-key row id, the executor that claimed it, and the
 * claim count. Settlement's fenced flip presents it so a zombie claimant can
 * never finish. A structural mirror of apps/api's key-row fence — realtime
 * carries it with no dependency on apps/api.
 */
export interface RunFence {
  readonly id: string;
  readonly executorId: string;
  readonly claims: number;
}

/**
 * The run identity the policy hooks close over: who pays, whose content this
 * is (the AAD sender), which conversation and epoch it wraps to. Known before
 * the claim — the hook request shapes stay content-only because the identity
 * rides this context instead.
 */
export interface RunIdentity {
  readonly userId: string;
  readonly senderId: string;
  readonly conversationId: string;
  readonly walletId: string;
  readonly epochNumber: number;
}

/**
 * The run identity plus the captured fence, assembled after the claim and
 * threaded into both hooks by the binder — settlement closes over the fence
 * to gate its terminal flip.
 */
export interface RunContext extends RunIdentity {
  /**
   * The DO-minted run id grouping this run's charges (`usage_records.runId` —
   * there is no run table). Run-scoped alongside the fence; the settlement
   * hook closes over it to set `ChargeInput.runId` and derive the charge
   * idempotency key.
   */
  readonly runId: string;
  readonly fence: RunFence;
}

/**
 * What the DO hands the run referee to settle a run's disposition: the client
 * idempotency key, the freshly minted run id, and the run identity (the fence
 * is the referee's output, not its input).
 */
export interface RunClaimRequest {
  readonly runKey: string;
  readonly runId: string;
  /**
   * Canonical-JSON hash of the run request the client sent. The referee 409s
   * a reused key presented with a different body — the same body-hash guard
   * the idempotency-key row enforces for request-kind mutations.
   */
  readonly bodyHash: string;
  readonly identity: RunIdentity;
}

/**
 * The run referee's verdict, structurally mirroring the idempotency key-row
 * claim (apps/api owns the real state machine). `executor` carries the
 * captured fence a fresh run starts under; `replay` carries the already-settled
 * response returned without executing; `attach` joins a run still live in this
 * single-instanced DO.
 */
export type RunClaim =
  | { readonly outcome: 'executor'; readonly fence: RunFence }
  | { readonly outcome: 'replay'; readonly response: unknown }
  | { readonly outcome: 'attach' }
  /** A reused key presented with a different canonical body — surfaces as 409. */
  | { readonly outcome: 'conflict'; readonly code: ErrorCode };

/**
 * The injected run-referee capability. The DO claims the durable key-row
 * before starting a run; the concrete implementation lives in apps/api and is
 * supplied through the DO's bindings (packages never import apps).
 */
export type ClaimRun = (request: RunClaimRequest) => Promise<RunClaim>;

export interface FlowStartRequest {
  readonly definition: WorkflowDefinition;
  readonly inputs: FlowInputs;
  readonly hooks: FlowHookBindings;
  /** The claimed idempotency-key row id — claim happens in the DO before start. */
  readonly runKey: string;
  readonly emit: (event: FlowStreamEvent) => void;
}

/** Explicit stop and the deadline alarm both settle the billable partial. */
export type FlowStopReason = 'user-stop' | 'deadline';

export type FlowRunOutcome =
  | { readonly outcome: 'succeeded' }
  | { readonly outcome: 'stopped' }
  | { readonly outcome: 'failed'; readonly code: ErrorCode };

export interface FlowRunHandle {
  readonly runId: string;
  readonly done: Promise<FlowRunOutcome>;
  stop(reason: FlowStopReason): void;
}

export interface FlowExecutor {
  start(request: FlowStartRequest): FlowRunHandle;
}
