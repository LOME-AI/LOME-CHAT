import { describe, it, expect } from 'vitest';
import { wrapEpochKeyForNewMember } from './member.js';
import { generateKeyPair } from './sharing.js';
import { createFirstEpoch, unwrapEpochKey } from './epoch-lifecycle.js';
import { DecryptionError } from './crypto-errors.js';

describe('member', () => {
  describe('wrapEpochKeyForNewMember', () => {
    it('returns a Uint8Array blob', () => {
      const member = generateKeyPair();
      const epoch = createFirstEpoch([generateKeyPair().publicKey]);

      const wrap = wrapEpochKeyForNewMember(epoch.epochPrivateKey, member.publicKey);

      expect(wrap).toBeInstanceOf(Uint8Array);
    });

    it('new member can unwrap to get epoch private key', () => {
      const existingMember = generateKeyPair();
      const newMember = generateKeyPair();
      const epoch = createFirstEpoch([existingMember.publicKey]);

      const wrap = wrapEpochKeyForNewMember(epoch.epochPrivateKey, newMember.publicKey);
      const unwrapped = unwrapEpochKey(newMember.privateKey, wrap);

      expect(unwrapped).toEqual(epoch.epochPrivateKey);
    });

    it('wrong private key cannot unwrap', () => {
      const newMember = generateKeyPair();
      const wrongMember = generateKeyPair();
      const epoch = createFirstEpoch([generateKeyPair().publicKey]);

      const wrap = wrapEpochKeyForNewMember(epoch.epochPrivateKey, newMember.publicKey);

      expect(() => unwrapEpochKey(wrongMember.privateKey, wrap)).toThrow(DecryptionError);
    });

    it('produces different blobs per call due to ephemeral keys', () => {
      const member = generateKeyPair();
      const epoch = createFirstEpoch([generateKeyPair().publicKey]);

      const wrap1 = wrapEpochKeyForNewMember(epoch.epochPrivateKey, member.publicKey);
      const wrap2 = wrapEpochKeyForNewMember(epoch.epochPrivateKey, member.publicKey);

      expect(wrap1).not.toEqual(wrap2);
    });

    it('wraps for multiple members yield same epoch key', () => {
      const member1 = generateKeyPair();
      const member2 = generateKeyPair();
      const epoch = createFirstEpoch([generateKeyPair().publicKey]);

      const wrap1 = wrapEpochKeyForNewMember(epoch.epochPrivateKey, member1.publicKey);
      const wrap2 = wrapEpochKeyForNewMember(epoch.epochPrivateKey, member2.publicKey);

      const key1 = unwrapEpochKey(member1.privateKey, wrap1);
      const key2 = unwrapEpochKey(member2.privateKey, wrap2);

      expect(key1).toEqual(key2);
      expect(key1).toEqual(epoch.epochPrivateKey);
    });
  });
});
