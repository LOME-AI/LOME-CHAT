import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { constantTimeCompare } from './constant-time.js';
import { decryptContentEnvelope } from './envelope.js';
import { EpochNotInChainError } from './errors.js';
import { u64Field, utf8Field } from './format.js';
import { asContentKey } from './keys.js';
import { wrapSecretTo, unwrapSecret } from './wrap.js';
import type { ContentLocation } from './envelope.js';
import type { ContentKey, EpochPrivateKey, EpochPublicKey } from './keys.js';
import type { WrappedSecret } from './wrap.js';

/** Domain-separation label for content keys wrapped to an epoch public key. */
export const CONTENT_KEY_WRAP_LABEL = 'content-key.epoch';

export const EPOCH_CONFIRMATION_BYTES = 32;

// Domain-separation constant baked into key derivation: once any real data
// is encrypted under this HKDF info string, it can never change.
const EPOCH_CONFIRMATION_INFO = 'hushbox/epoch-confirmation';

const encoder = new TextEncoder();

/**
 * Keyed epoch confirmation: HKDF-SHA-256 over the epoch private key, bound
 * to the conversation and epoch number. Only holders of the epoch private
 * key can compute it — unlike a bare hash of the key, it is useless as a
 * public commitment oracle and cannot be replayed across conversations or
 * epochs.
 */
export function computeEpochConfirmation(
  epochPrivateKey: EpochPrivateKey,
  conversationId: string,
  epochNumber: number
): Uint8Array {
  const info = concatBytes(
    encoder.encode(EPOCH_CONFIRMATION_INFO),
    utf8Field(conversationId),
    u64Field(epochNumber, 'epochNumber')
  );
  return hkdf(sha256, epochPrivateKey, undefined, info, EPOCH_CONFIRMATION_BYTES);
}

export function verifyEpochConfirmation(
  epochPrivateKey: EpochPrivateKey,
  conversationId: string,
  epochNumber: number,
  expected: Uint8Array
): boolean {
  const computed = computeEpochConfirmation(epochPrivateKey, conversationId, epochNumber);
  return constantTimeCompare(computed, expected);
}

export function wrapContentKeyToEpoch(
  epochPublicKey: EpochPublicKey,
  contentKey: ContentKey
): WrappedSecret {
  return wrapSecretTo(epochPublicKey, contentKey, CONTENT_KEY_WRAP_LABEL);
}

export function unwrapContentKeyFromEpoch(
  epochPrivateKey: EpochPrivateKey,
  wrapped: WrappedSecret
): ContentKey {
  return asContentKey(unwrapSecret(epochPrivateKey, wrapped, CONTENT_KEY_WRAP_LABEL));
}

/**
 * One link of the epoch chain a member holds: the epoch number alongside
 * that epoch's unwrapped private key (current epoch plus any previous epochs
 * the member belonged to).
 */
export interface EpochChainEntry {
  epochNumber: number;
  privateKey: EpochPrivateKey;
}

/**
 * Decrypts content using whichever epoch in the chain the content was
 * persisted under (`location.epochNumber`), keeping prior-epoch content
 * readable after rotation. An epoch outside the chain is a typed error —
 * partial visibility (member joined after the content's epoch) surfaces as
 * `EpochNotInChainError`, never as garbage plaintext.
 */
export function decryptContentWithEpochChain(
  chain: readonly EpochChainEntry[],
  wrappedContentKey: WrappedSecret,
  location: ContentLocation,
  blob: Uint8Array
): Uint8Array {
  const entry = chain.find((candidate) => candidate.epochNumber === location.epochNumber);
  if (!entry) {
    throw new EpochNotInChainError(location.epochNumber);
  }
  const contentKey = unwrapContentKeyFromEpoch(entry.privateKey, wrappedContentKey);
  return decryptContentEnvelope(contentKey, wrappedContentKey, location, blob);
}
