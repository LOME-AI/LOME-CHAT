import type { ContentValue } from './content-value.js';
import type { ErrorCode } from './error-codes.js';
import type { ChatHistoryMessage, InferenceEvent } from './inference.js';
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

/**
 * The wallet-hold identity a paid admission grant placed — everything the
 * terminal sink needs to release the hold early instead of waiting out its
 * TTL. Trial grants place no hold and carry none.
 */
export interface FlowHoldIdentity {
  readonly walletId: string;
  readonly holdId: string;
  readonly scopeIds: readonly string[];
}

/** Refusals carry the typed code (INSUFFICIENT_ADMISSION, ADMISSION_UNAVAILABLE, …). */
export type AdmissionDecision =
  | { readonly admitted: true; readonly holdRef: string; readonly hold?: FlowHoldIdentity }
  | { readonly admitted: false; readonly code: ErrorCode };

/**
 * What `FlowRunHandle.admitted` resolves to: the admission verdict, surfaced
 * so the DO can answer the start request synchronously (a refusal is an HTTP
 * error, never only a run-failed WS event) and release the granted hold at
 * the run's terminal sink. A run that fails before its admission hook ever
 * runs (invalid inputs, an executor defect) resolves `admitted: false` with
 * that failure's code — the promise always settles.
 */
export type FlowAdmissionOutcome =
  | { readonly admitted: true; readonly hold?: FlowHoldIdentity }
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
 * How a paid turn grafts onto the message tree when it is a REGENERATE rather
 * than a fresh send. `targetMessageId` is the anchor USER message the turn
 * re-runs. `action` distinguishes keeping that user message (`retry` — swap the
 * reply) from replacing it (`edit` — the initiator's `userMessage` is inserted
 * in its place). `replaceAssistantId` (retry only) discriminates retry-all
 * (unset: every reply below the anchor is deleted) from regenerate-one (set:
 * only that reply is deleted, surviving siblings kept). Absent for a fresh send.
 * The delete + re-parent runs inside the one settlement transaction.
 */
export interface RegenerateAction {
  readonly action: 'retry' | 'edit';
  readonly targetMessageId: string;
  readonly replaceAssistantId?: string;
  /**
   * The fork tip the pre-run guard observed when it validated the deletable
   * tail. Carried so the settlement can assert the tip the fork-row lock
   * resolves still equals it before deleting anything — the fork-tip TOCTOU
   * fence. Null for a fork with no tip yet; absent for a linear regenerate or a
   * retry-one (which deletes a fixed, guard-validated id, not a tip-derived
   * tail).
   */
  readonly observedForkTipId?: string | null;
}

/**
 * A paid run's identity the policy hooks close over: who pays, whose content
 * this is (the AAD sender), which conversation and epoch it wraps to. Known
 * before the claim — the hook request shapes stay content-only because the
 * identity rides this context instead.
 */
export interface PaidRunIdentity {
  readonly mode: 'paid';
  readonly userId: string;
  readonly senderId: string;
  readonly conversationId: string;
  readonly walletId: string;
  readonly epochNumber: number;
  /**
   * The initiator's message for this turn, supplied at send. Its content is
   * persisted (epoch-wrapped) alongside the assistant's reply inside the one
   * settlement transaction; the client-supplied id makes that persistence
   * idempotent across a re-executed run.
   */
  readonly userMessage: {
    readonly id: string;
    readonly content: string;
  };
  /**
   * The branch this turn extends, when the client sends onto a fork rather than
   * linear history. The turn's messages chain onto the fork's current tip and
   * that tip advances to the new assistant reply inside the settlement
   * transaction. Absent (or null) for a linear send — the tip is then the
   * conversation's highest-sequence message.
   */
  readonly forkId?: string | null;
  /**
   * Present when this turn re-runs an existing turn (regenerate/edit) rather
   * than appending a fresh one. The settlement deletes the superseded reply(s)
   * and re-parents the new reply inside its one transaction. Absent for a fresh
   * send — the turn simply chains onto the tip.
   */
  readonly regenerate?: RegenerateAction | null;
}

/**
 * A trial run's identity: no wallet, no epoch, no conversation. The trial
 * session id is the only principal — it scopes the idempotency-key claim (it
 * is a uuid, fitting `idempotency_keys.userId`), and the trial policy hooks
 * charge nothing and persist nothing.
 */
export interface TrialRunIdentity {
  readonly mode: 'trial';
  readonly sessionId: string;
}

/**
 * The run identity, discriminated by policy mode. A paid run carries the
 * paying wallet and the send-time epoch; a trial run carries only its session.
 * The binder branches on `mode` to resolve the definition's declared hooks.
 */
export type RunIdentity = PaidRunIdentity | TrialRunIdentity;

/**
 * The run identity plus the captured fence, assembled after the claim and
 * threaded into both hooks by the binder — settlement closes over the fence
 * to gate its terminal flip. `runId` (DO-minted) groups the run's charges
 * (`usage_records.runId` — there is no run table); the settlement hook closes
 * over it to set `ChargeInput.runId` and derive the charge idempotency key.
 * The intersection distributes over the identity union, so narrowing on `mode`
 * recovers each variant's fields.
 */
export type RunContext = RunIdentity & {
  readonly runId: string;
  readonly fence: RunFence;
};

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
  /**
   * Run-scoped, client-supplied prior conversation turns (E2E crypto means the
   * server cannot reconstruct them). Not a graph value and never baked into
   * the definition — the interpreter hands it to node executions through
   * `NodeRunContext`. Absent means no prior context.
   */
  readonly history?: readonly ChatHistoryMessage[];
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
  /** Settles at the admission decision (see `FlowAdmissionOutcome`); never rejects. */
  readonly admitted: Promise<FlowAdmissionOutcome>;
  stop(reason: FlowStopReason): void;
}

export interface FlowExecutor {
  start(request: FlowStartRequest): FlowRunHandle;
}
