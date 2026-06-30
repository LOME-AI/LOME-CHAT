import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const recordEvidenceMock = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
vi.mock('@hushbox/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/db')>();
  return {
    ...actual,
    recordServiceEvidence: recordEvidenceMock,
  };
});

const { runR2Gc } = await import('./r2-gc.js');
const { SERVICE_NAMES } = await import('@hushbox/db');
import type { MediaStorage } from '../storage/index.js';

// Fixed clock baseline. `vi.setSystemTime` anchors Date.now() to this instant
// so `runR2Gc({ now: Date.now() })` and `vi.advanceTimersByTime(...)` work
// without hardcoding additional wall-clock strings.
const FIXED_NOW = new Date('2026-04-29T00:00:00.000Z');
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

interface ListPage {
  objects: { key: string; uploaded: Date; size: number }[];
  nextCursor?: string;
}

function stubStorage(pages: ListPage[]): {
  storage: MediaStorage;
  deleteCalls: string[];
  deleteRejectKeys: Set<string>;
} {
  const deleteCalls: string[] = [];
  const deleteRejectKeys = new Set<string>();
  let pageIndex = 0;
  const storage: MediaStorage = {
    put: vi.fn(),
    mintDownloadUrl: vi.fn(),
    list: vi.fn(() => {
      const page = pages[pageIndex] ?? { objects: [] };
      pageIndex += 1;
      return Promise.resolve(page);
    }),
    delete: vi.fn((key: string) => {
      deleteCalls.push(key);
      if (deleteRejectKeys.has(key)) {
        return Promise.reject(new Error(`fake delete failure for ${key}`));
      }
      return Promise.resolve();
    }),
  };
  return { storage, deleteCalls, deleteRejectKeys };
}

interface DbRow {
  key: string;
}

function stubDb(knownKeys: string[]): { db: never; selectCalls: number } {
  const knownSet = new Set(knownKeys);
  let selectCalls = 0;
  const where = (predicate: { lookup: string[] }): Promise<DbRow[]> => {
    selectCalls += 1;
    const matches = predicate.lookup.filter((k) => knownSet.has(k)).map((k) => ({ key: k }));
    return Promise.resolve(matches);
  };
  const fromBuilder = {
    where: (clause: { _: string; values: string[] }) => where({ lookup: clause.values }),
  };
  const selectBuilder = { from: () => fromBuilder };
  const db = {
    select: () => selectBuilder,
  } as unknown as never;
  return { db, selectCalls: () => selectCalls } as unknown as { db: never; selectCalls: number };
}

vi.mock(import('drizzle-orm'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    inArray: ((_col: unknown, values: string[]) => ({ _: 'inArray', values })) as never,
  };
});

