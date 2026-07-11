import { eq } from 'drizzle-orm';
import { contentItems, messages } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * A content item joined to its message's conversation and epoch — everything
 * media's presign authorization needs from chat-owned rows. The epoch is the
 * message's epoch NUMBER; media resolves it to the epoch row id through the
 * conversations barrel, since `epochs` belongs to that slice (single-writer).
 */
export interface ContentItemPresignRow {
  readonly contentItemId: string;
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly contentType: string;
  readonly storageKey: string | null;
}

function storeFailure(cause: unknown): DomainError {
  return unavailableError('chat presign read failed', cause);
}

/**
 * The chat slice's published presign read: `content_items ⋈ messages` for one
 * content item. Chat is the single writer of both tables, so this join lives
 * here and the composition root composes it with the conversations reads. A
 * missing item answers null (media translates that to a blind not_found).
 */
export function findContentItemForPresign(
  db: DbWriter,
  contentItemId: string
): ResultAsync<ContentItemPresignRow | null, DomainError> {
  return fromPromise(
    db
      .select({
        contentItemId: contentItems.id,
        conversationId: messages.conversationId,
        epochNumber: messages.epochNumber,
        contentType: contentItems.contentType,
        storageKey: contentItems.storageKey,
      })
      .from(contentItems)
      .innerJoin(messages, eq(contentItems.messageId, messages.id))
      .where(eq(contentItems.id, contentItemId)),
    storeFailure
  ).map((rows) => rows[0] ?? null);
}
