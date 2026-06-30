import { describe, it, expect } from 'vitest';
import { signHmacSha256Webhook } from '@hushbox/crypto';
import { nanoUSD } from '@hushbox/shared';
import { textEncoder, toStandardBase64 } from '@hushbox/shared';
import { createHelcimPaymentProvider } from './payment-helcim.js';
import { createMockPaymentProvider } from './payment-mock.js';
import {
  createFixtureFetch,
  HELCIM_PURCHASE_APPROVED,
  HELCIM_PURCHASE_DECLINED,
  HELCIM_TRANSACTION_STATUS_APPROVED,
} from './payment-helcim-fixtures.js';
import { createWebhookVerifier } from '../domain/webhook-verify.js';
import type { ChargeRequest, PaymentProvider } from '../ports/index.js';
import type { WebhookSignatureHeaders } from '../domain/webhook-verify.js';

const VERIFIER_SECRET = toStandardBase64(textEncoder.encode('parity-webhook-secret'));
const WEBHOOK_URL = 'http://localhost:8787/api/webhooks/payment';

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

/** One behavioral surface per adapter so the same matrix runs on both. */
interface ProviderHarness {
  readonly provider: PaymentProvider;
  primeApproved(): void;
  primeDeclined(): void;
  primeStatusApproved(): void;
  primeStatusUnknown(): void;
  outgoingIdempotencyKeys(): readonly (string | undefined)[];
}

function makeMockHarness(): ProviderHarness {
  const provider = createMockPaymentProvider({
    webhookUrl: WEBHOOK_URL,
    webhookVerifier: VERIFIER_SECRET,
    webhookDelayMs: 0,
    fetchImpl: createFixtureFetch().fetchImpl,
  });
  return {
    provider,
    primeApproved(): void {
      // The mock approves by default.
    },
    primeDeclined(): void {
      provider.setNextChargeOutcome({ status: 'declined', declineReason: 'Insufficient funds' });
    },
    primeStatusApproved(): void {
      // The mock remembers its own approved transactions.
    },
    primeStatusUnknown(): void {
      // Unknown ids are unknown by construction.
    },
    outgoingIdempotencyKeys(): readonly (string | undefined)[] {
      return provider.getChargeRequests().map((request) => request.idempotencyKey);
    },
  };
}

function makeHelcimHarness(): ProviderHarness {
  const fixture = createFixtureFetch();
  const provider = createHelcimPaymentProvider({
    apiToken: 'sandbox-api-token',
    fetchImpl: fixture.fetchImpl,
  });
  return {
    provider,
    primeApproved(): void {
      fixture.enqueueJson(200, HELCIM_PURCHASE_APPROVED);
    },
    primeDeclined(): void {
      fixture.enqueueJson(400, HELCIM_PURCHASE_DECLINED);
    },
    primeStatusApproved(): void {
      fixture.enqueueJson(200, HELCIM_TRANSACTION_STATUS_APPROVED);
    },
    primeStatusUnknown(): void {
      fixture.enqueueJson(404, { errors: 'Not found' });
    },
    outgoingIdempotencyKeys(): readonly (string | undefined)[] {
      return fixture.requests().map((request) => request.headers['idempotency-key']);
    },
  };
}

const HARNESSES = [
  ['mock adapter', makeMockHarness],
  ['helcim adapter (sandbox fixtures)', makeHelcimHarness],
] as const;

