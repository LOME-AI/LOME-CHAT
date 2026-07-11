import { WS_HEARTBEAT_PING_MESSAGE, WS_HEARTBEAT_PONG_MESSAGE } from '@hushbox/shared';
import { getApiUrl } from './api.js';
import { getLinkGuestAuth } from './link-guest-auth.js';
import { parseServerFrame } from './server-frames.js';
import { useNetworkStore } from '../stores/network.js';
import { useWebsocketInboundActivityStore } from '../stores/websocket-inbound-activity.js';
import type { RunFrame } from './server-frames.js';
import type { RealtimeEvent, RealtimeEventType } from '@hushbox/realtime/events';
import type { ResumeRequest } from '@hushbox/realtime/protocol';

// Two rAFs in a browser ensure the React render + commit triggered by the
// inbound-event listener has been painted before the inbound counter
// decrements, so the settled signal can't fire in the gap between the
// listener's state update and React's effect flush. Non-browser fallback
// (Node tests, Workers without rAF) chains two setTimeout(0) calls for
// the same "next two ticks" effect.
//
// `no-restricted-globals` bans `requestAnimationFrame` in favor of the
// `useAnimationFrame` hook from @hushbox/ui, which respects user motion
// preferences. The exemption here is intentional: this is paint-timing
// for settled-signal correctness, not animation; the work runs regardless
// of motion preferences, and the call site isn't inside a React component
// so a hook isn't usable.
function scheduleAfterPaint(callback: () => void): void {
  // eslint-disable-next-line no-restricted-globals -- paint-timing, not animation; see comment above
  if (typeof requestAnimationFrame === 'function') {
    // eslint-disable-next-line no-restricted-globals -- paint-timing, not animation; see comment above
    requestAnimationFrame(() => {
      // eslint-disable-next-line no-restricted-globals -- paint-timing, not animation; see comment above
      requestAnimationFrame(() => {
        callback();
      });
    });
    return;
  }
  setTimeout(() => {
    setTimeout(callback, 0);
  }, 0);
}

// Idle-keepalive heartbeat. On each tick the client sends the ping; the
// Durable Object's setWebSocketAutoResponse answers with the pong from the
// Workers runtime WITHOUT waking the DO or broadcasting to peers. The pong
// (or any other inbound) clears the pong timeout, so an idle-but-alive socket
// no longer trips the half-open detector and reconnects on a fixed cadence.

type EventListener<T extends RealtimeEventType> = (
  event: Extract<RealtimeEvent, { type: T }>
) => void;

// Internal storage type avoids complex Extract narrowing in Map generics
type AnyEventListener = (event: RealtimeEvent) => void;

export type { RunFrame } from './server-frames.js';

export type RunFrameListener = (frame: RunFrame) => void;

/** Resume replays at most this many streams per reconnect (protocol bound). */
const MAX_RESUME_STREAMS = 32;

export interface ConversationWebSocketOptions {
  conversationId: string;
  /**
   * Overrides the default `/conversations/:id/websocket` path (already
   * including any query string). The trial socket uses this — its upgrade
   * lives at `/chat/trial/websocket` and is keyed by the trial token, not a
   * conversation id.
   */
  wsPath?: string;
  onEvent?: (event: RealtimeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
}

interface ResolvedOptions {
  conversationId: string;
  wsPath?: string;
  onEvent?: (event: RealtimeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
  initialBackoffMs: number;
  maxBackoffMs: number;
  heartbeatIntervalMs: number;
  pongTimeoutMs: number;
}

export class ConversationWebSocket {
  private ws: WebSocket | null = null;
  private options: ResolvedOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private currentBackoff: number;
  private intentionalClose = false;
  private shouldBeConnected = false;
  private _ready = false;
  private networkUnsubscribe: (() => void) | null = null;
  private listeners = new Map<string, Set<AnyEventListener>>();
  private frameListeners = new Set<RunFrameListener>();
  private stateListeners = new Set<() => void>();
  /**
   * Last-seen cursor per live stream of the current run. Feeds the `resume`
   * request on reconnect (gap-free replay) and dedupes the replay overlap
   * (a frame at or below the recorded cursor was already delivered). Cleared
   * when the run finishes; a stream answered `stream-gone` is dropped so a
   * later resume no longer asks for it.
   */
  private streamCursors = new Map<string, number>();

