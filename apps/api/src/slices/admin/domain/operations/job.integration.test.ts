import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb, idempotencyKeys, jobs } from '@hushbox/db';
import { deadJobFactory, discardedJobFactory, jobFactory } from '@hushbox/db/factories';
import { eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { redriveJob } from '../../../../lib/jobs/index.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { adminJobOperations } from './index.js';
import type { JobDispatcherNamespace } from '../../../../lib/jobs/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type {
  AdminOpHarnessInstance,
  AdminOpInterleavingAction,
  AdminOpInterleavingConfig,
} from '../describe-admin-op.js';
import type { AdminJobDeps } from './job.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin job op tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const adminStores = createAdminStores();

const REDRIVE_CONTRACT = ADMIN_OP_CONTRACTS['job.redrive'];
const DISCARD_CONTRACT = ADMIN_OP_CONTRACTS['job.discard'];
const RESTORE_CONTRACT = ADMIN_OP_CONTRACTS['job.restore'];

const insertedJobIds: string[] = [];

afterAll(async () => {
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/job.%'));
  for (const jobId of insertedJobIds) {
    await db.delete(jobs).where(eq(jobs.id, jobId));
  }
});

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    emitMetric: noop,
    captureError: noop,
  };
}

interface WakeProbeState {
  readonly log: string[];
  armed: boolean;
}

/**
 * The battery's ephemeral seam: a fake dispatcher namespace recording each
 * wake by shard name. `wakeJobDispatcher` swallows failures by design (lossy
 * nudge), so the armed probe throws BEFORE recording — the battery's
 * failure arm sees an empty log while the op still succeeds.
 */
function probeNamespace(state: WakeProbeState): JobDispatcherNamespace {
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: (_url: string, _init?: { method: string }): Promise<unknown> => {
        if (state.armed) return Promise.reject(new Error('wake probe armed to fail'));
        state.log.push(String(id));
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    }),
  };
}

interface JobHarness extends AdminOpHarnessInstance {
  readonly jobId: string;
  readonly wakes: readonly string[];
}

type JobSeed = 'dead' | 'discarded' | 'pending';

async function insertJob(seed: JobSeed): Promise<string> {
  // Always the bulk shard: committed rows must never be claimable by a
  // default-shard dispatcher pass (jobs test-isolation doctrine).
  const factories = {
    dead: deadJobFactory,
    discarded: discardedJobFactory,
    pending: jobFactory,
  } as const;
  const values = factories[seed].build({ shard: 'bulk' });
  const [row] = await db.insert(jobs).values(values).returning({ id: jobs.id });
  if (row === undefined) throw new Error('job harness: job insert returned no row');
  insertedJobIds.push(row.id);
  return row.id;
}

