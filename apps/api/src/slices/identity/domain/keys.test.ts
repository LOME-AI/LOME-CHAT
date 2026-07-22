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

  it('locks out login per lowercased identifier at 5 attempts per 15 minutes', () => {
    expect(IDENTITY_KEYS.loginLockout.buildKey('Alice@Example.COM')).toBe(
      'login:lockout:alice@example.com'
    );
    expect(IDENTITY_KEYS.loginLockout.ttlSeconds).toBe(900);
    expect(IDENTITY_KEYS.loginLockout.rateLimitConfig).toEqual({
      maxAttempts: 5,
      windowSeconds: 900,
    });
  });

  it('locks out recovery wrapped-key retrieval per lowercased identifier at 3 attempts per hour', () => {
    expect(IDENTITY_KEYS.recoveryGetKeyLockout.buildKey('Alice@Example.COM')).toBe(
      'recovery:getkey:lockout:alice@example.com'
    );
    expect(IDENTITY_KEYS.recoveryGetKeyLockout.ttlSeconds).toBe(3600);
    expect(IDENTITY_KEYS.recoveryGetKeyLockout.rateLimitConfig).toEqual({
      maxAttempts: 3,
      windowSeconds: 3600,
    });
  });

  it('throttles verification-email resend per lowercased email at 1 per 60 seconds', () => {
    expect(IDENTITY_KEYS.resendVerifyRateLimit.buildKey('Alice@Example.COM')).toBe(
      'resend-verify:email:ratelimit:alice@example.com'
    );
    expect(IDENTITY_KEYS.resendVerifyRateLimit.ttlSeconds).toBe(60);
    expect(IDENTITY_KEYS.resendVerifyRateLimit.rateLimitConfig).toEqual({
      maxAttempts: 1,
      windowSeconds: 60,
    });
  });

  it('throttles email-verification token consume per token at 10 per hour', () => {
    expect(IDENTITY_KEYS.verifyTokenRateLimit.buildKey('tok-1')).toBe(
      'verify:token:ratelimit:tok-1'
    );
    expect(IDENTITY_KEYS.verifyTokenRateLimit.ttlSeconds).toBe(3600);
    expect(IDENTITY_KEYS.verifyTokenRateLimit.rateLimitConfig).toEqual({
      maxAttempts: 10,
      windowSeconds: 3600,
    });
  });

  it('locks out recovery reset per lowercased identifier at 3 attempts per hour', () => {
    expect(IDENTITY_KEYS.recoveryResetLockout.buildKey('Alice@Example.COM')).toBe(
      'recovery:reset:lockout:alice@example.com'
    );
    expect(IDENTITY_KEYS.recoveryResetLockout.ttlSeconds).toBe(3600);
    expect(IDENTITY_KEYS.recoveryResetLockout.rateLimitConfig).toEqual({
      maxAttempts: 3,
      windowSeconds: 3600,
    });
  });

  it('keys billing login tokens by the token itself with the legacy 60-second TTL', () => {
    expect(IDENTITY_KEYS.billingLoginToken.buildKey('token-1')).toBe('billing:login-token:token-1');
    expect(IDENTITY_KEYS.billingLoginToken.ttlSeconds).toBe(60);
  });

  it('gates account-deletion guessing per user, locking on the 3rd failed step-up within an hour', () => {
    expect(IDENTITY_KEYS.deleteAccountLockout.buildKey('u1')).toBe('delete-account:lockout:u1');
    expect(IDENTITY_KEYS.deleteAccountLockout.ttlSeconds).toBe(3600);
    // maxAttempts: 2 — the reserve-before-verify gate admits exactly two before
    // locking the third, reproducing legacy's `count >= 3` (lock on 3rd failure).
    expect(IDENTITY_KEYS.deleteAccountLockout.rateLimitConfig).toEqual({
      maxAttempts: 2,
      windowSeconds: 3600,
    });
  });

  it('holds a separate 24-hour account-deletion hard lock per user', () => {
    expect(IDENTITY_KEYS.deleteAccountHardLock.buildKey('u1')).toBe('delete-account:hard-lock:u1');
    expect(IDENTITY_KEYS.deleteAccountHardLock.ttlSeconds).toBe(86_400);
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
