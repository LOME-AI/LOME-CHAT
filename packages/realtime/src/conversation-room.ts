// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- The Cloudflare Workers ambient runtime (the `cloudflare:workers` module + DO globals) has no importable module form; the published `@cloudflare/workers-types` is a global script whose DOM redefinitions break a browser-DOM consumer (apps/web type-checks this source through the typed API client). A path reference to a minimal local ambient shim is the only mechanism that carries the runtime into that consumer's program without polluting its DOM lib.
/// <reference path="./cloudflare-workers.d.ts" />
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
  FlowHoldIdentity,
  FlowHookBindings,
  FlowStartRequest,
  RunContext,
  RunFence,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { RoomNotify, RoomSocket } from './room-core.js';
import type { MembershipVerifier } from './revocation.js';
import type { SessionVerifier } from './session-liveness.js';
import type { RoomTelemetry } from './telemetry.js';
import type { UserRoomTracker } from './user-rooms.js';

/**
 * The composition seam: the worker binds the executor, the membership
 * verifier, telemetry, the hook binder, and the clock/rng — packages never
 * import apps. The factory below closes the DO class over these bindings;
 * the worker entry re-exports the bound class for the wrangler DO binding.
 */
export interface RoomBindings {
  readonly executor: FlowExecutor;
  readonly verifier: MembershipVerifier;
  /**
   * The broadcast-time session-liveness backstop: closes the
   * push-eviction under-inclusion window by cutting a socket whose authorizing
   * session was revoked, even while its principal remains a member. Optional
   * until the worker injects identity's session-liveness read (composed in
   * createRoomBindings, exactly like the membership verifier).
   */
  readonly sessionVerifier?: SessionVerifier;
  readonly telemetry: RoomTelemetry;
  /** Claims the durable run referee before start, capturing the settlement fence. */
  readonly claimRun: ClaimRun;
  /** Resolves a definition's named policy hooks, closing them over the run context. */
  readonly bindHooks: (context: RunContext, definition: WorkflowDefinition) => FlowHookBindings;
  readonly maxStreamBytes: number;
  readonly now: () => number;
  readonly newRunId: () => string;
  /** Releases an admission hold at the run's terminal sink (best-effort). */
  readonly releaseHold: (hold: FlowHoldIdentity) => Promise<void>;
  /** Fenced key-row lease touch for the live run ('lost' = superseded by a retry). */
  readonly heartbeat: (fence: RunFence) => Promise<'alive' | 'lost'>;
  /** Fenced `claimed → failed` flip for a run that terminated without settling. */
  readonly failRun: (fence: RunFence) => Promise<void>;
  /**
   * The per-user active-room set writer (ARCHITECTURE §15): the DO SADDs on WS
   * accept and SREMs when a user's last socket in the room closes, so a session
   * revocation can fan an eviction out to exactly the rooms the user occupies.
   * Optional until the worker wires the Redis-backed tracker.
   */
  readonly userRooms?: UserRoomTracker;
  /**
   * Best-effort push for a persisted new message, fired at the terminal sink of
   * a succeeded paid run. Optional until the composition root injects the push
   * capability (composed in createRoomBindings from the notifications barrel,
   * which slice adapters may not import — so the factory is injected).
   */
  readonly notify?: RoomNotify;
}

export type ConversationRoomClass<Env> = new (
  ctx: DurableObjectState,
  env: Env
) => DurableObject<Env>;

/**
 * The executor start request as the DO hands it to the runtime: `FlowStartRequest`
 * plus the in-memory-only held-stream release awaitable (`awaitStreamRelease`).
 * This is dev/E2E plumbing that rides the in-process executor wiring, NEVER the
 * wire protocol — the DO attaches it only for a `holdPrimaryStream` run, and the
 * chat runtime reads it (by matching structural shape) to build the paused mock
 * provider. Never present in production: no production run carries `mockDirectives`.
 */
