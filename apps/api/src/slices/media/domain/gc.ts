import { DEADLINE_CLASS_MS } from '@hushbox/shared';
import { SERVICE_NAMES, recordServiceEvidence } from '@hushbox/db';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { INPUTS_PREFIX, INPUTS_STAGING_TTL_SECONDS, MEDIA_PREFIX } from '../ports/index.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { MediaReferenceReader, Storage } from '../ports/index.js';

/**
 * R2 garbage collection: the one reclaim mechanism for storage debris, made
 * recoverable by lazy re-runs (cron hosts the trigger; a missed pass only
 * delays reclamation). Every delete is naturally idempotent and there are no
 * DB writes, so a pass killed at any point leaves nothing to clean up.
 */

/** Safety margin on top of the longest flow deadline. */
export const MEDIA_GC_GRACE_MARGIN_SECONDS = 900;

/**
 * GC never deletes an object younger than the longest flow deadline plus the
 * margin. Without the grace, the orphan sweep can delete a just-uploaded
 * object whose finalize transaction has not committed yet — a billed message
 * with permanently missing media, breaking persisted ⟺ billed in effect.
 * Derived from the deadline table so a longer deadline class widens the
 * grace automatically.
 */
export const MEDIA_GC_MIN_AGE_SECONDS =
  Math.max(...Object.values(DEADLINE_CLASS_MS)) / 1000 + MEDIA_GC_GRACE_MARGIN_SECONDS;

/**
 * Soft runtime budget for a GC pass. The Workers `cpu_ms` ceiling is 30s and GC
 * shares that isolate with the other hourly cron auditors (ledger-conservation +
 * snapshot-drift) run together under one `Promise.all`, so the sweep bails at
 * 15s — a DELIBERATE shared-isolate margin that leaves ~15s of the 30s window
 * for the co-runners, not strict legacy parity. Legacy's 25s assumed GC owned
 * the isolate; here it does not. The bail still leaves headroom to record
 * evidence and return, and lets the next hourly pass reclaim the rest. A killed
 * pass leaves nothing to clean up (deletes are idempotent, no DB writes), so an
 * early bail is always safe; the danger it prevents is a `cpu_ms` kill mid-sweep
 * every hour, making zero forward progress forever.
 */
export const MEDIA_GC_MAX_RUNTIME_MS = 15_000;

export interface MediaGcDeps {
  readonly storage: Storage;
  readonly references: MediaReferenceReader;
  readonly now: () => Date;
  /**
   * Evidence writes go through `recordServiceEvidence` (CI-only inside): a
   * completed pass records an `r2-gc` row so CI's `verify:evidence` step can
   * prove the real reclaim seam ran.
   */
  readonly db: Database;
  readonly isCI: boolean;
  /**
   * Sink for per-delete failures. Each failed R2 delete is isolated (the pass
   * continues and later sweeps still run) and reported here as a Sentry
   * capture, so debris left behind is visible rather than silent. Best-effort
   * by the Telemetry contract; `productionMediaGcDeps` always wires it.
   */
  readonly telemetry?: Pick<Telemetry, 'captureError'>;
  /** Listing page size override; the adapter default applies when omitted. */
  readonly pageSize?: number;
}

export interface MediaGcReport {
  readonly mediaScanned: number;
  readonly mediaReclaimed: number;
  readonly stagingScanned: number;
  readonly stagingReclaimed: number;
  /** Wall-clock duration of the pass, measured off the injected `now()`. */
  readonly durationMs: number;
  /** True when the pass bailed at the soft runtime budget before finishing. */
  readonly partialCompletion: boolean;
}

interface SweepTally {
  readonly scanned: number;
  readonly reclaimed: number;
  readonly partialCompletion: boolean;
}

/** The recursion-invariant inputs to a sweep — only cursor and tally change. */
interface SweepContext {
  readonly deps: MediaGcDeps;
  readonly plan: SweepPlan;
  /** Pass start instant (off `deps.now()`) that the soft budget measures from. */
  readonly startedAt: number;
}

interface SweepPlan {
  readonly prefix: string;
  readonly minAgeSeconds: number;
  /** Of the age-expired keys, the subset this sweep may delete. */
  reclaimable(keys: readonly string[]): ResultAsync<readonly string[], DomainError>;
}

/**
 * One full pass: the media/ orphan sweep (age-expired keys no live content
 * item references), then the inputs/ staging sweep (crashed uploads past the
 * staging TTL — a live run's inputs are covered because the TTL exceeds the
 * longest deadline plus margin).
 */
