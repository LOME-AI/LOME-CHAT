import { describe, expect, it } from 'vitest';
import { SESSION_MAX_AGE_SECONDS } from '../../../lib/context/index.js';
import { IDENTITY_KEYS } from './keys.js';

describe('IDENTITY_KEYS', () => {
  it('keys pending registrations by the server-issued handshake id with a 5-minute TTL', () => {
    expect(IDENTITY_KEYS.opaquePendingRegistration.buildKey('handshake-1')).toBe(
      'opaque:pending:handshake-1'
    );
    expect(IDENTITY_KEYS.opaquePendingRegistration.ttlSeconds).toBe(300);
  });

  it('keys pending logins by the server-issued handshake id with a 2-minute TTL', () => {
    expect(IDENTITY_KEYS.opaquePendingLogin.buildKey('handshake-2')).toBe(
      'opaque:login:handshake-2'
    );
    expect(IDENTITY_KEYS.opaquePendingLogin.ttlSeconds).toBe(120);
  });

  it('tracks active sessions per user and session for the cookie lifetime', () => {
    expect(IDENTITY_KEYS.sessionActive.buildKey('u1', 's1')).toBe('sessions:user:active:u1:s1');
    expect(IDENTITY_KEYS.sessionActive.ttlSeconds).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it('tracks the password-changed-at watermark per user for the cookie lifetime', () => {
    expect(IDENTITY_KEYS.passwordChangedAt.buildKey('u1')).toBe('auth:pw-changed:u1');
    expect(IDENTITY_KEYS.passwordChangedAt.ttlSeconds).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it('rate-limits login per lowercased identifier at 5 attempts per 15 minutes', () => {
    expect(IDENTITY_KEYS.loginRateLimit.buildKey('Alice@Example.COM')).toBe(
      'login:user:ratelimit:alice@example.com'
    );
    expect(IDENTITY_KEYS.loginRateLimit.ttlSeconds).toBe(900);
    expect(IDENTITY_KEYS.loginRateLimit.rateLimitConfig).toEqual({
      maxAttempts: 5,
      windowSeconds: 900,
    });
  });

  it('keys billing login tokens by the token itself with the legacy 60-second TTL', () => {
    expect(IDENTITY_KEYS.billingLoginToken.buildKey('token-1')).toBe('billing:login-token:token-1');
    expect(IDENTITY_KEYS.billingLoginToken.ttlSeconds).toBe(60);
  });

  it('rate-limits registration per lowercased email at 3 attempts per hour', () => {
    expect(IDENTITY_KEYS.registerRateLimit.buildKey('New@Example.COM')).toBe(
      'register:email:ratelimit:new@example.com'
    );
    expect(IDENTITY_KEYS.registerRateLimit.ttlSeconds).toBe(3600);
    expect(IDENTITY_KEYS.registerRateLimit.rateLimitConfig).toEqual({
      maxAttempts: 3,
      windowSeconds: 3600,
    });
  });
});
