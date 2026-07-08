import { describe, expect, it } from 'vitest';
import { DEADLINE_CLASS_MS, WorkflowDefinition } from '@hushbox/shared';
import { RoomCore } from './room-core.js';
import type {
  FlowExecutor,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStopReason,
  FlowStreamEvent,
  RunClaim,
  RunClaimRequest,
  RunContext,
  WorkflowDefinition as WorkflowDefinitionType,
} from '@hushbox/shared';
import type { RunStartBody, ServerFrame, SocketAttachment } from './protocol.js';
import type { MembershipDecision } from './revocation.js';
import type { RoomSocket } from './room-core.js';

class FakeSocket implements RoomSocket {
  readonly sent: string[] = [];
  readonly closed: { code: number; reason: string }[] = [];
  constructor(private readonly socketAttachment: SocketAttachment | null) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
  attachment(): SocketAttachment | null {
    return this.socketAttachment;
  }
}

function frames(socket: FakeSocket): ServerFrame[] {
  return socket.sent.map((data) => JSON.parse(data) as ServerFrame);
}

function definition(): WorkflowDefinition {
  return WorkflowDefinition.parse({
    version: 1,
    deadlineClass: 'text',
    hooks: { admission: 'chat-admission', settlement: 'chat-settlement' },
    nodes: [
      {
        id: 'n1',
        version: 1,
        out: 'out',
        type: 'modelCall',
        model: 'test-model',
        params: {},
        in: { node: 'n1', port: 'in' },
      },
    ],
    edges: [],
  });
}

function runBody(runKey = 'key-1'): RunStartBody {
  return {
    mode: 'paid',
    runKey,
    bodyHash: 'body-hash-1',
    definition: definition(),
    inputs: {},
    userId: 'u1',
    senderId: 'sender-1',
    walletId: 'w1',
    epochNumber: 3,
    userMessage: { id: 'um1', content: 'hi' },
  };
}

function trialRunBody(runKey = 'key-1'): RunStartBody {
  return {
    mode: 'trial',
    runKey,
    bodyHash: 'body-hash-1',
    definition: definition(),
    inputs: {},
    sessionId: 'session-1',
  };
}

const DEFAULT_FENCE = { id: 'fence-1', executorId: 'exec-1', claims: 1 };

interface TelemetryRecord {
  method: string;
  fields: Record<string, string | undefined>;
}

interface BindHookCall {
  context: RunContext;
  definition: WorkflowDefinitionType;
}

