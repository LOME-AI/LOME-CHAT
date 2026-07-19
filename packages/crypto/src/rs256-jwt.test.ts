import { describe, it, expect, beforeAll } from 'vitest';
import { fromBase64, textEncoder } from '@hushbox/shared';
import { signRs256Jwt } from './rs256-jwt.js';

let privateKeyPem: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  publicKey = keyPair.publicKey;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`; // gitleaks:allow
});

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fromBase64(segment))) as Record<string, unknown>;
}

describe('signRs256Jwt', () => {
  it('declares RS256 in the JWT header', async () => {
    const jwt = await signRs256Jwt({ privateKeyPem, claims: { iss: 'a@b.com' } });

    const [headerSegment] = jwt.split('.');
    expect(decodeSegment(headerSegment ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('encodes the provided claims into the payload segment', async () => {
    const claims = { iss: 'svc@project.iam', scope: 'firebase.messaging', iat: 100, exp: 3700 };

    const jwt = await signRs256Jwt({ privateKeyPem, claims });

    const [, payloadSegment] = jwt.split('.');
    expect(decodeSegment(payloadSegment ?? '')).toEqual(claims);
  });

  it('produces a signature the corresponding public key verifies', async () => {
    const jwt = await signRs256Jwt({ privateKeyPem, claims: { iss: 'a@b.com', exp: 42 } });

    const [headerSegment, payloadSegment, signatureSegment] = jwt.split('.');
    const signingInput = `${headerSegment ?? ''}.${payloadSegment ?? ''}`;
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      fromBase64(signatureSegment ?? '').buffer as ArrayBuffer,
      textEncoder.encode(signingInput)
    );

    expect(verified).toBe(true);
  });
});
