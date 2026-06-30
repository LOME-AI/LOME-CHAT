import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { DecryptionFailedError, MalformedBlobError } from './errors.js';
import {
  BLOB_FORMAT_VERSION,
  NONCE_BYTES,
  TAG_BYTES,
  assertKnownVersion,
  bytesField,
  u64Field,
  utf8Field,
} from './format.js';
import type { ContentKey } from './keys.js';
import type { WrappedSecret } from './wrap.js';

/**
 * Content envelope: XChaCha20-Poly1305 under a per-content key, with the
 * full location tuple (version, conversationId, messageId, contentItemId,
 * position, epochNumber, senderId) AND the wrapped content key bound as AAD.
 *
 * The AAD is location-binding, not authorship: anyone holding the epoch
 * public key (including the server) can mint valid ciphertext, but a valid
 * ciphertext spliced into any other location — or paired with any other key
 * wrap — fails authentication instead of decrypting.
 *
 * Compress-then-encrypt is safe in this scheme: each envelope compresses a
 * single source's content in its own stream, so there is no cross-source
 * co-compression and no CRIME-shaped length leak (padding optional).
 */

const MIN_BLOB_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

export interface ContentLocation {
  conversationId: string;
  messageId: string;
  contentItemId: string;
  position: number;
  epochNumber: number;
  senderId: string;
}

function locationAad(wrappedContentKey: WrappedSecret, location: ContentLocation): Uint8Array {
  return concatBytes(
    Uint8Array.of(BLOB_FORMAT_VERSION),
    utf8Field(location.conversationId),
    utf8Field(location.messageId),
    utf8Field(location.contentItemId),
    u64Field(location.position, 'position'),
    u64Field(location.epochNumber, 'epochNumber'),
    utf8Field(location.senderId),
    bytesField(wrappedContentKey)
  );
}

export function encryptContentEnvelope(
  contentKey: ContentKey,
  wrappedContentKey: WrappedSecret,
  location: ContentLocation,
  plaintext: Uint8Array
): Uint8Array {
  const aad = locationAad(wrappedContentKey, location);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertextAndTag = xchacha20poly1305(contentKey, nonce, aad).encrypt(plaintext);

  return concatBytes(Uint8Array.of(BLOB_FORMAT_VERSION), nonce, ciphertextAndTag);
}

export function decryptContentEnvelope(
  contentKey: ContentKey,
  wrappedContentKey: WrappedSecret,
  location: ContentLocation,
  blob: Uint8Array
): Uint8Array {
  assertKnownVersion(blob);
  if (blob.length < MIN_BLOB_BYTES) {
    throw new MalformedBlobError(
      `Envelope too short: ${String(blob.length)} bytes, minimum ${String(MIN_BLOB_BYTES)}`
    );
  }

  const aad = locationAad(wrappedContentKey, location);
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const ciphertextAndTag = blob.subarray(1 + NONCE_BYTES);

  try {
    return xchacha20poly1305(contentKey, nonce, aad).decrypt(ciphertextAndTag);
  } catch {
    throw new DecryptionFailedError(
      'Content envelope decryption failed: wrong key, tampered blob, or location mismatch'
    );
  }
}
