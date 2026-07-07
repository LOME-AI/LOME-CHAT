import { and, eq, inArray } from 'drizzle-orm';
import { messages } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Deletes the messages a fork deletion orphaned. Chat is the single writer of
 * `messages`; the conversations slice owns the DELETE DECISION (which ids are
 * exclusive to the deleted branch — never a shared ancestor) and composes this
 * writer inside the same fork-delete transaction. The `content_items` cascade
 * (and the `usage_records` `SET NULL` behind it) is the DB's, matching a normal
 * message deletion. An empty id set is a no-op — no query, no orphaned branch.
 *
 * The `conversationId` scope is defense-in-depth: this is the only cross-slice
 * deleter of `messages`, and the correct caller already sources `ids` from the
 * same conversation's parent chain, so scoping is a no-op for it. But a future
 * or misusing caller passing ids from another conversation can never delete
 * outside `conversationId` — the WHERE predicate, not caller discipline, is the
 * boundary.
 */
export function deleteForkMessagesWithinTx(
  tx: DbWriter,
  conversationId: string,
  ids: readonly string[]
): ResultAsync<void, DomainError> {
  if (ids.length === 0) return okAsync();
  return fromPromise(
    tx
      .delete(messages)
      .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, [...ids]))),
    (cause): DomainError => unavailableError('chat fork-message delete failed', cause)
  ).map((): void => undefined);
}

/**
 * Binds a fork-delete transaction to the chat deleter, matching the
 * conversations slice's `ForkMessageDeleter` shape. The composition root wires
 * this named factory alongside its other slice deps; conversations invokes the
 * returned deleter with the conversation whose fork is being removed, so the
 * scope predicate above is always supplied.
 */
export function createForkMessageDeleter(
  tx: DbWriter
): (conversationId: string, ids: readonly string[]) => ResultAsync<void, DomainError> {
  return (conversationId, ids) => deleteForkMessagesWithinTx(tx, conversationId, ids);
}
