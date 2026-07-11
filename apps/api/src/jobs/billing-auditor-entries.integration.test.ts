import { Redis } from '@upstash/redis';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { afterAll, describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import { writeThroughSnapshot } from '../slices/billing/index.js';
import { BILLING_KEYS } from '../slices/billing/domain/keys.js';
import {
  createBillingAuditProbes,
  createLedgerConservationEntry,
  createSnapshotDriftEntry,
} from './billing-auditor-entries.js';
import type { SafeLogFields, Telemetry } from '../lib/telemetry/index.js';
import type { WalletSnapshotComparison } from '../slices/billing/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Redis env are required for billing auditor entry tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

interface TelemetryRecorder {
  readonly telemetry: Telemetry;
  readonly errors: { msg: string; fields: SafeLogFields | undefined }[];
  readonly warns: { msg: string; fields: SafeLogFields | undefined }[];
  readonly captured: string[];
}

function recordingTelemetry(): TelemetryRecorder {
  const errors: TelemetryRecorder['errors'] = [];
  const warns: TelemetryRecorder['warns'] = [];
  const captured: string[] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: SafeLogFields) => {
      warns.push({ msg, fields });
    },
    error: (msg: string, fields?: SafeLogFields) => {
      errors.push({ msg, fields });
    },
    emitMetric: () => {},
    captureError: (_error, code: string) => {
      captured.push(code);
    },
  };
  return { telemetry, errors, warns, captured };
}

function comparison(overrides: Partial<WalletSnapshotComparison>): WalletSnapshotComparison {
  return {
    walletId: crypto.randomUUID(),
    snapshotBalanceNanoUsd: 100n,
    ledgerBalanceNanoUsd: 100n,
    driftNanoUsd: 0n,
    snapshotLedgerSeq: 1n,
    walletLedgerSeq: 1n,
    ...overrides,
  };
}

afterAll(async () => {
  await db.$client.end();
});

describe('createLedgerConservationEntry', () => {
  it('pages on an unbalanced transaction', async () => {
    const recorder = recordingTelemetry();
    const entry = createLedgerConservationEntry({
      audit: () =>
        okAsync({
          unbalancedTransactions: [{ transactionId: crypto.randomUUID(), totalNanoUsd: -7n }],
          walletDrift: [],
        }),
      telemetry: recorder.telemetry,
    });
    expect(entry.name).toBe('ledger-conservation-audit');
    await entry.run();
    expect(recorder.captured).toEqual(['ledger_conservation_unbalanced']);
  });

  it('pages on wallet balance drift', async () => {
    const recorder = recordingTelemetry();
    const entry = createLedgerConservationEntry({
      audit: () =>
        okAsync({
          unbalancedTransactions: [],
          walletDrift: [{ walletId: crypto.randomUUID(), balanceNanoUsd: 5n, legSumNanoUsd: 0n }],
        }),
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.captured).toEqual(['ledger_wallet_balance_drift']);
  });

  it('stays silent on a conserved ledger', async () => {
    const recorder = recordingTelemetry();
    const entry = createLedgerConservationEntry({
      audit: () => okAsync({ unbalancedTransactions: [], walletDrift: [] }),
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.captured).toEqual([]);
    expect(recorder.errors).toEqual([]);
  });

  it('propagates an audit failure to the entry runner', async () => {
    const entry = createLedgerConservationEntry({
      audit: () => errAsync(unavailableError('db down')),
      telemetry: recordingTelemetry().telemetry,
    });
    await expect(entry.run()).rejects.toThrow('unavailable');
  });
});

describe('createSnapshotDriftEntry', () => {
  it('pages when a snapshot sequence is ahead of the ledger', async () => {
    const recorder = recordingTelemetry();
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a']),
      compare: () =>
        okAsync(comparison({ snapshotLedgerSeq: 9n, walletLedgerSeq: 3n, driftNanoUsd: 0n })),
      telemetry: recorder.telemetry,
    });
    expect(entry.name).toBe('wallet-snapshot-drift-audit');
    await entry.run();
    expect(recorder.captured).toEqual(['wallet_snapshot_seq_ahead']);
    expect(recorder.warns).toEqual([]);
  });

  it('warns (digest level) on ordinary balance drift', async () => {
    const recorder = recordingTelemetry();
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a']),
      compare: () =>
        okAsync(comparison({ snapshotLedgerSeq: 1n, walletLedgerSeq: 2n, driftNanoUsd: -300n })),
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.captured).toEqual([]);
    expect(recorder.warns).toEqual([
      {
        msg: 'wallet snapshot balance drifted from the ledger',
        fields: { errorCode: 'wallet_snapshot_drift' },
      },
    ]);
  });

  it('stays silent on aligned snapshots and skips missing ones', async () => {
    const recorder = recordingTelemetry();
    let calls = 0;
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a', 'wallet-b']),
      compare: () => {
        calls += 1;
        return calls === 1 ? okAsync(comparison({})) : okAsync(null);
      },
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.captured).toEqual([]);
    expect(recorder.warns).toEqual([]);
  });

  it('contains a single wallet audit failure and keeps auditing the rest', async () => {
    const recorder = recordingTelemetry();
    const audited: string[] = [];
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a', 'wallet-b']),
      compare: (walletId) => {
        audited.push(walletId);
        return walletId === 'wallet-a'
          ? errAsync(unavailableError('redis blip'))
          : okAsync(comparison({}));
      },
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(audited).toEqual(['wallet-a', 'wallet-b']);
    expect(recorder.captured).toEqual(['wallet_snapshot_audit_failed']);
  });
});

describe('createBillingAuditProbes', () => {
  it('runs the real read-only probes end to end', async () => {
    const probes = createBillingAuditProbes(db, redis);
    const findings = await probes.audit();
    expect(findings.isOk()).toBe(true);
    const walletId = crypto.randomUUID();
    const written = await writeThroughSnapshot(redis, {
      walletId,
      balanceNanoUsd: 1n,
      ledgerSeq: 1n,
      walletType: 'purchased',
    });
    written._unsafeUnwrap();
    try {
      const walletIds = await probes.listWalletIds();
      expect(walletIds._unsafeUnwrap()).toContain(walletId);
      // No wallets row exists for the seeded id, so the comparison resolves
      // null — the full Redis + Postgres path still executed.
      const compared = await probes.compare(walletId);
      expect(compared._unsafeUnwrap()).toBeNull();
    } finally {
      await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
    }
  });
});
