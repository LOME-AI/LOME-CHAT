/**
 * Integration tests for epoch-key-cache using REAL cryptographic functions.
 * Unlike epoch-key-cache.test.ts (which mocks @hushbox/crypto), these tests
 * verify that processKeyChain works end-to-end with actual ECIES encryption,
 * chain link traversal, and confirmation hash verification.
 *
 * These tests catch bugs that mocked tests cannot — such as using the wrong
 * confirmation hash during chain link verification.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createFirstEpoch, performEpochRotation, generateKeyPair } from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { processKeyChain, getEpochKey, clearEpochKeyCache, getCacheSize } from './epoch-key-cache';

describe('epoch-key-cache real-crypto chain link traversal', () => {
  beforeEach(() => {
    clearEpochKeyCache();
  });

  it('recovers older epoch key via chain link after single rotation', () => {
    const account = generateKeyPair();
    const epoch1 = createFirstEpoch([account.publicKey], 'conv-1', 1);
    const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [account.publicKey], 'conv-1', 2);

    // Simulate server response after rotation: epoch 1 wraps deleted, only epoch 2 wrap exists
    const keyChain = {
      wraps: [
        {
          epochNumber: 2,
          wrap: toBase64(epoch2.memberWraps[0]!.wrap),
          confirmationHash: toBase64(epoch2.confirmationHash),
        },
      ],
      chainLinks: [
        {
          epochNumber: 2,
          chainLink: toBase64(epoch2.chainLink),
          confirmationHash: toBase64(epoch2.confirmationHash),
        },
      ],
      currentEpoch: 2,
    };

    processKeyChain('conv-1', keyChain, account.privateKey);

    expect(getEpochKey('conv-1', 2)).toEqual(epoch2.epochPrivateKey);
    expect(getEpochKey('conv-1', 1)).toEqual(epoch1.epochPrivateKey);
  });

  it('recovers all older epoch keys via multi-rotation chain', () => {
    const account = generateKeyPair();
    const epoch1 = createFirstEpoch([account.publicKey], 'conv-1', 1);
    const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [account.publicKey], 'conv-1', 2);
    const epoch3 = performEpochRotation(epoch2.epochPrivateKey, [account.publicKey], 'conv-1', 3);

    // Only newest wrap available, all older must come from chain links
    const keyChain = {
      wraps: [
        {
          epochNumber: 3,
          wrap: toBase64(epoch3.memberWraps[0]!.wrap),
          confirmationHash: toBase64(epoch3.confirmationHash),
        },
      ],
      chainLinks: [
        {
          epochNumber: 2,
          chainLink: toBase64(epoch2.chainLink),
          confirmationHash: toBase64(epoch2.confirmationHash),
        },
        {
          epochNumber: 3,
          chainLink: toBase64(epoch3.chainLink),
          confirmationHash: toBase64(epoch3.confirmationHash),
        },
      ],
      currentEpoch: 3,
    };

    processKeyChain('conv-1', keyChain, account.privateKey);

    expect(getEpochKey('conv-1', 3)).toEqual(epoch3.epochPrivateKey);
    expect(getEpochKey('conv-1', 2)).toEqual(epoch2.epochPrivateKey);
    expect(getEpochKey('conv-1', 1)).toEqual(epoch1.epochPrivateKey);
    expect(getCacheSize()).toBe(3);
  });

  it('does not cache key when chain link data is corrupted', () => {
    const account = generateKeyPair();
    const epoch1 = createFirstEpoch([account.publicKey], 'conv-1', 1);
    const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [account.publicKey], 'conv-1', 2);

    // Corrupt the chain link data
    const corruptedChainLink = new Uint8Array(epoch2.chainLink);
    corruptedChainLink[0] = (corruptedChainLink[0]! + 1) % 256;

    const keyChain = {
      wraps: [
        {
          epochNumber: 2,
          wrap: toBase64(epoch2.memberWraps[0]!.wrap),
          confirmationHash: toBase64(epoch2.confirmationHash),
        },
      ],
      chainLinks: [
        {
          epochNumber: 2,
          chainLink: toBase64(corruptedChainLink),
          confirmationHash: toBase64(epoch2.confirmationHash),
        },
      ],
      currentEpoch: 2,
    };

    processKeyChain('conv-1', keyChain, account.privateKey);

    expect(getEpochKey('conv-1', 2)).toEqual(epoch2.epochPrivateKey);
    expect(getEpochKey('conv-1', 1)).toBeUndefined();
  });

  it('rejects a wrap whose keyed confirmation was bound to a different conversation', () => {
    const account = generateKeyPair();
    // Confirmation is bound to 'conv-OTHER' but replayed under 'conv-1'.
    const epoch1 = createFirstEpoch([account.publicKey], 'conv-OTHER', 1);

    const keyChain = {
      wraps: [
        {
          epochNumber: 1,
          wrap: toBase64(epoch1.memberWraps[0]!.wrap),
          confirmationHash: toBase64(epoch1.confirmationHash),
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    };

    processKeyChain('conv-1', keyChain, account.privateKey);

    expect(getEpochKey('conv-1', 1)).toBeUndefined();
  });

  it('rejects a wrap whose keyed confirmation was bound to a different epoch number', () => {
    const account = generateKeyPair();
    // Confirmation is bound to epoch 5 but presented as epoch 1.
    const epoch = createFirstEpoch([account.publicKey], 'conv-1', 5);

    const keyChain = {
      wraps: [
        {
          epochNumber: 1,
          wrap: toBase64(epoch.memberWraps[0]!.wrap),
          confirmationHash: toBase64(epoch.confirmationHash),
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    };

    processKeyChain('conv-1', keyChain, account.privateKey);

    expect(getEpochKey('conv-1', 1)).toBeUndefined();
  });

  it('recovers keys when wrap exists for an intermediate epoch', () => {
    const account = generateKeyPair();
    const epoch1 = createFirstEpoch([account.publicKey], 'conv-1', 1);
    const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [account.publicKey], 'conv-1', 2);
    const epoch3 = performEpochRotation(epoch2.epochPrivateKey, [account.publicKey], 'conv-1', 3);

    // Wraps exist for epochs 2 and 3 (e.g., epoch 1 deleted, epoch 2 kept)
    const keyChain = {
      wraps: [
        {
          epochNumber: 2,
          wrap: toBase64(epoch2.memberWraps[0]!.wrap),
          confirmationHash: toBase64(epoch2.confirmationHash),
        },
        {
          epochNumber: 3,
          wrap: toBase64(epoch3.memberWraps[0]!.wrap),
          confirmationHash: toBase64(epoch3.confirmationHash),
        },
      ],
      chainLinks: [
        {
          epochNumber: 2,
          chainLink: toBase64(epoch2.chainLink),
          confirmationHash: toBase64(epoch2.confirmationHash),
        },
        {
          epochNumber: 3,
          chainLink: toBase64(epoch3.chainLink),
          confirmationHash: toBase64(epoch3.confirmationHash),
        },
      ],
      currentEpoch: 3,
    };

    processKeyChain('conv-1', keyChain, account.privateKey);

    expect(getEpochKey('conv-1', 3)).toEqual(epoch3.epochPrivateKey);
    expect(getEpochKey('conv-1', 2)).toEqual(epoch2.epochPrivateKey);
    expect(getEpochKey('conv-1', 1)).toEqual(epoch1.epochPrivateKey);
  });
});
