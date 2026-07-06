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
