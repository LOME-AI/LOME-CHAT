import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetApiUrl = vi.hoisted(() => vi.fn(() => 'http://localhost:8787'));
vi.mock('./api.js', () => ({
  getApiUrl: () => mockGetApiUrl(),
}));

const mockGetLinkGuestAuth = vi.fn<() => string | null>(() => null);
vi.mock('./link-guest-auth.js', () => ({
  getLinkGuestAuth: () => mockGetLinkGuestAuth(),
}));

const mockNetworkStore = vi.hoisted(() => {
  let isOffline = false;
  const listeners = new Set<
    (state: { isOffline: boolean; setIsOffline: (v: boolean) => void }) => void
  >();
  return {
    useNetworkStore: {
      getState: (): { isOffline: boolean; setIsOffline: (v: boolean) => void } => ({
        isOffline,
        setIsOffline: () => {},
      }),
      subscribe: (
        listener: (state: { isOffline: boolean; setIsOffline: (v: boolean) => void }) => void
      ): (() => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    },
    _setOffline: (offline: boolean): void => {
      isOffline = offline;
      for (const listener of listeners) {
        listener({ isOffline: offline, setIsOffline: () => {} });
      }
    },
    _reset: (): void => {
      isOffline = false;
      listeners.clear();
    },
    _listenerCount: (): number => listeners.size,
  };
});
vi.mock('../stores/network.js', () => ({
  useNetworkStore: mockNetworkStore.useNetworkStore,
}));

const mockStartProcessing = vi.fn();
const mockEndProcessing = vi.fn();
vi.mock('../stores/websocket-inbound-activity.js', () => ({
  useWebsocketInboundActivityStore: {
    getState: (): { startProcessing: () => void; endProcessing: () => void } => ({
      startProcessing: mockStartProcessing,
      endProcessing: mockEndProcessing,
    }),
  },
}));

import { ConversationWebSocket, type ConversationWebSocketOptions } from './ws-client.js';

// readyState starts as OPEN. onopen is NOT auto-fired; tests trigger it manually.

class MockWebSocket {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;

  readyState: number = MockWebSocket.OPEN;
  url: string;

  private eventListeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set());
    }
    const set = this.eventListeners.get(type);
    if (set) set.add(listener);
  }

  dispatchEvent(type: string, event: unknown): void {
    const listeners = this.eventListeners.get(type);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent('close', {} as CloseEvent);
  });
}

let createdWebSockets: MockWebSocket[] = [];
const OriginalMockWebSocket = MockWebSocket;

function createMockWebSocketConstructor(): typeof MockWebSocket {
  return class TrackedMockWebSocket extends OriginalMockWebSocket {
    constructor(url: string) {
      super(url);
      createdWebSockets.push(this);
    }
  } as typeof MockWebSocket;
}

function simulateOpen(ws: MockWebSocket): void {
  ws.dispatchEvent('open', {} as Event);
}

function simulateUnexpectedClose(ws: MockWebSocket): void {
  ws.readyState = MockWebSocket.CLOSED;
  ws.dispatchEvent('close', {} as CloseEvent);
}

