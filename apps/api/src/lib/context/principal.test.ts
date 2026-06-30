import { describe, it, expect } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  parseSessionClaims,
  derivePrincipal,
  sessionCookieOptions,
} from './principal.js';
import type { SessionClaims } from './principal.js';

const NOW = 1_700_000_000_000;

function validClaims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    userId: 'user-1',
    sessionId: 'session-1',
    createdAt: NOW - 1000,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    ...overrides,
  };
}

describe('parseSessionClaims', () => {
  it('returns claims for a valid session object', () => {
    expect(parseSessionClaims(validClaims())).toEqual(validClaims());
  });

  it('strips unknown fields sealed by the legacy session writer', () => {
    const legacyShaped = {
      ...validClaims(),
      email: 'a@b.c',
      username: 'alice',
      emailVerified: true,
      totpEnabled: false,
      hasAcknowledgedPhrase: true,
    };
    expect(parseSessionClaims(legacyShaped)).toEqual(validClaims());
  });

  it('preserves billingOnly when present', () => {
    const parsed = parseSessionClaims({ ...validClaims(), billingOnly: true });
    expect(parsed?.billingOnly).toBe(true);
  });

  it('returns null for a non-object value', () => {
    expect(parseSessionClaims('not-a-session')).toBeNull();
  });

  it('returns null when userId is missing', () => {
    const incomplete: Record<string, unknown> = { ...validClaims() };
    delete incomplete['userId'];
    expect(parseSessionClaims(incomplete)).toBeNull();
  });

  it('returns null when userId is empty', () => {
    expect(parseSessionClaims(validClaims({ userId: '' }))).toBeNull();
  });

  it('returns null when pending2FA is not a boolean', () => {
    expect(parseSessionClaims({ ...validClaims(), pending2FA: 'yes' })).toBeNull();
  });
});

describe('derivePrincipal', () => {
  it('returns none when no claims exist', () => {
    expect(derivePrincipal(null, NOW)).toEqual({ kind: 'none' });
  });

  it('returns full for a valid non-pending session', () => {
    const claims = validClaims();
    expect(derivePrincipal(claims, NOW)).toEqual({ kind: 'full', claims });
  });

  it('returns pending-2fa for an unexpired mid-2FA session', () => {
    const claims = validClaims({ pending2FA: true, pending2FAExpiresAt: NOW + 60_000 });
    expect(derivePrincipal(claims, NOW)).toEqual({ kind: 'pending-2fa', claims });
  });

  it('returns none for an expired mid-2FA session', () => {
    const claims = validClaims({ pending2FA: true, pending2FAExpiresAt: NOW - 1 });
    expect(derivePrincipal(claims, NOW)).toEqual({ kind: 'none' });
  });

  it('returns billing-only for a billing-restricted session', () => {
    const claims = validClaims({ billingOnly: true });
    expect(derivePrincipal(claims, NOW)).toEqual({ kind: 'billing-only', claims });
  });

  it('treats a pending-2FA billing session as pending-2fa (2FA gates first)', () => {
    const claims = validClaims({
      pending2FA: true,
      pending2FAExpiresAt: NOW + 60_000,
      billingOnly: true,
    });
    expect(derivePrincipal(claims, NOW)).toEqual({ kind: 'pending-2fa', claims });
  });
});

describe('sessionCookieOptions', () => {
  it('keeps the pre-rewrite cookie name and 30-day max age', () => {
    expect(SESSION_COOKIE_NAME).toBe('hushbox_session');
    expect(SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 30);
  });

  it('builds hardened production cookie options', () => {
    expect(sessionCookieOptions('secret-at-least-32-characters-long!!', true)).toEqual({
      password: 'secret-at-least-32-characters-long!!',
      cookieName: SESSION_COOKIE_NAME,
      cookieOptions: {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: SESSION_MAX_AGE_SECONDS,
      },
    });
  });

  it('relaxes secure and sameSite outside production (local http dev)', () => {
    const options = sessionCookieOptions('secret-at-least-32-characters-long!!', false);
    expect(options.cookieOptions).toMatchObject({ secure: false, sameSite: 'lax' });
  });
});
