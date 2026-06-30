import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  KEY_BYTES,
  asAccountPrivateKey,
  asAccountPublicKey,
  asWrappingPrivateKey,
  asWrappingPublicKey,
  asEpochPrivateKey,
  asEpochPublicKey,
  asContentKey,
  asShareSecret,
  generateAccountKeyPair,
  generateEpochKeyPair,
  generateContentKey,
} from './keys.js';
import { InvalidKeyError } from './errors.js';

const validators = [
  ['asAccountPrivateKey', asAccountPrivateKey],
  ['asAccountPublicKey', asAccountPublicKey],
  ['asWrappingPrivateKey', asWrappingPrivateKey],
  ['asWrappingPublicKey', asWrappingPublicKey],
  ['asEpochPrivateKey', asEpochPrivateKey],
  ['asEpochPublicKey', asEpochPublicKey],
  ['asContentKey', asContentKey],
  ['asShareSecret', asShareSecret],
] as const;

describe('keys', () => {
  it('KEY_BYTES is 32', () => {
    expect(KEY_BYTES).toBe(32);
  });

  describe.each(validators)('%s', (_name, validate) => {
    it('brands 32-byte material, preserving the bytes', () => {
      const bytes = randomBytes(KEY_BYTES);

      const key = validate(bytes);

      expect(new Uint8Array(key)).toEqual(new Uint8Array(bytes));
      expect(key.length).toBe(KEY_BYTES);
    });

    it('rejects material shorter than 32 bytes', () => {
      expect(() => validate(randomBytes(KEY_BYTES - 1))).toThrow(InvalidKeyError);
    });

    it('rejects material longer than 32 bytes', () => {
      expect(() => validate(randomBytes(KEY_BYTES + 1))).toThrow(InvalidKeyError);
    });

    it('rejects empty material', () => {
      expect(() => validate(new Uint8Array(0))).toThrow(InvalidKeyError);
    });
  });

  describe('generateAccountKeyPair', () => {
    it('returns an X25519 keypair whose public key matches the private key', () => {
      const pair = generateAccountKeyPair();

      expect(new Uint8Array(pair.publicKey)).toEqual(x25519.getPublicKey(pair.privateKey));
    });

    it('returns fresh material per call', () => {
      expect(generateAccountKeyPair().privateKey).not.toEqual(generateAccountKeyPair().privateKey);
    });
  });

  describe('generateEpochKeyPair', () => {
    it('returns an X25519 keypair whose public key matches the private key', () => {
      const pair = generateEpochKeyPair();

      expect(new Uint8Array(pair.publicKey)).toEqual(x25519.getPublicKey(pair.privateKey));
    });

    it('returns fresh material per call', () => {
      expect(generateEpochKeyPair().privateKey).not.toEqual(generateEpochKeyPair().privateKey);
    });
  });

  describe('generateContentKey', () => {
    it('returns 32 random bytes', () => {
      const key = generateContentKey();

      expect(key.length).toBe(KEY_BYTES);
    });

    it('returns fresh material per call', () => {
      expect(generateContentKey()).not.toEqual(generateContentKey());
    });
  });
});