function makeHarness(options: { maxStreamBytes?: number; doneRejects?: boolean } = {}): {
  core: RoomCore;
  addSocket(principalId: string, overrides?: Partial<SocketAttachment>): FakeSocket;
  addRawSocket(attachment: SocketAttachment | null): FakeSocket;
  decisions: Map<string, MembershipDecision>;
  verifyCalls: string[];
  telemetry: TelemetryRecord[];
  alarms: { set: number[]; deleted: number };
  claim: {
    calls: RunClaimRequest[];
    resolveWith(result: RunClaim): void;
    failNext(): void;
  };
  bindHookCalls: BindHookCall[];
  executor: {
    starts: FlowStartRequest[];
    emit(event: FlowStreamEvent): void;
    finish(outcome: FlowRunOutcome): void;
    stops: FlowStopReason[];
    failNextStart(): void;
  };
} {
  const sockets: FakeSocket[] = [];
  const decisions = new Map<string, MembershipDecision>();
  const verifyCalls: string[] = [];
  const telemetry: TelemetryRecord[] = [];
  const alarms = { set: [] as number[], deleted: 0 };
  const starts: FlowStartRequest[] = [];
  const stops: FlowStopReason[] = [];
  const claimCalls: RunClaimRequest[] = [];
  const bindHookCalls: BindHookCall[] = [];
  let claimResult: RunClaim = { outcome: 'executor', fence: DEFAULT_FENCE };
  let claimShouldFail = false;
  let emitFunction: ((event: FlowStreamEvent) => void) | null = null;
  let finishFunction: ((outcome: FlowRunOutcome) => void) | null = null;
  let shouldFailStart = false;
  let runCounter = 0;

  const executor: FlowExecutor = {
    start(request) {
      if (shouldFailStart) {
        shouldFailStart = false;
        throw new Error('executor exploded');
      }
      starts.push(request);
      emitFunction = request.emit;
      let done: Promise<FlowRunOutcome>;
      if (options.doneRejects === true) {
        done = Promise.reject(new Error('executor defect'));
      } else {
        done = new Promise<FlowRunOutcome>((resolve) => {
          finishFunction = resolve;
        });
      }
      return {
        runId: 'executor-run',
        done,
        stop: (reason) => {
          stops.push(reason);
        },
      };
    },
  };

  const record =
    (method: string) =>
    (fields: Record<string, string | undefined>): void => {
      telemetry.push({ method, fields });
    };

  const core = new RoomCore({
    conversationId: 'c1',
    executor,
    verifier: {
      verify: (conversationId, principalId) => {
        verifyCalls.push(`${conversationId}:${principalId}`);
        return Promise.resolve(decisions.get(principalId) ?? 'member');
      },
    },
    telemetry: {
      runStarted: record('runStarted'),
      runFinished: record('runFinished'),
      runRejected: record('runRejected'),
      deadlineFired: record('deadlineFired'),
      principalEvicted: record('principalEvicted'),
      deliveryPaused: record('deliveryPaused'),
      clientMessageRejected: record('clientMessageRejected'),
      upgradeRejected: record('upgradeRejected'),
      billableGeneration: record('billableGeneration'),
    },
    scheduler: {
      setAlarm: (at) => {
        alarms.set.push(at);
      },
      deleteAlarm: () => {
        alarms.deleted += 1;
      },
    },
    claimRun: (request) => {
      claimCalls.push(request);
      if (claimShouldFail) {
        claimShouldFail = false;
        return Promise.reject(new Error('referee unavailable'));
      }
      return Promise.resolve(claimResult);
    },
    bindHooks: (context, definition) => {
      bindHookCalls.push({ context, definition });
      return {
        admission: () => Promise.resolve({ admitted: true, holdRef: 'hold-1' }),
        settlement: () => Promise.resolve(),
      };
    },
    maxStreamBytes: options.maxStreamBytes ?? 1_000_000,
    now: () => 10_000,
    newRunId: () => {
      runCounter += 1;
      return `run-${String(runCounter)}`;
    },
    sockets: () => sockets,
  });

  return {
    core,
    addSocket: (principalId, overrides = {}) => {
      const socket = new FakeSocket({
        principalId,
        conversationId: 'c1',
        isGuest: false,
        connectedAt: 100,
        ...overrides,
      });
      sockets.push(socket);
      return socket;
    },
    addRawSocket: (attachment) => {
      const socket = new FakeSocket(attachment);
      sockets.push(socket);
      return socket;
    },
    decisions,
    verifyCalls,
    telemetry,
    alarms,
    claim: {
      calls: claimCalls,
      resolveWith: (result) => {
        claimResult = result;
      },
      failNext: () => {
        claimShouldFail = true;
      },
    },
    bindHookCalls,
    executor: {
      starts,
      emit: (event) => {
        if (emitFunction === null) throw new Error('no active run');
        emitFunction(event);
      },
      finish: (outcome) => {
        if (finishFunction === null) throw new Error('no active run');
        finishFunction(outcome);
      },
      stops,
      failNextStart: () => {
        shouldFailStart = true;
      },
    },
  };
}

describe('handleOpen', () => {
  it('sends the ready frame to the opening socket', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.handleOpen(socket);
    expect(frames(socket)[0]).toEqual({ type: 'ready' });
  });

  it('broadcasts presence with the real conversationId', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.handleOpen(socket);
    const presence = frames(socket).find(
      (frame) => frame.type === 'event' && frame.event.type === 'presence:update'
    );
    expect(presence).toMatchObject({ event: { conversationId: 'c1' } });
  });
});

