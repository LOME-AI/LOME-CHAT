import { DEADLINE_CLASS_MS } from '@hushbox/shared';
import { SERVICE_NAMES, recordServiceEvidence } from '@hushbox/db';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { INPUTS_PREFIX, INPUTS_STAGING_TTL_SECONDS, MEDIA_PREFIX } from '../ports/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
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
  /** Listing page size override; the adapter default applies when omitted. */
  readonly pageSize?: number;
}

export interface MediaGcReport {
  readonly mediaScanned: number;
  readonly mediaReclaimed: number;
  readonly stagingScanned: number;
  readonly stagingReclaimed: number;
}

interface SweepTally {
  readonly scanned: number;
  readonly reclaimed: number;
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
  return sweep(deps, orphanSweep, undefined, { scanned: 0, reclaimed: 0 })
    .andThen((media) =>
      sweep(deps, stagingSweep, undefined, { scanned: 0, reclaimed: 0 }).map((staging) => ({
        mediaScanned: media.scanned,
        mediaReclaimed: media.reclaimed,
        stagingScanned: staging.scanned,
        stagingReclaimed: staging.reclaimed,
      }))
    )
    .andThen((report) =>
      // Records only after both sweeps complete (a no-op outside CI), so the
      // evidence row proves a full pass ran, never a partial one.
      fromPromise(recordServiceEvidence(deps.db, deps.isCI, SERVICE_NAMES.R2_GC), (cause) =>
        unavailableError('service-evidence write failed', cause)
      ).map(() => report)
    );
}

function sweep(
  deps: MediaGcDeps,
  plan: SweepPlan,
  cursor: string | undefined,
  tally: SweepTally
): ResultAsync<SweepTally, DomainError> {
  const options = {
    ...(cursor === undefined ? {} : { cursor }),
    ...(deps.pageSize === undefined ? {} : { limit: deps.pageSize }),
  };
  return deps.storage.list(plan.prefix, options).andThen((page) => {
    const nowMs = deps.now().getTime();
    const expired = page.objects
      .filter((object) => object.uploaded.getTime() + plan.minAgeSeconds * 1000 <= nowMs)
      .map((object) => object.key);
    return reclaim(deps.storage, plan, expired).andThen((reclaimed) => {
      const next: SweepTally = {
        scanned: tally.scanned + page.objects.length,
        reclaimed: tally.reclaimed + reclaimed,
      };
      return page.nextCursor === undefined
        ? okAsync(next)
        : sweep(deps, plan, page.nextCursor, next);
    });
  });
}

function reclaim(
  storage: Storage,
  plan: SweepPlan,
  expired: readonly string[]
): ResultAsync<number, DomainError> {
  if (expired.length === 0) return okAsync(0);
  return plan.reclaimable(expired).andThen((keys) => deleteSequentially(storage, keys));
}

/**
 * Deletes run one at a time: sweeps execute inside a single invocation, and
 * the platform caps simultaneous outbound connections, so a parallel batch
 * would only queue at the socket layer while risking the cap.
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
