import * as React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { ChartTooltipContent, ChartLegendContent } from '@hushbox/ui';
import { TEST_IDS, type SpendingOverTimeResponse } from '@hushbox/shared';
import {
  CHART_COLORS,
  UsageChartCard,
  DEFAULT_CHART_MARGIN,
  DEFAULT_AXIS_PROPS,
  formatDollarTick,
  formatDollarTooltip,
  formatPeriodLabel,
} from './chart-utilities';
import type { ChartConfig } from '@hushbox/ui';

interface SpendingOverTimeChartProps {
  data: SpendingOverTimeResponse | undefined;
  isLoading: boolean;
}

export function SpendingOverTimeChart({
  data,
  isLoading,
}: Readonly<SpendingOverTimeChartProps>): React.JSX.Element {
  const { chartData, models, chartConfig } = React.useMemo(() => {
    if (!data?.data.length)
      return { chartData: [], models: [] as string[], chartConfig: {} as ChartConfig };

    const modelsSet = new Set<string>();
    const periodMap = new Map<string, Record<string, number>>();

    for (const point of data.data) {
      modelsSet.add(point.model);
      const existing = periodMap.get(point.period) ?? {};
      existing[point.model] = Number.parseFloat(point.totalCost);
      periodMap.set(point.period, existing);
    }

    const modelsList = [...modelsSet];
    const config: ChartConfig = {
      total: { label: 'Total', color: 'var(--foreground)' },
    };
    for (const [index, model] of modelsList.entries()) {
      config[model] = {
        label: model,
        /* v8 ignore start -- index % CHART_COLORS.length is always in bounds; the ?? only satisfies noUncheckedIndexedAccess and never fires */
        color: CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)',
        /* v8 ignore stop */
      };
    }

    // Fill missing models with 0 so lines smoothly rise from / fall to zero
    const rows = [...periodMap.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([period, values]) => {
        const row: Record<string, number | string> = {
          period: formatPeriodLabel(period),
        };
        let total = 0;
        for (const model of modelsList) {
          const val = values[model] ?? 0;
          row[model] = val;
          total += val;
        }
        row['total'] = total;
        return row;
      });

    return { chartData: rows, models: modelsList, chartConfig: config };
  }, [data]);

  const dataTable = (
    <table>
      <caption>Spending over time by model, in US dollars</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          {models.map((model) => (
            <th scope="col" key={model}>
              {model}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={String(row['period'])}>
            <th scope="row">{String(row['period'])}</th>
            {models.map((model) => (
              <td key={model}>{formatDollarTooltip(Number(row[model]))}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <UsageChartCard
      title="Spending Over Time"
      testId={TEST_IDS.spendingOverTimeChart}
      isLoading={isLoading}
      isEmpty={chartData.length === 0}
      chartConfig={chartConfig}
      ariaLabel={`Spending over time across ${String(models.length)} model${models.length === 1 ? '' : 's'} over ${String(chartData.length)} period${chartData.length === 1 ? '' : 's'}.`}
      dataTable={dataTable}
    >
      <AreaChart data={chartData} margin={DEFAULT_CHART_MARGIN} accessibilityLayer>
        <XAxis dataKey="period" {...DEFAULT_AXIS_PROPS} />
        <YAxis {...DEFAULT_AXIS_PROPS} tickFormatter={formatDollarTick} />
        <Tooltip
          content={<ChartTooltipContent valueFormatter={formatDollarTooltip} hideZeroValues />}
        />
        <Legend content={<ChartLegendContent />} />
        {models.map((model, index) => {
          /* v8 ignore next -- index % CHART_COLORS.length is always in bounds; the ?? only satisfies noUncheckedIndexedAccess and never fires */
          const color = CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)';
          return (
            <Area
              key={model}
              type="monotone"
              dataKey={model}
              stroke={color}
              fill={color}
              fillOpacity={0.4}
              connectNulls={false}
            />
          );
        })}
        <Area
          type="monotone"
          dataKey="total"
          stroke="var(--foreground)"
          fill="none"
          strokeWidth={2}
          strokeDasharray="4 2"
          dot={false}
        />
      </AreaChart>
    </UsageChartCard>
  );
}
