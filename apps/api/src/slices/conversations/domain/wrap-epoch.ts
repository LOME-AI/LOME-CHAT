import { fromBase64 } from '@hushbox/shared';
import { conflictError, forbiddenError, notFoundError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import type { ConversationsStores } from '../ports/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The member-keyed epoch-at-persist gate (published for the chat settlement,
 * which owns no conversations/epochs access). It is the shape legacy
 * owner-billed group sends relied on, and the one that works when the sender is
 * a LINK GUEST (no `userId`): the caller supplies the sender's already-resolved
 * decryption public key (base64) and this asserts, INSIDE the settlement
 * transaction, that (A) the captured send-time epoch is still `currentEpoch`
 * under a FOR-SHARE lock that serializes against a concurrent rotation's UPDATE
 * — so content never wraps to a superseded epoch a removed member could still
 * decrypt (forward secrecy) — and (B) that key holds an `epoch_members` row for
 * the current epoch, verified SERVER-SIDE against the authoritative wrap-set, so
 * a caller passing a non-member or stale key fails (public keys are not secrets;
 * the check does not trust that the caller resolved a real member). A user
 * member and a link guest both hold a key in `epoch_members`, so one gate serves
 * both. On any failure the settlement transaction terminal-fails and persists
 * nothing.
 *
 * The boolean is an unused success token; every failure is an expected domain
 * `Result` error, never a defect.
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
