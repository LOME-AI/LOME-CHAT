import { describe, it, expect } from 'vitest';
import type { PublicUsageStats, UsageStatsWindowStats } from '@hushbox/shared';
import { USAGE_STATS_WINDOWS } from '@hushbox/shared';
import {
  availableModalities,
  availableWindows,
  defaultWindowKey,
  rankModels,
  colorForRank,
  OTHERS_COLOR,
  formatUsd,
  formatDelta,
  formatShare,
  trendSeries,
  xAxisLabels,
  dotPlotPositions,
  selectView,
} from './compute-stats';

function windowStats(overrides: Partial<UsageStatsWindowStats> = {}): UsageStatsWindowStats {
  return {
    models: [
      {
        modelId: 'a/one',
        displayName: 'One',
        provider: 'a',
        sharePercent: 40,
        deltaPoints: 2.1,
        avgCostUsd: '0.01',
      },
      {
        modelId: 'b/two',
        displayName: 'Two',
        provider: 'b',
        sharePercent: 50,
        deltaPoints: -0.4,
        avgCostUsd: '0.002',
      },
    ],
    others: { sharePercent: 10, deltaPoints: null },
    trend: {
      bucket: 'day',
      points: [
        {
          start: '2026-06-01',
          models: [
            { modelId: 'a/one', sharePercent: 40 },
            { modelId: 'b/two', sharePercent: 50 },
          ],
          othersSharePercent: 10,
        },
        {
          start: '2026-06-02',
          models: [{ modelId: 'b/two', sharePercent: 80 }],
          othersSharePercent: 20,
        },
      ],
    },
    cost: { avgUsd: '0.0051', medianUsd: '0.003', p90Usd: '0.02' },
    ...overrides,
  };
}

function stats(modalities: PublicUsageStats['modalities']): PublicUsageStats {
  return { schemaVersion: 1, generatedAt: '2026-07-01T00:00:00Z', modalities };
}

describe('availableModalities', () => {
  it('returns only modalities present in the payload, in canonical order', () => {
    const data = stats({
      video: { '30d': windowStats() },
      text: { '30d': windowStats() },
    });
    expect(availableModalities(data)).toEqual(['text', 'video']);
  });

  it('excludes a modality whose window record is empty', () => {
    const data = stats({ text: { '30d': windowStats() }, image: {} });
    expect(availableModalities(data)).toEqual(['text']);
  });
});

describe('availableWindows', () => {
  it('returns the declared windows that have data for the modality, in declaration order', () => {
    const data = stats({ text: { all: windowStats(), '7d': windowStats() } });
    expect(availableWindows(data, 'text').map((w) => w.key)).toEqual(['7d', 'all']);
  });

  it('returns an empty list for an absent modality', () => {
    const data = stats({ text: { '30d': windowStats() } });
    expect(availableWindows(data, 'image')).toEqual([]);
  });
});

describe('defaultWindowKey', () => {
  it('prefers 30d when present', () => {
    expect(defaultWindowKey(USAGE_STATS_WINDOWS)).toBe('30d');
  });

  it('falls back to the first available window when 30d is absent', () => {
    const windows = USAGE_STATS_WINDOWS.filter((w) => w.key !== '30d');
    expect(defaultWindowKey(windows)).toBe('7d');
  });

  it('throws on an empty window list', () => {
    expect(() => defaultWindowKey([])).toThrow(/at least one window/);
  });
});

describe('rankModels', () => {
  it('orders models by descending share and assigns 1-based ranks', () => {
    const ranked = rankModels(windowStats());
    expect(ranked.map((m) => m.modelId)).toEqual(['b/two', 'a/one']);
    expect(ranked.map((m) => m.rank)).toEqual([1, 2]);
  });

  it('assigns chart token colors by rank', () => {
    const ranked = rankModels(windowStats());
    expect(ranked[0]?.color).toBe('var(--chart-1)');
    expect(ranked[1]?.color).toBe('var(--chart-2)');
  });
});

describe('colorForRank', () => {
  it('assigns the five chart tokens solid for ranks 1-5', () => {
    expect(colorForRank(1)).toBe('var(--chart-1)');
    expect(colorForRank(5)).toBe('var(--chart-5)');
  });

  it('renders rank 6 as a faded chart-1, distinct from rank 1', () => {
    expect(colorForRank(6)).toBe('color-mix(in srgb, var(--chart-1) 55%, transparent)');
    expect(colorForRank(6)).not.toBe(colorForRank(1));
  });

  it('keeps all ten ranks pairwise distinct and stable', () => {
    const colors = Array.from({ length: 10 }, (_, index) => colorForRank(index + 1));
    expect(new Set(colors).size).toBe(10);
    expect(colors[9]).toBe('color-mix(in srgb, var(--chart-5) 55%, transparent)');
  });

  it('fades a further step for each cycle beyond rank 10', () => {
    expect(colorForRank(11)).toBe('color-mix(in srgb, var(--chart-1) 30%, transparent)');
    expect(colorForRank(11)).not.toBe(colorForRank(6));
  });
});

