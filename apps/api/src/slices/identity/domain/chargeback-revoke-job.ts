import { z } from 'zod';
import { jobOutcome } from '../../../lib/jobs/index.js';
import { CHARGEBACK_REVOKE_JOB_TYPE } from '../../billing/index.js';
import { evictUserBestEffort, revokeAllSessions } from './session.js';
import type { JobOutcome, JobRegistration } from '../../../lib/jobs/index.js';
import type { EvictUserPort } from '../ports/index.js';
import type { RedisClient } from './keys.js';

/**
 * Failure budget before the dispatcher dead-letters the row. Only a transient
 * watermark-bump (Redis) failure consumes it; the eviction fan-out is
 * best-effort and never fails the job. A dead row is a jobs-health auditor page
 * — the must-happen guarantee the redesign puts under session revocation.
 */
export const CHARGEBACK_REVOKE_MAX_FAILURES = 10;

const chargebackRevokePayloadSchema = z.object({ userId: z.uuid() });

export interface ChargebackRevokeJobDeps {
  readonly redis: RedisClient;
  /** Absent when the realtime binding is unavailable (degrades to no eviction). */
  readonly evictUser?: EvictUserPort;
  /** Injected for deterministic watermark assertions; defaults to wall clock. */
  readonly now?: () => number;
}

/**
 * `chargeback.revoke.v1` — the must-happen session revocation for a locked
 * account, enqueued in the webhook's clawback+lock settlement transaction (so
 * it can never be lost the way a swallowed post-commit best-effort bump was).
 * The handler bumps the all-session `passwordChangedAt` watermark — the SOLE
 * cutoff for a locked user's ALREADY-LIVE sessions and WS (the `users.lockedAt`
 * gate only blocks NEW logins) — then evicts live sockets best-effort. A
 * transient bump failure returns `fail` so the dispatcher retries within
 * seconds, closing the up-to-30-day window a lost bump would have left open.
 *
 * `natural` idempotency: re-running re-bumps the watermark to a fresh `now`,
 * which is idempotent in effect (a locked account issues no new full sessions,
 * so a later watermark still stales exactly the sessions that must die); the
 * eviction is best-effort promptness, backstopped by the fail-closed
 * broadcast-time session-liveness check the watermark drives.
 */
export function createChargebackRevokeJobRegistration(
  deps: ChargebackRevokeJobDeps
): JobRegistration<typeof chargebackRevokePayloadSchema> {
  const now = deps.now ?? ((): number => Date.now());
  return {
    type: CHARGEBACK_REVOKE_JOB_TYPE,
    schema: chargebackRevokePayloadSchema,
    leaseSeconds: 30,
    maxFailures: CHARGEBACK_REVOKE_MAX_FAILURES,
    idempotency: 'natural',
    // The `bulk` shard: the job is enqueued by the billing webhook slice (as
    // account deletion enqueues media.reclaimUser.v1 on bulk), and the jobs
    // integration harness reserves the `default` shard for committed rows to
    // pass.integration alone. The post-commit `bulk` wake keeps it prompt.
    shard: 'bulk',
    handler: async (execution): Promise<JobOutcome> => {
      const { userId } = execution.payload;
      const revoked = await revokeAllSessions(deps.redis, userId, now());
      if (revoked.isErr()) return jobOutcome.fail(revoked.error.code);
      // Best-effort promptness (never fails the must-happen job — the Result
      // always resolves ok); the watermark bump above is the correctness cutoff
      // the broadcast backstop reads.
      await evictUserBestEffort(deps.evictUser, userId).unwrapOr(null);
      return jobOutcome.ok({ revoked: userId });
    },
  };
}
