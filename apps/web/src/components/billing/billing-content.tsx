import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  FeeBreakdown,
  CostPieChart,
} from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useStableBalance } from '@/hooks/billing/use-stable-balance';
import { useTransactions } from '@/hooks/billing/billing';
import { formatBalance } from '@/lib/format';
import { PaymentModal } from '@/components/billing/payment-modal';
import { PageBody } from '@/components/shared/page-body';
import { ManageOnlineButton } from '@/components/billing/manage-online-button';
import { isPaymentDisabled } from '@/capacitor/platform';
import type { BalanceTransactionResponse } from '@hushbox/shared';

const TRANSACTIONS_PER_PAGE = 5;

const SIMPLE_TRANSACTION_LABELS: Record<string, string> = {
  clawback: 'Balance adjustment',
  promo: 'Promotional credit',
};

function getTransactionDisplay(tx: BalanceTransactionResponse): string {
  if (tx.type === 'charge') {
    const totalChars = (tx.inputCharacters ?? 0) + (tx.outputCharacters ?? 0);
    return `AI response: ${tx.model ?? 'unknown'} (${String(totalChars)} chars)`;
  }
  if (tx.type === 'deposit' || tx.type === 'refund') {
    const label = tx.type === 'deposit' ? 'Deposit' : 'Refund';
    return `${label} of $${Number.parseFloat(tx.amount).toFixed(2)}`;
  }
  return SIMPLE_TRANSACTION_LABELS[tx.type] ?? tx.type;
}

function TransactionContent({
  isLoading,
  deposits,
  page,
}: {
  readonly isLoading: boolean;
  readonly deposits: readonly BalanceTransactionResponse[];
  readonly page: number;
}): React.JSX.Element {
  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        {Array.from({ length: TRANSACTIONS_PER_PAGE }).map((_, index) => (
          <div
            key={index}
            data-testid={TEST_IDS.transactionSkeletonRow}
            className="flex h-16 items-center justify-between"
          >
            <div className="space-y-2">
              <div
                data-testid={TEST_IDS.skeletonBlock}
                className="bg-muted h-5 w-40 animate-pulse rounded"
              />
              <div
                data-testid={TEST_IDS.skeletonBlock}
                className="bg-muted h-4 w-32 animate-pulse rounded"
              />
            </div>
            <div className="space-y-2 text-right">
              <div
                data-testid={TEST_IDS.skeletonBlock}
                className="bg-muted ml-auto h-5 w-16 animate-pulse rounded"
              />
              <div
                data-testid={TEST_IDS.skeletonBlock}
                className="bg-muted ml-auto h-4 w-28 animate-pulse rounded"
              />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (deposits.length === 0 && page === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">No purchases yet</p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      {deposits.map((tx) => (
        <div
          key={tx.id}
          data-testid={TEST_IDS.transactionRow}
          className="flex h-16 items-center justify-between border-b last:border-0"
        >
          <div>
            <p className="font-medium">{getTransactionDisplay(tx)}</p>
            <p className="text-muted-foreground text-sm">
              {new Date(tx.createdAt).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
          <div className="text-right">
            <p className="font-medium text-green-600">
              +${Number.parseFloat(tx.amount).toFixed(2)}
            </p>
            <p className="text-muted-foreground text-sm">
              Balance: {formatBalance(tx.balanceAfter)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function BalanceCard({
  displayBalance,
  isStable,
  paymentDisabled,
  onAddCredits,
}: {
  readonly displayBalance: string;
  readonly isStable: boolean;
  readonly paymentDisabled: boolean;
  readonly onAddCredits: () => void;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-brand-red">Current Balance</CardTitle>
        <CardDescription>Your available credits for AI model usage</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            {isStable ? (
              <p data-testid={TEST_IDS.balanceDisplay} className="text-4xl font-bold">
                {formatBalance(displayBalance)}
              </p>
            ) : (
              <div className="bg-muted h-10 w-48 animate-pulse rounded" />
            )}
          </div>
          {paymentDisabled ? (
            <ManageOnlineButton />
          ) : (
            <Button onClick={onAddCredits} size="lg">
              Add Credits
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function BillingContent({ billingOnly }: { billingOnly?: boolean } = {}): React.JSX.Element {
  const paymentDisabled = isPaymentDisabled();
  const [showPaymentModal, setShowPaymentModal] = React.useState(false);
  const [page, setPage] = React.useState(0);
  const {
    displayBalance,
    isStable: isBalanceStable,
    refetch: refetchBalance,
  } = useStableBalance(billingOnly ? { enabled: true } : undefined);
  const { data: transactionsData, isLoading: transactionsLoading } = useTransactions({
    limit: TRANSACTIONS_PER_PAGE,
    offset: page * TRANSACTIONS_PER_PAGE,
    type: 'deposit',
  });

  const handlePaymentSuccess = (): void => {
    void refetchBalance();
  };

  const deposits = transactionsData?.transactions ?? [];
  const hasNextPage = Boolean(transactionsData?.nextCursor);
  const hasPreviousPage = page > 0;

  return (
    <>
      <PageBody testId={TEST_IDS.billingContent} className="space-y-6">
        <BalanceCard
          displayBalance={displayBalance}
          isStable={isBalanceStable}
          paymentDisabled={paymentDisabled}
          onAddCredits={() => {
            setShowPaymentModal(true);
          }}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-brand-red">Purchase History</CardTitle>
            <CardDescription>Your credit purchases</CardDescription>
          </CardHeader>
          <CardContent>
            <div data-testid={TEST_IDS.transactionListContainer} className="h-[320px]">
              <TransactionContent isLoading={transactionsLoading} deposits={deposits} page={page} />
            </div>
            {(deposits.length > 0 || page > 0) && (
              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-28"
                  onClick={() => {
                    setPage((p) => Math.max(0, p - 1));
                  }}
                  disabled={!hasPreviousPage}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Previous
                </Button>
                <span className="text-muted-foreground text-sm">Page {page + 1}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-28"
                  onClick={() => {
                    setPage((p) => p + 1);
                  }}
                  disabled={!hasNextPage}
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-3">
            <div className="grid gap-8 md:grid-cols-2">
              <FeeBreakdown depositAmount={100} />
              <CostPieChart depositAmount={100} />
            </div>
            <p className="text-muted-foreground mt-4 text-xs italic">
              Actual costs vary based on your model selection and usage patterns.
            </p>
          </CardContent>
        </Card>
      </PageBody>

      {!paymentDisabled && (
        <PaymentModal
          open={showPaymentModal}
          onOpenChange={setShowPaymentModal}
          onSuccess={handlePaymentSuccess}
        />
      )}
    </>
  );
}
