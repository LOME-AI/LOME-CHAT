import { DEADLINE_CLASS_MS, ERROR_CODES } from '@hushbox/shared';
import { buildPresenceEvent, connectedUserIds } from './presence.js';
import { ReplayBuffer } from './replay-buffer.js';
import { RunControl } from './run-control.js';
import { TRIAL_ROOM_PREFIX, clientMessageSchema, serializeFrame } from './protocol.js';
import type {
  ClaimRun,
  ErrorCode,
  FlowExecutor,
  FlowHoldIdentity,
  FlowHookBindings,
  FlowRunOutcome,
  FlowStreamEvent,
  MockDirectives,
  PaidRunIdentity,
  RunContext,
  RunFence,
  RunIdentity,
  SenderPrincipal,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { RealtimeEvent } from './events.js';
import type { RunStartBody, ServerFrame, SocketAttachment } from './protocol.js';
import type { MembershipDecision, MembershipVerifier } from './revocation.js';
import type { SessionSnapshot, SessionVerifier } from './session-liveness.js';
import type { RoomTelemetry } from './telemetry.js';
import type { UserRoomTracker } from './user-rooms.js';

/**
 * All conversation-room behavior, as a plain node-covered module. The
 * Durable Object class is a thin shell over this core: it adapts platform
 * WebSockets to `RoomSocket`, storage alarms to `AlarmScheduler`, and routes
 * HTTP control calls — nothing else.
 */

export interface RoomSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  attachment(): SocketAttachment | null;
}

export interface AlarmScheduler {
  setAlarm(at: number): void;
  deleteAlarm(): void;
}

export interface BroadcastReceipt {
  /** Sockets the frame was written to. */
  readonly delivered: number;
  /** Principals skipped inside the last-known-good pause window. */
  readonly paused: number;
  /** Principals cut by the broadcast-time revocation check. */
  readonly evicted: number;
}

export type RunStartResult =
  | {
      readonly ok: true;
      readonly outcome: 'executor';
      readonly runId: string;
      readonly deadlineAt: number;
    }
  | { readonly ok: true; readonly outcome: 'replay'; readonly response: unknown }
  | { readonly ok: true; readonly outcome: 'attach' }
  // The concurrent-run block and the referee's body-mismatch conflict both
  // answer 409; the code distinguishes them (CONCURRENT_RUN vs the referee's).
  | { readonly ok: false; readonly code: ErrorCode };

/**
 * The post-settlement push side-band: a succeeded paid run persisted a new
 * message, so members who are not present get a content-free notification. The
 * present-user set is snapshotted at fire time so the downstream selector can
 * suppress members already watching the conversation live. Never carries the
 * message itself — the payload is generic by construction (a push notification
 * sits outside the E2E envelope).
 */
export interface RoomPushNotification {
  readonly conversationId: string;
  readonly senderUserId: string;
  /** Users with an open socket at fire time — suppressed downstream (they saw it live). */
  readonly presentUserIds: readonly string[];
}

/**
 * The injected best-effort push capability. Fired at the run's terminal sink
 * for a succeeded paid run; never throws and never blocks completion. Absent
 * (optional) when no push is wired — the room then finishes runs unchanged.
 */
export type RoomNotify = (notification: RoomPushNotification) => Promise<void>;

