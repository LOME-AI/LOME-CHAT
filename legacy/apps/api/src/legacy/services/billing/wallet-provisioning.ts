import { wallets, ledgerEntries, type DatabaseClient } from '@hushbox/db';
import { WELCOME_CREDIT_BALANCE, FREE_ALLOWANCE_DOLLARS } from '@hushbox/shared';

/**
 * Single source of truth for wallet creation in production.
 *
 * Creates both a purchased wallet (with welcome credit) and a free_tier wallet
 * for the given user. Idempotent via ON CONFLICT DO NOTHING — safe to call
 * multiple times or inside retry loops.
 *
 * Only creates welcome_credit ledger entries for wallets that were newly created
 * (RETURNING gives a row). If the wallet already existed, the insert is a no-op
 * and no duplicate ledger entry is created.
 *
 * @param db - Database or transaction client
 * @param userId - The user to provision wallets for
 */
export async function ensureWalletsExist(db: DatabaseClient, userId: string): Promise<void> {
  // Create purchased wallet with welcome credit
  const [purchasedWallet] = await db
    .insert(wallets)
    .values({
      userId,
      type: 'purchased',
      balance: WELCOME_CREDIT_BALANCE,
      priority: 0,
    })
    .onConflictDoNothing({ target: [wallets.userId, wallets.type] })
    .returning({ id: wallets.id });

  if (purchasedWallet) {
    await db
      .insert(ledgerEntries)
      .values({
        walletId: purchasedWallet.id,
        amount: WELCOME_CREDIT_BALANCE,
        balanceAfter: WELCOME_CREDIT_BALANCE,
        entryType: 'welcome_credit',
        sourceWalletId: purchasedWallet.id,
      })
      .returning({ id: ledgerEntries.id });
  }

  // Create free tier wallet with daily allowance
  const [freeTierWallet] = await db
    .insert(wallets)
    .values({
      userId,
      type: 'free_tier',
      balance: FREE_ALLOWANCE_DOLLARS,
      priority: 1,
    })
    .onConflictDoNothing({ target: [wallets.userId, wallets.type] })
    .returning({ id: wallets.id });

  if (freeTierWallet) {
    await db
      .insert(ledgerEntries)
      .values({
        walletId: freeTierWallet.id,
        amount: FREE_ALLOWANCE_DOLLARS,
        balanceAfter: FREE_ALLOWANCE_DOLLARS,
        entryType: 'welcome_credit',
        sourceWalletId: freeTierWallet.id,
      })
      .returning({ id: ledgerEntries.id });
  }
}
