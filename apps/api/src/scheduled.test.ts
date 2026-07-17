import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_LOG_CRON,
  DAILY_RETENTION_CRON,
  HOURLY_MAINTENANCE_CRON,
  JOBS_HEALTH_CRON,
  createScheduledHandler,
  cronEntriesFor,
  productionScheduledRuntime,
} from './scheduled.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { SafeLogFields, Telemetry } from './lib/telemetry/index.js';
import type { CronDependencies, ScheduledBindings, ScheduledRuntime } from './scheduled.js';

interface TelemetryRecorder {
  readonly telemetry: Telemetry;
  readonly errors: { msg: string; fields: SafeLogFields | undefined }[];
  readonly captured: string[];
}

function recordingTelemetry(): TelemetryRecorder {
  const errors: TelemetryRecorder['errors'] = [];
  const captured: string[] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields?: SafeLogFields) => {
      errors.push({ msg, fields });
    },
    emitMetric: () => {},
    captureError: (_error, code: string) => {
      captured.push(code);
    },
  };
  return { telemetry, errors, captured };
}

function fakeDeps(): CronDependencies {
  return {
    env: { NODE_ENV: 'development' } as ScheduledBindings,
    db: {} as Database,
    redis: {} as Redis,
    telemetry: recordingTelemetry().telemetry,
    now: () => new Date(),
    isCI: false,
    catalogFetch: () => Promise.reject(new Error('unused')),
    gatewayBaseUrl: 'https://gateway.test/api/v1',
    refreshJitter: { maxMs: 0, random: () => 0, sleep: () => Promise.resolve() },
  };
}

describe('cron schedule constants', () => {
  it('mirror the wrangler [triggers] crons exactly', () => {
    const wranglerToml = readFileSync(
      fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
      'utf8'
    );
    const cronsLine = /crons\s*=\s*\[(?<list>[^\]]*)\]/.exec(wranglerToml)?.groups?.['list'];
    if (cronsLine === undefined) throw new Error('wrangler.toml has no [triggers] crons list');
    const deployed = [...cronsLine.matchAll(/"(?<expr>[^"]+)"/g)].map(
      (match) => match.groups?.['expr']
    );
    expect(deployed).toEqual([
      JOBS_HEALTH_CRON,
      ACCESS_LOG_CRON,
      HOURLY_MAINTENANCE_CRON,
      DAILY_RETENTION_CRON,
    ]);
  });
});

describe('cronEntriesFor', () => {
  it('routes the fifteen-minute schedule to the jobs-health auditor', () => {
    const entries = cronEntriesFor(JOBS_HEALTH_CRON, fakeDeps());
    expect(entries?.map((entry) => entry.name)).toEqual(['jobs-health-audit']);
  });

  it('routes the hourly schedule to the pollers and auditors', () => {
    const entries = cronEntriesFor(HOURLY_MAINTENANCE_CRON, fakeDeps());
    expect(entries?.map((entry) => entry.name)).toEqual([
      'model-catalog-refresh',
      'media-gc',
      'ledger-conservation-audit',
      'wallet-snapshot-drift-audit',
    ]);
  });

  it('routes the daily schedule to the retention deletes and the admin digest', () => {
    const entries = cronEntriesFor(DAILY_RETENTION_CRON, fakeDeps());
    expect(entries?.map((entry) => entry.name)).toEqual([
      'idempotency-key-purge',
      'jobs-succeeded-prune',
      'jobs-discarded-prune',
      'account-deletion-events-purge',
      'admin-daily-digest',
    ]);
  });

  it('routes the six-hour schedule to the access-log auditor', () => {
    const entries = cronEntriesFor(ACCESS_LOG_CRON, fakeDeps());
    expect(entries?.map((entry) => entry.name)).toEqual(['admin-access-log-audit']);
  });

  it('runs the access-log audit entry, resolving its reader and allowlist (dev fake reader)', async () => {
    const entries = cronEntriesFor(ACCESS_LOG_CRON, {
      ...fakeDeps(),
      env: {
        NODE_ENV: 'development',
        ADMIN_ACTOR_ALLOWLIST: 'admin@hushbox.ai',
      } as ScheduledBindings,
    });
    const entry = entries?.find((candidate) => candidate.name === 'admin-access-log-audit');
    if (entry === undefined) throw new Error('access-log audit entry missing');
    // Dev resolves a fake, empty reader — the run drives the resolveReader and
    // allowlist thunks and completes without emitting an alert.
    await expect(entry.run()).resolves.toBeUndefined();
  });

  it('routes the hourly schedule in production too (the 6-connection catalog cap)', () => {
    const entries = cronEntriesFor(HOURLY_MAINTENANCE_CRON, {
      ...fakeDeps(),
      env: { NODE_ENV: 'production' } as ScheduledBindings,
    });
    expect(entries?.map((entry) => entry.name)).toEqual([
      'model-catalog-refresh',
      'media-gc',
      'ledger-conservation-audit',
      'wallet-snapshot-drift-audit',
    ]);
  });

  it('returns undefined for an unregistered cron expression', () => {
    expect(cronEntriesFor('59 23 * * *', fakeDeps())).toBeUndefined();
  });
});

