import { x25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { InvalidKeyError } from './errors.js';

/**
 * Branded key classes. Each class carries a distinct compile-time brand so a
 * key can never be passed where a different class is expected (argument
 * transposition is a type error, not a runtime surprise). Validators check
 * length before branding; raw `Uint8Array`s are never accepted by these APIs.
 */
export const KEY_BYTES = 32;

export type AccountPrivateKey = Uint8Array & { readonly __brand: 'crypto.AccountPrivateKey' };
export type AccountPublicKey = Uint8Array & { readonly __brand: 'crypto.AccountPublicKey' };
export type WrappingPrivateKey = Uint8Array & { readonly __brand: 'crypto.WrappingPrivateKey' };
export type WrappingPublicKey = Uint8Array & { readonly __brand: 'crypto.WrappingPublicKey' };
export type EpochPrivateKey = Uint8Array & { readonly __brand: 'crypto.EpochPrivateKey' };
export type EpochPublicKey = Uint8Array & { readonly __brand: 'crypto.EpochPublicKey' };
export type ContentKey = Uint8Array & { readonly __brand: 'crypto.ContentKey' };
export type ShareSecret = Uint8Array & { readonly __brand: 'crypto.ShareSecret' };

/** Any key class usable as a wrap recipient (X25519 public key). */
export type PublicKey = AccountPublicKey | WrappingPublicKey | EpochPublicKey;
/** Any key class usable to open a wrap (X25519 private key). */
export type PrivateKey = AccountPrivateKey | WrappingPrivateKey | EpochPrivateKey;

function assertKeyLength(keyClass: string, bytes: Uint8Array): void {
  if (bytes.length !== KEY_BYTES) {
    throw new InvalidKeyError(
      `${keyClass} must be ${String(KEY_BYTES)} bytes, got ${String(bytes.length)}`
    );
  }
}

export function asAccountPrivateKey(bytes: Uint8Array): AccountPrivateKey {
  assertKeyLength('AccountPrivateKey', bytes);
  return bytes as AccountPrivateKey;
}

export function asAccountPublicKey(bytes: Uint8Array): AccountPublicKey {
  assertKeyLength('AccountPublicKey', bytes);
  return bytes as AccountPublicKey;
}

export function asWrappingPrivateKey(bytes: Uint8Array): WrappingPrivateKey {
  assertKeyLength('WrappingPrivateKey', bytes);
  return bytes as WrappingPrivateKey;
}

export function asWrappingPublicKey(bytes: Uint8Array): WrappingPublicKey {
  assertKeyLength('WrappingPublicKey', bytes);
  return bytes as WrappingPublicKey;
}

export function asEpochPrivateKey(bytes: Uint8Array): EpochPrivateKey {
  assertKeyLength('EpochPrivateKey', bytes);
  return bytes as EpochPrivateKey;
}

export function asEpochPublicKey(bytes: Uint8Array): EpochPublicKey {
  assertKeyLength('EpochPublicKey', bytes);
  return bytes as EpochPublicKey;
}

export function asContentKey(bytes: Uint8Array): ContentKey {
  assertKeyLength('ContentKey', bytes);
  return bytes as ContentKey;
}

export function asShareSecret(bytes: Uint8Array): ShareSecret {
  assertKeyLength('ShareSecret', bytes);
  return bytes as ShareSecret;
}

export interface AccountKeyPair {
  publicKey: AccountPublicKey;
  privateKey: AccountPrivateKey;
}

export interface EpochKeyPair {
  publicKey: EpochPublicKey;
  privateKey: EpochPrivateKey;
}

export function generateAccountKeyPair(): AccountKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return {
    publicKey: asAccountPublicKey(publicKey),
    privateKey: asAccountPrivateKey(secretKey),
  };
}

export function generateEpochKeyPair(): EpochKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return {
    publicKey: asEpochPublicKey(publicKey),
    privateKey: asEpochPrivateKey(secretKey),
  };
}

export function generateContentKey(): ContentKey {
  return asContentKey(randomBytes(KEY_BYTES));
}
