import { describe, it, expect } from 'vitest';
import { signHmacSha256Webhook } from '@hushbox/crypto';
import { textEncoder, toStandardBase64 } from '@hushbox/shared';
import { createWebhookVerifier } from './webhook-verify.js';
import type { WebhookSignatureHeaders } from './webhook-verify.js';

const VERIFIER_SECRET = toStandardBase64(textEncoder.encode('test-webhook-secret'));

async function signedHeaders(
  rawBody: string,
  overrides: Partial<{ timestamp: string; webhookId: string }> = {}
): Promise<WebhookSignatureHeaders> {
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const webhookId = overrides.webhookId ?? 'webhook-id-1';
  const signature = await signHmacSha256Webhook({
    secret: VERIFIER_SECRET,
    payload: rawBody,
    timestamp,
    webhookId,
  });
  return { signature, timestamp, webhookId };
}

describe('createWebhookVerifier', () => {
  it('throws when the verifier secret is missing', () => {
    expect(() => createWebhookVerifier({ verifier: undefined })).toThrow(
      'webhook verifier is not configured'
    );
  });

  it('throws when the verifier secret is empty', () => {
    expect(() => createWebhookVerifier({ verifier: '' })).toThrow(
      'webhook verifier is not configured'
    );
  });

  it('throws when the verifier secret is only whitespace', () => {
    expect(() => createWebhookVerifier({ verifier: '   ' })).toThrow(
      'webhook verifier is not configured'
    );
  });

  it('throws when the verifier secret is not valid base64', () => {
    expect(() => createWebhookVerifier({ verifier: 'not-valid-base64!!!' })).toThrow(
      'not valid standard base64'
    );
  });
});

describe('verify — signature rejection matrix', () => {
  const verifier = createWebhookVerifier({ verifier: VERIFIER_SECRET });
  const rawBody = JSON.stringify({ type: 'cardTransaction', id: '25764674' });

  it('accepts a correctly signed payload', async () => {
    const headers = await signedHeaders(rawBody);
    const result = await verifier.verify(rawBody, headers);
    expect(result.isOk()).toBe(true);
  });

  it('rejects a missing signature header with an unauthorized error', async () => {
    const headers = await signedHeaders(rawBody);
    const result = await verifier.verify(rawBody, { ...headers, signature: undefined });
    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects a missing timestamp header with an unauthorized error', async () => {
    const headers = await signedHeaders(rawBody);
    const result = await verifier.verify(rawBody, { ...headers, timestamp: undefined });
    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects a missing webhook-id header with an unauthorized error', async () => {
    const headers = await signedHeaders(rawBody);
    const result = await verifier.verify(rawBody, { ...headers, webhookId: undefined });
    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects a signature computed with a different secret', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const wrongSignature = await signHmacSha256Webhook({
      secret: toStandardBase64(textEncoder.encode('a-different-secret')),
      payload: rawBody,
      timestamp,
      webhookId: 'webhook-id-1',
    });
    const result = await verifier.verify(rawBody, {
      signature: wrongSignature,
      timestamp,
      webhookId: 'webhook-id-1',
    });
    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects a tampered body', async () => {
    const headers = await signedHeaders(rawBody);
    const tampered = JSON.stringify({ type: 'cardTransaction', id: '99999999' });
    const result = await verifier.verify(tampered, headers);
    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects a tampered timestamp', async () => {
    const headers = await signedHeaders(rawBody, { timestamp: '1000000000' });
    const result = await verifier.verify(rawBody, { ...headers, timestamp: '2000000000' });
    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects a tampered webhook id', async () => {
    const headers = await signedHeaders(rawBody, { webhookId: 'webhook-id-1' });
    const result = await verifier.verify(rawBody, { ...headers, webhookId: 'webhook-id-2' });
    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('never includes the verifier secret in a rejection', async () => {
    const headers = await signedHeaders(rawBody);
    const result = await verifier.verify(rawBody, { ...headers, signature: 'v1,bogus' });
    const error = result._unsafeUnwrapErr();
    expect(JSON.stringify(error)).not.toContain(VERIFIER_SECRET);
  });
});