describe('handleClose', () => {
  it('broadcasts presence to the remaining sockets', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.handleClose();
    const presence = frames(socket).find(
      (frame) => frame.type === 'event' && frame.event.type === 'presence:update'
    );
    expect(presence).toBeDefined();
  });

  it('is a no-op when no sockets remain', async () => {
    const h = makeHarness();
    await h.core.handleClose();
    expect(h.verifyCalls).toEqual([]);
  });
});

describe('broadcastEvent', () => {
  function event(): Parameters<RoomCore['broadcastEvent']>[0] {
    return { type: 'rotation:complete', timestamp: 1, conversationId: 'c1', newEpochNumber: 2 };
  }

  it('delivers the event to every member socket', async () => {
    const h = makeHarness();
    const a = h.addSocket('u1');
    const b = h.addSocket('u2');
    await h.core.broadcastEvent(event());
    expect(frames(a)).toEqual([{ type: 'event', event: event() }]);
    expect(frames(b)).toEqual([{ type: 'event', event: event() }]);
  });

  it('verifies each principal once per broadcast', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.addSocket('u1');
    await h.core.broadcastEvent(event());
    expect(h.verifyCalls).toEqual(['c1:u1']);
  });

  it('closes a revoked principal without delivering', async () => {
    const h = makeHarness();
    const revoked = h.addSocket('u2');
    h.decisions.set('u2', 'revoked');
    await h.core.broadcastEvent(event());
    expect(revoked.sent).toEqual([]);
    expect(revoked.closed).toEqual([{ code: 1008, reason: 'revoked' }]);
  });

  it('records telemetry when a principal is evicted at broadcast time', async () => {
    const h = makeHarness();
    h.addSocket('u2');
    h.decisions.set('u2', 'revoked');
    await h.core.broadcastEvent(event());
    expect(h.telemetry).toContainEqual({
      method: 'principalEvicted',
      fields: { conversationId: 'c1' },
    });
  });

  it('skips a paused principal but keeps the socket open', async () => {
    const h = makeHarness();
    const paused = h.addSocket('u3');
    h.decisions.set('u3', 'pause');
    await h.core.broadcastEvent(event());
    expect(paused.sent).toEqual([]);
    expect(paused.closed).toEqual([]);
  });

  it('records telemetry when delivery pauses', async () => {
    const h = makeHarness();
    h.addSocket('u3');
    h.decisions.set('u3', 'pause');
    await h.core.broadcastEvent(event());
    expect(h.telemetry).toContainEqual({
      method: 'deliveryPaused',
      fields: { conversationId: 'c1' },
    });
  });

  it('counts delivered sockets and paused and evicted principals', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.addSocket('u1');
    h.addSocket('u2');
    h.addSocket('u3');
    h.decisions.set('u2', 'revoked');
    h.decisions.set('u3', 'pause');
    await expect(h.core.broadcastEvent(event())).resolves.toEqual({
      delivered: 2,
      paused: 1,
      evicted: 1,
    });
  });

  it('closes a socket whose attachment is unreadable', async () => {
    const h = makeHarness();
    const broken = h.addRawSocket(null);
    await h.core.broadcastEvent(event());
    expect(broken.closed).toEqual([{ code: 1011, reason: 'invalid attachment' }]);
  });

  it('closes a socket whose send fails', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    socket.send = () => {
      throw new Error('socket gone');
    };
    await expect(h.core.broadcastEvent(event())).resolves.toMatchObject({ delivered: 0 });
    expect(socket.closed).toEqual([{ code: 1011, reason: 'send failed' }]);
  });
});

