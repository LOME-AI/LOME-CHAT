import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateKeyPair,
  openMessageEnvelope,
  decryptTextWithContentKey,
  decryptBinaryWithContentKey,
  decryptTextFromEpoch,
  type LegacyContentKey,
  type WrappedContentKey,
} from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { processKeyChain, getEpochKey, clearEpochKeyCache } from '@/lib/epoch-key-cache';
import { createDemoEpoch, buildKeyChain, encryptForEpoch, beginMessage } from './crypto-encoder';

const CONVERSATION_ID = 'demo-conv-1';

describe('demo crypto-encoder', () => {
  beforeEach(() => {
    clearEpochKeyCache();
  });

  it('buildKeyChain unwraps to the epoch private key via the real key cache', () => {
    const account = generateKeyPair();
    const epoch = createDemoEpoch(account.publicKey);

    processKeyChain(CONVERSATION_ID, buildKeyChain(epoch), account.privateKey);

    expect(getEpochKey(CONVERSATION_ID, epoch.epochNumber)).toEqual(epoch.epochPrivateKey);
  });

  it('encryptForEpoch round-trips a title through the real epoch decrypt', () => {
    const account = generateKeyPair();
    const epoch = createDemoEpoch(account.publicKey);
    const wire = encryptForEpoch(epoch, 'Multi-modal answers');
    expect(decryptTextFromEpoch(epoch.epochPrivateKey, fromBase64(wire))).toBe(
      'Multi-modal answers'
    );
  });

  it('beginMessage text item round-trips through the real message-envelope decrypt', () => {
    const account = generateKeyPair();
    const epoch = createDemoEpoch(account.publicKey);
    const envelope = beginMessage(epoch);
    const blob = envelope.encryptText('Hello from the **demo** 🎉');

    const contentKey: LegacyContentKey = openMessageEnvelope(
      epoch.epochPrivateKey,
      fromBase64(envelope.wrappedContentKey) as WrappedContentKey
    );
    expect(decryptTextWithContentKey(contentKey, fromBase64(blob))).toBe(
      'Hello from the **demo** 🎉'
    );
  });

  it('beginMessage binary item round-trips through the real media decrypt', () => {
    const account = generateKeyPair();
    const epoch = createDemoEpoch(account.publicKey);
    const envelope = beginMessage(epoch);
    const asset = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 255, 128]);
    const ciphertext = envelope.encryptBinary(asset);

    const contentKey: LegacyContentKey = openMessageEnvelope(
      epoch.epochPrivateKey,
      fromBase64(envelope.wrappedContentKey) as WrappedContentKey
    );
    expect(decryptBinaryWithContentKey(contentKey, ciphertext)).toEqual(asset);
  });

  it('shares one content key across text and binary items in the same message', () => {
    const account = generateKeyPair();
    const epoch = createDemoEpoch(account.publicKey);
    const envelope = beginMessage(epoch);
    const textBlob = envelope.encryptText('caption');
    const asset = new Uint8Array([9, 8, 7, 6, 5]);
    const mediaCipher = envelope.encryptBinary(asset);

    const contentKey: LegacyContentKey = openMessageEnvelope(
      epoch.epochPrivateKey,
      fromBase64(envelope.wrappedContentKey) as WrappedContentKey
    );
    expect(decryptTextWithContentKey(contentKey, fromBase64(textBlob))).toBe('caption');
    expect(decryptBinaryWithContentKey(contentKey, mediaCipher)).toEqual(asset);
  });
});
