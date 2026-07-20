import { describe, it, expect } from 'vitest';
import { getPushClient } from './factory.js';

const TEST_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'test@test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
});

describe('getPushClient', () => {
  describe('in local development', () => {
    it('returns console client when NODE_ENV is development', () => {
      const client = getPushClient({ NODE_ENV: 'development' });
      expect(client).toBeDefined();
      expect(client).toHaveProperty('send');
    });

    it('returns console client when NODE_ENV is undefined', () => {
      const client = getPushClient({});
      expect(client).toBeDefined();
    });

    it('returns console client even if FCM credentials provided in local dev', () => {
      const client = getPushClient({
        NODE_ENV: 'development',
        FCM_PROJECT_ID: 'test-project',
        FCM_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
      });
      expect(client).toBeDefined();
    });
  });

  describe('in CI', () => {
    it('returns console client (no real push in CI)', () => {
      const client = getPushClient({
        NODE_ENV: 'development',
        CI: 'true',
      });
      expect(client).toBeDefined();
    });

    it('returns console client in CI E2E mode', () => {
      const client = getPushClient({
        NODE_ENV: 'development',
        CI: 'true',
        E2E: 'true',
      });
      expect(client).toBeDefined();
    });
  });

  describe('in production', () => {
    it('throws if FCM_PROJECT_ID is missing', () => {
      expect(() =>
        getPushClient({
          NODE_ENV: 'production',
          FCM_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
        })
      ).toThrow('FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON required in production');
    });

    it('throws if FCM_SERVICE_ACCOUNT_JSON is missing', () => {
      expect(() =>
        getPushClient({
          NODE_ENV: 'production',
          FCM_PROJECT_ID: 'test-project',
        })
      ).toThrow('FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON required in production');
    });

    it('returns real client when credentials are provided', () => {
      const client = getPushClient({
        NODE_ENV: 'production',
        FCM_PROJECT_ID: 'test-project',
        FCM_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
      });
      expect(client).toBeDefined();
      expect(client).toHaveProperty('send');
    });
  });
});
