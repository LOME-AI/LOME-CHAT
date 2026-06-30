import { inArray } from 'drizzle-orm';
import {
  contentItems,
  recordServiceEvidence,
  SERVICE_NAMES,
  type Database,
  type EvidenceConfig,
} from '@hushbox/db';
import type { MediaStorage } from '../storage/index.js';

const DEFAULT_PREFIX = 'media/';
const DEFAULT_CUTOFF_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;

/**
 * Number of deletes to fan out in parallel per chunk. Cloudflare Workers cap
 * concurrent fetches per invocation; 50 fits comfortably under that limit
 * while reclaiming time vs. fully-sequential awaits.
 */
const GC_DELETE_BATCH_SIZE = 50;

/**
 * Soft runtime budget for the cron handler. The Workers `cpu_ms` ceiling is
 * 30s; we bail at 25s so we have headroom to record evidence and return
 * stats. Partial completion is recorded so dashboards can flag pile-ups.
 */
const MAX_GC_RUNTIME_MS = 25_000;

export interface RunR2GcInput {
  storage: MediaStorage;
  db: Database;
  now: number;
  prefix?: string;
  cutoffMs?: number;
  batchSize?: number;
  /**
   * Optional evidence config. When supplied, a successful GC run records
   * `SERVICE_NAMES.R2_GC` so CI's verify:evidence step can prove the cron's
   * code path executed. `recordServiceEvidence` gates on `isCI === true`, so
   * production runs stay a no-op even when this is passed.
   */
  evidence?: EvidenceConfig;
}

export interface R2GcStats {
  scanned: number;
  orphansFound: number;
  deleted: number;
  bytesReclaimed: number;
  durationMs: number;
  /** True when the run exited early because MAX_GC_RUNTIME_MS elapsed. */
  partialCompletion: boolean;
}

interface PageStats {
  orphansFound: number;
  deleted: number;
  bytesReclaimed: number;
}

async function findOrphans(
  db: Database,
  eligible: { key: string; uploaded: Date; size: number }[]
): Promise<{ key: string; size: number }[]> {
  if (eligible.length === 0) return [];
  const eligibleKeys = eligible.map((o) => o.key);
  const rows = await db
    .select({ key: contentItems.storageKey })
    .from(contentItems)
    .where(inArray(contentItems.storageKey, eligibleKeys));
  const knownKeys = new Set(rows.map((r) => r.key));
  return eligible.filter((o) => !knownKeys.has(o.key));
}

async function deleteOrphans(
  storage: MediaStorage,
  orphans: { key: string; size: number }[]
): Promise<{ deleted: number; bytesReclaimed: number }> {
  let deleted = 0;
  let bytesReclaimed = 0;
  // Chunk the deletes and fan out in parallel via Promise.allSettled so a
  // single rejection inside the chunk does not abort the rest of the batch.
  // Sequential awaits exceed the 30s cpu_ms budget at scale.
  for (let index = 0; index < orphans.length; index += GC_DELETE_BATCH_SIZE) {
    const chunk = orphans.slice(index, index + GC_DELETE_BATCH_SIZE);
    const results = await Promise.allSettled(chunk.map((o) => storage.delete(o.key)));
    for (const [chunkIndex, result] of results.entries()) {
      const orphan = chunk[chunkIndex];
      if (orphan === undefined) continue;
      if (result.status === 'fulfilled') {
        deleted += 1;
        bytesReclaimed += orphan.size;
      } else {
        const reason: unknown = result.reason;
        console.error('r2-gc delete failed', { key: orphan.key, error: reason });
      }
    }
  }
  return { deleted, bytesReclaimed };
}

async function processPage(
  input: RunR2GcInput,
  cutoffMs: number,
  page: Awaited<ReturnType<MediaStorage['list']>>
): Promise<PageStats> {
  const eligible = page.objects.filter((o) => input.now - o.uploaded.getTime() > cutoffMs);
  const orphans = await findOrphans(input.db, eligible);
  const { deleted, bytesReclaimed } = await deleteOrphans(input.storage, orphans);
  return { orphansFound: orphans.length, deleted, bytesReclaimed };
}

/**
 * Daily GC of orphaned R2 media objects. Lists every object under `media/`,
 * filters to those uploaded more than 24h ago (cutoff configurable), looks
 * each batch up in `content_items.storage_key`, and deletes any object that
 * no DB row references.
 *
 * The 24h cutoff protects in-flight uploads — an object that was just
 * written but whose DB transaction hasn't committed yet must not be deleted.
 *
 * Errors on individual deletes are logged and the loop continues; errors
 * during list (the loop's outer call) abort the run and propagate.
 */
export async function runR2Gc(input: RunR2GcInput): Promise<R2GcStats> {
  const prefix = input.prefix ?? DEFAULT_PREFIX;
  const cutoffMs = input.cutoffMs ?? DEFAULT_CUTOFF_MS;
  const limit = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const startedAt = Date.now();

  let scanned = 0;
  let orphansFound = 0;
  let deleted = 0;
  let bytesReclaimed = 0;
  let cursor: string | undefined;
  let partialCompletion = false;

  do {
    if (Date.now() - startedAt > MAX_GC_RUNTIME_MS) {
      // Soft budget tripped — bail before kicking off another list/delete
      // round and let the next cron run pick up the rest.
      partialCompletion = true;
      console.warn('r2-gc bailing early due to MAX_GC_RUNTIME_MS', {
        scanned,
        deleted,
        durationMs: Date.now() - startedAt,
      });
      break;
    }

    const page = await input.storage.list(prefix, {
      limit,
      ...(cursor !== undefined && { cursor }),
    });
    scanned += page.objects.length;

    const pageStats = await processPage(input, cutoffMs, page);
    orphansFound += pageStats.orphansFound;
    deleted += pageStats.deleted;
    bytesReclaimed += pageStats.bytesReclaimed;

    cursor = page.nextCursor;
  } while (cursor !== undefined);

  const stats: R2GcStats = {
    scanned,
    orphansFound,
    deleted,
    bytesReclaimed,
    durationMs: Date.now() - startedAt,
    partialCompletion,
  };

  if (input.evidence !== undefined) {
    // Persist run stats alongside the evidence row so dashboards can correlate
    // GC effectiveness over time without scraping logs. `partialCompletion`
    // is included so dashboards can flag pile-ups when the budget is tripped.
    await recordServiceEvidence(input.evidence.db, input.evidence.isCI, SERVICE_NAMES.R2_GC, {
      scanned: stats.scanned,
      orphansFound: stats.orphansFound,
      deleted: stats.deleted,
      bytesReclaimed: stats.bytesReclaimed,
      durationMs: stats.durationMs,
      partialCompletion: stats.partialCompletion,
    });
  }

  return stats;
}