export function runMediaGc(deps: MediaGcDeps): ResultAsync<MediaGcReport, DomainError> {
  const orphanSweep: SweepPlan = {
    prefix: MEDIA_PREFIX,
    minAgeSeconds: MEDIA_GC_MIN_AGE_SECONDS,
    reclaimable: (keys) =>
      deps.references
        .referencedStorageKeys(keys)
        .map((referenced) => keys.filter((key) => !referenced.has(key))),
  };
  const stagingSweep: SweepPlan = {
    prefix: INPUTS_PREFIX,
    minAgeSeconds: INPUTS_STAGING_TTL_SECONDS,
    reclaimable: (keys) => okAsync(keys),
  };
  const startedAt = deps.now().getTime();
  const initial: SweepTally = { scanned: 0, reclaimed: 0, partialCompletion: false };
  return sweep({ deps, plan: orphanSweep, startedAt }, undefined, initial)
    .andThen((media) =>
      sweep({ deps, plan: stagingSweep, startedAt }, undefined, initial).map((staging) => ({
        mediaScanned: media.scanned,
        mediaReclaimed: media.reclaimed,
        stagingScanned: staging.scanned,
        stagingReclaimed: staging.reclaimed,
        durationMs: deps.now().getTime() - startedAt,
        partialCompletion: media.partialCompletion || staging.partialCompletion,
      }))
    )
    .andThen((report) =>
      // Evidence records on every pass — partial or complete (a no-op outside
      // CI) — carrying `partialCompletion` so a budget-bailed pass surfaces as
      // a flagged pile-up rather than a withheld row.
      fromPromise(
        recordServiceEvidence(deps.db, deps.isCI, SERVICE_NAMES.R2_GC, {
          mediaScanned: report.mediaScanned,
          mediaReclaimed: report.mediaReclaimed,
          stagingScanned: report.stagingScanned,
          stagingReclaimed: report.stagingReclaimed,
          durationMs: report.durationMs,
          partialCompletion: report.partialCompletion,
        }),
        (cause) => unavailableError('service-evidence write failed', cause)
      ).map(() => report)
    );
}

function sweep(
  ctx: SweepContext,
  cursor: string | undefined,
  tally: SweepTally
): ResultAsync<SweepTally, DomainError> {
  const { deps, plan, startedAt } = ctx;
  // Soft-budget bail before each page fetch: a pass that would run past the
  // runtime budget stops and reports a partial completion, so a `cpu_ms` kill
  // can never leave the hourly sweep making zero forward progress.
  if (deps.now().getTime() - startedAt > MEDIA_GC_MAX_RUNTIME_MS) {
    return okAsync({ ...tally, partialCompletion: true });
  }
  const options = {
    ...(cursor === undefined ? {} : { cursor }),
    ...(deps.pageSize === undefined ? {} : { limit: deps.pageSize }),
  };
  return deps.storage.list(plan.prefix, options).andThen((page) => {
    const nowMs = deps.now().getTime();
    const expired = page.objects
      .filter((object) => object.uploaded.getTime() + plan.minAgeSeconds * 1000 <= nowMs)
      .map((object) => object.key);
    return reclaim(deps, plan, expired).andThen((reclaimed) => {
      const next: SweepTally = {
        scanned: tally.scanned + page.objects.length,
        reclaimed: tally.reclaimed + reclaimed,
        partialCompletion: false,
      };
      return page.nextCursor === undefined ? okAsync(next) : sweep(ctx, page.nextCursor, next);
    });
  });
}

function reclaim(
  deps: MediaGcDeps,
  plan: SweepPlan,
  expired: readonly string[]
): ResultAsync<number, DomainError> {
  if (expired.length === 0) return okAsync(0);
  return plan.reclaimable(expired).andThen((keys) => deleteIsolated(deps, keys));
}

/**
 * GC deletes run one at a time (sweeps execute inside a single invocation and
 * the platform caps simultaneous outbound connections, so a parallel batch
 * would only queue at the socket layer while risking the cap) and each is
 * failure-isolated: a delete that errors is captured to telemetry and skipped,
 * never aborting the pass. GC is a lazy backstop, so one unreachable object
 * must not strand every later key or the second sweep — auditors detect, the
 * next pass reclaims. Only successful deletes count toward the tally.
 */
function deleteIsolated(
  deps: MediaGcDeps,
  keys: readonly string[]
): ResultAsync<number, DomainError> {
  let deleted = okAsync<number, DomainError>(0);
  for (const key of keys) {
    deleted = deleted.andThen((count) =>
      deps.storage
        .delete(key)
        .map(() => count + 1)
        .orElse((error) => {
          deps.telemetry?.captureError(
            new Error(error.code, { cause: error }),
            FINGERPRINT_CODES.mediaGcDeleteFailed
          );
          return okAsync<number, DomainError>(count);
        })
    );
  }
  return deleted;
}

/**
 * Deletes run one at a time (see {@link deleteIsolated} for the reasoning) and
 * fail-fast: the first errored delete aborts the chain and surfaces the error.
 * The deleted-account reclaim job depends on this fail-on-error contract to
 * return a retryable failure, so it is deliberately distinct from GC's
 * failure-isolated sweep.
 */
export function deleteSequentially(
  storage: Storage,
  keys: readonly string[]
): ResultAsync<number, DomainError> {
  let deleted = okAsync<number, DomainError>(0);
  for (const key of keys) {
    deleted = deleted.andThen((count) => storage.delete(key).map(() => count + 1));
  }
  return deleted;
}
