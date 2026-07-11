import { fromBase64 } from '@hushbox/shared';
import { conflictError, forbiddenError, notFoundError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import type { ConversationsStores } from '../ports/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The epoch-at-persist gate (published for the chat settlement, which owns no
 * conversations/epochs access). Run INSIDE the settlement transaction before
 * wrapping content: it re-reads the conversations row FOR SHARE — serializing
 * against a concurrent rotation's `currentEpoch` UPDATE — and asserts the
 * captured send-time epoch is still current AND that the initiator is still a
 * member of it. On any failure the settlement transaction must terminal-fail
 * and persist nothing, so content never wraps to a superseded epoch a removed
 * member could still decrypt (forward secrecy).
 *
 * The boolean is a success token (unused downstream); a mismatch is an
 * expected domain `Result` error, never a defect.
 */

export interface WrapEpochAssertion {
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly userId: string;
}

function assertEpochMembership(
  stores: ConversationsStores,
  params: WrapEpochAssertion
): ResultAsync<boolean, DomainError> {
  return stores.members
    .activeByUser(params.conversationId, params.userId)
    .andThen((member) =>
      member === null || member.visibleFromEpoch > params.epochNumber
        ? errAsync<boolean, DomainError>(
            forbiddenError('chat wrap: initiator is not a member of the wrap epoch')
          )
        : okAsync<boolean, DomainError>(true)
    );
}

export function assertWrapEpochWithinTx(
  stores: ConversationsStores,
  params: WrapEpochAssertion
): ResultAsync<boolean, DomainError> {
  return stores.conversations.lockForShare(params.conversationId).andThen((conversation) => {
    if (conversation === null) {
      return errAsync<boolean, DomainError>(
        notFoundError('chat wrap: conversation not found at settlement')
      );
    }
    if (conversation.currentEpoch !== params.epochNumber) {
      return errAsync<boolean, DomainError>(
        conflictError('chat wrap: epoch rotated between send and settlement')
      );
    }
    return assertEpochMembership(stores, params);
  });
}

/**
 * The member-keyed epoch-at-persist gate — the shape legacy owner-billed group
 * sends relied on, and the one that works when the sender is a LINK GUEST (no
 * `userId`): the caller supplies the sender's already-resolved decryption
 * public key (base64) and this asserts, INSIDE the settlement transaction,
 * that (A) the captured send-time epoch is still `currentEpoch` under a
 * FOR-SHARE lock that serializes against a concurrent rotation's UPDATE, and
 * (B) that key holds an `epoch_members` row for the current epoch. Property A
 * is identical to `assertWrapEpochWithinTx`; property B replaces the per-user
 * `activeByUser` membership check with a conversation-keyed, key-keyed
 * `epoch_members` lookup — verified SERVER-SIDE against the authoritative
 * wrap-set, so a caller passing a non-member or stale key fails (public keys
 * are not secrets; the check does not trust that the caller resolved a real
 * member). A user member and a link guest both hold a key in `epoch_members`,
 * so one gate serves both.
 *
 * Mirrors `assertWrapEpochWithinTx`'s Result contract exactly (the boolean is
 * an unused success token; every failure is an expected domain error).
 */

export interface WrapEpochByMemberAssertion {
  readonly conversationId: string;
  readonly expectedEpoch: number;
  /** base64 of the sender member's decryption public key. */
  readonly memberPublicKey: string;
}

export function assertWrapEpochByMemberWithinTx(
  stores: ConversationsStores,
  params: WrapEpochByMemberAssertion
): ResultAsync<boolean, DomainError> {
  return stores.conversations.lockForShare(params.conversationId).andThen((conversation) => {
    if (conversation === null) {
      return errAsync<boolean, DomainError>(
        notFoundError('chat wrap: conversation not found at settlement')
      );
    }
    if (conversation.currentEpoch !== params.expectedEpoch) {
      return errAsync<boolean, DomainError>(
        conflictError('chat wrap: epoch rotated between send and settlement')
      );
    }
    return stores.epochs
      .memberInEpoch({
        conversationId: params.conversationId,
        epochNumber: conversation.currentEpoch,
        memberPublicKey: fromBase64(params.memberPublicKey),
      })
      .andThen((isMember) =>
        isMember
          ? okAsync<boolean, DomainError>(true)
          : errAsync<boolean, DomainError>(
              forbiddenError('chat wrap: sender key is not a member of the wrap epoch')
            )
      );
  });
}