  constructor(options: ConversationWebSocketOptions) {
    this.options = {
      initialBackoffMs: 1000,
      maxBackoffMs: 30_000,
      heartbeatIntervalMs: 30_000,
      pongTimeoutMs: 10_000,
      ...options,
    };
    this.currentBackoff = this.options.initialBackoffMs;
  }

  get conversationId(): string {
    return this.options.conversationId;
  }

  connect(): void {
    if (this.ws) return;
    this.intentionalClose = false;
    this.shouldBeConnected = true;
    this.subscribeToNetwork();

    if (useNetworkStore.getState().isOffline) return;

    this.createConnection();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.shouldBeConnected = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.unsubscribeFromNetwork();
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client disconnect');
      }
      // CONNECTING sockets: the open handler detects staleness and closes them
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** True when the server has completed WebSocket registration (fan-out ready). */
  get ready(): boolean {
    return this._ready;
  }

  /**
   * Resolves true once the server's `ready` frame lands (immediately if it
   * already has), false when `timeoutMs` elapses first. Used by the run
   * transport to gate the run-start POST on an attached socket — POSTing
   * before the socket is registered would stream the run's opening frames
   * into the void.
   */
  waitForReady(timeoutMs: number): Promise<boolean> {
    if (this._ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = this.onStateChange(() => {
        if (!this._ready) return;
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
        resolve(true);
      });
      timer = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, timeoutMs);
    });
  }

  on<T extends RealtimeEventType>(type: T, listener: EventListener<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    const set = this.listeners.get(type);
    if (set) set.add(listener as AnyEventListener);
    return (): void => {
      this.listeners.get(type)?.delete(listener as AnyEventListener);
    };
  }

  /** Subscribes to run-output frames (stream / stream-gone / run lifecycle). */
  onRunFrame(listener: RunFrameListener): () => void {
    this.frameListeners.add(listener);
    return (): void => {
      this.frameListeners.delete(listener);
    };
  }

