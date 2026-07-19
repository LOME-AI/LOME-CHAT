/**
 * Proactive epoch rotation builder.
 * DESIGN: Rotation happens at the point of action (add/remove/leave/revoke),
 * NOT deferred to message send. The send path has zero rotation logic.
 */

import { performEpochRotation, encryptTextForEpoch } from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { client, fetchJson } from './api-client.js';
import { setEpochKey, setCurrentEpoch } from './epoch-key-cache.js';
import type { StreamChatRotation } from '@hushbox/shared';

export interface RotationMember {
  publicKey: Uint8Array;
}

export interface BuildRotationInput {
  conversationId: string;
  currentEpochPrivateKey: Uint8Array;
  currentEpochNumber: number;
  members: RotationMember[];
  plaintextTitle: string;
}

export interface RotationResult {
  params: StreamChatRotation;
  newEpochPrivateKey: Uint8Array;
  newEpochNumber: number;
}

export interface MemberKeyResponse {
  memberId: string;
  userId: string | null;
  linkId: string | null;
  publicKey: string;
  privilege: string;
  visibleFromEpoch: number;
}

export interface ExecuteWithRotationInput {
  conversationId: string;
  currentEpochPrivateKey: Uint8Array;
  currentEpochNumber: number;
  plaintextTitle: string;
  filterMembers: (allKeys: MemberKeyResponse[]) => RotationMember[];
  execute: (rotation: StreamChatRotation) => Promise<unknown>;
}

const MAX_ROTATION_ATTEMPTS = 2;

export function buildRotation(input: BuildRotationInput): RotationResult {
  if (input.currentEpochPrivateKey.every((b) => b === 0)) {
    throw new Error('Cannot rotate: epoch key unavailable');
  }
  const newEpochNumber = input.currentEpochNumber + 1;
  const rotation = performEpochRotation(
    input.currentEpochPrivateKey,
    input.members.map((m) => m.publicKey),
    input.conversationId,
    newEpochNumber
  );
  const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, input.plaintextTitle);

  const params: StreamChatRotation = {
    expectedEpoch: input.currentEpochNumber,
    epochPublicKey: toBase64(rotation.epochPublicKey),
    confirmationHash: toBase64(rotation.confirmationHash),
    chainLink: toBase64(rotation.chainLink),
    encryptedTitle: toBase64(encryptedTitle),
    memberWraps: rotation.memberWraps.map((w) => ({
      memberPublicKey: toBase64(w.memberPublicKey),
      wrap: toBase64(w.wrap),
    })),
  };

  return {
    params,
    newEpochPrivateKey: rotation.epochPrivateKey,
    newEpochNumber,
  };
}

interface MemberKeysApiResponse {
  members: MemberKeyResponse[];
}

function isStaleEpochError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    (error as Error & { status: number }).status === 409
  );
}

async function fetchMemberKeys(conversationId: string): Promise<MemberKeyResponse[]> {
  const response = await fetchJson<MemberKeysApiResponse>(
    client.conversations[':conversationId']['member-keys'].$get({
      param: { conversationId },
    })
  );
  return response.members;
}

export async function executeWithRotation(
  input: ExecuteWithRotationInput
): Promise<RotationResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS; attempt++) {
    const memberKeys = await fetchMemberKeys(input.conversationId);
    const members = input.filterMembers(memberKeys);
    const result = buildRotation({
      conversationId: input.conversationId,
      currentEpochPrivateKey: input.currentEpochPrivateKey,
      currentEpochNumber: input.currentEpochNumber,
      members,
      plaintextTitle: input.plaintextTitle,
    });

    try {
      await input.execute(result.params);

      setEpochKey(input.conversationId, result.newEpochNumber, result.newEpochPrivateKey);
      setCurrentEpoch(input.conversationId, result.newEpochNumber);

      return result;
    } catch (error: unknown) {
      if (isStaleEpochError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}
