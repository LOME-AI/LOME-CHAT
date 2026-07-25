import { describe, it, expect, beforeAll } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { createWebPushSender } from './push-webpush.js';
import type { VapidKeys } from './webpush/index.js';
import type { PushMessage, PushRecipient } from '../ports/index.js';

const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';
const ALIAS = 'LP8HoKvhpgV7wlyNkKm5FzNGj9H6Rs3q';

// A real base64url P-256 subscription public key (65-byte uncompressed point);
// paired auth secret is 16 bytes. Values are inert test fixtures.
const SUB_P256DH =
  'BOeIadxzr8jCEiJstuK2__fGtYo6wWP0HMZDdYl-RWBXoSB9O1Bs4Dd4gPtm5WijJcYxrmH-i1QTCTzaj9xJ4tE';
const SUB_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

let vapid: VapidKeys;

beforeAll(async () => {
  // Generate a throwaway P-256 keypair at runtime so no VAPID secret is committed.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  vapid = {
    subject: 'mailto:test@hushbox.ai',
    publicKey: toBase64(raw),
    privateKey: jwk.d ?? '',
  };
});

function webRecipient(userId: string, endpoint: string): PushRecipient {
  return { platform: 'web', userId, endpoint, p256dh: SUB_P256DH, auth: SUB_AUTH };
}

function message(recipients: readonly PushRecipient[]): PushMessage {
  return {
    recipients,
    title: 'New message',
    body: 'You have a new message in a conversation.',
    data: { category: 'message', conversationId: CONVERSATION_ID },
    collapseKey: ALIAS,
  };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function capturingFetch(status: number): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: requestUrl(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as Uint8Array,
    });
    return Promise.resolve(new Response(null, { status }));
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

describe('createWebPushSender', () => {
  it('resolves nothing when there are no web recipients', async () => {
    const { fetchImpl, sent } = capturingFetch(201);
    const sender = createWebPushSender({ vapid, fetchImpl });

    const result = await sender.send(
      message([{ platform: 'ios', userId: 'u1', token: 'ios-token' }])
    );

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 0,
      failureCount: 0,
      deliveredTokens: [],
      deadTokens: [],
    });
    expect(sent).toEqual([]);
  });

  it('counts a 2xx as delivered', async () => {
    const { fetchImpl } = capturingFetch(201);
    const sender = createWebPushSender({ vapid, fetchImpl });

    const result = await sender.send(message([webRecipient('u1', 'https://push.example/aaa')]));

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 1,
      failureCount: 0,
      deliveredTokens: [{ userId: 'u1', token: 'https://push.example/aaa' }],
      deadTokens: [],
    });
  });

  it('stamps the collapse alias as the Topic header and never the raw conversationId', async () => {
    const { fetchImpl, sent } = capturingFetch(201);
    const sender = createWebPushSender({ vapid, fetchImpl });

    const delivery = await sender.send(message([webRecipient('u1', 'https://push.example/aaa')]));
    expect(delivery.isOk()).toBe(true);

    const headers = sent[0]?.headers ?? {};
    expect(headers['Topic']).toBe(ALIAS);
    const serialized = JSON.stringify({ url: sent[0]?.url, headers });
    expect(serialized).not.toContain(CONVERSATION_ID);
    // The encrypted body must not carry the id in cleartext either.
    expect(new TextDecoder().decode(sent[0]?.body)).not.toContain(CONVERSATION_ID);
  });

  it('omits the Topic header when no collapse alias is set', async () => {
    const { fetchImpl, sent } = capturingFetch(201);
    const sender = createWebPushSender({ vapid, fetchImpl });

    const delivery = await sender.send({
      recipients: [webRecipient('u1', 'https://push.example/aaa')],
      title: 'New message',
      body: 'body',
      data: { category: 'message', conversationId: CONVERSATION_ID },
    });
    expect(delivery.isOk()).toBe(true);

    expect(sent[0]?.headers['Topic']).toBeUndefined();
  });

  it('prunes a 404 subscription by its endpoint', async () => {
    const { fetchImpl } = capturingFetch(404);
    const sender = createWebPushSender({ vapid, fetchImpl });

    const result = await sender.send(message([webRecipient('u1', 'https://push.example/gone')]));

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 0,
      failureCount: 1,
      deliveredTokens: [],
      deadTokens: [{ userId: 'u1', token: 'https://push.example/gone' }],
    });
  });

  it('prunes a 410 subscription by its endpoint', async () => {
    const { fetchImpl } = capturingFetch(410);
    const sender = createWebPushSender({ vapid, fetchImpl });

    const result = await sender.send(message([webRecipient('u1', 'https://push.example/gone')]));

    expect(result._unsafeUnwrap().deadTokens).toEqual([
      { userId: 'u1', token: 'https://push.example/gone' },
    ]);
  });

  it('counts a transient rejection as a failure without pruning', async () => {
    const { fetchImpl } = capturingFetch(429);
    const sender = createWebPushSender({ vapid, fetchImpl });

    const result = await sender.send(message([webRecipient('u1', 'https://push.example/aaa')]));

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 0,
      failureCount: 1,
      deliveredTokens: [],
      deadTokens: [],
    });
  });

  it('counts a transport exception as a failure', async () => {
    const fetchImpl = (() => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const sender = createWebPushSender({ vapid, fetchImpl });

    const result = await sender.send(message([webRecipient('u1', 'https://push.example/aaa')]));

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 0,
      failureCount: 1,
      deliveredTokens: [],
      deadTokens: [],
    });
  });

  it('rejects a message missing the generic payload', async () => {
    const { fetchImpl } = capturingFetch(201);
    const sender = createWebPushSender({ vapid, fetchImpl });

    const result = await sender.send({
      recipients: [webRecipient('u1', 'https://push.example/aaa')],
      title: 'x',
      body: 'y',
      collapseKey: ALIAS,
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
