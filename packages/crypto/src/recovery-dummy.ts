import { hkdfSha256 } from './hash.js';
import { InvalidKeyError } from './errors.js';

/**
 * The server's OPAQUE master secret, branded so it can never be transposed
 * with the (also string-shaped) identifier argument of the derivation below.
 * The raw bytes are UTF-8 of the secret string; length is not fixed (unlike
 * the 32-byte key classes), only non-emptiness is asserted.
 */
export type ServerSecret = Uint8Array & { readonly __brand: 'crypto.ServerSecret' };

export function asServerSecret(bytes: Uint8Array): ServerSecret {
  if (bytes.length === 0) {
    throw new InvalidKeyError('ServerSecret must be non-empty');
  }
  return bytes as ServerSecret;
}

/**
 * Domain-separation label for the recovery dummy wrapped-key derivation.
 * Baked into the HKDF info: once any response has been served under it, it
 * can never change without shifting every dummy blob.
 */
export const RECOVERY_DUMMY_WRAPPED_KEY_LABEL = 'hushbox/recovery-dummy-wrapped-key/v1';

const encoder = new TextEncoder();

/**
 * Deterministic per-identifier dummy for unknown accounts on the public
 * recovery wrapped-key endpoint — the enumeration-safe / timing-safe defense.
 * Every distinguisher an attacker could read off the response must match a
 * real account's blob: same length, same leading version byte, a body that
 * looks like ciphertext (never a recognizable constant), and stability across
 * repeated queries. HKDF-SHA-256 over the server secret, domain-separated by
 * {@link RECOVERY_DUMMY_WRAPPED_KEY_LABEL} and bound to the canonical
 * identifier, gives all four at once — indistinguishable from ciphertext
 * without the server secret.
 *
 * `referenceWrappedKey` is a real ECIES wrap from this package (a public,
 * format-defining blob — NOT secret): only its length and leading version
 * byte are read, so the dummy tracks the live blob format and a format change
 * can never reopen the gap. X25519 accepts any 32 bytes, so HKDF output is
 * valid for the key-shaped region — with one canonical-encoding correction:
 * a real ephemeral public key is a little-endian u-coordinate below 2^255−19,
 * so the top bit of its final byte (blob index 32) is ALWAYS clear, while
 * uniform HKDF output would set it half the time — a certainty-grade
 * non-existence oracle. The mask keeps the dummy inside the real key-space
 * (the residual non-canonical range above the prime is ~19/2^255 — negligible).
 */
export function deriveDummyRecoveryWrappedKey(
  serverSecret: ServerSecret,
  canonicalIdentifier: string,
  referenceWrappedKey: Uint8Array
): Uint8Array {
  const info = encoder.encode(`${RECOVERY_DUMMY_WRAPPED_KEY_LABEL}:${canonicalIdentifier}`);
  // Body index 31 is blob index 32 — the final ephemeral-key byte.
  const body = hkdfSha256(
    serverSecret,
    new Uint8Array(0),
    info,
    referenceWrappedKey.length - 1
  ).map((byte, index) => (index === 31 ? byte & 0x7f : byte));
  const blob = new Uint8Array(referenceWrappedKey.length);
  blob.set(referenceWrappedKey.subarray(0, 1), 0);
  blob.set(body, 1);
  return blob;
}
