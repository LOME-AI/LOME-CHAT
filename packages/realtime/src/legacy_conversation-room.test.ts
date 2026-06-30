import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

import type { PresenceUpdateEvent, RealtimeEvent } from './events.js';

interface MockWebSocket {
  send: Mock;
  close: Mock;
  serializeAttachment: Mock;
  deserializeAttachment: Mock;
  _attachment?: unknown;
}

interface ConnectionMeta {
  userId?: string;
  displayName?: string;
  isGuest: boolean;
  connectedAt: number;
}

function createMockWebSocket(meta?: ConnectionMeta): MockWebSocket {
  const ws: MockWebSocket = {
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn((value: unknown) => {
      ws._attachment = value;
    }),
    deserializeAttachment: vi.fn(() => ws._attachment ?? null),
  };
  if (meta) ws._attachment = meta;
  return ws;
}

function createMockCtx(): {
  ctx: { acceptWebSocket: Mock; getWebSockets: Mock; setWebSocketAutoResponse: Mock };
  sockets: MockWebSocket[];
} {
  const sockets: MockWebSocket[] = [];
  return {
    ctx: {
      acceptWebSocket: vi.fn((ws: MockWebSocket) => {
        sockets.push(ws);
      }),
      getWebSockets: vi.fn(() => [...sockets]),
      setWebSocketAutoResponse: vi.fn(),
    },
    sockets,
  };
}

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Mirrors the Workers-runtime global. The DO constructor builds one of these to
// register the idle-keepalive ping/pong auto-response pair.
vi.stubGlobal(
  'WebSocketRequestResponsePair',
  class WebSocketRequestResponsePair {
    constructor(
      readonly request: string,
      readonly response: string
    ) {}
  }
);

let mockPairClient: MockWebSocket;
let mockPairServer: MockWebSocket;

vi.stubGlobal(
  'WebSocketPair',
  class WebSocketPair {
    0: MockWebSocket;
    1: MockWebSocket;
    constructor() {
      mockPairClient = createMockWebSocket();
      mockPairServer = createMockWebSocket();
      this[0] = mockPairClient;
      this[1] = mockPairServer;
    }
  }
);

// Workers runtime accepts status 101 and a `webSocket` property on Response.
// Node.js Response rejects status outside 200-599. Override to support Workers semantics.
const OriginalResponse = globalThis.Response;
vi.stubGlobal(
  'Response',
  class WorkersResponse extends OriginalResponse {
    webSocket: WebSocket | null = null;
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket | null }) {
      const workerStatus = init?.status;
      const ws = (init as Record<string, unknown> | undefined)?.['webSocket'] as
        | WebSocket
        | null
        | undefined;
      const safeInit: ResponseInit | undefined =
        workerStatus === 101 ? { ...init, status: 200, webSocket: null } : init;
      super(body, safeInit);
      if (workerStatus === 101) {
        Object.defineProperty(this, 'status', { value: 101 });
      }
      if (ws != null) {
        this.webSocket = ws;
      }
    }

    static override json(data: unknown, init?: ResponseInit): WorkersResponse {
      return new WorkersResponse(JSON.stringify(data), {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    }
  }
);

let ConversationRoom: typeof import('./legacy_conversation-room.js').ConversationRoom;

beforeEach(async () => {
  vi.resetModules();
  const module_ = await import('./legacy_conversation-room.js');
  ConversationRoom = module_.ConversationRoom;
});

function asPresenceUpdate(event: RealtimeEvent): PresenceUpdateEvent {
  if (event.type !== 'presence:update') {
    throw new Error(`Expected presence:update, got ${event.type}`);
  }
  return event;
}