interface HandlerHarness {
  readonly runtime: ScheduledRuntime;
  readonly recorder: TelemetryRecorder;
  readonly dbEnds: number[];
}

function handlerHarness(entriesFor: ScheduledRuntime['entriesFor']): HandlerHarness {
  const recorder = recordingTelemetry();
  const dbEnds: number[] = [];
  const runtime: ScheduledRuntime = {
    createDb: () =>
      ({
        $client: {
          end: () => {
            dbEnds.push(1);
            return Promise.resolve();
          },
        },
      }) as unknown as Database,
    createRedis: () => ({}) as Redis,
    createTelemetry: () => recorder.telemetry,
    entriesFor,
  };
  return { runtime, recorder, dbEnds };
}

const ENV: ScheduledBindings = { NODE_ENV: 'development' } as ScheduledBindings;
const CTX = { waitUntil: () => {} };

describe('createScheduledHandler', () => {
  it('captures an unregistered cron expression and still closes the db', async () => {
    const harness = handlerHarness(cronEntriesFor);
    const handler = createScheduledHandler(harness.runtime);
    await handler({ cron: 'bogus' }, ENV, CTX);
    expect(harness.recorder.captured).toEqual(['cron_unknown_schedule']);
    expect(harness.dbEnds).toHaveLength(1);
  });

  it('runs the matched entries and closes the db afterwards', async () => {
    const ran: string[] = [];
    const harness = handlerHarness(() => [
      {
        name: 'first',
        run: () => {
          ran.push('first');
          return Promise.resolve();
        },
      },
      {
        name: 'second',
        run: () => {
          ran.push('second');
          return Promise.resolve();
        },
      },
    ]);
    const handler = createScheduledHandler(harness.runtime);
    await handler({ cron: JOBS_HEALTH_CRON }, ENV, CTX);
    expect(ran).toEqual(['first', 'second']);
    expect(harness.recorder.captured).toEqual([]);
    expect(harness.dbEnds).toHaveLength(1);
  });

  it('supplies live cron dependencies to the entry mapping', async () => {
    let seen: CronDependencies | undefined;
    const harness = handlerHarness((_cron, deps) => {
      seen = deps;
      return [];
    });
    const handler = createScheduledHandler(harness.runtime);
    await handler({ cron: JOBS_HEALTH_CRON }, ENV, CTX);
    if (seen === undefined) throw new Error('entriesFor never received deps');
    expect(seen.now()).toBeInstanceOf(Date);
    expect(seen.gatewayBaseUrl).toContain('openrouter.ai');
    expect(seen.refreshJitter.maxMs).toBe(60_000);
  });

  it('contains an entry failure and closes the db regardless', async () => {
    const harness = handlerHarness(() => [
      { name: 'broken', run: () => Promise.reject(new Error('boom')) },
    ]);
    const handler = createScheduledHandler(harness.runtime);
    await handler({ cron: HOURLY_MAINTENANCE_CRON }, ENV, CTX);
    expect(harness.recorder.captured).toEqual(['cron_entry_failed']);
    expect(harness.dbEnds).toHaveLength(1);
  });
});

describe('productionScheduledRuntime', () => {
  const DEV_ENV = {
    NODE_ENV: 'development',
    DATABASE_URL:
      process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hushbox',
    UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    TELEMETRY_SINKS: 'console',
  } as ScheduledBindings;

  it('fails fast on a missing DATABASE_URL', () => {
    expect(() =>
      productionScheduledRuntime.createDb({ NODE_ENV: 'development' } as ScheduledBindings)
    ).toThrow('DATABASE_URL');
  });

  it('opens (and can close) a dev-mode db handle', async () => {
    const db = productionScheduledRuntime.createDb(DEV_ENV);
    await expect(db.$client.end()).resolves.toBeUndefined();
  });

  it('opens (and can close) a production-mode db handle', async () => {
    const db = productionScheduledRuntime.createDb({
      ...DEV_ENV,
      NODE_ENV: 'production',
    } as ScheduledBindings);
    await expect(db.$client.end()).resolves.toBeUndefined();
  });

  it('fails fast on missing Redis bindings', () => {
    expect(() =>
      productionScheduledRuntime.createRedis({ NODE_ENV: 'development' } as ScheduledBindings)
    ).toThrow('UPSTASH');
  });

  it('builds a Redis client from the bindings', () => {
    const redis = productionScheduledRuntime.createRedis(DEV_ENV);
    expect(typeof redis.scan).toBe('function');
  });

  it('builds the telemetry fan-out from the sink registry', () => {
    const telemetry = productionScheduledRuntime.createTelemetry(DEV_ENV, {
      waitUntil: () => {},
    });
    telemetry.info('cron telemetry smoke check');
    expect(typeof telemetry.captureError).toBe('function');
  });

  it('routes entries through cronEntriesFor', () => {
    expect(productionScheduledRuntime.entriesFor).toBe(cronEntriesFor);
  });
});