describe('OTHERS_COLOR', () => {
  it('is the neutral border token', () => {
    expect(OTHERS_COLOR).toBe('var(--border)');
  });
});

describe('formatUsd', () => {
  it('prefixes a dollar sign', () => {
    expect(formatUsd('0.0051')).toBe('$0.0051');
  });

  it('trims trailing fraction zeros', () => {
    expect(formatUsd('0.0100')).toBe('$0.01');
  });

  it('drops a fraction that trims to nothing', () => {
    expect(formatUsd('2.000')).toBe('$2');
  });

  it('leaves integer strings untouched', () => {
    expect(formatUsd('3')).toBe('$3');
  });
});

describe('formatDelta', () => {
  it('renders positive deltas with an explicit plus sign', () => {
    expect(formatDelta(2.1)).toBe('+2.1');
  });

  it('renders negative deltas with a minus sign', () => {
    expect(formatDelta(-0.4)).toBe('-0.4');
  });

  it('renders zero as +0.0', () => {
    expect(formatDelta(0)).toBe('+0.0');
  });
});

describe('formatShare', () => {
  it('renders one decimal place with a percent sign', () => {
    expect(formatShare(40)).toBe('40.0%');
  });
});

describe('trendSeries', () => {
  it('returns one band per ranked model plus Others last', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.map((s) => s.label)).toEqual(['Two', 'One', 'Others']);
    expect(series.at(-1)?.color).toBe(OTHERS_COLOR);
  });

  it('treats a model missing from a point as zero share there', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    // At the second point 'a/one' is absent: its band must be flat (zero height).
    const one = series.find((s) => s.label === 'One');
    expect(one?.path).toContain('L 100');
  });

  it('pins the top of the Others band to the chart top', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    const others = series.at(-1);
    expect(others?.path).toContain(' 0 ');
  });

  it('exposes a top-boundary line path per band tracing its upper edge', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    // Stack bottom-up: Two upper = [50, 80] → y [50, 20]; One upper = [90, 80] → y [10, 20].
    expect(series.map((s) => s.topPath)).toEqual([
      'M 0 50 L 100 20',
      'M 0 10 L 100 20',
      'M 0 0 L 100 0',
    ]);
  });

  it('pins the Others top line to the chart top', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.at(-1)?.topPath).toBe('M 0 0 L 100 0');
  });

  it('returns no bands when the trend has a single point', () => {
    const ws = windowStats();
    const trend = { bucket: ws.trend.bucket, points: [ws.trend.points[0]] };
    expect(trendSeries(trend, rankModels(ws), ws.others.sharePercent)).toEqual([]);
  });

  it('returns no bands when the trend has no points', () => {
    const ws = windowStats();
    expect(trendSeries({ bucket: 'day', points: [] }, rankModels(ws), 10)).toEqual([]);
  });

  it('renders only the Others band when no models are ranked', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(windowStats({ models: [] })), 10);
    expect(series.map((s) => s.label)).toEqual(['Others']);
  });

  function zeroOthersStats(): UsageStatsWindowStats {
    return windowStats({
      others: { sharePercent: 0, deltaPoints: null },
      trend: {
        bucket: 'day',
        points: [
          {
            start: '2026-06-01',
            models: [
              { modelId: 'a/one', sharePercent: 40 },
              { modelId: 'b/two', sharePercent: 60 },
            ],
            othersSharePercent: 0,
          },
          {
            // Point shares sum to 99.9: per-point rounding drift the pinned
            // topmost band must absorb when Others is omitted.
            start: '2026-06-02',
            models: [
              { modelId: 'a/one', sharePercent: 33.3 },
              { modelId: 'b/two', sharePercent: 66.6 },
            ],
            othersSharePercent: 0,
          },
        ],
      },
    });
  }

  it('omits the Others band when the window Others share is zero', () => {
    const ws = zeroOthersStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.map((s) => s.label)).toEqual(['Two', 'One']);
  });

  it('pins the topmost model band to the chart top when Others is omitted', () => {
    const ws = zeroOthersStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.at(-1)?.label).toBe('One');
    expect(series.at(-1)?.topPath).toBe('M 0 0 L 100 0');
  });

  it('keeps the Others band when no models are ranked even at zero share', () => {
    const ws = zeroOthersStats();
    const series = trendSeries(ws.trend, rankModels(windowStats({ models: [] })), 0);
    expect(series.map((s) => s.label)).toEqual(['Others']);
  });
});

