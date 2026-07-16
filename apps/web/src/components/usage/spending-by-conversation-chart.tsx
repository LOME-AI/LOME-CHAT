import * as React from 'react';
// eslint-disable-next-line sonarjs/deprecation -- recharts v3 still uses Cell for Pie coloring
import { PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { ChartTooltipContent, ChartLegendContent } from '@hushbox/ui';
import { TEST_IDS, type SpendingByConversationResponse } from '@hushbox/shared';
import { CHART_COLORS, UsageChartCard } from './chart-utilities';
import type { ChartConfig } from '@hushbox/ui';

interface ConversationTitle {
  id: string;
  title: string;
}

interface SpendingByConversationChartProps {
  data: SpendingByConversationResponse | undefined;
  isLoading: boolean;
  conversationTitles?: ConversationTitle[];
}

function resolveConversationLabel(title: string | undefined, conversationId: string): string {
  if (!title || title === 'Decrypting...' || title === 'Encrypted conversation') {
    return `conv-${conversationId.slice(-6)}`;
  }
  return title.length > 24 ? `${title.slice(0, 24)}...` : title;
}

export function SpendingByConversationChart({
  data,
  isLoading,
  conversationTitles,
}: Readonly<SpendingByConversationChartProps>): React.JSX.Element {
  const { chartData, chartConfig } = React.useMemo(() => {
    if (!data?.data.length) return { chartData: [], chartConfig: {} as ChartConfig };

    const titleMap = new Map<string, string>();
    if (conversationTitles) {
      for (const c of conversationTitles) {
        titleMap.set(c.id, c.title);
      }
    }

    const config: ChartConfig = {};
    const rows = data.data.map((row, index) => {
      const title = titleMap.get(row.conversationId);
      const label = resolveConversationLabel(title, row.conversationId);
      config[label] = {
        label,
        /* v8 ignore start -- index % CHART_COLORS.length is always in bounds; the ?? only satisfies noUncheckedIndexedAccess and never fires */
        color: CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)',
        /* v8 ignore stop */
      };
      return {
        name: label,
        value: Number.parseFloat(row.totalSpent),
        conversationId: row.conversationId,
      };
    });

    return { chartData: rows, chartConfig: config };
  }, [data, conversationTitles]);

  const dataTable = (
    <table>
      <caption>Spending by conversation, in US dollars</caption>
      <thead>
        <tr>
          <th scope="col">Conversation</th>
          <th scope="col">Spent</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.conversationId}>
            <th scope="row">{row.name}</th>
            <td>{`$${row.value.toFixed(4)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <UsageChartCard
      title="Top Conversations"
      testId={TEST_IDS.spendingByConversationChart}
      isLoading={isLoading}
      isEmpty={chartData.length === 0}
      emptyMessage="No conversation data"
      chartConfig={chartConfig}
      ariaLabel={`Spending split across ${String(chartData.length)} top conversation${chartData.length === 1 ? '' : 's'}.`}
      dataTable={dataTable}
    >
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={100}
          paddingAngle={2}
          dataKey="value"
        >
          {chartData.map((_, index) => (
            /* v8 ignore start -- index % CHART_COLORS.length is always in bounds; the ?? only satisfies noUncheckedIndexedAccess and never fires */
            // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- recharts v3 Cell API
            <Cell
              key={index}
              fill={CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)'}
            />
            /* v8 ignore stop */
          ))}
        </Pie>
        <Tooltip
          content={
            <ChartTooltipContent
              nameKey="name"
              valueFormatter={(v) => `$${Number(v).toFixed(4)}`}
            />
          }
        />
        <Legend content={<ChartLegendContent />} />
      </PieChart>
    </UsageChartCard>
  );
}