export interface RoomCoreOptions {
  readonly conversationId: string;
  readonly executor: FlowExecutor;
  readonly verifier: MembershipVerifier;
  /**
   * Broadcast-time SESSION-liveness backstop, applied per socket ALONGSIDE the
   * membership check: a real user's socket receives a frame only if its session
   * is still valid. This is the correctness guarantee that closes the
   * push-eviction under-inclusion window (a socket held past the active-room-set
   * TTL that an all-session revocation misses). Optional: when absent the room
   * is membership-only (the worker wires it in production); guests and trial
   * principals carry no session snapshot and are never session-checked.
   */
  readonly sessionVerifier?: SessionVerifier;
  readonly telemetry: RoomTelemetry;
  readonly scheduler: AlarmScheduler;
  /** Claims the durable run referee before start, capturing the settlement fence. */
  readonly claimRun: ClaimRun;
  /** Resolves a definition's named policy hooks, closing them over the run context. */
  readonly bindHooks: (context: RunContext, definition: WorkflowDefinition) => FlowHookBindings;
  readonly maxStreamBytes: number;
  readonly now: () => number;
  readonly newRunId: () => string;
  /** The live socket list — the DO supplies ctx.getWebSockets() adapted. */
  readonly sockets: () => readonly RoomSocket[];
  /**
   * Releases an admission hold at the run's terminal sink (paid runs only) —
   * best-effort: a failure leaves the hold to its TTL, never fails the run.
   */
  readonly releaseHold: (hold: FlowHoldIdentity) => Promise<void>;
  /**
   * Fenced key-row lease touch for the live run. `lost` means a retry
   * superseded this run's claim — the room stops the zombie.
   */
  readonly heartbeat: (fence: RunFence) => Promise<'alive' | 'lost'>;
  /**
   * Fenced `claimed → failed` flip for a run that reached a terminal state
   * without settling, freeing the key for one serialized retry. A settled row
   * matches zero rows (a no-op) — the fence keeps this safe on every terminal.
   */
  readonly failRun: (fence: RunFence) => Promise<void>;
  /**
   * Records/removes this room in the connecting user's active-room set so a
   * session revocation can fan an eviction out to it (ARCHITECTURE §15).
   * Optional: absent in tests and until the worker wires the Redis-backed
   * tracker into the DO bindings.
   */
  readonly userRooms?: UserRoomTracker;
  /**
   * Best-effort push for a persisted new message, fired at the terminal sink of
   * a succeeded paid run (never trial, never a failed/stopped run). Optional:
   * absent when no push is wired — a notify failure never affects run
   * completion (fired fire-and-forget through the same best-effort swallow as
   * the money duties).
   */
  readonly notify?: RoomNotify;
}

/**
 * The userId to track for eviction, or null when the socket is not a revocable
 * user session. Link guests (`isGuest`) hold no revocable session — their
 * eviction is the separate link-revoke path — and trial-session principals
 * (sentinel-prefixed ids streaming their own trial room) have no session to
 * revoke; everything else is a real authenticated user.
 */
function trackableUserId(attachment: SocketAttachment): string | null {
  if (attachment.isGuest) return null;
  if (attachment.principalId.startsWith(TRIAL_ROOM_PREFIX)) return null;
  return attachment.principalId;
}

/**
 * The authorizing session snapshot to session-check a socket against, or null
 * when the socket holds no revocable session (a link guest, a trial principal,
 * or — defensively — a real-user socket that predates session threading). Only
 * a real authenticated user carrying both session fields is session-checked;
 * every other socket is governed by the membership check alone.
 */
function sessionSnapshotOf(attachment: SocketAttachment): SessionSnapshot | null {
  if (trackableUserId(attachment) === null) return null;
  if (attachment.sessionId === undefined || attachment.sessionCreatedAt === undefined) {
    return null;
  }
  return {
    userId: attachment.principalId,
    sessionId: attachment.sessionId,
    sessionCreatedAt: attachment.sessionCreatedAt,
  };
}

/**
 * Under half the 90-second run lease so one missed tick never lapses a
 * healthy run's lease.
 */
export const RUN_HEARTBEAT_INTERVAL_MS = 30_000;

const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;

function closeQuietly(socket: RoomSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed — nothing to clean up.
  }
}

type PaidRunStartBody = Extract<RunStartBody, { readonly mode: 'paid' }>;

/**
 * Assembles the paid run identity from the worker→DO body, filling
 * `conversationId` from the DO's own id (never a body field). The optional
 * `forkId` / `regenerate` are spread only when present so the exact-optional
 * identity shape matches. Extracted to keep `startRun`'s branching flat.
 */
