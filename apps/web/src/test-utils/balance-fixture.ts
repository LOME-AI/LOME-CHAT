import type { GetBalanceResponse } from '@hushbox/shared';

/**
 * Build a `GET /billing/balance` response body for tests. Money is NanoUSD
 * wire strings ($1 = 1_000_000_000 nano). `purchased` is the negative-capable
 * paid wallet the tier and negative-balance gate key on; `remainingNanoUsd` is
 * the free-tier daily allowance remaining (what the derived tier hooks read as
 * `freeAllowanceCents`).
 */
export function makeBalance(purchasedNanoUsd: string, remainingNanoUsd = '0'): GetBalanceResponse {
  return {
    purchased: { balanceNanoUsd: purchasedNanoUsd },
    free: { balanceNanoUsd: '0' },
    allowance: {
      day: '2026-07-11',
      limitNanoUsd: '5000000000',
      spentNanoUsd: '0',
      remainingNanoUsd,
    },
  };
}
