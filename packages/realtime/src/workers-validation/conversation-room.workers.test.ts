import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { WS_HEARTBEAT_PING_MESSAGE } from '@hushbox/shared';
import { roomTelemetryControl } from './test-worker.js';

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Connection {
  socket: WebSocket;
  frames: Frame[];
  closes: { code: number; reason: string }[];
}

function roomStub(conversationId: string): DurableObjectStub {
  return env.CONVERSATION_ROOM.get(env.CONVERSATION_ROOM.idFromName(conversationId));
}

async function connect(
  stub: DurableObjectStub,
  conversationId: string,
  principalId: string
): Promise<Connection> {
  const response = await stub.fetch(
    `https://room/websocket?principalId=${principalId}&conversationId=${conversationId}&isGuest=false`,
    { headers: { Upgrade: 'websocket' } }
  );
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error(`upgrade failed: ${String(response.status)}`);
  }
  const connection: Connection = { socket, frames: [], closes: [] };
  socket.accept();
  socket.addEventListener('message', (event) => {
    connection.frames.push(JSON.parse(event.data as string) as Frame);
  });
  socket.addEventListener('close', (event) => {
    connection.closes.push({ code: event.code, reason: event.reason });
  });
  return connection;
}

async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function frameOfType(connection: Connection, type: string): () => Frame | undefined {
  return () => connection.frames.find((frame) => frame.type === type);
}

function definitionInput(): unknown {
  return {
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
  };
}

describe('ConversationRoom under workerd', () => {
  beforeEach(() => {
    roomTelemetryControl.upgradeRejected.length = 0;
  });

  it('records the upgrade-failure metric when the DO rejects bad params', async () => {
    const stub = roomStub('upgrade-fail');
    // conversationId query param mismatches the DO's own id — the upgrade fails
    // its attachment check, and the failure branch emits the WAE metric.
    const response = await stub.fetch(
      'https://room/websocket?principalId=u1&conversationId=wrong-room&isGuest=false',
      { headers: { Upgrade: 'websocket' } }
    );
    expect(response.status).toBe(400);
    expect(roomTelemetryControl.upgradeRejected).toEqual([{ conversationId: 'upgrade-fail' }]);
  });

  it('upgrades a WebSocket and relays a typing event between sockets', async () => {
    const stub = roomStub('relay');
    const alice = await connect(stub, 'relay', 'u1');
    const bob = await connect(stub, 'relay', 'u2');
    await until(frameOfType(alice, 'ready'), 'alice ready');
    await until(frameOfType(bob, 'ready'), 'bob ready');

    const typing = { type: 'typing:start', timestamp: 1, conversationId: 'relay', userId: 'u1' };
    alice.socket.send(JSON.stringify(typing));

    const relayed = await until(
      () =>
        bob.frames.find(
          (frame) => frame.type === 'event' && (frame['event'] as Frame).type === 'typing:start'
        ),
      'typing relay'
    );
    expect(relayed['event']).toEqual(typing);
    expect(
      alice.frames.some(
        (frame) => frame.type === 'event' && (frame['event'] as Frame).type === 'typing:start'
      )
    ).toBe(false);
  });

  it('auto-responds to a heartbeat ping without relaying it to peers', async () => {
    const stub = roomStub('heartbeat');
    const alice = await connect(stub, 'heartbeat', 'u1');
    const bob = await connect(stub, 'heartbeat', 'u2');
    await until(frameOfType(alice, 'ready'), 'alice ready');
    await until(frameOfType(bob, 'ready'), 'bob ready');

    alice.socket.send(WS_HEARTBEAT_PING_MESSAGE);

    // The runtime auto-responds with the pong to the sender without invoking
    // webSocketMessage; the ping must never reach a peer as relayed traffic.
    await until(frameOfType(alice, 'pong'), 'alice heartbeat pong');
    expect(bob.frames.some((frame) => frame.type === 'ping' || frame.type === 'pong')).toBe(false);
  });

  it('preserves the socket attachment across the hibernation serialization round-trip', async () => {
    const stub = roomStub('attachments');
    await connect(stub, 'attachments', 'u1');

    const attachment = await runInDurableObject(stub, (_instance, state) => {
      const [socket] = state.getWebSockets();
      return socket?.deserializeAttachment() as Record<string, unknown>;
    });

    expect(attachment).toMatchObject({
      principalId: 'u1',
      conversationId: 'attachments',
      isGuest: false,
    });
    expect(typeof attachment['connectedAt']).toBe('number');
  });

  it('fires run control when the deadline alarm runs', async () => {
    const stub = roomStub('deadline');
    const alice = await connect(stub, 'deadline', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const started = await stub.fetch('https://room/run/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'paid',
        runKey: 'key-1',
        bodyHash: 'body-hash-1',
        definition: definitionInput(),
        inputs: {},
        userId: 'u1',
        senderId: 'u1',
        walletId: 'w1',
        epochNumber: 1,
        userMessage: { id: crypto.randomUUID(), content: 'hi' },
      }),
    });
    expect(started.status).toBe(201);

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const finished = await until(frameOfType(alice, 'run-finished'), 'run-finished frame');
    expect(finished['outcome']).toEqual({ outcome: 'stopped' });
  });

  function paidRunBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      mode: 'paid',
      runKey: `key-${crypto.randomUUID()}`,
      bodyHash: `hash-${crypto.randomUUID()}`,
      definition: definitionInput(),
      inputs: {},
      userId: 'u1',
      senderId: 'u1',
      walletId: 'w1',
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      ...overrides,
    });
  }

  async function startRun(stub: DurableObjectStub, body: string): Promise<Response> {
    return stub.fetch('https://room/run/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  }

  function releaseHeldStream(stub: DurableObjectStub): Promise<Response> {
    return stub.fetch('https://room/mock/release-stream', { method: 'POST' });
  }

  it('holds a holdPrimaryStream run open until the release route fires', async () => {
    const stub = roomStub('held-run');
    const alice = await connect(stub, 'held-run', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const started = await startRun(
      stub,
      paidRunBody({ mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    // The run is parked at the barrier — no run-finished frame appears.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alice.frames.find((frame) => frame.type === 'run-finished')).toBeUndefined();

    const released = await releaseHeldStream(stub);
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({ released: true });

    const finished = await until(frameOfType(alice, 'run-finished'), 'run-finished after release');
    expect(finished['outcome']).toEqual({ outcome: 'succeeded' });
  });

  it('is a harmless no-op when the release route fires with nothing held', async () => {
    const stub = roomStub('held-none');
    const released = await releaseHeldStream(stub);
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({ released: false });
  });

  it('creates no barrier for a run without holdPrimaryStream (release is a no-op)', async () => {
    const stub = roomStub('held-gate');
    const alice = await connect(stub, 'held-gate', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const started = await startRun(stub, paidRunBody());
    expect(started.status).toBe(201);

    const released = await releaseHeldStream(stub);
    await expect(released.json()).resolves.toEqual({ released: false });
  });

  it('evicts only the requested principal sockets', async () => {
    const stub = roomStub('evict');
    const alice = await connect(stub, 'evict', 'u1');
    const bob = await connect(stub, 'evict', 'u2');
    await until(frameOfType(bob, 'ready'), 'bob ready');

    const response = await stub.fetch('https://room/evict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'u1' }),
    });
    await expect(response.json()).resolves.toEqual({ closed: 1 });

    const closed = await until(() => alice.closes[0], 'alice close event');
    expect(closed.code).toBe(1008);
    expect(bob.closes).toEqual([]);
  });
});