function buildPaidIdentity(body: PaidRunStartBody, conversationId: string): PaidRunIdentity {
  const { regenerate } = body;
  return {
    mode: 'paid',
    userId: body.userId,
    senderId: body.senderId,
    // The discriminated sender rides through when the body carried it; a
    // flat-only body maps to no `sender` (the existing user path, unchanged).
    ...(body.sender === undefined ? {} : { sender: body.sender }),
    conversationId,
    walletId: body.walletId,
    epochNumber: body.epochNumber,
    userMessage: body.userMessage,
    ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
    ...(regenerate === undefined
      ? {}
      : {
          regenerate: {
            action: regenerate.action,
            targetMessageId: regenerate.targetMessageId,
            ...(regenerate.replaceAssistantId === undefined
              ? {}
              : { replaceAssistantId: regenerate.replaceAssistantId }),
            ...(regenerate.observedForkTipId === undefined
              ? {}
              : { observedForkTipId: regenerate.observedForkTipId }),
          },
        }),
  };
}

/**
 * The paid sender to carry on the live-run record for the post-settlement push
 * (a trial run notifies no one, so it carries nothing). Extracted so the branch
 * lives here rather than inflating `startRun`.
 */
/**
 * The sender's id for eviction/attribution from a discriminated principal: a
 * member's userId or a link-guest's linkId.
 */
function senderPrincipalId(sender: SenderPrincipal): string {
  return sender.kind === 'user' ? sender.userId : sender.linkId;
}

function liveRunSender(identity: RunIdentity): { readonly senderUserId?: string } {
  if (identity.mode !== 'paid') return {};
  // When the body carried the discriminated sender it is authoritative; a
  // flat-only body falls back to the flat `senderId` (the existing user path).
  const senderId =
    identity.sender === undefined ? identity.senderId : senderPrincipalId(identity.sender);
  return { senderUserId: senderId };
}

/**
 * The run's dev/E2E directives as a spread-ready object — present only when the
 * body carried them (production omits the field). Extracted to keep `startRun`
 * flat, mirroring `buildPaidIdentity` / `liveRunSender`.
 */
function optionalMockDirectives(mockDirectives: MockDirectives | undefined): {
  readonly mockDirectives?: MockDirectives;
} {
  return mockDirectives === undefined ? {} : { mockDirectives };
}

export class RoomCore {
  private readonly runControl = new RunControl();
  private buffer: ReplayBuffer | null = null;
  /** Serializes run-frame fan-out so tokens arrive in emission order. */
  private chain: Promise<void> = Promise.resolve();
  /**
   * The live run's money/lease duties: the settlement fence (heartbeat +
   * fail-on-terminal), the admission hold (released at every terminal), and
   * the heartbeat timer. Guarded by runId like RunControl.release.
   */
  private liveRun: {
    readonly runId: string;
    readonly fence: RunFence;
    /**
     * The paying sender, captured for the post-settlement push. Present only
     * for a paid run (a trial run carries no conversation and never notifies),
     * so it doubles as the paid marker at the terminal sink.
     */
    readonly senderUserId?: string;
    hold?: FlowHoldIdentity;
    heartbeat?: ReturnType<typeof setInterval>;
  } | null = null;

  constructor(private readonly options: RoomCoreOptions) {}

  async handleOpen(socket: RoomSocket): Promise<void> {
    socket.send(serializeFrame({ type: 'ready' }));
    await this.trackSocket(socket);
    await this.broadcastPresence();
  }

  async handleClose(socket: RoomSocket): Promise<void> {
    await this.untrackSocket(socket);
    await this.broadcastPresence();
  }

  /**
   * Records this room in the user's active-room set. Reliability is
   * load-bearing: a missed track would leave a revoked-but-still-member user
   * receiving plaintext until the membership cache expires, so a track failure
   * propagates and the DO fails the upgrade (fail-closed — no socket without a
   * tracked entry) rather than granting an untracked socket. Guests, trial
   * principals, and attachment-less sockets are skipped.
   */
  private async trackSocket(socket: RoomSocket): Promise<void> {
    const tracker = this.options.userRooms;
    if (tracker === undefined) return;
    const attachment = socket.attachment();
    if (attachment === null) return;
    const userId = trackableUserId(attachment);
    if (userId === null) return;
    await tracker.track(userId, this.options.conversationId);
  }

