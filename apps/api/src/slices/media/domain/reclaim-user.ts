import { z } from 'zod';
import { jobOutcome } from '../../../lib/jobs/index.js';
import { MEDIA_PREFIX, validateMediaKey } from '../ports/index.js';
import { deleteSequentially } from './gc.js';
import type { JobOutcome, JobRegistration } from '../../../lib/jobs/index.js';
import type { Storage } from '../ports/index.js';

/**
 * The deleted-account media sweep. Hard deletion cascades the DB rows in its
 * own transaction and enqueues this job with the storage keys captured
 * before the cascade (the keys die with the rows at commit, so the payload
 * is the only surviving map from account to ciphertext). R2 delete is
 * naturally idempotent, so redelivery after a crash simply re-deletes; the
 * orphan GC remains the crash-debris backstop if the job is lost entirely.
 */
export const MEDIA_RECLAIM_USER_JOB_TYPE = 'media.reclaimUser.v1';

/** Deletes between lease heartbeats; the fence stops zombies chunk-by-chunk. */
export const MEDIA_RECLAIM_HEARTBEAT_CHUNK = 25;

const mediaKeySchema = z
  .string()
  .refine((key) => key.startsWith(MEDIA_PREFIX) && validateMediaKey(key) === null, {
    message: 'reclaim keys must be well-formed media/ object keys',
  });

export const mediaReclaimUserPayloadSchema = z.object({
  userId: z.uuid(),
  storageKeys: z.array(mediaKeySchema),
});

export interface MediaReclaimUserJobDeps {
  readonly storage: Storage;
}

export function createMediaReclaimUserJob(
  deps: MediaReclaimUserJobDeps
): JobRegistration<typeof mediaReclaimUserPayloadSchema> {
  return {
    type: MEDIA_RECLAIM_USER_JOB_TYPE,
    schema: mediaReclaimUserPayloadSchema,
    leaseSeconds: 300,
    maxFailures: 8,
    idempotency: 'natural',
    shard: 'bulk',
    handler: async (execution): Promise<JobOutcome> => {
      const { storageKeys } = execution.payload;
      for (let start = 0; start < storageKeys.length; start += MEDIA_RECLAIM_HEARTBEAT_CHUNK) {
        if ((await execution.heartbeat()) === 'lost') {
          return jobOutcome.fail('media reclaim lease lost mid-run');
        }
        const chunk = storageKeys.slice(start, start + MEDIA_RECLAIM_HEARTBEAT_CHUNK);
        const deleted = await deleteSequentially(deps.storage, chunk);
        if (deleted.isErr()) {
          return jobOutcome.fail(`media reclaim delete failed: ${deleted.error.code}`);
        }
      }
      return jobOutcome.ok({ reclaimed: storageKeys.length });
    },
  };
}
