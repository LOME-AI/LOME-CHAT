import { describe, expect, it } from 'vitest';
import { buildPresenceEvent, connectedUserIds } from './presence.js';
import type { SocketAttachment } from './protocol.js';

function member(principalId: string, overrides: Partial<SocketAttachment> = {}): SocketAttachment {
  return {
    principalId,
    conversationId: 'c1',
    isGuest: false,
    connectedAt: 100,
    ...overrides,
  };
}

describe('buildPresenceEvent', () => {
  it('emits the real conversationId', () => {
    const event = buildPresenceEvent('c1', [member('u1')], 500);
    expect(event.conversationId).toBe('c1');
  });

  it('throws on an empty conversationId', () => {
    expect(() => buildPresenceEvent('', [member('u1')], 500)).toThrow(/conversationId/);
  });

  it('stamps the event with the provided clock value', () => {
    const event = buildPresenceEvent('c1', [], 500);
    expect(event.timestamp).toBe(500);
  });

  it('maps an authenticated principal to a userId member', () => {
    const event = buildPresenceEvent('c1', [member('u1', { displayName: 'Alice' })], 500);
    expect(event.members).toEqual([
      { userId: 'u1', displayName: 'Alice', isGuest: false, connectedAt: 100 },
    ]);
  });

  it('omits userId for guests while keeping their display name', () => {
    const event = buildPresenceEvent(
      'c1',
      [member('link-1', { isGuest: true, displayName: 'Guest' })],
      500
    );
    expect(event.members).toEqual([{ displayName: 'Guest', isGuest: true, connectedAt: 100 }]);
  });

  it('lists one member per connection', () => {
    const event = buildPresenceEvent('c1', [member('u1'), member('u1', { connectedAt: 200 })], 500);
    expect(event.members).toHaveLength(2);
  });
});

describe('connectedUserIds', () => {
  it('dedupes principals with multiple sockets', () => {
    expect(connectedUserIds([member('u1'), member('u1')])).toEqual(['u1']);
  });

  it('omits guests', () => {
    expect(connectedUserIds([member('u1'), member('link-1', { isGuest: true })])).toEqual(['u1']);
  });
});
