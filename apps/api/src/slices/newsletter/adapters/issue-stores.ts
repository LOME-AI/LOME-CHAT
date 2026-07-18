import { and, desc, eq, lt } from 'drizzle-orm';
import { newsletterIssues } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { DbWriter } from '../../../lib/idempotency/transaction.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

export type NewsletterIssueRow = typeof newsletterIssues.$inferSelect;

/** One mapper for every issue read: infra rejections become `unavailable`. */
function issueStoreFailure(cause: unknown): DomainError {
  return unavailableError('newsletter issue store query failed', cause);
}

export interface CreateIssueParams {
  readonly subject: string;
  readonly bodyMarkdown: string;
  readonly scheduledAt: Date;
  /** The admin email from the Access JWT (no users FK — admins are not product users). */
  readonly createdBy: string;
}

/**
 * WithinTx composition surface for the admin scheduling op: the issue insert
 * commits (or rolls back) with the caller's transaction — alongside its
 * `admin_audit` row and dispatch enqueue. Infra failures throw, aborting the
 * enclosing transaction (the billing WithinTx precedent).
 */
export async function createIssueWithinTx(
  tx: DbWriter,
  params: CreateIssueParams
): Promise<NewsletterIssueRow> {
  const rows = await tx
    .insert(newsletterIssues)
    .values({ ...params, status: 'scheduled' })
    .returning();
  return mustInsertedRow(rows[0]);
}

/**
 * An INSERT … RETURNING with no ON CONFLICT always returns its row; a missing
 * one is a driver defect, thrown so the enclosing transaction aborts.
 */
export function mustInsertedRow(row: NewsletterIssueRow | undefined): NewsletterIssueRow {
  if (row === undefined) {
    throw new Error('newsletter issue insert returned no row');
  }
  return row;
}

export type CancelIssueResult =
  | { readonly kind: 'canceled' }
  | { readonly kind: 'already-canceled' }
  | { readonly kind: 'illegal-state'; readonly status: 'sending' | 'sent' }
  | { readonly kind: 'not-found' };

/**
 * Atomic `scheduled → canceled`; on 0 rows the actual state is read and
 * classified (never check-then-act): already-canceled converges as a no-op,
 * a `sending`/`sent` issue is an illegal cancel — dispatch has claimed it.
 */
export async function cancelIssueWithinTx(
  tx: DbWriter,
  issueId: string
): Promise<CancelIssueResult> {
  const rows = await tx
    .update(newsletterIssues)
    .set({ status: 'canceled', canceledAt: new Date() })
    .where(and(eq(newsletterIssues.id, issueId), eq(newsletterIssues.status, 'scheduled')))
    .returning({ id: newsletterIssues.id });
  if (rows.length === 1) return { kind: 'canceled' };

  const current = await tx
    .select({ status: newsletterIssues.status })
    .from(newsletterIssues)
    .where(eq(newsletterIssues.id, issueId));
  const row = current[0];
  if (row === undefined) return { kind: 'not-found' };
  if (row.status === 'canceled') return { kind: 'already-canceled' };
  if (row.status === 'sending' || row.status === 'sent') {
    return { kind: 'illegal-state', status: row.status };
  }
  // Still `scheduled` after a 0-row conditional cancel cannot happen inside
  // one transaction's snapshot — it means the WHERE and this read disagree.
  /* v8 ignore next -- unreachable by the snapshot argument above */
  throw new Error('newsletter issue cancel observed an impossible state');
}

export function getIssueById(
  db: Database,
  issueId: string
): ResultAsync<NewsletterIssueRow | null, DomainError> {
  return fromPromise(
    db.select().from(newsletterIssues).where(eq(newsletterIssues.id, issueId)),
    issueStoreFailure
  ).map((rows) => rows[0] ?? null);
}

export interface ListIssuesParams {
  readonly limit: number;
  /** Keyset cursor: the last issue id of the previous page (uuidv7 = time-ordered). */
  readonly cursor?: string | undefined;
}

export interface ListIssuesPage {
  readonly issues: readonly NewsletterIssueRow[];
  readonly nextCursor: string | null;
}

export function listIssues(
  db: Database,
  params: ListIssuesParams
): ResultAsync<ListIssuesPage, DomainError> {
  return fromPromise(
    db
      .select()
      .from(newsletterIssues)
      .where(params.cursor === undefined ? undefined : lt(newsletterIssues.id, params.cursor))
      .orderBy(desc(newsletterIssues.id))
      .limit(params.limit + 1),
    issueStoreFailure
  ).map((rows) => buildIssuesPage(rows, params.limit));
}

/** Exported for direct edge coverage; `listIssues` is its only product caller. */
export function buildIssuesPage(
  rows: readonly NewsletterIssueRow[],
  limit: number
): ListIssuesPage {
  if (rows.length <= limit) {
    return { issues: rows, nextCursor: null };
  }
  const issues = rows.slice(0, limit);
  const last = issues.at(-1);
  if (last === undefined) {
    return { issues, nextCursor: null };
  }
  return { issues, nextCursor: last.id };
}
