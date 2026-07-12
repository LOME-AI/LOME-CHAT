import { nanoUsdToDollarString } from '@hushbox/shared';
import { useStability } from '@/providers/stability-provider';
import { useBalance } from '@/hooks/billing/billing';

/**
 * Enhanced balance hook with stability tracking.
 * Returns isStable: true for trial users, or when balance loads for auth users.
 */
export function useStableBalance(options?: { enabled?: boolean }): ReturnType<typeof useBalance> & {
  /** True when balance has stabilized (loaded or trial) */
  isStable: boolean;
  /**
   * Safe display value that won't flash during loading: the spendable
   * purchased balance as a bare dollar string, derived from the NanoUSD wire
   * value via bigint math (no float).
   */
  displayBalance: string;
} {
  const query = useBalance(options);
  const { isBalanceStable } = useStability();

  return {
    ...query,
    isStable: options?.enabled ? Boolean(query.data) : isBalanceStable,
    displayBalance: query.data ? nanoUsdToDollarString(query.data.purchased.balanceNanoUsd) : '0',
  };
}
