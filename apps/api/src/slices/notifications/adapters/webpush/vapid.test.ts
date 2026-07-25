import { describe, it, expect } from 'vitest';
import { jwtVerify, importJWK } from 'jose';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { createVapidAuthorization } from './vapid.js';

// A throwaway P-256 keypair generated once for these tests (never a real VAPID
// key). Public key is the 65-byte uncompressed point; private is the 32-byte
// scalar — both base64url, the on-the-wire VAPID form.
const KEYS = {
  subject: 'mailto:test@hushbox.ai',
  publicKey:
    'BOeIadxzr8jCEiJstuK2__fGtYo6wWP0HMZDdYl-RWBXoSB9O1Bs4Dd4gPtm5WijJcYxrmH-i1QTCTzaj9xJ4tE',
  privateKey: 'SQ6hnT9IQ-46JeC7tl_zN_tJjH0v76csKdFBGcCYTx0',
} as const;

const NOW_MS = 1_700_000_000_000;

function parseAuthorization(header: string): { t: string; k: string } {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  if (match === null) throw new Error(`unexpected Authorization header: ${header}`);
  return { t: match[1] ?? '', k: match[2] ?? '' };
}

async function verifyingKey(): Promise<CryptoKey> {
  const pub = fromBase64(KEYS.publicKey);
  const key = await importJWK(
    {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64(pub.subarray(1, 33)),
      y: toBase64(pub.subarray(33, 65)),
    },
    'ES256'
  );
  return key as CryptoKey;
}

describe('createVapidAuthorization', () => {
  it('emits a `vapid t=<jwt>, k=<publicKey>` header carrying the public key', async () => {
    const header = await createVapidAuthorization({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: KEYS,
      nowMs: NOW_MS,
    });

    const { k } = parseAuthorization(header);
    expect(k).toBe(KEYS.publicKey);
  });

  it('signs an ES256 JWT that verifies against the public key with the expected claims', async () => {
    const header = await createVapidAuthorization({
      endpoint: 'https://push.example.net/push/xyz',
      keys: KEYS,
      nowMs: NOW_MS,
    });

    const { t } = parseAuthorization(header);
    const { payload, protectedHeader } = await jwtVerify(t, await verifyingKey(), {
      currentDate: new Date(NOW_MS),
    });

    expect(protectedHeader.alg).toBe('ES256');
    expect(payload.aud).toBe('https://push.example.net');
    expect(payload.sub).toBe(KEYS.subject);
    const iat = Math.floor(NOW_MS / 1000);
    expect(payload.exp).toBeGreaterThan(iat);
    expect(payload.exp).toBeLessThanOrEqual(iat + 24 * 60 * 60);
  });

  it('rejects a JWT whose signature does not match the public key', async () => {
    const header = await createVapidAuthorization({
      endpoint: 'https://push.example.net/push/xyz',
      keys: KEYS,
      nowMs: NOW_MS,
    });
    const { t } = parseAuthorization(header);

    // Tamper: flip the last character of the signature segment.
    const [h = '', p = '', sig = ''] = t.split('.');
    const flipped = sig.endsWith('A') ? 'B' : 'A';
    const tampered = `${h}.${p}.${sig.slice(0, -1)}${flipped}`;

    await expect(jwtVerify(tampered, await verifyingKey())).rejects.toThrow();
  });

  it('honours a custom expiry within the 24-hour ceiling', async () => {
    const header = await createVapidAuthorization({
      endpoint: 'https://push.example.net/push/xyz',
      keys: KEYS,
      nowMs: NOW_MS,
      expirySeconds: 60,
    });
    const { t } = parseAuthorization(header);
    const { payload } = await jwtVerify(t, await verifyingKey(), { currentDate: new Date(NOW_MS) });

    expect(payload.exp).toBe(Math.floor(NOW_MS / 1000) + 60);
  });

  it('fails fast when the requested expiry exceeds the 24-hour ceiling', async () => {
    await expect(
      createVapidAuthorization({
        endpoint: 'https://push.example.net/push/xyz',
        keys: KEYS,
        nowMs: NOW_MS,
        expirySeconds: 24 * 60 * 60 + 1,
      })
    ).rejects.toThrow();
  });
});
