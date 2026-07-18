import type { Database } from '@hushbox/db';
import type { AdminStores } from '../ports/index.js';

/**
 * The coarse read-audit actions (Charter #3/#12: sensitive reads are
 * audited). One row per Customer-360 view; one row per SQL-panel query —
 * written on the request connection, not inside any transaction (reads skip
 * the tx machinery), and BEFORE the read executes for the SQL panel so a
 * refused or failed query is still on the record.
 */
export const READ_AUDIT_ACTIONS = {
  customer360: 'read.customer360',
  sqlPanel: 'read.sqlPanel',
  feedbackView: 'read.feedbackView',
  newsletterSubscribers: 'read.newsletterSubscribers',
} as const;

export interface ReadAuditEntry {
  readonly actor: string;
  readonly action: (typeof READ_AUDIT_ACTIONS)[keyof typeof READ_AUDIT_ACTIONS];
  readonly targetType?: string;
  readonly targetId?: string;
  /** Wire-JSON read parameters (a 360 query, a SQL query text) — never results. */
  readonly details: Record<string, unknown>;
}

export async function writeReadAudit(
  stores: AdminStores,
  db: Database,
  entry: ReadAuditEntry
): Promise<{ id: string }> {
  return stores.insertAudit(db, entry);
}
