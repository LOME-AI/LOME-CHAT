import {
  PUBLIC_USAGE_STATS_SCHEMA_VERSION,
  USAGE_STATS_WINDOWS,
  type PublicUsageStats,
  type UsageStatsWindowKey,
  type UsageStatsWindowStats,
} from '@hushbox/shared';

/**
 * Fixture rendered through the real component tree while the API response is
 * in flight (the roadmap island's ghost-UI pattern): `StatsBoard` stamps
 * `data-skeleton` on the wrapper and global CSS masks the text into shimmer
 * bars, so nothing here is ever visually shown. It is typed as a real
 * {@link PublicUsageStats} so the placeholder cannot drift from the schema.
 *
 * Shape goals (enforced by `placeholder-data.test.ts`): two modalities so
 * the tab row renders, every declared window for the primary modality so the
 * pill row renders fully, and several models plus a multi-point trend so the
 * chart, ranked list, and dot plot shimmer at realistic density.
 */

const PLACEHOLDER_MODELS = [
  { modelId: 'ghost/alpha', displayName: 'Placeholder Alpha', share: 44 },
  { modelId: 'ghost/beta', displayName: 'Placeholder Beta', share: 27 },
  { modelId: 'ghost/gamma', displayName: 'Placeholder Gamma', share: 19 },
] as const;

function placeholderWindow(): UsageStatsWindowStats {
  return {
    models: PLACEHOLDER_MODELS.map((model, index) => ({
      modelId: model.modelId,
      displayName: model.displayName,
      provider: 'ghost',
      sharePercent: model.share,
      deltaPoints: index === 0 ? 1.2 : -0.3,
      avgCostUsd: '0.005',
    })),
    others: { sharePercent: 10, deltaPoints: null },
    trend: {
      bucket: 'day',
      points: [0, 1, 2, 3, 4, 5].map((day) => ({
        start: `2026-06-0${String(day + 1)}`,
        models: PLACEHOLDER_MODELS.map((model) => ({
          modelId: model.modelId,
          sharePercent: model.share,
        })),
        othersSharePercent: 10,
      })),
    },
    cost: { avgUsd: '0.0049', medianUsd: '0.0031', p90Usd: '0.018' },
  };
}

const allWindows = Object.fromEntries(
  USAGE_STATS_WINDOWS.map((window) => [window.key, placeholderWindow()])
) as Partial<Record<UsageStatsWindowKey, UsageStatsWindowStats>>;

export const placeholderStats: PublicUsageStats = {
  schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
  generatedAt: '2026-01-01T00:00:00Z',
  modalities: {
    text: allWindows,
    image: { '30d': placeholderWindow() },
  },
};
