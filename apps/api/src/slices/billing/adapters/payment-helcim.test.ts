import { describe, it, expect, vi } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { createHelcimPaymentProvider } from './payment-helcim.js';
import {
  createFixtureFetch,
  HELCIM_PURCHASE_APPROVED,
  HELCIM_PURCHASE_DECLINED,
  HELCIM_PURCHASE_ERRORS_MAP,
  HELCIM_TRANSACTION_STATUS_APPROVED,
  HELCIM_TRANSACTION_STATUS_DECLINED,
} from './payment-helcim-fixtures.js';
import type { FixtureFetch } from './payment-helcim-fixtures.js';
import type { ChargeRequest, PaymentProvider } from '../ports/index.js';
import type { Database } from '@hushbox/db';

const API_TOKEN = 'test-api-token';

/** Zero backoff so retry-exhaustion paths stay fast under test. */
const FAST_NETWORK = { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, timeoutMs: 1000 };

function makeProvider(fixture: FixtureFetch, baseUrl?: string): PaymentProvider {
  return createHelcimPaymentProvider({
    apiToken: API_TOKEN,
    fetchImpl: fixture.fetchImpl,
    network: FAST_NETWORK,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
}

function chargeRequest(overrides: Partial<ChargeRequest> = {}): ChargeRequest {
  return {
    idempotencyKey: 'payment-123',
    reference: 'ref-123',
    amount: nanoUSD(10_000_000_000n),
    cardToken: 'card-token-1',
    customerCode: 'CST1234',
    ipAddress: '192.168.1.1',
    ...overrides,
  };
}

describe('createHelcimPaymentProvider — construction', () => {
  it('throws when the api token is missing', () => {
    expect(() => createHelcimPaymentProvider({ apiToken: '' })).toThrow(
      'Helcim API token is not configured'
    );
  });

  it('throws when the api token is only whitespace', () => {
    expect(() => createHelcimPaymentProvider({ apiToken: '   ' })).toThrow(
      'Helcim API token is not configured'
    );
  });

  it('throws when the api token is too short', () => {
    expect(() => createHelcimPaymentProvider({ apiToken: 'short' })).toThrow(
      'Helcim API token appears invalid'
    );
  });

  it('is not a mock', () => {
    const provider = makeProvider(createFixtureFetch());
    expect(provider.isMock).toBe(false);
  });
});

describe('charge — outgoing request', () => {
  it('POSTs the purchase endpoint with the api token header', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result.isOk()).toBe(true);
    const [request] = fixture.requests();
    expect(request?.url).toBe('https://api.helcim.com/v2/payment/purchase');
    expect(request?.method).toBe('POST');
    expect(request?.headers['api-token']).toBe(API_TOKEN);
  });

  it('forwards the caller-supplied idempotency key on the charge call', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const result = await makeProvider(fixture).charge(
      chargeRequest({ idempotencyKey: 'pre-claim-abc' })
    );

    expect(result.isOk()).toBe(true);

    expect(fixture.requests()[0]?.headers['idempotency-key']).toBe('pre-claim-abc');
  });

  it('forwards a distinct idempotency key on every charge call', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const provider = makeProvider(fixture);
    const first = await provider.charge(chargeRequest({ idempotencyKey: 'key-1' }));
    const second = await provider.charge(chargeRequest({ idempotencyKey: 'key-2' }));

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);

    const keys = fixture.requests().map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual(['key-1', 'key-2']);
  });

  it('sends the Helcim purchase body shape', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result.isOk()).toBe(true);
    expect(JSON.parse(fixture.requests()[0]?.body ?? '{}')).toEqual({
      amount: 10,
      currency: 'USD',
      ipAddress: '192.168.1.1',
      customerCode: 'CST1234',
      invoiceNumber: 'ref-123',
      cardData: { cardToken: 'card-token-1' },
    });
  });

  it('sends the merchant reference as the invoiceNumber', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const result = await makeProvider(fixture).charge(chargeRequest({ reference: 'invoice-xyz' }));

    expect(result.isOk()).toBe(true);
    const body = JSON.parse(fixture.requests()[0]?.body ?? '{}') as { invoiceNumber: string };
    expect(body.invoiceNumber).toBe('invoice-xyz');
  });

  it('converts fractional nano-USD amounts exactly', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const result = await makeProvider(fixture).charge(
      chargeRequest({ amount: nanoUSD(10_500_000_000n) })
    );

    expect(result.isOk()).toBe(true);

    const body = JSON.parse(fixture.requests()[0]?.body ?? '{}') as { amount: number };
    expect(body.amount).toBe(10.5);
  });

  it('uses the global fetch when none is injected', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    vi.stubGlobal('fetch', fixture.fetchImpl);
    try {
      const provider = createHelcimPaymentProvider({ apiToken: API_TOKEN });
      const result = await provider.charge(chargeRequest());
      expect(result._unsafeUnwrap().status).toBe('approved');
      expect(fixture.requests()).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses a configured base URL', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const result = await makeProvider(fixture, 'http://localhost:9999/v2').charge(chargeRequest());

    expect(result.isOk()).toBe(true);

    expect(fixture.requests()[0]?.url).toBe('http://localhost:9999/v2/payment/purchase');
  });
});

