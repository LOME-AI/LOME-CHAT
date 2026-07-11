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

export interface SnapshotDriftDeps {
  readonly redis: RedisClient;
  readonly db: Database;
  readonly stores: BillingStores;
}

/**
 * The full snapshot-vs-ledger readout, sequences included. A snapshot whose
 * `ledgerSeq` lags the wallet's is ordinary staleness (the CAS write-through
 * is behind by at most the snapshot TTL); a snapshot sequence AHEAD of the
 * ledger is impossible by construction and means the CAS discipline broke.
 */
export interface WalletSnapshotComparison {
  readonly walletId: string;
  readonly snapshotBalanceNanoUsd: bigint;
  readonly ledgerBalanceNanoUsd: bigint;
  /** snapshot − ledger. */
  readonly driftNanoUsd: bigint;
  readonly snapshotLedgerSeq: bigint;
  readonly walletLedgerSeq: bigint;
}

/**
 * Compares the cached admission snapshot against the ledger's balance and
 * sequence. Null when nothing is cached or the wallet row is gone (a miss
 * self-heals via the Postgres re-read, so there is nothing to audit).
 */
export function compareSnapshotToLedger(
  deps: SnapshotDriftDeps,
  walletId: string
): ResultAsync<WalletSnapshotComparison | null, DomainError> {
  return fromPromise(deps.redis.get(BILLING_KEYS.walletSnapshot.buildKey(walletId)), (cause) =>
    unavailableError('snapshot-drift audit: Redis read failed', cause)
  ).andThen((stored) => {
    if (stored === null) return okAsync(null);
    const parsed = walletSnapshotSchema.safeParse(stored);
    if (!parsed.success) {
      return errAsync(validationError('snapshot-drift audit: malformed snapshot', parsed.error));
    }
    const snapshotBalanceNanoUsd = BigInt(parsed.data.balanceNanoUsd);
    const snapshotLedgerSeq = BigInt(parsed.data.ledgerSeq);
    return deps.stores.readWalletSnapshot(deps.db, walletId).map((walletRow) => {
      if (walletRow === null) return null;
      return {
        walletId,
        snapshotBalanceNanoUsd,
        ledgerBalanceNanoUsd: walletRow.balanceNanoUsd,
        driftNanoUsd: snapshotBalanceNanoUsd - walletRow.balanceNanoUsd,
        snapshotLedgerSeq,
        walletLedgerSeq: walletRow.ledgerSeq,
      };
    });
  });
}

const SNAPSHOT_KEY_PREFIX = BILLING_KEYS.walletSnapshot.buildKey('');

/**
 * SCAN examines the whole keyspace regardless of MATCH, so the page size is
 * sized for keyspace traversal, not for the (small, short-TTL) snapshot set.
 */
export const SNAPSHOT_SCAN_PAGE_SIZE = 1000;

/** Hard page cap so the audit's Redis walk is bounded per pass. */
export const SNAPSHOT_SCAN_MAX_PAGES = 500;

/**
 * The wallets that currently hold a cached admission snapshot — the audit
 * population for the snapshot-drift cron. A wallet the SCAN misses (expired
 * mid-walk, or beyond the page cap) is only skipped this pass; the hourly
 * re-run covers it.
 */
export function listSnapshotWalletIds(
  redis: RedisClient
): ResultAsync<readonly string[], DomainError> {
  return fromPromise(scanSnapshotKeys(redis), (cause) =>
    unavailableError('snapshot-drift audit: Redis scan failed', cause)
  );
}

async function scanSnapshotKeys(redis: RedisClient): Promise<readonly string[]> {
  const walletIds: string[] = [];
  let cursor = '0';
  for (let page = 0; page < SNAPSHOT_SCAN_MAX_PAGES; page += 1) {
    const [nextCursor, keys] = await redis.scan(cursor, {
      match: `${SNAPSHOT_KEY_PREFIX}*`,
      count: SNAPSHOT_SCAN_PAGE_SIZE,
    });
    for (const key of keys) {
      walletIds.push(key.slice(SNAPSHOT_KEY_PREFIX.length));
    }
    cursor = nextCursor;
    if (cursor === '0') break;
  }
  return walletIds;
}
