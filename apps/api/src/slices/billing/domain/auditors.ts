import { unavailableError, validationError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { BILLING_KEYS, walletSnapshotSchema } from './keys.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BillingStores, UnbalancedTransaction, WalletDrift } from '../ports/index.js';
import type { RedisClient } from './keys.js';

/**
 * Read-only conservation probes the hourly conservation cron consumes:
 * auditors detect and page, repair is explicit — nothing here writes.
 */

const AUDIT_FINDINGS_LIMIT = 100;

export interface ConservationAuditFindings {
  /** Transaction groups whose signed legs do not sum to zero. */
  readonly unbalancedTransactions: readonly UnbalancedTransaction[];
  /** Wallets whose running balance diverged from Σ of their legs. */
  readonly walletDrift: readonly WalletDrift[];
}

export function runConservationAudit(
  stores: BillingStores,
  db: Database
): ResultAsync<ConservationAuditFindings, DomainError> {
  return stores
    .findUnbalancedTransactions(db, AUDIT_FINDINGS_LIMIT)
    .andThen((unbalancedTransactions) =>
      stores
        .findWalletDrift(db, AUDIT_FINDINGS_LIMIT)
        .map((walletDrift) => ({ unbalancedTransactions, walletDrift }))
    );
}

export interface SnapshotDrift {
  readonly walletId: string;
  readonly snapshotBalanceNanoUsd: bigint;
  readonly ledgerBalanceNanoUsd: bigint;
  /** snapshot − ledger; the auditor alerts past its divergence bound. */
  readonly driftNanoUsd: bigint;
}

export interface SnapshotDriftDeps {
  readonly redis: RedisClient;
  readonly db: Database;
  readonly stores: BillingStores;
}

/**
 * Compares the cached admission snapshot against the ledger's balance. Null
 * when nothing is cached (a miss self-heals via the Postgres re-read, so
 * there is nothing to audit).
 */
export function findSnapshotDrift(
  deps: SnapshotDriftDeps,
  walletId: string
): ResultAsync<SnapshotDrift | null, DomainError> {
  return fromPromise(deps.redis.get(BILLING_KEYS.walletSnapshot.buildKey(walletId)), (cause) =>
    unavailableError('snapshot-drift audit: Redis read failed', cause)
  ).andThen((stored) => {
    if (stored === null) return okAsync(null);
    const parsed = walletSnapshotSchema.safeParse(stored);
    if (!parsed.success) {
      return errAsync(validationError('snapshot-drift audit: malformed snapshot', parsed.error));
    }
    const snapshotBalanceNanoUsd = BigInt(parsed.data.balanceNanoUsd);
    return deps.stores.readWalletSnapshot(deps.db, walletId).map((walletRow) => {
      if (walletRow === null) return null;
      return {
        walletId,
        snapshotBalanceNanoUsd,
        ledgerBalanceNanoUsd: walletRow.balanceNanoUsd,
        driftNanoUsd: snapshotBalanceNanoUsd - walletRow.balanceNanoUsd,
      };
    });
  });
}
