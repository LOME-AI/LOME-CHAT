import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  generateContentKey,
  wrapContentKeyForEpoch,
  unwrapContentKeyForEpoch,
  wrapContentKeyForShare,
  unwrapContentKeyForShare,
  CONTENT_KEY_LENGTH,
  SHARE_WRAP_INFO,
} from './content-key.js';
import { generateKeyPair } from './sharing.js';
import { DecryptionError } from './crypto-errors.js';

describe('content-key', () => {
  it('uses share-wrap-v1 as the HKDF info string', () => {
    expect(SHARE_WRAP_INFO).toBe('share-wrap-v1');
  });

  it('CONTENT_KEY_LENGTH is 32 bytes', () => {
    expect(CONTENT_KEY_LENGTH).toBe(32);
  });

  describe('generateContentKey', () => {
    it('returns 32 random bytes', () => {
      const key = generateContentKey();

      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(CONTENT_KEY_LENGTH);
    });

    it('produces a different key on each call', () => {
      const key1 = generateContentKey();
      const key2 = generateContentKey();

      expect(key1).not.toEqual(key2);
    });
  });

  describe('wrapContentKeyForEpoch / unwrapContentKeyForEpoch', () => {
    it('round-trips a content key through ECIES wrap/unwrap', () => {
      const keyPair = generateKeyPair();
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyForEpoch(keyPair.publicKey, contentKey);
      const unwrapped = unwrapContentKeyForEpoch(keyPair.privateKey, wrapped);

      expect(unwrapped).toEqual(contentKey);
    });

    it('wrapped bytes are not the content key itself', () => {
      const keyPair = generateKeyPair();
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyForEpoch(keyPair.publicKey, contentKey);

      expect(wrapped).not.toEqual(contentKey);
    });

    it('produces different wrapped bytes on repeated calls (fresh ephemeral key)', () => {
      const keyPair = generateKeyPair();
      const contentKey = generateContentKey();

      const wrapped1 = wrapContentKeyForEpoch(keyPair.publicKey, contentKey);
      const wrapped2 = wrapContentKeyForEpoch(keyPair.publicKey, contentKey);

      expect(wrapped1).not.toEqual(wrapped2);
    });

    it('throws DecryptionError when unwrapping with the wrong private key', () => {
      const keyPair = generateKeyPair();
      const wrongKeyPair = generateKeyPair();
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyForEpoch(keyPair.publicKey, contentKey);

      expect(() => unwrapContentKeyForEpoch(wrongKeyPair.privateKey, wrapped)).toThrow(
        DecryptionError
      );
    });
  });

  describe('wrapContentKeyForShare / unwrapContentKeyForShare', () => {
    it('round-trips a content key through symmetric wrap/unwrap', () => {
      const shareSecret = randomBytes(32);
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyForShare(shareSecret, contentKey);
      const unwrapped = unwrapContentKeyForShare(shareSecret, wrapped);

      expect(unwrapped).toEqual(contentKey);
    });

    it('wrapped bytes are not the content key itself', () => {
      const shareSecret = randomBytes(32);
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyForShare(shareSecret, contentKey);

      expect(wrapped).not.toEqual(contentKey);
    });

    it('produces different wrapped bytes on repeated calls (fresh nonce)', () => {
      const shareSecret = randomBytes(32);
      const contentKey = generateContentKey();

      const wrapped1 = wrapContentKeyForShare(shareSecret, contentKey);
      const wrapped2 = wrapContentKeyForShare(shareSecret, contentKey);

      expect(wrapped1).not.toEqual(wrapped2);
    });

    it('throws DecryptionError when unwrapping with the wrong share secret', () => {
      const shareSecret = randomBytes(32);
      const wrongSecret = randomBytes(32);
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyForShare(shareSecret, contentKey);

      expect(() => unwrapContentKeyForShare(wrongSecret, wrapped)).toThrow(DecryptionError);
    });

    it('throws on a tampered wrapped blob', () => {
      const shareSecret = randomBytes(32);
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyForShare(shareSecret, contentKey);
      const tampered = new Uint8Array(wrapped) as typeof wrapped;
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;

      expect(() => unwrapContentKeyForShare(shareSecret, tampered)).toThrow();
    });
  });

  describe('cross-audience isolation', () => {
    it('a content key wrapped for a share cannot be unwrapped by an epoch private key', () => {
      const keyPair = generateKeyPair();
      const shareSecret = randomBytes(32);
      const contentKey = generateContentKey();

      const wrappedForShare = wrapContentKeyForShare(shareSecret, contentKey);

      expect(() => unwrapContentKeyForEpoch(keyPair.privateKey, wrappedForShare)).toThrow();
    });

    it('a content key wrapped for an epoch cannot be unwrapped by a share secret', () => {
      const keyPair = generateKeyPair();
      const shareSecret = randomBytes(32);
      const contentKey = generateContentKey();

      const wrappedForEpoch = wrapContentKeyForEpoch(keyPair.publicKey, contentKey);

      expect(() => unwrapContentKeyForShare(shareSecret, wrappedForEpoch)).toThrow();
    });
  });
});