async function createJobHarness(
  options: { hooks?: AdminOpEngineHooks } = {},
  seed: JobSeed = 'dead'
): Promise<JobHarness> {
  const jobId = await insertJob(seed);
  const actor = `admin-job-test-${crypto.randomUUID()}@hushbox.ai`;
  const probe: WakeProbeState = { log: [], armed: false };
  const deps: AdminJobDeps = { jobDispatcher: probeNamespace(probe) };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminJobDeps>([...adminJobOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: deps,
    executorId: `admin-job-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    jobId,
    wakes: probe.log,
    /**
     * Admin-originated durable state only: the restorable discard marker.
     * Scheduler state (status, claims, failures) is deliberately excluded —
     * a redriven job's effects are the system's resumed obligation, which is
     * exactly why `job.redrive` is ephemeral-class.
     */
    projection: async (): Promise<{ discarded: boolean }> => {
      const rows = await db
        .select({ discardedAt: jobs.discardedAt })
        .from(jobs)
        .where(eq(jobs.id, jobId));
      const row = rows[0];
      if (row === undefined) throw new Error('job harness: projection job is gone');
      return { discarded: row.discardedAt !== null };
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    ephemeral: {
      log: () => probe.log,
      armFailure: () => {
        probe.armed = true;
      },
    },
  };
}

function jobOf(harness: AdminOpHarnessInstance): string {
  return (harness as JobHarness).jobId;
}

/** Scheduler churn on the target row: feasibility diverges (a discarded row
 * refuses redrive) — accepted per the Charter; the projection tracks only
 * the discard marker, which redrive never touches. */
const targetRedriveAttempt: AdminOpInterleavingAction = {
  name: 'system-redrive-attempt',
  run: async (harness) => {
    await redriveJob(db, jobOf(harness));
  },
};

/** Redrive churn on a per-run noise dead row — meaningful table churn with
 * no interaction with the op target (job.restore's undo is `job.discard`,
 * which refuses on a non-dead row, so the target must not be redriven). */
const noiseDeadRedrive: AdminOpInterleavingAction = {
  name: 'noise-dead-redrive',
  run: async () => {
    const noiseId = await insertJob('dead');
    await redriveJob(db, noiseId);
  },
};

const noiseEnqueue: AdminOpInterleavingAction = {
  name: 'noise-enqueue',
  run: async () => {
    await insertJob('pending');
  },
};

function jobInterleaving(actions: readonly AdminOpInterleavingAction[]): AdminOpInterleavingConfig {
  return {
    seeds: [13, 23, 43],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      jobId: jobOf(harness),
      reason: `interleaving disposition ${crypto.randomUUID()}`,
    }),
    actions,
  };
}

const redriveTarget = { jobId: '' };
describeAdminOp({
  contract: REDRIVE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createJobHarness(options);
    redriveTarget.jobId = harness.jobId;
    return harness;
  },
  validInput: () => ({
    jobId: redriveTarget.jobId,
    reason: `cause fixed, redriving ${crypto.randomUUID()}`,
  }),
  invalidInput: { jobId: 'not-a-uuid', reason: 'x' },
  hasEphemeralEffects: true,
});

const discardTarget = { jobId: '' };
describeAdminOp({
  contract: DISCARD_CONTRACT,
  createHarness: async (options) => {
    const harness = await createJobHarness(options);
    discardTarget.jobId = harness.jobId;
    return harness;
  },
  validInput: () => ({
    jobId: discardTarget.jobId,
    reason: `obsolete job ${crypto.randomUUID()}`,
  }),
  invalidInput: { jobId: 'not-a-uuid', reason: 'x' },
  interleaving: jobInterleaving([targetRedriveAttempt, noiseEnqueue]),
});

const restoreTarget = { jobId: '' };
describeAdminOp({
  contract: RESTORE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createJobHarness(options, 'discarded');
    restoreTarget.jobId = harness.jobId;
    return harness;
  },
  validInput: () => ({
    jobId: restoreTarget.jobId,
    reason: `discarded in error ${crypto.randomUUID()}`,
  }),
  invalidInput: { jobId: 'not-a-uuid', reason: 'x' },
  interleaving: jobInterleaving([noiseDeadRedrive, noiseEnqueue]),
});

function runOp(
  harness: JobHarness,
  name: string,
  jobId: string
): ReturnType<JobHarness['engine']['run']> {
  return harness.engine.run({
    name,
    input: { jobId, reason: `semantic probe ${crypto.randomUUID()}` },
    actor: harness.actor,
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
  });
}

describe('job.redrive / job.discard / job.restore semantics', () => {
  it('redrives a dead row to pending with counters reset and wakes the returned shard post-commit', async () => {
    const harness = await createJobHarness();
    expect(harness.wakes).toEqual([]);

    const result = await runOp(harness, 'job.redrive', harness.jobId);

    expect(result.isOk()).toBe(true);
    const rows = await db
      .select({ status: jobs.status, claims: jobs.claims, failures: jobs.failures })
      .from(jobs)
      .where(eq(jobs.id, harness.jobId));
    expect(rows[0]).toEqual({ status: 'pending', claims: 0, failures: 0 });
    // The dead row rode the bulk shard; the wake must name that exact shard.
    expect(harness.wakes).toEqual(['bulk']);
  });

  it('refuses to redrive a discarded row — restore it first (no wake fired)', async () => {
    const harness = await createJobHarness({}, 'discarded');

    const result = await runOp(harness, 'job.redrive', harness.jobId);

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(harness.wakes).toEqual([]);
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses to redrive an already-active row with a typed conflict', async () => {
    const harness = await createJobHarness({}, 'pending');

    const result = await runOp(harness, 'job.redrive', harness.jobId);

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(harness.wakes).toEqual([]);
  });

  it('refuses to redrive a terminal non-dead row with a typed conflict', async () => {
    const harness = await createJobHarness();
    const [row] = await db
      .insert(jobs)
      .values({ ...jobFactory.build({ shard: 'bulk' }), status: 'succeeded' })
      .returning({ id: jobs.id });
    if (row === undefined) throw new Error('succeeded job insert returned no row');
    insertedJobIds.push(row.id);

    const result = await runOp(harness, 'job.redrive', row.id);

    expect(result.isErr() && result.error.code).toBe('conflict');
  });

  it('refuses to discard a non-dead row with a typed conflict', async () => {
    const harness = await createJobHarness({}, 'pending');

    const result = await runOp(harness, 'job.discard', harness.jobId);

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.projection()).toEqual({ discarded: false });
  });

  it('refuses to discard an already-discarded row with a typed conflict', async () => {
    const harness = await createJobHarness({}, 'discarded');

    const result = await runOp(harness, 'job.discard', harness.jobId);

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses to restore an undiscarded row with a typed conflict', async () => {
    const harness = await createJobHarness();

    const result = await runOp(harness, 'job.restore', harness.jobId);

    expect(result.isErr() && result.error.code).toBe('conflict');
  });

  it('refuses an unknown job with a typed not-found on every job op', async () => {
    const harness = await createJobHarness();
    const missing = crypto.randomUUID();

    for (const name of ['job.redrive', 'job.discard', 'job.restore']) {
      const result = await runOp(harness, name, missing);
      expect(result.isErr() && result.error.code).toBe('not_found');
    }
    expect(await harness.auditCount()).toBe(0);
  });

  it('registers discard/restore as an inverse pair and redrive alone (Iron Law gate)', () => {
    const registry = createAdminOpRegistry<AdminJobDeps>([...adminJobOperations]);

    expect(registry.get('job.discard')?.contract.inverse).toBe('job.restore');
    expect(registry.get('job.restore')?.contract.inverse).toBe('job.discard');
    expect(registry.get('job.redrive')?.contract.inverse).toBeNull();

    const loneDiscard = adminJobOperations.filter(
      (operation) => operation.contract.name === 'job.discard'
    );
    expect(() => createAdminOpRegistry<AdminJobDeps>(loneDiscard)).toThrow(
      /Reversibility Iron Law/
    );
  });
});
