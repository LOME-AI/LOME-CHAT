import { z } from 'zod';
import { nanoUSD, serializeNanoUSD, toBase64, trimPage } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { resolveCallerMember } from './caller.js';
import { contentItemView, contentItemViewSchema } from './content-item-view.js';
import type { ConversationCaller } from './caller.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ContentItemRow, ConversationsStores, HistoryMessageRow } from '../ports/index.js';
import type { Outcome } from './outcomes.js';

/**
 * The history read's content-item wire shape: the shared slim view PLUS the
 * settled display metadata (model, billed cost, smart-model flag). Kept
 * separate from `contentItemViewSchema` on purpose — the unauthenticated
 * public-share read reuses the slim base view and must never carry these
 * fields, so widening the base view is not an option; the history read extends
 * it here instead.
 */
export const historyContentItemViewSchema = contentItemViewSchema.extend({
  /** The generating model id, or null for user/system items. */
  modelName: z.string().nullable(),
  /** Total billed cost anchored to this item as a canonical NanoUSD string, or null. */
  cost: z.string().nullable(),
  isSmartModel: z.boolean(),
  /**
   * Persisted reasoning-token count for the generation(s) anchored to this
   * item, or null when none was recorded. Drives the settled thinking label.
   */
  reasoningTokens: z.number().int().nullable(),
});

export type HistoryContentItemView = z.infer<typeof historyContentItemViewSchema>;

function historyContentItemView(row: ContentItemRow): HistoryContentItemView {
  return {
    ...contentItemView(row),
    modelName: row.modelId,
    cost: row.costNanoUsd === null ? null : serializeNanoUSD(nanoUSD(row.costNanoUsd)),
    isSmartModel: row.isSmartModel,
    reasoningTokens: row.reasoningTokens,
  };
}

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
  contentItems: z.array(historyContentItemViewSchema),
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
 * forward — the path a second device, a reload, a newly-added member, or a
 * shared-link guest has to load prior messages. Guest-reachable, so it takes a
 * resolved `ConversationCaller` (user OR link guest) and gates through the
 * shared `resolveCallerMember` active-member check — a revoked guest (its row
 * left) or a non-member gets the indistinguishable not-found. The caller's own
 * member row supplies the `visibleFromEpoch` floor, so a rotation-seated guest
 * (or a late-joining member) never sees an earlier epoch's messages. Messages
 * page by `sequenceNumber` (the cursor); content items order by `position`
 * within each message.
 */
export function getMessageHistory(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly caller: ConversationCaller;
    readonly cursor?: number;
    readonly limit?: number;
  }
): ResultAsync<Outcome<MessageHistoryView>, DomainError> {
  const limit = Math.min(params.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  return resolveCallerMember(stores, params.conversationId, params.caller).andThen((caller) => {
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
        const { page, hasMore } = trimPage(rows, limit);
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
    contentItems: row.contentItems.map((item) => historyContentItemView(item)),
  };
}
