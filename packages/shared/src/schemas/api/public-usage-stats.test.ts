import { describe, it, expect } from 'vitest';
import {
  PUBLIC_USAGE_STATS_SCHEMA_VERSION,
  publicUsageStatsSchema,
  usageStatsWindowStatsSchema,
} from './public-usage-stats.js';

const validWindowStats = {
  models: [
    {
      modelId: 'anthropic/claude-sonnet-4.5',
      displayName: 'Claude Sonnet 4.5',
      provider: 'Anthropic',
      sharePercent: 42.5,
      deltaPoints: 1.2,
      avgCostUsd: '0.0051',
    },
  ],
  others: { sharePercent: 57.5, deltaPoints: -1.2 },
  trend: {
    bucket: 'day' as const,
    points: [
      {
        start: '2026-07-10',
        models: [{ modelId: 'anthropic/claude-sonnet-4.5', sharePercent: 42.5 }],
        othersSharePercent: 57.5,
      },
    ],
  },
  cost: { avgUsd: '0.0051', medianUsd: '0.0032', p90Usd: '0.0140' },
};

const validPayload = {
  schemaVersion: 1,
  generatedAt: '2026-07-17T00:00:00Z',
  modalities: {
    text: { '7d': validWindowStats },
  },
};

describe('usageStatsWindowStatsSchema', () => {
  it('parses valid window stats', () => {
    expect(usageStatsWindowStatsSchema.parse(validWindowStats)).toEqual(validWindowStats);
  });

  it('accepts null deltaPoints on a model entry', () => {
    const stats = {
      ...validWindowStats,
      models: [{ ...validWindowStats.models[0], deltaPoints: null }],
      others: { sharePercent: 57.5, deltaPoints: null },
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(true);
  });

  it('rejects sharePercent above 100', () => {
    const stats = {
      ...validWindowStats,
      models: [{ ...validWindowStats.models[0], sharePercent: 100.1 }],
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects negative sharePercent', () => {
    const stats = {
      ...validWindowStats,
      models: [{ ...validWindowStats.models[0], sharePercent: -0.1 }],
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects sharePercent with more than one decimal place', () => {
    const stats = {
      ...validWindowStats,
      models: [{ ...validWindowStats.models[0], sharePercent: 42.55 }],
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects avgCostUsd given as a number', () => {
    const stats = {
      ...validWindowStats,
      models: [{ ...validWindowStats.models[0], avgCostUsd: 0.0051 }],
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects a non-decimal avgCostUsd string', () => {
    const stats = {
      ...validWindowStats,
      models: [{ ...validWindowStats.models[0], avgCostUsd: '$0.0051' }],
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects a cost value given as a number', () => {
    const stats = {
      ...validWindowStats,
      cost: { ...validWindowStats.cost, medianUsd: 0.0032 },
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects an unknown trend bucket', () => {
    const stats = {
      ...validWindowStats,
      trend: { ...validWindowStats.trend, bucket: 'week' },
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects a non-ISO-date trend point start', () => {
    const stats = {
      ...validWindowStats,
      trend: {
        ...validWindowStats.trend,
        points: [{ ...validWindowStats.trend.points[0], start: 'July 10' }],
      },
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects a smuggled count field on window stats', () => {
    expect(
      usageStatsWindowStatsSchema.safeParse({ ...validWindowStats, messageCount: 12 }).success
    ).toBe(false);
  });

  it('rejects a smuggled count field on a model entry', () => {
    const stats = {
      ...validWindowStats,
      models: [{ ...validWindowStats.models[0], messageCount: 12 }],
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects a smuggled count field on a trend point', () => {
    const stats = {
      ...validWindowStats,
      trend: {
        ...validWindowStats.trend,
        points: [{ ...validWindowStats.trend.points[0], userCount: 3 }],
      },
    };
    expect(usageStatsWindowStatsSchema.safeParse(stats).success).toBe(false);
  });
});

describe('publicUsageStatsSchema', () => {
  it('parses a valid payload', () => {
    expect(publicUsageStatsSchema.parse(validPayload)).toEqual(validPayload);
  });

  it('accepts every shared modality as a key', () => {
    const payload = {
      ...validPayload,
      modalities: {
        text: { '7d': validWindowStats },
        image: { '30d': validWindowStats },
        audio: { all: validWindowStats },
        video: { '7d': validWindowStats },
        embedding: { '30d': validWindowStats },
      },
    };
    expect(publicUsageStatsSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects an unknown modality key', () => {
    const payload = {
      ...validPayload,
      modalities: { hologram: { '7d': validWindowStats } },
    };
    expect(publicUsageStatsSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects an unknown window key', () => {
    const payload = {
      ...validPayload,
      modalities: { text: { '90d': validWindowStats } },
    };
    expect(publicUsageStatsSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a non-integer schemaVersion', () => {
    expect(publicUsageStatsSchema.safeParse({ ...validPayload, schemaVersion: 1.5 }).success).toBe(
      false
    );
  });

  it('rejects a zero schemaVersion', () => {
    expect(publicUsageStatsSchema.safeParse({ ...validPayload, schemaVersion: 0 }).success).toBe(
      false
    );
  });

  it('rejects a non-ISO generatedAt', () => {
    expect(
      publicUsageStatsSchema.safeParse({ ...validPayload, generatedAt: 'yesterday' }).success
    ).toBe(false);
  });

  it('rejects a smuggled count field at the top level', () => {
    expect(publicUsageStatsSchema.safeParse({ ...validPayload, totalMessages: 100 }).success).toBe(
      false
    );
  });
});

describe('PUBLIC_USAGE_STATS_SCHEMA_VERSION', () => {
  it('is the integer 1', () => {
    expect(PUBLIC_USAGE_STATS_SCHEMA_VERSION).toBe(1);
  });
});