  /**
   * Removes this room from the user's active-room set only when their LAST
   * socket in it closes. Over-inclusion is safe (a stale entry makes a later
   * eviction a harmless no-op) but under-inclusion — dropping the entry while
   * another live socket remains — would leak plaintext, so a lingering
   * same-user socket suppresses the removal. Best-effort: a failed removal is
   * swallowed and reclaimed by the tracker's crash-orphan backstop.
   */
  private async untrackSocket(socket: RoomSocket): Promise<void> {
    const tracker = this.options.userRooms;
    if (tracker === undefined) return;
    const attachment = socket.attachment();
    if (attachment === null) return;
    const userId = trackableUserId(attachment);
    if (userId === null) return;
    const stillConnected = this.options
      .sockets()
      .some((other) => other !== socket && other.attachment()?.principalId === userId);
    if (stillConnected) return;
    await this.swallowDuty(tracker.untrack(userId, this.options.conversationId));
  }

  async broadcastEvent(event: RealtimeEvent): Promise<BroadcastReceipt> {
    return this.deliverFrame({ type: 'event', event }, this.options.sockets());
  }

  async handleClientMessage(sender: RoomSocket, raw: string): Promise<void> {
    const message = this.parseClientMessage(raw);
    if (message === null) {
      this.options.telemetry.clientMessageRejected({
        conversationId: this.options.conversationId,
      });
      return;
    }
    if (message.type === 'resume') {
      const frames = message.streams.flatMap((stream): ServerFrame[] => {
        const result = this.buffer?.resume(stream.streamId, stream.lastEventId) ?? {
          kind: 'gone' as const,
        };
        if (result.kind === 'gone') {
          return [{ type: 'stream-gone', streamId: stream.streamId }];
        }
        return result.events.map(
          (event): ServerFrame => ({
            type: 'stream',
            streamId: event.streamId,
            cursor: event.cursor,
            event: event.event,
          })
        );
      });
      await this.sendToVerified(sender, frames);
      return;
    }
    // Never trust client-provided IDs: the relayed identity comes from the
    // worker-authenticated attachment, and a typing event addressed to another
    // conversation is rejected like any other malformed client message.
    const attachment = sender.attachment();
    if (attachment === null || message.conversationId !== this.options.conversationId) {
      this.options.telemetry.clientMessageRejected({
        conversationId: this.options.conversationId,
      });
      return;
    }
    const event = { ...message, userId: attachment.principalId };
    const others = this.options.sockets().filter((socket) => socket !== sender);
    await this.deliverFrame({ type: 'event', event }, others);
  }

  async evict(principalId: string): Promise<number> {
    const all = this.options.sockets();
    const targets = all.filter((socket) => socket.attachment()?.principalId === principalId);
    for (const socket of targets) {
      closeQuietly(socket, CLOSE_POLICY_VIOLATION, 'evicted');
    }
    const remaining = all.filter((socket) => !targets.includes(socket));
    const attachments = remaining
      .map((socket) => socket.attachment())
      .filter((attachment): attachment is SocketAttachment => attachment !== null);
    if (attachments.length > 0) {
      const presence = buildPresenceEvent(
        this.options.conversationId,
        attachments,
        this.options.now()
      );
      await this.deliverFrame({ type: 'event', event: presence }, remaining);
    }
    return targets.length;
  }

  presenceSnapshot(): string[] {
    const attachments = this.options
      .sockets()
      .map((socket) => socket.attachment())
      .filter((attachment): attachment is SocketAttachment => attachment !== null);
    return connectedUserIds(attachments);
  }

