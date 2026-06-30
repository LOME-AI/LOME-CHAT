import { describe, it, expect, vi } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { textEncoder, toStandardBase64 } from '@hushbox/shared';
import { createMockPaymentProvider } from './payment-mock.js';
import { createFixtureFetch } from './payment-helcim-fixtures.js';
import { createWebhookVerifier } from '../domain/webhook-verify.js';
import type { MockPaymentProvider } from './payment-mock.js';
import type { FixtureFetch } from './payment-helcim-fixtures.js';
import type { ChargeRequest } from '../ports/index.js';

const WEBHOOK_VERIFIER = toStandardBase64(textEncoder.encode('mock-webhook-secret'));
const WEBHOOK_URL = 'http://localhost:8787/api/webhooks/payment';

function makeProvider(fixture: FixtureFetch): MockPaymentProvider {
  return createMockPaymentProvider({
    webhookUrl: WEBHOOK_URL,
    webhookVerifier: WEBHOOK_VERIFIER,
    webhookDelayMs: 0,
    fetchImpl: fixture.fetchImpl,
  });
}

function chargeRequest(overrides: Partial<ChargeRequest> = {}): ChargeRequest {
  return {
    idempotencyKey: 'payment-123',
    amount: nanoUSD(10_000_000_000n),
    cardToken: 'card-token-1',
    customerCode: 'CST1234',
    ipAddress: '192.168.1.1',
    ...overrides,
  };
}

describe('createMockPaymentProvider — construction', () => {
  it('throws when the webhook verifier is missing', () => {
    expect(() =>
      createMockPaymentProvider({ webhookUrl: WEBHOOK_URL, webhookVerifier: '' })
    ).toThrow('webhook verifier');
  });

  it('throws when the webhook url is missing', () => {
    expect(() =>
      createMockPaymentProvider({ webhookUrl: '', webhookVerifier: WEBHOOK_VERIFIER })
    ).toThrow('webhook url');
  });

  it('is a mock', () => {
    expect(makeProvider(createFixtureFetch()).isMock).toBe(true);
  });
});

describe('charge', () => {
  it('approves by default with a mock transaction id', async () => {
    const result = await makeProvider(createFixtureFetch()).charge(chargeRequest());
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('approved');
    if (outcome.status === 'approved') {
      expect(outcome.transactionId).toMatch(/^mock-txn-/);
    }
  });

  it('issues a fresh transaction id per approved charge', async () => {
    const provider = makeProvider(createFixtureFetch());
    const firstResult = await provider.charge(chargeRequest());
    const secondResult = await provider.charge(chargeRequest());
    const first = firstResult._unsafeUnwrap();
    const second = secondResult._unsafeUnwrap();
    if (first.status === 'approved' && second.status === 'approved') {
      expect(first.transactionId).not.toBe(second.transactionId);
    } else {
      expect.unreachable('both charges must approve');
    }
  });

  it('records every charge request with its idempotency key', async () => {
    const provider = makeProvider(createFixtureFetch());
    const first = await provider.charge(chargeRequest({ idempotencyKey: 'key-1' }));
    const second = await provider.charge(chargeRequest({ idempotencyKey: 'key-2' }));

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);

    expect(provider.getChargeRequests().map((r) => r.idempotencyKey)).toEqual(['key-1', 'key-2']);
  });

  it('returns the primed declined outcome', async () => {
    const provider = makeProvider(createFixtureFetch());
    provider.setNextChargeOutcome({ status: 'declined', declineReason: 'Card declined' });
    const result = await provider.charge(chargeRequest());

    expect(result._unsafeUnwrap()).toEqual({
      status: 'declined',
      declineReason: 'Card declined',
    });
  });

  it('rejects a non-positive amount with a validation error and records nothing', async () => {
    const provider = makeProvider(createFixtureFetch());
    const result = await provider.charge(chargeRequest({ amount: nanoUSD(0n) }));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(provider.getChargeRequests()).toHaveLength(0);
  });

  it('rejects a sub-cent amount with a validation error', async () => {
    const provider = makeProvider(createFixtureFetch());
    const result = await provider.charge(chargeRequest({ amount: nanoUSD(10_000_000_001n) }));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(provider.getChargeRequests()).toHaveLength(0);
  });

  it('clears recorded charge requests', async () => {
    const provider = makeProvider(createFixtureFetch());
    const result = await provider.charge(chargeRequest());
    expect(result.isOk()).toBe(true);
    provider.clearChargeRequests();
    expect(provider.getChargeRequests()).toHaveLength(0);
  });
});

