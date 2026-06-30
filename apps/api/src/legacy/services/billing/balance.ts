import { and, eq, inArray, lt, max } from 'drizzle-orm';
import { wallets, ledgerEntries, type Database } from '@hushbox/db';
import {
  getUserTier,
  FREE_ALLOWANCE_DOLLARS,
  needsResetBeforeMidnight,
  type UserTierInfo,
} from '@hushbox/shared';

export interface BalanceCheckResult {
  hasBalance: boolean;
  currentBalance: string;
  freeAllowanceCents: number;
}

interface WalletRow {
  type: string;
  balance: string;
  id: string;
}

/**
 * Compute purchased balance sum and free tier balance from wallet rows.
 * All wallet balances are stored as dollar strings in `numeric(20,8)` columns.
 */
function computeBalances(walletRows: WalletRow[]): {
  purchasedBalance: number;
  purchasedBalanceString: string;
  freeAllowanceDollars: number;
  freeTierWalletId: string | null;
} {
  let purchasedBalance = 0;
  let freeAllowanceDollars = 0;
  let freeTierWalletId: string | null = null;

  for (const wallet of walletRows) {
    const balance = Number.parseFloat(wallet.balance);
    if (wallet.type === 'purchased') {
      purchasedBalance += balance;
    } else if (wallet.type === 'free_tier') {
      freeAllowanceDollars = balance;
      freeTierWalletId = wallet.id;
    }
  }

  const purchasedBalanceString = purchasedBalance.toFixed(8);

  return { purchasedBalance, purchasedBalanceString, freeAllowanceDollars, freeTierWalletId };
}

/**
 * Check if user has positive balance or free allowance.
 * Returns balance for display even if insufficient.
 *
 * With wallet-based system:
 * - SUM(purchased wallets) > 0: Can use any model
 * - free_tier wallet balance > 0: Can use basic models
 * - Both zero: No access
 *
 * Also triggers lazy renewal of free tier if needed.
 */
export async function checkUserBalance(db: Database, userId: string): Promise<BalanceCheckResult> {
  const walletRows = await db
    .select({
      type: wallets.type,
      balance: wallets.balance,
      id: wallets.id,
    })
    .from(wallets)
    .where(eq(wallets.userId, userId));

  const {
    purchasedBalance,
    purchasedBalanceString,
    freeAllowanceDollars: rawFreeAllowanceDollars,
    freeTierWalletId,
  } = computeBalances(walletRows as WalletRow[]);

  // Lazy renewal of free tier (returns dollars)
  const freeAllowanceDollars = freeTierWalletId
    ? await maybeRenewFreeAllowance(db, freeTierWalletId, rawFreeAllowanceDollars)
    : rawFreeAllowanceDollars;

  // Convert dollars to cents for the billing system
  const freeAllowanceCents = freeAllowanceDollars * 100;

  const hasBalance = purchasedBalance > 0 || freeAllowanceCents > 0;

  return { hasBalance, currentBalance: purchasedBalanceString, freeAllowanceCents };
}

/**
 * Get user tier info with lazy renewal of free allowance.
 * Returns full tier information for authorization decisions.
 *
 * Queries wallets table instead of users table.
 * Free tier renewal is based on ledger entries, not a reset timestamp column.
 *
 * @param db - Database connection
 * @param userId - User ID, or null for trial users
 * @returns Tier info with balances
 */
export async function getUserTierInfo(db: Database, userId: string | null): Promise<UserTierInfo> {
  if (userId === null) {
    return getUserTier(null);
  }

  const walletRows = await db
    .select({
      type: wallets.type,
      balance: wallets.balance,
      id: wallets.id,
    })
    .from(wallets)
    .where(eq(wallets.userId, userId));

  if (walletRows.length === 0) {
    return getUserTier({ balanceCents: 0, freeAllowanceCents: 0 });
  }

  const {
    purchasedBalance,
    freeAllowanceDollars: initialFreeAllowanceDollars,
    freeTierWalletId,
  } = computeBalances(walletRows as WalletRow[]);

  // Lazy renewal of free tier allowance (returns dollars)
  const freeAllowanceDollars = freeTierWalletId
    ? await maybeRenewFreeAllowance(db, freeTierWalletId, initialFreeAllowanceDollars)
    : initialFreeAllowanceDollars;

  // Convert dollars to fractional cents — no Math.round, preserves full precision
  const balanceCents = purchasedBalance * 100;
  const freeAllowanceCents = freeAllowanceDollars * 100;

  return getUserTier({
    balanceCents,
    freeAllowanceCents,
  });
}

/**
 * Check if free tier wallet needs renewal and perform atomic renewal if needed.
 *
 * Idempotency: The UPDATE uses WHERE balance < FREE_ALLOWANCE_DOLLARS.
 * If two requests race, only the first succeeds (second finds balance >= and updates 0 rows).
 * Ledger entry is only inserted inside the same transaction when the update succeeds.
 *
 * @param currentBalanceDollars - Current free tier wallet balance in dollars
 * @returns The free allowance in dollars (either renewed or unchanged)
 */
async function maybeRenewFreeAllowance(
  db: Database,
  freeTierWalletId: string,
  currentBalanceDollars: number
): Promise<number> {
  // Check last renewal timestamp from ledger entries
  const [renewalResult] = await db
    .select({ maxCreatedAt: max(ledgerEntries.createdAt) })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.walletId, freeTierWalletId),
        inArray(ledgerEntries.entryType, ['renewal', 'welcome_credit'])
      )
    );

  const lastRenewalAt = renewalResult?.maxCreatedAt ?? null;

  // If renewal is not needed, return current balance in dollars
  if (!needsResetBeforeMidnight(lastRenewalAt)) {
    return currentBalanceDollars;
  }

  // Atomic transaction: UPDATE wallet + INSERT ledger entry together.
  // The WHERE clause IS the idempotency guard: if two requests race,
  // only the first succeeds; the second finds balance >= FREE_ALLOWANCE_DOLLARS and updates 0 rows.
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(wallets)
      .set({ balance: FREE_ALLOWANCE_DOLLARS })
      .where(
        and(
          eq(wallets.id, freeTierWalletId),
          eq(wallets.type, 'free_tier'),
          lt(wallets.balance, FREE_ALLOWANCE_DOLLARS)
        )
      )
      .returning({ id: wallets.id, balance: wallets.balance });

    // If update returned 0 rows, balance was already >= FREE_ALLOWANCE_DOLLARS (race or already full)
    if (updated) {
      // Amount is the delta: what was actually added to the wallet
      const delta = (Number.parseFloat(FREE_ALLOWANCE_DOLLARS) - currentBalanceDollars).toFixed(8);

      await tx
        .insert(ledgerEntries)
        .values({
          walletId: freeTierWalletId,
          amount: delta,
          balanceAfter: FREE_ALLOWANCE_DOLLARS,
          entryType: 'renewal',
          sourceWalletId: freeTierWalletId,
        })
        .returning({ id: ledgerEntries.id });
    }
  });

  return Number.parseFloat(FREE_ALLOWANCE_DOLLARS);
}
