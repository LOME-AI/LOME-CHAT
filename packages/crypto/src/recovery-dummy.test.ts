import { describe, expect, it } from 'vitest';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { InvalidKeyError } from './errors.js';
import {
  RECOVERY_DUMMY_WRAPPED_KEY_LABEL,
  asServerSecret,
  deriveDummyRecoveryWrappedKey,
} from './recovery-dummy.js';

const encoder = new TextEncoder();

/**
 * A stand-in for a real stored recovery blob: 81 bytes (ECIES header 33 +
 * 32-byte plaintext + 16-byte tag), leading version byte 0x01. Only its
 * length and first byte are read by the derivation, so the remaining bytes
 * are irrelevant.
 */
function referenceBlob(): Uint8Array {
  const ref = new Uint8Array(81);
  ref[0] = 0x01;
  return ref;
}

/**
 * The exact inline algorithm from the identity slice's `recovery.ts`
 * (dummyWrappedKey), recomputed independently via WebCrypto — the source of
 * truth the extracted function must reproduce byte-for-byte.
 */
async function inlineDummyWrappedKey(
  masterSecret: string,
  canonicalId: string,
  reference: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(masterSecret), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encoder.encode(`hushbox/recovery-dummy-wrapped-key/v1:${canonicalId}`),
    },
    key,
    (reference.length - 1) * 8
  );
  const body = new Uint8Array(bits).map((byte, index) => (index === 31 ? byte & 0x7f : byte));
  const blob = new Uint8Array(reference.length);
  blob.set(reference.subarray(0, 1), 0);
  blob.set(body, 1);
  return blob;
}

describe('deriveDummyRecoveryWrappedKey', () => {
  const secret = asServerSecret(encoder.encode('master-secret-vector'));
  const canonicalId = 'user@example.com';

  it('reproduces the pinned vector of the inline recovery.ts derivation', () => {
    // Pinned from the inline WebCrypto algorithm (see inlineDummyWrappedKey)
    // for secret='master-secret-vector', id='user@example.com', 81-byte ref
    // with version 0x01 — proves the extracted function is byte-identical, so
    // the future rewire is behavior-preserving.
    const expected = hexToBytes(
      '019af78b01685c358ef1e0e5b1b99da43d1fac4746d95caa7ee2f8ad7cf1d4e57126dc50dd4b23e2e' +
        '85208c4582077b7cb55b8da57c9c85fa8d89be029ce46fe310169381960f9f5d0a65a4c500d1a597a'
    );
    expect(deriveDummyRecoveryWrappedKey(secret, canonicalId, referenceBlob())).toEqual(expected);
  });

  it('matches an independent WebCrypto recomputation of the inline algorithm', async () => {
    const expected = await inlineDummyWrappedKey(
      'master-secret-vector',
      canonicalId,
      referenceBlob()
    );
    expect(deriveDummyRecoveryWrappedKey(secret, canonicalId, referenceBlob())).toEqual(expected);
  });

  it('is deterministic: identical inputs derive identical output', () => {
    const a = deriveDummyRecoveryWrappedKey(secret, canonicalId, referenceBlob());
    const b = deriveDummyRecoveryWrappedKey(secret, canonicalId, referenceBlob());
    expect(a).toEqual(b);
  });

  it('preserves the reference length and its leading version byte', () => {
    const ref = referenceBlob();
    const blob = deriveDummyRecoveryWrappedKey(secret, canonicalId, ref);
    expect(blob.length).toBe(ref.length);
    expect(blob[0]).toBe(ref[0]);
  });

  it('clears the top bit of the final ephemeral-key byte (blob index 32)', () => {
    // Uniform HKDF sets it half the time; a real X25519 u-coordinate never
    // does — leaving it set would be a non-existence oracle.
    const blob = deriveDummyRecoveryWrappedKey(secret, canonicalId, referenceBlob());
    const finalEphemeralByte = blob[32] ?? -1;
    expect(finalEphemeralByte & 0x80).toBe(0);
  });

  it('domain-separates on the identifier: a different id derives a different blob', () => {
    const a = deriveDummyRecoveryWrappedKey(secret, 'alice@example.com', referenceBlob());
    const b = deriveDummyRecoveryWrappedKey(secret, 'bob@example.com', referenceBlob());
    expect(a).not.toEqual(b);
  });

  it('domain-separates on the label: a different label prefix derives a different blob', () => {
    // Independently derive with a different HKDF info label (same secret, id,
    // masking, assembly) and assert divergence — proving the fixed label is
    // load-bearing in the derivation, not decorative.
    const ref = referenceBlob();
    const otherInfo = encoder.encode(`hushbox/some-other-label/v1:${canonicalId}`);
    const otherBody = hkdf(sha256, secret, new Uint8Array(0), otherInfo, ref.length - 1).map(
      (byte, index) => (index === 31 ? byte & 0x7f : byte)
    );
    const otherBlob = new Uint8Array(ref.length);
    otherBlob.set(ref.subarray(0, 1), 0);
    otherBlob.set(otherBody, 1);

    const real = deriveDummyRecoveryWrappedKey(secret, canonicalId, ref);
    expect(real).not.toEqual(otherBlob);
  });

  it('pins the domain-separation label constant', () => {
    expect(RECOVERY_DUMMY_WRAPPED_KEY_LABEL).toBe('hushbox/recovery-dummy-wrapped-key/v1');
  });
});

describe('asServerSecret', () => {
  it('brands non-empty secret bytes', () => {
    const bytes = encoder.encode('a-secret');
    expect(asServerSecret(bytes)).toBe(bytes);
  });

  it('rejects an empty secret', () => {
    expect(() => asServerSecret(new Uint8Array(0))).toThrow(InvalidKeyError);
  });
});
