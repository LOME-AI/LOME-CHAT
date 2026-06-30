import { describe, it, expect, vi } from 'vitest';
import { createEvent, type RealtimeEvent } from '@hushbox/realtime/events';
import {
  broadcastToRoom,
  broadcastFireAndForget,
  getActiveConversationUserIds,
} from './broadcast.js';
import type { Bindings } from '../types.js';

function createMockEvent(): RealtimeEvent {
  return createEvent('message:new', {
    messageId: 'msg-123',
    conversationId: 'conv-456',
    senderType: 'user',
    senderId: 'user-789',
  });
}

interface MockStub {
  fetch: ReturnType<typeof vi.fn>;
}

interface MockNamespace {
  idFromName: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function createMockDONamespace(sentCount: number): {
  namespace: MockNamespace;
  stub: MockStub;
  id: object;
} {
  const id = { toString: () => 'mock-do-id' };
  const stub: MockStub = {
    fetch: vi.fn().mockResolvedValue(Response.json({ sent: sentCount })),
  };
  const namespace: MockNamespace = {
    idFromName: vi.fn().mockReturnValue(id),
    get: vi.fn().mockReturnValue(stub),
  };

  return { namespace, stub, id };
}

describe('broadcastToRoom', () => {
  it('returns { sent: 0 } when CONVERSATION_ROOM binding is unavailable', async () => {
    const env = {} as Bindings;
    const event = createMockEvent();

    const result = await broadcastToRoom(env, 'conv-456', event);

    expect(result).toEqual({ sent: 0 });
  });

  it('calls idFromName with conversationId', async () => {
    const { namespace } = createMockDONamespace(3);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    await broadcastToRoom(env, 'conv-456', event);

    expect(namespace.idFromName).toHaveBeenCalledWith('conv-456');
  });

  it('calls stub.fetch with POST /broadcast and JSON body', async () => {
    const { namespace, stub, id } = createMockDONamespace(2);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    await broadcastToRoom(env, 'conv-456', event);

    expect(namespace.get).toHaveBeenCalledWith(id);
    expect(stub.fetch).toHaveBeenCalledOnce();

    const fetchCall = stub.fetch.mock.calls[0] as [Request];
    const request = fetchCall[0];
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/broadcast');

    const body: unknown = await request.json();
    expect(body).toMatchObject({
      type: 'message:new',
      messageId: 'msg-123',
      conversationId: 'conv-456',
      senderType: 'user',
      senderId: 'user-789',
    });
  });

  it('returns sent count from DO response', async () => {
    const { namespace } = createMockDONamespace(5);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    const result = await broadcastToRoom(env, 'conv-456', event);

    expect(result).toEqual({ sent: 5 });
  });

  it('propagates errors from DO fetch', async () => {
    const id = { toString: () => 'mock-do-id' };
    const stub: MockStub = {
      fetch: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    };
    const namespace: MockNamespace = {
      idFromName: vi.fn().mockReturnValue(id),
      get: vi.fn().mockReturnValue(stub),
    };
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    await expect(broadcastToRoom(env, 'conv-456', event)).rejects.toThrow('DO unavailable');
  });
});

describe('broadcastFireAndForget', () => {
  it('does not throw when broadcast succeeds', () => {
    const { namespace } = createMockDONamespace(2);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    expect(() => {
      broadcastFireAndForget(env, 'conv-456', event);
    }).not.toThrow();
  });

  it('does not log when broadcast succeeds', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { namespace } = createMockDONamespace(2);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    broadcastFireAndForget(env, 'conv-456', event);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('logs error when broadcast fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub: MockStub = {
      fetch: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    };
    const namespace: MockNamespace = {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'id' }),
      get: vi.fn().mockReturnValue(stub),
    };
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    broadcastFireAndForget(env, 'conv-456', event);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      '[fire-and-forget] broadcast message:new to conv-456:',
      expect.any(Error)
    );
    spy.mockRestore();
  });

  it('calls waitUntil when executionCtx provided', () => {
    const waitUntil = vi.fn();
    const { namespace } = createMockDONamespace(1);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    broadcastFireAndForget(env, 'conv-456', event, { waitUntil });

    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it('no-ops when env has no CONVERSATION_ROOM', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {} as Bindings;
    const event = createMockEvent();

    expect(() => {
      broadcastFireAndForget(env, 'conv-456', event);
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

function createPresenceDONamespace(userIds: string[] | { status: number }): {
  namespace: MockNamespace;
  stub: MockStub;
} {
  const id = { toString: () => 'mock-do-id' };
  const responseInit = 'status' in userIds ? { status: userIds.status } : { status: 200 };
  const responseBody = 'status' in userIds ? '' : JSON.stringify({ userIds });
  const stub: MockStub = {
    fetch: vi.fn().mockResolvedValue(new Response(responseBody, responseInit)),
  };
  const namespace: MockNamespace = {
    idFromName: vi.fn().mockReturnValue(id),
    get: vi.fn().mockReturnValue(stub),
  };
  return { namespace, stub };
}

describe('getActiveConversationUserIds', () => {
  it('returns an empty set when CONVERSATION_ROOM binding is unavailable', async () => {
    const env = {} as Bindings;

    const result = await getActiveConversationUserIds(env, 'conv-1');

    expect(result).toEqual(new Set());
  });

  it('returns the set of userIds reported by the DO', async () => {
    const { namespace } = createPresenceDONamespace(['user-1', 'user-2', 'user-3']);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;

    const result = await getActiveConversationUserIds(env, 'conv-1');

    expect(result).toEqual(new Set(['user-1', 'user-2', 'user-3']));
  });

  it('calls GET /presence on the DO stub', async () => {
    const { namespace, stub } = createPresenceDONamespace(['user-1']);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;

    await getActiveConversationUserIds(env, 'conv-1');

    expect(namespace.idFromName).toHaveBeenCalledWith('conv-1');
    expect(stub.fetch).toHaveBeenCalledOnce();
    const fetchCall = stub.fetch.mock.calls[0] as [Request];
    const request = fetchCall[0];
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe('/presence');
  });

  it('returns an empty set when the DO returns a non-OK status', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { namespace } = createPresenceDONamespace({ status: 500 });
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;

    const result = await getActiveConversationUserIds(env, 'conv-1');

    expect(result).toEqual(new Set());
    spy.mockRestore();
  });

  it('returns an empty set when the DO fetch rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub: MockStub = {
      fetch: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    };
    const namespace: MockNamespace = {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'id' }),
      get: vi.fn().mockReturnValue(stub),
    };
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;

    const result = await getActiveConversationUserIds(env, 'conv-1');

    expect(result).toEqual(new Set());
    spy.mockRestore();
  });
});
