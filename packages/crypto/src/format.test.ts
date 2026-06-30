import { describe, it, expect } from 'vitest';
import {
  BLOB_FORMAT_VERSION,
  assertKnownVersion,
  utf8Field,
  bytesField,
  u64Field,
} from './format.js';
import { InvalidParameterError, MalformedBlobError, UnknownBlobVersionError } from './errors.js';

describe('format', () => {
  describe('BLOB_FORMAT_VERSION', () => {
    it('is 0x02, distinct from the v1 ECIES version byte 0x01', () => {
      expect(BLOB_FORMAT_VERSION).toBe(0x02);
    });
  });

  describe('assertKnownVersion', () => {
    it('accepts a blob starting with the current version byte', () => {
      const blob = Uint8Array.of(BLOB_FORMAT_VERSION, 0xaa, 0xbb);

      expect(() => {
        assertKnownVersion(blob);
      }).not.toThrow();
    });

    it('throws MalformedBlobError for an empty blob', () => {
      expect(() => {
        assertKnownVersion(new Uint8Array(0));
      }).toThrow(MalformedBlobError);
    });

    it('throws UnknownBlobVersionError for an unknown version byte', () => {
      const blob = Uint8Array.of(0x01, 0xaa);

      expect(() => {
        assertKnownVersion(blob);
      }).toThrow(UnknownBlobVersionError);
    });

    it('reports the rejected version on the error', () => {
      const blob = Uint8Array.of(0x09);

      try {
        assertKnownVersion(blob);
        expect.unreachable('assertKnownVersion must throw');
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownBlobVersionError);
        expect((error as UnknownBlobVersionError).version).toBe(0x09);
      }
    });
  });

  describe('utf8Field', () => {
    it('encodes a string as a u32 big-endian length prefix plus UTF-8 bytes', () => {
      const encoded = utf8Field('abc');

      expect(encoded).toEqual(Uint8Array.of(0, 0, 0, 3, 0x61, 0x62, 0x63));
    });

    it('encodes the empty string as a zero length prefix', () => {
      const encoded = utf8Field('');

      expect(encoded).toEqual(Uint8Array.of(0, 0, 0, 0));
    });

    it('produces distinct encodings for ambiguous concatenations', () => {
      const ab_c = new Uint8Array([...utf8Field('ab'), ...utf8Field('c')]);
      const a_bc = new Uint8Array([...utf8Field('a'), ...utf8Field('bc')]);

      expect(ab_c).not.toEqual(a_bc);
    });
  });

  describe('bytesField', () => {
    it('encodes bytes as a u32 big-endian length prefix plus the bytes', () => {
      const encoded = bytesField(Uint8Array.of(0xff, 0xee));

      expect(encoded).toEqual(Uint8Array.of(0, 0, 0, 2, 0xff, 0xee));
    });
  });

  describe('u64Field', () => {
    it('encodes a non-negative integer as 8 big-endian bytes', () => {
      const encoded = u64Field(258, 'position');

      expect(encoded).toEqual(Uint8Array.of(0, 0, 0, 0, 0, 0, 1, 2));
    });

    it('encodes the maximum safe integer', () => {
      const encoded = u64Field(Number.MAX_SAFE_INTEGER, 'position');

      expect(encoded).toEqual(Uint8Array.of(0, 31, 255, 255, 255, 255, 255, 255));
    });

    it('throws InvalidParameterError for a negative value', () => {
      expect(() => u64Field(-1, 'position')).toThrow(InvalidParameterError);
    });

    it('throws InvalidParameterError for a non-integer value', () => {
      expect(() => u64Field(1.5, 'position')).toThrow(InvalidParameterError);
    });

    it('throws InvalidParameterError for an unsafe integer', () => {
      expect(() => u64Field(Number.MAX_SAFE_INTEGER + 2, 'position')).toThrow(
        InvalidParameterError
      );
    });

    it('names the offending field in the error message', () => {
      expect(() => u64Field(-3, 'epochNumber')).toThrow(/epochNumber/);
    });
  });
});
