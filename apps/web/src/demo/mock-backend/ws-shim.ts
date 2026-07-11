/**
 * Replaces the global `WebSocket` so the demo's conversations connect without
 * a server. The real `ConversationWebSocket` opens a socket to
 * `/conversations/:id/websocket`; this fake dispatches `open` then a single
 * `{"type":"ready"}` frame — the exact signal the client gates fan-out on —
 * and never closes on its own, so there is no reconnect/backoff churn. Sends
 * are accepted and dropped (the demo has no peers). Non-conversation sockets
 * (e.g. Vite HMR in dev) pass through to the real WebSocket untouched.
 */
import type { ServerFrame } from '@hushbox/realtime/protocol';

const CONVERSATION_WS_PREFIX = '/conversations/';
const CONVERSATION_WS_SUFFIX = '/websocket';
const READY_FRAME = '{"type":"ready"}';

type WsListener = (event: unknown) => void;

/**
 * Open fake sockets keyed by conversation id, so the director can push realtime
 * events (group message-replay, typing indicators) and the fetch shim can push
 * run frames to the matching socket.
 */
const openSockets = new Map<string, DemoConversationSocket>();

/** Parse the conversation id out of a `/conversations/:id/websocket?…` url. */
function conversationIdFromUrl(url: string): string {
  const afterPrefix = url.split(CONVERSATION_WS_PREFIX)[1] ?? '';
  return afterPrefix.split(CONVERSATION_WS_SUFFIX)[0] ?? '';
}

function isConversationSocketUrl(url: string): boolean {
  return url.includes(CONVERSATION_WS_PREFIX) && url.includes(CONVERSATION_WS_SUFFIX);
}

/**
 * Push a realtime event to the demo socket of a conversation, wrapped in the
 * `{type:'event', event}` frame the client parses. Returns whether a socket
 * was open to receive it. Best-effort: a missed frame is recovered by the next
 * event's refetch and the ws-ready catch-up refetch.
 */
export function emitDemoRealtimeEvent(conversationId: string, event: object): boolean {
  const socket = openSockets.get(conversationId);
  if (socket === undefined) return false;
  socket.emitFrame({ type: 'event', event } as unknown as ServerFrame);
  return true;
}

/**
 * Streams a run's frames to the conversation's socket with an inter-frame
 * delay (so the reply "types out") plus a one-time lead pause before the
 * first post-label frame — used to simulate image/video generation time.
 * Retries briefly until the socket exists: the client acquires the socket and
 * awaits `ready` before POSTing, but the demo's fetch shim schedules frames
 * as it answers the POST.
 */
export function emitDemoTurnFrames(
  conversationId: string,
  frames: readonly ServerFrame[],
  options: { delayMs: number; leadDelayMs?: number }
): void {
  const { delayMs, leadDelayMs = 0 } = options;
  let index = 0;
  const pushNext = (): void => {
    const socket = openSockets.get(conversationId);
    if (socket === undefined) {
      // Socket briefly absent (registry churn): retry on the same cadence.
      setTimeout(pushNext, Math.max(delayMs, 50));
      return;
    }
    const frame = frames[index];
    if (frame === undefined) return;
    socket.emitFrame(frame);
    index += 1;
    if (index >= frames.length) return;
    // Lead pause between the stream-start label and the first reply frame.
    const wait = index === 2 && leadDelayMs > 0 ? leadDelayMs : delayMs;
    setTimeout(pushNext, wait);
  };
  setTimeout(pushNext, 0);
}

/** A permanently-open fake socket for the demo's conversations. */
export class DemoConversationSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = DemoConversationSocket.OPEN;
  readonly url: string;
  private readonly conversationId: string;
  private readonly listeners = new Map<string, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    this.conversationId = conversationIdFromUrl(url);
    openSockets.set(this.conversationId, this);
    // The client attaches its listeners synchronously right after construction,
    // so defer open + ready to a microtask to guarantee they're caught.
    queueMicrotask(() => {
      this.emit('open', { type: 'open' });
      this.emit('message', { type: 'message', data: READY_FRAME });
    });
  }

  /** Dispatch a server frame to the client as a JSON `message` frame. */
  emitFrame(frame: ServerFrame): void {
    this.emit('message', { type: 'message', data: JSON.stringify(frame) });
  }

  addEventListener(type: string, listener: WsListener): void {
    const set = this.listeners.get(type) ?? new Set<WsListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: WsListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {
    // No peers in the demo — presence/typing/resume frames are dropped.
  }

  close(): void {
    // Client-initiated only (navigation/unmount). Never reconnects.
    this.readyState = DemoConversationSocket.CLOSED;
    if (openSockets.get(this.conversationId) === this) {
      openSockets.delete(this.conversationId);
    }
  }

  private emit(type: string, event: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of set) listener(event);
  }
}

/**
 * Patch `globalThis.WebSocket`. Returns an uninstaller restoring the original.
 *
 * A `Proxy` construct-trap routes only `/conversations/:id/websocket` sockets
 * to the fake; everything else (Vite HMR in dev) is constructed from the real
 * WebSocket. The proxy forwards property access to the target, so
 * `WebSocket.OPEN` and friends keep their real values without re-declaration.
 */
export function installWebSocketShim(): () => void {
  const Original = globalThis.WebSocket;

  globalThis.WebSocket = new Proxy(Original, {
    construct(target, args): object {
      const url = String(args[0]);
      if (isConversationSocketUrl(url)) {
        return new DemoConversationSocket(url);
      }
      return Reflect.construct(target, args) as object;
    },
  });

  return () => {
    globalThis.WebSocket = Original;
  };
}