describe('handleClientMessage', () => {
  it('relays a typing event to other members only', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    const typing = { type: 'typing:start', timestamp: 1, conversationId: 'c1', userId: 'u1' };
    await h.core.handleClientMessage(sender, JSON.stringify(typing));
    expect(frames(other)).toEqual([{ type: 'event', event: typing }]);
    expect(sender.sent).toEqual([]);
  });

  it('relays a spoofed userId as the attachment principalId', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    const typing = { type: 'typing:start', timestamp: 1, conversationId: 'c1', userId: 'victim' };
    await h.core.handleClientMessage(sender, JSON.stringify(typing));
    expect(frames(other)).toEqual([{ type: 'event', event: { ...typing, userId: 'u1' } }]);
  });

  it('rejects a typing event for another conversation with telemetry and no delivery', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    const typing = { type: 'typing:stop', timestamp: 1, conversationId: 'c2', userId: 'u1' };
    await h.core.handleClientMessage(sender, JSON.stringify(typing));
    expect(other.sent).toEqual([]);
    expect(h.telemetry).toContainEqual({
      method: 'clientMessageRejected',
      fields: { conversationId: 'c1' },
    });
  });

  it('rejects a typing event from a socket without a readable attachment', async () => {
    const h = makeHarness();
    const sender = h.addRawSocket(null);
    const other = h.addSocket('u2');
    const typing = { type: 'typing:start', timestamp: 1, conversationId: 'c1', userId: 'u1' };
    await h.core.handleClientMessage(sender, JSON.stringify(typing));
    expect(other.sent).toEqual([]);
    expect(h.telemetry).toContainEqual({
      method: 'clientMessageRejected',
      fields: { conversationId: 'c1' },
    });
  });

  it('rejects malformed JSON with telemetry and no delivery', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    await h.core.handleClientMessage(sender, 'not json');
    expect(other.sent).toEqual([]);
    expect(h.telemetry).toContainEqual({
      method: 'clientMessageRejected',
      fields: { conversationId: 'c1' },
    });
  });

  it('rejects a message outside the client vocabulary', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    const forged = { type: 'message:new', timestamp: 1, messageId: 'm1', conversationId: 'c1' };
    await h.core.handleClientMessage(sender, JSON.stringify(forged));
    expect(other.sent).toEqual([]);
  });

  it('answers a resume for an unknown stream with stream-gone', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    await h.core.handleClientMessage(
      sender,
      JSON.stringify({ type: 'resume', streams: [{ streamId: 's1', lastEventId: 0 }] })
    );
    expect(frames(sender)).toEqual([{ type: 'stream-gone', streamId: 's1' }]);
  });

  it('replays nothing to a revoked principal and closes its socket', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    h.decisions.set('u1', 'revoked');
    await h.core.handleClientMessage(
      sender,
      JSON.stringify({ type: 'resume', streams: [{ streamId: 's1', lastEventId: 0 }] })
    );
    expect(sender.sent).toEqual([]);
    expect(sender.closed).toEqual([{ code: 1008, reason: 'revoked' }]);
  });
});

