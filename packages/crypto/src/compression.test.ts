import { describe, it, expect } from 'vitest';
import { deflateSync } from 'fflate';
import {
  compress,
  decompress,
  compressIfSmaller,
  MAX_DECOMPRESSED_MESSAGE_BYTES,
} from './compression.js';
import { DecompressionCapError } from './errors.js';

const MIB = 1024 * 1024;

describe('compression', () => {
  describe('compress/decompress', () => {
    it('compresses and decompresses data correctly', () => {
      const original = new TextEncoder().encode('Hello, World! '.repeat(100));

      const compressed = compress(original);
      const decompressed = decompress(compressed);

      expect(decompressed).toEqual(original);
    });

    it('compressed data is smaller than original for repetitive content', () => {
      const original = new TextEncoder().encode('AAAAAAAAAA'.repeat(1000));

      const compressed = compress(original);

      expect(compressed.length).toBeLessThan(original.length);
    });

    it('uses raw deflate format (no gzip header)', () => {
      const original = new TextEncoder().encode('Hello, World! '.repeat(100));

      const compressed = compress(original);

      // Gzip format starts with magic bytes 0x1f 0x8b
      // Raw deflate does NOT have these bytes
      const hasGzipHeader = compressed[0] === 0x1f && compressed[1] === 0x8b;
      expect(hasGzipHeader).toBe(false);
    });

    it('handles empty data', () => {
      const original = new Uint8Array(0);

      const compressed = compress(original);
      const decompressed = decompress(compressed);

      expect(decompressed).toEqual(original);
    });

    it('aborts a 64 MiB deflate bomb instead of inflating it', () => {
      // 64 MiB of zeros deflates to a few tens of KiB — a payload that
      // decrypts legitimately but would inflate unboundedly on every
      // member's client without a cap.
      const bomb = deflateSync(new Uint8Array(64 * MIB));

      try {
        decompress(bomb);
        expect.unreachable('decompress must abort');
      } catch (error) {
        expect(error).toBeInstanceOf(DecompressionCapError);
        const capError = error as DecompressionCapError;
        expect(capError.capBytes).toBe(MAX_DECOMPRESSED_MESSAGE_BYTES);
        // Mid-inflate abort: bounded by the cap plus one input slice's
        // worst-case DEFLATE expansion (1024 B × 1032), nowhere near 64 MiB.
        expect(capError.bytesInflated).toBeGreaterThan(MAX_DECOMPRESSED_MESSAGE_BYTES);
        expect(capError.bytesInflated).toBeLessThan(MAX_DECOMPRESSED_MESSAGE_BYTES + 1024 * 1032);
      }
    });

    it('round-trips a payload just under the message cap', () => {
      const original = new TextEncoder().encode('a'.repeat(MAX_DECOMPRESSED_MESSAGE_BYTES - 1));

      expect(decompress(compress(original))).toEqual(original);
    });

    it('handles unicode text', () => {
      const text = '你好世界 🌍 مرحبا '.repeat(50);
      const original = new TextEncoder().encode(text);

      const compressed = compress(original);
      const decompressed = decompress(compressed);

      expect(new TextDecoder().decode(decompressed)).toBe(text);
    });
  });

  describe('compressIfSmaller', () => {
    it('returns compressed data when smaller', () => {
      const original = new TextEncoder().encode('AAAAAAAAAA'.repeat(1000));

      const { result, compressed } = compressIfSmaller(original);

      expect(compressed).toBe(true);
      expect(result.length).toBeLessThan(original.length);
    });

    it('returns original data when compression makes it larger', () => {
      // Random data doesn't compress well
      const original = new Uint8Array(100);
      for (let index = 0; index < original.length; index++) {
        original[index] = Math.floor(Math.random() * 256);
      }

      const { result, compressed } = compressIfSmaller(original);

      expect(compressed).toBe(false);
      expect(result).toEqual(original);
    });

    it('decompressed result matches original when compressed', () => {
      const original = new TextEncoder().encode('Hello, World! '.repeat(100));

      const { result, compressed } = compressIfSmaller(original);

      if (compressed) {
        const decompressed = decompress(result);
        expect(decompressed).toEqual(original);
      } else {
        expect(result).toEqual(original);
      }
    });
  });
});
