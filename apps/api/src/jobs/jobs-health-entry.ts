import { findStuckJobs, readJobQueueStats, wakeJobDispatcher } from '../lib/jobs/index.js';
import { FINGERPRINT_CODES } from '../lib/telemetry/index.js';
import type {
  JobDispatcherNamespace,
  JobQueueStats,
  JobShard,
  StuckJobRow,
} from '../lib/jobs/index.js';
import type { DbWriter } from '../lib/idempotency/transaction.js';
import type { Telemetry } from '../lib/telemetry/index.js';
import type { CronEntry } from './cron.js';

/**
 * The jobs-health auditor (15-minute cadence): read-only detection plus the
 * one blessed clock-nudge — `wake()` on both dispatcher shards when stuck
 * work is found, because the platform's at-least-once alarm has a documented
 * wedge failure the perpetual re-arm cannot survive alone.
 */

/** Page cap on the stuck-row scan; one stuck row already pages. */
export const STUCK_JOBS_PAGE_LIMIT = 50;

export interface JobsHealthProbes {
  readonly findStuck: () => Promise<StuckJobRow[]>;
  readonly queueStats: () => Promise<JobQueueStats>;
}

export function createJobsHealthProbes(db: DbWriter): JobsHealthProbes {
  return {
    findStuck: () => findStuckJobs(db, { limit: STUCK_JOBS_PAGE_LIMIT }),
    queueStats: () => readJobQueueStats(db),
  };
}

/** The structural env slice the wake nudge needs (absent in local dev/tests). */
export interface JobsHealthCronEnv {
  readonly JOB_DISPATCHER?: JobDispatcherNamespace;
}

/**
 * Binds the lossy wake nudge to the DO namespace. An absent binding is a
 * no-op: the dispatcher's perpetual alarm remains the delivery guarantee,
 * and the auditor's page (not the nudge) is the signal a human acts on.
 */
export function createDispatcherWake(env: JobsHealthCronEnv): (shard: JobShard) => Promise<void> {
  return async (shard: JobShard): Promise<void> => {
    const namespace = env.JOB_DISPATCHER;
    if (namespace === undefined) return;
    await wakeJobDispatcher(namespace, shard);
  };
}

export interface JobsHealthEntryDeps {
  readonly probes: JobsHealthProbes;
  readonly telemetry: Telemetry;
  readonly wake: (shard: JobShard) => Promise<void>;
}

export function createJobsHealthEntry(deps: JobsHealthEntryDeps): CronEntry {
  return {
    name: 'jobs-health-audit',
    run: async (): Promise<void> => {
      const stuck = await deps.probes.findStuck();
      const stats = await deps.probes.queueStats();
      // Watcher: the ops dashboard renders queue depth/age; the page below —
      // not these metrics — is what a human acts on for stuck work.
      deps.telemetry.emitMetric('jobs_queue_depth', stats.pendingCount);
      if (stats.oldestPendingAgeSeconds !== null) {
        deps.telemetry.emitMetric('jobs_oldest_pending_age_seconds', stats.oldestPendingAgeSeconds);
      }
      if (stuck.length === 0) return;
      for (const row of stuck) {
        deps.telemetry.error('job stuck past its health bound', {
          jobId: row.id,
          jobType: row.type,
          errorCode: 'jobs_stuck',
        });
      }
      deps.telemetry.captureError(
        new Error('jobs stuck past health bounds'),
        FINGERPRINT_CODES.jobsStuck
      );
      await deps.wake('default');
      await deps.wake('bulk');
    },
  };
}
