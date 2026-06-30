import { describe, it, expect } from 'vitest';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
  PER_FLOW_MEDIA_CAP_BYTES,
  encryptMediaChunk,
  decryptMediaChunk,
  encryptMediaStream,
  decryptMediaStream,
} from './chunked.js';
import { generateContentKey } from './keys.js';
import {
  ChunkStreamError,
  DecryptionFailedError,
  InvalidParameterError,
  MalformedBlobError,
  UnknownBlobVersionError,
} from './errors.js';
import { BLOB_FORMAT_VERSION, NONCE_BYTES } from './format.js';
import type { ChunkLocation } from './chunked.js';

const CONTENT_ID = 'content-1111';

function at(chunkIndex: number, isLast: boolean, contentId = CONTENT_ID): ChunkLocation {
  return { contentId, chunkIndex, isLast };
}

/** Deterministic filler for payloads beyond randomBytes's 65,536-byte cap. */
function patternBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    out[index] = (index * 31 + seed) & 0xff;
  }
  return out;
}

describe('chunked', () => {
  describe('PER_FLOW_MEDIA_CAP_BYTES', () => {
    it('is 20 MiB, matching the ValueStore metered budget', () => {
      expect(PER_FLOW_MEDIA_CAP_BYTES).toBe(20 * 1024 * 1024);
    });
  });

  describe('encryptMediaChunk', () => {
    it('produces a versioned blob', () => {
      const key = generateContentKey();

      const blob = encryptMediaChunk(key, at(0, false), randomBytes(64));

      expect(blob.at(0)).toBe(BLOB_FORMAT_VERSION);
    });

    it('uses a fresh random nonce per encryption of the same chunk', () => {
      const key = generateContentKey();
      const plaintext = randomBytes(64);

      const first = encryptMediaChunk(key, at(0, false), plaintext);
      const second = encryptMediaChunk(key, at(0, false), plaintext);

      expect(first.subarray(1, 1 + NONCE_BYTES)).not.toEqual(second.subarray(1, 1 + NONCE_BYTES));
    });

    it('uses distinct nonces across many chunks (statistical uniqueness)', () => {
      const key = generateContentKey();
      const chunkCount = 256;

      const nonces = new Set<string>();
      for (let index = 0; index < chunkCount; index++) {
        const blob = encryptMediaChunk(key, at(index, index === chunkCount - 1), randomBytes(8));
        nonces.add(bytesToHex(blob.subarray(1, 1 + NONCE_BYTES)));
      }

      expect(nonces.size).toBe(chunkCount);
    });

    it('rejects a negative chunk index', () => {
      const key = generateContentKey();

      expect(() => encryptMediaChunk(key, at(-1, false), randomBytes(8))).toThrow(
        InvalidParameterError
      );
    });
  });

  describe('decryptMediaChunk', () => {
    it('round-trips a chunk at the same contentId, index, and last-flag', () => {
      const key = generateContentKey();
      const plaintext = randomBytes(1024);

      const blob = encryptMediaChunk(key, at(3, true), plaintext);
      const decrypted = decryptMediaChunk(key, at(3, true), blob);

      expect(decrypted).toEqual(plaintext);
    });

    it('fails when presented at a different chunk index', () => {
      const key = generateContentKey();

      const blob = encryptMediaChunk(key, at(3, false), randomBytes(64));

      expect(() => decryptMediaChunk(key, at(4, false), blob)).toThrow(DecryptionFailedError);
    });

    it('fails when the last-chunk flag is flipped', () => {
      const key = generateContentKey();

      const blob = encryptMediaChunk(key, at(3, false), randomBytes(64));

      expect(() => decryptMediaChunk(key, at(3, true), blob)).toThrow(DecryptionFailedError);
    });

    it('fails with the wrong key', () => {
      const blob = encryptMediaChunk(generateContentKey(), at(0, true), randomBytes(64));

      expect(() => decryptMediaChunk(generateContentKey(), at(0, true), blob)).toThrow(
        DecryptionFailedError
      );
    });

    it('fails when a same-index chunk from another stream under the same key is presented', () => {
      const key = generateContentKey();

      const foreign = encryptMediaChunk(key, at(3, false, 'content-other'), randomBytes(64));

      expect(() => decryptMediaChunk(key, at(3, false), foreign)).toThrow(DecryptionFailedError);
    });

    it('rejects an unknown version byte with a typed error', () => {
      const key = generateContentKey();

      const blob = encryptMediaChunk(key, at(0, true), randomBytes(64));
      const downgraded = new Uint8Array(blob);
      downgraded[0] = 0x01;

      expect(() => decryptMediaChunk(key, at(0, true), downgraded)).toThrow(
        UnknownBlobVersionError
      );
    });

    it('rejects a blob shorter than the minimum length', () => {
      const key = generateContentKey();

      expect(() =>
        decryptMediaChunk(key, at(0, true), Uint8Array.of(BLOB_FORMAT_VERSION, 9))
      ).toThrow(MalformedBlobError);
    });
  });

  describe('encryptMediaStream', () => {
    it('marks only the final chunk as last', () => {
      const key = generateContentKey();
      const chunks = [randomBytes(32), randomBytes(32), randomBytes(32)];

      const blobs = encryptMediaStream(key, CONTENT_ID, chunks);

      expect(blobs).toHaveLength(3);
      expect(decryptMediaChunk(key, at(2, true), blobs[2]!)).toEqual(chunks[2]);
      expect(() => decryptMediaChunk(key, at(0, true), blobs[0]!)).toThrow(DecryptionFailedError);
    });

    it('rejects an empty chunk list', () => {
      expect(() => encryptMediaStream(generateContentKey(), CONTENT_ID, [])).toThrow(
        ChunkStreamError
      );
    });
  });

  describe('decryptMediaStream', () => {
    it('round-trips a multi-chunk stream', () => {
      const key = generateContentKey();
      const chunks = [randomBytes(1000), randomBytes(1000), randomBytes(500)];

      const blobs = encryptMediaStream(key, CONTENT_ID, chunks);
      const decrypted = decryptMediaStream(key, CONTENT_ID, blobs);

      expect(decrypted).toEqual(
        new Uint8Array([...(chunks[0] ?? []), ...(chunks[1] ?? []), ...(chunks[2] ?? [])])
      );
    });

    it('round-trips a single-chunk stream', () => {
      const key = generateContentKey();
      const chunk = randomBytes(64);

      const blobs = encryptMediaStream(key, CONTENT_ID, [chunk]);
      const decrypted = decryptMediaStream(key, CONTENT_ID, blobs);

      expect(decrypted).toEqual(chunk);
    });

    it('round-trips a multi-MiB multi-chunk stream', () => {
      const key = generateContentKey();
      const mib = 1024 * 1024;
      const chunks = [patternBytes(2 * mib, 1), patternBytes(2 * mib, 2), patternBytes(2 * mib, 3)];

      const blobs = encryptMediaStream(key, CONTENT_ID, chunks);
      const decrypted = decryptMediaStream(key, CONTENT_ID, blobs);

      expect(decrypted.length).toBe(6 * mib);
      expect(decrypted.subarray(0, 2 * mib)).toEqual(chunks[0]);
      expect(decrypted.subarray(4 * mib)).toEqual(chunks[2]);
    });

    it('round-trips unicode plaintext bytes', () => {
      const key = generateContentKey();
      const text = '混合 unicode → emoji 🎉 and ñ accents ﷽';
      const encoded = new TextEncoder().encode(text);

      const blobs = encryptMediaStream(key, CONTENT_ID, [encoded]);
      const decrypted = decryptMediaStream(key, CONTENT_ID, blobs);

      expect(new TextDecoder().decode(decrypted)).toBe(text);
    });

    it('round-trips with a unicode contentId', () => {
      const key = generateContentKey();
      const contentId = 'コンテンツ-🎬-id';
      const chunk = randomBytes(64);

      const blobs = encryptMediaStream(key, contentId, [chunk]);
      const decrypted = decryptMediaStream(key, contentId, blobs);

      expect(decrypted).toEqual(chunk);
    });

    it('fails when a same-index chunk is swapped in from another stream under the same key', () => {
      const key = generateContentKey();
      const blobsA = encryptMediaStream(key, 'content-a', [
        randomBytes(32),
        randomBytes(32),
        randomBytes(32),
      ]);
      const blobsB = encryptMediaStream(key, 'content-b', [
        randomBytes(32),
        randomBytes(32),
        randomBytes(32),
      ]);
      const spliced = [blobsA[0], blobsB[1], blobsA[2]] as Uint8Array[];

      expect(() => decryptMediaStream(key, 'content-a', spliced)).toThrow(DecryptionFailedError);
    });

    it('fails on a reordered stream', () => {
      const key = generateContentKey();
      const blobs = encryptMediaStream(key, CONTENT_ID, [
        randomBytes(32),
        randomBytes(32),
        randomBytes(32),
      ]);
      const reordered = [blobs[1], blobs[0], blobs[2]] as Uint8Array[];

      expect(() => decryptMediaStream(key, CONTENT_ID, reordered)).toThrow(DecryptionFailedError);
    });

    it('fails on a duplicated chunk', () => {
      const key = generateContentKey();
      const blobs = encryptMediaStream(key, CONTENT_ID, [
        randomBytes(32),
        randomBytes(32),
        randomBytes(32),
      ]);
      const duplicated = [blobs[0], blobs[1], blobs[1], blobs[2]] as Uint8Array[];

      expect(() => decryptMediaStream(key, CONTENT_ID, duplicated)).toThrow(DecryptionFailedError);
    });

    it('fails on a truncated stream missing the last chunk', () => {
      const key = generateContentKey();
      const blobs = encryptMediaStream(key, CONTENT_ID, [
        randomBytes(32),
        randomBytes(32),
        randomBytes(32),
      ]);
      const truncated = blobs.slice(0, 2);

      expect(() => decryptMediaStream(key, CONTENT_ID, truncated)).toThrow(DecryptionFailedError);
    });

    it('rejects an empty blob list', () => {
      expect(() => decryptMediaStream(generateContentKey(), CONTENT_ID, [])).toThrow(
        ChunkStreamError
      );
    });
  });
});
