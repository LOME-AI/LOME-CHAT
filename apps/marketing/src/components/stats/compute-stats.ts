import {
  MODALITIES,
  USAGE_STATS_WINDOWS,
  type Modality,
  type PublicUsageStats,
  type UsageStatsWindow,
  type UsageStatsWindowKey,
  type UsageStatsWindowStats,
} from '@hushbox/shared';

type Trend = UsageStatsWindowStats['trend'];

export interface RankedModel {
  readonly rank: number;
  readonly modelId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly sharePercent: number;
  readonly deltaPoints: number | null;
  readonly avgCostUsd: string;
  readonly color: string;
}

export interface TrendBand {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly path: string;
  /** Open polyline along the band's upper edge — stroked as the hard separator line. */
  readonly topPath: string;
}

export interface DotPlotEntry extends RankedModel {
  /** Horizontal position on the log-scale axis, 0 (cheapest) to 100 (priciest). */
  readonly position: number;
}

/** Neutral token for the aggregated Others bucket — never a chart series color. */
export const OTHERS_COLOR = 'var(--border)';

const CHART_TOKEN_COUNT = 5;

/**
 * Modalities present in the payload, in the canonical MODALITIES order. A
 * modality key with an empty window record carries nothing renderable and is
 * treated as absent.
 */
export function availableModalities(data: PublicUsageStats): Modality[] {
  return MODALITIES.filter((modality) => {
    const windows = data.modalities[modality];
    return windows !== undefined && Object.keys(windows).length > 0;
  });
}

export function availableWindows(
  data: PublicUsageStats,
  modality: Modality
): readonly UsageStatsWindow[] {
  return USAGE_STATS_WINDOWS.filter((window) => data.modalities[modality]?.[window.key]);
}

export function defaultWindowKey(windows: readonly UsageStatsWindow[]): UsageStatsWindowKey {
  const thirty = windows.find((window) => window.key === '30d');
  if (thirty !== undefined) return thirty.key;
  if (windows.length === 0) throw new Error('defaultWindowKey requires at least one window');
  return windows[0].key;
}

export interface StatsView {
  readonly modality: Modality;
  readonly window: UsageStatsWindow;
  readonly stats: UsageStatsWindowStats;
}

/**
 * Resolves the (modality, window) pair to render, falling back gracefully:
 * an absent selected modality yields the first present one, and a selected
 * window with no data for that modality yields the modality's default
 * window. Null only when the payload carries no modalities at all.
 */
export function selectView(
  data: PublicUsageStats,
  selectedModality: Modality | null,
  selectedWindowKey: UsageStatsWindowKey | null
): StatsView | null {
  const modalities = availableModalities(data);
  if (modalities.length === 0) return null;
  const modality =
    selectedModality !== null && modalities.includes(selectedModality)
      ? selectedModality
      : modalities[0];

  const windows = availableWindows(data, modality);
  const windowKey =
    selectedWindowKey !== null && windows.some((w) => w.key === selectedWindowKey)
      ? selectedWindowKey
      : defaultWindowKey(windows);
  const window = windows.find((w) => w.key === windowKey);
  const stats = data.modalities[modality]?.[windowKey];
  // Unreachable-by-construction guard: windowKey is drawn from `windows`, and
  // availableWindows only lists keys with data. Defensive only.
  /* v8 ignore next 3 */
  if (window === undefined || stats === undefined) {
    throw new Error('selectView resolved a window without data');
  }
  return { modality, window, stats };
}

/**
 * Series colors are purely token-derived (one-off hex values are banned):
 * ranks 1-5 use --chart-1..5 solid; each further five-rank cycle reuses the
 * same tokens faded another 55% step via color-mix (rank 6-10 at 55%, 11-15
 * at 30%, ...), so every displayed rank gets a visually distinct, stable
 * paint. The fold threshold keeps real lists short; the fade ladder is the
 * deterministic continuation for however many ranks appear.
 */
export function colorForRank(rank: number): string {
  const token = `var(--chart-${String(((rank - 1) % CHART_TOKEN_COUNT) + 1)})`;
  const cycle = Math.floor((rank - 1) / CHART_TOKEN_COUNT);
  if (cycle === 0) return token;
  const percent = Math.round(100 * 0.55 ** cycle);
  return `color-mix(in srgb, ${token} ${String(percent)}%, transparent)`;
}

export function rankModels(stats: UsageStatsWindowStats): RankedModel[] {
  return stats.models
    .toSorted((a, b) => b.sharePercent - a.sharePercent)
    .map((model, index) => ({ ...model, rank: index + 1, color: colorForRank(index + 1) }));
}

/** Display formatting only — the USD string is never fed into arithmetic. */
export function formatUsd(usd: string): string {
  const trimmed = usd.includes('.') ? usd.replace(/0+$/, '').replace(/\.$/, '') : usd;
  return `$${trimmed}`;
}

export function formatDelta(deltaPoints: number): string {
  return `${deltaPoints >= 0 ? '+' : ''}${deltaPoints.toFixed(1)}`;
}

