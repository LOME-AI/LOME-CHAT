import { pgTable, bigint, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { paymentStatusEnum } from './enums';
import { users } from './users';

/** The durable pre-claim written before the card charge. */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    // SET NULL: financial rows survive hard user deletion, pseudonymized
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    amountNanoUsd: bigint('amount_nano_usd', { mode: 'bigint' }).notNull(),
    status: paymentStatusEnum('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull().unique(),

    // Helcim identifiers (cardLastFour keeps rows pseudonymous, not anonymous)
    helcimTransactionId: text('helcim_transaction_id').unique(),
    cardType: text('card_type'),
    cardLastFour: text('card_last_four'),

    // Errors carry codes, never content (CODE-RULES telemetry doctrine)
    errorCode: text('error_code'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    webhookReceivedAt: timestamp('webhook_received_at', { withTimezone: true }),
  },
  (table) => [index('payments_user_id_idx').on(table.userId)]
);
