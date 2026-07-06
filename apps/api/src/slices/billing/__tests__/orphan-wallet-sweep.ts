import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { ledgerEntries, wallets } from '@hushbox/db';
import type { Database } from '@hushbox/db';

/**
 * Billing integration suites seed userId-null wallet fixtures and track their
 * ids in memory for a per-file afterAll delete. When a vitest worker is killed
 * mid-file (retry + timeout under heavy parallel load, or the idle-killer),
 * those ids die with the process and the rows orphan forever — the shared test
 * DB then accretes conservation-violating fixtures that later runs never
 * reclaim.
 *
 * This start-of-run sweep is the crash-resilient counterpart to that afterAll:
 * it reclaims OLD leaked orphan wallets and their legs. The fixtures are
 * intentional (the conservation auditor needs unbalanced / leg-less wallets),
 * so the fix is reclamation, never balancing.
 *
 * Concurrency safety rests on an age gate, not a marker. A concurrently-running
 * test file's freshest fixtures are at most that file's wall-clock age old —
 * seconds to a couple of minutes. Deleting only orphans older than
 * ORPHAN_WALLET_MAX_AGE_MS (far beyond any single file's lifetime) makes it
 * impossible to match a concurrent file's rows: they are always younger than
 * the cutoff. A global truncate or a blanket userId-IS-NULL delete would
 * destroy those live rows and is therefore forbidden.
 */
const ORPHAN_WALLET_MAX_AGE_MS = 30 * 60 * 1000;

export async function sweepLeakedTestWallets(
  db: Database,
  maxAgeMs: number = ORPHAN_WALLET_MAX_AGE_MS
): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  // userId is null on every seeded wallet fixture; the age gate is what keeps a
  // concurrent file's fresh rows out of range.
  const oldOrphan = and(isNull(wallets.userId), lt(wallets.createdAt, cutoff));

  // A transaction with any leg on an old orphan wallet is a leaked fixture.
  // Delete the WHOLE transaction (every leg sharing the id): the deferred
  // zero-sum constraint trigger re-checks the group at commit and an emptied
  // group sums to zero, so unbalanced fixtures drop with no trigger disable and
  // no dangling house-account leg is left behind. Old orphans are self-contained
  // fixtures, so no live transaction shares an id with one.
  const doomed = await db
    .selectDistinct({ transactionId: ledgerEntries.transactionId })
    .from(ledgerEntries)
    .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
    .where(oldOrphan);
  const transactionIds = doomed.map((row) => row.transactionId);
  if (transactionIds.length > 0) {
    await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
  }

  // Now leg-free, the old orphan wallets delete without tripping the restrict FK.
  await db.delete(wallets).where(oldOrphan);
}
