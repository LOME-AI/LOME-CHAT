import { describe, expect, it } from 'vitest';
import { createConversationRoomRealtime } from './realtime-broadcast.js';

interface FetchedCall {
  readonly name: string;
  readonly url: string;
}

function fakeNamespace(calls: FetchedCall[]): DurableObjectNamespace {
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: (url: string) => {
        calls.push({ name: id, url });
        return Promise.resolve(Response.json({ closed: 1 }));
      },
    }),
  };
  return namespace as unknown as DurableObjectNamespace;
}

describe('createConversationRoomRealtime', () => {
  it('fails fast when the CONVERSATION_ROOM binding is missing', () => {
    expect(() => createConversationRoomRealtime({})).toThrow(/CONVERSATION_ROOM/);
  });

  it('routes room calls through the bound namespace', async () => {
    const calls: FetchedCall[] = [];
    const realtime = createConversationRoomRealtime({ CONVERSATION_ROOM: fakeNamespace(calls) });
    const result = await realtime.evict('conversation-1', 'principal-1');
    expect(result.isOk() && result.value).toBe(1);
    expect(calls).toEqual([{ name: 'conversation-1', url: 'https://conversation-room/evict' }]);
  });
});
