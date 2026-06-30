import { pgTable, bigint, check, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { houseAccountEnum, ledgerEntryKindEnum } from './enums';
import { payments } from './payments';
import { usageRecords } from './usage-records';
import { wallets } from './wallets';

/**
 * Lightweight double-entry — signed legs sharing a transactionId summing
 * to zero (enforced at commit by a deferred constraint trigger in a
 * hand-written migration; Drizzle does not model triggers). Each leg hits exactly one of
 * a user wallet or a house account; a running balance exists only on
 * user-wallet legs (a balance on a house row would serialize settlements).
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    transactionId: uuid('transaction_id').notNull(),
    walletId: uuid('wallet_id').references(() => wallets.id, { onDelete: 'restrict' }),
    houseAccount: houseAccountEnum('house_account'),
    kind: ledgerEntryKindEnum('kind').notNull(),
    amountNanoUsd: bigint('amount_nano_usd', { mode: 'bigint' }).notNull(),
    balanceAfterNanoUsd: bigint('balance_after_nano_usd', { mode: 'bigint' }),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    usageRecordId: uuid('usage_record_id').references(() => usageRecords.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('ledger_entries_transaction_id_idx').on(table.transactionId),
    index('ledger_entries_wallet_created_idx').on(table.walletId, table.createdAt),
    index('ledger_entries_payment_id_idx').on(table.paymentId).where(isNotNull(table.paymentId)),
    index('ledger_entries_usage_record_id_idx')
      .on(table.usageRecordId)
      .where(isNotNull(table.usageRecordId)),
    check(
      'ledger_entries_one_account',
      sql`num_nonnulls(${table.walletId}, ${table.houseAccount}) = 1`
    ),
    check(
      'ledger_entries_balance_on_wallet_legs',
      sql`(${table.balanceAfterNanoUsd} IS NOT NULL) = (${table.walletId} IS NOT NULL)`
    ),
  ]
);
