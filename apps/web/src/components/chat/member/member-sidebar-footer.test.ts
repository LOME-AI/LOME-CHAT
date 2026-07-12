import { describe, it, expect } from 'vitest';
import { computeBudgetSublabel } from '@/components/chat/member/member-sidebar-footer';

interface Member {
  memberId: string;
  userId: string | null;
  spentNanoUsd: string;
  effectiveRemainingNanoUsd: string;
}

function makeData(
  members: Member[],
  ownerBalanceNanoUsd = '200000000000'
): {
  conversationSpentNanoUsd: string;
  ownerBalanceNanoUsd: string;
  members: Member[];
} {
  return {
    conversationSpentNanoUsd: '30000000000',
    ownerBalanceNanoUsd,
    members,
  };
}

describe('computeBudgetSublabel', () => {
  it('uses total conversation spend and owner balance for owners', () => {
    const data = makeData(
      [
        {
          memberId: 'm1',
          userId: 'u1',
          spentNanoUsd: '10000000000',
          effectiveRemainingNanoUsd: '0',
        },
      ],
      '200000000000'
    );

    // owner: $30.00 total spent / $200.00 owner balance
    expect(computeBudgetSublabel(data, 'u1', 'owner')).toBe('$30.00 spent / $200.00 budget');
  });

  it('uses backend effective remaining for non-owner members', () => {
    const data = makeData([
      {
        memberId: 'm3',
        userId: 'u3',
        spentNanoUsd: '15000000000',
        effectiveRemainingNanoUsd: '35000000000',
      },
    ]);

    // $15.00 spent / $35.00 effective remaining
    expect(computeBudgetSublabel(data, 'u3', 'write')).toBe('$15.00 spent / $35.00 budget');
  });

  it('matches the member row by memberId when the viewer is a link guest', () => {
    const data = makeData([
      {
        memberId: 'guest-mem',
        userId: null,
        spentNanoUsd: '5000000000',
        effectiveRemainingNanoUsd: '35000000000',
      },
    ]);

    expect(computeBudgetSublabel(data, 'guest-mem', 'write')).toBe('$5.00 spent / $35.00 budget');
  });

  it('treats a missing member row as zero spent and zero remaining', () => {
    const data = makeData([
      {
        memberId: 'other',
        userId: 'other-user',
        spentNanoUsd: '10000000000',
        effectiveRemainingNanoUsd: '40000000000',
      },
    ]);

    expect(computeBudgetSublabel(data, 'no-match', 'write')).toBe('$0.00 spent / $0.00 budget');
  });
});