describe('ConversationRoom', () => {
  describe('fetch routing', () => {
    it('returns 404 for unknown paths', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/unknown');

      const response = await room.fetch(request);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
    });

    it('returns 404 for GET /broadcast (wrong method)', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/broadcast', {
        method: 'GET',
      });

      const response = await room.fetch(request);

      expect(response.status).toBe(404);
    });

    it('returns 404 for POST /presence (wrong method)', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/presence', {
        method: 'POST',
      });

      const response = await room.fetch(request);

      expect(response.status).toBe(404);
    });
  });

  describe('presence query (GET /presence)', () => {
    it('returns an empty userIds array when no sockets are connected', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/presence', { method: 'GET' });

      const response = await room.fetch(request);

      expect(response.status).toBe(200);
      const body: { userIds: string[] } = await response.json();
      expect(body.userIds).toEqual([]);
    });

    it('returns userIds for each connected socket', async () => {
      const { ctx, sockets } = createMockCtx();
      sockets.push(
        createMockWebSocket({ userId: 'user-1', isGuest: false, connectedAt: 1000 }),
        createMockWebSocket({ userId: 'user-2', isGuest: false, connectedAt: 2000 })
      );

      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/presence', { method: 'GET' });

      const response = await room.fetch(request);

      const body: { userIds: string[] } = await response.json();
      expect(body.userIds.toSorted((a, b) => a.localeCompare(b))).toEqual(['user-1', 'user-2']);
    });

    it('deduplicates userIds when the same user has multiple sockets', async () => {
      const { ctx, sockets } = createMockCtx();
      sockets.push(
        createMockWebSocket({ userId: 'user-1', isGuest: false, connectedAt: 1000 }),
        createMockWebSocket({ userId: 'user-1', isGuest: false, connectedAt: 2000 }),
        createMockWebSocket({ userId: 'user-2', isGuest: false, connectedAt: 3000 })
      );

      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/presence', { method: 'GET' });

      const response = await room.fetch(request);

      const body: { userIds: string[] } = await response.json();
      expect(body.userIds.toSorted((a, b) => a.localeCompare(b))).toEqual(['user-1', 'user-2']);
    });

    it('omits guest sockets that have no userId', async () => {
      const { ctx, sockets } = createMockCtx();
      sockets.push(
        createMockWebSocket({ userId: 'user-1', isGuest: false, connectedAt: 1000 }),
        createMockWebSocket({ displayName: 'Guest A', isGuest: true, connectedAt: 2000 })
      );

      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/presence', { method: 'GET' });

      const response = await room.fetch(request);

      const body: { userIds: string[] } = await response.json();
      expect(body.userIds).toEqual(['user-1']);
    });

    it('skips sockets with null attachment metadata', async () => {
      const { ctx, sockets } = createMockCtx();
      const wsWithMeta = createMockWebSocket({
        userId: 'user-1',
        isGuest: false,
        connectedAt: 1000,
      });
      const wsWithoutMeta = createMockWebSocket();
      wsWithoutMeta._attachment = undefined;
      sockets.push(wsWithMeta, wsWithoutMeta);

      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/presence', { method: 'GET' });

      const response = await room.fetch(request);

      const body: { userIds: string[] } = await response.json();
      expect(body.userIds).toEqual(['user-1']);
    });
  });

  describe('WebSocket upgrade (/websocket)', () => {
    it('returns 101 with webSocket property for authenticated user', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/websocket?userId=user-1');

      const response = await room.fetch(request);

      expect(response.status).toBe(101);
      expect(response.webSocket).toBeDefined();
    });

    it('stores ConnectionMeta with userId for authenticated user', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/websocket?userId=user-1');

      await room.fetch(request);

      expect(mockPairServer.serializeAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          isGuest: false,
        })
      );
    });

    it('stores ConnectionMeta with displayName and isGuest for guest', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/websocket?guest=true&name=Guest%20Alice');

      await room.fetch(request);

      expect(mockPairServer.serializeAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: 'Guest Alice',
          isGuest: true,
        })
      );
    });

    it('calls ctx.acceptWebSocket with server socket', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/websocket?userId=user-1');

      await room.fetch(request);

      expect(ctx.acceptWebSocket).toHaveBeenCalledTimes(1);
      expect(ctx.acceptWebSocket).toHaveBeenCalledWith(mockPairServer);
    });

    it('calls serializeAttachment with connection metadata including connectedAt', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/websocket?userId=user-1');

      const before = Date.now();
      await room.fetch(request);
      const after = Date.now();

      const meta = mockPairServer.serializeAttachment.mock.calls[0]?.[0] as ConnectionMeta;
      expect(meta.connectedAt).toBeGreaterThanOrEqual(before);
      expect(meta.connectedAt).toBeLessThanOrEqual(after);
    });

    it('broadcasts presence update to all connected sockets after new connection', async () => {
      const { ctx, sockets } = createMockCtx();
      const existingSocket = createMockWebSocket({
        userId: 'user-1',
        displayName: 'Alice',
        isGuest: false,
        connectedAt: 1000,
      });
      sockets.push(existingSocket);

      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/websocket?userId=user-2');

      await room.fetch(request);

      expect(existingSocket.send).toHaveBeenCalledTimes(1);
      const sentData = asPresenceUpdate(
        JSON.parse(existingSocket.send.mock.calls[0]?.[0] as string) as RealtimeEvent
      );
      expect(sentData.type).toBe('presence:update');
      expect(sentData.members).toHaveLength(2);
      expect(sentData.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: 'user-1' }),
          expect.objectContaining({ userId: 'user-2' }),
        ])
      );
    });

    it('broadcasts presence update including new connection metadata', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/websocket?userId=user-1');

      await room.fetch(request);

      // The newly connected socket receives two messages: presence:update first,
      // then the ready signal. Verify the presence payload specifically.
      expect(mockPairServer.send).toHaveBeenCalledTimes(2);
      const sentData = asPresenceUpdate(
        JSON.parse(mockPairServer.send.mock.calls[0]?.[0] as string) as RealtimeEvent
      );
      expect(sentData.type).toBe('presence:update');
      expect(sentData.members).toHaveLength(1);
      expect(sentData.members[0]).toEqual(
        expect.objectContaining({ userId: 'user-1', isGuest: false })
      );
    });

    it('sends ready signal to the new socket after presence broadcast', async () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const request = new Request('https://fake-host/websocket?userId=user-1');

      await room.fetch(request);

      expect(mockPairServer.send).toHaveBeenCalledTimes(2);
      const readyPayload = JSON.parse(mockPairServer.send.mock.calls[1]?.[0] as string) as {
        type: string;
      };
      expect(readyPayload).toEqual({ type: 'ready' });
    });
  });

  describe('broadcast (/broadcast)', () => {
    it('sends event to all connected sockets', async () => {
      const { ctx, sockets } = createMockCtx();
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      sockets.push(ws1, ws2);

      const room = new ConversationRoom(ctx as never, {} as never);
      const event: RealtimeEvent = {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      const request = new Request('https://fake-host/broadcast', {
        method: 'POST',
        body: JSON.stringify(event),
      });

      await room.fetch(request);

      const expected = JSON.stringify(event);
      expect(ws1.send).toHaveBeenCalledWith(expected);
      expect(ws2.send).toHaveBeenCalledWith(expected);
    });

    it('returns count of sockets in response', async () => {
      const { ctx, sockets } = createMockCtx();
      sockets.push(createMockWebSocket(), createMockWebSocket(), createMockWebSocket());

      const room = new ConversationRoom(ctx as never, {} as never);
      const event: RealtimeEvent = {
        type: 'typing:stop',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      const request = new Request('https://fake-host/broadcast', {
        method: 'POST',
        body: JSON.stringify(event),
      });

      const response = await room.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect((body as { sent: number }).sent).toBe(3);
    });

    it('handles dead sockets gracefully (send throws)', async () => {
      const { ctx, sockets } = createMockCtx();
      const deadSocket = createMockWebSocket();
      deadSocket.send.mockImplementation(() => {
        throw new Error('Socket is closed');
      });
      const aliveSocket = createMockWebSocket();
      sockets.push(deadSocket, aliveSocket);

      const room = new ConversationRoom(ctx as never, {} as never);
      const event: RealtimeEvent = {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      const request = new Request('https://fake-host/broadcast', {
        method: 'POST',
        body: JSON.stringify(event),
      });

      const response = await room.fetch(request);

      expect(response.status).toBe(200);
      expect(aliveSocket.send).toHaveBeenCalled();
    });

    it('closes dead sockets when send fails', async () => {
      const { ctx, sockets } = createMockCtx();
      const deadSocket = createMockWebSocket();
      deadSocket.send.mockImplementation(() => {
        throw new Error('Socket is closed');
      });
      sockets.push(deadSocket);

      const room = new ConversationRoom(ctx as never, {} as never);
      const event: RealtimeEvent = {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      const request = new Request('https://fake-host/broadcast', {
        method: 'POST',
        body: JSON.stringify(event),
      });

      await room.fetch(request);

      expect(deadSocket.close).toHaveBeenCalledWith(1011, 'Send failed');
    });
  });

  describe('webSocketMessage', () => {
    it('forwards string messages to all OTHER sockets (not sender)', () => {
      const { ctx, sockets } = createMockCtx();
      const sender = createMockWebSocket();
      const receiver1 = createMockWebSocket();
      const receiver2 = createMockWebSocket();
      sockets.push(sender, receiver1, receiver2);

      const room = new ConversationRoom(ctx as never, {} as never);
      const message = JSON.stringify({
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });

      room.webSocketMessage(sender as never, message);

      expect(sender.send).not.toHaveBeenCalled();
      expect(receiver1.send).toHaveBeenCalledWith(message);
      expect(receiver2.send).toHaveBeenCalledWith(message);
    });

    it('ignores binary messages (ArrayBuffer)', () => {
      const { ctx, sockets } = createMockCtx();
      const sender = createMockWebSocket();
      const receiver = createMockWebSocket();
      sockets.push(sender, receiver);

      const room = new ConversationRoom(ctx as never, {} as never);
      const binaryMessage = new ArrayBuffer(8);

      room.webSocketMessage(sender as never, binaryMessage);

      expect(receiver.send).not.toHaveBeenCalled();
    });

    it('handles dead sockets during forwarding', () => {
      const { ctx, sockets } = createMockCtx();
      const sender = createMockWebSocket();
      const deadReceiver = createMockWebSocket();
      deadReceiver.send.mockImplementation(() => {
        throw new Error('Socket is closed');
      });
      const aliveReceiver = createMockWebSocket();
      sockets.push(sender, deadReceiver, aliveReceiver);

      const room = new ConversationRoom(ctx as never, {} as never);
      const message = JSON.stringify({
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });

      room.webSocketMessage(sender as never, message);

      expect(deadReceiver.close).toHaveBeenCalledWith(1011, 'Send failed');
      expect(aliveReceiver.send).toHaveBeenCalledWith(message);
    });
  });

  describe('idle keepalive auto-response', () => {
    it('registers a ping->pong auto-response pair on construction', () => {
      const { ctx } = createMockCtx();

      const room = new ConversationRoom(ctx as never, {} as never);

      expect(room).toBeInstanceOf(ConversationRoom);
      expect(ctx.setWebSocketAutoResponse).toHaveBeenCalledTimes(1);
      const pair = ctx.setWebSocketAutoResponse.mock.calls[0]?.[0] as {
        request: string;
        response: string;
      };
      expect(pair.request).toBe(JSON.stringify({ type: 'ping' }));
      expect(pair.response).toBe(JSON.stringify({ type: 'pong' }));
    });

    it('does not broadcast the keepalive ping to peers if it reaches webSocketMessage', () => {
      // Defense-in-depth: the runtime auto-responds to the exact ping without
      // invoking webSocketMessage, so a ping should never hit the broadcast
      // path. If it ever does, it must not be forwarded to other sockets.
      const { ctx, sockets } = createMockCtx();
      const sender = createMockWebSocket();
      const peer = createMockWebSocket();
      sockets.push(sender, peer);

      const room = new ConversationRoom(ctx as never, {} as never);
      room.webSocketMessage(sender as never, JSON.stringify({ type: 'ping' }));

      expect(peer.send).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe('webSocketClose', () => {
    it('completes WebSocket close handshake by calling ws.close(code, reason)', () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const closedSocket = createMockWebSocket();

      room.webSocketClose(closedSocket as never, 1000, 'Normal closure', true);

      expect(closedSocket.close).toHaveBeenCalledWith(1000, 'Normal closure');
    });

    it('handles already-closed socket in close handshake gracefully', () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const closedSocket = createMockWebSocket();
      closedSocket.close.mockImplementation(() => {
        throw new Error('Already closed');
      });

      expect(() => {
        room.webSocketClose(closedSocket as never, 1000, 'Normal', true);
      }).not.toThrow();
    });

    it('broadcasts presence update to remaining sockets', () => {
      const { ctx, sockets } = createMockCtx();
      const remainingSocket = createMockWebSocket({
        userId: 'user-2',
        displayName: 'Bob',
        isGuest: false,
        connectedAt: 1000,
      });
      sockets.push(remainingSocket);

      const room = new ConversationRoom(ctx as never, {} as never);
      const closedSocket = createMockWebSocket();

      room.webSocketClose(closedSocket as never, 1000, 'Normal', true);

      expect(remainingSocket.send).toHaveBeenCalledTimes(1);
      const sentData = asPresenceUpdate(
        JSON.parse(remainingSocket.send.mock.calls[0]?.[0] as string) as RealtimeEvent
      );
      expect(sentData.type).toBe('presence:update');
      expect(sentData.members).toEqual([
        {
          userId: 'user-2',
          displayName: 'Bob',
          isGuest: false,
          connectedAt: 1000,
        },
      ]);
    });
  });

  describe('webSocketError', () => {
    it('closes the errored socket', () => {
      const { ctx } = createMockCtx();
      const room = new ConversationRoom(ctx as never, {} as never);
      const erroredSocket = createMockWebSocket();

      room.webSocketError(erroredSocket as never, new Error('test error'));

      expect(erroredSocket.close).toHaveBeenCalledWith(1011, 'WebSocket error');
    });

    it('broadcasts presence update to remaining sockets', () => {
      const { ctx, sockets } = createMockCtx();
      const remainingSocket = createMockWebSocket({
        userId: 'user-3',
        isGuest: false,
        connectedAt: 2000,
      });
      sockets.push(remainingSocket);

      const room = new ConversationRoom(ctx as never, {} as never);
      const erroredSocket = createMockWebSocket();

      room.webSocketError(erroredSocket as never, new Error('test error'));

      expect(remainingSocket.send).toHaveBeenCalledTimes(1);
      const sentData = JSON.parse(
        remainingSocket.send.mock.calls[0]?.[0] as string
      ) as RealtimeEvent;
      expect(sentData.type).toBe('presence:update');
    });
  });

  describe('broadcastPresence (via webSocketClose)', () => {
    it('builds presence from deserializeAttachment on each socket', () => {
      const { ctx, sockets } = createMockCtx();
      const ws1 = createMockWebSocket({
        userId: 'user-1',
        displayName: 'Alice',
        isGuest: false,
        connectedAt: 1000,
      });
      const ws2 = createMockWebSocket({
        displayName: 'Guest Bob',
        isGuest: true,
        connectedAt: 2000,
      });
      sockets.push(ws1, ws2);

      const room = new ConversationRoom(ctx as never, {} as never);

      room.webSocketClose(createMockWebSocket() as never, 1000, 'Normal', true);

      expect(ws1.deserializeAttachment).toHaveBeenCalled();
      expect(ws2.deserializeAttachment).toHaveBeenCalled();

      const sentData = asPresenceUpdate(
        JSON.parse(ws1.send.mock.calls[0]?.[0] as string) as RealtimeEvent
      );
      expect(sentData.type).toBe('presence:update');
      expect(sentData.members).toHaveLength(2);
      expect(sentData.members).toEqual([
        {
          userId: 'user-1',
          displayName: 'Alice',
          isGuest: false,
          connectedAt: 1000,
        },
        {
          displayName: 'Guest Bob',
          isGuest: true,
          connectedAt: 2000,
        },
      ]);
    });

    it('skips sockets with null attachment', () => {
      const { ctx, sockets } = createMockCtx();
      const wsWithMeta = createMockWebSocket({
        userId: 'user-1',
        isGuest: false,
        connectedAt: 1000,
      });
      const wsWithoutMeta = createMockWebSocket();
      wsWithoutMeta._attachment = undefined;
      sockets.push(wsWithMeta, wsWithoutMeta);

      const room = new ConversationRoom(ctx as never, {} as never);

      room.webSocketClose(createMockWebSocket() as never, 1000, 'Normal', true);

      const sentData = asPresenceUpdate(
        JSON.parse(wsWithMeta.send.mock.calls[0]?.[0] as string) as RealtimeEvent
      );
      expect(sentData.members).toHaveLength(1);
      expect(sentData.members[0]?.userId).toBe('user-1');
    });

    it('sends presence:update event to all remaining sockets', () => {
      const { ctx, sockets } = createMockCtx();
      const ws1 = createMockWebSocket({
        userId: 'user-1',
        isGuest: false,
        connectedAt: 1000,
      });
      const ws2 = createMockWebSocket({
        userId: 'user-2',
        isGuest: false,
        connectedAt: 2000,
      });
      sockets.push(ws1, ws2);

      const room = new ConversationRoom(ctx as never, {} as never);

      room.webSocketClose(createMockWebSocket() as never, 1000, 'Normal', true);

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);

      const sentData1 = JSON.parse(ws1.send.mock.calls[0]?.[0] as string) as RealtimeEvent;
      const sentData2 = JSON.parse(ws2.send.mock.calls[0]?.[0] as string) as RealtimeEvent;
      expect(sentData1.type).toBe('presence:update');
      expect(sentData2.type).toBe('presence:update');
    });
  });
});