describe('startRun', () => {
  it('returns the executor outcome with the run id and deadline from the class', async () => {
    const h = makeHarness();
    await expect(h.core.startRun(runBody())).resolves.toEqual({
      ok: true,
      outcome: 'executor',
      runId: 'run-1',
      deadlineAt: 10_000 + DEADLINE_CLASS_MS.text,
    });
  });

  it('claims the run referee with the key, run id, and DO-filled identity', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.claim.calls).toEqual([
      {
        runKey: 'key-1',
        runId: 'run-1',
        bodyHash: 'body-hash-1',
        identity: {
          mode: 'paid',
          userId: 'u1',
          senderId: 'sender-1',
          // conversationId comes from the DO's own id, never the body.
          conversationId: 'c1',
          walletId: 'w1',
          epochNumber: 3,
          userMessage: { id: 'um1', content: 'hi' },
        },
      },
    ]);
  });

  it('claims the run referee with a trial identity carrying only the session id', async () => {
    const h = makeHarness();
    await h.core.startRun(trialRunBody());
    expect(h.claim.calls).toEqual([
      {
        runKey: 'key-1',
        runId: 'run-1',
        bodyHash: 'body-hash-1',
        identity: { mode: 'trial', sessionId: 'session-1' },
      },
    ]);
  });

  it('claims the run referee before starting the executor', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'replay', response: { runId: 'earlier' } });
    await h.core.startRun(runBody());
    expect(h.claim.calls).toHaveLength(1);
    expect(h.executor.starts).toEqual([]);
  });

  it('sets the deadline alarm on the executor branch', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.alarms.set).toEqual([10_000 + DEADLINE_CLASS_MS.text]);
  });

  it('binds the hooks with the run context including the captured fence', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const body = runBody();
    await h.core.startRun(body);
    expect(h.bindHookCalls).toEqual([
      {
        context: {
          mode: 'paid',
          userId: 'u1',
          senderId: 'sender-1',
          conversationId: 'c1',
          walletId: 'w1',
          epochNumber: 3,
          userMessage: { id: 'um1', content: 'hi' },
          // The DO-minted run id is threaded into the run context.
          runId: 'run-1',
          fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
        },
        definition: body.definition,
      },
    ]);
  });

  it('threads a paid run forkId into the bound run context', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const base = runBody();
    if (base.mode !== 'paid') throw new Error('expected a paid run body');
    await h.core.startRun({ ...base, forkId: 'fork-1' });
    expect(h.bindHookCalls[0]?.context).toMatchObject({ mode: 'paid', forkId: 'fork-1' });
  });

  it('threads a paid run regenerate action into the bound run context', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const base = runBody();
    if (base.mode !== 'paid') throw new Error('expected a paid run body');
    await h.core.startRun({
      ...base,
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', replaceAssistantId: 'a1' },
    });
    expect(h.bindHookCalls[0]?.context).toMatchObject({
      mode: 'paid',
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', replaceAssistantId: 'a1' },
    });
  });

  it('threads a paid regenerate observed fork tip into the bound run context', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const base = runBody();
    if (base.mode !== 'paid') throw new Error('expected a paid run body');
    await h.core.startRun({
      ...base,
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', observedForkTipId: 'tip-1' },
    });
    const context = h.bindHookCalls[0]?.context;
    if (context?.mode !== 'paid') throw new Error('expected a paid context');
    expect(context.regenerate?.observedForkTipId).toBe('tip-1');
  });

  it('threads a paid edit regenerate without a replaceAssistantId', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const base = runBody();
    if (base.mode !== 'paid') throw new Error('expected a paid run body');
    await h.core.startRun({
      ...base,
      regenerate: { action: 'edit', targetMessageId: 'anchor-1' },
    });
    const context = h.bindHookCalls[0]?.context;
    expect(context).toMatchObject({
      mode: 'paid',
      regenerate: { action: 'edit', targetMessageId: 'anchor-1' },
    });
    if (context?.mode !== 'paid') throw new Error('expected a paid context');
    expect(context.regenerate?.replaceAssistantId).toBeUndefined();
  });

  it('hands the executor the definition, inputs, runKey, and bound hooks', async () => {
    const h = makeHarness();
    const body = runBody();
    await h.core.startRun(body);
    const request = h.executor.starts[0];
    expect(request).toMatchObject({ definition: body.definition, inputs: {}, runKey: 'key-1' });
    await expect(
      request?.hooks.admission({ definition: body.definition, estimate: '0' as never })
    ).resolves.toEqual({ admitted: true, holdRef: 'hold-1' });
  });

  it('replays the stored outcome without executing when the referee replays', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'replay', response: { runId: 'settled-run' } });
    await expect(h.core.startRun(runBody())).resolves.toEqual({
      ok: true,
      outcome: 'replay',
      response: { runId: 'settled-run' },
    });
    expect(h.executor.starts).toEqual([]);
    expect(h.bindHookCalls).toEqual([]);
    expect(h.alarms.set).toEqual([]);
  });

  it('releases the in-memory claim after a replay so a new run can start', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'replay', response: null });
    await h.core.startRun(runBody());
    h.claim.resolveWith({ outcome: 'executor', fence: DEFAULT_FENCE });
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({
      ok: true,
      outcome: 'executor',
    });
  });

  it('returns the attach outcome without executing when the referee attaches', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'attach' });
    await expect(h.core.startRun(runBody())).resolves.toEqual({ ok: true, outcome: 'attach' });
    expect(h.executor.starts).toEqual([]);
    expect(h.alarms.set).toEqual([]);
  });

  it('releases the in-memory claim after an attach so a new run can start', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'attach' });
    await h.core.startRun(runBody());
    h.claim.resolveWith({ outcome: 'executor', fence: DEFAULT_FENCE });
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({
      ok: true,
      outcome: 'executor',
    });
  });

  it('returns a 409 conflict without executing when the referee reports a body mismatch', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'conflict', code: 'IDEMPOTENCY_BODY_MISMATCH' });
    await expect(h.core.startRun(runBody())).resolves.toEqual({
      ok: false,
      code: 'IDEMPOTENCY_BODY_MISMATCH',
    });
    expect(h.executor.starts).toEqual([]);
    expect(h.bindHookCalls).toEqual([]);
    expect(h.alarms.set).toEqual([]);
  });

  it('releases the in-memory claim after a conflict so a new run can start', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'conflict', code: 'IDEMPOTENCY_BODY_MISMATCH' });
    await h.core.startRun(runBody());
    h.claim.resolveWith({ outcome: 'executor', fence: DEFAULT_FENCE });
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({
      ok: true,
      outcome: 'executor',
    });
  });

  it('releases the in-memory claim and rethrows when the referee errors', async () => {
    const h = makeHarness();
    h.claim.failNext();
    await expect(h.core.startRun(runBody())).rejects.toThrow('referee unavailable');
    expect(h.executor.starts).toEqual([]);
    expect(h.alarms.set).toEqual([]);
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({ ok: true });
  });

  it('rejects a concurrent second run with the typed code without claiming again', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    await expect(h.core.startRun(runBody('key-2'))).resolves.toEqual({
      ok: false,
      code: 'CONCURRENT_RUN',
    });
    // The durable referee is never reached for the blocked second run.
    expect(h.claim.calls).toHaveLength(1);
  });

  it('records telemetry for the concurrent rejection', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    await h.core.startRun(runBody('key-2'));
    expect(h.telemetry).toContainEqual({
      method: 'runRejected',
      fields: { conversationId: 'c1', errorCode: 'CONCURRENT_RUN' },
    });
  });

  it('enqueues the run-started frame ahead of the first stream frame', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'hi' },
    });
    await h.core.settled();
    const kinds = frames(socket).map((frame) => frame.type);
    expect(kinds[0]).toBe('run-started');
    expect(kinds).toEqual(['run-started', 'stream']);
  });

  it('releases the claim and rethrows when the executor fails to start', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    h.executor.failNextStart();
    await expect(h.core.startRun(runBody())).rejects.toThrow('executor exploded');
    // A synchronous throw must leave no run-started frame with no matching
    // run-finished — nothing is enqueued for the doomed run.
    await h.core.settled();
    expect(socket.sent).toEqual([]);
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({ ok: true });
  });

  it('deletes the alarm when the executor fails to start', async () => {
    const h = makeHarness();
    h.executor.failNextStart();
    await expect(h.core.startRun(runBody())).rejects.toThrow('executor exploded');
    expect(h.alarms.deleted).toBe(1);
  });
});

