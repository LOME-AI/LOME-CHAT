import { describe, it, expect } from 'vitest';
import { textEncoder, toStandardBase64 } from '@hushbox/shared';
import { createPaymentProviderFromEnv } from './payment-provider-factory.js';

const VERIFIER = toStandardBase64(textEncoder.encode('mock-webhook-secret'));

const LOCAL_DEV_ENV = {
  NODE_ENV: 'development',
  API_URL: 'http://localhost:8787',
  HELCIM_WEBHOOK_VERIFIER: VERIFIER,
};

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  HELCIM_API_TOKEN: 'production-api-token',
};

describe('createPaymentProviderFromEnv', () => {
  it('returns the mock provider in local dev', () => {
    const provider = createPaymentProviderFromEnv(LOCAL_DEV_ENV);
    expect(provider.isMock).toBe(true);
  });

  it('fails fast in local dev without API_URL', () => {
    expect(() =>
      createPaymentProviderFromEnv({ NODE_ENV: 'development', HELCIM_WEBHOOK_VERIFIER: VERIFIER })
    ).toThrow('API_URL and HELCIM_WEBHOOK_VERIFIER');
  });

  it('fails fast in local dev without HELCIM_WEBHOOK_VERIFIER', () => {
    expect(() =>
      createPaymentProviderFromEnv({ NODE_ENV: 'development', API_URL: 'http://localhost:8787' })
    ).toThrow('API_URL and HELCIM_WEBHOOK_VERIFIER');
  });

  it('returns the real provider outside local dev', () => {
    const provider = createPaymentProviderFromEnv(PRODUCTION_ENV);
    expect(provider.isMock).toBe(false);
  });

  it('returns the real provider when CI is set even in development mode', () => {
    const provider = createPaymentProviderFromEnv({
      NODE_ENV: 'development',
      CI: 'true',
      HELCIM_API_TOKEN: 'sandbox-api-token',
    });
    expect(provider.isMock).toBe(false);
  });

  it('fails fast outside local dev without HELCIM_API_TOKEN', () => {
    expect(() => createPaymentProviderFromEnv({ NODE_ENV: 'production' })).toThrow(
      'HELCIM_API_TOKEN'
    );
  });

  it('throws when NODE_ENV is absent rather than defaulting into the mock', () => {
    expect(() =>
      createPaymentProviderFromEnv({
        API_URL: 'http://localhost:8787',
        HELCIM_WEBHOOK_VERIFIER: VERIFIER,
      })
    ).toThrow('NODE_ENV');
  });
});
