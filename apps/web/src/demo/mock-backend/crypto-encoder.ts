/**
 * Encrypts the demo's canned plaintext fixtures into the EXACT base64 wire
 * shapes the real app expects, using the same `@hushbox/crypto` helpers the
 * production server uses. The demo's in-browser fake backend serves these so
 * the unmodified client decrypt path (`processKeyChain` →
 * `unwrapContentKeyFromEpoch` → `decryptContentEnvelope`) runs verbatim — the
 * demo genuinely exercises the encryption stack rather than bypassing it.
 *
 * Content is sealed with the wrap-once content envelope the server writes:
 * one fresh content key per message wrapped to the epoch (`wrapContentKeyToEpoch`),
 * every item encrypted with `encryptContentEnvelope` binding its full location
 * tuple (conversationId, messageId, contentItemId, position, epochNumber,
 * senderId) as AAD. The caller therefore supplies the message location up front
 * and each item's id + position at encrypt time.
 *
 * Encryption needs only the epoch PUBLIC key, so this works for both
 * fixture-seeded conversations (epoch created here) and conversations the user
 * creates live (epoch created client-side, only its public key sent to the
 * fake backend).
 */
import {
  createFirstEpoch,
  generateContentKey,
  wrapContentKeyToEpoch,
  encryptContentEnvelope,
  encryptTextForEpoch,
  asEpochPublicKey,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import type { KeyChainResponse } from '@/lib/epoch-key-cache';

export interface DemoEpoch {
  readonly epochNumber: number;
  readonly epochPublicKey: Uint8Array;
  readonly epochPrivateKey: Uint8Array;
  readonly confirmationHash: Uint8Array;
  readonly memberWrap: Uint8Array;
}

/** Create the first epoch for a demo conversation, wrapped to the demo account. */
export function createDemoEpoch(accountPublicKey: Uint8Array, epochNumber = 1): DemoEpoch {
  const epoch = createFirstEpoch([accountPublicKey]);
  const memberWrap = epoch.memberWraps[0];
  if (memberWrap === undefined) {
    throw new Error('createFirstEpoch returned no member wrap for the demo account');
  }
  return {
    epochNumber,
    epochPublicKey: epoch.epochPublicKey,
    epochPrivateKey: epoch.epochPrivateKey,
    confirmationHash: epoch.confirmationHash,
    memberWrap: memberWrap.wrap,
  };
}

/**
 * Build the `GET /api/keys/:id` (and `POST /api/keys/batch` per-conversation)
 * wire payload for a single-epoch conversation. `chainLinks` is empty because
 * demo conversations never rotate epochs.
 */
export function buildKeyChain(epoch: DemoEpoch): KeyChainResponse {
  return {
    wraps: [
      {
        epochNumber: epoch.epochNumber,
        wrap: toBase64(epoch.memberWrap),
        confirmationHash: toBase64(epoch.confirmationHash),
        visibleFromEpoch: 1,
      },
    ],
    chainLinks: [],
    currentEpoch: epoch.epochNumber,
  };
}

/**
 * Encrypt a single-blob ECIES field (conversation/list title) for an epoch.
 * Returns base64 for the `title` wire field.
 */
export function encryptForEpoch(epoch: DemoEpoch, plaintext: string): string {
  return toBase64(encryptTextForEpoch(epoch.epochPublicKey, plaintext));
}

/**
 * The message-level identity every content envelope on a message binds as AAD
 * (minus the per-item `contentItemId`/`position`, supplied at encrypt time).
 * `senderId` mirrors the served `MessageResponse.senderId`; a null value (the
 * demo assistant) canonicalizes to '' exactly as the client's reconstruction
 * does, so both sides derive the same AAD.
 */
export interface MessageLocation {
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string | null;
  readonly epochNumber: number;
}

export interface MessageEnvelope {
  /** base64 wrapped content key for `MessageResponse.wrappedContentKey`. */
  readonly wrappedContentKey: string;
  /** Encrypt a text content item → base64 for `ContentItemResponse.encryptedBlob`. */
  encryptText: (contentItemId: string, position: number, plaintext: string) => string;
  /** Encrypt a media asset → RAW ciphertext bytes to serve at a `data:`/`blob:` URL. */
  encryptBinary: (contentItemId: string, position: number, bytes: Uint8Array) => Uint8Array;
}

const textEncoder = new TextEncoder();

/**
 * Begin a per-message envelope. One content key per message is shared by every
 * content item (text and media), wrapped once to the epoch — mirrors the
 * server's wrap-once model and the client's one-unwrap-per-message read path.
 */
export function beginMessage(epoch: DemoEpoch, location: MessageLocation): MessageEnvelope {
  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyToEpoch(
    asEpochPublicKey(epoch.epochPublicKey),
    contentKey
  );
  const senderId = location.senderId ?? '';
  const encrypt = (contentItemId: string, position: number, plaintext: Uint8Array): Uint8Array =>
    encryptContentEnvelope(
      contentKey,
      wrappedContentKey,
      {
        conversationId: location.conversationId,
        messageId: location.messageId,
        contentItemId,
        position,
        epochNumber: location.epochNumber,
        senderId,
      },
      plaintext
    );
  return {
    wrappedContentKey: toBase64(wrappedContentKey),
    encryptText: (contentItemId: string, position: number, plaintext: string): string =>
      toBase64(encrypt(contentItemId, position, textEncoder.encode(plaintext))),
    encryptBinary: (contentItemId: string, position: number, bytes: Uint8Array): Uint8Array =>
      encrypt(contentItemId, position, bytes),
  };
}
