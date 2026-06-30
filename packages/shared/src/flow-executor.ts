import type { ContentValue } from './content-value.js';
import type { ErrorCode } from './error-codes.js';
import type { InferenceEvent } from './inference.js';
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

export interface SettlementRequest {
  /** The idempotency-key referee for the run (there is no run table). */
  readonly runKey: string;
  /** The run's final outputs, wrapped and persisted inside the settlement transaction. */
  readonly outputs: Readonly<Record<string, ContentValue>>;
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