  async startRun(body: RunStartBody): Promise<RunStartResult> {
    const runId = this.options.newRunId();
    const deadlineAt = this.options.now() + DEADLINE_CLASS_MS[body.definition.deadlineClass];
    // The in-memory concurrent-run hard block goes first: a synchronous claim
    // rejects a second run before any durable round trip, and holding it
    // across the async referee claim serializes interleaved starts. A resubmit
    // under the SAME run key passes through to the referee, whose attach
    // branch answers — only a different key is the concurrent-run block.
    const claim = this.runControl.claim(runId, body.runKey, deadlineAt);
    if (!claim.ok) {
      this.options.telemetry.runRejected({
        conversationId: this.options.conversationId,
        errorCode: claim.code,
      });
      return { ok: false, code: claim.code };
    }
    // conversationId is the DO's own id, never a body field: the room a run
    // addresses is the room it runs in. A trial run carries no wallet, epoch,
    // or conversation — only its session id.
    const identity: RunIdentity =
      body.mode === 'paid'
        ? buildPaidIdentity(body, this.options.conversationId)
        : { mode: 'trial', sessionId: body.sessionId };
    let decision;
    try {
      decision = await this.options.claimRun({
        runKey: body.runKey,
        runId,
        bodyHash: body.bodyHash,
        identity,
      });
    } catch (error) {
      this.runControl.release(runId);
      throw error;
    }
    if (decision.outcome === 'conflict') {
      // A reused key with a different body never executes — release the
      // in-memory claim and answer the referee's 409 code.
      this.runControl.release(runId);
      this.options.telemetry.runRejected({
        conversationId: this.options.conversationId,
        errorCode: decision.code,
      });
      return { ok: false, code: decision.code };
    }
    if (decision.outcome === 'replay') {
      this.runControl.release(runId);
      return { ok: true, outcome: 'replay', response: decision.response };
    }
    if (decision.outcome === 'attach') {
      // The attach branch returns without joining the live stream; the fresh
      // in-memory claim is released because nothing starts here.
      this.runControl.release(runId);
      return { ok: true, outcome: 'attach' };
    }
    if (claim.sameKeyLive) {
      // Degenerate race: the referee reclaimed the key while this room still
      // runs it in memory (a lapsed lease under a live run). Nothing starts —
      // the live run keeps streaming and the reclaimed fence idles until its
      // lease lapses again, when a retry can truly re-execute.
      return { ok: true, outcome: 'attach' };
    }
    // Dev/E2E deterministic-inference directives ride the run context untouched
    // (production bodies omit the field); the executor consumes it per-run to
    // select the mock provider, gated DO-side on env mode.
    const context: RunContext = {
      ...identity,
      runId,
      fence: decision.fence,
      ...optionalMockDirectives(body.mockDirectives),
    };
    this.options.scheduler.setAlarm(deadlineAt);
    this.buffer = new ReplayBuffer({ maxStreamBytes: this.options.maxStreamBytes });
    let handle;
    try {
      handle = this.options.executor.start({
        definition: body.definition,
        inputs: body.inputs,
        history: body.history,
        hooks: this.options.bindHooks(context, body.definition),
        runKey: body.runKey,
        ...optionalMockDirectives(context.mockDirectives),
        emit: (event) => {
          this.onStreamEvent(runId, event);
        },
      });
    } catch (error) {
      this.runControl.release(runId);
      this.options.scheduler.deleteAlarm();
      this.buffer = null;
      // Nothing started, but the referee's claim is real: fail it so the key
      // frees for one serialized retry instead of waiting out the lease.
      this.failRunQuietly(decision.fence);
      throw error;
    }
    // Enqueued only after start() returns: a synchronous throw must never leave
    // a run-started frame with no matching run-finished. start() returns the
    // handle synchronously and emits only asynchronously, so this still precedes
    // the first stream frame.
    this.enqueueFrame({ type: 'run-started', runId });
    this.runControl.attach(handle);
    this.liveRun = { runId, fence: decision.fence, ...liveRunSender(identity) };
    this.options.telemetry.runStarted({ conversationId: this.options.conversationId, runId });
    void this.watchRun(runId, handle.done);
    // Admission is decided inside the executor (the one place the policy
    // lives); awaiting it here makes every refusal a synchronous HTTP answer
    // rather than only a run-failed WS event. The refused run terminal-fails
    // through the normal sink above.
    const admission = await handle.admitted;
    if (!admission.admitted) {
      this.options.telemetry.runRejected({
        conversationId: this.options.conversationId,
        errorCode: admission.code,
      });
      return { ok: false, code: admission.code };
    }
    this.adoptAdmission(runId, admission.hold);
    return { ok: true, outcome: 'executor', runId, deadlineAt };
  }

