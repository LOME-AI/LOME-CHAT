import { describe, expect, it } from 'vitest';
import { createRealtimeBroadcast } from './realtime-do.js';
import type { RunStartBody } from '@hushbox/realtime';

interface RecordedCall {
  conversationName: string;
  url: string;
  method: string;
  body: unknown;
}

function fakeNamespace(respond: (call: RecordedCall) => Response | Promise<Response>): {
  namespace: DurableObjectNamespace;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit): Promise<Response> => {
        const call: RecordedCall = {
          conversationName: id.name,
          url,
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        return respond(call);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, calls };
}

const event = {
  type: 'rotation:complete',
  timestamp: 1,
  conversationId: 'c1',
  newEpochNumber: 2,
} as const;

function runBody(): RunStartBody {
  return {
    runKey: 'key-1',
    definition: {
      version: 1,
      deadlineClass: 'text',
      hooks: { admission: 'chat-admission', settlement: 'chat-settlement' },
      nodes: [],
      edges: [],
    } as unknown as RunStartBody['definition'],
    inputs: {},
  };
}

describe('broadcast', () => {
  it('posts the event to the conversation room and returns the receipt', async () => {
    const { namespace, calls } = fakeNamespace(() =>
      Response.json({ delivered: 2, paused: 0, evicted: 1 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.broadcast('c1', event);
    expect(result._unsafeUnwrap()).toEqual({ delivered: 2, paused: 0, evicted: 1 });
    expect(calls[0]).toMatchObject({
      conversationName: 'c1',
      method: 'POST',
      body: event,
    });
    expect(calls[0]?.url).toContain('/broadcast');
  });

  it('maps a network failure to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => {
      throw new Error('socket hang up');
    });
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.broadcast('c1', event);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a non-ok response to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ code: 'VALIDATION' }, { status: 400 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.broadcast('c1', event);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a malformed response body to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => Response.json({ delivered: 'lots' }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.broadcast('c1', event);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('evict', () => {
  it('posts the principal and resolves the closed count', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ closed: 2 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.evict('c1', 'u1');
    expect(result._unsafeUnwrap()).toBe(2);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { principalId: 'u1' } });
    expect(calls[0]?.url).toContain('/evict');
  });
});

describe('presence', () => {
  it('resolves the connected user ids', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ userIds: ['u1', 'u2'] }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.presence('c1');
    expect(result._unsafeUnwrap()).toEqual(['u1', 'u2']);
    expect(calls[0]).toMatchObject({ method: 'GET' });
    expect(calls[0]?.url).toContain('/presence');
  });
});

describe('startRun', () => {
  it('resolves the started outcome on a created run', async () => {
    const { namespace, calls } = fakeNamespace(() =>
      Response.json({ runId: 'run-1', deadlineAt: 310_000 }, { status: 201 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({ started: true, runId: 'run-1', deadlineAt: 310_000 });
    expect(calls[0]).toMatchObject({ method: 'POST', body: runBody() });
    expect(calls[0]?.url).toContain('/run/start');
  });

  it('resolves the typed concurrent outcome on a 409', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ code: 'CONCURRENT_RUN' }, { status: 409 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({ started: false, code: 'CONCURRENT_RUN' });
  });

  it('maps a 409 without the concurrent code to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => Response.json({ code: 'OTHER' }, { status: 409 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps an unexpected status to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ code: 'VALIDATION' }, { status: 400 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('stopRun', () => {
  it('posts the user stop and resolves whether a run was stopped', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ stopped: true }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.stopRun('c1');
    expect(result._unsafeUnwrap()).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { reason: 'user-stop' } });
    expect(calls[0]?.url).toContain('/run/stop');
  });
});

describe('addressing', () => {
  it('addresses the room by the conversation id', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ userIds: [] }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.presence('conversation-42');
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.conversationName).toBe('conversation-42');
  });
});
