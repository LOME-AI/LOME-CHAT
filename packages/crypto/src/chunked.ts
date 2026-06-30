import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { ChunkStreamError, DecryptionFailedError, MalformedBlobError } from './errors.js';
import {
  BLOB_FORMAT_VERSION,
  NONCE_BYTES,
  TAG_BYTES,
  assertKnownVersion,
  u64Field,
  utf8Field,
} from './format.js';
import type { ContentKey } from './keys.js';

/**
 * Per-flow cap on media bytes, enforced at flow validation. Set equal to the
 * in-memory ValueStore's metered budget (≤20 MB metered, assuming a ≥3×
 * real-memory multiplier on the ~128 MB isolate shared across co-located
 * DOs): a media value larger than this can never fit a flow, so it is
 * rejected up front rather than OOM-killing neighboring conversations.
 */
export const PER_FLOW_MEDIA_CAP_BYTES = 20 * 1024 * 1024;

/**
 * STREAM-style chunked media encryption. Each chunk is sealed under the
 * media's content key with a FRESH RANDOM NONCE (a zero/counter nonce
 * pattern is banned; XChaCha20's 24-byte nonce makes random safe). Fresh
 * nonces prevent keystream reuse if a key were ever shared across streams —
 * but they do NOT prevent cross-stream chunk splicing; the contentId in the
 * AAD is what closes that. The AAD binds the stream's contentId, the chunk
 * index, and an explicit last-chunk flag, so cross-stream substitution,
 * reordering, duplication, and truncation all fail authentication instead
 * of yielding a spliced stream.
 */

const MIN_BLOB_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

/**
 * A chunk's full AAD-bound position: which stream it belongs to and where it
 * sits in that stream (mirrors the envelope's ContentLocation pattern).
 */
export interface ChunkLocation {
  contentId: string;
  chunkIndex: number;
  isLast: boolean;
}

function chunkAad(location: ChunkLocation): Uint8Array {
  return concatBytes(
    Uint8Array.of(BLOB_FORMAT_VERSION),
    utf8Field(location.contentId),
    u64Field(location.chunkIndex, 'chunkIndex'),
    Uint8Array.of(location.isLast ? 1 : 0)
  );
}

export function encryptMediaChunk(
  key: ContentKey,
  location: ChunkLocation,
  plaintext: Uint8Array
): Uint8Array {
  const aad = chunkAad(location);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertextAndTag = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);

  return concatBytes(Uint8Array.of(BLOB_FORMAT_VERSION), nonce, ciphertextAndTag);
}

export function decryptMediaChunk(
  key: ContentKey,
  location: ChunkLocation,
  blob: Uint8Array
): Uint8Array {
  assertKnownVersion(blob);
  if (blob.length < MIN_BLOB_BYTES) {
    throw new MalformedBlobError(
      `Media chunk too short: ${String(blob.length)} bytes, minimum ${String(MIN_BLOB_BYTES)}`
    );
  }

  const aad = chunkAad(location);
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const ciphertextAndTag = blob.subarray(1 + NONCE_BYTES);

  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertextAndTag);
  } catch {
    throw new DecryptionFailedError(
      'Media chunk decryption failed: wrong key, wrong stream, wrong position, or tampered chunk'
    );
  }
}

export function encryptMediaStream(
  key: ContentKey,
  contentId: string,
  chunks: readonly Uint8Array[]
): Uint8Array[] {
  if (chunks.length === 0) {
    throw new ChunkStreamError('Cannot encrypt an empty media stream');
  }
  return chunks.map((chunk, index) =>
    encryptMediaChunk(
      key,
      { contentId, chunkIndex: index, isLast: index === chunks.length - 1 },
      chunk
    )
  );
}

export function decryptMediaStream(
  key: ContentKey,
  contentId: string,
  blobs: readonly Uint8Array[]
): Uint8Array {
  if (blobs.length === 0) {
    throw new ChunkStreamError('Cannot decrypt an empty media stream');
  }
  const parts = blobs.map((blob, index) =>
    decryptMediaChunk(
      key,
      { contentId, chunkIndex: index, isLast: index === blobs.length - 1 },
      blob
    )
  );
  return concatBytes(...parts);
}
