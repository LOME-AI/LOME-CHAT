import { z } from 'zod';
import { jobOutcome } from '../../../lib/jobs/index.js';
import { evictUserBestEffort, revokeAllSessions } from './session.js';
import type { JobOutcome, JobRegistration } from '../../../lib/jobs/index.js';
import type { EvictUserPort } from '../ports/index.js';
import type { RedisClient } from './keys.js';

/**
 * `session.revoke.v1` — the durable, trigger-neutral session revocation for a
 * userId. Its type name and handler are identity-owned (session revocation is
 * identity's concern); the enqueuers live in whatever slice needs a durable
 * revocation cutoff (billing's chargeback webhook, the admin containment ops).
 * The row is inserted in the enqueuer's settlement transaction, so the cutoff
 * can never be lost the way a swallowed post-commit best-effort bump was.
 */
export const SESSION_REVOKE_JOB_TYPE = 'session.revoke.v1';

/**
 * Failure budget before the dispatcher dead-letters the row. Only a transient
 * watermark-bump (Redis) failure consumes it; the eviction fan-out is
 * best-effort and never fails the job. A dead row is a jobs-health auditor page
 * — the must-happen guarantee the redesign puts under session revocation.
 */
export const SESSION_REVOKE_MAX_FAILURES = 10;

const sessionRevokePayloadSchema = z.object({ userId: z.uuid() });

export interface SessionRevokeJobDeps {
  readonly redis: RedisClient;
  /** Absent when the realtime binding is unavailable (degrades to no eviction). */
  readonly evictUser?: EvictUserPort;
  /** Injected for deterministic watermark assertions; defaults to wall clock. */
  readonly now?: () => number;
}

/**
 * The `session.revoke.v1` handler: the must-happen revocation for every session
 * of a userId, whatever triggered it (a chargeback lock, an admin containment
 * op). It bumps the all-session `passwordChangedAt` watermark — the SOLE cutoff
 * for a user's ALREADY-LIVE sessions and WS (a `users.lockedAt` gate only
 * blocks NEW logins) — then evicts live sockets best-effort. A transient bump
 * failure returns `fail` so the dispatcher retries within seconds, closing the
 * up-to-30-day window a lost bump would have left open.
 *
 * `natural` idempotency: re-running re-bumps the watermark to a fresh `now`,
 * which is idempotent in effect (a revoked account issues no sessions the later
 * watermark should spare, so it still stales exactly the sessions that must
 * die); the eviction is best-effort promptness, backstopped by the fail-closed
 * broadcast-time session-liveness check the watermark drives.
 */
export function createSessionRevokeJobRegistration(
  deps: SessionRevokeJobDeps
): JobRegistration<typeof sessionRevokePayloadSchema> {
  const now = deps.now ?? ((): number => Date.now());
  return {
    type: SESSION_REVOKE_JOB_TYPE,
    schema: sessionRevokePayloadSchema,
    leaseSeconds: 30,
    maxFailures: SESSION_REVOKE_MAX_FAILURES,
    idempotency: 'natural',
    // The `bulk` shard: the job is enqueued by slices that also enqueue other
    // bulk work (billing's chargeback webhook, account deletion's
    // media.reclaimUser.v1), and the jobs integration harness reserves the
    // `default` shard for committed rows to pass.integration alone. The
    // post-commit `bulk` wake keeps it prompt.
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