describe.each(HARNESSES)('payment provider parity — %s', (_name, makeHarness) => {
  it('approves a charge with a non-empty transaction id', async () => {
    const harness = makeHarness();
    harness.primeApproved();
    const result = await harness.provider.charge(chargeRequest());
    const outcome = result._unsafeUnwrap();

    expect(outcome.status).toBe('approved');
    if (outcome.status === 'approved') {
      expect(outcome.transactionId.length).toBeGreaterThan(0);
    }
  });

  it('returns a declined outcome with the provider reason', async () => {
    const harness = makeHarness();
    harness.primeDeclined();
    const result = await harness.provider.charge(chargeRequest());
    const outcome = result._unsafeUnwrap();

    expect(outcome).toEqual({ status: 'declined', declineReason: 'Insufficient funds' });
  });

  it('forwards the caller-supplied idempotency key on every charge call', async () => {
    const harness = makeHarness();
    harness.primeApproved();
    const first = await harness.provider.charge(chargeRequest({ idempotencyKey: 'pre-claim-1' }));
    harness.primeApproved();
    const second = await harness.provider.charge(chargeRequest({ idempotencyKey: 'pre-claim-2' }));

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);

    expect(harness.outgoingIdempotencyKeys()).toEqual(['pre-claim-1', 'pre-claim-2']);
  });

  it('reports an approved charge from the status query', async () => {
    const harness = makeHarness();
    harness.primeApproved();
    const chargeResult = await harness.provider.charge(chargeRequest());
    const outcome = chargeResult._unsafeUnwrap();
    if (outcome.status !== 'approved') {
      expect.unreachable('charge must approve');
    }
    harness.primeStatusApproved();
    const statusResult = await harness.provider.getChargeStatus(outcome.transactionId);
    const status = statusResult._unsafeUnwrap();

    expect(status).toEqual({ status: 'approved', transactionId: outcome.transactionId });
  });

  it('returns a not_found error for an unknown transaction', async () => {
    const harness = makeHarness();
    harness.primeStatusUnknown();
    const result = await harness.provider.getChargeStatus('unknown-transaction');

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('rejects a non-positive amount with a validation error', async () => {
    const harness = makeHarness();
    const result = await harness.provider.charge(chargeRequest({ amount: nanoUSD(0n) }));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(harness.outgoingIdempotencyKeys()).toHaveLength(0);
  });

  it('rejects a sub-cent amount with a validation error', async () => {
    const harness = makeHarness();
    const result = await harness.provider.charge(
      chargeRequest({ amount: nanoUSD(10_000_000_001n) })
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(harness.outgoingIdempotencyKeys()).toHaveLength(0);
  });
});

interface SignedWebhook {
  readonly body: string;
  readonly headers: WebhookSignatureHeaders;
}

/** A webhook as the mock adapter actually delivers it. */
async function mockDeliveredWebhook(): Promise<SignedWebhook> {
  const fixture = createFixtureFetch();
  fixture.enqueueJson(200, { received: true });
  const provider = createMockPaymentProvider({
    webhookUrl: WEBHOOK_URL,
    webhookVerifier: VERIFIER_SECRET,
    webhookDelayMs: 0,
    fetchImpl: fixture.fetchImpl,
  });
  const charged = await provider.charge(chargeRequest());
  if (charged.isErr()) {
    throw new Error('mock charge must approve');
  }
  await provider.flushWebhooks();
  const [request] = fixture.requests();
  return {
    body: request?.body ?? '',
    headers: {
      signature: request?.headers['webhook-signature'],
      timestamp: request?.headers['webhook-timestamp'],
      webhookId: request?.headers['webhook-id'],
    },
  };
}

/**
 * A sandbox-shaped webhook: the body is the wire shape the legacy route
 * receives from Helcim; the signature is SYNTHETIC (signed here with the
 * test secret — real sandbox signatures require the sandbox verifier).
 */
async function sandboxShapedWebhook(): Promise<SignedWebhook> {
  const body = JSON.stringify({ id: '25764674', type: 'cardTransaction' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookId = 'msg_sandbox_fixture';
  const signature = await signHmacSha256Webhook({
    secret: VERIFIER_SECRET,
    payload: body,
    timestamp,
    webhookId,
  });
  return { body, headers: { signature, timestamp, webhookId } };
}

const WEBHOOK_SOURCES = [
  ['mock adapter delivery', mockDeliveredWebhook],
  ['sandbox-shaped fixture', sandboxShapedWebhook],
] as const;

describe.each(WEBHOOK_SOURCES)('webhook verification parity — %s', (_name, makeWebhook) => {
  const verifier = createWebhookVerifier({ verifier: VERIFIER_SECRET });

  it('accepts the signed webhook as payment.completed', async () => {
    const webhook = await makeWebhook();
    const result = await verifier.verify(webhook.body, webhook.headers);

    expect(result._unsafeUnwrap().type).toBe('payment.completed');
  });

  it('rejects it when the signature header is missing', async () => {
    const webhook = await makeWebhook();
    const result = await verifier.verify(webhook.body, {
      ...webhook.headers,
      signature: undefined,
    });

    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects it with a wrong signature', async () => {
    const webhook = await makeWebhook();
    const result = await verifier.verify(webhook.body, {
      ...webhook.headers,
      signature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    });

    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects it with a tampered body', async () => {
    const webhook = await makeWebhook();
    const result = await verifier.verify(
      JSON.stringify({ id: 'tampered', type: 'cardTransaction' }),
      webhook.headers
    );

    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects it with a tampered timestamp', async () => {
    const webhook = await makeWebhook();
    const result = await verifier.verify(webhook.body, {
      ...webhook.headers,
      timestamp: '1000000000',
    });

    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  /**
   * Helcim's scheme signs the timestamp but defines no freshness window, so
   * an identical replay verifies; replay absorption is the webhook route's
   * atomic status claim, not this layer.
   */
  it('accepts an identical replayed delivery', async () => {
    const webhook = await makeWebhook();
    const first = await verifier.verify(webhook.body, webhook.headers);
    const replay = await verifier.verify(webhook.body, webhook.headers);

    expect(first.isOk()).toBe(true);
    expect(replay.isOk()).toBe(true);
  });
});
