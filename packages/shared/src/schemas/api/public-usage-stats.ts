import { z } from 'zod';
import { Modality } from '../../modality.js';
import { USAGE_STATS_TREND_BUCKETS, USAGE_STATS_WINDOW_KEYS } from '../../usage-stats-windows.js';

/**
 * Public anonymized usage-stats payload served by GET /public/stats and
 * rendered on the marketing site. Structurally count-free: every object is
 * strict/closed and no field carries an absolute count (messages, users,
 * tokens) — only percent shares and per-message cost aggregates. Sum-to-100
 * invariants are the builder's job; this schema validates shape only.
 */

/**
 * The wire-contract version stamped into every snapshot row and payload.
 * Bump it when the payload shape changes incompatibly; the endpoint serves
 * the latest snapshot whose stored version matches this constant.
 */
export const PUBLIC_USAGE_STATS_SCHEMA_VERSION = 1;

const sharePercentSchema = z
  .number()
  .min(0)
  .max(100)
  .refine((v) => Math.round(v * 10) / 10 === v, 'sharePercent must have at most one decimal place');

/** Non-negative decimal USD string (e.g. "0.0051") — money never rides as a JS number. */
const usdStringSchema = z.string().regex(/^\d+(\.\d+)?$/, 'must be a plain decimal USD string');

const modelShareSchema = z.strictObject({
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.string().min(1),
  sharePercent: sharePercentSchema,
  /** Percentage-point change vs the prior equal window; null when the window has no delta. */
  deltaPoints: z.number().nullable(),
  avgCostUsd: usdStringSchema,
});

const othersSchema = z.strictObject({
  sharePercent: sharePercentSchema,
  deltaPoints: z.number().nullable(),
});

const trendModelPointSchema = z.strictObject({
  modelId: z.string().min(1),
  sharePercent: sharePercentSchema,
});

const trendPointSchema = z.strictObject({
  start: z.iso.date(),
  models: z.array(trendModelPointSchema),
  othersSharePercent: sharePercentSchema,
});

const trendSchema = z.strictObject({
  bucket: z.enum(USAGE_STATS_TREND_BUCKETS),
  points: z.array(trendPointSchema),
});

const costSchema = z.strictObject({
  avgUsd: usdStringSchema,
  medianUsd: usdStringSchema,
  p90Usd: usdStringSchema,
});

export const usageStatsWindowStatsSchema = z.strictObject({
  models: z.array(modelShareSchema),
  others: othersSchema,
  trend: trendSchema,
  cost: costSchema,
});

export type UsageStatsWindowStats = z.infer<typeof usageStatsWindowStatsSchema>;

const usageStatsWindowKeySchema = z.enum(USAGE_STATS_WINDOW_KEYS);

export const publicUsageStatsSchema = z.strictObject({
  schemaVersion: z.number().int().positive(),
  generatedAt: z.iso.datetime(),
  modalities: z.partialRecord(
    Modality,
    z.partialRecord(usageStatsWindowKeySchema, usageStatsWindowStatsSchema)
  ),
});

export type PublicUsageStats = z.infer<typeof publicUsageStatsSchema>;