describe('verify — body parsing after signature acceptance', () => {
  const verifier = createWebhookVerifier({ verifier: VERIFIER_SECRET });

  it('rejects a malformed JSON body with a validation error', async () => {
    const rawBody = 'not-json{';
    const headers = await signedHeaders(rawBody);
    const result = await verifier.verify(rawBody, headers);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a non-object JSON body with a validation error', async () => {
    const rawBody = '42';
    const headers = await signedHeaders(rawBody);
    const result = await verifier.verify(rawBody, headers);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a recognized event type without a transaction id', async () => {
    const rawBody = JSON.stringify({ type: 'cardTransaction' });
    const headers = await signedHeaders(rawBody);
    const result = await verifier.verify(rawBody, headers);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects an unsigned malformed body as unauthorized, not validation', async () => {
    const result = await verifier.verify('not-json{', {
      signature: undefined,
      timestamp: undefined,
      webhookId: undefined,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });
});

describe('verify — typed event mapping', () => {
  const verifier = createWebhookVerifier({ verifier: VERIFIER_SECRET });

  async function verifyEvent(payload: Record<string, unknown>): Promise<unknown> {
    const rawBody = JSON.stringify(payload);
    const headers = await signedHeaders(rawBody);
    const result = await verifier.verify(rawBody, headers);
    return result._unsafeUnwrap();
  }

  it('maps cardTransaction to payment.completed', async () => {
    const event = await verifyEvent({ type: 'cardTransaction', id: '25764674' });
    expect(event).toEqual({ type: 'payment.completed', transactionId: '25764674' });
  });

  it('coerces a numeric transaction id to a string', async () => {
    const event = await verifyEvent({ type: 'cardTransaction', id: 25_764_674 });
    expect(event).toEqual({ type: 'payment.completed', transactionId: '25764674' });
  });

  it('reads the transactionId field when id is absent', async () => {
    const event = await verifyEvent({ type: 'cardTransaction', transactionId: '25764674' });
    expect(event).toEqual({ type: 'payment.completed', transactionId: '25764674' });
  });

  it('maps declinedCardTransaction to payment.failed', async () => {
    const event = await verifyEvent({ type: 'declinedCardTransaction', id: '1' });
    expect(event).toEqual({ type: 'payment.failed', transactionId: '1' });
  });

  it('maps chargeback to dispute.chargeback', async () => {
    const event = await verifyEvent({ type: 'chargeback', id: '1' });
    expect(event).toEqual({ type: 'dispute.chargeback', transactionId: '1' });
  });

  it('maps reversal to dispute.reversal', async () => {
    const event = await verifyEvent({ type: 'reversal', id: '1' });
    expect(event).toEqual({ type: 'dispute.reversal', transactionId: '1' });
  });

  it('maps inquiry to dispute.inquiry', async () => {
    const event = await verifyEvent({ type: 'inquiry', id: '1' });
    expect(event).toEqual({ type: 'dispute.inquiry', transactionId: '1' });
  });

  it('maps retrieval to dispute.retrieval', async () => {
    const event = await verifyEvent({ type: 'retrieval', id: '1' });
    expect(event).toEqual({ type: 'dispute.retrieval', transactionId: '1' });
  });

  it('maps an unknown event type to unrecognized with the raw type', async () => {
    const event = await verifyEvent({ type: 'cardBatch', id: '1' });
    expect(event).toEqual({ type: 'unrecognized', rawType: 'cardBatch' });
  });

  it('maps a missing type field to unrecognized', async () => {
    const event = await verifyEvent({ id: '1' });
    expect(event).toEqual({ type: 'unrecognized', rawType: '' });
  });

  it('maps an Object.prototype key as the type to unrecognized', async () => {
    const event = await verifyEvent({ type: 'toString', id: '1' });
    expect(event).toEqual({ type: 'unrecognized', rawType: 'toString' });
  });
});
