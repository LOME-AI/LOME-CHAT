import { and, asc, count, eq } from 'drizzle-orm';
import { contentItems, llmCompletions, messages, usageRecords } from '@hushbox/db';
import type { Database } from '@hushbox/db';

/** First aggregate row's count, 0 when the query returned no row. */
export function firstCount(rows: readonly { count: number }[]): number {
  return rows[0]?.count ?? 0;
}

/**
 * Read-only E2E observation queries over the new schema. Semantic
 * adaptations from legacy (which joined `usage_records.sourceId`):
 * settlement now stamps `usage_records.conversationId` directly and anchors
 * each charge to its content item, so the joins run through those columns.
 */

/** Rows in `llm_completions` for a conversation's settled charges. */
export async function countLlmCompletions(db: Database, conversationId: string): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(llmCompletions)
    .innerJoin(usageRecords, eq(usageRecords.id, llmCompletions.usageRecordId))
    .where(eq(usageRecords.conversationId, conversationId));
  return firstCount(rows);
}

export interface MessagePayerRow {
  readonly messageId: string;
  readonly payerId: string | null;
}

/**
 * Each assistant message's resolved payer: `usage_records.payerUserId`, the
 * owner of the wallet settlement debited, reached through the charge's anchor
 * content item. It names the conversation owner on an owner-funded turn and the
 * sender on a self-funded one.
 */
export async function listMessagePayers(
  db: Database,
  conversationId: string
): Promise<MessagePayerRow[]> {
  const aiMessages = await db
    .select({ messageId: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'assistant')))
    .orderBy(asc(messages.sequenceNumber));

  const charges = await db
    .select({ messageId: contentItems.messageId, payerId: usageRecords.payerUserId })
    .from(usageRecords)
    .innerJoin(contentItems, eq(contentItems.id, usageRecords.contentItemId))
    .where(eq(usageRecords.conversationId, conversationId));

  const payerByMessage = new Map<string, string | null>();
  for (const charge of charges) {
    if (!payerByMessage.has(charge.messageId)) {
      payerByMessage.set(charge.messageId, charge.payerId);
    }
  }

  return aiMessages.map((message) => ({
    messageId: message.messageId,
    payerId: payerByMessage.get(message.messageId) ?? null,
  }));
}

const NANO_FRACTION_DIGITS = 9;

/** Nano-USD bigint rendered as a plain decimal USD string (legacy `numeric::text` shape). */
export function nanoUsdToDecimalString(nanoUsd: bigint): string {
  const negative = nanoUsd < 0n;
  const magnitude = negative ? -nanoUsd : nanoUsd;
  const whole = magnitude / 1_000_000_000n;
  const fraction = String(magnitude % 1_000_000_000n).padStart(NANO_FRACTION_DIGITS, '0');
  return `${negative ? '-' : ''}${String(whole)}.${fraction}`;
}

/**
 * Total actual cost charged for a conversation's SURVIVING content — the
 * inner joins through the anchor content item and its message drop charges
 * whose content was later deleted (`contentItemId` is SET NULL on deletion),
 * matching the legacy "surviving AI messages" scope.
 */
export async function conversationCost(db: Database, conversationId: string): Promise<string> {
  const rows = await db
    .select({ costNanoUsd: usageRecords.costNanoUsd })
    .from(usageRecords)
    .innerJoin(contentItems, eq(contentItems.id, usageRecords.contentItemId))
    .innerJoin(messages, eq(messages.id, contentItems.messageId))
    .where(eq(usageRecords.conversationId, conversationId));
  let total = 0n;
  for (const row of rows) total += row.costNanoUsd;
  return nanoUsdToDecimalString(total);
}
