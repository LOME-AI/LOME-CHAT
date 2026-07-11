import {
  compareSnapshotToLedger,
  createBillingStores,
  listSnapshotWalletIds,
  runConservationAudit,
} from '../slices/billing/index.js';
import { runOrThrow } from './cron.js';
import type { Database } from '@hushbox/db';
import type { Redis } from '@upstash/redis';
import type { ResultAsync } from '../lib/result/index.js';
import type { DomainError } from '../lib/errors/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';
import type {
  ConservationAuditFindings,
  WalletSnapshotComparison,
} from '../slices/billing/index.js';
import type { CronEntry } from './cron.js';

/**
 * The hourly billing auditors: read-only detection, Sentry-visible paging
 * for invariant violations, warn-level (daily-digest) logs for routine
 * drift. Repair is explicit human action — nothing here mutates domain
 * state. Finding details (which transaction, which wallet) live in the
 * database the page points a human at; the telemetry channel carries codes
 * and counts, never row payloads.
 */

export interface ConservationAuditEntryDeps {
  readonly audit: () => ResultAsync<ConservationAuditFindings, DomainError>;
  readonly telemetry: Telemetry;
}

export function createLedgerConservationEntry(deps: ConservationAuditEntryDeps): CronEntry {
  return {
    name: 'ledger-conservation-audit',
    run: async (): Promise<void> => {
      const findings = await runOrThrow(deps.audit());
      if (findings.unbalancedTransactions.length > 0) {
        deps.telemetry.error('ledger conservation audit found unbalanced transactions', {
          errorCode: 'ledger_conservation_unbalanced',
        });
        deps.telemetry.captureError(
          new Error('ledger conservation audit found unbalanced transactions'),
          'ledger_conservation_unbalanced'
        );
      }
      if (findings.walletDrift.length > 0) {
        deps.telemetry.error('ledger conservation audit found wallet balance drift', {
          errorCode: 'ledger_wallet_balance_drift',
        });
        deps.telemetry.captureError(
          new Error('ledger conservation audit found wallet balance drift'),
          'ledger_wallet_balance_drift'
        );
      }
    },
  };
}

export interface SnapshotDriftEntryDeps {
  readonly listWalletIds: () => ResultAsync<readonly string[], DomainError>;
  readonly compare: (walletId: string) => ResultAsync<WalletSnapshotComparison | null, DomainError>;
  readonly telemetry: Telemetry;
}

export function createSnapshotDriftEntry(deps: SnapshotDriftEntryDeps): CronEntry {
  return {
    name: 'wallet-snapshot-drift-audit',
    run: async (): Promise<void> => {
      const walletIds = await runOrThrow(deps.listWalletIds());
      for (const walletId of walletIds) {
        // Contained per wallet: one malformed snapshot must not hide the
        // remaining wallets from this pass.
        const compared = await deps.compare(walletId);
        if (compared.isErr()) {
          deps.telemetry.captureError(
            new Error(compared.error.code, { cause: compared.error }),
            'wallet_snapshot_audit_failed'
          );
          continue;
        }
        const comparison = compared.value;
        if (comparison === null) continue;
        if (comparison.snapshotLedgerSeq > comparison.walletLedgerSeq) {
          // Impossible by construction (the write-through CASes on the
          // ledger sequence) — a page, not digest drift.
          deps.telemetry.error('wallet snapshot ledger sequence is ahead of the ledger', {
            errorCode: 'wallet_snapshot_seq_ahead',
          });
          deps.telemetry.captureError(
            new Error('wallet snapshot ledger sequence is ahead of the ledger'),
            'wallet_snapshot_seq_ahead'
          );
          continue;
        }
        if (comparison.driftNanoUsd !== 0n) {
          deps.telemetry.warn('wallet snapshot balance drifted from the ledger', {
            errorCode: 'wallet_snapshot_drift',
          });
        }
      }
    },
  };
}

export interface BillingAuditProbes {
  readonly audit: ConservationAuditEntryDeps['audit'];
  readonly listWalletIds: SnapshotDriftEntryDeps['listWalletIds'];
  readonly compare: SnapshotDriftEntryDeps['compare'];
}

/** Binds the published billing audit queries to live infra handles. */
export function createBillingAuditProbes(db: Database, redis: Redis): BillingAuditProbes {
  const stores = createBillingStores();
  return {
    audit: () => runConservationAudit(stores, db),
    listWalletIds: () => listSnapshotWalletIds(redis),
    compare: (walletId) => compareSnapshotToLedger({ redis, db, stores }, walletId),
  };
}
