import { describe, it, expect, vi } from 'vitest';
import { nanoUSD, textEncoder, toStandardBase64 } from '@hushbox/shared';
import { createPaymentProviderFromEnv } from './payment-provider-factory.js';
import { createFixtureFetch, HELCIM_PURCHASE_APPROVED } from './payment-helcim-fixtures.js';
import type { Database } from '@hushbox/db';
import type { ChargeRequest } from '../ports/index.js';

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

const CI_ENV = { NODE_ENV: 'development', CI: 'true', HELCIM_API_TOKEN: 'sandbox-api-token' };

function chargeRequest(): ChargeRequest {
  return {
    idempotencyKey: 'payment-123',
    reference: 'ref-123',
    amount: nanoUSD(10_000_000_000n),
    cardToken: 'card-token-1',
    customerCode: 'CST1234',
    ipAddress: '192.168.1.1',
  };
}

function spyDb(): { db: Database; insert: ReturnType<typeof vi.fn> } {
  const values = vi.fn(() => Promise.resolve());
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as unknown as Database, insert };
}

describe('createPaymentProviderFromEnv — service evidence threading', () => {
  it('threads db and isCI into the real provider so a CI charge records evidence', async () => {
    const { db, insert } = spyDb();
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    vi.stubGlobal('fetch', fixture.fetchImpl);
    try {
      const result = await createPaymentProviderFromEnv(CI_ENV, db).charge(chargeRequest());
      expect(result._unsafeUnwrap().status).toBe('approved');
      expect(insert).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never records evidence through the mock provider', async () => {
    const { db, insert } = spyDb();
    const provider = createPaymentProviderFromEnv(LOCAL_DEV_ENV, db);

    expect(provider.isMock).toBe(true);
    const result = await provider.charge(chargeRequest());

    expect(result.isOk()).toBe(true);
    expect(insert).not.toHaveBeenCalled();
  });
});
