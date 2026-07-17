import { and, count, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  conversationMembers,
  conversations,
  deviceTokens,
  jobs,
  users,
  wallets,
} from '@hushbox/db';
import type { Database } from '@hushbox/db';
import type {
  AdminCrossSliceReads,
  AdminJobCounts,
  AdminJobQueueFilter,
  AdminJobQueueResult,
  AdminJobRow,
} from '../slices/admin/index.js';

const JOB_COLUMNS = {
  id: jobs.id,
  type: jobs.type,
  shard: jobs.shard,
  status: jobs.status,
  discardedAt: jobs.discardedAt,
  failures: jobs.failures,
  claims: jobs.claims,
  payload: jobs.payload,
  errors: jobs.errors,
  nextAttemptAt: jobs.nextAttemptAt,
  createdAt: jobs.createdAt,
  finishedAt: jobs.finishedAt,
} as const;

type JobSelection = Pick<typeof jobs.$inferSelect, keyof typeof JOB_COLUMNS>;

function toJobRow(row: JobSelection): AdminJobRow {
  const { discardedAt, ...rest } = row;
  return { ...rest, discarded: discardedAt !== null };
}

/**
 * Cross-slice read bindings for the admin plane's Customer-360 panels and
 * jobs screens, bound at the composition root: slice code references only
 * its own schema objects (`jobs` is lib-owned; `users` belongs to identity,
 * `wallets` to billing, `device_tokens` to notifications, `conversations`
 * and `conversation_members` to the conversations slice), so these scoped,
 * read-only queries live app-level — the admin slice consumes them through
 * its `AdminCrossSliceReads` port.
 */
export function createAdminCrossSliceReads(db: Database): AdminCrossSliceReads {
  return {
    async userAccountFacts(userId: string) {
      const rows = await db
        .select({ createdAt: users.createdAt, lockReason: users.lockReason })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0] ?? null;
    },

    async walletSummaries(userId: string) {
      return db
        .select({ id: wallets.id, type: wallets.type, balanceNanoUsd: wallets.balanceNanoUsd })
        .from(wallets)
        .where(eq(wallets.userId, userId))
        .orderBy(wallets.type);
    },

    async deviceTokenSummary(userId: string) {
      // Deliberately never selects the token column — the token value is
      // push credential material and must not leave the server.
      const tokens = await db
        .select({ platform: deviceTokens.platform })
        .from(deviceTokens)
        .where(eq(deviceTokens.userId, userId))
        .orderBy(deviceTokens.id);
      return { count: tokens.length, tokens };
    },

    async conversationCounts(userId: string) {
      const [owned, memberships] = await Promise.all([
        db.select({ value: count() }).from(conversations).where(eq(conversations.userId, userId)),
        db
          .select({ value: count() })
          .from(conversationMembers)
          .where(and(eq(conversationMembers.userId, userId), isNull(conversationMembers.leftAt))),
      ]);
      // Summing the single-row count() result avoids a dead "no row" branch.
      return {
        owned: owned.reduce((sum, row) => sum + row.value, 0),
        activeMemberships: memberships.reduce((sum, row) => sum + row.value, 0),
      };
    },

    async jobsTouchingUser(userId: string, limit: number) {
      // Payload-based on purpose (jobs carry no user column); add a
      // `jobs.targetUserId` payload index when this panel gets hot.
      // LIMIT-bounded, admin-volume only.
      const rows = await db
        .select(JOB_COLUMNS)
        .from(jobs)
        .where(sql`${jobs.payload} ->> 'userId' = ${userId}`)
        .orderBy(desc(jobs.id))
        .limit(limit);
      return rows.map((row) => toJobRow(row));
    },

    async listJobs(filter: AdminJobQueueFilter): Promise<AdminJobQueueResult> {
      const conditions = [
        filter.type === undefined ? undefined : eq(jobs.type, filter.type),
        ...statusConditions(filter.status),
        filter.cursor === undefined ? undefined : lt(jobs.id, filter.cursor),
      ].filter((condition) => condition !== undefined);
      const rows = await db
        .select(JOB_COLUMNS)
        .from(jobs)
        .where(and(...conditions))
        .orderBy(desc(jobs.id))
        .limit(filter.limit);
      const last = rows.at(-1);
      return {
        rows: rows.map((row) => toJobRow(row)),
        nextCursor: rows.length === filter.limit && last !== undefined ? last.id : null,
      };
    },

    async jobCounts(): Promise<AdminJobCounts> {
      const grouped = await db
        .select({
          status: jobs.status,
          discarded: isNotNull(jobs.discardedAt).mapWith(Boolean).as('discarded'),
          value: count(),
        })
        .from(jobs)
        .groupBy(jobs.status, isNotNull(jobs.discardedAt));
      const totals = { pending: 0, running: 0, dead: 0, discarded: 0 };
      for (const bucket of grouped) {
        const key = countBucketKey(bucket.status, bucket.discarded);
        if (key !== null) totals[key] += bucket.value;
      }
      return totals;
    },
  };
}

function countBucketKey(status: string, discarded: boolean): keyof AdminJobCounts | null {
  if (status === 'pending') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'dead') return discarded ? 'discarded' : 'dead';
  return null;
}

function statusConditions(status: AdminJobQueueFilter['status']) {
  if (status === undefined) return [];
  if (status === 'discarded') return [eq(jobs.status, 'dead'), isNotNull(jobs.discardedAt)];
  if (status === 'dead') return [eq(jobs.status, 'dead'), isNull(jobs.discardedAt)];
  return [eq(jobs.status, status)];
}
