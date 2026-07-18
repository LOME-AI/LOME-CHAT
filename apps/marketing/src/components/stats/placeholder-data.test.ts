import { describe, it, expect } from 'vitest';
import { publicUsageStatsSchema, USAGE_STATS_WINDOW_KEYS } from '@hushbox/shared';
import { placeholderStats } from './placeholder-data';

describe('placeholderStats', () => {
  it('parses against the wire schema', () => {
    expect(() => publicUsageStatsSchema.parse(placeholderStats)).not.toThrow();
  });

  it('covers at least two modalities so the tab row renders a realistic skeleton', () => {
    expect(Object.keys(placeholderStats.modalities).length).toBeGreaterThanOrEqual(2);
  });

  it('covers every declared window for its primary modality', () => {
    const text = placeholderStats.modalities.text;
    expect(text).toBeDefined();
    for (const key of USAGE_STATS_WINDOW_KEYS) {
      expect(text?.[key]).toBeDefined();
    }
  });

  it('carries several models and a multi-point trend so charts render at realistic density', () => {
    const stats = placeholderStats.modalities.text?.['30d'];
    expect(stats?.models.length).toBeGreaterThanOrEqual(3);
    expect(stats?.trend.points.length).toBeGreaterThanOrEqual(2);
  });
});
