import { describe, it, expect } from 'vitest';
import { getSessionOptions, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from './session.js';

describe('session', () => {
  const testSecret = 'test-secret-at-least-32-characters-long';

  describe('SESSION_COOKIE_NAME', () => {
    it('is hushbox_session', () => {
      expect(SESSION_COOKIE_NAME).toBe('hushbox_session');
    });
  });

  describe('SESSION_MAX_AGE_SECONDS', () => {
    it('is 30 days', () => {
      const thirtyDays = 60 * 60 * 24 * 30;
      expect(SESSION_MAX_AGE_SECONDS).toBe(thirtyDays);
    });
  });

  describe('getSessionOptions', () => {
    it('returns options with the provided password', () => {
      const options = getSessionOptions(testSecret, false);

      expect(options.password).toBe(testSecret);
    });

    it('uses the correct cookie name', () => {
      const options = getSessionOptions(testSecret, false);

      expect(options.cookieName).toBe(SESSION_COOKIE_NAME);
    });

    it('sets httpOnly to true', () => {
      const options = getSessionOptions(testSecret, false);

      expect(options.cookieOptions?.['httpOnly']).toBe(true);
    });

    it('sets sameSite to lax in development', () => {
      const options = getSessionOptions(testSecret, false);

      expect(options.cookieOptions?.['sameSite']).toBe('lax');
    });

    it('sets sameSite to none in production for Capacitor WebView compatibility', () => {
      const options = getSessionOptions(testSecret, true);

      expect(options.cookieOptions?.['sameSite']).toBe('none');
    });

    it('sets secure to false in development', () => {
      const options = getSessionOptions(testSecret, false);

      expect(options.cookieOptions?.['secure']).toBe(false);
    });

    it('sets secure to true in production', () => {
      const options = getSessionOptions(testSecret, true);

      expect(options.cookieOptions?.['secure']).toBe(true);
    });

    it('sets maxAge to SESSION_MAX_AGE_SECONDS', () => {
      const options = getSessionOptions(testSecret, false);

      expect(options.cookieOptions?.['maxAge']).toBe(SESSION_MAX_AGE_SECONDS);
    });
  });
});
