import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { encryptMediaChunk } from './chunked.js';
import { encryptContentEnvelope } from './envelope.js';
import { wrapContentKeyToEpoch, decryptContentWithEpochChain } from './epoch.js';
import { generateContentKey, generateEpochKeyPair, generateAccountKeyPair } from './keys.js';
import type { ContentLocation } from './envelope.js';
import type { EpochChainEntry } from './epoch.js';

/**
 * Type tests: each @ts-expect-error line asserts that the marked call DOES
 * NOT compile. If a branded key class ever became assignable where another
 * is expected, the directive would be flagged unused and `tsgo --noEmit`
 * would fail — transposition is blocked at the type level.
 */

const location: ContentLocation = {
  conversationId: 'conv-1',
  messageId: 'msg-1',
  contentItemId: 'item-1',
  position: 0,
  epochNumber: 1,
  senderId: 'user-1',
};

describe('branded key transposition (compile-time)', () => {
  it('rejects an epoch private key where a content key is expected', () => {
    const epoch = generateEpochKeyPair();

    const callEncrypt = (): Uint8Array =>
      encryptMediaChunk(
        // @ts-expect-error — EpochPrivateKey is not assignable to ContentKey
        epoch.privateKey,
        { contentId: 'content-1', chunkIndex: 0, isLast: true },
        randomBytes(8)
      );

    expect(callEncrypt).toBeInstanceOf(Function);
  });

  it('rejects an epoch public key where a content key is expected', () => {
    const epoch = generateEpochKeyPair();
    const contentKey = generateContentKey();
    const wrapped = wrapContentKeyToEpoch(epoch.publicKey, contentKey);

    const callEncrypt = (): Uint8Array =>
      // @ts-expect-error — EpochPublicKey is not assignable to ContentKey
      encryptContentEnvelope(epoch.publicKey, wrapped, location, randomBytes(8));

    expect(callEncrypt).toBeInstanceOf(Function);
  });

  it('rejects a content key where an epoch public key is expected', () => {
    const contentKey = generateContentKey();

    const callWrap = (): Uint8Array =>
      // @ts-expect-error — ContentKey is not assignable to EpochPublicKey
      wrapContentKeyToEpoch(contentKey, contentKey);

    expect(callWrap).toBeInstanceOf(Function);
  });

  it('rejects an account private key where an epoch private key is expected', () => {
    const account = generateAccountKeyPair();

    // @ts-expect-error — AccountPrivateKey is not assignable to EpochPrivateKey
    const entry: EpochChainEntry = { epochNumber: 1, privateKey: account.privateKey };

    expect(entry.epochNumber).toBe(1);
  });

  it('rejects a raw Uint8Array where any branded key is expected', () => {
    const raw = randomBytes(32);

    const callEncrypt = (): Uint8Array =>
      encryptMediaChunk(
        // @ts-expect-error — unbranded Uint8Array is not assignable to ContentKey
        raw,
        { contentId: 'content-1', chunkIndex: 0, isLast: true },
        randomBytes(8)
      );

    expect(callEncrypt).toBeInstanceOf(Function);
  });

  it('rejects a raw Uint8Array where a wrapped secret is expected', () => {
    const epoch = generateEpochKeyPair();
    const contentKey = generateContentKey();

    const callDecrypt = (): Uint8Array =>
      decryptContentWithEpochChain(
        [{ epochNumber: 1, privateKey: epoch.privateKey }],
        // @ts-expect-error — unbranded Uint8Array is not assignable to WrappedSecret
        randomBytes(81),
        location,
        encryptContentEnvelope(
          contentKey,
          wrapContentKeyToEpoch(epoch.publicKey, contentKey),
          location,
          randomBytes(8)
        )
      );

    expect(callDecrypt).toBeInstanceOf(Function);
  });
});
