import { z } from 'zod';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { contentItemView, contentItemViewSchema } from './content-item-view.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConversationsStores, HistoryMessageRow } from '../ports/index.js';
import type { Outcome } from './outcomes.js';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

export const historyMessageSchema = z.object({
  id: z.string(),
  parentMessageId: z.string().nullable(),
  sequenceNumber: z.number().int(),
  epochNumber: z.number().int(),
  senderType: z.enum(['user', 'assistant', 'system']),
  senderId: z.string().nullable(),
  /** Base64 wrap of the message content key — the client unwraps it to decrypt. */
  wrappedContentKey: z.string(),
  batchId: z.string(),
  contentItems: z.array(contentItemViewSchema),
});

export type HistoryMessage = z.infer<typeof historyMessageSchema>;

export const messageHistorySchema = z.object({
  messages: z.array(historyMessageSchema),
  /** The next page's cursor (the last sequence number), or null at the end. */
  nextCursor: z.string().nullable(),
});

export type MessageHistoryView = z.infer<typeof messageHistorySchema>;

/**
 * A page of the caller's conversation history, from their `visibleFromEpoch`
 * forward — the only path a second device, a reload, or a newly-added member has
 * to load prior messages. Membership-gated; a non-member gets the
 * indistinguishable not-found. Messages page by `sequenceNumber` (the cursor);
 * content items are ordered by `position` within each message. A member with a
 * later visibility floor never sees an earlier epoch's messages.
 */
export function getMessageHistory(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly cursor?: number;
    readonly limit?: number;
  }
): ResultAsync<Outcome<MessageHistoryView>, DomainError> {
  const limit = Math.min(params.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  return stores.members
    .activeByUser(params.conversationId, params.callerUserId)
    .andThen((caller) => {
      if (caller === null) return okAsync<Outcome<MessageHistoryView>>({ refusal: 'not-found' });
      return stores.messages
        .history({
          conversationId: params.conversationId,
          minEpoch: caller.visibleFromEpoch,
          afterSequence: params.cursor ?? null,
          // Over-fetch one to detect a further page without a second query.
          limit: limit + 1,
        })
        .map((rows): Outcome<MessageHistoryView> => {
          const hasMore = rows.length > limit;
          const page = hasMore ? rows.slice(0, limit) : rows;
          const last = page.at(-1);
          return {
            messages: page.map((row) => historyMessageView(row)),
            nextCursor: hasMore && last !== undefined ? String(last.sequenceNumber) : null,
          };
        });
    });
}

function historyMessageView(row: HistoryMessageRow): HistoryMessage {
  return {
    id: row.id,
    parentMessageId: row.parentMessageId,
    sequenceNumber: row.sequenceNumber,
    epochNumber: row.epochNumber,
    senderType: row.senderType,
    senderId: row.senderId,
    wrappedContentKey: toBase64(row.wrappedContentKey),
    batchId: row.batchId,
    contentItems: row.contentItems.map((item) => contentItemView(item)),
  };
}
