import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, usageRecords } from '@hushbox/db';
import { seedPublicUsageRecords } from './seed-public-stats.js';
import type { PublicUsageRecordSpec } from './seed-public-stats.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for seed-public-stats integration tests`);
  }
  return value;
}

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

// Unique per test run so re-runs never collide with rows a previous run (or the
// real seed) left behind; cleanup deletes exactly this run's rows.
const RUN_KEY = crypto.randomUUID();

function stableKey(suffix: string): string {
  return `public-stats-test-${RUN_KEY}-${suffix}`;
}

function idempotencyKeys(): string[] {
  return SPECS.map((spec) => `seed:public-usage:${spec.stableKey}`);
}

const SPECS: PublicUsageRecordSpec[] = [
  {
    stableKey: stableKey('text'),
    modelId: 'anthropic/claude-opus-4.6',
    providerName: 'anthropic',
    modality: 'text',
    costNanoUsd: 5_200_000n,
    createdAt: new Date('2026-06-10T12:30:00.000Z'),
  },
  {
    stableKey: stableKey('image'),
    modelId: 'openai/gpt-image-1',
    providerName: 'openai',
    modality: 'image',
    costNanoUsd: 40_000_000n,
    isEstimated: true,
    createdAt: new Date('2026-07-01T08:15:00.000Z'),
  },
];

afterAll(async () => {
  await db.delete(usageRecords).where(inArray(usageRecords.idempotencyKey, idempotencyKeys()));
  await db.$client.end();
});

describe('seedPublicUsageRecords', () => {
  it('inserts anonymous, backdated usage records with no user/conversation/content linkage', async () => {
    const result = await seedPublicUsageRecords({ db }, { records: SPECS });
    expect(result.usageRecordsCreated).toBe(2);

    const rows = await db
      .select()
      .from(usageRecords)
      .where(inArray(usageRecords.idempotencyKey, idempotencyKeys()));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.userId).toBeNull();
      expect(row.conversationId).toBeNull();
      expect(row.contentItemId).toBeNull();
      expect(row.runId).toMatch(/^[0-9a-f-]{36}$/);
    }
    const text = rows.find((row) => row.modality === 'text');
    expect(text?.costNanoUsd).toBe(5_200_000n);
    expect(text?.isEstimated).toBe(false);
    expect(text?.createdAt.toISOString()).toBe('2026-06-10T12:30:00.000Z');
    const image = rows.find((row) => row.modality === 'image');
    expect(image?.costNanoUsd).toBe(40_000_000n);
    expect(image?.isEstimated).toBe(true);
  });

  it('is an idempotent no-op on re-run (deterministic keys already present)', async () => {
    const result = await seedPublicUsageRecords({ db }, { records: SPECS });
    expect(result.usageRecordsCreated).toBe(0);

    const rows = await db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(inArray(usageRecords.idempotencyKey, idempotencyKeys()));
    expect(rows).toHaveLength(2);
  });

  it('creates nothing for an empty spec list', async () => {
    const result = await seedPublicUsageRecords({ db }, { records: [] });
    expect(result.usageRecordsCreated).toBe(0);
  });
});
