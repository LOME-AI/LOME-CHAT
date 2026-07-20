import { DurableObject } from 'cloudflare:workers';

import { WS_HEARTBEAT_PING_MESSAGE, WS_HEARTBEAT_PONG_MESSAGE } from '@hushbox/shared';

import type { PresenceUpdateEvent } from './events.js';

/** Metadata attached to each WebSocket connection via serializeAttachment */
export interface ConnectionMeta {
  userId?: string;
  displayName?: string;
  isGuest: boolean;
  connectedAt: number;
}

interface PresenceMember {
  userId?: string;
  displayName?: string;
  isGuest: boolean;
  connectedAt: number;
}

/**
 * Per-conversation broadcast hub using Durable Object Hibernation API.
 *
 * Routes:
 *   GET /websocket?userId=xxx           -- authenticated user WebSocket upgrade
 *   GET /websocket?guest=true&name=xxx  -- link guest WebSocket upgrade
 *   POST /broadcast                     -- API Worker sends events to all connections
 *   GET /presence                       -- API Worker queries currently-subscribed userIds
 */
export class ConversationRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    // Idle-keepalive heartbeat: the client sends the ping on each heartbeat
    // tick; the Workers runtime auto-replies with the pong WITHOUT invoking
    // webSocketMessage (no peer broadcast, no exit from hibernation), so an
    // idle-but-alive socket never trips the client's half-open timeout.
    // Register once — registration is passive (no timers), so a room with zero
    // clients still hibernates.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(WS_HEARTBEAT_PING_MESSAGE, WS_HEARTBEAT_PONG_MESSAGE)
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/websocket') {
      return this.handleWebSocketUpgrade(url);
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      return this.handleBroadcast(request);
    }

    if (url.pathname === '/presence' && request.method === 'GET') {
      return this.handlePresenceQuery();
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Returns the deduplicated set of authenticated userIds currently holding
   * an open WebSocket to this room. Used by the API Worker at push-dispatch
   * time to suppress notifications for users who already see the new message
   * via the `message:complete` WebSocket event.
   *
   * Guest sockets are deliberately omitted — guests don't have userIds and
   * can't be the target of a userId-keyed push lookup. Sockets with missing
   * attachment metadata are also skipped (no userId to report).
   */
  private handlePresenceQuery(): Response {
    const sockets = this.ctx.getWebSockets();
    const userIds = new Set<string>();
    for (const ws of sockets) {
      const meta = ws.deserializeAttachment() as ConnectionMeta | null;
      if (meta?.userId !== undefined) {
        userIds.add(meta.userId);
      }
    }
    return Response.json({ userIds: [...userIds] });
  }

  private handleWebSocketUpgrade(url: URL): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const isGuest = url.searchParams.get('guest') === 'true';
    const userId = url.searchParams.get('userId');
    const displayName = url.searchParams.get('name');
    const meta: ConnectionMeta = {
      ...(userId !== null && { userId }),
      ...(displayName !== null && { displayName }),
      isGuest,
      connectedAt: Date.now(),
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(meta);
    this.broadcastPresence();

    // Signal to the client that server-side registration is complete.
    // Tests wait for this instead of using hard-coded timeouts.
    server.send(JSON.stringify({ type: 'ready' }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const event = await request.json();
    const sockets = this.ctx.getWebSockets();
    const message = JSON.stringify(event);

    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        try {
          ws.close(1011, 'Send failed');
        } catch {
          /* already closed */
        }
      }
    }

    return Response.json({ sent: sockets.length });
  }

  /**
   * Hibernation API handler: client sent a message.
   * Only typing events are sent client-to-server. Forward to all OTHER connections.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;

    // Keepalive pings are answered by the runtime auto-response and never reach
    // here; this guard ensures one is never broadcast to peers as chat traffic
    // even if a client sends it outside the auto-response fast path.
    if (message === WS_HEARTBEAT_PING_MESSAGE) return;

    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      if (socket === ws) continue;
      try {
        socket.send(message);
      } catch {
        try {
          socket.close(1011, 'Send failed');
        } catch {
          /* already closed */
        }
      }
    }
  }

  /**
   * Hibernation API handler: WebSocket closed.
   * Clean up and broadcast presence update.
   */
  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    this.broadcastPresence();
  }

  /**
   * Hibernation API handler: WebSocket error.
   */
  webSocketError(ws: WebSocket, _error: unknown): void {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      /* already closed */
    }
    this.broadcastPresence();
  }

  /**
   * Build and broadcast a presence:update event from current connections.
   */
  private broadcastPresence(): void {
    const sockets = this.ctx.getWebSockets();
    const members: PresenceMember[] = [];

    for (const ws of sockets) {
      const meta = ws.deserializeAttachment() as ConnectionMeta | null;
      if (meta) {
        members.push({
          ...(meta.userId !== undefined && { userId: meta.userId }),
          ...(meta.displayName !== undefined && { displayName: meta.displayName }),
          isGuest: meta.isGuest,
          connectedAt: meta.connectedAt,
        });
      }
    }

    const event: PresenceUpdateEvent = {
      type: 'presence:update',
      timestamp: Date.now(),
      conversationId: '',
      members,
    };

    const message = JSON.stringify(event);
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        /* dead socket, ignore */
      }
    }
  }
}
