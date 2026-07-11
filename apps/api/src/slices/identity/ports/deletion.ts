import type { SettlementTx } from '../../../lib/idempotency/index.js';

/**
 * What the deletion executor needs from OTHER slices' published surfaces,
 * expressed as an identity-owned port and bound at the composition root:
 * chat's content purge helpers plus the media-reclaim enqueue (identity may
 * not import the chat or media barrels — both already import identity, and
 * a barrel cycle is lint-banned). The conversations helpers are imported
 * directly (that direction is cycle-free), so they are not part of this port.
 *
 * Every method runs on the branded `SettlementTx` and THROWS on failure —
 * inside the one deletion transaction a throw aborts the whole commit.
 */
export interface AccountDeletionPurge {
  /** Chat's DISTINCT non-null storage-key capture for the owned conversations. */
  captureContentStorageKeysWithinTx(
    tx: SettlementTx,
    conversationIds: readonly string[]
  ): Promise<readonly string[]>;
  /** Chat's senderId scrub for the user's messages outside the owned set. */
  detachMessageSendersWithinTx(
    tx: SettlementTx,
    userId: string,
    excludedConversationIds: readonly string[]
  ): Promise<void>;
  /**
   * Enqueues `media.reclaimUser.v1` (bulk shard) inside the deletion
   * transaction — Pattern C: the job row commits atomically with the delete
   * whose ciphertext it reclaims. Never called with an empty key list.
   */
  enqueueMediaReclaimWithinTx(
    tx: SettlementTx,
    args: { readonly userId: string; readonly storageKeys: readonly string[] }
  ): Promise<void>;
}
