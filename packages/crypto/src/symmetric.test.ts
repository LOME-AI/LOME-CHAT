import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { symmetricEncrypt, symmetricDecrypt } from './symmetric.js';
import { DecryptionError, InvalidBlobError } from './crypto-errors.js';

describe('symmetric', () => {
  const key = randomBytes(32);

  describe('symmetricEncrypt', () => {
    it('returns a Uint8Array blob', () => {
      const plaintext = new TextEncoder().encode('Hello');

      const blob = symmetricEncrypt(key, plaintext);

      expect(blob).toBeInstanceOf(Uint8Array);
    });

    it('has 40 bytes overhead (24 nonce + 16 tag)', () => {
      const plaintext = new TextEncoder().encode('Hello');

      const blob = symmetricEncrypt(key, plaintext);

      expect(blob.length).toBe(plaintext.length + 40);
    });

    it('produces different blobs per call due to random nonce', () => {
      const plaintext = new TextEncoder().encode('Hello');

      const blob1 = symmetricEncrypt(key, plaintext);
      const blob2 = symmetricEncrypt(key, plaintext);

      expect(blob1).not.toEqual(blob2);
    });

    it('first 24 bytes are the nonce', () => {
      const plaintext = new TextEncoder().encode('Hello');

      const blob1 = symmetricEncrypt(key, plaintext);
      const blob2 = symmetricEncrypt(key, plaintext);

      const nonce1 = blob1.slice(0, 24);
      const nonce2 = blob2.slice(0, 24);
      expect(nonce1).not.toEqual(nonce2);
    });
  });

  describe('symmetricDecrypt', () => {
    it('round-trips encrypt and decrypt', () => {
      const plaintext = new TextEncoder().encode('Secret message');

      const blob = symmetricEncrypt(key, plaintext);
      const decrypted = symmetricDecrypt(key, blob);

      expect(decrypted).toEqual(plaintext);
    });

    it('handles empty plaintext', () => {
      const plaintext = new Uint8Array(0);

      const blob = symmetricEncrypt(key, plaintext);
      const decrypted = symmetricDecrypt(key, blob);

      expect(decrypted).toEqual(plaintext);
      expect(blob.length).toBe(40);
    });

    it('handles large plaintext', () => {
      const plaintext = new TextEncoder().encode('x'.repeat(100_000));

      const blob = symmetricEncrypt(key, plaintext);
      const decrypted = symmetricDecrypt(key, blob);

      expect(decrypted).toEqual(plaintext);
    });

    it('handles binary data', () => {
      const plaintext = new Uint8Array(256);
      for (let index = 0; index < 256; index++) plaintext[index] = index;

      const blob = symmetricEncrypt(key, plaintext);
      const decrypted = symmetricDecrypt(key, blob);

      expect(decrypted).toEqual(plaintext);
    });

    it('throws DecryptionError with wrong key', () => {
      const plaintext = new TextEncoder().encode('Secret');
      const wrongKey = randomBytes(32);

      const blob = symmetricEncrypt(key, plaintext);

      expect(() => symmetricDecrypt(wrongKey, blob)).toThrow(DecryptionError);
    });

    it('throws DecryptionError with tampered ciphertext', () => {
      const plaintext = new TextEncoder().encode('Secret');

      const blob = symmetricEncrypt(key, plaintext);
      const tampered = new Uint8Array(blob);
      tampered[24] = (tampered[24] ?? 0) ^ 0xff;

      expect(() => symmetricDecrypt(key, tampered)).toThrow(DecryptionError);
    });

    it('throws DecryptionError with tampered nonce', () => {
      const plaintext = new TextEncoder().encode('Secret');

      const blob = symmetricEncrypt(key, plaintext);
      const tampered = new Uint8Array(blob);
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;

      expect(() => symmetricDecrypt(key, tampered)).toThrow(DecryptionError);
    });

    it('throws InvalidBlobError for truncated blob', () => {
      expect(() => symmetricDecrypt(key, new Uint8Array(39))).toThrow(InvalidBlobError);
      expect(() => symmetricDecrypt(key, new Uint8Array(0))).toThrow(InvalidBlobError);
    });
  });
});
