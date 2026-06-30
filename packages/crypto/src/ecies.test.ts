import { describe, it, expect } from 'vitest';
import { eciesEncrypt, eciesDecrypt } from './ecies.js';
import { generateKeyPair } from './sharing.js';
import { DecryptionError, InvalidBlobError } from './crypto-errors.js';

describe('ecies', () => {
  describe('eciesEncrypt', () => {
    it('returns a Uint8Array blob', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('Hello, World!');

      const blob = eciesEncrypt(publicKey, plaintext);

      expect(blob).toBeInstanceOf(Uint8Array);
    });

    it('blob starts with version byte 0x01', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('Hello');

      const blob = eciesEncrypt(publicKey, plaintext);

      expect(blob[0]).toBe(0x01);
    });

    it('blob contains 32-byte ephemeral public key after version byte', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('Hello');

      const blob = eciesEncrypt(publicKey, plaintext);
      const ephemeralPub = blob.slice(1, 33);

      expect(ephemeralPub.length).toBe(32);
    });

    it('has 49 bytes overhead (1 version + 32 ephemeral + 16 tag)', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('Hello');

      const blob = eciesEncrypt(publicKey, plaintext);

      expect(blob.length).toBe(plaintext.length + 49);
    });

    it('produces different ephemeral keys per call', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('Hello');

      const blob1 = eciesEncrypt(publicKey, plaintext);
      const blob2 = eciesEncrypt(publicKey, plaintext);

      const eph1 = blob1.slice(1, 33);
      const eph2 = blob2.slice(1, 33);
      expect(eph1).not.toEqual(eph2);
    });

    it('produces different ciphertexts per call', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('Hello');

      const blob1 = eciesEncrypt(publicKey, plaintext);
      const blob2 = eciesEncrypt(publicKey, plaintext);

      expect(blob1).not.toEqual(blob2);
    });
  });

  describe('eciesDecrypt', () => {
    it('round-trips encrypt and decrypt', () => {
      const keyPair = generateKeyPair();
      const plaintext = new TextEncoder().encode('Secret message');

      const blob = eciesEncrypt(keyPair.publicKey, plaintext);
      const decrypted = eciesDecrypt(keyPair.privateKey, blob);

      expect(decrypted).toEqual(plaintext);
    });

    it('handles empty plaintext', () => {
      const keyPair = generateKeyPair();
      const plaintext = new Uint8Array(0);

      const blob = eciesEncrypt(keyPair.publicKey, plaintext);
      const decrypted = eciesDecrypt(keyPair.privateKey, blob);

      expect(decrypted).toEqual(plaintext);
      expect(blob.length).toBe(49);
    });

    it('handles large plaintext', () => {
      const keyPair = generateKeyPair();
      const plaintext = new TextEncoder().encode('x'.repeat(100_000));

      const blob = eciesEncrypt(keyPair.publicKey, plaintext);
      const decrypted = eciesDecrypt(keyPair.privateKey, blob);

      expect(decrypted).toEqual(plaintext);
    });

    it('handles binary data', () => {
      const keyPair = generateKeyPair();
      const plaintext = new Uint8Array(256);
      for (let index = 0; index < 256; index++) plaintext[index] = index;

      const blob = eciesEncrypt(keyPair.publicKey, plaintext);
      const decrypted = eciesDecrypt(keyPair.privateKey, blob);

      expect(decrypted).toEqual(plaintext);
    });

    it('throws DecryptionError with wrong private key', () => {
      const keyPair = generateKeyPair();
      const wrongKeyPair = generateKeyPair();
      const plaintext = new TextEncoder().encode('Secret');

      const blob = eciesEncrypt(keyPair.publicKey, plaintext);

      expect(() => eciesDecrypt(wrongKeyPair.privateKey, blob)).toThrow(DecryptionError);
    });

    it('throws DecryptionError with tampered ciphertext', () => {
      const keyPair = generateKeyPair();
      const plaintext = new TextEncoder().encode('Secret');

      const blob = eciesEncrypt(keyPair.publicKey, plaintext);
      const tampered = new Uint8Array(blob);
      tampered[33] = (tampered[33] ?? 0) ^ 0xff;

      expect(() => eciesDecrypt(keyPair.privateKey, tampered)).toThrow(DecryptionError);
    });

    it('throws DecryptionError with tampered ephemeral key', () => {
      const keyPair = generateKeyPair();
      const plaintext = new TextEncoder().encode('Secret');

      const blob = eciesEncrypt(keyPair.publicKey, plaintext);
      const tampered = new Uint8Array(blob);
      tampered[1] = (tampered[1] ?? 0) ^ 0xff;

      expect(() => eciesDecrypt(keyPair.privateKey, tampered)).toThrow(DecryptionError);
    });

    it('throws InvalidBlobError for truncated blob', () => {
      const keyPair = generateKeyPair();

      expect(() => eciesDecrypt(keyPair.privateKey, new Uint8Array(48))).toThrow(InvalidBlobError);
      expect(() => eciesDecrypt(keyPair.privateKey, new Uint8Array(0))).toThrow(InvalidBlobError);
    });

    it('throws InvalidBlobError for wrong version byte', () => {
      const keyPair = generateKeyPair();
      const plaintext = new TextEncoder().encode('Secret');

      const blob = eciesEncrypt(keyPair.publicKey, plaintext);
      const wrongVersion = new Uint8Array(blob);
      wrongVersion[0] = 0x02;

      expect(() => eciesDecrypt(keyPair.privateKey, wrongVersion)).toThrow(InvalidBlobError);
    });
  });
});
