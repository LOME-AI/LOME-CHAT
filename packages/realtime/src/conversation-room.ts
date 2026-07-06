import { DurableObject } from 'cloudflare:workers';
import { ERROR_CODES, WS_HEARTBEAT_PING_MESSAGE, WS_HEARTBEAT_PONG_MESSAGE } from '@hushbox/shared';
import { realtimeEventSchema } from './events.js';
import { RoomCore } from './room-core.js';
import {
  evictBodySchema,
  runStartBodySchema,
  runStopBodySchema,
  socketAttachmentSchema,
} from './protocol.js';
import type {
  ClaimRun,
  ErrorCode,
  FlowExecutor,
  FlowHookBindings,
  RunContext,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { RoomSocket } from './room-core.js';
import type { MembershipVerifier } from './revocation.js';
import type { RoomTelemetry } from './telemetry.js';

/**
 * The composition seam: the worker binds the executor, the membership
 * verifier, telemetry, the hook binder, and the clock/rng — packages never
 * import apps. The factory below closes the DO class over these bindings;
 * the worker entry re-exports the bound class for the wrangler DO binding.
 */
export interface RoomBindings {
  readonly executor: FlowExecutor;
  readonly verifier: MembershipVerifier;
  readonly telemetry: RoomTelemetry;
  /** Claims the durable run referee before start, capturing the settlement fence. */
  readonly claimRun: ClaimRun;
  /** Resolves a definition's named policy hooks, closing them over the run context. */
  readonly bindHooks: (context: RunContext, definition: WorkflowDefinition) => FlowHookBindings;
  readonly maxStreamBytes: number;
  readonly now: () => number;
  readonly newRunId: () => string;
}

export type ConversationRoomClass<Env> = new (
  ctx: DurableObjectState,
  env: Env
) => DurableObject<Env>;

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Error bodies only carry registry codes — a non-registry literal fails to compile. */
function errorResponse(code: ErrorCode, status: number): Response {
  return jsonResponse({ code }, status);
}

/**
 * Thin-shell Durable Object (the arch pattern: a DO class contains only
 * platform glue). Every behavior — broadcast gating, replay, presence,
 * run control — lives in the plain RoomCore the node project covers; this
 * class only adapts platform WebSockets, storage alarms, and HTTP routing.
 */
export function createConversationRoomClass<Env>(
  createBindings: (env: Env) => RoomBindings
): ConversationRoomClass<Env> {
  return class ConversationRoom extends DurableObject<Env> {
    private readonly core: RoomCore;
    private readonly bindings: RoomBindings;
    private readonly conversationId: string;
    /** Stable per-WebSocket wrappers: RoomCore compares sockets by identity. */
    private readonly wrappers = new WeakMap<WebSocket, RoomSocket>();

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      const name = ctx.id.name;
      if (name === undefined) {
        throw new Error(
          'ConversationRoom requires a named id — reach it via idFromName(conversationId)'
        );
      }
      this.conversationId = name;
      this.bindings = createBindings(env);
      this.core = new RoomCore({
        conversationId: name,
        executor: this.bindings.executor,
        verifier: this.bindings.verifier,
        telemetry: this.bindings.telemetry,
        scheduler: {
          setAlarm: (at) => void this.ctx.storage.setAlarm(at),
          deleteAlarm: () => void this.ctx.storage.deleteAlarm(),
        },
        claimRun: this.bindings.claimRun,
        bindHooks: this.bindings.bindHooks,
        maxStreamBytes: this.bindings.maxStreamBytes,
        now: this.bindings.now,
        newRunId: this.bindings.newRunId,
        sockets: () => this.ctx.getWebSockets().map((socket) => this.wrap(socket)),
      });
      // Idle-keepalive heartbeat: the client sends the ping on each heartbeat
      // tick; the Workers runtime auto-replies the pong WITHOUT invoking
      // webSocketMessage (no peer broadcast, no exit from hibernation), so an
      // idle-but-alive socket never trips the client's half-open timeout.
      // Registration is passive (no timers), so a zero-client room still hibernates.
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(WS_HEARTBEAT_PING_MESSAGE, WS_HEARTBEAT_PONG_MESSAGE)
      );
    }

    override async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /websocket': {
          return this.upgrade(url);
        }
        case 'POST /broadcast': {
          return this.broadcastRoute(request);
        }
        case 'POST /evict': {
          return this.evictRoute(request);
        }
        case 'GET /presence': {
          return jsonResponse({ userIds: this.core.presenceSnapshot() });
        }
        case 'POST /run/start': {
          return this.runStartRoute(request);
        }
        case 'POST /run/stop': {
          return this.runStopRoute(request);
        }
        default: {
          return errorResponse(ERROR_CODES.NOT_FOUND, 404);
        }
      }
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      if (typeof message !== 'string') {
        return;
      }
      // A heartbeat ping arriving outside the auto-response fast path must not be
      // parsed as a chat/typing frame.
      if (message === WS_HEARTBEAT_PING_MESSAGE) {
        return;
      }
      await this.core.handleClientMessage(this.wrap(ws), message);
    }

    async webSocketClose(): Promise<void> {
      await this.core.handleClose();
    }

    async webSocketError(): Promise<void> {
      await this.core.handleClose();
    }

    alarm(): void {
      this.core.onAlarm();
    }

    private async broadcastRoute(request: Request): Promise<Response> {
      const event = realtimeEventSchema.safeParse(await request.json());
      if (!event.success) {
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      return jsonResponse(await this.core.broadcastEvent(event.data));
    }

    private async evictRoute(request: Request): Promise<Response> {
      const body = evictBodySchema.safeParse(await request.json());
      if (!body.success) {
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      return jsonResponse({ closed: await this.core.evict(body.data.principalId) });
    }

    private async runStartRoute(request: Request): Promise<Response> {
      const body = runStartBodySchema.safeParse(await request.json());
      if (!body.success) {
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      const result = await this.core.startRun(body.data);
      if (!result.ok) {
        return errorResponse(result.code, 409);
      }
      // Replay returns the already-settled response; attach signals a live run
      // the client rejoins over the socket. Only the executor branch opens a
      // fresh run.
      if (result.outcome === 'replay') {
        return jsonResponse({ outcome: 'replay', response: result.response }, 200);
      }
      if (result.outcome === 'attach') {
        return jsonResponse({ outcome: 'attach' }, 200);
      }
      return jsonResponse({ runId: result.runId, deadlineAt: result.deadlineAt }, 201);
    }

    private async runStopRoute(request: Request): Promise<Response> {
      const body = runStopBodySchema.safeParse(await request.json());
      if (!body.success) {
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      return jsonResponse({ stopped: this.core.stopRun() });
    }

    private async upgrade(url: URL): Promise<Response> {
      const displayName = url.searchParams.get('displayName');
      const attachment = socketAttachmentSchema.safeParse({
        principalId: url.searchParams.get('principalId'),
        conversationId: url.searchParams.get('conversationId'),
        ...(displayName === null ? {} : { displayName }),
        isGuest: url.searchParams.get('isGuest') === 'true',
        connectedAt: this.bindings.now(),
      });
      if (!attachment.success || attachment.data.conversationId !== this.conversationId) {
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(attachment.data);
      await this.core.handleOpen(this.wrap(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    private wrap(socket: WebSocket): RoomSocket {
      const existing = this.wrappers.get(socket);
      if (existing !== undefined) {
        return existing;
      }
      const wrapped: RoomSocket = {
        send: (data) => {
          socket.send(data);
        },
        close: (code, reason) => {
          socket.close(code, reason);
        },
        attachment: () => {
          const parsed = socketAttachmentSchema.safeParse(socket.deserializeAttachment());
          return parsed.success ? parsed.data : null;
        },
      };
      this.wrappers.set(socket, wrapped);
      return wrapped;
    }
  };
}
