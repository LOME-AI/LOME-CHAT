import { pgTable, index, integer, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { idempotencyKeyKindEnum, idempotencyKeyStatusEnum } from './enums';

/**
 * The dual-role table — request dedup and THE run referee (there is no
 * run table). First arrival INSERTs `claimed` (the unique constraint is the
 * claim); the claims/claimedBy fence has the same semantics as jobs;
 * the live DO heartbeat-touches claimedAt (~90 s lease). TTL purge skips
 * non-terminal rows; read paths never depend on the purge having run.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    // Deliberately not an FK: trial requests scope by trial-session
    // principal, which has no users row.
    userId: uuid('user_id').notNull(),
    route: text('route').notNull(),
    key: text('key').notNull(),
    kind: idempotencyKeyKindEnum('kind').notNull(),
    status: idempotencyKeyStatusEnum('status').notNull().default('claimed'),
    // Canonicalized-JSON hash; reused key + different body ⇒ 409
    bodyHash: text('body_hash').notNull(),
    response: jsonb('response'),
    // Groups a run's usage_records; null on kind=request rows
    runId: uuid('run_id'),
    // Same claims/claimedBy fence semantics as jobs, but the DEFAULT diverges:
    // jobs rows are born `pending` (claims=0) and the dispatcher increments at
    // each claim, whereas here the creating INSERT *is* the first claim (the
    // unique constraint is the claim — see the table comment), so the row is
    // born already claimed by its creator at claims=1. A lease-expired retry
    // then increments to 2, matching the jobs "one claim per attempt" count.
    claims: integer('claims').notNull().default(1),
    claimedBy: text('claimed_by').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('idempotency_keys_scope_unique').on(table.userId, table.route, table.key),
    // Backs the TTL purge cron over terminal rows
    index('idempotency_keys_purge_idx').on(table.completedAt).where(isNotNull(table.completedAt)),
  ]
);