  /**
   * Wires the granted admission into the live-run record: the hold to release
   * at the terminal sink and the lease heartbeat. When the run already
   * finished before admission resolved, the sink could not have known the
   * hold — release it here instead.
   */
  private adoptAdmission(runId: string, hold: FlowHoldIdentity | undefined): void {
    const live = this.liveRun;
    if (live?.runId !== runId) {
      if (hold !== undefined) this.releaseHoldQuietly(hold);
      return;
    }
    if (hold !== undefined) live.hold = hold;
    live.heartbeat = setInterval(() => {
      void this.heartbeatTick(runId, live.fence);
    }, RUN_HEARTBEAT_INTERVAL_MS);
  }

  private async heartbeatTick(runId: string, fence: RunFence): Promise<void> {
    try {
      const result = await this.options.heartbeat(fence);
      if (result === 'lost' && this.liveRun?.runId === runId) {
        // A retry superseded this run's claim. Stop the zombie — its
        // settlement would fence-lose anyway; stopping only saves provider
        // spend.
        this.runControl.stop('user-stop');
      }
    } catch {
      // Best-effort: a transient store failure never stops a healthy run;
      // the fence stays authoritative.
    }
  }

  private async watchRun(runId: string, done: Promise<FlowRunOutcome>): Promise<void> {
    let outcome: FlowRunOutcome;
    try {
      outcome = await done;
    } catch {
      // The executor contract reports failures as outcomes; a rejected
      // `done` is a defect, contained here as a failed run so the room
      // always releases the claim and the alarm.
      outcome = { outcome: 'failed', code: ERROR_CODES.INTERNAL };
    }
    this.finishRun(runId, outcome);
  }

  stopRun(): boolean {
    return this.runControl.stop('user-stop');
  }

  onAlarm(): void {
    const runId = this.runControl.activeRunId();
    if (this.runControl.onAlarm() === 'stopped' && runId !== null) {
      this.options.telemetry.deadlineFired({
        conversationId: this.options.conversationId,
        runId,
      });
    }
  }

