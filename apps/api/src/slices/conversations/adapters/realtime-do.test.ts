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
    mode: 'paid',
    runKey: 'key-1',
    bodyHash: 'body-hash-1',
    definition: {
      version: 1,
      deadlineClass: 'text',
      hooks: { admission: 'chat-admission', settlement: 'chat-settlement' },
      nodes: [],
      edges: [],
    } as unknown as RunStartBody['definition'],
    inputs: {},
    userId: 'u1',
    senderId: 'u1',
    walletId: 'w1',
    epochNumber: 1,
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

  it('resolves the referee body-mismatch conflict on a 409', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ code: 'IDEMPOTENCY_BODY_MISMATCH' }, { status: 409 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({ started: false, code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });

  it('resolves the replay outcome with the stored response on a 200', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ outcome: 'replay', response: { runId: 'settled' } }, { status: 200 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'replay', response: { runId: 'settled' } });
  });

  it('resolves the attach outcome on a 200', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ outcome: 'attach' }, { status: 200 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'attach' });
  });

  it('maps a malformed 200 body to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => Response.json({ outcome: 'nope' }, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
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

describe('upgrade', () => {
  // The DO's real answer is a `101` with the client socket; undici's Response
  // constructor rejects sub-200 statuses, so a `200` sentinel stands in here —
  // the adapter passes the response through untouched regardless of status, and
  // the real `101` round-trip is proven in the workerd validation suite.
  it('forwards the principal as DO query params and returns the response', async () => {
    const proxied = new Response('proxied', { status: 200 });
    const { namespace, calls } = fakeNamespace(() => proxied);
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'u1', isGuest: false },
      new Headers({ Upgrade: 'websocket' })
    );
    expect(result._unsafeUnwrap()).toBe(proxied);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/websocket');
    expect(calls[0]?.url).toContain('principalId=u1');
    expect(calls[0]?.url).toContain('conversationId=c1');
    expect(calls[0]?.url).toContain('isGuest=false');
  });

  it('forwards a guest display name', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response(null, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'link-1', isGuest: true, displayName: 'Guest' },
      new Headers()
    );
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.url).toContain('isGuest=true');
    expect(calls[0]?.url).toContain('displayName=Guest');
  });

  it('maps a transport failure to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => {
      throw new Error('socket hang up');
    });
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'u1', isGuest: false },
      new Headers()
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
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
