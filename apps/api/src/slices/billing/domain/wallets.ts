import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { WELCOME_CREDIT_NANO_USD } from './constants.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BillingStores, WelcomeEmailPort } from '../ports/index.js';

export interface ProvisionResult {
  readonly purchasedWalletId: string;
  readonly freeWalletId: string;
  readonly welcomeCreditGranted: boolean;
}

/**
 * Billing's published wallet provisioning: creates the one purchased + one
 * free wallet a user owns and grants the welcome credit as a zero-sum promo
 * leg pair on the purchased wallet. Idempotent by upsert — the wallet unique
 * (userId, type) arbitrates racing calls, and the grant rides only on the
 * arbitration winner (the ledger idempotency key is a second, independent
 * guard). Hard deletion means a re-registered email is granted again —
 * deliberate (full deletion outranks grant dedup). Today the only bound is
 * per-user: the `welcome:<userId>` ledger idempotency key blocks a double
 * grant to a live account; the global welcome/trial budget is enforced at
 * chat admission when that lands.
 */
export async function provisionWalletsWithinTx(
  stores: BillingStores,
  tx: SettlementTx,
  userId: string
): Promise<ProvisionResult> {
  const purchased = await stores.insertWalletIfAbsentWithinTx(tx, userId, 'purchased');
  const free = await stores.insertWalletIfAbsentWithinTx(tx, userId, 'free');
  if (!purchased.created) {
    return {
      purchasedWalletId: purchased.id,
      freeWalletId: free.id,
      welcomeCreditGranted: false,
    };
  }
  const wallet = await stores.lockWalletWithinTx(tx, purchased.id);
  const balanceAfter = wallet.balanceNanoUsd + WELCOME_CREDIT_NANO_USD;
  const transactionId = crypto.randomUUID();
  await stores.insertLedgerLegsWithinTx(tx, [
    {
      transactionId,
      kind: 'promo',
      amountNanoUsd: WELCOME_CREDIT_NANO_USD,
      balanceAfterNanoUsd: balanceAfter,
      walletId: purchased.id,
      idempotencyKey: `welcome:${userId}:user`,
    },
    {
      transactionId,
      kind: 'promo',
      amountNanoUsd: -WELCOME_CREDIT_NANO_USD,
      houseAccount: 'promo',
      idempotencyKey: `welcome:${userId}:house`,
    },
  ]);
  await stores.updateWalletBalanceWithinTx(tx, purchased.id, balanceAfter, wallet.ledgerSeq + 1n);
  return { purchasedWalletId: purchased.id, freeWalletId: free.id, welcomeCreditGranted: true };
}

export interface ProvisionUserBillingDeps {
  readonly db: Database;
  readonly stores: BillingStores;
  readonly welcomeEmail: WelcomeEmailPort;
}

export interface ProvisionUserBillingArgs {
  readonly userId: string;
  readonly email: string;
  readonly userName?: string;
}

/**
 * The welcome-credit provisioning orchestrator identity calls at signup:
 * wallets + credit in one settlement transaction, then the welcome email —
 * best-effort by port doctrine (a sender outage never blocks or fails
 * provisioning) and only when this call actually granted the credit, so a
 * replay never re-sends.
 */
export function provisionUserBilling(
  deps: ProvisionUserBillingDeps,
  args: ProvisionUserBillingArgs
): ResultAsync<ProvisionResult, DomainError> {
  return fromPromise(
    runSettlement(deps.db, (tx) => provisionWalletsWithinTx(deps.stores, tx, args.userId)),
    (cause) => unavailableError('wallet provisioning failed', cause)
  ).andThen((result) => {
    if (!result.welcomeCreditGranted) return okAsync(result);
    return deps.welcomeEmail
      .sendWelcomeEmail(
        args.userName === undefined
          ? { to: args.email }
          : { to: args.email, userName: args.userName }
      )
      .orElse(() => okAsync())
      .map(() => result);
  });
}
