import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BillingStores, StalePendingPayment } from '../ports/index.js';

/**
 * Read-only reconciliation-sweep query for a future auditor cron: it surfaces
 * `pending` pre-claims stranded past the reconcile age (a captured-but-never-
 * recorded charge leaves one). It only detects — repair is the verify job's
 * reference lookup, or explicit human redrive; nothing here mutates.
 */

const RECONCILIATION_FINDINGS_LIMIT = 100;

/**
 * How long a pre-claim may sit `pending` before it is a sweep candidate. Set
 * well past the verify job's delay so a row here means the verify path itself
 * never resolved it, not that it is merely in flight.
 */
export const PENDING_RECONCILE_AGE_SECONDS = 60 * 60;

export interface PendingReconciliationFindings {
  readonly stalePending: readonly StalePendingPayment[];
}

export function runPendingPaymentReconciliation(
  stores: BillingStores,
  db: Database,
  now: Date
): ResultAsync<PendingReconciliationFindings, DomainError> {
  const olderThan = new Date(now.getTime() - PENDING_RECONCILE_AGE_SECONDS * 1000);
  return stores
    .findStalePendingPayments(db, olderThan, RECONCILIATION_FINDINGS_LIMIT)
    .map((stalePending) => ({ stalePending }));
}
