import { describe, it, expect, vi } from 'vitest';
import { getHelcimClient } from './index.js';
import * as mockModule from './mock.js';

describe('getHelcimClient', () => {
  describe('in local development', () => {
    it('returns mock client with webhook config', () => {
      const client = getHelcimClient({
        NODE_ENV: 'development',
        API_URL: 'http://localhost:8787',
        HELCIM_WEBHOOK_VERIFIER: 'mock-verifier',
      });
      expect(client.isMock).toBe(true);
    });

    it('throws if API_URL is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'development',
          HELCIM_WEBHOOK_VERIFIER: 'verifier',
        })
      ).toThrow('API_URL and HELCIM_WEBHOOK_VERIFIER required for local dev');
    });

    it('throws if HELCIM_WEBHOOK_VERIFIER is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'development',
          API_URL: 'http://localhost:8787',
        })
      ).toThrow('API_URL and HELCIM_WEBHOOK_VERIFIER required for local dev');
    });

    it('returns mock client even if API credentials are provided in local dev', () => {
      const client = getHelcimClient({
        NODE_ENV: 'development',
        API_URL: 'http://localhost:8787',
        HELCIM_API_TOKEN: 'token',
        HELCIM_WEBHOOK_VERIFIER: 'verifier',
      });
      expect(client.isMock).toBe(true);
    });

    it('passes webhook config to mock client', () => {
      const createMockSpy = vi.spyOn(mockModule, 'createMockHelcimClient');

      getHelcimClient({
        NODE_ENV: 'development',
        API_URL: 'http://localhost:8787',
        HELCIM_WEBHOOK_VERIFIER: 'mock-verifier',
      });

      expect(createMockSpy).toHaveBeenCalledWith({
        webhookUrl: 'http://localhost:8787/api/webhooks/payment',
        webhookVerifier: 'mock-verifier',
      });

      createMockSpy.mockRestore();
    });
  });

  describe('in CI', () => {
    it('throws if HELCIM_API_TOKEN is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'development',
          CI: 'true',
          HELCIM_WEBHOOK_VERIFIER: 'verifier',
        })
      ).toThrow('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
    });

    it('throws if HELCIM_WEBHOOK_VERIFIER is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'development',
          CI: 'true',
          HELCIM_API_TOKEN: 'token',
        })
      ).toThrow('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
    });

    it('returns real client when credentials are provided', () => {
      const client = getHelcimClient({
        NODE_ENV: 'development',
        CI: 'true',
        HELCIM_API_TOKEN: 'test-api-token-valid',
        HELCIM_WEBHOOK_VERIFIER: 'test-verifier-valid',
      });
      expect(client.isMock).toBe(false);
    });
  });

  describe('in production', () => {
    it('throws if HELCIM_API_TOKEN is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'production',
          HELCIM_WEBHOOK_VERIFIER: 'verifier',
        })
      ).toThrow('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
    });

    it('throws if HELCIM_WEBHOOK_VERIFIER is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'production',
          HELCIM_API_TOKEN: 'token',
        })
      ).toThrow('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
    });

    it('returns real client when credentials are provided', () => {
      const client = getHelcimClient({
        NODE_ENV: 'production',
        HELCIM_API_TOKEN: 'test-api-token-valid',
        HELCIM_WEBHOOK_VERIFIER: 'test-verifier-valid',
      });
      expect(client.isMock).toBe(false);
    });
  });
});
