import { Redis } from '@upstash/redis';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchBucket } from './slices/media/adapters/test-fixtures.js';
import { writeThroughSnapshot } from './slices/billing/index.js';
import { BILLING_KEYS } from './slices/billing/domain/keys.js';
import { TEST_GATEWAY_BASE_URL, catalogFetch } from './slices/models/domain/gateway-fixtures.js';
import { runCronEntries } from './jobs/cron.js';
import {
  DAILY_RETENTION_CRON,
  HOURLY_MAINTENANCE_CRON,
  JOBS_HEALTH_CRON,
  cronEntriesFor,
  scheduledHandler,
} from './scheduled.js';
import type { SafeLogFields, Telemetry } from './lib/telemetry/index.js';
import type { CronDependencies, ScheduledBindings } from './scheduled.js';
import type { ScratchBucket } from './slices/media/adapters/test-fixtures.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for scheduled integration tests — run via pnpm test:api`);
  }
  return value;
}

const db = createDb(requireEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({
  url: requireEnv('UPSTASH_REDIS_REST_URL'),
  token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
});

interface TelemetryRecorder {
  readonly telemetry: Telemetry;
  readonly captured: string[];
  readonly metrics: string[];
}

function recordingTelemetry(): TelemetryRecorder {
  const captured: string[] = [];
  const metrics: string[] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (_msg: string, _fields?: SafeLogFields) => {},
    emitMetric: (name: string) => {
      metrics.push(name);
    },
    captureError: (_error, code: string) => {
      captured.push(code);
    },
  };
  return { telemetry, captured, metrics };
}

let scratch: ScratchBucket;

beforeAll(async () => {
  scratch = await createScratchBucket();
});

afterAll(async () => {
  await scratch.destroy();
  await db.$client.end();
});

/**
 * Live-infra deps: real Postgres/Redis/MinIO, the gateway replayed by
 * fixture (an empty catalog — CI never makes a live AI call), and the GC
 * sweep pointed at an isolated scratch bucket (age-based sweeps must never
 * share the dev bucket).
 */
function liveDeps(telemetry: Telemetry): CronDependencies {
  return {
    env: { ...process.env, R2_BUCKET_MEDIA: scratch.bucket } as ScheduledBindings,
    db,
    redis,
    telemetry,
    now: () => new Date(),
    isCI: false,
    catalogFetch: catalogFetch({ models: [], zdrModelIds: [] }),
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    refreshJitter: { maxMs: 0, random: () => 0, sleep: () => Promise.resolve() },
  };
}

describe('the hourly maintenance pass', () => {
  it('runs the poller and every auditor against live infra without an entry failure', async () => {
    // A seeded snapshot guarantees the drift auditor walks at least one
    // wallet (the comparison path, not just the empty scan).
    const walletId = crypto.randomUUID();
    const written = await writeThroughSnapshot(redis, {
      walletId,
      balanceNanoUsd: 1n,
      ledgerSeq: 1n,
      walletType: 'purchased',
    });
    written._unsafeUnwrap();
    const recorder = recordingTelemetry();
    try {
      const entries = cronEntriesFor(HOURLY_MAINTENANCE_CRON, liveDeps(recorder.telemetry));
      if (entries === undefined) throw new Error('hourly cron mapped no entries');
      await runCronEntries(entries, recorder.telemetry);
    } finally {
      await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
    }
    // Ambient dev data may legitimately page an auditor; what must never
    // appear is an entry-level failure.
    expect(recorder.captured).not.toContain('cron_entry_failed');
  });
});

describe('the daily retention pass', () => {
  it('runs both retention deletes against live Postgres without an entry failure', async () => {
    const recorder = recordingTelemetry();
    const entries = cronEntriesFor(DAILY_RETENTION_CRON, liveDeps(recorder.telemetry));
    if (entries === undefined) throw new Error('daily cron mapped no entries');
    await runCronEntries(entries, recorder.telemetry);
    expect(recorder.captured).not.toContain('cron_entry_failed');
  });
});

describe('the jobs-health pass', () => {
  it('probes the live jobs table and emits queue stats without an entry failure', async () => {
    const recorder = recordingTelemetry();
    const entries = cronEntriesFor(JOBS_HEALTH_CRON, liveDeps(recorder.telemetry));
    if (entries === undefined) throw new Error('jobs-health cron mapped no entries');
    await runCronEntries(entries, recorder.telemetry);
    expect(recorder.captured).not.toContain('cron_entry_failed');
    expect(recorder.metrics).toContain('jobs_queue_depth');
  });
});

describe('scheduledHandler (production runtime, end to end)', () => {
  it('executes a daily retention trigger against the live stack', async () => {
    const env = { ...process.env, TELEMETRY_SINKS: 'console' } as ScheduledBindings;
    await expect(
      scheduledHandler({ cron: DAILY_RETENTION_CRON }, env, { waitUntil: () => {} })
    ).resolves.toBeUndefined();
  });
});
