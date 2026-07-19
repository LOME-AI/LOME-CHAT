import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { createSharedLink, deriveKeysFromLinkSecret, LINK_INFO } from './link.js';
import { generateKeyPair } from './sharing.js';
import { createFirstEpoch, unwrapEpochKey } from './epoch-lifecycle.js';
import { DecryptionError } from './crypto-errors.js';

describe('link', () => {
  it('uses link-keypair-v1 as HKDF info string', () => {
    expect(LINK_INFO).toBe('link-keypair-v1');
  });

  describe('createSharedLink', () => {
    it('returns linkSecret, linkPublicKey, and linkWrap', () => {
      const epoch = createFirstEpoch(
        [generateKeyPair().publicKey],
        '00000000-0000-7000-8000-000000000abc',
        1
      );

      const result = createSharedLink(epoch.epochPrivateKey);

      expect(result.linkSecret).toBeInstanceOf(Uint8Array);
      expect(result.linkSecret.length).toBe(32);
      expect(result.linkPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.linkPublicKey.length).toBe(32);
      expect(result.linkWrap).toBeInstanceOf(Uint8Array);
    });

    it('generates unique secrets per call', () => {
      const epoch = createFirstEpoch(
        [generateKeyPair().publicKey],
        '00000000-0000-7000-8000-000000000abc',
        1
      );

      const result1 = createSharedLink(epoch.epochPrivateKey);
      const result2 = createSharedLink(epoch.epochPrivateKey);

      expect(result1.linkSecret).not.toEqual(result2.linkSecret);
      expect(result1.linkPublicKey).not.toEqual(result2.linkPublicKey);
    });

    it('linkPublicKey corresponds to key derived from linkSecret', () => {
      const epoch = createFirstEpoch(
        [generateKeyPair().publicKey],
        '00000000-0000-7000-8000-000000000abc',
        1
      );

      const result = createSharedLink(epoch.epochPrivateKey);
      const derivedKeyPair = deriveKeysFromLinkSecret(result.linkSecret);

      expect(derivedKeyPair.publicKey).toEqual(result.linkPublicKey);
    });
  });

  describe('deriveKeysFromLinkSecret', () => {
    it('returns a key pair with 32-byte keys', () => {
      const secret = randomBytes(32);

      const { publicKey, privateKey } = deriveKeysFromLinkSecret(secret);

      expect(publicKey).toBeInstanceOf(Uint8Array);
      expect(publicKey.length).toBe(32);
      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(privateKey.length).toBe(32);
    });

    it('produces deterministic output for same secret', () => {
      const secret = randomBytes(32);

      const kp1 = deriveKeysFromLinkSecret(secret);
      const kp2 = deriveKeysFromLinkSecret(secret);

      expect(kp1.publicKey).toEqual(kp2.publicKey);
      expect(kp1.privateKey).toEqual(kp2.privateKey);
    });

    it('produces different output for different secrets', () => {
      const kp1 = deriveKeysFromLinkSecret(randomBytes(32));
      const kp2 = deriveKeysFromLinkSecret(randomBytes(32));

      expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    });
  });

  describe('end-to-end link flow', () => {
    it('link secret holder can decrypt epoch key via link wrap', () => {
      const member = generateKeyPair();
      const epoch = createFirstEpoch([member.publicKey], '00000000-0000-7000-8000-000000000abc', 1);

      const link = createSharedLink(epoch.epochPrivateKey);

      const linkKeyPair = deriveKeysFromLinkSecret(link.linkSecret);
      const epochKey = unwrapEpochKey(linkKeyPair.privateKey, link.linkWrap);

      expect(epochKey).toEqual(epoch.epochPrivateKey);
    });

    it('wrong secret cannot decrypt link wrap', () => {
      const epoch = createFirstEpoch(
        [generateKeyPair().publicKey],
        '00000000-0000-7000-8000-000000000abc',
        1
      );

      const link = createSharedLink(epoch.epochPrivateKey);

      const wrongKeyPair = deriveKeysFromLinkSecret(randomBytes(32));

      expect(() => unwrapEpochKey(wrongKeyPair.privateKey, link.linkWrap)).toThrow(DecryptionError);
    });
  });
});
