import { generateKeyPair } from './sharing.js';
import { eciesEncrypt, eciesDecrypt } from './ecies.js';
import { sha256Hash } from './hash.js';
import { constantTimeCompare } from './constant-time.js';

export interface EpochMemberWrap {
  memberPublicKey: Uint8Array;
  wrap: Uint8Array;
}

export interface CreateEpochResult {
  epochPublicKey: Uint8Array;
  epochPrivateKey: Uint8Array;
  confirmationHash: Uint8Array;
  memberWraps: EpochMemberWrap[];
}

export interface EpochRotationResult {
  epochPublicKey: Uint8Array;
  epochPrivateKey: Uint8Array;
  confirmationHash: Uint8Array;
  memberWraps: EpochMemberWrap[];
  chainLink: Uint8Array;
}

function wrapForMembers(
  epochPrivateKey: Uint8Array,
  memberPublicKeys: Uint8Array[]
): EpochMemberWrap[] {
  return memberPublicKeys.map((memberPublicKey) => ({
    memberPublicKey,
    wrap: eciesEncrypt(memberPublicKey, epochPrivateKey),
  }));
}

export function createFirstEpoch(memberPublicKeys: Uint8Array[]): CreateEpochResult {
  const epoch = generateKeyPair();
  const confirmationHash = sha256Hash(epoch.privateKey);
  const memberWraps = wrapForMembers(epoch.privateKey, memberPublicKeys);

  return {
    epochPublicKey: epoch.publicKey,
    epochPrivateKey: epoch.privateKey,
    confirmationHash,
    memberWraps,
  };
}

export function performEpochRotation(
  oldEpochPrivateKey: Uint8Array,
  memberPublicKeys: Uint8Array[]
): EpochRotationResult {
  const newEpoch = generateKeyPair();
  const confirmationHash = sha256Hash(newEpoch.privateKey);
  const memberWraps = wrapForMembers(newEpoch.privateKey, memberPublicKeys);
  const chainLink = eciesEncrypt(newEpoch.publicKey, oldEpochPrivateKey);

  return {
    epochPublicKey: newEpoch.publicKey,
    epochPrivateKey: newEpoch.privateKey,
    confirmationHash,
    memberWraps,
    chainLink,
  };
}

export function unwrapEpochKey(accountPrivateKey: Uint8Array, wrap: Uint8Array): Uint8Array {
  return eciesDecrypt(accountPrivateKey, wrap);
}

export function traverseChainLink(
  newerEpochPrivateKey: Uint8Array,
  chainLink: Uint8Array
): Uint8Array {
  return eciesDecrypt(newerEpochPrivateKey, chainLink);
}

export function verifyEpochKeyConfirmation(
  epochPrivateKey: Uint8Array,
  expectedHash: Uint8Array
): boolean {
  const computed = sha256Hash(epochPrivateKey);
  return constantTimeCompare(computed, expectedHash);
}
