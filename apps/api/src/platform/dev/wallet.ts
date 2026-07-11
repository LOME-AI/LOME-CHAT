import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { runSettlement } from '../../lib/idempotency/index.js';
import {
  createBillingStores,
  refreshWalletSnapshot,
  usdToNanoUsd,
} from '../../slices/billing/index.js';
import { nanoUsdToDecimalString } from './reads.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';

export interface SetWalletBalanceParams {
  readonly email: string;
  /** Legacy wire name `free_tier` maps onto the new `free` wallet type. */
  readonly walletType: 'purchased' | 'free_tier';
  /** Decimal USD string (legacy wire shape), e.g. "5.00". */
  readonly balance: string;
}

export interface SetWalletBalanceResult {
  readonly newBalance: string;
}

/** Raised for the legacy 404 cases (unknown user / missing wallet). */
export class DevWalletNotFoundError extends Error {}

/**
 * Set a user's wallet balance to an exact value. Dev/test only.
 *
 * Semantic adaptation from legacy (a raw balance UPDATE + single ledger
 * row): the new ledger is double-entry with a write-time zero-sum
 * constraint, so the set is posted as a `promo` adjustment pair (wallet leg
 * balancing against the promo house account) inside one settlement
 * transaction, and the Redis balance snapshot is refreshed afterwards so
 * admission sees the new balance immediately.
 */
export async function setWalletBalance(
  db: Database,
  redis: Redis,
  params: SetWalletBalanceParams
): Promise<SetWalletBalanceResult> {
  const stores = createBillingStores();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, params.email.toLowerCase()));
  if (user === undefined) {
    throw new DevWalletNotFoundError(`User not found: ${params.email}`);
  }

  const walletType = params.walletType === 'free_tier' ? 'free' : 'purchased';
  // A wallet-read failure reads as "no wallet" — for dev tooling the legacy
  // 404 is the right answer either way.
  const walletsRead = await stores.readWallets(db, user.id);
  const wallet = walletsRead.unwrapOr([]).find((row) => row.type === walletType);
  if (wallet === undefined) {
    throw new DevWalletNotFoundError(`Wallet not found: ${params.walletType} for ${params.email}`);
  }

  const targetNanoUsd = usdToNanoUsd(Number(params.balance));

  await runSettlement(db, async (tx) => {
    const locked = await stores.lockWalletWithinTx(tx, wallet.id);
    const delta = targetNanoUsd - locked.balanceNanoUsd;
    if (delta === 0n) return;
    const transactionId = crypto.randomUUID();
    await stores.insertLedgerLegsWithinTx(tx, [
      {
        transactionId,
        kind: 'promo',
        amountNanoUsd: delta,
        idempotencyKey: `dev:set-balance:${transactionId}:wallet`,
        walletId: wallet.id,
        balanceAfterNanoUsd: targetNanoUsd,
      },
      {
        transactionId,
        kind: 'promo',
        amountNanoUsd: -delta,
        idempotencyKey: `dev:set-balance:${transactionId}:house`,
        houseAccount: 'promo',
      },
    ]);
    await stores.updateWalletBalanceWithinTx(tx, wallet.id, targetNanoUsd, locked.ledgerSeq + 1n);
  });

  // Best-effort snapshot refresh: admission CASes on ledgerSeq, so a stale
  // snapshot self-heals on the next write-through; a Redis hiccup here must
  // not fail the balance set the DB already committed.
  await refreshWalletSnapshot({ db, redis, stores }, wallet.id).unwrapOr(null);

  return { newBalance: nanoUsdToDecimalString(targetNanoUsd) };
}
