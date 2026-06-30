import { describe, it, expect } from 'vitest';
import { deflateSync } from 'fflate';
import {
  encodeForEncryption,
  decodeFromDecryption,
  encodeBinary,
  decodeBinary,
} from './message-codec.js';
import { InvalidBlobError } from './crypto-errors.js';
import { DecompressionCapError } from './errors.js';

const FLAG_UNCOMPRESSED = 0x00;
const FLAG_COMPRESSED = 0x01;
const FLAG_BINARY_UNCOMPRESSED = 0x02;

describe('message-codec', () => {
  describe('encodeForEncryption', () => {
    it('prepends 0x00 flag for short string that does not benefit from compression', () => {
      const result = encodeForEncryption('Hello');

      expect(result[0]).toBe(FLAG_UNCOMPRESSED);
      expect(result.length).toBeGreaterThan(1);
    });

    it('prepends 0x01 flag for long repetitive string that compresses well', () => {
      const result = encodeForEncryption('A'.repeat(10_000));

      expect(result[0]).toBe(FLAG_COMPRESSED);
      expect(result.length).toBeLessThan(10_000);
    });

    it('produces payload whose data portion matches original bytes when uncompressed', () => {
      const text = 'Hello';
      const result = encodeForEncryption(text);
      const originalBytes = new TextEncoder().encode(text);

      expect(result.subarray(1)).toEqual(originalBytes);
    });

    it('handles empty string', () => {
      const result = encodeForEncryption('');

      expect(result[0]).toBe(FLAG_UNCOMPRESSED);
      // Flag byte + empty data (deflate of empty would be larger)
      expect(result.length).toBe(1);
    });

    it('handles unicode text', () => {
      const text = '你好世界 🌍 مرحبا';
      const result = encodeForEncryption(text);

      expect(result[0]).toBe(FLAG_UNCOMPRESSED);
      expect(result.length).toBeGreaterThan(1);
    });
  });

  describe('decodeFromDecryption', () => {
    it('decodes uncompressed payload (0x00 flag)', () => {
      const text = 'Hello, World!';
      const textBytes = new TextEncoder().encode(text);
      const payload = new Uint8Array(1 + textBytes.length);
      payload[0] = FLAG_UNCOMPRESSED;
      payload.set(textBytes, 1);

      const result = decodeFromDecryption(payload);

      expect(result).toBe(text);
    });

    it('decodes compressed payload (0x01 flag)', () => {
      const text = 'B'.repeat(10_000);
      const encoded = encodeForEncryption(text);

      expect(encoded[0]).toBe(FLAG_COMPRESSED);

      const result = decodeFromDecryption(encoded);

      expect(result).toBe(text);
    });

    it('handles empty string payload', () => {
      const payload = new Uint8Array([FLAG_UNCOMPRESSED]);

      const result = decodeFromDecryption(payload);

      expect(result).toBe('');
    });

    it('aborts a crafted compressed-flag deflate bomb', () => {
      // A hostile conversation member can produce this payload: it encrypts
      // and decrypts legitimately, so the codec is the last line of defense.
      const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024));
      const payload = new Uint8Array(1 + bomb.length);
      payload[0] = FLAG_COMPRESSED;
      payload.set(bomb, 1);

      expect(() => decodeFromDecryption(payload)).toThrow(DecompressionCapError);
    });
  });

  describe('round-trip', () => {
    it('round-trips short text through encode/decode', () => {
      const text = 'Short message';

      const encoded = encodeForEncryption(text);
      const decoded = decodeFromDecryption(encoded);

      expect(decoded).toBe(text);
    });

    it('round-trips long text through encode/decode', () => {
      const text = 'This is a longer message that should compress. '.repeat(500);

      const encoded = encodeForEncryption(text);
      const decoded = decodeFromDecryption(encoded);

      expect(decoded).toBe(text);
    });

    it('round-trips unicode text', () => {
      const text = '你好世界 🌍 مرحبا '.repeat(200);

      const encoded = encodeForEncryption(text);
      const decoded = decodeFromDecryption(encoded);

      expect(decoded).toBe(text);
    });

    it('round-trips empty string', () => {
      const text = '';

      const encoded = encodeForEncryption(text);
      const decoded = decodeFromDecryption(encoded);

      expect(decoded).toBe(text);
    });
  });

  describe('encodeBinary', () => {
    it('prepends 0x02 binary flag', () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);

      const encoded = encodeBinary(bytes);

      expect(encoded[0]).toBe(FLAG_BINARY_UNCOMPRESSED);
      expect(encoded.length).toBe(bytes.length + 1);
    });

    it('stores bytes verbatim with no compression', () => {
      const bytes = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);

      const encoded = encodeBinary(bytes);

      expect(encoded.subarray(1)).toEqual(bytes);
    });

    it('handles empty bytes', () => {
      const encoded = encodeBinary(new Uint8Array(0));

      expect(encoded.length).toBe(1);
      expect(encoded[0]).toBe(FLAG_BINARY_UNCOMPRESSED);
    });
  });

  describe('decodeBinary', () => {
    it('strips the flag byte and returns the original bytes', () => {
      const bytes = new Uint8Array([9, 8, 7, 6, 5]);
      const encoded = encodeBinary(bytes);

      const decoded = decodeBinary(encoded);

      expect(decoded).toEqual(bytes);
    });

    it('round-trips empty bytes', () => {
      const encoded = encodeBinary(new Uint8Array(0));

      const decoded = decodeBinary(encoded);

      expect(decoded.length).toBe(0);
    });

    it('throws InvalidBlobError on wrong flag', () => {
      const payload = new Uint8Array([FLAG_UNCOMPRESSED, 1, 2, 3]);

      expect(() => decodeBinary(payload)).toThrow(InvalidBlobError);
    });

    it('throws InvalidBlobError on empty payload', () => {
      expect(() => decodeBinary(new Uint8Array(0))).toThrow(InvalidBlobError);
    });
  });

  describe('flag isolation', () => {
    it('decodeFromDecryption throws on a binary flag payload', () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const binary = encodeBinary(bytes);

      expect(() => decodeFromDecryption(binary)).toThrow(InvalidBlobError);
    });

    it('decodeBinary throws on a text payload', () => {
      const text = encodeForEncryption('hello');

      expect(() => decodeBinary(text)).toThrow(InvalidBlobError);
    });
  });
});
