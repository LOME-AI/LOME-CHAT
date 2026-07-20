import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const runR2GcMock = vi.fn();
vi.mock('./services/gc/r2-gc.js', () => ({
  runR2Gc: runR2GcMock,
}));

vi.mock('aws4fetch', () => ({
  AwsClient: class MockAwsClient {
    fetch = vi.fn();
    sign = vi.fn();
  },
}));

const { scheduledHandler } = await import('./scheduled.js');
const { createDb, LOCAL_NEON_DEV_CONFIG, accountDeletionEvents } = await import('@hushbox/db');
import type { Database } from '@hushbox/db';
import type { Bindings } from './types.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required for scheduled integration tests — run pnpm ensure-stack from the repo root'
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

const baseEnv: Bindings = {
  DATABASE_URL,
  APP_VERSION: '0.0.0',
  R2_S3_ENDPOINT: 'http://localhost:9000',
  R2_ACCESS_KEY_ID: 'minioadmin',
  R2_SECRET_ACCESS_KEY: 'minioadmin',
  R2_BUCKET_MEDIA: 'hushbox-media-dev',
};

const baseEvent = { cron: '0 3 * * *', scheduledTime: Date.now() };
const baseCtx = { waitUntil: vi.fn() };

describe('scheduledHandler integration (real Postgres)', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  beforeEach(async () => {
    await db.delete(accountDeletionEvents);
    runR2GcMock.mockReset();
    runR2GcMock.mockResolvedValue({
      scanned: 0,
      orphansFound: 0,
      deleted: 0,
      bytesReclaimed: 0,
      durationMs: 0,
      partialCompletion: false,
    });
  });

  afterAll(async () => {
    await db.delete(accountDeletionEvents);
  });

  it('purges account_deletion_events rows older than 90 days and keeps newer rows', async () => {
    const now = new Date();
    const [keepRow] = await db
      .insert(accountDeletionEvents)
      .values({ deletedAt: new Date(now.getTime() - 89 * DAY_MS) })
      .returning();
    const [expireRow] = await db
      .insert(accountDeletionEvents)
      .values({ deletedAt: new Date(now.getTime() - 91 * DAY_MS) })
      .returning();

    if (!keepRow || !expireRow) {
      throw new Error('Seed inserts failed');
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await scheduledHandler(baseEvent, baseEnv, baseCtx);

      const remaining = await db.select().from(accountDeletionEvents);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(keepRow.id);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
