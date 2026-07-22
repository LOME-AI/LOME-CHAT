import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { DEADLINE_CLASS_MS } from '@hushbox/shared';
import { LOCAL_NEON_DEV_CONFIG, SERVICE_NAMES, createDb, serviceEvidence } from '@hushbox/db';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import {
  INPUTS_STAGING_TTL_SECONDS,
  mediaObjectKey,
  stagingInputKey,
  stagingInputMetadata,
} from '../ports/index.js';
import { createScratchBucket } from '../adapters/test-fixtures.js';
import {
  MEDIA_GC_GRACE_MARGIN_SECONDS,
  MEDIA_GC_MAX_RUNTIME_MS,
  MEDIA_GC_MIN_AGE_SECONDS,
  runMediaGc,
} from './gc.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { ScratchBucket } from '../adapters/test-fixtures.js';
import type { MediaGcDeps } from './gc.js';
import type { MediaReferenceReader, Storage } from '../ports/index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for GC integration tests — run via pnpm test:api`);
  }
  return value;
}

const db = createDb(requireEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

afterAll(async () => {
  await db.$client.end();
});

async function countGcEvidence(): Promise<number> {
  const rows = await db
    .select()
    .from(serviceEvidence)
    .where(eq(serviceEvidence.service, SERVICE_NAMES.R2_GC));
  return rows.length;
}

async function latestGcEvidenceDetails(): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(serviceEvidence)
    .where(eq(serviceEvidence.service, SERVICE_NAMES.R2_GC))
    .orderBy(desc(serviceEvidence.createdAt))
    .limit(1);
  return (rows[0]?.details ?? null) as Record<string, unknown> | null;
}

/**
 * GC against a scratch MinIO bucket (isolated per test file so age-based
 * sweeps can never touch objects owned by other suites or concurrent runs).
 * The reference reader is a fake of this slice's own port interface; the
 * storage adapter and every delete are real.
 */

const OCTET_STREAM = 'application/octet-stream';
const BYTES = new Uint8Array([1, 2, 3, 4]);

function newMediaKey(): string {
  return mediaObjectKey({
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    objectId: crypto.randomUUID(),
  });
}

function referencesOf(referenced: readonly string[]): MediaReferenceReader {
  const set = new Set(referenced);
  return {
    referencedStorageKeys: (keys) => okAsync(new Set(keys.filter((key) => set.has(key)))),
  };
}

/** A clock far enough ahead that every object in the bucket is past the grace. */
function afterGrace(): () => Date {
  const graceMs = (MEDIA_GC_MIN_AGE_SECONDS + 60) * 1000;
  return () => new Date(Date.now() + graceMs);
}

function afterStagingTtl(): () => Date {
  const ttlMs = (INPUTS_STAGING_TTL_SECONDS + 60) * 1000;
  return () => new Date(Date.now() + ttlMs);
}

/**
 * Mock clock whose first read (the `startedAt` capture) sits at the base
 * instant and every later read sits a full runtime budget past it — so the
 * first per-page budget check trips and the sweep bails before listing.
 */
function budgetExceededClock(): () => Date {
  const base = Date.now();
  let calls = 0;
  return () => new Date(calls++ === 0 ? base : base + MEDIA_GC_MAX_RUNTIME_MS + 1000);
}

/**
 * Mock clock parked far past the grace period (so orphans are reclaimable)
 * that advances only a few ms per read — always well under the runtime budget,
 * so no bail fires and `durationMs` is a small positive number.
 */
function withinBudgetClock(): () => Date {
  const base = Date.now() + (MEDIA_GC_MIN_AGE_SECONDS + 60) * 1000;
  let calls = 0;
  return () => new Date(base + 10 * calls++);
}

describe('media GC constants', () => {
  it('grace period covers the longest flow deadline plus the margin', () => {
    const maxDeadlineSeconds = Math.max(...Object.values(DEADLINE_CLASS_MS)) / 1000;
    expect(MEDIA_GC_MIN_AGE_SECONDS).toBeGreaterThanOrEqual(
      maxDeadlineSeconds + MEDIA_GC_GRACE_MARGIN_SECONDS
    );
  });

  it('staging TTL exceeds the grace period so live-run inputs are never reclaimed first', () => {
    expect(INPUTS_STAGING_TTL_SECONDS).toBeGreaterThanOrEqual(MEDIA_GC_MIN_AGE_SECONDS);
  });

  it('soft runtime budget is the shared-isolate margin of 15s (below legacy 25s, which assumed sole isolate ownership)', () => {
    expect(MEDIA_GC_MAX_RUNTIME_MS).toBe(15_000);
  });
});

