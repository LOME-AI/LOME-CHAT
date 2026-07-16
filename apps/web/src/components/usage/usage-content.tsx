import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import {
  useUsageSummary,
  useSpendingOverTime,
  useCostByModel,
  useTokenUsageOverTime,
  useSpendingByConversation,
  useBalanceHistory,
  useUsageModels,
} from '@/hooks/billing/usage';
import { useDecryptedConversations } from '@/hooks/chat/chat';
import { PageBody } from '@/components/shared/page-body';
import { UsageFilters, type DateRangePreset } from './usage-filters';
import { UsageKpiCards } from './usage-kpi-cards';
import { SpendingOverTimeChart } from './spending-over-time-chart';
import { CostByModelChart } from './cost-by-model-chart';
import { TokenUsageChart } from './token-usage-chart';
import { SpendingByConversationChart } from './spending-by-conversation-chart';
import { BalanceHistoryChart } from './balance-history-chart';

const PRESET_DAYS: Record<Exclude<DateRangePreset, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

function getDateRange(preset: DateRangePreset): { startDate: string; endDate: string } {
  const end = new Date();
  /* v8 ignore next -- toISOString() always contains 'T', so split()[0] is never undefined; the ?? '' satisfies noUncheckedIndexedAccess */
  const endDate = end.toISOString().split('T')[0] ?? '';

  if (preset === 'all') {
    return { startDate: '2020-01-01', endDate };
  }

  const days = PRESET_DAYS[preset];
  const start = new Date();
  start.setDate(start.getDate() - days);
  /* v8 ignore next -- toISOString() always contains 'T', so split()[0] is never undefined; the ?? '' satisfies noUncheckedIndexedAccess */
  return { startDate: start.toISOString().split('T')[0] ?? '', endDate };
}

export function UsageContent(): React.JSX.Element {
  const [range, setRange] = React.useState<DateRangePreset>('30d');
  const [model, setModel] = React.useState<string | undefined>();

  const dateRange = React.useMemo(() => getDateRange(range), [range]);
  const timeSeriesParams = React.useMemo(
    () => ({ ...dateRange, ...(model !== undefined && { model }) }),
    [dateRange, model]
  );

  const { data: modelsData } = useUsageModels();
  const { data: conversations } = useDecryptedConversations();
  const summary = useUsageSummary(dateRange);
  const spendingOverTime = useSpendingOverTime(timeSeriesParams);
  const costByModel = useCostByModel(dateRange);
  const tokenUsage = useTokenUsageOverTime(timeSeriesParams);
  const spendingByConversation = useSpendingByConversation(dateRange);
  const balanceHistory = useBalanceHistory(dateRange);

  return (
    <PageBody testId={TEST_IDS.usageContent} className="space-y-6">
      <UsageFilters
        range={range}
        onRangeChange={setRange}
        model={model}
        onModelChange={setModel}
        availableModels={modelsData?.models ?? []}
      />

      <UsageKpiCards data={summary.data} isLoading={summary.isLoading} />

      <SpendingOverTimeChart data={spendingOverTime.data} isLoading={spendingOverTime.isLoading} />

      <div className="grid gap-6 md:grid-cols-2">
        <CostByModelChart data={costByModel.data} isLoading={costByModel.isLoading} />
        <TokenUsageChart data={tokenUsage.data} isLoading={tokenUsage.isLoading} />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <SpendingByConversationChart
          data={spendingByConversation.data}
          isLoading={spendingByConversation.isLoading}
          {...(conversations && {
            conversationTitles: conversations.map((c) => ({ id: c.id, title: c.title })),
          })}
        />
        <BalanceHistoryChart data={balanceHistory.data} isLoading={balanceHistory.isLoading} />
      </div>
    </PageBody>
  );
}
