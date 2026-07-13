import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateKeyPair,
  unwrapContentKeyFromEpoch,
  decryptContentEnvelope,
  decryptTextFromEpoch,
  asEpochPrivateKey,
  type WrappedSecret,
  type ContentLocation,
} from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { processKeyChain, getEpochKey, clearEpochKeyCache } from '@/lib/epoch-key-cache';
import {
  createDemoEpoch,
  buildKeyChain,
  encryptForEpoch,
  beginMessage,
  type DemoEpoch,
  type MessageLocation,
} from './crypto-encoder';

const CONVERSATION_ID = 'demo-conv-1';
const MESSAGE_ID = 'demo-msg-1';
const SENDER_ID = 'demo-user';

function messageLocation(epoch: DemoEpoch): MessageLocation {
  return {
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    senderId: SENDER_ID,
    epochNumber: epoch.epochNumber,
  };
}

/** The full content-item location the server binds as AAD, mirrored for a decrypt. */
function contentLocation(itemId: string, position: number, epoch: DemoEpoch): ContentLocation {
  return {
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    contentItemId: itemId,
    position,
    epochNumber: epoch.epochNumber,
    senderId: SENDER_ID,
  };
}

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

  it('beginMessage text item round-trips through the real content-envelope decrypt', () => {
    const account = generateKeyPair();
    const epoch = createDemoEpoch(account.publicKey);
    const envelope = beginMessage(epoch, messageLocation(epoch));
    const itemId = 'text-item-1';
    const blob = envelope.encryptText(itemId, 0, 'Hello from the **demo** 🎉');

    const wrapped = fromBase64(envelope.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epoch.epochPrivateKey), wrapped);
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      contentLocation(itemId, 0, epoch),
      fromBase64(blob)
    );
    expect(new TextDecoder().decode(plaintext)).toBe('Hello from the **demo** 🎉');
  });

  it('beginMessage binary item round-trips through the real content-envelope decrypt', () => {
    const account = generateKeyPair();
    const epoch = createDemoEpoch(account.publicKey);
    const envelope = beginMessage(epoch, messageLocation(epoch));
    const itemId = 'media-item-1';
    const asset = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 255, 128]);
    const ciphertext = envelope.encryptBinary(itemId, 0, asset);

    const wrapped = fromBase64(envelope.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epoch.epochPrivateKey), wrapped);
    expect(
      decryptContentEnvelope(contentKey, wrapped, contentLocation(itemId, 0, epoch), ciphertext)
    ).toEqual(asset);
  });

  it('shares one content key across text and binary items in the same message', () => {
    const account = generateKeyPair();
    const epoch = createDemoEpoch(account.publicKey);
    const envelope = beginMessage(epoch, messageLocation(epoch));
    const textBlob = envelope.encryptText('caption-item', 0, 'caption');
    const asset = new Uint8Array([9, 8, 7, 6, 5]);
    const mediaCipher = envelope.encryptBinary('asset-item', 1, asset);

    const wrapped = fromBase64(envelope.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epoch.epochPrivateKey), wrapped);
    const caption = decryptContentEnvelope(
      contentKey,
      wrapped,
      contentLocation('caption-item', 0, epoch),
      fromBase64(textBlob)
    );
    expect(new TextDecoder().decode(caption)).toBe('caption');
    expect(
      decryptContentEnvelope(
        contentKey,
        wrapped,
        contentLocation('asset-item', 1, epoch),
        mediaCipher
      )
    ).toEqual(asset);
  });

  it('binds the item location as AAD: decrypting under a different location fails', () => {
    const account = generateKeyPair();
    const epoch = createDemoEpoch(account.publicKey);
    const envelope = beginMessage(epoch, messageLocation(epoch));
    const blob = envelope.encryptText('right-item', 0, 'secret');

    const wrapped = fromBase64(envelope.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epoch.epochPrivateKey), wrapped);
    // Same key + blob, wrong contentItemId — the bound AAD must reject it.
    expect(() =>
      decryptContentEnvelope(
        contentKey,
        wrapped,
        contentLocation('wrong-item', 0, epoch),
        fromBase64(blob)
      )
    ).toThrow();
  });
});
