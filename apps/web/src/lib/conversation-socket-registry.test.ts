import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acquireConversationSocket,
  releaseConversationSocket,
  acquireTrialSocket,
  releaseTrialSocket,
  resetSocketRegistryForTests,
} from '@/lib/conversation-socket-registry.js';

const connectSpy = vi.fn();
const disconnectSpy = vi.fn();
const constructorSpy = vi.fn();

vi.mock('@/lib/ws-client.js', () => ({
  ConversationWebSocket: class {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      constructorSpy(options);
    }
    connect = connectSpy;
    disconnect = disconnectSpy;
  },
}));

describe('conversation socket registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetSocketRegistryForTests();
  });

  it('creates and connects one socket per conversation', () => {
    const a = acquireConversationSocket('c1');
    const b = acquireConversationSocket('c1');
    expect(a).toBe(b);
    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('creates distinct sockets for distinct conversations', () => {
    const a = acquireConversationSocket('c1');
    const b = acquireConversationSocket('c2');
    expect(a).not.toBe(b);
    expect(constructorSpy).toHaveBeenCalledTimes(2);
  });

  it('disconnects only when the last holder releases', () => {
    acquireConversationSocket('c1');
    acquireConversationSocket('c1');
    releaseConversationSocket('c1');
    expect(disconnectSpy).not.toHaveBeenCalled();
    releaseConversationSocket('c1');
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh socket after full release', () => {
    const a = acquireConversationSocket('c1');
    releaseConversationSocket('c1');
    const b = acquireConversationSocket('c1');
    expect(a).not.toBe(b);
  });

  it('ignores release of an unknown conversation', () => {
    expect(() => {
      releaseConversationSocket('nope');
    }).not.toThrow();
  });

  it('builds the trial socket with the trial upgrade path and token', () => {
    acquireTrialSocket('tok-123');
    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        wsPath: '/chat/trial/websocket?trialToken=tok-123',
      })
    );
  });

  it('shares the trial socket per token and releases it', () => {
    const a = acquireTrialSocket('tok-1');
    const b = acquireTrialSocket('tok-1');
    expect(a).toBe(b);
    releaseTrialSocket('tok-1');
    releaseTrialSocket('tok-1');
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps trial and conversation sockets in separate namespaces', () => {
    const trial = acquireTrialSocket('c1');
    const conversation = acquireConversationSocket('c1');
    expect(trial).not.toBe(conversation);
  });
});
