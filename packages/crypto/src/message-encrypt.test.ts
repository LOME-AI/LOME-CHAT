import { describe, it, expect } from 'vitest';
import {
  beginMessageEnvelope,
  openMessageEnvelope,
  encryptTextForEpoch,
  decryptTextFromEpoch,
  encryptTextWithContentKey,
  decryptTextWithContentKey,
  encryptBinaryWithContentKey,
  decryptBinaryWithContentKey,
} from './message-encrypt.js';
import { generateContentKey, CONTENT_KEY_LENGTH } from './content-key.js';
import { generateKeyPair } from './sharing.js';
import { DecryptionError } from './crypto-errors.js';

describe('message-encrypt', () => {
  // Characterization: single-blob ECIES helpers for encrypted bytea fields on
  // non-message tables (conversation titles, custom instructions, etc.).
  describe('encryptTextForEpoch / decryptTextFromEpoch', () => {
    it('round-trips text under an epoch keypair', () => {
      const keyPair = generateKeyPair();
      const text = 'conversation title 密码🔐';

      const blob = encryptTextForEpoch(keyPair.publicKey, text);
      const decrypted = decryptTextFromEpoch(keyPair.privateKey, blob);

      expect(decrypted).toBe(text);
    });

    it('throws DecryptionError with the wrong private key', () => {
      const keyPair = generateKeyPair();
      const wrongKeyPair = generateKeyPair();

      const blob = encryptTextForEpoch(keyPair.publicKey, 'secret');

      expect(() => decryptTextFromEpoch(wrongKeyPair.privateKey, blob)).toThrow(DecryptionError);
    });
  });

  describe('beginMessageEnvelope', () => {
    it('returns a fresh content key and a wrapped copy', () => {
      const { publicKey } = generateKeyPair();

      const envelope = beginMessageEnvelope(publicKey);

      expect(envelope.contentKey).toBeInstanceOf(Uint8Array);
      expect(envelope.contentKey.length).toBe(CONTENT_KEY_LENGTH);
      expect(envelope.wrappedContentKey).toBeInstanceOf(Uint8Array);
      expect(envelope.wrappedContentKey).not.toEqual(envelope.contentKey);
    });

    it('produces a different envelope on each call', () => {
      const { publicKey } = generateKeyPair();

      const e1 = beginMessageEnvelope(publicKey);
      const e2 = beginMessageEnvelope(publicKey);

      expect(e1.contentKey).not.toEqual(e2.contentKey);
      expect(e1.wrappedContentKey).not.toEqual(e2.wrappedContentKey);
    });
  });

  describe('openMessageEnvelope', () => {
    it('recovers the content key with the matching private key', () => {
      const keyPair = generateKeyPair();
      const { contentKey, wrappedContentKey } = beginMessageEnvelope(keyPair.publicKey);

      const recovered = openMessageEnvelope(keyPair.privateKey, wrappedContentKey);

      expect(recovered).toEqual(contentKey);
    });

    it('throws DecryptionError with the wrong private key', () => {
      const keyPair = generateKeyPair();
      const wrongKeyPair = generateKeyPair();
      const { wrappedContentKey } = beginMessageEnvelope(keyPair.publicKey);

      expect(() => openMessageEnvelope(wrongKeyPair.privateKey, wrappedContentKey)).toThrow(
        DecryptionError
      );
    });
  });

  describe('encryptTextWithContentKey / decryptTextWithContentKey', () => {
    it('round-trips a short text message', () => {
      const contentKey = generateContentKey();
      const text = 'Hello, World!';

      const ciphertext = encryptTextWithContentKey(contentKey, text);
      const decrypted = decryptTextWithContentKey(contentKey, ciphertext);

      expect(decrypted).toBe(text);
    });

    it('round-trips a long text message with compression', () => {
      const contentKey = generateContentKey();
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(500);

      const ciphertext = encryptTextWithContentKey(contentKey, text);
      const decrypted = decryptTextWithContentKey(contentKey, ciphertext);

      expect(decrypted).toBe(text);
    });

    it('round-trips unicode text', () => {
      const contentKey = generateContentKey();
      const text = '密码🔐émojis 日本語 العربية';

      const ciphertext = encryptTextWithContentKey(contentKey, text);
      const decrypted = decryptTextWithContentKey(contentKey, ciphertext);

      expect(decrypted).toBe(text);
    });

    it('round-trips the empty string', () => {
      const contentKey = generateContentKey();

      const ciphertext = encryptTextWithContentKey(contentKey, '');
      const decrypted = decryptTextWithContentKey(contentKey, ciphertext);

      expect(decrypted).toBe('');
    });

    it('produces different ciphertext on repeated encryptions of the same plaintext (fresh nonce)', () => {
      const contentKey = generateContentKey();
      const text = 'Hello';

      const c1 = encryptTextWithContentKey(contentKey, text);
      const c2 = encryptTextWithContentKey(contentKey, text);

      expect(c1).not.toEqual(c2);
    });

    it('throws DecryptionError with wrong content key', () => {
      const contentKey = generateContentKey();
      const wrongKey = generateContentKey();

      const ciphertext = encryptTextWithContentKey(contentKey, 'secret');

      expect(() => decryptTextWithContentKey(wrongKey, ciphertext)).toThrow(DecryptionError);
    });
  });

  describe('encryptBinaryWithContentKey / decryptBinaryWithContentKey', () => {
    it('round-trips arbitrary bytes', () => {
      const contentKey = generateContentKey();
      const bytes = new Uint8Array([0, 1, 2, 255, 254, 253]);

      const ciphertext = encryptBinaryWithContentKey(contentKey, bytes);
      const decrypted = decryptBinaryWithContentKey(contentKey, ciphertext);

      expect(decrypted).toEqual(bytes);
    });

    it('round-trips empty bytes', () => {
      const contentKey = generateContentKey();

      const ciphertext = encryptBinaryWithContentKey(contentKey, new Uint8Array(0));
      const decrypted = decryptBinaryWithContentKey(contentKey, ciphertext);

      expect(decrypted.length).toBe(0);
    });

    it('round-trips large binary payloads (no compression)', () => {
      const contentKey = generateContentKey();
      const bytes = new Uint8Array(100_000);
      for (let index = 0; index < bytes.length; index++) {
        bytes[index] = index % 256;
      }

      const ciphertext = encryptBinaryWithContentKey(contentKey, bytes);
      const decrypted = decryptBinaryWithContentKey(contentKey, ciphertext);

      expect(decrypted).toEqual(bytes);
    });

    it('produces different ciphertext on repeated encryptions (fresh nonce)', () => {
      const contentKey = generateContentKey();
      const bytes = new Uint8Array([1, 2, 3, 4]);

      const c1 = encryptBinaryWithContentKey(contentKey, bytes);
      const c2 = encryptBinaryWithContentKey(contentKey, bytes);

      expect(c1).not.toEqual(c2);
    });

    it('throws DecryptionError with wrong content key', () => {
      const contentKey = generateContentKey();
      const wrongKey = generateContentKey();
      const bytes = new Uint8Array([9, 9, 9]);

      const ciphertext = encryptBinaryWithContentKey(contentKey, bytes);

      expect(() => decryptBinaryWithContentKey(wrongKey, ciphertext)).toThrow(DecryptionError);
    });
  });

  describe('wrap-once multi-item flow', () => {
    it('one content key can encrypt multiple text items and all decrypt with one unwrap', () => {
      const keyPair = generateKeyPair();
      const { contentKey, wrappedContentKey } = beginMessageEnvelope(keyPair.publicKey);

      const c1 = encryptTextWithContentKey(contentKey, 'first item');
      const c2 = encryptTextWithContentKey(contentKey, 'second item');
      const c3 = encryptTextWithContentKey(contentKey, 'third item');

      const recovered = openMessageEnvelope(keyPair.privateKey, wrappedContentKey);

      expect(decryptTextWithContentKey(recovered, c1)).toBe('first item');
      expect(decryptTextWithContentKey(recovered, c2)).toBe('second item');
      expect(decryptTextWithContentKey(recovered, c3)).toBe('third item');
    });

    it('one content key can mix text and binary items', () => {
      const keyPair = generateKeyPair();
      const { contentKey, wrappedContentKey } = beginMessageEnvelope(keyPair.publicKey);

      const textCipher = encryptTextWithContentKey(contentKey, 'caption');
      const binBytes = new Uint8Array([10, 20, 30, 40]);
      const binCipher = encryptBinaryWithContentKey(contentKey, binBytes);

      const recovered = openMessageEnvelope(keyPair.privateKey, wrappedContentKey);

      expect(decryptTextWithContentKey(recovered, textCipher)).toBe('caption');
      expect(decryptBinaryWithContentKey(recovered, binCipher)).toEqual(binBytes);
    });
  });
});
