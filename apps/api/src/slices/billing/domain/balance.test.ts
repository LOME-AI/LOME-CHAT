import { describe, expect, it } from 'vitest';
import { callerUserId } from './balance.js';
import type { Principal, SessionClaims } from '../../../lib/context/index.js';

const claims: SessionClaims = {
  userId: 'user-42',
  sessionId: 'session-1',
  createdAt: 1000,
  pending2FA: false,
  pending2FAExpiresAt: 0,
};

describe('callerUserId', () => {
  it('returns the session userId for a full principal', () => {
    const principal: Principal = { kind: 'full', claims };
    expect(callerUserId(principal)).toBe('user-42');
  });

  it('throws for a principal without a full session', () => {
    const principal: Principal = { kind: 'none' };
    expect(() => callerUserId(principal)).toThrow(/full principal/);
  });
});
