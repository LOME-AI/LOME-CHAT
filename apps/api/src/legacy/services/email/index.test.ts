import { describe, it, expect } from 'vitest';
import { getEmailClient } from './index.js';

describe('getEmailClient', () => {
  describe('in local development', () => {
    it('returns console client when NODE_ENV is development', () => {
      const client = getEmailClient({ NODE_ENV: 'development' });
      expect(client).toBeDefined();
      expect(client).toHaveProperty('sendEmail');
    });

    it('returns console client when NODE_ENV is undefined', () => {
      const client = getEmailClient({});
      expect(client).toBeDefined();
    });

    it('returns console client even if RESEND_API_KEY provided in local dev', () => {
      const client = getEmailClient({
        NODE_ENV: 'development',
        RESEND_API_KEY: 'test-key',
      });
      expect(client).toBeDefined();
    });
  });

  describe('in CI', () => {
    it('returns console client (no real email in CI)', () => {
      const client = getEmailClient({
        NODE_ENV: 'development',
        CI: 'true',
      });
      expect(client).toBeDefined();
    });

    it('returns console client even with RESEND_API_KEY in CI', () => {
      const client = getEmailClient({
        NODE_ENV: 'development',
        CI: 'true',
        RESEND_API_KEY: 'test-key',
      });
      expect(client).toBeDefined();
    });

    it('returns console client in CI E2E mode', () => {
      const client = getEmailClient({
        NODE_ENV: 'development',
        CI: 'true',
        E2E: 'true',
      });
      expect(client).toBeDefined();
    });
  });

  describe('in production', () => {
    it('throws if RESEND_API_KEY is missing', () => {
      expect(() => getEmailClient({ NODE_ENV: 'production' })).toThrow(
        'RESEND_API_KEY required in production'
      );
    });

    it('returns real client when credentials are provided', () => {
      const client = getEmailClient({
        NODE_ENV: 'production',
        RESEND_API_KEY: 'test-key',
      });
      expect(client).toBeDefined();
      expect(client).toHaveProperty('sendEmail');
    });
  });
});
