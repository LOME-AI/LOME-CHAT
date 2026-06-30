import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { DecryptionError, InvalidBlobError } from './crypto-errors.js';

const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
const MIN_BLOB_LENGTH = NONCE_LENGTH + TAG_LENGTH; // 40

export function symmetricEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertextAndTag = xchacha20poly1305(key, nonce).encrypt(plaintext);

  const blob = new Uint8Array(NONCE_LENGTH + ciphertextAndTag.length);
  blob.set(nonce, 0);
  blob.set(ciphertextAndTag, NONCE_LENGTH);
  return blob;
}

export function symmetricDecrypt(key: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length < MIN_BLOB_LENGTH) {
    throw new InvalidBlobError(
      `Blob too short: ${String(blob.length)} bytes, minimum ${String(MIN_BLOB_LENGTH)}`
    );
  }

  const nonce = blob.slice(0, NONCE_LENGTH);
  const ciphertextAndTag = blob.slice(NONCE_LENGTH);

  try {
    return xchacha20poly1305(key, nonce).decrypt(ciphertextAndTag);
  } catch {
    throw new DecryptionError('Symmetric decryption failed');
  }
}