describe('mock webhook delivery', () => {
  it('delivers a signed cardTransaction webhook for an approved charge', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { received: true });
    const provider = makeProvider(fixture);
    const result = await provider.charge(chargeRequest());
    const outcome = result._unsafeUnwrap();
    await provider.flushWebhooks();

    const [request] = fixture.requests();
    expect(request?.url).toBe(WEBHOOK_URL);
    expect(request?.method).toBe('POST');
    if (outcome.status === 'approved') {
      expect(JSON.parse(request?.body ?? '{}')).toEqual({
        type: 'cardTransaction',
        id: outcome.transactionId,
      });
    }
  });

  it('delivers a webhook that passes the domain verifier', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { received: true });
    const provider = makeProvider(fixture);
    const charged = await provider.charge(chargeRequest());
    expect(charged.isOk()).toBe(true);
    await provider.flushWebhooks();

    const [request] = fixture.requests();
    const verifier = createWebhookVerifier({ verifier: WEBHOOK_VERIFIER });
    const result = await verifier.verify(request?.body ?? '', {
      signature: request?.headers['webhook-signature'],
      timestamp: request?.headers['webhook-timestamp'],
      webhookId: request?.headers['webhook-id'],
    });

    expect(result._unsafeUnwrap().type).toBe('payment.completed');
  });

  it('schedules no webhook for a declined charge', async () => {
    const fixture = createFixtureFetch();
    const provider = makeProvider(fixture);
    provider.setNextChargeOutcome({ status: 'declined', declineReason: 'Card declined' });
    const result = await provider.charge(chargeRequest());
    expect(result.isOk()).toBe(true);
    await provider.flushWebhooks();

    expect(fixture.requests()).toHaveLength(0);
  });

  it('delivers via the global fetch after the default delay when neither is injected', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { received: true });
    vi.stubGlobal('fetch', fixture.fetchImpl);
    vi.useFakeTimers();
    try {
      const provider = createMockPaymentProvider({
        webhookUrl: WEBHOOK_URL,
        webhookVerifier: WEBHOOK_VERIFIER,
      });
      const result = await provider.charge(chargeRequest());
      expect(result.isOk()).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      await provider.flushWebhooks();
      expect(fixture.requests()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('captures a delivery failure instead of throwing', async () => {
    const fixture = createFixtureFetch();
    const provider = makeProvider(fixture);
    const result = await provider.charge(chargeRequest());
    expect(result.isOk()).toBe(true);
    await provider.flushWebhooks();

    expect(provider.getWebhookDeliveryFailures()).toHaveLength(1);
  });
});

describe('getChargeStatus', () => {
  it('returns approved for a previously approved charge', async () => {
    const provider = makeProvider(createFixtureFetch());
    const charged = await provider.charge(chargeRequest());
    const outcome = charged._unsafeUnwrap();
    if (outcome.status !== 'approved') {
      expect.unreachable('charge must approve');
    }
    const result = await provider.getChargeStatus(outcome.transactionId);

    expect(result._unsafeUnwrap()).toEqual({
      status: 'approved',
      transactionId: outcome.transactionId,
    });
  });

  it('returns a not_found error for an unknown transaction', async () => {
    const provider = makeProvider(createFixtureFetch());
    const result = await provider.getChargeStatus('missing');

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });
});
