import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { conflictError, notFoundError } from '../../../../lib/errors/index.js';
import {
  discardJob,
  redriveJob,
  restoreJob,
  wakeJobDispatcher,
} from '../../../../lib/jobs/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { defineAdminOp } from '../registry.js';
import type { JobDispatcherNamespace } from '../../../../lib/jobs/index.js';

/**
 * The dead-inbox dispositions, composed from lib/jobs' published lifecycle
 * writes. `job.redrive` is ephemeral-class: it resumes an existing system
 * obligation — the redriven job's effects are the system's at-least-once
 * work, never admin-originated state — so it has no inverse. The restorable
 * discard marker is the durable pair `job.discard` ↔ `job.restore`; restore
 * never redrives (running the job again is a separate, explicit redrive).
 */

const redriveContract = ADMIN_OP_CONTRACTS['job.redrive'];
const discardContract = ADMIN_OP_CONTRACTS['job.discard'];
const restoreContract = ADMIN_OP_CONTRACTS['job.restore'];

export interface AdminJobDeps {
  readonly jobDispatcher: JobDispatcherNamespace;
}

export const jobRedrive = defineAdminOp<AdminJobDeps, (typeof redriveContract)['input']>(
  redriveContract,
  {
    execute: async (ctx, input) => {
      const result = await redriveJob(ctx.tx, input.jobId);
      if (result.outcome === 'refused') {
        if (result.reason === 'not-found') return err(notFoundError('job does not exist'));
        if (result.reason === 'discarded') {
          return err(conflictError('job is discarded — restore it before redriving'));
        }
        return err(conflictError('job is not dead'));
      }
      if (result.outcome === 'already-active') {
        return err(conflictError('job is already active'));
      }
      const { shard } = result;
      const namespace = ctx.deps.jobDispatcher;
      ctx.registerEphemeral({
        name: 'job.redrive.wake',
        // The lossy post-commit nudge: a lost wake is recovered by the
        // dispatcher's perpetual alarm (wakeJobDispatcher swallows failures).
        run: () => wakeJobDispatcher(namespace, shard),
      });
      return ok({
        effects: [{ label: 'job.status', before: 'dead', after: 'pending' }],
        target: { type: 'job', id: input.jobId },
      });
    },
  }
);

export const jobDiscard = defineAdminOp<AdminJobDeps, (typeof discardContract)['input']>(
  discardContract,
  {
    execute: async (ctx, input) => {
      const result = await discardJob(ctx.tx, input.jobId);
      if (result === 'not-found') return err(notFoundError('job does not exist'));
      if (result === 'already-discarded') return err(conflictError('job is already discarded'));
      if (result === 'not-dead') return err(conflictError('only a dead job can be discarded'));
      return ok({
        effects: [{ label: 'job.discardedAt', before: null, after: 'discarded' }],
        target: { type: 'job', id: input.jobId },
        inverseInput: {
          jobId: input.jobId,
          reason: `undo of job.discard on job ${input.jobId}`,
        },
      });
    },
  }
);

export const jobRestore = defineAdminOp<AdminJobDeps, (typeof restoreContract)['input']>(
  restoreContract,
  {
    execute: async (ctx, input) => {
      const result = await restoreJob(ctx.tx, input.jobId);
      if (result === 'not-found') return err(notFoundError('job does not exist'));
      if (result === 'not-discarded') return err(conflictError('job is not discarded'));
      return ok({
        effects: [{ label: 'job.discardedAt', before: 'discarded', after: null }],
        target: { type: 'job', id: input.jobId },
        inverseInput: {
          jobId: input.jobId,
          reason: `undo of job.restore on job ${input.jobId}`,
        },
      });
    },
  }
);
