import type { ContentValue } from './content-value.js';
import type { ErrorCode } from './error-codes.js';
import type { ChatHistoryMessage, FilePartMapper, InferenceEvent } from './inference.js';
import type { MockDirectives } from './mock-directives.js';
import type { Modality } from './affordability/modality.js';
import type { NanoUSD } from './affordability/nano-usd.js';
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
 * The token dimension of a language generation, recorded alongside the charge
 * (feeds the `llm_completions` analytics row). Reasoning and cached counts
 * default to 0 when the provider reported none.
 */
export interface CompletionTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
}

/**
 * The dimensional facts of a media generation, recorded alongside the charge
 * (feeds the `media_generations` analytics row). All optional — a generation
 * carries only the dimensions its call declared (image count / video duration
 * + resolution).
 */
export interface MediaGenerationFacts {
  readonly imageCount?: number;
  readonly durationMs?: number;
  readonly resolution?: string;
}

/**
 * The per-generation billing facts one `modelCall` node produces, collected by
 * the interpreter and handed to the settlement hook. These are ONLY the
 * generation's own facts: who pays and what epoch it wraps to ride RunContext,
 * and the idempotency key + timestamp are derived at settlement. For TEXT the
 * persisted `contentItemId` is minted at persist time (the `key` pairs this
 * charge to that content); for MEDIA it is pre-minted at run start (see
 * `MediaPersistPlan`) because the ciphertext must be stored to R2 during
 * streaming under its final key. `billableCostNanoUsd` is already billable —
 * the port conversion (or the billable catalog estimate) applied the fee;
 * `chargeWithinTx` charges it as-is.
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
  readonly billableCostNanoUsd: bigint;
  readonly isEstimated: boolean;
  /**
   * The additive storage fee (nano-USD, never marked up) for this generation,
   * attached at settlement once the persisted char/byte counts are known. Absent
   * until settlement enriches the charge; consumers treat absent as 0n.
   */
  readonly storageFeeNanoUsd?: bigint;
  /** Present on language generations — the token dimension for `llm_completions`. */
  readonly tokens?: CompletionTokens;
  /** Present on image/video generations — the dimension for `media_generations`. */
  readonly media?: MediaGenerationFacts;
  /**
   * The smartModel routing pipeline ran for this generation, independent of
   * whether the classifier billed. Drives the persisted "Smart Model" display
   * chip: it badges the answer whenever the pipeline ran, so a classifier that
   * failed and fell back (no classifier charge) still badges. Present only on a
   * smartModel node's primary answer charge; never on the classifier's own
   * auxiliary charge. Display-only — the debit path is untouched.
   */
  readonly smartModelRan?: boolean;
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
 * The turn's sender, discriminated by principal kind. Both variants carry
 * `memberId` — the `conversation_members.id` that a user member and a
 * link-guest member alike hold — the unifier membership, epoch, and spend
 * attribution key on. A member's send resolves to `user` (its `userId`); a
 * link-guest's send to `linkGuest`, carrying the `linkId` that persists to
 * `messages.senderId` (a guest has no userId). The paying/owner identity is
 * separate (`walletId` + the identity's `userId`) and unchanged.
 */
export type SenderPrincipal =
  | { readonly kind: 'user'; readonly userId: string; readonly memberId: string }
  | { readonly kind: 'linkGuest'; readonly linkId: string; readonly memberId: string };

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
  /**
   * The resolved sender as a discriminated principal — a member (`user`) or a
   * link-guest (`linkGuest`), each carrying the `conversation_members.id` in
   * `memberId`. Present only when the run-start body supplied it; absent for a
   * body carrying only the flat `userId`/`senderId`, so existing user runs are
   * unchanged. This is the seam that lets a guest send (no userId) be
   * represented; consumers migrate off the flat fields onto it separately.
   */
  readonly sender?: SenderPrincipal;
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
  /**
   * Dev/E2E deterministic-inference directives, threaded per-request from the
   * run-start body. Present ONLY when the chat route populated the body in
   * dev/E2E (production never sets it); provider selection additionally gates on
   * the DO's own env mode, so this is never load-bearing on the real path.
   */
  readonly mockDirectives?: MockDirectives;
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

/**
 * The persistence identity pre-minted at run start for one media generation.
 * Media cannot wait for settlement to name its content: the R2 storage key and
 * the encryption AAD bind `assistantMessageId` + `contentItemId` while the
 * ciphertext streams, before the settlement transaction runs. The content KEY
 * itself never rides this type — it stays closure-only in the run; only the
 * epoch-wrapped form (`WrappedSecret` bytes, the persist layer's `bytea`
 * expectation) travels here for settlement to persist.
 */
export interface MediaPersistPlan {
  readonly assistantMessageId: string;
  readonly contentItemId: string;
  readonly epochNumber: number;
  readonly wrappedContentKey: Uint8Array;
}

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
  /**
   * Run-scoped, client-supplied plaintext custom instructions (stored E2E-
   * encrypted, so — like history — the client decrypts and resends them each
   * turn). Not a graph value and never baked into the definition; the
   * interpreter hands it to node executions through `NodeRunContext`, and the
   * language adapter folds it into the base system prompt. Absent leaves the
   * base prompt untouched.
   */
  readonly customInstructions?: string;
  readonly hooks: FlowHookBindings;
  /**
   * The client-supplied `Idempotency-Key` header (printable-ASCII, ≤200 chars),
   * claimed in the DO before start. Client-controllable — NEVER surface it as an
   * allowlisted Sentry tag (an allowlisted tag bypasses the scrub); use `runId`
   * for any diagnostic that leaves the process.
   */
  readonly runKey: string;
  /**
   * The DO-minted uuidv7 run id (the `idempotency_keys.id` PK, minted at run
   * start via `newRunId()`; groups the run's charges as `usage_records.runId`).
   * Server-controlled and non-PII, so this — not `runKey` — is the id safe to
   * emit as a Sentry tag on a cost-circuit trip. The production caller (the
   * conversation DO) always supplies it; optional only so in-process executor
   * test doubles need not mint one, and absent it the trip event simply carries
   * no runId tag rather than ever leaking the client `runKey`.
   */
  readonly runId?: string;
  /**
   * Dev/E2E deterministic-inference directives (mirrors `RunContext.mockDirectives`,
   * from which the DO threads it). The executor uses it ONLY to select the mock
   * provider per-run, and only when the DO's env mode enables the mock; absent on
   * the real (OpenRouter/cassette) path.
   */
  readonly mockDirectives?: MockDirectives;
  /**
   * Resolves the file-part→media-event mapper bound to one node's pre-minted
   * persistence identity (fan-out branches each get their own bound mapper;
   * `undefined` means the node has no media plan). An in-process function
   * reference — `FlowStartRequest` is constructed inside the DO, never
   * serialized across the Worker→DO hop — and per-run, like `emit`/`hooks`.
   */
  readonly mapFilePartFor?: (nodeKey: string) => FilePartMapper | undefined;
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
