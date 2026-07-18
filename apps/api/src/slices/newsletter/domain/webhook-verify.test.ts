import { describe, expect, it } from 'vitest';
import { signHmacSha256Webhook } from '@hushbox/crypto';
import { createResendWebhookVerifier } from './webhook-verify.js';
import type { ResendWebhookHeaders } from './webhook-verify.js';

/**
 * The Svix scheme end-to-end with real HMAC vectors: every accepted delivery
 * in these tests is signed in-test with the same signed-content construction
 * (`${id}.${timestamp}.${body}`) Resend documents, against the fixed dev
 * secret format (`whsec_` + standard base64).
 */

const RAW_SECRET_B64 = Buffer.from('newsletter-test-webhook-secret').toString('base64');
const SECRET = `whsec_${RAW_SECRET_B64}`;

const NOW = new Date('2026-07-17T12:00:00Z');

function timestampFor(now: Date, skewSeconds = 0): string {
  return String(Math.floor(now.getTime() / 1000) + skewSeconds);
}

async function signedHeaders(
  body: string,
  options: { readonly skewSeconds?: number; readonly id?: string } = {}
): Promise<ResendWebhookHeaders> {
  const svixId = options.id ?? 'msg_test_1';
  const svixTimestamp = timestampFor(NOW, options.skewSeconds ?? 0);
  const svixSignature = await signHmacSha256Webhook({
    secret: RAW_SECRET_B64,
    payload: body,
    timestamp: svixTimestamp,
    webhookId: svixId,
  });
  return { svixId, svixTimestamp, svixSignature };
}

const BOUNCE_BODY = JSON.stringify({
  type: 'email.bounced',
  data: { to: ['Bounced@Example.com'] },
});

describe('createResendWebhookVerifier', () => {
  it('fails fast on a secret without the whsec_ prefix', () => {
    expect(() => createResendWebhookVerifier({ secret: RAW_SECRET_B64 })).toThrow(/whsec_/);
  });

  it('fails fast on a whsec_ secret whose remainder is not standard base64', () => {
    expect(() => createResendWebhookVerifier({ secret: 'whsec_!!!not-base64!!!' })).toThrow(
      /base64/
    );
  });

  it('fails fast on an undefined secret', () => {
    expect(() => createResendWebhookVerifier({ secret: undefined })).toThrow(/not configured/);
  });

  it('accepts a correctly signed bounce and lowercases its recipients', async () => {
    const verifier = createResendWebhookVerifier({ secret: SECRET });

    const result = await verifier.verify(BOUNCE_BODY, await signedHeaders(BOUNCE_BODY), NOW);

    expect(result._unsafeUnwrap()).toEqual({
      type: 'email.bounced',
      recipients: ['bounced@example.com'],
      eventId: 'msg_test_1',
    });
  });

  it('accepts a complaint whose data.to is a bare string', async () => {
    const body = JSON.stringify({ type: 'email.complained', data: { to: 'One@example.com' } });
    const verifier = createResendWebhookVerifier({ secret: SECRET });

    const result = await verifier.verify(body, await signedHeaders(body), NOW);

    expect(result._unsafeUnwrap()).toEqual({
      type: 'email.complained',
      recipients: ['one@example.com'],
      eventId: 'msg_test_1',
    });
  });

  it('rejects a tampered body as unauthorized', async () => {
    const verifier = createResendWebhookVerifier({ secret: SECRET });
    const headers = await signedHeaders(BOUNCE_BODY);
    const tampered = BOUNCE_BODY.replace('bounced', 'delivered');

    const result = await verifier.verify(tampered, headers, NOW);

    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects a stale timestamp beyond the five-minute tolerance', async () => {
    const verifier = createResendWebhookVerifier({ secret: SECRET });
    const headers = await signedHeaders(BOUNCE_BODY, { skewSeconds: -301 });

    const result = await verifier.verify(BOUNCE_BODY, headers, NOW);

    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('rejects a future timestamp beyond the five-minute tolerance', async () => {
    const verifier = createResendWebhookVerifier({ secret: SECRET });
    const headers = await signedHeaders(BOUNCE_BODY, { skewSeconds: 301 });

    const result = await verifier.verify(BOUNCE_BODY, headers, NOW);

    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('accepts a timestamp inside the tolerance window', async () => {
    const verifier = createResendWebhookVerifier({ secret: SECRET });
    const headers = await signedHeaders(BOUNCE_BODY, { skewSeconds: -299 });

    const result = await verifier.verify(BOUNCE_BODY, headers, NOW);

    expect(result.isOk()).toBe(true);
  });

  it('rejects a non-numeric timestamp as unauthorized', async () => {
    const verifier = createResendWebhookVerifier({ secret: SECRET });
    const headers = await signedHeaders(BOUNCE_BODY);

    const result = await verifier.verify(
      BOUNCE_BODY,
      { ...headers, svixTimestamp: 'not-a-number' },
      NOW
    );

    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it.each([
    ['svixId', { svixId: undefined }],
    ['svixTimestamp', { svixTimestamp: undefined }],
    ['svixSignature', { svixSignature: undefined }],
  ])('rejects a delivery missing %s', async (_name, override) => {
    const verifier = createResendWebhookVerifier({ secret: SECRET });
    const headers = { ...(await signedHeaders(BOUNCE_BODY)), ...override };

    const result = await verifier.verify(BOUNCE_BODY, headers, NOW);

    expect(result._unsafeUnwrapErr().code).toBe('unauthorized');
  });

  it('maps a verified unknown event type to ignored', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { to: ['a@example.com'] } });
    const verifier = createResendWebhookVerifier({ secret: SECRET });

    const result = await verifier.verify(body, await signedHeaders(body), NOW);

    expect(result._unsafeUnwrap()).toEqual({ type: 'ignored', rawType: 'email.delivered' });
  });

  it('maps a verified body with no type field to ignored', async () => {
    const body = JSON.stringify({ data: { to: ['a@example.com'] } });
    const verifier = createResendWebhookVerifier({ secret: SECRET });

    const result = await verifier.verify(body, await signedHeaders(body), NOW);

    expect(result._unsafeUnwrap()).toEqual({ type: 'ignored', rawType: '' });
  });

  it('rejects a verified bounce with no data field as a validation error', async () => {
    const body = JSON.stringify({ type: 'email.bounced' });
    const verifier = createResendWebhookVerifier({ secret: SECRET });

    const result = await verifier.verify(body, await signedHeaders(body), NOW);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('drops empty-string recipients before deciding validity', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: [''] } });
    const verifier = createResendWebhookVerifier({ secret: SECRET });

    const result = await verifier.verify(body, await signedHeaders(body), NOW);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a verified non-JSON body as a validation error', async () => {
    const body = 'not json';
    const verifier = createResendWebhookVerifier({ secret: SECRET });

    const result = await verifier.verify(body, await signedHeaders(body), NOW);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a verified bounce with no recipients as a validation error', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: [] } });
    const verifier = createResendWebhookVerifier({ secret: SECRET });

    const result = await verifier.verify(body, await signedHeaders(body), NOW);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
