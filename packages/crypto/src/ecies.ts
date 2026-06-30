import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateKeyPair } from './sharing.js';
import { DecryptionError, InvalidBlobError } from './crypto-errors.js';

const VERSION_BYTE = 0x01;
const EPHEMERAL_PUB_LENGTH = 32;
const HEADER_LENGTH = 1 + EPHEMERAL_PUB_LENGTH; // 33
const TAG_LENGTH = 16;
const MIN_BLOB_LENGTH = HEADER_LENGTH + TAG_LENGTH; // 49
const HKDF_INFO = new TextEncoder().encode('ecies-xchacha20-v1');

export function eciesEncrypt(recipientPublicKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const ephemeral = generateKeyPair();

  const sharedPoint = x25519.getSharedSecret(ephemeral.privateKey, recipientPublicKey);

  const salt = new Uint8Array(64);
  salt.set(ephemeral.publicKey, 0);
  salt.set(recipientPublicKey, 32);
  const derivedKey = hkdf(sha256, sharedPoint, salt, HKDF_INFO, 32);

  const nonce = new Uint8Array(24);
  const ciphertextAndTag = xchacha20poly1305(derivedKey, nonce).encrypt(plaintext);

  const blob = new Uint8Array(HEADER_LENGTH + ciphertextAndTag.length);
  blob[0] = VERSION_BYTE;
  blob.set(ephemeral.publicKey, 1);
  blob.set(ciphertextAndTag, HEADER_LENGTH);
  return blob;
}

export function eciesDecrypt(recipientPrivateKey: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length < MIN_BLOB_LENGTH) {
    throw new InvalidBlobError(
      `Blob too short: ${String(blob.length)} bytes, minimum ${String(MIN_BLOB_LENGTH)}`
    );
  }
  if (blob[0] !== VERSION_BYTE) {
    throw new InvalidBlobError(`Unknown version byte: ${String(blob[0])}`);
  }

  const ephemeralPub = blob.slice(1, HEADER_LENGTH);
  const ciphertextAndTag = blob.slice(HEADER_LENGTH);

  const recipientPub = x25519.getPublicKey(recipientPrivateKey);
  const sharedPoint = x25519.getSharedSecret(recipientPrivateKey, ephemeralPub);

  const salt = new Uint8Array(64);
  salt.set(ephemeralPub, 0);
  salt.set(recipientPub, 32);
  const derivedKey = hkdf(sha256, sharedPoint, salt, HKDF_INFO, 32);

  const nonce = new Uint8Array(24);
  try {
    return xchacha20poly1305(derivedKey, nonce).decrypt(ciphertextAndTag);
  } catch {
    throw new DecryptionError('ECIES decryption failed');
  }
}