describe('xAxisLabels', () => {
  it('labels bounded day-bucket windows relative to today', () => {
    const window30 = USAGE_STATS_WINDOWS.find((w) => w.key === '30d')!;
    const ws = windowStats();
    expect(xAxisLabels(window30, ws.trend)).toEqual({ left: '30 days ago', right: 'today' });
  });

  it('labels the all-time window with the first and last month', () => {
    const windowAll = USAGE_STATS_WINDOWS.find((w) => w.key === 'all')!;
    const trend = {
      bucket: 'month' as const,
      points: [
        { start: '2025-11-01', models: [], othersSharePercent: 100 },
        { start: '2026-06-01', models: [], othersSharePercent: 100 },
      ],
    };
    expect(xAxisLabels(windowAll, trend)).toEqual({ left: 'Nov 2025', right: 'Jun 2026' });
  });

  it('returns empty labels when an unbounded trend has no points', () => {
    const windowAll = USAGE_STATS_WINDOWS.find((w) => w.key === 'all')!;
    expect(xAxisLabels(windowAll, { bucket: 'month', points: [] })).toEqual({
      left: '',
      right: '',
    });
  });
});

describe('selectView', () => {
  const data = stats({
    text: { '7d': windowStats(), '30d': windowStats(), all: windowStats() },
    video: { all: windowStats() },
  });

  it('defaults to the first present modality and the 30d window', () => {
    const view = selectView(data, null, null);
    expect(view?.modality).toBe('text');
    expect(view?.window.key).toBe('30d');
  });

  it('honors a valid selection', () => {
    const view = selectView(data, 'text', '7d');
    expect(view?.modality).toBe('text');
    expect(view?.window.key).toBe('7d');
  });

  it('falls back to an available window when the selected one has no data for the modality', () => {
    const view = selectView(data, 'video', '30d');
    expect(view?.modality).toBe('video');
    expect(view?.window.key).toBe('all');
  });

  it('falls back to the first present modality when the selected one is absent', () => {
    const view = selectView(data, 'image', '30d');
    expect(view?.modality).toBe('text');
  });

  it('returns null when the payload has no modalities', () => {
    expect(selectView(stats({}), null, null)).toBeNull();
  });

  it('exposes the window stats for the resolved pair', () => {
    const view = selectView(data, null, null);
    expect(view?.stats.cost.avgUsd).toBe('0.0051');
  });
});

describe('dotPlotPositions', () => {
  it('places the cheapest model at 0 and the priciest at 100 on a log scale', () => {
    const positions = dotPlotPositions(rankModels(windowStats()));
    const byId = new Map(positions.map((p) => [p.modelId, p.position]));
    expect(byId.get('b/two')).toBe(0);
    expect(byId.get('a/one')).toBe(100);
  });

  it('centers a single model', () => {
    const ws = windowStats();
    const only = rankModels({ ...ws, models: [ws.models[0]] });
    expect(dotPlotPositions(only)[0]?.position).toBe(50);
  });

  it('centers models when all costs are equal', () => {
    const ws = windowStats();
    const equal = rankModels({
      ...ws,
      models: ws.models.map((m) => ({ ...m, avgCostUsd: '0.01' })),
    });
    expect(dotPlotPositions(equal).every((p) => p.position === 50)).toBe(true);
  });

  it('pins non-positive costs to the left edge', () => {
    const ws = windowStats();
    const withZero = rankModels({
      ...ws,
      models: [{ ...ws.models[0], avgCostUsd: '0' }, ws.models[1]],
    });
    const byId = new Map(dotPlotPositions(withZero).map((p) => [p.modelId, p.position]));
    expect(byId.get('a/one')).toBe(0);
  });

  it('orders entries by average cost descending', () => {
    const positions = dotPlotPositions(rankModels(windowStats()));
    expect(positions.map((p) => p.modelId)).toEqual(['a/one', 'b/two']);
  });

  it('breaks cost ties by modelId ascending', () => {
    const ws = windowStats();
    const tied = rankModels({
      ...ws,
      models: ws.models.map((m) => ({ ...m, avgCostUsd: '0.01' })),
    });
    expect(dotPlotPositions(tied).map((p) => p.modelId)).toEqual(['a/one', 'b/two']);
  });

  it('keeps each color keyed to the model share rank after reordering', () => {
    const positions = dotPlotPositions(rankModels(windowStats()));
    const byId = new Map(positions.map((p) => [p.modelId, p.color]));
    expect(byId.get('b/two')).toBe('var(--chart-1)');
    expect(byId.get('a/one')).toBe('var(--chart-2)');
  });
});
