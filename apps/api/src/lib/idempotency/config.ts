/**
 * Idempotency timing configuration. Deliberately code constants, not env
 * registry entries: these values are invariants of the state machine (a
 * per-environment override could silently break the TTL floor), and the env
 * registry carries per-mode values only.
 */

/**
 * Lease on a `kind=request` claim. A crash mid-request leaves the row
 * `claimed`; a retry may reclaim it only after this lease expires, so the
 * value bounds how long a client waits behind a dead executor. Request
 * handlers are short; 90 s is already generous.
 */
export const REQUEST_LEASE_SECONDS = 90;

/**
 * Lease on a `kind=run` claim. The live conversation executor
 * heartbeat-touches `claimedAt` on a short interval, so the lease stays
 * short regardless of run deadline — a deploy-killed run is retryable in
 * seconds, never deadline + grace.
 */
export const RUN_LEASE_SECONDS = 90;

/** The longest run deadline in the system (media runs). */
export const MAX_RUN_DEADLINE_SECONDS = 15 * 60;

/** Settlement/propagation grace beyond the run deadline. */
export const IDEMPOTENCY_GRACE_SECONDS = 60;

/**
 * How long after a failure the client may still auto-resubmit with the same
 * key. A purged `succeeded` row inside this horizon would turn a late
 * resubmit into a duplicate execution — hence the floor below.
 */
export const MAX_AUTO_RESUBMIT_HORIZON_SECONDS = 10 * 60;

/**
 * Terminal-row retention before the purge cron may delete. Mirrors the jobs
 * system's 7-day succeeded prune; the purge skips non-terminal rows and read
 * paths never depend on the purge having run.
 */
export const IDEMPOTENCY_PURGE_TTL_SECONDS = 7 * 24 * 3600;

export interface IdempotencyTtlConfig {
  readonly purgeTtlSeconds: number;
  readonly leaseSecondsByKind: { readonly request: number; readonly run: number };
  readonly maxRunDeadlineSeconds: number;
  readonly graceSeconds: number;
  readonly maxAutoResubmitHorizonSeconds: number;
}

export const IDEMPOTENCY_TTL_CONFIG: IdempotencyTtlConfig = {
  purgeTtlSeconds: IDEMPOTENCY_PURGE_TTL_SECONDS,
  leaseSecondsByKind: { request: REQUEST_LEASE_SECONDS, run: RUN_LEASE_SECONDS },
  maxRunDeadlineSeconds: MAX_RUN_DEADLINE_SECONDS,
  graceSeconds: IDEMPOTENCY_GRACE_SECONDS,
  maxAutoResubmitHorizonSeconds: MAX_AUTO_RESUBMIT_HORIZON_SECONDS,
};

/**
 * The TTL floor, asserted fail-fast: the purge TTL must exceed (a) every
 * lease — a purged live claim would un-serialize re-execution — and (b)
 * max run deadline + grace + the client's max auto-resubmit horizon — a
 * purged `succeeded` row would turn a late resubmit into a duplicate
 * execution.
 */
export function assertIdempotencyTtlFloor(config: IdempotencyTtlConfig): void {
  const values = [
    config.purgeTtlSeconds,
    config.leaseSecondsByKind.request,
    config.leaseSecondsByKind.run,
    config.maxRunDeadlineSeconds,
    config.graceSeconds,
    config.maxAutoResubmitHorizonSeconds,
  ];
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error('idempotency config: every duration must be a positive finite number');
  }
  const longestLease = Math.max(config.leaseSecondsByKind.request, config.leaseSecondsByKind.run);
  if (config.purgeTtlSeconds <= longestLease) {
    throw new Error(
      `idempotency config: purge TTL (${String(config.purgeTtlSeconds)}s) must exceed the longest lease (${String(longestLease)}s)`
    );
  }
  const replayFloor =
    config.maxRunDeadlineSeconds + config.graceSeconds + config.maxAutoResubmitHorizonSeconds;
  if (config.purgeTtlSeconds <= replayFloor) {
    throw new Error(
      `idempotency config: purge TTL (${String(config.purgeTtlSeconds)}s) must exceed run deadline + grace + resubmit horizon (${String(replayFloor)}s)`
    );
  }
}

// Startup fail-fast: importing any idempotency machinery with a broken
// timing configuration must die here, not misbehave at purge time.
assertIdempotencyTtlFloor(IDEMPOTENCY_TTL_CONFIG);
