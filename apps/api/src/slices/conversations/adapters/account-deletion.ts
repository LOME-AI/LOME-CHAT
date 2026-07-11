import { and, eq, isNull } from 'drizzle-orm';
import { conversationMembers, conversations } from '@hushbox/db';
import type { SettlementTx } from '../../../lib/idempotency/index.js';

/**
 * The conversations slice's published surface for identity's account-deletion
 * transaction (single-writer: this slice owns `conversations` and
 * `conversation_members`). Both run on the branded `SettlementTx` and THROW on
 * failure — inside the one deletion transaction a throw aborts the whole
 * commit, so a partial deletion can never persist.
 */

/**
 * The ids of every conversation the user OWNS. The deletion transaction
 * captures these before the `users` delete cascades them away: they scope the
 * chat slice's storage-key capture (owned content dies with the cascade) and
 * its sender scrub (foreign conversations survive, so those messages are
 * detached instead).
 */
export async function ownedConversationIdsWithinTx(
  tx: SettlementTx,
  userId: string
): Promise<readonly string[]> {
  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  return rows.map((row) => row.id);
}

/**
 * Deletes every conversation the user OWNS (messages/content cascade with
 * them). Runs INSIDE the deletion transaction, BEFORE the `users` delete —
 * relying on the users→conversations cascade instead aborts the commit. The
 * users delete triggers two overlapping actions on the same membership row of an
 * owned conversation: the conversationId→conversations CASCADE deletes it, while
 * the userId→users SET NULL updates it. Because this transaction already modified
 * that row (leftAt) earlier in the same command, Postgres raises "tuple to be
 * updated was already modified by an operation triggered by the current command".
 * Deleting the owned conversations first removes their membership rows before
 * any SET NULL can touch them.
 */
export async function deleteOwnedConversationsWithinTx(
  tx: SettlementTx,
  userId: string
): Promise<void> {
  await tx.delete(conversations).where(eq(conversations.userId, userId));
}

/**
 * The bulk leave: stamps `leftAt` on every ACTIVE membership of the user.
 * Must run BEFORE the `users` delete — its FK sets `userId` null, and the
 * surviving row satisfies the `userId OR linkId OR leftAt` check only once
 * `leftAt` is set. Already-departed rows keep their original timestamp.
 */
export async function leaveAllMembershipsWithinTx(
  tx: SettlementTx,
  userId: string,
  leftAt: Date
): Promise<void> {
  await tx
    .update(conversationMembers)
    .set({ leftAt })
    .where(and(eq(conversationMembers.userId, userId), isNull(conversationMembers.leftAt)));
}