export function formatShare(sharePercent: number): string {
  return `${sharePercent.toFixed(1)}%`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 100%-stacked-area bands over the trend, bottom-up in rank order with the
 * Others band closing the stack. The Others band's upper edge is pinned to
 * the chart top so per-point rounding drift can never leave a sliver of
 * background above the stack. A model absent from a point contributes zero
 * share there; trend-only model ids not in the ranked list are absorbed by
 * the pinned Others band. Fewer than two points cannot draw an area, so the
 * series is empty and the chart shows its not-enough-data placeholder.
 *
 * A zero-share Others is omitted entirely (band and, downstream, its legend
 * entry) to mirror the ranked list's suppression rule; the topmost model band
 * then inherits the chart-top pin so rounding drift still cannot leave a
 * sliver above the stack. With no ranked models the Others band stays as the
 * only thing left to draw.
 */
export function trendSeries(
  trend: Trend,
  ranked: readonly RankedModel[],
  othersSharePercent: number
): TrendBand[] {
  const points = trend.points;
  if (points.length < 2) return [];
  const xs = points.map((_, index) => round2((index * 100) / (points.length - 1)));
  const columns = points;

  const shareAt = (pointIndex: number, modelId: string): number =>
    columns[pointIndex].models.find((m) => m.modelId === modelId)?.sharePercent ?? 0;

  let lower = xs.map(() => 0);
  const bands: TrendBand[] = [];

  const topPath = (upperEdge: readonly number[]): string =>
    xs
      .map(
        (x, index) =>
          `${index === 0 ? 'M' : 'L'} ${String(x)} ${String(round2(100 - upperEdge[index]))}`
      )
      .join(' ');

  const bandPath = (lowerEdge: readonly number[], upperEdge: readonly number[]): string => {
    const forward = xs.map(
      (x, index) => `L ${String(x)} ${String(round2(100 - lowerEdge[index]))}`
    );
    const backward = xs
      .toReversed()
      .map((x, index) => {
        const upper = upperEdge[xs.length - 1 - index];
        return `L ${String(x)} ${String(round2(100 - upper))}`;
      })
      .join(' ');
    const [first, ...rest] = forward;
    return `${first.replace('L', 'M')} ${rest.join(' ')} ${backward} Z`;
  };

  const chartTop = xs.map(() => 100);
  const includeOthers = othersSharePercent !== 0 || ranked.length === 0;

  for (const [modelIndex, model] of ranked.entries()) {
    const pinned = !includeOthers && modelIndex === ranked.length - 1;
    const upper = pinned
      ? chartTop
      : xs.map((_, index) => lower[index] + shareAt(index, model.modelId));
    bands.push({
      id: model.modelId,
      label: model.displayName,
      color: model.color,
      path: bandPath(lower, upper),
      topPath: topPath(upper),
    });
    lower = upper;
  }

  if (includeOthers) {
    bands.push({
      id: 'others',
      label: 'Others',
      color: OTHERS_COLOR,
      path: bandPath(lower, chartTop),
      topPath: topPath(chartTop),
    });
  }

  return bands;
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.split('-');
  return `${MONTH_LABELS[Number(month) - 1]} ${year}`;
}

export function xAxisLabels(
  window: UsageStatsWindow,
  trend: Trend
): { left: string; right: string } {
  if (window.days !== null) {
    return { left: `${String(window.days)} days ago`, right: 'today' };
  }
  if (trend.points.length === 0) return { left: '', right: '' };
  const first = trend.points[0];
  const last = trend.points.toReversed()[0];
  return { left: monthLabel(first.start), right: monthLabel(last.start) };
}

/**
 * Log-scale horizontal positions for the per-model cost dot plot. Costs are
 * parsed as numbers for positioning only, never for money arithmetic.
 * Non-positive costs have no log position and pin to the left edge. Rows are
 * ordered priciest-first (modelId breaks ties) while each color stays keyed
 * to the model's share rank, so the paint matches the share views.
 */
export function dotPlotPositions(ranked: readonly RankedModel[]): DotPlotEntry[] {
  const logs = ranked
    .map((model) => Number.parseFloat(model.avgCostUsd))
    .filter((value) => value > 0)
    .map((value) => Math.log(value));
  const min = Math.min(...logs);
  const max = Math.max(...logs);

  return ranked
    .map((model) => {
      const value = Number.parseFloat(model.avgCostUsd);
      if (value <= 0) return { ...model, position: 0 };
      if (max === min) return { ...model, position: 50 };
      return { ...model, position: round2(((Math.log(value) - min) / (max - min)) * 100) };
    })
    .toSorted((a, b) => {
      const costDiff = Number.parseFloat(b.avgCostUsd) - Number.parseFloat(a.avgCostUsd);
      if (costDiff !== 0) return costDiff;
      if (a.modelId === b.modelId) return 0;
      return a.modelId < b.modelId ? -1 : 1;
    });
}