describe('stream delivery', () => {
  const delta: FlowStreamEvent = {
    streamId: 's1',
    cursor: 1,
    event: { kind: 'text-delta', index: 0, content: 'hi' },
  };

  it('fans emitted events out as stream frames', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    expect(frames(socket)).toContainEqual({
      type: 'stream',
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'hi' },
    });
  });

  it('replays buffered events on resume', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    sender.sent.length = 0;
    await h.core.handleClientMessage(
      sender,
      JSON.stringify({ type: 'resume', streams: [{ streamId: 's1', lastEventId: 0 }] })
    );
    expect(frames(sender)).toEqual([
      {
        type: 'stream',
        streamId: 's1',
        cursor: 1,
        event: { kind: 'text-delta', index: 0, content: 'hi' },
      },
    ]);
  });

  it('answers stream-gone on resume after the stream overflows its budget', async () => {
    const h = makeHarness({ maxStreamBytes: 10 });
    const sender = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    sender.sent.length = 0;
    await h.core.handleClientMessage(
      sender,
      JSON.stringify({ type: 'resume', streams: [{ streamId: 's1', lastEventId: 0 }] })
    );
    expect(frames(sender)).toEqual([{ type: 'stream-gone', streamId: 's1' }]);
  });

  it('preserves token order through to the finish frame', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    h.executor.emit({ ...delta, cursor: 2 });
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    const cursors = frames(socket)
      .filter((frame) => frame.type === 'stream' || frame.type === 'run-finished')
      .map((frame) => (frame.type === 'stream' ? frame.cursor : 'finished'));
    expect(cursors).toEqual([1, 2, 'finished']);
  });
});