describe('charge — outcomes', () => {
  it('maps an approved response to an approved outcome', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrap()).toEqual({
      status: 'approved',
      transactionId: '12345',
      cardType: 'Visa',
      cardLastFour: '1234',
    });
  });

  it('returns an unavailable error when an approved response is missing the transaction id', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { approvalCode: 'ABC123' });
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a declined response to a declined outcome with the provider message', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(400, HELCIM_PURCHASE_DECLINED);
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrap()).toEqual({
      status: 'declined',
      declineReason: 'Insufficient funds',
    });
  });

  it('joins error-map messages into the decline reason', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(400, HELCIM_PURCHASE_ERRORS_MAP);
    const result = await makeProvider(fixture).charge(chargeRequest());

    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('declined');
    if (outcome.status === 'declined') {
      expect(outcome.declineReason).toContain('Invalid card token');
      expect(outcome.declineReason).toContain('Invalid amount');
    }
  });

  it('falls back to a generic decline reason when the error map is empty', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(400, { errors: {} });
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrap()).toEqual({
      status: 'declined',
      declineReason: 'Payment declined',
    });
  });

  it('falls back to a generic decline reason when the provider sends none', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(400, {});
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrap()).toEqual({
      status: 'declined',
      declineReason: 'Payment declined',
    });
  });

  /**
   * Pins the ruled contract: a 5xx with a parseable JSON body is a terminal
   * decline (legacy parity), never a retryable error; payment.verify.v1
   * reconciles the truth if real Helcim 5xx semantics turn out to differ.
   */
  it('maps a 5xx response with a parseable JSON body to a declined outcome', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(503, { responseMessage: 'Service unavailable' });
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrap()).toEqual({
      status: 'declined',
      declineReason: 'Service unavailable',
    });
  });

  it('treats a 200 without an approval code as declined', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { transactionId: 12_345 });
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrap().status).toBe('declined');
  });

  it('rejects a zero amount with a validation error before any provider call', async () => {
    const fixture = createFixtureFetch();
    const result = await makeProvider(fixture).charge(chargeRequest({ amount: nanoUSD(0n) }));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(fixture.requests()).toHaveLength(0);
  });

  it('rejects a negative amount with a validation error before any provider call', async () => {
    const fixture = createFixtureFetch();
    const result = await makeProvider(fixture).charge(chargeRequest({ amount: nanoUSD(-1n) }));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(fixture.requests()).toHaveLength(0);
  });

  it('rejects a sub-cent amount with a validation error before any provider call', async () => {
    const fixture = createFixtureFetch();
    const result = await makeProvider(fixture).charge(
      chargeRequest({ amount: nanoUSD(10_000_000_001n) })
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(fixture.requests()).toHaveLength(0);
  });

  it('returns an unavailable error for a JSON purchase response with an unrecognized shape', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, 'a-bare-json-string');
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('omits card metadata the provider did not send', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { transactionId: 777, approvalCode: 'OK1' });
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrap()).toEqual({ status: 'approved', transactionId: '777' });
  });

  it('returns an unavailable error when the request fails', async () => {
    const fixture = createFixtureFetch();
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('returns an unavailable error for an unparseable response body', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueRaw(502, '<html>bad gateway</html>');
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('never includes the api token in error values', async () => {
    const fixture = createFixtureFetch();
    const result = await makeProvider(fixture).charge(chargeRequest());

    const error = result._unsafeUnwrapErr();
    expect(
      JSON.stringify(error, (_key, value: unknown) =>
        value instanceof Error ? value.message : value
      )
    ).not.toContain(API_TOKEN);
  });
});

describe('charge — service evidence', () => {
  function fakeDb(): {
    db: Database;
    insert: ReturnType<typeof vi.fn>;
    values: ReturnType<typeof vi.fn>;
  } {
    const values = vi.fn(() => Promise.resolve());
    const insert = vi.fn(() => ({ values }));
    return { db: { insert } as unknown as Database, insert, values };
  }

  function evidenceProvider(fixture: FixtureFetch, db: Database, isCI: boolean): PaymentProvider {
    return createHelcimPaymentProvider({
      apiToken: API_TOKEN,
      fetchImpl: fixture.fetchImpl,
      network: FAST_NETWORK,
      db,
      isCI,
    });
  }

  it('records one helcim service-evidence row after a successful CI charge', async () => {
    const { db, insert, values } = fakeDb();
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);

    const result = await evidenceProvider(fixture, db, true).charge(chargeRequest());

    expect(result._unsafeUnwrap().status).toBe('approved');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ service: 'helcim' }));
  });

  it('skips the evidence write outside CI', async () => {
    const { db, insert } = fakeDb();
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);

    const result = await evidenceProvider(fixture, db, false).charge(chargeRequest());

    expect(result._unsafeUnwrap().status).toBe('approved');
    expect(insert).not.toHaveBeenCalled();
  });

  it('records no evidence on a declined charge', async () => {
    const { db, insert } = fakeDb();
    const fixture = createFixtureFetch();
    fixture.enqueueJson(400, HELCIM_PURCHASE_DECLINED);

    const result = await evidenceProvider(fixture, db, true).charge(chargeRequest());

    expect(result._unsafeUnwrap().status).toBe('declined');
    expect(insert).not.toHaveBeenCalled();
  });

  it('records no evidence when an approved response lacks a transaction id', async () => {
    const { db, insert } = fakeDb();
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { approvalCode: 'ABC123' });

    const result = await evidenceProvider(fixture, db, true).charge(chargeRequest());

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('charge — network resilience', () => {
  it('retries a network-failed purchase call and returns the replayed approval', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueNetworkError();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrap().status).toBe('approved');
  });

  it('forwards the same idempotency key on the retried attempt', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueNetworkError();
    fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    const result = await makeProvider(fixture).charge(
      chargeRequest({ idempotencyKey: 'pre-claim-retry' })
    );

    expect(result.isOk()).toBe(true);
    const keys = fixture.requests().map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual(['pre-claim-retry', 'pre-claim-retry']);
  });

  it('exhausts retries against a persistent network failure', async () => {
    const fixture = createFixtureFetch();
    const result = await makeProvider(fixture).charge(chargeRequest());

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(fixture.requests()).toHaveLength(3);
  });

  it('returns a timeout error when the provider call hangs past the per-attempt timeout', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueHang();
    const provider = createHelcimPaymentProvider({
      apiToken: API_TOKEN,
      fetchImpl: fixture.fetchImpl,
      network: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, timeoutMs: 20 },
    });
    const result = await provider.charge(chargeRequest());

    expect(result._unsafeUnwrapErr().code).toBe('timeout');
  });

  it('retries a network-failed status query', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueNetworkError();
    fixture.enqueueJson(200, HELCIM_TRANSACTION_STATUS_APPROVED);
    const result = await makeProvider(fixture).getChargeStatus('12345');

    expect(result._unsafeUnwrap()).toEqual({ status: 'approved', transactionId: '12345' });
  });
});

