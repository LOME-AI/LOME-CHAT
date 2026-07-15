/**
 * Leave a conversation. Two server-enforced paths:
 *   1. Owner   — server deletes the conversation. No rotation needed.
 *   2. Non-owner — server requires an atomically-submitted epoch rotation so
 *      the leaving member can't read messages encrypted with the next epoch
 *      key.
 *
 * Both call sites (member-sidebar via `useGroupChat.onLeave` and the sidebar
 * chat-list dropdown via `chat-item.handleConfirmLeave`) route through this
 * function so the rotation contract is enforced in one place.
 *
 * Navigation after success is the caller's responsibility — member-sidebar
 * always navigates (the user is by definition viewing the leaving
 * conversation), but chat-item only navigates when leaving the active chat.
 */

import {
  fromBase64,
  friendlyErrorMessage,
  isOwner,
  type MemberPrivilege,
  type StreamChatRotation,
} from '@hushbox/shared';
import { UserMessageError } from '@hushbox/ui';
import { getCurrentEpoch, getEpochKey } from './epoch-key-cache.js';
import { executeWithRotation } from './rotation.js';
import type { MemberKeyResponse, RotationMember } from './rotation.js';

export type LeaveCallback = (params: {
  conversationId: string;
  rotation?: StreamChatRotation;
}) => Promise<unknown>;

/**
 * Populates the epoch-key cache for a conversation the caller may not be
 * viewing. The sidebar `Leave` flow can be triggered from any page; if the
 * user hasn't visited this conversation yet `useDecryptedMessages` never ran
 * `processKeyChain`, so `getCurrentEpoch` / `getEpochKey` below would be
 * empty and the non-owner rotation path would throw INTERNAL with the modal
 * stuck open. The callback owns fetching + unwrapping so this lib stays free
 * of QueryClient / private-key knowledge.
 */
export type EnsureKeysCachedCallback = (conversationId: string) => Promise<void>;

export interface LeaveConversationInput {
  conversationId: string;
  callerId: string;
  plaintextTitle: string;
  privilege: MemberPrivilege;
  leave: LeaveCallback;
  ensureKeysCached?: EnsureKeysCachedCallback;
}

function filterOutCaller(callerId: string): (keys: MemberKeyResponse[]) => RotationMember[] {
  return (keys) => {
    const result: RotationMember[] = [];
    for (const k of keys) {
      if (k.userId !== callerId) result.push({ publicKey: fromBase64(k.publicKey) });
    }
    return result;
  };
}

export async function leaveConversation(input: LeaveConversationInput): Promise<void> {
  const { conversationId, callerId, plaintextTitle, privilege, leave, ensureKeysCached } = input;

  if (isOwner(privilege)) {
    await leave({ conversationId });
    return;
  }

  if (ensureKeysCached) await ensureKeysCached(conversationId);

  const epochNumber = getCurrentEpoch(conversationId);
  if (epochNumber === undefined) {
    throw new UserMessageError(friendlyErrorMessage('INTERNAL'));
  }
  const epochKey = getEpochKey(conversationId, epochNumber);
  if (!epochKey) {
    throw new UserMessageError(friendlyErrorMessage('INTERNAL'));
  }

  await executeWithRotation({
    conversationId,
    currentEpochPrivateKey: epochKey,
    currentEpochNumber: epochNumber,
    plaintextTitle,
    filterMembers: filterOutCaller(callerId),
    execute: (rotation) => leave({ conversationId, rotation }),
  });
}
