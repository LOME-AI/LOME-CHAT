import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { createShare, openShare } from './message-share.js';
import { generateContentKey } from './content-key.js';
import { DecryptionError } from './crypto-errors.js';

describe('message-share', () => {
  describe('createShare', () => {
    it('returns a 32-byte share secret and a wrapped share key', () => {
      const contentKey = generateContentKey();

      const result = createShare(contentKey);

      expect(result.shareSecret).toBeInstanceOf(Uint8Array);
      expect(result.shareSecret.length).toBe(32);
      expect(result.wrappedShareKey).toBeInstanceOf(Uint8Array);
    });

    it('does not leak the content key in the wrapped bytes', () => {
      const contentKey = generateContentKey();

      const { wrappedShareKey } = createShare(contentKey);

      expect(wrappedShareKey).not.toEqual(contentKey);
    });

    it('generates a unique share secret on each call', () => {
      const contentKey = generateContentKey();

      const r1 = createShare(contentKey);
      const r2 = createShare(contentKey);

      expect(r1.shareSecret).not.toEqual(r2.shareSecret);
      expect(r1.wrappedShareKey).not.toEqual(r2.wrappedShareKey);
    });
  });

  describe('openShare', () => {
    it('round-trips the content key with the matching share secret', () => {
      const contentKey = generateContentKey();

      const { shareSecret, wrappedShareKey } = createShare(contentKey);
      const recovered = openShare(shareSecret, wrappedShareKey);

      expect(recovered).toEqual(contentKey);
    });

    it('throws DecryptionError with a wrong share secret', () => {
      const contentKey = generateContentKey();
      const wrongSecret = randomBytes(32);

      const { wrappedShareKey } = createShare(contentKey);

      expect(() => openShare(wrongSecret, wrappedShareKey)).toThrow(DecryptionError);
    });

    it('throws on a tampered wrapped share key', () => {
      const contentKey = generateContentKey();

      const { shareSecret, wrappedShareKey } = createShare(contentKey);
      const tampered = new Uint8Array(wrappedShareKey) as typeof wrappedShareKey;
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;

      expect(() => openShare(shareSecret, tampered)).toThrow();
    });
  });
});
