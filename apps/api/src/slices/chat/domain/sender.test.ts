import { describe, expect, it } from 'vitest';
import { senderCaller, senderPrincipalId } from './sender.js';
import type { SenderPrincipal } from '@hushbox/shared';

// The resolved run principals carry a memberId; the helpers accept them (and the
// narrower route-time `TurnSender`) structurally.
const USER: SenderPrincipal = { kind: 'user', userId: 'u1', memberId: 'm1' };
const GUEST: SenderPrincipal = { kind: 'linkGuest', linkId: 'l1', memberId: 'm1' };

describe('senderPrincipalId', () => {
  it('yields a user sender its userId', () => {
    expect(senderPrincipalId(USER)).toBe('u1');
  });

  it('yields a link-guest sender its linkId', () => {
    expect(senderPrincipalId(GUEST)).toBe('l1');
  });
});

describe('senderCaller', () => {
  it('maps a user sender to a user caller', () => {
    expect(senderCaller({ kind: 'user', userId: 'u1' }, 'c1')).toEqual({
      kind: 'user',
      userId: 'u1',
    });
  });

  it('maps a link-guest sender to a guest caller carrying the conversation it acts in', () => {
    expect(senderCaller({ kind: 'linkGuest', linkId: 'l1' }, 'c1')).toEqual({
      kind: 'linkGuest',
      linkId: 'l1',
      conversationId: 'c1',
    });
  });
});
