import { describe, it, expect } from 'vitest';
import { at } from '@hushbox/shared/src/test-utilities.js';
import {
  createFirstEpoch,
  performEpochRotation,
  unwrapEpochKey,
  traverseChainLink,
  verifyEpochKeyConfirmation,
} from './epoch-lifecycle.js';
import { generateKeyPair } from './sharing.js';

describe('epoch', () => {
  describe('createFirstEpoch', () => {
    it('returns epoch key pair, confirmation hash, and member wraps', () => {
      const member = generateKeyPair();

      const result = createFirstEpoch([member.publicKey]);

      expect(result.epochPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.epochPublicKey.length).toBe(32);
      expect(result.epochPrivateKey).toBeInstanceOf(Uint8Array);
      expect(result.epochPrivateKey.length).toBe(32);
      expect(result.confirmationHash).toBeInstanceOf(Uint8Array);
      expect(result.confirmationHash.length).toBe(32);
      expect(result.memberWraps).toHaveLength(1);
    });

    it('creates wraps for multiple members', () => {
      const member1 = generateKeyPair();
      const member2 = generateKeyPair();
      const member3 = generateKeyPair();

      const result = createFirstEpoch([member1.publicKey, member2.publicKey, member3.publicKey]);

      expect(result.memberWraps).toHaveLength(3);
    });

    it('each member wrap contains the member public key and encrypted blob', () => {
      const member = generateKeyPair();

      const result = createFirstEpoch([member.publicKey]);

      expect(at(result.memberWraps, 0).memberPublicKey).toEqual(member.publicKey);
      expect(at(result.memberWraps, 0).wrap).toBeInstanceOf(Uint8Array);
    });

    it('each member can unwrap to get the epoch private key', () => {
      const member1 = generateKeyPair();
      const member2 = generateKeyPair();

      const result = createFirstEpoch([member1.publicKey, member2.publicKey]);

      const key1 = unwrapEpochKey(member1.privateKey, at(result.memberWraps, 0).wrap);
      const key2 = unwrapEpochKey(member2.privateKey, at(result.memberWraps, 1).wrap);

      expect(key1).toEqual(result.epochPrivateKey);
      expect(key2).toEqual(result.epochPrivateKey);
    });

    it('confirmation hash verifies against epoch private key', () => {
      const member = generateKeyPair();

      const result = createFirstEpoch([member.publicKey]);

      expect(verifyEpochKeyConfirmation(result.epochPrivateKey, result.confirmationHash)).toBe(
        true
      );
    });

    it('generates unique epoch keys per call', () => {
      const member = generateKeyPair();

      const result1 = createFirstEpoch([member.publicKey]);
      const result2 = createFirstEpoch([member.publicKey]);

      expect(result1.epochPublicKey).not.toEqual(result2.epochPublicKey);
    });
  });

  describe('performEpochRotation', () => {
    it('returns new epoch key pair, member wraps, and chain link', () => {
      const member = generateKeyPair();
      const epoch1 = createFirstEpoch([member.publicKey]);

      const result = performEpochRotation(epoch1.epochPrivateKey, [member.publicKey]);

      expect(result.epochPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.epochPublicKey.length).toBe(32);
      expect(result.epochPrivateKey).toBeInstanceOf(Uint8Array);
      expect(result.epochPrivateKey.length).toBe(32);
      expect(result.confirmationHash).toBeInstanceOf(Uint8Array);
      expect(result.memberWraps).toHaveLength(1);
      expect(result.chainLink).toBeInstanceOf(Uint8Array);
    });

    it('new epoch key is different from old epoch key', () => {
      const member = generateKeyPair();
      const epoch1 = createFirstEpoch([member.publicKey]);

      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [member.publicKey]);

      expect(epoch2.epochPublicKey).not.toEqual(epoch1.epochPublicKey);
      expect(epoch2.epochPrivateKey).not.toEqual(epoch1.epochPrivateKey);
    });

    it('member wraps for new epoch are valid', () => {
      const member = generateKeyPair();
      const epoch1 = createFirstEpoch([member.publicKey]);

      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [member.publicKey]);
      const unwrapped = unwrapEpochKey(member.privateKey, at(epoch2.memberWraps, 0).wrap);

      expect(unwrapped).toEqual(epoch2.epochPrivateKey);
    });

    it('chain link allows traversal to older epoch key', () => {
      const member = generateKeyPair();
      const epoch1 = createFirstEpoch([member.publicKey]);

      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [member.publicKey]);
      const recoveredOldKey = traverseChainLink(epoch2.epochPrivateKey, epoch2.chainLink);

      expect(recoveredOldKey).toEqual(epoch1.epochPrivateKey);
    });

    it('supports multiple rotations with chain traversal', () => {
      const member = generateKeyPair();
      const epoch1 = createFirstEpoch([member.publicKey]);
      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [member.publicKey]);
      const epoch3 = performEpochRotation(epoch2.epochPrivateKey, [member.publicKey]);

      const key2 = traverseChainLink(epoch3.epochPrivateKey, epoch3.chainLink);
      expect(key2).toEqual(epoch2.epochPrivateKey);

      const key1 = traverseChainLink(key2, epoch2.chainLink);
      expect(key1).toEqual(epoch1.epochPrivateKey);
    });

    it('can rotate with different member set', () => {
      const member1 = generateKeyPair();
      const member2 = generateKeyPair();
      const epoch1 = createFirstEpoch([member1.publicKey, member2.publicKey]);

      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [member1.publicKey]);

      expect(epoch2.memberWraps).toHaveLength(1);
      const unwrapped = unwrapEpochKey(member1.privateKey, at(epoch2.memberWraps, 0).wrap);
      expect(unwrapped).toEqual(epoch2.epochPrivateKey);
    });
  });

  describe('unwrapEpochKey', () => {
    it('unwraps epoch private key from member wrap', () => {
      const member = generateKeyPair();
      const epoch = createFirstEpoch([member.publicKey]);

      const key = unwrapEpochKey(member.privateKey, at(epoch.memberWraps, 0).wrap);

      expect(key).toEqual(epoch.epochPrivateKey);
    });

    it('throws with wrong member private key', () => {
      const member = generateKeyPair();
      const wrongMember = generateKeyPair();
      const epoch = createFirstEpoch([member.publicKey]);

      expect(() => unwrapEpochKey(wrongMember.privateKey, at(epoch.memberWraps, 0).wrap)).toThrow();
    });
  });

  describe('traverseChainLink', () => {
    it('recovers older epoch key from chain link', () => {
      const member = generateKeyPair();
      const epoch1 = createFirstEpoch([member.publicKey]);
      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [member.publicKey]);

      const recovered = traverseChainLink(epoch2.epochPrivateKey, epoch2.chainLink);

      expect(recovered).toEqual(epoch1.epochPrivateKey);
    });

    it('throws with wrong newer epoch key', () => {
      const member = generateKeyPair();
      const epoch1 = createFirstEpoch([member.publicKey]);
      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [member.publicKey]);
      const wrongKey = generateKeyPair();

      expect(() => traverseChainLink(wrongKey.privateKey, epoch2.chainLink)).toThrow();
    });
  });

  describe('verifyEpochKeyConfirmation', () => {
    it('returns true for matching key and hash', () => {
      const member = generateKeyPair();
      const epoch = createFirstEpoch([member.publicKey]);

      expect(verifyEpochKeyConfirmation(epoch.epochPrivateKey, epoch.confirmationHash)).toBe(true);
    });

    it('returns false for wrong key', () => {
      const member = generateKeyPair();
      const epoch = createFirstEpoch([member.publicKey]);
      const wrongKey = generateKeyPair();

      expect(verifyEpochKeyConfirmation(wrongKey.privateKey, epoch.confirmationHash)).toBe(false);
    });

    it('returns false for wrong hash', () => {
      const member = generateKeyPair();
      const epoch = createFirstEpoch([member.publicKey]);
      const wrongHash = new Uint8Array(32).fill(0xff);

      expect(verifyEpochKeyConfirmation(epoch.epochPrivateKey, wrongHash)).toBe(false);
    });
  });
});