export type HeldStreamStartRequest = FlowStartRequest & {
  readonly awaitStreamRelease?: () => Promise<void>;
};

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
    /**
     * The dev/E2E held-stream barrier: the resolver for the currently-parked
     * primary stream, or null when nothing is held. A single per-DO slot (one
     * run per conversation), set only for a `holdPrimaryStream` run — which only
     * ever exists in dev/E2E (no production run carries `mockDirectives`), so this
     * stays null in production by construction. Cleared and resolved by the
     * release route (idempotent: releasing with nothing held is a no-op).
     */
    private heldStreamRelease: (() => void) | null = null;

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
      // Wrap the injected executor so a `holdPrimaryStream` run gets the DO-owned
      // release barrier threaded into its start request (in-process only, never
      // the wire). Every other run passes through untouched.
      const baseExecutor = this.bindings.executor;
      const heldStreamExecutor: FlowExecutor = {
        start: (request) => baseExecutor.start(this.attachHeldStreamRelease(request)),
      };
      this.core = new RoomCore({
        conversationId: name,
        executor: heldStreamExecutor,
        verifier: this.bindings.verifier,
        ...(this.bindings.sessionVerifier === undefined
          ? {}
          : { sessionVerifier: this.bindings.sessionVerifier }),
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
        releaseHold: this.bindings.releaseHold,
        heartbeat: this.bindings.heartbeat,
        failRun: this.bindings.failRun,
        ...(this.bindings.userRooms === undefined ? {} : { userRooms: this.bindings.userRooms }),
        ...(this.bindings.notify === undefined ? {} : { notify: this.bindings.notify }),
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
        case 'POST /mock/release-stream': {
          // The dev/E2E held-stream release. Inert in production by construction
          // (no run is ever held there, so the slot is always null); externally
          // reachable only through the product Worker's `dev-only` forward route,
          // which 404s in production.
          return this.releaseHeldStreamRoute();
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

    async webSocketClose(ws: WebSocket): Promise<void> {
      await this.core.handleClose(this.wrap(ws));
    }

    async webSocketError(ws: WebSocket): Promise<void> {
      await this.core.handleClose(this.wrap(ws));
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

    /**
     * Attaches the DO-owned release barrier to a `holdPrimaryStream` run's start
     * request so the paused mock provider can await it. The Promise executor runs
     * synchronously, so the resolver is captured into the single per-DO slot
     * before the (augmented) request returns. A non-held run passes through
     * unchanged — no barrier, no slot mutation.
     */
    private attachHeldStreamRelease(request: FlowStartRequest): HeldStreamStartRequest {
      if (request.mockDirectives?.holdPrimaryStream !== true) {
        return request;
      }
      const gate = new Promise<void>((resolve) => {
        this.heldStreamRelease = resolve;
      });
      return { ...request, awaitStreamRelease: () => gate };
    }

    /** Resolves and clears the held-stream barrier. No-op when nothing is held. */
    private releaseHeldStreamRoute(): Response {
      const release = this.heldStreamRelease;
      this.heldStreamRelease = null;
      if (release !== null) {
        release();
      }
      return jsonResponse({ released: release !== null });
    }

    private async upgrade(url: URL): Promise<Response> {
      const displayName = url.searchParams.get('displayName');
      // The worker authorizes the session before proxying the upgrade and
      // forwards its snapshot (a real user only) so the broadcast-time
      // session-liveness check can validate the socket. Absent for guests and
      // trial principals — they hold no revocable session.
      const sessionId = url.searchParams.get('sessionId');
      const sessionCreatedAt = url.searchParams.get('sessionCreatedAt');
      const attachment = socketAttachmentSchema.safeParse({
        principalId: url.searchParams.get('principalId'),
        conversationId: url.searchParams.get('conversationId'),
        ...(displayName === null ? {} : { displayName }),
        isGuest: url.searchParams.get('isGuest') === 'true',
        connectedAt: this.bindings.now(),
        ...(sessionId === null ? {} : { sessionId }),
        ...(sessionCreatedAt === null ? {} : { sessionCreatedAt: Number(sessionCreatedAt) }),
      });
      if (!attachment.success || attachment.data.conversationId !== this.conversationId) {
        this.bindings.telemetry.upgradeRejected({ conversationId: this.conversationId });
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
