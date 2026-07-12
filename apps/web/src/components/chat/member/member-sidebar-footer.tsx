import * as React from 'react';
import { DollarSign } from 'lucide-react';
import { canManageLinks, nanoUsdToDollarString, TEST_IDS } from '@hushbox/shared';
import { useConversationBudgets } from '@/hooks/billing/use-conversation-budgets';
import { SidebarFooterBase } from '@/components/shared/sidebar-footer-base';

interface BudgetData {
  conversationSpentNanoUsd: string;
  ownerBalanceNanoUsd: string;
  members: {
    memberId: string;
    userId: string | null;
    /** '0' when no member_budgets row exists. */
    spentNanoUsd: string;
    /** Backend min(member cap remaining, conversation cap remaining, owner balance). */
    effectiveRemainingNanoUsd: string;
  }[];
}

/** @internal Exported for testing. */
export function computeBudgetSublabel(
  data: BudgetData,
  currentUserId: string,
  currentUserPrivilege: string
): string {
  // The owner is excluded from the member rows and funds turns from their raw
  // wallet, so the owner's line reads total conversation spend against that
  // balance. A non-owner reads their own spend against the backend-computed
  // effective remaining (the exact figure admission gates on) — never re-derived.
  if (currentUserPrivilege === 'owner') {
    const spent = `$${nanoUsdToDollarString(data.conversationSpentNanoUsd)}`;
    const budget = `$${nanoUsdToDollarString(data.ownerBalanceNanoUsd)}`;
    return `${spent} spent / ${budget} budget`;
  }

  const memberRow = data.members.find(
    (mb) => mb.userId === currentUserId || mb.memberId === currentUserId
  );
  const spent = `$${nanoUsdToDollarString(memberRow?.spentNanoUsd ?? '0')}`;
  const budget = `$${nanoUsdToDollarString(memberRow?.effectiveRemainingNanoUsd ?? '0')}`;
  return `${spent} spent / ${budget} budget`;
}

interface MemberSidebarFooterProps {
  conversationId: string;
  currentUserId: string;
  currentUserPrivilege: string;
  collapsed: boolean;
  onBudgetSettingsClick?: (() => void) | undefined;
}

export function MemberSidebarFooter({
  conversationId,
  currentUserId,
  currentUserPrivilege,
  collapsed,
  onBudgetSettingsClick,
}: Readonly<MemberSidebarFooterProps>): React.JSX.Element {
  const isAdmin = canManageLinks(currentUserPrivilege);
  const { data } = useConversationBudgets(conversationId) as { data: BudgetData | undefined };

  const sublabel =
    data === undefined
      ? undefined
      : computeBudgetSublabel(data, currentUserId, currentUserPrivilege);

  return (
    <SidebarFooterBase
      icon={<DollarSign className="size-4" />}
      label={isAdmin ? 'Budget Settings' : 'Your Budget'}
      sublabel={sublabel}
      onClick={onBudgetSettingsClick}
      collapsed={collapsed}
      testId={TEST_IDS.memberBudget}
    />
  );
}