describe('ConversationWebSocket', () => {
  beforeEach(() => {
    // Include rAF in the fake-timer set because the inbound-activity tail
    // is scheduled via requestAnimationFrame (post-paint) rather than
    // setTimeout. Without this, tests that advance fake time won't fire
    // the endProcessing tail and assertions on it will spuriously fail.
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'Date',
      ],
    });
    createdWebSockets = [];
    mockNetworkStore._reset();
    const TrackedMock = createMockWebSocketConstructor();
    Object.defineProperty(TrackedMock, 'CONNECTING', { value: 0 });
    Object.defineProperty(TrackedMock, 'OPEN', { value: 1 });
    Object.defineProperty(TrackedMock, 'CLOSING', { value: 2 });
    Object.defineProperty(TrackedMock, 'CLOSED', { value: 3 });
    vi.stubGlobal('WebSocket', TrackedMock);
    mockGetApiUrl.mockReset().mockReturnValue('http://localhost:8787');
    mockGetLinkGuestAuth.mockReset().mockReturnValue(null);
    mockStartProcessing.mockReset();
    mockEndProcessing.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createClient(
    overrides: Partial<ConversationWebSocketOptions> = {}
  ): ConversationWebSocket {
    return new ConversationWebSocket({
      conversationId: 'conv-123',
      ...overrides,
    });
  }

  function getLastWebSocket(): MockWebSocket {
    const ws = createdWebSockets.at(-1);
    if (!ws) throw new Error('No WebSocket created');
    return ws;
  }

  describe('construction', () => {
    it('creates instance without connecting', () => {
      const client = createClient();
      expect(client).toBeInstanceOf(ConversationWebSocket);
      expect(createdWebSockets).toHaveLength(0);
    });
  });

  describe('connect', () => {
    it('creates WebSocket with correct URL', () => {
      const client = createClient({ conversationId: 'abc-def' });
      client.connect();
      expect(createdWebSockets).toHaveLength(1);
      expect(getLastWebSocket().url).toBe('ws://localhost:8787/conversations/abc-def/websocket');
    });

    it('converts http to ws in URL', () => {
      const client = createClient();
      client.connect();
      expect(getLastWebSocket().url).toBe('ws://localhost:8787/conversations/conv-123/websocket');
    });

    it('converts https to wss in URL', () => {
      mockGetApiUrl.mockReturnValue('https://api.hushbox.ai');
      const client = createClient();
      client.connect();
      expect(getLastWebSocket().url).toBe('wss://api.hushbox.ai/conversations/conv-123/websocket');
    });

    it('appends linkPublicKey query param for link guests', () => {
      mockGetLinkGuestAuth.mockReturnValue('base64LinkPublicKey==');
      const client = createClient();
      client.connect();
      expect(getLastWebSocket().url).toBe(
        'ws://localhost:8787/conversations/conv-123/websocket?linkPublicKey=base64LinkPublicKey%3D%3D'
      );
    });

    it('does not append linkPublicKey when not a link guest', () => {
      mockGetLinkGuestAuth.mockReturnValue(null);
      const client = createClient();
      client.connect();
      expect(getLastWebSocket().url).toBe('ws://localhost:8787/conversations/conv-123/websocket');
    });

    it('no-ops if already connected', () => {
      const client = createClient();
      client.connect();
      client.connect(); // second call
      expect(createdWebSockets).toHaveLength(1);
    });
  });

  describe('connected getter', () => {
    it('returns false before connecting', () => {
      const client = createClient();
      expect(client.connected).toBe(false);
    });

    it('returns true when WebSocket is open', () => {
      const client = createClient();
      client.connect();
      expect(client.connected).toBe(true);
    });

    it('returns false after disconnect', () => {
      const client = createClient();
      client.connect();
      client.disconnect();
      expect(client.connected).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('closes WebSocket with code 1000', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      client.disconnect();
      expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnect');
    });

    it('prevents reconnection after disconnect', () => {
      const client = createClient({ initialBackoffMs: 100 });
      client.connect();

      client.disconnect();

      vi.advanceTimersByTime(200);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('no-ops if not connected', () => {
      const client = createClient();
      expect(() => {
        client.disconnect();
      }).not.toThrow();
    });

    it('does not call close on CONNECTING socket', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      ws.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      expect(ws.close).not.toHaveBeenCalled();
    });

    it('closes stale socket when it opens after disconnect', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      ws.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      ws.readyState = MockWebSocket.OPEN;
      simulateOpen(ws);

      expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnect');
    });

    it('ignores close events from stale sockets', () => {
      const onConnectionChange = vi.fn();
      const client = createClient({ onConnectionChange, initialBackoffMs: 100 });
      client.connect();
      const ws1 = getLastWebSocket();
      ws1.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      ws1.readyState = MockWebSocket.CLOSED;
      ws1.dispatchEvent('close', {} as CloseEvent);

      expect(onConnectionChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('ignores messages from stale sockets', () => {
      const onEvent = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 1,
        conversationId: 'c1',
        userId: 'u1',
      };

      const client = createClient({ onEvent });
      client.connect();
      const ws1 = getLastWebSocket();
      ws1.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      ws1.readyState = MockWebSocket.OPEN;
      ws1.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe('onopen', () => {
    it('resets backoff to initial value', () => {
      const client = createClient({ initialBackoffMs: 500, maxBackoffMs: 10_000 });
      client.connect();
      const ws1 = getLastWebSocket();

      simulateOpen(ws1);

      simulateUnexpectedClose(ws1);

      vi.advanceTimersByTime(500);
      expect(createdWebSockets).toHaveLength(2);
      const ws2 = getLastWebSocket();

      simulateOpen(ws2);

      simulateUnexpectedClose(ws2);

      // Should reconnect at 500ms again (not 1000ms) because backoff was reset
      vi.advanceTimersByTime(499);
      expect(createdWebSockets).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(3);
    });

    it('notifies connection change with true', () => {
      const onConnectionChange = vi.fn();
      const client = createClient({ onConnectionChange });
      client.connect();
      const ws = getLastWebSocket();

      simulateOpen(ws);

      expect(onConnectionChange).toHaveBeenCalledWith(true);
    });
  });

  describe('onclose', () => {
    it('notifies connection change with false', () => {
      const onConnectionChange = vi.fn();
      const client = createClient({ onConnectionChange });
      client.connect();
      const ws = getLastWebSocket();

      simulateUnexpectedClose(ws);

      expect(onConnectionChange).toHaveBeenCalledWith(false);
    });
  });

  describe('onmessage', () => {
    it('dispatches to onEvent callback', () => {
      const onEvent = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };

      const client = createClient({ onEvent });
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(onEvent).toHaveBeenCalledWith(fakeEvent);
    });

    it('dispatches to typed listeners registered via on()', () => {
      const listener = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };

      const client = createClient();
      client.on('typing:start', listener);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(listener).toHaveBeenCalledWith(fakeEvent);
    });

    it('does not dispatch to listeners for other event types', () => {
      const typingListener = vi.fn();
      const fakeEvent = {
        type: 'message:new' as const,
        timestamp: 123,
        messageId: 'm1',
        conversationId: 'c1',
        senderType: 'user' as const,
      };

      const client = createClient();
      client.on('typing:start', typingListener);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(typingListener).not.toHaveBeenCalled();
    });

    it('ignores invalid frames (unparseable payload)', () => {
      const onEvent = vi.fn();
      const client = createClient({ onEvent });
      client.connect();
      const ws = getLastWebSocket();

      expect(() => {
        ws.dispatchEvent('message', { data: 'not-json' } as MessageEvent);
      }).not.toThrow();
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('marks inbound activity start synchronously and end after a paint-cycle tail', () => {
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 1,
        conversationId: 'c1',
        userId: 'u1',
      };

      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(mockStartProcessing).toHaveBeenCalledTimes(1);
      expect(mockEndProcessing).not.toHaveBeenCalled();

      // The implementation uses two chained rAF calls so the inbound
      // counter outlives the React render the listener triggered. Vitest's
      // frame-advance flushes nested rAFs in one call, so a single
      // advanceTimersToNextFrame() is enough to fire both.
      // runAllTimers drains the nested rAF pair regardless of frame-pacing
      // behavior across vitest/sinon versions.
      vi.runAllTimers();

      expect(mockEndProcessing).toHaveBeenCalledTimes(1);
    });

    it('ends inbound activity after two ticks where requestAnimationFrame is unavailable', () => {
      // Non-browser runtimes (and browsers mid-teardown) have no rAF; the
      // settled-signal tail must still fire via the timer fallback. null,
      // not undefined: the module only checks `typeof !== 'function'`.
      vi.stubGlobal('requestAnimationFrame', null);
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 1,
        conversationId: 'c1',
        userId: 'u1',
      };

      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(mockStartProcessing).toHaveBeenCalledTimes(1);
      expect(mockEndProcessing).not.toHaveBeenCalled();

      vi.runAllTimers();

      expect(mockEndProcessing).toHaveBeenCalledTimes(1);
    });

    it('does not mark inbound activity for malformed frames', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: 'garbage' } as MessageEvent);

      expect(mockStartProcessing).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(mockEndProcessing).not.toHaveBeenCalled();
    });

    it('does not mark inbound activity for the ready signal', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);

      expect(mockStartProcessing).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(mockEndProcessing).not.toHaveBeenCalled();
    });
  });

  describe('on() listener management', () => {
    it('returns unsubscribe function that removes listener', () => {
      const listener = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };

      const client = createClient();
      const unsubscribe = client.on('typing:start', listener);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('supports multiple listeners for the same event type', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };

      const client = createClient();
      client.on('typing:start', listener1);
      client.on('typing:start', listener2);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeAllListeners', () => {
    it('clears all registered listeners', () => {
      const listener = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };

      const client = createClient();
      client.on('typing:start', listener);
      client.connect();
      const ws = getLastWebSocket();

      client.removeAllListeners();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('sends JSON-serialized event', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      const event = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };
      client.send(event);

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify(event));
    });

    it('throws when not connected', () => {
      const client = createClient();
      const event = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };

      expect(() => {
        client.send(event);
      }).toThrow('WebSocket is not connected');
    });

    it('throws when WebSocket is closed', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      ws.readyState = MockWebSocket.CLOSED;

      const event = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };
      expect(() => {
        client.send(event);
      }).toThrow('WebSocket is not connected');
    });
  });

  describe('auto-reconnect', () => {
    it('recovers via the close path, not the error event, when the socket errors', () => {
      const client = createClient({ initialBackoffMs: 1000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      // A browser always follows onerror with onclose; the error alone must
      // not tear anything down or double-schedule a reconnect.
      ws.dispatchEvent('error', {} as Event);
      vi.advanceTimersByTime(5000);
      expect(createdWebSockets).toHaveLength(1);
      expect(client.connected).toBe(true);

      simulateUnexpectedClose(ws);
      vi.advanceTimersByTime(1000);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('schedules reconnect on unexpected close', () => {
      const client = createClient({ initialBackoffMs: 1000 });
      client.connect();
      const ws = getLastWebSocket();

      simulateUnexpectedClose(ws);

      vi.advanceTimersByTime(999);
      expect(createdWebSockets).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('applies exponential backoff', () => {
      const client = createClient({ initialBackoffMs: 100, maxBackoffMs: 10_000 });
      client.connect();

      simulateUnexpectedClose(getLastWebSocket());
      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(2);

      // backoff 200ms (no onopen fired, so backoff stays doubled)
      simulateUnexpectedClose(getLastWebSocket());

      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(2);

      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(3);

      simulateUnexpectedClose(getLastWebSocket());
      vi.advanceTimersByTime(399);
      expect(createdWebSockets).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(4);
    });

    it('caps backoff at maxBackoffMs', () => {
      const client = createClient({ initialBackoffMs: 1000, maxBackoffMs: 4000 });
      client.connect();

      // 1000 -> 2000 -> 4000 -> 4000 (capped)
      for (let index = 0; index < 3; index++) {
        simulateUnexpectedClose(getLastWebSocket());
        const delay = Math.min(1000 * Math.pow(2, index), 4000);
        vi.advanceTimersByTime(delay);
      }
      expect(createdWebSockets).toHaveLength(4);

      simulateUnexpectedClose(getLastWebSocket());

      vi.advanceTimersByTime(3999);
      expect(createdWebSockets).toHaveLength(4);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(5);
    });

    it('does not reconnect after intentional disconnect', () => {
      const client = createClient({ initialBackoffMs: 100 });
      client.connect();

      client.disconnect();

      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(1);
    });
  });

  describe('network-aware reconnection', () => {
    it('does not create WebSocket when offline at connect time', () => {
      mockNetworkStore._setOffline(true);
      const client = createClient();
      client.connect();
      expect(createdWebSockets).toHaveLength(0);
    });

    it('creates WebSocket when network restores after offline connect', () => {
      mockNetworkStore._setOffline(true);
      const client = createClient();
      client.connect();
      expect(createdWebSockets).toHaveLength(0);

      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('cancels pending reconnect timer when network is lost', () => {
      const client = createClient({ initialBackoffMs: 1000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      simulateUnexpectedClose(ws);

      // Going offline should cancel the timer
      mockNetworkStore._setOffline(true);

      vi.advanceTimersByTime(2000);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('reconnects immediately when network restores (skips backoff)', () => {
      const client = createClient({ initialBackoffMs: 5000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);
      simulateUnexpectedClose(ws);

      mockNetworkStore._setOffline(true);

      // Coming back online should reconnect immediately, no waiting.
      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('resets backoff to initial on network restore', () => {
      const client = createClient({ initialBackoffMs: 100, maxBackoffMs: 10_000 });
      client.connect();
      simulateUnexpectedClose(getLastWebSocket()); // backoff=100
      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(2);

      simulateUnexpectedClose(getLastWebSocket()); // backoff=200
      vi.advanceTimersByTime(200);
      expect(createdWebSockets).toHaveLength(3);

      // Going offline then back online resets backoff to initial.
      simulateUnexpectedClose(getLastWebSocket()); // would be backoff=400
      mockNetworkStore._setOffline(true);
      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(4);

      // Initial backoff is 100, not 800
      simulateUnexpectedClose(getLastWebSocket());
      vi.advanceTimersByTime(99);
      expect(createdWebSockets).toHaveLength(4);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(5);
    });

    it('does not reconnect on network restore after intentional disconnect', () => {
      const client = createClient();
      client.connect();
      simulateOpen(getLastWebSocket());

      client.disconnect();

      mockNetworkStore._setOffline(true);
      mockNetworkStore._setOffline(false);

      expect(createdWebSockets).toHaveLength(1);
    });

    it('unsubscribes from network store on disconnect', () => {
      const client = createClient();
      client.connect();
      expect(mockNetworkStore._listenerCount()).toBe(1);

      client.disconnect();
      expect(mockNetworkStore._listenerCount()).toBe(0);

      mockNetworkStore._setOffline(true);
      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('subscribes to the network store once across repeated offline connects', () => {
      mockNetworkStore._setOffline(true);
      const client = createClient();
      client.connect();
      client.connect();

      expect(mockNetworkStore._listenerCount()).toBe(1);
      expect(createdWebSockets).toHaveLength(0);

      // A single subscription means restoration opens exactly one socket.
      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('ignores network store updates that do not flip the offline state', () => {
      const client = createClient();
      client.connect();
      simulateOpen(getLastWebSocket());

      mockNetworkStore._setOffline(false); // still online: neither lost nor restored

      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('does not open a second socket when the network restores while one is alive', () => {
      const client = createClient();
      client.connect();
      simulateOpen(getLastWebSocket());

      // Going offline does not tear down a live socket; restoration must not
      // race a duplicate connection alongside it.
      mockNetworkStore._setOffline(true);
      mockNetworkStore._setOffline(false);

      expect(createdWebSockets).toHaveLength(1);
    });

    it('does not schedule reconnect while offline', () => {
      mockNetworkStore._setOffline(true);
      const client = createClient({ initialBackoffMs: 100 });
      client.connect();

      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(1);

      mockNetworkStore._setOffline(true);

      simulateUnexpectedClose(getLastWebSocket());

      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(1);
    });
  });

  describe('heartbeat', () => {
    function simulateInbound(ws: MockWebSocket): void {
      // Any inbound message counts as proof-of-life. Use the ready signal so
      // the event-dispatch path stays inert (no parseEvent / activity store).
      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);
    }

    function simulatePong(ws: MockWebSocket): void {
      ws.dispatchEvent('message', { data: '{"type":"pong"}' } as MessageEvent);
    }

    it('sends an application-level ping on each heartbeat tick', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      expect(ws.send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000); // first heartbeat tick

      expect(ws.send).toHaveBeenCalledWith('{"type":"ping"}');
    });

    it('resets the pong timeout when a pong arrives, preventing reconnect', () => {
      const client = createClient({
        heartbeatIntervalMs: 30_000,
        pongTimeoutMs: 10_000,
        initialBackoffMs: 1000,
      });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(30_000); // ping sent, pong timeout armed
      vi.advanceTimersByTime(5000); // mid-window
      simulatePong(ws); // runtime auto-response pong clears the timeout
      vi.advanceTimersByTime(5000); // original timeout instant passes

      expect(ws.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('does not surface a pong as a chat or presence event', () => {
      const onEvent = vi.fn();
      const listener = vi.fn();
      const client = createClient({
        onEvent,
        heartbeatIntervalMs: 30_000,
        pongTimeoutMs: 10_000,
      });
      client.on('presence:update', listener);
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      simulatePong(ws);

      expect(onEvent).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(mockStartProcessing).not.toHaveBeenCalled();
    });

    it('force-closes a half-open socket when no inbound arrives before the pong timeout', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      // Half-open: no further inbound messages, and no native close fires.
      // Ping interval elapses, arming the pong timeout.
      vi.advanceTimersByTime(30_000);
      expect(ws.close).not.toHaveBeenCalled();

      // Pong never arrives within the timeout -> socket presumed dead.
      vi.advanceTimersByTime(10_000);
      expect(ws.close).toHaveBeenCalledTimes(1);
    });

    it('reconnects after a half-open socket is force-closed by the heartbeat', () => {
      const client = createClient({
        heartbeatIntervalMs: 30_000,
        pongTimeoutMs: 10_000,
        initialBackoffMs: 1000,
      });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(40_000); // ping interval + pong timeout
      expect(createdWebSockets).toHaveLength(1);

      // Force-close routes through the existing close -> scheduleReconnect path.
      vi.advanceTimersByTime(1000);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('does not churn a healthy socket that keeps receiving inbound messages', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      // Inbound traffic arrives inside every heartbeat window: cross the
      // ping interval, then deliver a message a few seconds later (well
      // before the pong timeout), repeatedly.
      for (let cycle = 0; cycle < 5; cycle++) {
        vi.advanceTimersByTime(31_000); // ping fires (~30s), pong timeout armed
        simulateInbound(ws); // arrives ~1s into the 10s window -> clears it
      }

      expect(ws.close).not.toHaveBeenCalled();
      expect(createdWebSockets).toHaveLength(1);
    });

    it('clears a pending pong timeout when inbound arrives before it expires', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(30_000); // ping fires, pong timeout armed
      vi.advanceTimersByTime(9999); // just before timeout
      simulateInbound(ws); // pong arrives -> clears timeout
      vi.advanceTimersByTime(1); // original timeout instant passes

      expect(ws.close).not.toHaveBeenCalled();
    });

    it('does not extend the pong deadline when a second silent tick fires first', () => {
      // A pong window longer than the ping interval means a silent socket
      // sees a second tick while the first window is still open; that tick
      // must not re-arm (push out) the pending deadline.
      const client = createClient({ heartbeatIntervalMs: 10_000, pongTimeoutMs: 25_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(10_000); // first silent tick arms the window (expires t=35s)
      vi.advanceTimersByTime(10_000); // second silent tick at t=20s
      expect(ws.send).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(14_999); // t=34.999s: original deadline not yet reached
      expect(ws.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // t=35s: the FIRST tick's deadline, not the second's
      expect(ws.close).toHaveBeenCalledWith(4000, 'Heartbeat timeout');
    });

    it('cancels an armed pong deadline on disconnect instead of reconnecting later', () => {
      const client = createClient({
        heartbeatIntervalMs: 10_000,
        pongTimeoutMs: 5000,
        initialBackoffMs: 1000,
      });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(10_000); // ping sent, pong deadline armed
      client.disconnect();

      vi.advanceTimersByTime(60_000); // deadline instant and backoff windows pass
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnect');
      expect(createdWebSockets).toHaveLength(1);
    });

    it('sends no ping on a tick when the socket is no longer open', () => {
      const client = createClient({ heartbeatIntervalMs: 10_000, pongTimeoutMs: 5000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      // Half-open in the other direction: the transport left OPEN without a
      // close event (e.g. mid-teardown), so the tick must not throw a send.
      ws.readyState = MockWebSocket.CLOSING;
      vi.advanceTimersByTime(10_000);

      expect(ws.send).not.toHaveBeenCalled();
      // The tick still arms the deadline, so the dead socket is force-closed.
      vi.advanceTimersByTime(5000);
      expect(ws.close).toHaveBeenCalledWith(4000, 'Heartbeat timeout');
    });

    it('does not run the heartbeat before the socket opens', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();

      // Never opened -> heartbeat must not arm.
      vi.advanceTimersByTime(60_000);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('stops the heartbeat after intentional disconnect', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      client.disconnect();
      ws.close.mockClear();

      // No heartbeat timer should survive teardown.
      vi.advanceTimersByTime(120_000);
      expect(ws.close).not.toHaveBeenCalled();
      expect(createdWebSockets).toHaveLength(1);
    });

    it('stops the heartbeat after the socket closes on its own', () => {
      const client = createClient({
        heartbeatIntervalMs: 30_000,
        pongTimeoutMs: 10_000,
        initialBackoffMs: 1_000_000,
      });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      simulateUnexpectedClose(ws);
      ws.close.mockClear();

      // The closed socket's heartbeat must not fire and re-close it.
      vi.advanceTimersByTime(120_000);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('does not leave heartbeat timers running after teardown', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      simulateOpen(getLastWebSocket());

      client.disconnect();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('run frames', () => {
    function streamFrame(streamId: string, cursor: number, event: unknown): string {
      return JSON.stringify({ type: 'stream', streamId, cursor, event });
    }
    const delta = (content: string): unknown => ({ kind: 'text-delta', index: 0, content });

    it('dispatches stream frames to onRunFrame listeners', () => {
      const client = createClient();
      const frames: unknown[] = [];
      client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);

      expect(frames).toEqual([
        {
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'text-delta', index: 0, content: 'a' },
        },
      ]);
    });

    it('dispatches run-started and run-finished frames', () => {
      const client = createClient();
      const frames: { type: string }[] = [];
      client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: '{"type":"run-started","runId":"r1"}' } as MessageEvent);
      ws.dispatchEvent('message', {
        data: JSON.stringify({
          type: 'run-finished',
          runId: 'r1',
          outcome: { outcome: 'succeeded' },
        }),
      } as MessageEvent);

      expect(frames.map((f) => f.type)).toEqual(['run-started', 'run-finished']);
    });

    it('drops duplicate or stale cursors for a stream (replay overlap)', () => {
      const client = createClient();
      const frames: unknown[] = [];
      client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 2, delta('b')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 2, delta('b')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 3, delta('c')) } as MessageEvent);

      expect(frames).toHaveLength(3);
    });

    it('tracks cursors per stream independently', () => {
      const client = createClient();
      const frames: unknown[] = [];
      client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: streamFrame('s1', 2, delta('a')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s2', 1, delta('b')) } as MessageEvent);

      expect(frames).toHaveLength(2);
    });

    it('sends a resume request on reconnect with per-stream cursors', () => {
      const client = createClient({ initialBackoffMs: 100 });
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s2', 2, delta('b')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);

      expect(ws2.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'resume',
          streams: [
            { streamId: 's1', lastEventId: 4 },
            { streamId: 's2', lastEventId: 2 },
          ],
        })
      );
    });

    it('does not send a resume request when no streams are live', () => {
      const client = createClient({ initialBackoffMs: 100 });
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);

      const resumeSends = ws2.send.mock.calls.filter((c) => String(c[0]).includes('resume'));
      expect(resumeSends).toHaveLength(0);
    });

    it('clears cursors when the run finishes', () => {
      const client = createClient({ initialBackoffMs: 100 });
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);
      ws1.dispatchEvent('message', {
        data: JSON.stringify({
          type: 'run-finished',
          runId: 'r1',
          outcome: { outcome: 'succeeded' },
        }),
      } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);

      const resumeSends = ws2.send.mock.calls.filter((c) => String(c[0]).includes('resume'));
      expect(resumeSends).toHaveLength(0);
    });

    it('drops a stream from resume after stream-gone', () => {
      const client = createClient({ initialBackoffMs: 100 });
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s2', 2, delta('b')) } as MessageEvent);
      ws1.dispatchEvent('message', {
        data: '{"type":"stream-gone","streamId":"s1"}',
      } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);

      expect(ws2.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'resume', streams: [{ streamId: 's2', lastEventId: 2 }] })
      );
    });

    it('unsubscribes run frame listeners', () => {
      const client = createClient();
      const frames: unknown[] = [];
      const unsubscribe = client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      unsubscribe();
      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);

      expect(frames).toHaveLength(0);
    });
  });

  describe('waitForReady', () => {
    it('resolves true immediately when already ready', async () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);

      await expect(client.waitForReady(1000)).resolves.toBe(true);
    });

    it('resolves true when the ready frame arrives before the timeout', async () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      const pending = client.waitForReady(1000);
      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);

      await expect(pending).resolves.toBe(true);
    });

    it('stays pending through non-ready state changes until the ready frame lands', async () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      const pending = client.waitForReady(1000);
      // The open handler notifies state listeners before the server's ready
      // frame arrives; that flip alone must not resolve the wait.
      simulateOpen(ws);
      let settled = false;
      const tracking = (async (): Promise<void> => {
        await pending;
        settled = true;
      })();
      await Promise.resolve();
      expect(settled).toBe(false);

      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);
      await expect(pending).resolves.toBe(true);
      await tracking;
    });

    it('resolves false when the timeout elapses first', async () => {
      const client = createClient();
      client.connect();

      const pending = client.waitForReady(1000);
      vi.advanceTimersByTime(1000);

      await expect(pending).resolves.toBe(false);
    });
  });

  describe('wsPath override and state changes', () => {
    it('uses the provided wsPath verbatim', () => {
      const client = createClient({ wsPath: '/chat/trial/websocket?trialToken=tok-1' });
      client.connect();
      expect(getLastWebSocket().url).toBe(
        'ws://localhost:8787/chat/trial/websocket?trialToken=tok-1'
      );
    });

    it('exposes the conversation id', () => {
      const client = createClient({ conversationId: 'conv-9' });
      expect(client.conversationId).toBe('conv-9');
    });

    it('notifies state-change listeners on open, ready, and close', () => {
      const client = createClient();
      const changes: boolean[] = [];
      client.onStateChange(() => changes.push(client.ready));
      client.connect();
      const ws = getLastWebSocket();

      simulateOpen(ws);
      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);
      simulateUnexpectedClose(ws);

      expect(changes).toEqual([false, true, false]);
    });
  });
});
