import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { DecryptionFailedError, InvalidParameterError, MalformedBlobError } from './errors.js';
import { BLOB_FORMAT_VERSION, NONCE_BYTES, TAG_BYTES, assertKnownVersion } from './format.js';
import type { PrivateKey, PublicKey } from './keys.js';

/**
 * Domain-separated asymmetric secret wrapping (ECIES: ephemeral X25519 →
 * HKDF-SHA-256 → XChaCha20-Poly1305). The mandatory label feeds the HKDF
 * info, so wraps made under different labels derive incompatible keys: a
 * blob wrapped for one purpose can never be unwrapped in another context,
 * even with the same recipient key material.
 */

const EPHEMERAL_PUB_BYTES = 32;
const HEADER_BYTES = 1 + EPHEMERAL_PUB_BYTES + NONCE_BYTES;
const MIN_BLOB_BYTES = HEADER_BYTES + TAG_BYTES;
// Domain-separation constant baked into key derivation: once any real data
// is encrypted under this HKDF info string, it can never change.
const WRAP_INFO_PREFIX = 'hushbox/wrap:';

const encoder = new TextEncoder();

export type WrappedSecret = Uint8Array & { readonly __brand: 'crypto.WrappedSecret' };

function deriveWrapKey(
  sharedPoint: Uint8Array,
  ephemeralPub: Uint8Array,
  recipientPub: Uint8Array,
  label: string
): Uint8Array {
  const salt = concatBytes(ephemeralPub, recipientPub);
  const info = encoder.encode(`${WRAP_INFO_PREFIX}${label}`);
  return hkdf(sha256, sharedPoint, salt, info, 32);
}

function assertLabel(label: string): void {
  if (label.length === 0) {
    throw new InvalidParameterError('Domain-separation label must be non-empty');
  }
}

export function wrapSecretTo(
  recipientPublicKey: PublicKey,
  secret: Uint8Array,
  label: string
): WrappedSecret {
  assertLabel(label);

  const ephemeral = x25519.keygen();
  const sharedPoint = x25519.getSharedSecret(ephemeral.secretKey, recipientPublicKey);
  const key = deriveWrapKey(sharedPoint, ephemeral.publicKey, recipientPublicKey, label);

  const nonce = randomBytes(NONCE_BYTES);
  const aad = Uint8Array.of(BLOB_FORMAT_VERSION);
  const ciphertextAndTag = xchacha20poly1305(key, nonce, aad).encrypt(secret);

  return concatBytes(
    Uint8Array.of(BLOB_FORMAT_VERSION),
    ephemeral.publicKey,
    nonce,
    ciphertextAndTag
  ) as WrappedSecret;
}

export function unwrapSecret(
  recipientPrivateKey: PrivateKey,
  wrapped: WrappedSecret,
  label: string
): Uint8Array {
  assertLabel(label);
  assertKnownVersion(wrapped);
  if (wrapped.length < MIN_BLOB_BYTES) {
    throw new MalformedBlobError(
      `Wrapped secret too short: ${String(wrapped.length)} bytes, minimum ${String(MIN_BLOB_BYTES)}`
    );
  }

  const ephemeralPub = wrapped.subarray(1, 1 + EPHEMERAL_PUB_BYTES);
  const nonce = wrapped.subarray(1 + EPHEMERAL_PUB_BYTES, HEADER_BYTES);
  const ciphertextAndTag = wrapped.subarray(HEADER_BYTES);

  const aad = Uint8Array.of(BLOB_FORMAT_VERSION);
  // The ECDH must sit inside the typed-error boundary: noble rejects an
  // all-zero or low-order ephemeral point by throwing from getSharedSecret
  // (the shared secret would be all zeros). A forged point in a stored blob
  // is adversarial input, so it surfaces as DecryptionFailedError — the same
  // typed failure as any other tampered blob — never as a raw Error.
  try {
    const recipientPub = x25519.getPublicKey(recipientPrivateKey);
    const sharedPoint = x25519.getSharedSecret(recipientPrivateKey, ephemeralPub);
    const key = deriveWrapKey(sharedPoint, ephemeralPub, recipientPub, label);
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertextAndTag);
  } catch {
    throw new DecryptionFailedError(
      'Secret unwrap failed: wrong recipient key, wrong domain label, invalid ephemeral point, or tampered blob'
    );
  }
}