describe('run completion', () => {
  it('broadcasts the run-finished frame with the outcome', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(frames(socket)).toContainEqual({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'succeeded' },
    });
  });

  it('drops the replay buffer with the run', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'x' },
    });
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    sender.sent.length = 0;
    await h.core.handleClientMessage(
      sender,
      JSON.stringify({ type: 'resume', streams: [{ streamId: 's1', lastEventId: 0 }] })
    );
    expect(frames(sender)).toEqual([{ type: 'stream-gone', streamId: 's1' }]);
  });

  it('releases the claim so a new run can start', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({ ok: true });
  });

  it('deletes the deadline alarm', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(h.alarms.deleted).toBe(1);
  });

  it('records telemetry with the failure code when the run fails', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'failed', code: 'TIMEOUT' });
    await h.core.settled();
    expect(h.telemetry).toContainEqual({
      method: 'runFinished',
      fields: { conversationId: 'c1', runId: 'run-1', errorCode: 'TIMEOUT' },
    });
  });

  it('contains a rejected done promise as a failed run', async () => {
    const h = makeHarness({ doneRejects: true });
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    await h.core.settled();
    expect(frames(socket)).toContainEqual({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'failed', code: 'INTERNAL' },
    });
  });

  it('drops a late emission after the run finished', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    socket.sent.length = 0;
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'late' },
    });
    await h.core.settled();
    expect(socket.sent).toEqual([]);
  });
});

describe('stopRun', () => {
  it('forwards the user stop to the executor handle', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.core.stopRun()).toBe(true);
    expect(h.executor.stops).toEqual(['user-stop']);
  });

  it('reports false when no run is active', () => {
    const h = makeHarness();
    expect(h.core.stopRun()).toBe(false);
  });
});

describe('onAlarm', () => {
  it('stops the active run with the deadline reason', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.core.onAlarm();
    expect(h.executor.stops).toEqual(['deadline']);
  });

  it('records deadline telemetry for the stopped run', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.core.onAlarm();
    expect(h.telemetry).toContainEqual({
      method: 'deadlineFired',
      fields: { conversationId: 'c1', runId: 'run-1' },
    });
  });

  it('is a no-op without an active run', () => {
    const h = makeHarness();
    h.core.onAlarm();
    expect(h.telemetry).toEqual([]);
  });
});

