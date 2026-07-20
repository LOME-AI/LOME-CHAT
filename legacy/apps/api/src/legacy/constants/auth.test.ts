import { describe, it, expect } from 'vitest';
import { EMAIL_VERIFY_TOKEN_EXPIRY_MS } from './auth.js';

describe('auth constants', () => {
  describe('EMAIL_VERIFY_TOKEN_EXPIRY_MS', () => {
    it('should equal 24 hours in milliseconds', () => {
      expect(EMAIL_VERIFY_TOKEN_EXPIRY_MS).toBe(86_400_000);
    });

    it('should equal 24 * 60 * 60 * 1000', () => {
      expect(EMAIL_VERIFY_TOKEN_EXPIRY_MS).toBe(24 * 60 * 60 * 1000);
    });
  });
});
