import * as React from 'react';

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
    color?: string;
    theme?: { light: string; dark: string };
  }
>;

interface ChartContextValue {
  config: ChartConfig;
}

const ChartContext = React.createContext<ChartContextValue | null>(null);

function useChart(): ChartContextValue {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }
  return context;
}

export { useChart };

interface ChartContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  config: ChartConfig;
  children: React.ReactNode;
}

/**
 * Wrapper that provides chart config context and injects CSS variables
 * for chart colors. Each key in config gets a `--color-{key}` variable.
 */
export function ChartContainer({
  config,
  children,
  className,
  ...props
}: Readonly<ChartContainerProps>): React.JSX.Element {
  const colorVariables = React.useMemo(() => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value.color) {
        result[`--color-${key}`] = value.color;
      }
    }
    return result;
  }, [config]);

  return (
    <ChartContext.Provider value={{ config }}>
      <div data-chart="" className={className} style={colorVariables} {...props}>
        {children}
      </div>
    </ChartContext.Provider>
  );
}

interface TooltipPayloadItem {
  name?: string;
  value?: number | string;
  dataKey?: string;
  color?: string;
  payload?: Record<string, unknown>;
}

type IndicatorType = 'line' | 'dot' | 'dashed';

const INDICATOR_SIZES: Record<IndicatorType, { width: number; height: number }> = {
  line: { width: 16, height: 3 },
  dot: { width: 8, height: 8 },
  dashed: { width: 8, height: 8 },
};

// When nameKey is set (e.g. pie charts whose dataKey is the numeric series and
// whose config is keyed by slice names), resolve the config key from name first.
// Without nameKey, dataKey-first keeps cartesian charts resolving correctly.
function resolvePayloadKey(item: TooltipPayloadItem, nameKey?: string): string {
  if (nameKey) {
    const fromNameKey = item.payload?.[nameKey];
    if (typeof fromNameKey === 'string' && fromNameKey !== '') return fromNameKey;
    return item.name ?? item.dataKey ?? '';
  }
  return item.dataKey ?? item.name ?? '';
}

function resolvePayloadColor(item: TooltipPayloadItem, nameKey?: string): string {
  const key = resolvePayloadKey(item, nameKey);
  return item.color ?? `var(--color-${key})`;
}

function resolvePayloadValue(
  item: TooltipPayloadItem,
  valueFormatter?: (value: number | string) => string
): number | string {
  const raw = item.value ?? 0;
  return valueFormatter ? valueFormatter(raw) : raw;
}

function resolveTooltipLabel(
  label: string | undefined,
  labelFormatter?: (label: string) => string
): string | undefined {
  return labelFormatter ? labelFormatter(label ?? '') : label;
}

function resolveVisiblePayload(
  payload: TooltipPayloadItem[] | undefined,
  active: boolean | undefined,
  hideZeroValues: boolean
): TooltipPayloadItem[] | null {
  if (!active || !payload?.length) return null;
  const items = hideZeroValues ? payload.filter((item) => Number(item.value) !== 0) : payload;
  return items.length > 0 ? items : null;
}

interface TooltipIndicatorProps {
  color: string;
  indicator: IndicatorType;
}

function TooltipIndicator({
  color,
  indicator,
}: Readonly<TooltipIndicatorProps>): React.JSX.Element {
  const size = INDICATOR_SIZES[indicator];
  return (
    <div
      className="shrink-0 rounded-[2px]"
      style={{
        // eslint-disable-next-line no-restricted-syntax -- Recharts library API requires inline color style for series colors
        backgroundColor: color,
        width: size.width,
        height: size.height,
        borderStyle: indicator === 'dashed' ? 'dashed' : 'solid',
      }}
    />
  );
}

interface TooltipItemProps {
  itemKey: string;
  config: ChartConfig;
  color: string;
  value: number | string;
  indicator: IndicatorType;
  hideIndicator: boolean;
}

function TooltipItem({
  itemKey,
  config,
  color,
  value,
  indicator,
  hideIndicator,
}: Readonly<TooltipItemProps>): React.JSX.Element {
  const itemLabel = config[itemKey]?.label ?? itemKey;

  return (
    <div className="flex items-center gap-2">
      {!hideIndicator && <TooltipIndicator color={color} indicator={indicator} />}
      <div className="text-muted-foreground flex flex-1 justify-between gap-4">
        <span>{itemLabel}</span>
        <span className="text-foreground font-mono font-medium tabular-nums">{value}</span>
      </div>
    </div>
  );
}

interface ChartTooltipContentProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  labelFormatter?: (label: string) => string;
  valueFormatter?: (value: number | string) => string;
  hideLabel?: boolean;
  hideIndicator?: boolean;
  hideZeroValues?: boolean;
  indicator?: IndicatorType;
  nameKey?: string;
}

/**
 * Custom tooltip content component for Recharts.
 * Reads chart config for labels and colors.
 */
export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
  hideLabel = false,
  hideIndicator = false,
  hideZeroValues = false,
  indicator = 'dot',
  nameKey,
}: Readonly<ChartTooltipContentProps>): React.JSX.Element | null {
  const { config } = useChart();

  const visiblePayload = resolveVisiblePayload(payload, active, hideZeroValues);
  if (!visiblePayload) return null;

  const formattedLabel = resolveTooltipLabel(label, labelFormatter);

  return (
    <div className="bg-background-paper border-border grid min-w-[8rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      {!hideLabel && formattedLabel && (
        <div className="text-muted-foreground font-medium">{formattedLabel}</div>
      )}
      <div className="grid gap-1.5">
        {visiblePayload.map((item) => (
          <TooltipItem
            key={resolvePayloadKey(item, nameKey)}
            itemKey={resolvePayloadKey(item, nameKey)}
            config={config}
            color={resolvePayloadColor(item, nameKey)}
            value={resolvePayloadValue(item, valueFormatter)}
            indicator={indicator}
            hideIndicator={hideIndicator}
          />
        ))}
      </div>
    </div>
  );
}

interface ChartLegendContentProps {
  payload?: {
    value?: string;
    dataKey?: string;
    color?: string;
  }[];
  verticalAlign?: 'top' | 'bottom';
}

/**
 * Custom legend content component for Recharts.
 * Reads chart config for labels and colors.
 */
export function ChartLegendContent({
  payload,
}: Readonly<ChartLegendContentProps>): React.JSX.Element | null {
  const { config } = useChart();

  if (!payload?.length) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-4 pt-3">
      {payload.map((entry) => {
        const key = entry.dataKey ?? entry.value ?? '';
        const itemConfig = config[key];
        const label = itemConfig?.label ?? key;
        const color = entry.color ?? `var(--color-${key})`;

        return (
          <div key={key} className="flex items-center gap-1.5">
            {/* eslint-disable-next-line no-restricted-syntax -- Recharts library API requires inline color style for series colors */}
            <div className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
            <span className="text-muted-foreground text-xs">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