  /**
   * Resolves when every enqueued run frame has been fanned out, including
   * frames enqueued by completion microtasks that fire while waiting.
   */
  async settled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.chain;
      await current;
    } while (current !== this.chain);
  }

  private async broadcastPresence(): Promise<void> {
    const sockets = this.options.sockets();
    const attachments = sockets
      .map((socket) => socket.attachment())
      .filter((attachment): attachment is SocketAttachment => attachment !== null);
    if (attachments.length === 0) {
      return;
    }
    const presence = buildPresenceEvent(
      this.options.conversationId,
      attachments,
      this.options.now()
    );
    await this.deliverFrame({ type: 'event', event: presence }, sockets);
  }

  private parseClientMessage(raw: string): ReturnType<typeof clientMessageSchema.parse> | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = clientMessageSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  private onStreamEvent(runId: string, event: FlowStreamEvent): void {
    if (this.runControl.activeRunId() !== runId || this.buffer === null) {
      return;
    }
    this.buffer.append(event);
    this.enqueueFrame({
      type: 'stream',
      streamId: event.streamId,
      cursor: event.cursor,
      event: event.event,
    });
    // Each step-finish is one billable gateway generation (one usage_records
    // row). The metric carries the actual generationId: a killed run commits no
    // usage_records, so this is the only record of that generation's provider
    // spend, and the reconciliation auditor needs which generation — not just
    // how many — to query OpenRouter. The terminal `finish` reuses the last
    // step's generation, so metering only step-finish avoids a double count.
    if (event.event.kind === 'step-finish') {
      this.options.telemetry.billableGeneration({
        conversationId: this.options.conversationId,
        runId,
        generationId: event.event.generationId,
      });
    }
  }

  private finishRun(runId: string, outcome: FlowRunOutcome): void {
    // Capture the live record before settlement clears it — the push decision
    // reads the paid sender it carries.
    const live = this.liveRun?.runId === runId ? this.liveRun : null;
    this.settleRunMoney(runId, outcome);
    this.runControl.release(runId);
    this.options.scheduler.deleteAlarm();
    this.buffer = null;
    this.options.telemetry.runFinished({
      conversationId: this.options.conversationId,
      runId,
      ...(outcome.outcome === 'failed' ? { errorCode: outcome.code } : {}),
    });
    // A succeeded paid run persisted a new message: fire the content-free push
    // to absent members. Trial runs (no senderUserId) and non-succeeded runs
    // (nothing persisted) never notify. Best-effort — never blocks the sink.
    if (outcome.outcome === 'succeeded' && live?.senderUserId !== undefined) {
      this.firePushNotify(live.senderUserId);
    }
    this.enqueueFrame({ type: 'run-finished', runId, outcome });
  }

  /**
   * Fires the injected push capability fire-and-forget with the presence
   * snapshot taken at fire time (absent members are selected downstream). The
   * swallow guards a throwing capability so a push failure can never reach the
   * terminal sink; a missing capability is a no-op.
   */
  private firePushNotify(senderUserId: string): void {
    const notify = this.options.notify;
    if (notify === undefined) return;
    try {
      void this.swallowDuty(
        notify({
          conversationId: this.options.conversationId,
          senderUserId,
          presentUserIds: this.presenceSnapshot(),
        })
      );
    } catch {
      // A synchronous throw from the capability must never reach the sink (an
      // async rejection is caught by swallowDuty); the run still finishes.
    }
  }

  /**
   * The run's money/lease duties at its ONE terminal sink — every outcome
   * (success, stop, failure, deadline, defect) funnels through finishRun, so
   * every run releases its hold here instead of waiting out the TTL, and every
   * unsettled run frees its key row for one serialized retry. All calls are
   * best-effort: TTL expiry and lease lapse remain the backstops.
   */
  private settleRunMoney(runId: string, outcome: FlowRunOutcome): void {
    const live = this.liveRun;
    if (live?.runId !== runId) return;
    this.liveRun = null;
    if (live.heartbeat !== undefined) clearInterval(live.heartbeat);
    if (live.hold !== undefined) this.releaseHoldQuietly(live.hold);
    if (outcome.outcome !== 'succeeded') {
      // Fenced flip to `failed`: a settled row (success, or a stopped run that
      // billed its partial) matches zero rows and no-ops; an unsettled row
      // frees the key so a same-key retry re-executes instead of attaching to
      // a dead run.
      this.failRunQuietly(live.fence);
    }
  }

  /** Best-effort money duty: every failure is swallowed (TTL is the backstop). */
  private releaseHoldQuietly(hold: FlowHoldIdentity): void {
    void this.swallowDuty(this.options.releaseHold(hold));
  }

  /** Best-effort lease duty: every failure is swallowed (lease lapse is the backstop). */
  private failRunQuietly(fence: RunFence): void {
    void this.swallowDuty(this.options.failRun(fence));
  }

  private async swallowDuty(duty: Promise<void>): Promise<void> {
    try {
      await duty;
    } catch {
      // Best-effort by design: the mechanism's own backstop recovers.
    }
  }

  private enqueueFrame(frame: ServerFrame): void {
    this.chain = this.deliverAfter(this.chain, frame);
  }

  private async deliverAfter(previous: Promise<void>, frame: ServerFrame): Promise<void> {
    await previous;
    await this.deliverFrame(frame, this.options.sockets());
  }

  private async sendToVerified(socket: RoomSocket, frames: readonly ServerFrame[]): Promise<void> {
    await this.deliverEach(frames, [socket]);
  }

  private async deliverFrame(
    frame: ServerFrame,
    sockets: readonly RoomSocket[]
  ): Promise<BroadcastReceipt> {
    return this.deliverEach([frame], sockets);
  }

  private async deliverEach(
    frames: readonly ServerFrame[],
    sockets: readonly RoomSocket[]
  ): Promise<BroadcastReceipt> {
    const byPrincipal = this.groupByPrincipal(sockets);
    const receipt = { delivered: 0, paused: 0, evicted: 0 };
    for (const [principalId, group] of byPrincipal) {
      const decision = await this.options.verifier.verify(this.options.conversationId, principalId);
      if (decision !== 'member') {
        this.applyNonMember(decision, group, receipt);
        continue;
      }
      // Member by membership — now the per-socket session backstop. A socket
      // whose authorizing session was revoked (logout, or a password-changed
      // watermark past its snapshot) is cut here even though its principal is
      // still a member, closing the leak the membership check alone cannot.
      for (const socket of group) {
        await this.deliverToMember(socket, frames, receipt);
      }
    }
    return receipt;
  }

  private async deliverToMember(
    socket: RoomSocket,
    frames: readonly ServerFrame[],
    receipt: { delivered: number; paused: number; evicted: number }
  ): Promise<void> {
    const session = await this.checkSession(socket);
    if (session === 'revoked') {
      closeQuietly(socket, CLOSE_POLICY_VIOLATION, 'session-revoked');
      receipt.evicted += 1;
      this.options.telemetry.principalEvicted({ conversationId: this.options.conversationId });
      return;
    }
    if (session === 'pause') {
      receipt.paused += 1;
      this.options.telemetry.deliveryPaused({ conversationId: this.options.conversationId });
      return;
    }
    if (this.sendQuietly(socket, frames)) {
      receipt.delivered += 1;
    }
  }

  /**
   * The socket's session-liveness decision. `live` when there is no session
   * verifier wired (membership-only mode) or the socket holds no revocable
   * session (guest/trial); otherwise the injected verifier's decision.
   */
  private async checkSession(socket: RoomSocket): Promise<'live' | 'revoked' | 'pause'> {
    const verifier = this.options.sessionVerifier;
    if (verifier === undefined) return 'live';
    const attachment = socket.attachment();
    if (attachment === null) return 'live';
    const snapshot = sessionSnapshotOf(attachment);
    if (snapshot === null) return 'live';
    return verifier.verify(snapshot);
  }

  /** Sockets without a readable attachment are closed — they can never be verified. */
  private groupByPrincipal(sockets: readonly RoomSocket[]): Map<string, RoomSocket[]> {
    const byPrincipal = new Map<string, RoomSocket[]>();
    for (const socket of sockets) {
      const attachment = socket.attachment();
      if (attachment === null) {
        closeQuietly(socket, CLOSE_INTERNAL_ERROR, 'invalid attachment');
        continue;
      }
      const group = byPrincipal.get(attachment.principalId) ?? [];
      group.push(socket);
      byPrincipal.set(attachment.principalId, group);
    }
    return byPrincipal;
  }

  /** Applies a non-member broadcast decision to the whole principal group. */
  private applyNonMember(
    decision: Exclude<MembershipDecision, 'member'>,
    group: readonly RoomSocket[],
    receipt: { delivered: number; paused: number; evicted: number }
  ): void {
    if (decision === 'revoked') {
      for (const socket of group) {
        closeQuietly(socket, CLOSE_POLICY_VIOLATION, 'revoked');
      }
      receipt.evicted += 1;
      this.options.telemetry.principalEvicted({ conversationId: this.options.conversationId });
      return;
    }
    receipt.paused += 1;
    this.options.telemetry.deliveryPaused({ conversationId: this.options.conversationId });
  }

  private sendQuietly(socket: RoomSocket, frames: readonly ServerFrame[]): boolean {
    try {
      for (const frame of frames) {
        socket.send(serializeFrame(frame));
      }
      return true;
    } catch {
      closeQuietly(socket, CLOSE_INTERNAL_ERROR, 'send failed');
      return false;
    }
  }
}
