import { DAILY_ALLOWANCE_NANO_USD } from './constants.js';
import { utcDayKey } from './period.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Principal } from '../../../lib/context/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BillingStores } from '../ports/index.js';

/**
 * The caller's identity, taken ONLY from the pipeline principal — never from
 * client input. Balance is a `session`-class route, so the authorizer
 * guarantees a full principal; anything else here is a composition defect.
 */
export function callerUserId(principal: Principal): string {
  if (principal.kind !== 'full') {
    throw new Error('billing: session route reached without a full principal');
  }
  return principal.claims.userId;
}

export interface BalanceView {
  readonly purchasedNanoUsd: bigint;
  readonly freeNanoUsd: bigint;
  readonly allowance: {
    readonly day: string;
    readonly limitNanoUsd: bigint;
    readonly spentNanoUsd: bigint;
    readonly remainingNanoUsd: bigint;
  };
}

/**
 * The balance read behind `GET /billing/balance`: wallet balances plus the
 * free-tier allowance for the current UTC day. Absent wallets read as zero
 * (pre-provisioning accounts); a fresh day needs no row and no mutation.
 */
export function readBalance(
  stores: BillingStores,
  db: Database,
  userId: string,
  now: Date
): ResultAsync<BalanceView, DomainError> {
  const day = utcDayKey(now);
  return stores.readWallets(db, userId).andThen((walletRows) =>
    stores.readAllowanceSpent(db, userId, day).map((spentNanoUsd) => {
      const purchased = walletRows.find((wallet) => wallet.type === 'purchased');
      const free = walletRows.find((wallet) => wallet.type === 'free');
      const remaining = DAILY_ALLOWANCE_NANO_USD - spentNanoUsd;
      return {
        purchasedNanoUsd: purchased?.balanceNanoUsd ?? 0n,
        freeNanoUsd: free?.balanceNanoUsd ?? 0n,
        allowance: {
          day,
          limitNanoUsd: DAILY_ALLOWANCE_NANO_USD,
          spentNanoUsd,
          remainingNanoUsd: remaining > 0n ? remaining : 0n,
        },
      };
    })
  );
}
