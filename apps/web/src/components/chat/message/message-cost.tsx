import * as React from 'react';
import { formatNanoUsdCost, NanoUSD, TEST_IDS } from '@hushbox/shared';

interface MessageCostProps {
  /**
   * Billed cost as a canonical NanoUSD wire string (e.g. "1360000" = $0.00136).
   * In the real app this is always canonical (from `sumCost`), but the upstream
   * mount gate only checks truthiness — so a non-canonical value can reach here
   * and is degraded to no-badge below rather than crashing the message list.
   */
  cost: string;
}

/**
 * Displays the cost of an AI message in the bottom-left corner.
 *
 * `formatNanoUsdCost` throws on a non-canonical NanoUSD string. The display
 * boundary guards with a safe parse so a malformed cost renders nothing instead
 * of throwing during render and taking down the whole message-list subtree.
 */
export function MessageCost({ cost }: Readonly<MessageCostProps>): React.JSX.Element | null {
  if (!NanoUSD.safeParse(cost).success) {
    return null;
  }

  const formattedCost = formatNanoUsdCost(cost);

  return (
    <span
      className="text-muted-foreground cursor-default text-xs opacity-60 transition-opacity hover:opacity-100"
      data-testid={TEST_IDS.messageCost}
    >
      {formattedCost}
    </span>
  );
}