describe('runR2Gc', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes orphans uploaded more than 24h ago', async () => {
    // Anchor uploads to the current fake clock. After advancing 25 hours, every
    // upload is older than the 24h cutoff.
    const { storage, deleteCalls } = stubStorage([
      {
        objects: [
          { key: 'media/known-old.enc', uploaded: new Date(Date.now()), size: 1000 },
          { key: 'media/orphan-old-1.enc', uploaded: new Date(Date.now()), size: 2000 },
          { key: 'media/orphan-old-2.enc', uploaded: new Date(Date.now()), size: 3000 },
        ],
      },
    ]);
    const dbHelper = stubDb(['media/known-old.enc']);

    vi.advanceTimersByTime(25 * ONE_HOUR_MS);
    const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

    expect(stats.scanned).toBe(3);
    expect(stats.orphansFound).toBe(2);
    expect(stats.deleted).toBe(2);
    expect(stats.bytesReclaimed).toBe(5000);
    expect(deleteCalls.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'media/orphan-old-1.enc',
      'media/orphan-old-2.enc',
    ]);
  });

  it('preserves objects uploaded less than 24h ago', async () => {
    // Recent upload anchored to the current fake clock; advance only 1 hour
    // so the cutoff hasn't elapsed.
    const { storage, deleteCalls } = stubStorage([
      {
        objects: [{ key: 'media/recent-orphan.enc', uploaded: new Date(Date.now()), size: 1000 }],
      },
    ]);
    const dbHelper = stubDb([]);

    vi.advanceTimersByTime(ONE_HOUR_MS);
    const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

    expect(stats.scanned).toBe(1);
    expect(stats.orphansFound).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it('paginates through multiple list calls via cursor', async () => {
    const oldUploadDate = new Date(Date.now()); // captured at fake-clock baseline
    const { storage } = stubStorage([
      {
        objects: [{ key: 'media/a.enc', uploaded: oldUploadDate, size: 100 }],
        nextCursor: 'cursor-1',
      },
      {
        objects: [{ key: 'media/b.enc', uploaded: oldUploadDate, size: 200 }],
        nextCursor: 'cursor-2',
      },
      {
        objects: [{ key: 'media/c.enc', uploaded: oldUploadDate, size: 300 }],
      },
    ]);
    const dbHelper = stubDb(['media/a.enc', 'media/b.enc', 'media/c.enc']);

    vi.advanceTimersByTime(25 * ONE_HOUR_MS);
    const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

    expect(stats.scanned).toBe(3);
    expect(stats.orphansFound).toBe(0);
    expect(storage.list).toHaveBeenCalledTimes(3);
  });

  it('handles empty bucket without errors', async () => {
    const { storage } = stubStorage([{ objects: [] }]);
    const dbHelper = stubDb([]);

    const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

    expect(stats).toEqual(expect.objectContaining({ scanned: 0, deleted: 0, bytesReclaimed: 0 }));
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('deletes all objects when DB has none', async () => {
    const oldUploadDate = new Date(Date.now()); // pre-advance
    const objects = Array.from({ length: 5 }, (_, index) => ({
      key: `media/orphan-${String(index)}.enc`,
      uploaded: oldUploadDate,
      size: 100,
    }));
    const { storage, deleteCalls } = stubStorage([{ objects }]);
    const dbHelper = stubDb([]);

    vi.advanceTimersByTime(25 * ONE_HOUR_MS);
    const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

    expect(stats.deleted).toBe(5);
    expect(deleteCalls).toHaveLength(5);
  });

  it('continues and logs after an individual delete failure', async () => {
    const oldUploadDate = new Date(Date.now()); // pre-advance
    const { storage, deleteCalls, deleteRejectKeys } = stubStorage([
      {
        objects: [
          { key: 'media/orphan-1.enc', uploaded: oldUploadDate, size: 100 },
          { key: 'media/orphan-2.enc', uploaded: oldUploadDate, size: 200 },
          { key: 'media/orphan-3.enc', uploaded: oldUploadDate, size: 300 },
        ],
      },
    ]);
    deleteRejectKeys.add('media/orphan-2.enc');
    const dbHelper = stubDb([]);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.advanceTimersByTime(25 * ONE_HOUR_MS);
      const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });
      expect(deleteCalls).toEqual([
        'media/orphan-1.enc',
        'media/orphan-2.enc',
        'media/orphan-3.enc',
      ]);
      expect(stats.deleted).toBe(2);
      expect(stats.bytesReclaimed).toBe(400);
      expect(errorSpy).toHaveBeenCalledWith('r2-gc delete failed', expect.any(Object));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns durationMs >= 0', async () => {
    const { storage } = stubStorage([{ objects: [] }]);
    const dbHelper = stubDb([]);

    const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes prefix and limit to storage.list', async () => {
    const { storage } = stubStorage([{ objects: [] }]);
    const dbHelper = stubDb([]);

    await runR2Gc({
      storage,
      db: dbHelper.db,
      now: Date.now(),
      prefix: 'custom-prefix/',
      batchSize: 250,
    });

    expect(storage.list).toHaveBeenCalledWith(
      'custom-prefix/',
      expect.objectContaining({ limit: 250 })
    );
  });

  it('uses cutoff exactly at the 24h boundary as still-recent', async () => {
    // Object uploaded at the fake clock anchor; advance time by exactly 24h.
    // The default cutoff is "more than 24h ago" — strict inequality, so
    // exactly 24h-old should NOT be deleted.
    const uploadedDate = new Date(Date.now());
    const { storage, deleteCalls } = stubStorage([
      {
        objects: [{ key: 'media/at-boundary.enc', uploaded: uploadedDate, size: 100 }],
      },
    ]);
    const dbHelper = stubDb([]);

    vi.advanceTimersByTime(ONE_DAY_MS);
    const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

    expect(stats.deleted).toBe(0);
    expect(deleteCalls).toHaveLength(0);
  });

  describe('parallel batching (CPU exhaustion mitigation)', () => {
    it('processes deletes in chunks of GC_DELETE_BATCH_SIZE in parallel', async () => {
      // 75 orphans → first batch of 50 fires before second batch of 25.
      const oldUploadDate = new Date(Date.now()); // pre-advance
      const objects = Array.from({ length: 75 }, (_, index) => ({
        key: `media/orphan-${String(index)}.enc`,
        uploaded: oldUploadDate,
        size: 10,
      }));
      let inFlight = 0;
      let maxInFlight = 0;
      const storage: MediaStorage = {
        put: vi.fn(),
        mintDownloadUrl: vi.fn(),
        list: vi.fn().mockResolvedValueOnce({ objects }),
        delete: vi.fn(async (_key: string) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
        }),
      };
      const dbHelper = stubDb([]);

      vi.advanceTimersByTime(25 * ONE_HOUR_MS);
      const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

      expect(stats.deleted).toBe(75);
      // Sequential implementation never exceeds 1 in-flight; parallel batched
      // implementation hits the batch size on the first chunk. Assert > 1 so
      // we don't over-couple to exact concurrency, then bound by batch size.
      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(50);
    });

    it('does not abort the batch when one delete in the chunk rejects', async () => {
      const oldUploadDate = new Date(Date.now());
      const objects = Array.from({ length: 5 }, (_, index) => ({
        key: `media/orphan-${String(index)}.enc`,
        uploaded: oldUploadDate,
        size: 10,
      }));
      const { storage, deleteCalls, deleteRejectKeys } = stubStorage([{ objects }]);
      deleteRejectKeys.add('media/orphan-2.enc');
      const dbHelper = stubDb([]);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        vi.advanceTimersByTime(25 * ONE_HOUR_MS);
        const stats = await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

        // All 5 deletes attempted, even though one rejects (Promise.allSettled).
        expect(deleteCalls).toHaveLength(5);
        expect(stats.deleted).toBe(4);
        expect(stats.bytesReclaimed).toBe(40);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('breaks early when MAX_GC_RUNTIME_MS elapses', async () => {
      // 4 list pages of 50 objects each. The fake-clock advance between
      // pages trips the time-elapsed check.
      const oldUploadDate = new Date(Date.now());
      const pages: ListPage[] = Array.from({ length: 4 }, (_, pageIndex) => {
        const base: ListPage = {
          objects: Array.from({ length: 50 }, (_, index) => ({
            key: `media/p${String(pageIndex)}-${String(index)}.enc`,
            uploaded: oldUploadDate,
            size: 1,
          })),
        };
        return pageIndex < 3 ? { ...base, nextCursor: `cursor-${String(pageIndex + 1)}` } : base;
      });
      // Replace `delete` with a call that advances the fake clock past the
      // 25s budget after the first batch resolves.
      const baseStub = stubStorage(pages);
      let pageIndexCallCount = 0;
      const trippingStorage: MediaStorage = {
        ...baseStub.storage,
        list: vi.fn(() => {
          pageIndexCallCount += 1;
          if (pageIndexCallCount === 2) {
            // After page 1 finished, jump past 25s before page 2's list call.
            vi.advanceTimersByTime(26_000);
          }
          const page = pages[pageIndexCallCount - 1] ?? { objects: [] };
          return Promise.resolve(page);
        }),
      };
      const dbHelper = stubDb([]);

      vi.advanceTimersByTime(25 * ONE_HOUR_MS);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const stats = await runR2Gc({ storage: trippingStorage, db: dbHelper.db, now: Date.now() });

        // List called fewer than 4 times because we bail.
        expect(pageIndexCallCount).toBeLessThan(4);
        expect(stats.partialCompletion).toBe(true);
        expect(stats.deleted).toBeLessThan(200);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('records partial-completion=true in evidence when GC bails early', async () => {
      recordEvidenceMock.mockClear();
      const oldUploadDate = new Date(Date.now());
      const pages: ListPage[] = Array.from({ length: 4 }, (_, pageIndex) => {
        const base: ListPage = {
          objects: Array.from({ length: 50 }, (_, index) => ({
            key: `media/p${String(pageIndex)}-${String(index)}.enc`,
            uploaded: oldUploadDate,
            size: 1,
          })),
        };
        return pageIndex < 3 ? { ...base, nextCursor: `cursor-${String(pageIndex + 1)}` } : base;
      });
      const baseStub = stubStorage(pages);
      let pageIndexCallCount = 0;
      const trippingStorage: MediaStorage = {
        ...baseStub.storage,
        list: vi.fn(() => {
          pageIndexCallCount += 1;
          if (pageIndexCallCount === 2) {
            vi.advanceTimersByTime(26_000);
          }
          const page = pages[pageIndexCallCount - 1] ?? { objects: [] };
          return Promise.resolve(page);
        }),
      };
      const dbHelper = stubDb([]);
      const fakeDb = { __fake: 'db' } as unknown as import('@hushbox/db').Database;

      vi.advanceTimersByTime(25 * ONE_HOUR_MS);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await runR2Gc({
          storage: trippingStorage,
          db: dbHelper.db,
          now: Date.now(),
          evidence: { db: fakeDb, isCI: true },
        });
        expect(recordEvidenceMock).toHaveBeenCalledWith(
          fakeDb,
          true,
          SERVICE_NAMES.R2_GC,
          expect.objectContaining({ partialCompletion: true })
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('evidence recording', () => {
    it('does not record evidence when no evidence config is supplied', async () => {
      recordEvidenceMock.mockClear();
      const { storage } = stubStorage([{ objects: [] }]);
      const dbHelper = stubDb([]);

      await runR2Gc({ storage, db: dbHelper.db, now: Date.now() });

      expect(recordEvidenceMock).not.toHaveBeenCalled();
    });

    it('records evidence at end of a successful run with stats payload', async () => {
      recordEvidenceMock.mockClear();
      const oldUploadDate = new Date(Date.now()); // pre-advance
      const { storage } = stubStorage([
        {
          objects: [
            { key: 'media/orphan-1.enc', uploaded: oldUploadDate, size: 100 },
            { key: 'media/orphan-2.enc', uploaded: oldUploadDate, size: 250 },
          ],
        },
      ]);
      const dbHelper = stubDb([]);
      const fakeDb = { __fake: 'db' } as unknown as import('@hushbox/db').Database;

      vi.advanceTimersByTime(25 * ONE_HOUR_MS);
      await runR2Gc({
        storage,
        db: dbHelper.db,
        now: Date.now(),
        evidence: { db: fakeDb, isCI: true },
      });

      expect(recordEvidenceMock).toHaveBeenCalledWith(
        fakeDb,
        true,
        SERVICE_NAMES.R2_GC,
        expect.objectContaining({
          scanned: 2,
          orphansFound: 2,
          deleted: 2,
          bytesReclaimed: 350,
          durationMs: expect.any(Number),
        })
      );
    });
  });
});
