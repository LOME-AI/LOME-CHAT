import { pgTable, bigint, boolean, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { contentItems } from './content-items';
import { conversations } from './conversations';
import { modalityEnum } from './enums';
import { sharedLinks } from './shared-links';
import { users } from './users';

/**
 * Saved ⟺ billed is referential at insert — every row is inserted with a
 * non-null contentItemId inside settle(); the column stays nullable with
 * ON DELETE SET NULL so financial retention survives hard deletion.
 */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    // The turn's SENDER, first-class and independently queryable beside
    // `userId`. The two resolve to different people on a group turn, and
    // `userId` is NOT the charged wallet's owner: it is the initiating member
    // on a user turn — even when an owner-funded turn debits the OWNER's
    // wallet — and the owner on a link-guest turn (a guest has no users row).
    // Grouping spend by `user_id` therefore groups by initiator; who funded it
    // is recoverable only from the ledger legs. Exactly one side is
    // written at insert, mirroring conversation_members' principal pair:
    // senderUserId for a member sender, senderLinkId for a link-guest sender
    // (a guest has no users row, so a users FK alone cannot record it). Both
    // stay nullable with ON DELETE SET NULL — financial retention survives the
    // sender's hard deletion, so a both-null row is the pseudonymized state,
    // never an insert-time state.
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    senderLinkId: uuid('sender_link_id').references(() => sharedLinks.id, {
      onDelete: 'set null',
    }),
    contentItemId: uuid('content_item_id').references(() => contentItems.id, {
      onDelete: 'set null',
    }),
    // Plain grouping uuid — there is no run table
    runId: uuid('run_id').notNull(),
    // The conversation this charge belongs to, stamped at settlement so
    // per-conversation spend analytics can group by it. Nullable with ON DELETE
    // SET NULL: financial retention survives hard conversation deletion.
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    // The serving model and provider captured as plain strings — no FK into
    // model_catalog: the charged cost is authoritative on this row (OpenRouter
    // returns it inline), so no catalog join is needed, and the decoupling
    // frees billing's retention from the models slice's lifecycle.
    modelId: text('model_id').notNull(),
    providerName: text('provider_name').notNull(),
    // The monthly invoice auditor reconciles Σ cost per modality
    modality: modalityEnum('modality').notNull(),
    // Gateway generation id (one per generation under the run)
    generationId: text('generation_id'),
    costNanoUsd: bigint('cost_nano_usd', { mode: 'bigint' }).notNull(),
    isEstimated: boolean('is_estimated').notNull().default(false),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('usage_records_user_id_idx').on(table.userId).where(isNotNull(table.userId)),
    index('usage_records_content_item_id_idx')
      .on(table.contentItemId)
      .where(isNotNull(table.contentItemId)),
    // Sender-keyed spend queries plus the deletion path's SET NULL scans.
    index('usage_records_sender_user_id_idx')
      .on(table.senderUserId)
      .where(isNotNull(table.senderUserId)),
    index('usage_records_sender_link_id_idx')
      .on(table.senderLinkId)
      .where(isNotNull(table.senderLinkId)),
    // Per-conversation spend analytics groups the caller's rows by conversation.
    index('usage_records_conversation_id_idx')
      .on(table.conversationId)
      .where(isNotNull(table.conversationId)),
    // Usage analytics groups and keyset-paginates by modelId.
    index('usage_records_model_id_idx').on(table.modelId),
    index('usage_records_run_id_idx').on(table.runId),
    // Public-stats windowed aggregates (7d/30d + daily trend buckets) scan by
    // created_at; every other index here is id-based.
    index('usage_records_created_at_idx').on(table.createdAt),
  ]
);
