import {
  pgTable,
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { jobShardEnum, jobStatusEnum } from './enums';

/**
 * The jobs system. The row is the record, the dead-letter store, and the
 * audit trail. `type` is text by design (versioned job-type names — the one
 * exception to the pgEnum rule). `payload` is mutable checkpoint state;
 * checkpoint and terminal writes pass the claims/claimedBy completion fence.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    type: text('type').notNull(),
    shard: jobShardEnum('shard').notNull().default('default'),
    priority: integer('priority').notNull().default(0),
    payload: jsonb('payload').notNull(),
    result: jsonb('result'),
    dedupeKey: text('dedupe_key'),
    status: jobStatusEnum('status').notNull().default('pending'),
    // Poison detection: incremented at claim, so deploys never burn retries
    claims: integer('claims').notNull().default(0),
    maxClaims: integer('max_claims').notNull(),
    // Drives backoff and the dead transition
    failures: integer('failures').notNull().default(0),
    maxFailures: integer('max_failures').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).defaultNow().notNull(),
    // Delayed start = future value; retries land at exact backoff
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    // Lease anchor + completion-fence identity; long jobs heartbeat-touch
    // claimedAt through the same fence as terminal writes
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    leaseSeconds: integer('lease_seconds').notNull(),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    // Full failure history
    errors: jsonb('errors')
      .$type<{ at: string; claim: number; error: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // Exactly these three partial indexes, by design
    index('jobs_claim_idx')
      .on(table.shard, table.priority, table.nextAttemptAt)
      .where(sql`${table.status} IN ('pending', 'running')`),
    uniqueIndex('jobs_dedupe_key_unique')
      .on(table.dedupeKey)
      .where(sql`${table.status} IN ('pending', 'running')`),
    index('jobs_prune_idx')
      .on(table.finishedAt)
      .where(sql`${table.status} = 'succeeded'`),
  ]
);
