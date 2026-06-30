import { describe, it, expect } from 'vitest';
import {
  CONTENT_KEY_WRAP_LABEL,
  EPOCH_CONFIRMATION_BYTES,
  computeEpochConfirmation,
  verifyEpochConfirmation,
  wrapContentKeyToEpoch,
  unwrapContentKeyFromEpoch,
  decryptContentWithEpochChain,
} from './epoch.js';
import { encryptContentEnvelope } from './envelope.js';
import { generateContentKey, generateEpochKeyPair } from './keys.js';
import { unwrapSecret } from './wrap.js';
import { DecryptionFailedError, EpochNotInChainError, InvalidParameterError } from './errors.js';
import type { ContentLocation } from './envelope.js';
import type { EpochChainEntry } from './epoch.js';
import type { WrappedSecret } from './wrap.js';

const CONVERSATION_ID = 'conv-abc';

function locationAt(epochNumber: number): ContentLocation {
  return {
    conversationId: CONVERSATION_ID,
    messageId: 'msg-1',
    contentItemId: 'item-1',
    position: 0,
    epochNumber,
    senderId: 'user-1',
  };
}

describe('epoch', () => {
  describe('computeEpochConfirmation', () => {
    it('is deterministic for the same key and context', () => {
      const epoch = generateEpochKeyPair();

      const first = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 3);
      const second = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 3);

      expect(first).toEqual(second);
      expect(first.length).toBe(EPOCH_CONFIRMATION_BYTES);
    });

    it('differs across epoch private keys', () => {
      const confirmationA = computeEpochConfirmation(
        generateEpochKeyPair().privateKey,
        CONVERSATION_ID,
        3
      );
      const confirmationB = computeEpochConfirmation(
        generateEpochKeyPair().privateKey,
        CONVERSATION_ID,
        3
      );

      expect(confirmationA).not.toEqual(confirmationB);
    });

    it('differs across conversations (no cross-conversation replay)', () => {
      const epoch = generateEpochKeyPair();

      const here = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 3);
      const there = computeEpochConfirmation(epoch.privateKey, 'conv-other', 3);

      expect(here).not.toEqual(there);
    });

    it('differs across epoch numbers', () => {
      const epoch = generateEpochKeyPair();

      const three = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 3);
      const four = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 4);

      expect(three).not.toEqual(four);
    });

    it('rejects a negative epoch number', () => {
      const epoch = generateEpochKeyPair();

      expect(() => computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, -1)).toThrow(
        InvalidParameterError
      );
    });
  });

  describe('verifyEpochConfirmation', () => {
    it('returns true for a matching confirmation', () => {
      const epoch = generateEpochKeyPair();
      const confirmation = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 2);

      expect(verifyEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 2, confirmation)).toBe(
        true
      );
    });

    it('returns false for a confirmation from a different key', () => {
      const epoch = generateEpochKeyPair();
      const other = generateEpochKeyPair();
      const confirmation = computeEpochConfirmation(other.privateKey, CONVERSATION_ID, 2);

      expect(verifyEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 2, confirmation)).toBe(
        false
      );
    });

    it('returns false for a confirmation of the wrong length', () => {
      const epoch = generateEpochKeyPair();

      expect(verifyEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 2, new Uint8Array(8))).toBe(
        false
      );
    });
  });

  describe('wrapContentKeyToEpoch / unwrapContentKeyFromEpoch', () => {
    it('round-trips a content key through an epoch wrap', () => {
      const epoch = generateEpochKeyPair();
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyToEpoch(epoch.publicKey, contentKey);
      const unwrapped = unwrapContentKeyFromEpoch(epoch.privateKey, wrapped);

      expect(new Uint8Array(unwrapped)).toEqual(new Uint8Array(contentKey));
    });

    it('fails with the wrong epoch private key', () => {
      const epoch = generateEpochKeyPair();
      const other = generateEpochKeyPair();

      const wrapped = wrapContentKeyToEpoch(epoch.publicKey, generateContentKey());

      expect(() => unwrapContentKeyFromEpoch(other.privateKey, wrapped)).toThrow(
        DecryptionFailedError
      );
    });

    it('wraps under the exported domain-separation label', () => {
      const epoch = generateEpochKeyPair();
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyToEpoch(epoch.publicKey, contentKey);

      expect(unwrapSecret(epoch.privateKey, wrapped, CONTENT_KEY_WRAP_LABEL)).toEqual(
        new Uint8Array(contentKey)
      );
      expect(() => unwrapSecret(epoch.privateKey, wrapped, 'some-other-label')).toThrow(
        DecryptionFailedError
      );
    });
  });

  describe('decryptContentWithEpochChain', () => {
    const plaintext = new TextEncoder().encode('cross-epoch content');

    function encryptAtEpoch(epochNumber: number): {
      chainEntry: EpochChainEntry;
      wrapped: ReturnType<typeof wrapContentKeyToEpoch>;
      blob: Uint8Array;
    } {
      const epoch = generateEpochKeyPair();
      const contentKey = generateContentKey();
      const wrapped = wrapContentKeyToEpoch(epoch.publicKey, contentKey);
      const blob = encryptContentEnvelope(contentKey, wrapped, locationAt(epochNumber), plaintext);
      return {
        chainEntry: { epochNumber, privateKey: epoch.privateKey },
        wrapped,
        blob,
      };
    }

    it('decrypts content from the current epoch', () => {
      const current = encryptAtEpoch(7);
      const chain = [current.chainEntry];

      const decrypted = decryptContentWithEpochChain(
        chain,
        current.wrapped,
        locationAt(7),
        current.blob
      );

      expect(decrypted).toEqual(plaintext);
    });

    it('decrypts content from the previous epoch via the chain', () => {
      const previous = encryptAtEpoch(6);
      const current = encryptAtEpoch(7);
      const chain = [current.chainEntry, previous.chainEntry];

      const decrypted = decryptContentWithEpochChain(
        chain,
        previous.wrapped,
        locationAt(6),
        previous.blob
      );

      expect(decrypted).toEqual(plaintext);
    });

    it('throws EpochNotInChainError for an epoch outside the chain', () => {
      const old = encryptAtEpoch(3);
      const current = encryptAtEpoch(7);
      const chain = [current.chainEntry];

      expect(() =>
        decryptContentWithEpochChain(chain, old.wrapped, locationAt(3), old.blob)
      ).toThrow(EpochNotInChainError);
    });

    it('reports the missing epoch number on the error', () => {
      const old = encryptAtEpoch(3);

      try {
        decryptContentWithEpochChain([], old.wrapped, locationAt(3), old.blob);
        expect.unreachable('must throw');
      } catch (error) {
        expect(error).toBeInstanceOf(EpochNotInChainError);
        expect((error as EpochNotInChainError).epochNumber).toBe(3);
      }
    });

    it('surfaces DecryptionFailedError for a forged all-zero ephemeral point in the wrap', () => {
      const current = encryptAtEpoch(7);
      const chain = [current.chainEntry];
      const forged = new Uint8Array(current.wrapped);
      forged.set(new Uint8Array(32), 1);

      expect(() =>
        decryptContentWithEpochChain(chain, forged as WrappedSecret, locationAt(7), current.blob)
      ).toThrow(DecryptionFailedError);
    });

    it('fails when the chain holds the wrong key for the epoch number', () => {
      const real = encryptAtEpoch(7);
      const imposter = generateEpochKeyPair();
      const chain: EpochChainEntry[] = [{ epochNumber: 7, privateKey: imposter.privateKey }];

      expect(() =>
        decryptContentWithEpochChain(chain, real.wrapped, locationAt(7), real.blob)
      ).toThrow(DecryptionFailedError);
    });
  });
});
