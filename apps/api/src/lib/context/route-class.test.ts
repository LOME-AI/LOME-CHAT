import { describe, it, expect } from 'vitest';
import { ROUTE_CLASSES, authorizeAccess } from './route-class.js';
import type { Principal, SessionClaims } from './principal.js';

const claims: SessionClaims = {
  userId: 'user-1',
  sessionId: 'session-1',
  createdAt: 0,
  pending2FA: false,
  pending2FAExpiresAt: 0,
};

const none: Principal = { kind: 'none' };
const pending: Principal = { kind: 'pending-2fa', claims };
const billingOnly: Principal = { kind: 'billing-only', claims };
const full: Principal = { kind: 'full', claims };
const linkGuest: Principal = { kind: 'link-guest', linkId: 'link-1', conversationId: 'conv-1' };

const DEV = { isProduction: false };
const PROD = { isProduction: true };

const ALLOWED = { allowed: true };
const UNAUTHORIZED = { allowed: false, status: 401, code: 'unauthorized' };
const FORBIDDEN = { allowed: false, status: 403, code: 'forbidden' };
const NOT_FOUND = { allowed: false, status: 404, code: 'not_found' };

describe('ROUTE_CLASSES', () => {
  it('is the closed five-class union', () => {
    expect(ROUTE_CLASSES).toEqual([
      'public',
      'session',
      'pending-2fa',
      'billing-token',
      'dev-only',
    ]);
  });
});

describe('authorizeAccess: default-deny', () => {
  it('denies an undeclared route class for an anonymous caller', () => {
    expect(authorizeAccess(undefined, none, DEV)).toEqual(FORBIDDEN);
  });

  it('denies an undeclared route class even for a full session', () => {
    expect(authorizeAccess(undefined, full, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: public', () => {
  it('allows an anonymous caller', () => {
    expect(authorizeAccess('public', none, DEV)).toEqual(ALLOWED);
  });

  it('allows a pending-2FA session', () => {
    expect(authorizeAccess('public', pending, DEV)).toEqual(ALLOWED);
  });

  it('allows a full session', () => {
    expect(authorizeAccess('public', full, PROD)).toEqual(ALLOWED);
  });
});

describe('authorizeAccess: session', () => {
  it('allows a full session', () => {
    expect(authorizeAccess('session', full, DEV)).toEqual(ALLOWED);
  });

  it('rejects an anonymous caller as unauthorized', () => {
    expect(authorizeAccess('session', none, DEV)).toEqual(UNAUTHORIZED);
  });

  it('rejects a pending-2FA session as forbidden', () => {
    expect(authorizeAccess('session', pending, DEV)).toEqual(FORBIDDEN);
  });

  it('rejects a billing-only session as forbidden', () => {
    expect(authorizeAccess('session', billingOnly, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: pending-2fa', () => {
  it('allows a pending-2FA session', () => {
    expect(authorizeAccess('pending-2fa', pending, DEV)).toEqual(ALLOWED);
  });

  it('allows an anonymous caller (login entry points carry this class)', () => {
    expect(authorizeAccess('pending-2fa', none, DEV)).toEqual(ALLOWED);
  });

  it('allows a full session', () => {
    expect(authorizeAccess('pending-2fa', full, DEV)).toEqual(ALLOWED);
  });

  it('allows a billing-only session (legacy auth surface admits it)', () => {
    expect(authorizeAccess('pending-2fa', billingOnly, DEV)).toEqual(ALLOWED);
  });
});

describe('authorizeAccess: billing-token', () => {
  it('allows a billing-only session', () => {
    expect(authorizeAccess('billing-token', billingOnly, DEV)).toEqual(ALLOWED);
  });

  it('allows a full session', () => {
    expect(authorizeAccess('billing-token', full, DEV)).toEqual(ALLOWED);
  });

  it('rejects an anonymous caller as unauthorized', () => {
    expect(authorizeAccess('billing-token', none, DEV)).toEqual(UNAUTHORIZED);
  });

  it('rejects a pending-2FA session as forbidden', () => {
    expect(authorizeAccess('billing-token', pending, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: link-guest reaches no HTTP route class', () => {
  it('is denied on every declared route class, in and out of production', () => {
    for (const routeClass of ROUTE_CLASSES) {
      expect(authorizeAccess(routeClass, linkGuest, DEV)).toEqual(FORBIDDEN);
      expect(authorizeAccess(routeClass, linkGuest, PROD)).toEqual(FORBIDDEN);
    }
  });

  it('is denied on an undeclared route class', () => {
    expect(authorizeAccess(undefined, linkGuest, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: trial-session reaches no HTTP route class', () => {
  const trialSession: Principal = { kind: 'trial-session', sessionId: 'session-1' };

  it('is denied on every declared route class, in and out of production', () => {
    for (const routeClass of ROUTE_CLASSES) {
      expect(authorizeAccess(routeClass, trialSession, DEV)).toEqual(FORBIDDEN);
      expect(authorizeAccess(routeClass, trialSession, PROD)).toEqual(FORBIDDEN);
    }
  });

  it('is denied on an undeclared route class', () => {
    expect(authorizeAccess(undefined, trialSession, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: dev-only', () => {
  it('allows an anonymous caller outside production', () => {
    expect(authorizeAccess('dev-only', none, DEV)).toEqual(ALLOWED);
  });

  it('allows a pending-2FA session outside production', () => {
    expect(authorizeAccess('dev-only', pending, DEV)).toEqual(ALLOWED);
  });

  it('answers not_found in production even for a full session', () => {
    expect(authorizeAccess('dev-only', full, PROD)).toEqual(NOT_FOUND);
  });
});
