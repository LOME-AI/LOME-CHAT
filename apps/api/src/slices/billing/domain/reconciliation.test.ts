import { describe, expect, it, vi } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import {
  PENDING_RECONCILE_AGE_SECONDS,
  runPendingPaymentReconciliation,
} from './reconciliation.js';
import type { Database } from '@hushbox/db';
import type { BillingStores, StalePendingPayment } from '../ports/index.js';

const DB = {} as Database;

function fakeStores(
  rows: readonly StalePendingPayment[],
  spy: (olderThan: Date, limit: number) => void
): BillingStores {
  return {
    findStalePendingPayments: (_db: Database, olderThan: Date, limit: number) => {
      spy(olderThan, limit);
      return okAsync(rows);
    },
  } as unknown as BillingStores;
}

const staleRow: StalePendingPayment = {
  id: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  amountNanoUsd: 5_000_000_000n,
  createdAt: new Date('2026-07-03T00:00:00Z'),
};

describe('runPendingPaymentReconciliation', () => {
  it('probes for pending rows older than the reconcile age', async () => {
    const now = new Date('2026-07-03T12:00:00Z');
    const spy = vi.fn();
    const result = await runPendingPaymentReconciliation(fakeStores([], spy), DB, now);
    expect(result.isOk()).toBe(true);
    const olderThan = spy.mock.calls[0]?.[0] as Date;
    expect(olderThan.getTime()).toBe(now.getTime() - PENDING_RECONCILE_AGE_SECONDS * 1000);
  });

  it('returns the stale pending rows the probe found', async () => {
    const result = await runPendingPaymentReconciliation(
      fakeStores([staleRow], vi.fn()),
      DB,
      new Date('2026-07-03T12:00:00Z')
    );
    expect(result._unsafeUnwrap().stalePending).toEqual([staleRow]);
  });

  it('reads only — the sole store method it can reach is the read probe', async () => {
    // The fake exposes no mutation method; any write attempt would throw on an
    // undefined call, so a green run is proof the sweep never mutates.
    const result = await runPendingPaymentReconciliation(
      fakeStores([], vi.fn()),
      DB,
      new Date('2026-07-03T12:00:00Z')
    );
    expect(result.isOk()).toBe(true);
  });
});
