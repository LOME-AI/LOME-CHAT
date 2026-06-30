import { describe, it, expect } from 'vitest';
import { fullSessionClaims } from './session-claims.js';
import type { SessionClaims } from '../../../lib/context/index.js';

const claims: SessionClaims = {
  userId: 'user-1',
  sessionId: 'session-1',
  createdAt: 0,
  pending2FA: false,
  pending2FAExpiresAt: 0,
};

describe('fullSessionClaims', () => {
  it('returns the claims of a full principal', () => {
    expect(fullSessionClaims({ kind: 'full', claims })).toBe(claims);
  });

  it('throws for an anonymous principal (authorizer bypass is a defect)', () => {
    expect(() => fullSessionClaims({ kind: 'none' })).toThrow(/full principal/);
  });

  it('throws for a half-authenticated principal', () => {
    expect(() => fullSessionClaims({ kind: 'pending-2fa', claims })).toThrow(/full principal/);
  });
});
