import * as React from 'react';
import { Badge, Button } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { CopyableId } from '@/components/util/copyable-id';
import { NanoUsdAmount } from '@/components/util/nano-usd-amount';
import type { Customer360View } from '@hushbox/shared';

interface C360HeaderProps {
  readonly user: Customer360View['user'];
  readonly money: Customer360View['panels']['money'];
}

/**
 * The 360 header: identity at a glance (lock state with its reason, balance,
 * key facts) and the promoted remediation ops, prefilled with the loaded
 * user's id. Credit wallet prefills the purchased wallet's id from the money
 * panel's wallet identity rows (no prefill when that panel failed).
 */
export function C360Header({ user, money }: C360HeaderProps): React.JSX.Element {
  const runOp = useRunOp();
  const locked = user.lockedAt !== null;
  const purchasedWalletId = money.ok
    ? money.data.wallets.find((wallet) => wallet.type === 'purchased')?.id
    : undefined;
  return (
    <header data-testid={TEST_IDS.adminC360Header} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">{user.email}</h2>
        {locked ? (
          <Badge variant="destructive">
            Locked since {user.lockedAt?.slice(0, 10)}
            {user.lockReason === null ? '' : `: ${user.lockReason}`}
          </Badge>
        ) : (
          <Badge variant="secondary">Active</Badge>
        )}
        {user.emailVerified ? null : <Badge variant="outline">Email unverified</Badge>}
        {money.ok ? (
          <Badge variant="outline">
            Balance <NanoUsdAmount wire={money.data.balance.purchasedNanoUsd} />
          </Badge>
        ) : null}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <CopyableId value={user.id} label="user id" />
        <span>{user.username}</span>
        <span>Created {user.createdAt.slice(0, 10)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            runOp({
              opName: 'wallet.credit',
              ...(purchasedWalletId === undefined
                ? {}
                : { initialValues: { walletId: purchasedWalletId } }),
            });
          }}
        >
          Credit wallet
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            runOp({
              opName: locked ? 'user.unlock' : 'user.lock',
              initialValues: { userId: user.id },
            });
          }}
        >
          {locked ? 'Unlock account' : 'Lock account'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            runOp({ opName: 'sessions.revokeAll', initialValues: { userId: user.id } });
          }}
        >
          Revoke all sessions
        </Button>
      </div>
    </header>
  );
}