describe('evict', () => {
  it('closes only the matching principal sockets', async () => {
    const h = makeHarness();
    const target = h.addSocket('u1');
    const targetSecond = h.addSocket('u1');
    const other = h.addSocket('u2');
    const closed = await h.core.evict('u1');
    expect(closed).toBe(2);
    expect(target.closed).toEqual([{ code: 1008, reason: 'evicted' }]);
    expect(targetSecond.closed).toEqual([{ code: 1008, reason: 'evicted' }]);
    expect(other.closed).toEqual([]);
  });

  it('broadcasts presence to the remaining members', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    const other = h.addSocket('u2');
    await h.core.evict('u1');
    const presence = frames(other).find(
      (frame) => frame.type === 'event' && frame.event.type === 'presence:update'
    );
    expect(presence).toMatchObject({
      event: { members: [{ userId: 'u2', isGuest: false, connectedAt: 100 }] },
    });
  });
});

describe('presenceSnapshot', () => {
  it('returns deduplicated authenticated user ids', () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.addSocket('u1');
    h.addSocket('link-1', { isGuest: true, displayName: 'Guest' });
    expect(h.core.presenceSnapshot()).toEqual(['u1']);
  });
});

describe('billable-generation metric', () => {
  const stepFinish: FlowStreamEvent = {
    streamId: 's1',
    cursor: 1,
    event: { kind: 'step-finish', step: 0, generationId: 'gen-1' },
  };

  it('records one metric per step-finish, dimensioned by conversation, run, generation id', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(stepFinish);
    await h.core.settled();
    // A killed run commits nothing, so this metric is the only record of the
    // generation's provider spend — the actual generationId must ride it so the
    // OpenRouter-usage auditor can reconcile the exact killed generation.
    expect(h.telemetry).toContainEqual({
      method: 'billableGeneration',
      fields: { conversationId: 'c1', runId: 'run-1', generationId: 'gen-1' },
    });
  });

  it('does not record a generation metric for a token delta', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'hi' },
    });
    await h.core.settled();
    expect(h.telemetry.some((entry) => entry.method === 'billableGeneration')).toBe(false);
  });
});

describe('mid-stream revocation', () => {
  it('evicts a principal revoked mid-run and delivers no stream frame', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    // Membership is rechecked at broadcast: revoking after the run started must
    // cut the socket at the next stream frame, never leaking the token.
    h.decisions.set('u1', 'revoked');
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'secret-token' },
    });
    await h.core.settled();
    expect(frames(socket).some((frame) => frame.type === 'stream')).toBe(false);
    expect(socket.sent.some((data) => data.includes('secret-token'))).toBe(false);
    expect(socket.closed).toContainEqual({ code: 1008, reason: 'revoked' });
  });
});

describe('media stream delivery', () => {
  const mediaStart: FlowStreamEvent = {
    streamId: 's1',
    cursor: 1,
    event: { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
  };
  const mediaDone: FlowStreamEvent = {
    streamId: 's1',
    cursor: 2,
    event: {
      kind: 'media-done',
      index: 0,
      value: {
        ref: 'media/c1/m1/abc',
        mimeType: 'image/png',
        modality: 'image',
        byteLength: 3,
        metadata: {},
      },
    },
  };

  it('fans media events out through the generic stream frame', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(mediaStart);
    h.executor.emit(mediaDone);
    await h.core.settled();
    expect(frames(socket)).toContainEqual({
      type: 'stream',
      streamId: 's1',
      cursor: 1,
      event: mediaStart.event,
    });
    expect(frames(socket)).toContainEqual({
      type: 'stream',
      streamId: 's1',
      cursor: 2,
      event: mediaDone.event,
    });
  });

  it('replays buffered media events on resume', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(mediaStart);
    h.executor.emit(mediaDone);
    await h.core.settled();
    sender.sent.length = 0;
    await h.core.handleClientMessage(
      sender,
      JSON.stringify({ type: 'resume', streams: [{ streamId: 's1', lastEventId: 0 }] })
    );
    expect(frames(sender)).toEqual([
      { type: 'stream', streamId: 's1', cursor: 1, event: mediaStart.event },
      { type: 'stream', streamId: 's1', cursor: 2, event: mediaDone.event },
    ]);
  });
});