  /** Fires on any connected/ready flip; lets shared-socket consumers rerender. */
  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return (): void => {
      this.stateListeners.delete(listener);
    };
  }

  removeAllListeners(): void {
    this.listeners.clear();
    this.frameListeners.clear();
  }

  send(event: RealtimeEvent): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(event));
  }

  private notifyStateChange(): void {
    for (const listener of this.stateListeners) listener();
  }

  private createConnection(): void {
    const wsUrl = this.buildWsUrl();
    const socket = new WebSocket(wsUrl);
    this.ws = socket;

    socket.addEventListener('open', (): void => {
      if (this.ws !== socket) {
        socket.close(1000, 'Client disconnect');
        return;
      }
      this.currentBackoff = this.options.initialBackoffMs;
      this.startHeartbeat();
      this.sendResumeIfNeeded(socket);
      this.options.onConnectionChange?.(true);
      this.notifyStateChange();
    });

    socket.addEventListener('message', (messageEvent: MessageEvent): void => {
      if (this.ws !== socket) return;

      // Any inbound message proves the socket is alive (the server has no
      // dedicated pong responder; it relays peer traffic and emits ready /
      // presence signals). Treat all of them as the heartbeat's pong.
      this.notePongReceived();

      const raw = String(messageEvent.data);
      // The heartbeat pong is proof-of-life only (notePongReceived already
      // cleared the timeout above); never route it as a frame.
      if (raw === WS_HEARTBEAT_PONG_MESSAGE) {
        return;
      }

      const frame = parseServerFrame(raw);
      if (frame === null) {
        // Malformed frames from transit corruption cannot be fixed
        // client-side; the server validates via Zod before broadcast.
        return;
      }

      if (frame.type === 'ready') {
        this._ready = true;
        this.options.onReadyChange?.(true);
        this.notifyStateChange();
        return;
      }

      const activity = useWebsocketInboundActivityStore.getState();
      activity.startProcessing();
      try {
        if (frame.type === 'event') {
          this.dispatchRealtimeEvent(frame.event);
        } else {
          this.dispatchRunFrame(frame);
        }
      } finally {
        scheduleAfterPaint(() => {
          activity.endProcessing();
        });
      }
    });

    socket.addEventListener('close', (): void => {
      if (this.ws !== socket) return;
      this.ws = null;
      this._ready = false;
      this.stopHeartbeat();
      this.options.onConnectionChange?.(false);
      this.options.onReadyChange?.(false);
      this.notifyStateChange();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener('error', (): void => {
      // onerror is always followed by onclose, so reconnect logic is in onclose
    });
  }

  private dispatchRealtimeEvent(event: RealtimeEvent): void {
    this.options.onEvent?.(event);
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        listener(event);
      }
    }
  }

  private dispatchRunFrame(frame: RunFrame): void {
    switch (frame.type) {
      case 'stream': {
        const last = this.streamCursors.get(frame.streamId) ?? 0;
        // Replay overlap: resume replays from lastEventId+1, but a race between
        // a live frame and the replay can double-deliver. Cursors are strictly
        // increasing per stream, so at-or-below the recorded cursor is a dupe.
        if (frame.cursor <= last) return;
        this.streamCursors.set(frame.streamId, frame.cursor);

        break;
      }
      case 'stream-gone': {
        this.streamCursors.delete(frame.streamId);

        break;
      }
      case 'run-finished': {
        this.streamCursors.clear();

        break;
      }
      // No default
    }
    for (const listener of this.frameListeners) {
      listener(frame);
    }
  }

  /**
   * Gap-free reconnect: replay every live stream from the cursor after the
   * last one seen. Sent before anything else on open so replayed frames land
   * ahead of new live traffic (the DO serializes per-socket sends).
   */
  private sendResumeIfNeeded(socket: WebSocket): void {
    if (this.streamCursors.size === 0) return;
    const streams = [...this.streamCursors.entries()]
      .slice(0, MAX_RESUME_STREAMS)
      .map(([streamId, lastEventId]) => ({ streamId, lastEventId }));
    const resume: ResumeRequest = { type: 'resume', streams };
    socket.send(JSON.stringify(resume));
  }

  private buildWsUrl(): string {
    const apiUrl = getApiUrl();
    const wsBase = apiUrl.replace(/^http/, 'ws');
    if (this.options.wsPath !== undefined) {
      return `${wsBase}${this.options.wsPath}`;
    }
    const base = `${wsBase}/conversations/${this.options.conversationId}/websocket`;
    const linkKey = getLinkGuestAuth();
    if (linkKey) {
      return `${base}?linkPublicKey=${encodeURIComponent(linkKey)}`;
    }
    return base;
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (useNetworkStore.getState().isOffline) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, this.currentBackoff);
    this.currentBackoff = Math.min(this.currentBackoff * 2, this.options.maxBackoffMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Detects half-open sockets (mobile sleep, network handoff) that stay in
   * the OPEN readyState but silently stop delivering data and never fire a
   * `close` event. Without this, the close-driven reconnect path never runs.
   *
   * On each interval tick we send an application-level ping and arm a pong
   * timeout. The DO's auto-response pong (or any other inbound) clears it (see
   * notePongReceived). If the timeout elapses with no inbound traffic, the
   * socket is presumed dead and force-closed, which routes through the existing
   * close -> scheduleReconnect machinery. A socket receiving traffic is never
   * churned because every message resets the timeout. The ping is what keeps
   * an idle-but-alive socket from tripping that timeout every cycle.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(WS_HEARTBEAT_PING_MESSAGE);
      }
      this.armPongTimeout();
    }, this.options.heartbeatIntervalMs);
  }

  private armPongTimeout(): void {
    if (this.pongTimer !== null) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // Half-open: no proof-of-life within the window. Force-close so the
      // close handler tears down state and schedules a reconnect.
      this.ws?.close(4000, 'Heartbeat timeout');
    }, this.options.pongTimeoutMs);
  }

  private notePongReceived(): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private subscribeToNetwork(): void {
    if (this.networkUnsubscribe) return;
    let wasOffline = useNetworkStore.getState().isOffline;
    this.networkUnsubscribe = useNetworkStore.subscribe((state) => {
      const isNowOffline = state.isOffline;
      if (wasOffline && !isNowOffline) this.onNetworkRestored();
      else if (!wasOffline && isNowOffline) this.onNetworkLost();
      wasOffline = isNowOffline;
    });
  }

  private unsubscribeFromNetwork(): void {
    this.networkUnsubscribe?.();
    this.networkUnsubscribe = null;
  }

  private onNetworkLost(): void {
    this.clearReconnectTimer();
  }

  private onNetworkRestored(): void {
    if (!this.shouldBeConnected || this.intentionalClose) return;
    this.currentBackoff = this.options.initialBackoffMs;
    if (!this.ws) this.createConnection();
  }
}
