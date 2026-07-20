import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { STUCK_PENDING_GRACE_SECONDS } from '../lib/jobs/index.js';
import {
  STUCK_JOBS_PAGE_LIMIT,
  createDispatcherWake,
  createJobsHealthEntry,
  createJobsHealthProbes,
} from './jobs-health-entry.js';
import type { SafeLogFields, Telemetry } from '../lib/telemetry/index.js';
import type { JobShard } from '../lib/jobs/index.js';
import type { DbTransaction } from '../lib/idempotency/transaction.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs-health entry integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

class Rollback extends Error {}

async function withRollback<T>(function_: (tx: DbTransaction) => Promise<T>): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      captured = { value: await function_(tx) };
      throw new Rollback('roll back test writes');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (captured === undefined) throw new Error('withRollback: body did not complete');
  return captured.value;
}

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

interface WakeRecorder {
  readonly wake: (shard: JobShard) => Promise<void>;
  readonly shards: JobShard[];
}

function recordingWake(): WakeRecorder {
  const shards: JobShard[] = [];
  return {
    shards,
    wake: (shard) => {
      shards.push(shard);
      return Promise.resolve();
    },
  };
}

afterAll(async () => {
  await db.$client.end();
});

describe('createJobsHealthEntry', () => {
  it('pages, logs each stuck row, and wakes both shards when a stuck row exists', async () => {
    const recorder = recordingTelemetry();
    const wake = recordingWake();
    const stuckId = await withRollback(async (tx) => {
      const rows = await tx
        .insert(jobs)
        .values({
          type: 'test.health-entry.v1',
          shard: 'bulk',
          payload: {},
          status: 'pending',
          maxClaims: 8,
          maxFailures: 5,
          leaseSeconds: 60,
          nextAttemptAt: sql`now() - make_interval(secs => ${STUCK_PENDING_GRACE_SECONDS + 120})`,
        })
        .returning({ id: jobs.id });
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('failed to insert stuck job');
      const entry = createJobsHealthEntry({
        probes: createJobsHealthProbes(tx),
        telemetry: recorder.telemetry,
        wake: wake.wake,
      });
      expect(entry.name).toBe('jobs-health-audit');
      await entry.run();
      return id;
    });
    expect(recorder.captured).toEqual(['jobs_stuck']);
    expect(
      recorder.errors.some(
        (line) => line.msg === 'job stuck past its health bound' && line.fields?.jobId === stuckId
      )
    ).toBe(true);
    expect(wake.shards).toEqual(['default', 'bulk']);
  });

  it('never pages or wakes when nothing is stuck', async () => {
    const recorder = recordingTelemetry();
    const wake = recordingWake();
    const entry = createJobsHealthEntry({
      probes: {
        findStuck: () => Promise.resolve([]),
      },
      telemetry: recorder.telemetry,
      wake: wake.wake,
    });
    await entry.run();
    expect(recorder.captured).toEqual([]);
    expect(recorder.errors).toEqual([]);
    expect(wake.shards).toEqual([]);
  });
});

describe('createJobsHealthProbes', () => {
  it('bounds the stuck scan by the page limit', async () => {
    const observed = await withRollback(async (tx) => {
      const probes = createJobsHealthProbes(tx);
      const rows = await probes.findStuck();
      return rows.length;
    });
    expect(observed).toBeLessThanOrEqual(STUCK_JOBS_PAGE_LIMIT);
  });
});

describe('createDispatcherWake', () => {
  it('wakes through the bound namespace', async () => {
    const fetched: string[] = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: (url: string) => {
          fetched.push(`${String(id)}:${url}`);
          return Promise.resolve(new Response(null));
        },
      }),
    };
    const wake = createDispatcherWake({ JOB_DISPATCHER: namespace });
    await wake('default');
    await wake('bulk');
    expect(fetched).toEqual([
      'default:https://job-dispatcher/wake',
      'bulk:https://job-dispatcher/wake',
    ]);
  });

  it('is a no-op when the binding is absent', async () => {
    const wake = createDispatcherWake({});
    await expect(wake('default')).resolves.toBeUndefined();
  });
});