describe('getChargeStatus', () => {
  it('GETs the card-transactions endpoint with the api token header', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_TRANSACTION_STATUS_APPROVED);
    const result = await makeProvider(fixture).getChargeStatus('12345');

    expect(result.isOk()).toBe(true);

    const [request] = fixture.requests();
    expect(request?.url).toBe('https://api.helcim.com/v2/card-transactions/12345');
    expect(request?.method).toBe('GET');
    expect(request?.headers['api-token']).toBe(API_TOKEN);
  });

  it('URL-encodes the transaction id', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_TRANSACTION_STATUS_APPROVED);
    const result = await makeProvider(fixture).getChargeStatus('a/b c');

    expect(result.isOk()).toBe(true);

    expect(fixture.requests()[0]?.url).toBe(
      'https://api.helcim.com/v2/card-transactions/a%2Fb%20c'
    );
  });

  it('maps an APPROVED status to approved', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_TRANSACTION_STATUS_APPROVED);
    const result = await makeProvider(fixture).getChargeStatus('12345');

    expect(result._unsafeUnwrap()).toEqual({ status: 'approved', transactionId: '12345' });
  });

  it('maps a DECLINED status to declined', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, HELCIM_TRANSACTION_STATUS_DECLINED);
    const result = await makeProvider(fixture).getChargeStatus('12345');

    expect(result._unsafeUnwrap()).toEqual({ status: 'declined', transactionId: '12345' });
  });

  it('returns a not_found error for an unknown transaction', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(404, { errors: 'Not found' });
    const result = await makeProvider(fixture).getChargeStatus('unknown');

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('returns an unavailable error for a provider failure', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(500, {});
    const result = await makeProvider(fixture).getChargeStatus('12345');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('returns an unavailable error for an unrecognized status value', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { transactionId: 12_345, status: 'PENDING_REVIEW' });
    const result = await makeProvider(fixture).getChargeStatus('12345');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('returns an unavailable error for an unparseable status body', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueRaw(200, 'not-json');
    const result = await makeProvider(fixture).getChargeStatus('12345');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('returns an unavailable error for a JSON status response with an unrecognized shape', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { unexpected: true });
    const result = await makeProvider(fixture).getChargeStatus('12345');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('findCaptureByReference', () => {
  it('GETs card-transactions filtered by invoiceNumber with the api token header', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, [{ transactionId: 12_345, status: 'APPROVED' }]);
    const result = await makeProvider(fixture).findCaptureByReference('ref-abc');

    expect(result.isOk()).toBe(true);
    const [request] = fixture.requests();
    expect(request?.url).toBe('https://api.helcim.com/v2/card-transactions?invoiceNumber=ref-abc');
    expect(request?.method).toBe('GET');
    expect(request?.headers['api-token']).toBe(API_TOKEN);
  });

  it('URL-encodes the reference in the query', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, []);
    const result = await makeProvider(fixture).findCaptureByReference('a/b c');

    expect(result.isOk()).toBe(true);
    expect(fixture.requests()[0]?.url).toBe(
      'https://api.helcim.com/v2/card-transactions?invoiceNumber=a%2Fb%20c'
    );
  });

  it('maps a found approved capture', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, [{ transactionId: 12_345, status: 'APPROVED' }]);
    const result = await makeProvider(fixture).findCaptureByReference('ref-abc');

    expect(result._unsafeUnwrap()).toEqual({
      kind: 'found',
      capture: { transactionId: '12345', status: 'approved' },
    });
  });

  it('maps a found declined capture', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, [{ transactionId: 999, status: 'DECLINED' }]);
    const result = await makeProvider(fixture).findCaptureByReference('ref-abc');

    expect(result._unsafeUnwrap()).toEqual({
      kind: 'found',
      capture: { transactionId: '999', status: 'declined' },
    });
  });

  it('takes the first capture when the search returns multiple results', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, [
      { transactionId: 111, status: 'APPROVED' },
      { transactionId: 222, status: 'DECLINED' },
    ]);
    const result = await makeProvider(fixture).findCaptureByReference('ref-abc');

    expect(result._unsafeUnwrap()).toEqual({
      kind: 'found',
      capture: { transactionId: '111', status: 'approved' },
    });
  });

  it('reports not-found for an empty result set', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, []);
    const result = await makeProvider(fixture).findCaptureByReference('ref-none');

    expect(result._unsafeUnwrap()).toEqual({ kind: 'not-found' });
  });

  it('returns an unavailable error for a provider failure', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(500, {});
    const result = await makeProvider(fixture).findCaptureByReference('ref-abc');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('returns an unavailable error for an unrecognized list shape', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { not: 'an-array' });
    const result = await makeProvider(fixture).findCaptureByReference('ref-abc');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('returns an unavailable error for an unrecognized capture status', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, [{ transactionId: 12_345, status: 'PENDING_REVIEW' }]);
    const result = await makeProvider(fixture).findCaptureByReference('ref-abc');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('never includes the api token in error values', async () => {
    const fixture = createFixtureFetch();
    const result = await makeProvider(fixture).findCaptureByReference('ref-abc');

    const error = result._unsafeUnwrapErr();
    expect(
      JSON.stringify(error, (_key, value: unknown) =>
        value instanceof Error ? value.message : value
      )
    ).not.toContain(API_TOKEN);
  });
});