describe('media GC against MinIO', () => {
  let scratch: ScratchBucket;

  // A fresh bucket per test: age-based sweeps reclaim everything eligible in
  // the bucket, so shared state would leak earlier tests' survivors into
  // later tests' exact counts.
  beforeEach(async () => {
    scratch = await createScratchBucket();
  });

  afterEach(async () => {
    await scratch.destroy();
  });

  // isCI: false by default so the evidence write no-ops (the db is untouched);
  // the evidence tests below override isCI: true with the real handle.
  function deps(overrides: Partial<MediaGcDeps>): MediaGcDeps {
    return {
      storage: scratch.storage,
      references: referencesOf([]),
      now: () => new Date(),
      db,
      isCI: false,
      ...overrides,
    };
  }

  async function put(key: string): Promise<void> {
    const metadata = key.startsWith('inputs/')
      ? stagingInputMetadata({
          runId: key.split('/')[1] ?? '',
          objectId: key.split('/')[2] ?? '',
        })
      : undefined;
    const result = await scratch.storage.put(key, BYTES, {
      contentType: OCTET_STREAM,
      ...(metadata === undefined ? {} : { metadata }),
    });
    result._unsafeUnwrap();
  }

  async function exists(key: string): Promise<boolean> {
    const stat = await scratch.storage.head(key);
    return stat._unsafeUnwrap() !== null;
  }

  it('reclaims an orphaned media object once it is past the grace period', async () => {
    const orphan = newMediaKey();
    await put(orphan);

    const report = await runMediaGc(deps({ now: afterGrace() }));

    expect(report._unsafeUnwrap().mediaReclaimed).toBe(1);
    expect(await exists(orphan)).toBe(false);
  });

  it('a just-uploaded object survives a GC pass that runs before its finalize commits', async () => {
    const inFlight = newMediaKey();
    await put(inFlight);

    const report = await runMediaGc(deps({}));

    expect(report._unsafeUnwrap().mediaReclaimed).toBe(0);
    expect(await exists(inFlight)).toBe(true);
  });

  it('a referenced media object past the grace period survives', async () => {
    const referenced = newMediaKey();
    await put(referenced);

    const report = await runMediaGc(
      deps({ references: referencesOf([referenced]), now: afterGrace() })
    );

    expect(report._unsafeUnwrap().mediaReclaimed).toBe(0);
    expect(await exists(referenced)).toBe(true);
  });

  it("reclaims a deleted account's group-conversation media on the next GC run", async () => {
    // Hard deletion cascades the content rows at commit, so the group
    // conversation's objects answer as unreferenced here; the next pass
    // (past grace) reclaims the ciphertext.
    const groupObjects = [newMediaKey(), newMediaKey()];
    for (const key of groupObjects) await put(key);

    const report = await runMediaGc(deps({ now: afterGrace() }));

    expect(report._unsafeUnwrap().mediaReclaimed).toBe(2);
    expect(await exists(groupObjects[0] ?? '')).toBe(false);
    expect(await exists(groupObjects[1] ?? '')).toBe(false);
  });

  it("reclaims a crashed upload's staging object once past the staging TTL", async () => {
    const crashed = stagingInputKey({
      runId: crypto.randomUUID(),
      objectId: crypto.randomUUID(),
    });
    await put(crashed);

    const report = await runMediaGc(deps({ now: afterStagingTtl() }));

    expect(report._unsafeUnwrap().stagingReclaimed).toBe(1);
    expect(await exists(crashed)).toBe(false);
  });

  it('a staging object inside the staging TTL survives', async () => {
    const live = stagingInputKey({
      runId: crypto.randomUUID(),
      objectId: crypto.randomUUID(),
    });
    await put(live);

    const report = await runMediaGc(deps({}));

    expect(report._unsafeUnwrap().stagingReclaimed).toBe(0);
    expect(await exists(live)).toBe(true);
  });

  it('walks every listing page when the sweep spans multiple pages', async () => {
    const orphans = [newMediaKey(), newMediaKey(), newMediaKey()];
    for (const key of orphans) await put(key);

    const report = await runMediaGc(deps({ now: afterGrace(), pageSize: 1 }));

    const unwrapped = report._unsafeUnwrap();
    expect(unwrapped.mediaScanned).toBe(3);
    expect(unwrapped.mediaReclaimed).toBe(3);
    for (const key of orphans) {
      expect(await exists(key)).toBe(false);
    }
  });

  it('reports scanned counts alongside reclaimed counts', async () => {
    const referenced = newMediaKey();
    const orphan = newMediaKey();
    await put(referenced);
    await put(orphan);

    const report = await runMediaGc(
      deps({ references: referencesOf([referenced]), now: afterGrace() })
    );

    const unwrapped = report._unsafeUnwrap();
    expect(unwrapped.mediaScanned).toBe(2);
    expect(unwrapped.mediaReclaimed).toBe(1);
  });

  it('isolates a failed delete: remaining keys are still swept, the staging sweep still runs, and one capture fires per failure', async () => {
    // One media orphan whose delete errors, one that succeeds, plus a staging
    // object — all past their age gates. A per-delete failure must not abort
    // the pass: the surviving orphan and the staging object are still reclaimed.
    const failingKey = newMediaKey();
    const survivingKey = newMediaKey();
    const staging = stagingInputKey({
      runId: crypto.randomUUID(),
      objectId: crypto.randomUUID(),
    });
    await put(failingKey);
    await put(survivingKey);
    await put(staging);

    const capturedCodes: string[] = [];
    const telemetry: Pick<Telemetry, 'captureError'> = {
      captureError: (_error, errorCode) => {
        capturedCodes.push(errorCode);
      },
    };
    const flakyDelete: Storage = {
      ...scratch.storage,
      delete: (key) =>
        key === failingKey
          ? errAsync(unavailableError('delete blew up'))
          : scratch.storage.delete(key),
    };

    const report = await runMediaGc(
      deps({ storage: flakyDelete, telemetry, now: afterStagingTtl() })
    );

    const unwrapped = report._unsafeUnwrap();
    // The pass did not abort; the successful media orphan and the staging
    // object were reclaimed, the failing one survives.
    expect(unwrapped.mediaReclaimed).toBe(1);
    expect(unwrapped.stagingReclaimed).toBe(1);
    expect(await exists(failingKey)).toBe(true);
    expect(await exists(survivingKey)).toBe(false);
    expect(await exists(staging)).toBe(false);
    // Exactly one capture, carrying the GC delete-failure code.
    expect(capturedCodes).toEqual(['media_gc_delete_failed']);
  });

  it('bails with partialCompletion when a page-fetch would exceed the runtime budget', async () => {
    const orphan = newMediaKey();
    await put(orphan);

    const report = await runMediaGc(deps({ now: budgetExceededClock() }));

    const unwrapped = report._unsafeUnwrap();
    expect(unwrapped.partialCompletion).toBe(true);
    expect(unwrapped.mediaReclaimed).toBe(0);
    // Bailed before listing — the orphan is untouched for the next hourly pass.
    expect(await exists(orphan)).toBe(true);
  });

  it('records evidence flagged partialCompletion on a budget-bailed pass', async () => {
    const before = await countGcEvidence();

    const report = await runMediaGc(deps({ isCI: true, now: budgetExceededClock() }));

    expect(report._unsafeUnwrap().partialCompletion).toBe(true);
    // Evidence still lands on a partial pass, flagged so dashboards see pile-ups.
    expect(await countGcEvidence()).toBeGreaterThan(before);
    expect(await latestGcEvidenceDetails()).toMatchObject({ partialCompletion: true });
  });

  it('reports a complete pass with a populated durationMs when within the runtime budget', async () => {
    const orphan = newMediaKey();
    await put(orphan);

    const report = await runMediaGc(deps({ now: withinBudgetClock() }));

    const unwrapped = report._unsafeUnwrap();
    expect(unwrapped.partialCompletion).toBe(false);
    expect(unwrapped.durationMs).toBeGreaterThan(0);
    expect(unwrapped.mediaReclaimed).toBe(1);
    expect(await exists(orphan)).toBe(false);
  });

  it('records an r2-gc evidence row after a completed pass when isCI is true', async () => {
    const before = await countGcEvidence();

    const report = await runMediaGc(deps({ isCI: true }));

    expect(report.isOk()).toBe(true);
    // Append-only table: the completed pass's write lands, so the count grows.
    expect(await countGcEvidence()).toBeGreaterThan(before);
  });

  it('records no r2-gc evidence when isCI is false', async () => {
    const before = await countGcEvidence();

    const report = await runMediaGc(deps({}));

    expect(report.isOk()).toBe(true);
    expect(await countGcEvidence()).toBe(before);
  });

  it('maps a service-evidence write failure to unavailable', async () => {
    const poisonDb = {
      insert: () => {
        throw new Error('evidence insert exploded');
      },
    } as unknown as Database;

    const report = await runMediaGc(deps({ isCI: true, db: poisonDb }));

    expect(report._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
