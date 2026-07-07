import { DEADLINE_CLASS_MS, ERROR_CODES } from '@hushbox/shared';
import { buildPresenceEvent, connectedUserIds } from './presence.js';
import { ReplayBuffer } from './replay-buffer.js';
import { RunControl } from './run-control.js';
import { clientMessageSchema, serializeFrame } from './protocol.js';
import type {
  ClaimRun,
  ErrorCode,
  FlowExecutor,
  FlowHookBindings,
  FlowRunOutcome,
  FlowStreamEvent,
  PaidRunIdentity,
  RunContext,
  RunIdentity,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { RealtimeEvent } from './events.js';
import type { RunStartBody, ServerFrame, SocketAttachment } from './protocol.js';
import type { MembershipDecision, MembershipVerifier } from './revocation.js';
import type { RoomTelemetry } from './telemetry.js';

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

export interface RoomCoreOptions {
  readonly conversationId: string;
  readonly executor: FlowExecutor;
  readonly verifier: MembershipVerifier;
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
}

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
          },
        }),
  };
}

export class RoomCore {
  private readonly runControl = new RunControl();
  private buffer: ReplayBuffer | null = null;
  /** Serializes run-frame fan-out so tokens arrive in emission order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: RoomCoreOptions) {}

  async handleOpen(socket: RoomSocket): Promise<void> {
    socket.send(serializeFrame({ type: 'ready' }));
    await this.broadcastPresence();
  }

  async handleClose(): Promise<void> {
    await this.broadcastPresence();
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
    // across the async referee claim serializes interleaved starts.
    const claim = this.runControl.claim(runId, deadlineAt);
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
    const context: RunContext = { ...identity, runId, fence: decision.fence };
    this.options.scheduler.setAlarm(deadlineAt);
    this.buffer = new ReplayBuffer({ maxStreamBytes: this.options.maxStreamBytes });
    let handle;
    try {
      handle = this.options.executor.start({
        definition: body.definition,
        inputs: body.inputs,
        hooks: this.options.bindHooks(context, body.definition),
        runKey: body.runKey,
        emit: (event) => {
          this.onStreamEvent(runId, event);
        },
      });
    } catch (error) {
      this.runControl.release(runId);
      this.options.scheduler.deleteAlarm();
      this.buffer = null;
      throw error;
    }
    // Enqueued only after start() returns: a synchronous throw must never leave
    // a run-started frame with no matching run-finished. start() returns the
    // handle synchronously and emits only asynchronously, so this still precedes
    // the first stream frame.
    this.enqueueFrame({ type: 'run-started', runId });
    this.runControl.attach(handle);
    this.options.telemetry.runStarted({ conversationId: this.options.conversationId, runId });
    void this.watchRun(runId, handle.done);
    return { ok: true, outcome: 'executor', runId, deadlineAt };
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
    this.runControl.release(runId);
    this.options.scheduler.deleteAlarm();
    this.buffer = null;
    this.options.telemetry.runFinished({
      conversationId: this.options.conversationId,
      runId,
      ...(outcome.outcome === 'failed' ? { errorCode: outcome.code } : {}),
    });
    this.enqueueFrame({ type: 'run-finished', runId, outcome });
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
      this.applyDecision(decision, group, frames, receipt);
    }
    return receipt;
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

  private applyDecision(
    decision: MembershipDecision,
    group: readonly RoomSocket[],
    frames: readonly ServerFrame[],
    receipt: { delivered: number; paused: number; evicted: number }
  ): void {
    if (decision === 'member') {
      for (const socket of group) {
        if (this.sendQuietly(socket, frames)) {
          receipt.delivered += 1;
        }
      }
      return;
    }
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
