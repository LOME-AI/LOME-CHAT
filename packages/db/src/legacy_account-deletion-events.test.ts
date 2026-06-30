import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { purgeExpiredDeletionEvents } from './legacy_account-deletion-events';
import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from './legacy_client';
import { accountDeletionEvents } from './schema/legacy_account-deletion-events';
import { users } from './schema/users';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DAY_MS = 24 * 60 * 60 * 1000;

describe('account_deletion_events', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  afterAll(async () => {
    await db.delete(accountDeletionEvents);
  });

  beforeEach(async () => {
    await db.delete(accountDeletionEvents);
  });

  describe('schema', () => {
    it('inserts a row with only defaults and populates id/deletedAt, leaving ipAddress and userAgent null', async () => {
      const before = new Date();
      const [row] = await db.insert(accountDeletionEvents).values({}).returning();
      const after = new Date();

      if (row === undefined) {
        throw new Error('Insert failed - no row returned');
      }

      expect(row.id).toMatch(UUIDV7_REGEX);
      expect(row.deletedAt).toBeInstanceOf(Date);
      expect(row.deletedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(row.deletedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
      expect(row.ipAddress).toBeNull();
      expect(row.userAgent).toBeNull();
    });

    it('round-trips explicit ipAddress and userAgent', async () => {
      const [row] = await db
        .insert(accountDeletionEvents)
        .values({
          ipAddress: '198.51.100.42',
          userAgent: 'Mozilla/5.0 (test)',
        })
        .returning();

      if (row === undefined) {
        throw new Error('Insert failed - no row returned');
      }

      expect(row.ipAddress).toBe('198.51.100.42');
      expect(row.userAgent).toBe('Mozilla/5.0 (test)');
    });
  });

  describe('purgeExpiredDeletionEvents', () => {
    it('removes only rows older than the cutoff', async () => {
      const now = new Date('2026-04-01T00:00:00Z');

      await db.insert(accountDeletionEvents).values({
        deletedAt: new Date(now.getTime() - 91 * DAY_MS),
      });
      const [keepRow] = await db
        .insert(accountDeletionEvents)
        .values({
          deletedAt: new Date(now.getTime() - 89 * DAY_MS),
        })
        .returning();

      if (keepRow === undefined) {
        throw new Error('Insert failed - no row returned');
      }

      const result = await purgeExpiredDeletionEvents(db, now);

      expect(result).toEqual({ purged: 1 });

      const remaining = await db.select().from(accountDeletionEvents);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(keepRow.id);
    });

    it('does not purge a row whose age equals retentionDays exactly (predicate is strict <)', async () => {
      const now = new Date('2026-04-01T00:00:00Z');

      const [row] = await db
        .insert(accountDeletionEvents)
        .values({
          deletedAt: new Date(now.getTime() - 90 * DAY_MS),
        })
        .returning();

      if (row === undefined) {
        throw new Error('Insert failed - no row returned');
      }

      const result = await purgeExpiredDeletionEvents(db, now, 90);

      expect(result).toEqual({ purged: 0 });

      const remaining = await db.select().from(accountDeletionEvents);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(row.id);
    });

    it('purges a row that is one millisecond older than retentionDays', async () => {
      const now = new Date('2026-04-01T00:00:00Z');

      await db.insert(accountDeletionEvents).values({
        deletedAt: new Date(now.getTime() - 90 * DAY_MS - 1),
      });

      const result = await purgeExpiredDeletionEvents(db, now, 90);

      expect(result).toEqual({ purged: 1 });

      const remaining = await db.select().from(accountDeletionEvents);
      expect(remaining).toHaveLength(0);
    });

    it('honors a custom retentionDays parameter', async () => {
      const now = new Date('2026-04-01T00:00:00Z');

      const [keepRow] = await db
        .insert(accountDeletionEvents)
        .values({
          deletedAt: new Date(now.getTime() - 30 * DAY_MS),
        })
        .returning();
      await db.insert(accountDeletionEvents).values({
        deletedAt: new Date(now.getTime() - 60 * DAY_MS),
      });
      await db.insert(accountDeletionEvents).values({
        deletedAt: new Date(now.getTime() - 100 * DAY_MS),
      });

      if (keepRow === undefined) {
        throw new Error('Insert failed - no row returned');
      }

      const result = await purgeExpiredDeletionEvents(db, now, 45);

      expect(result).toEqual({ purged: 2 });

      const remaining = await db.select().from(accountDeletionEvents);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(keepRow.id);
    });

    it('returns { purged: 0 } against an empty table', async () => {
      const now = new Date('2026-04-01T00:00:00Z');

      const result = await purgeExpiredDeletionEvents(db, now);

      expect(result).toEqual({ purged: 0 });
    });

    it('does not touch other tables', async () => {
      const now = new Date('2026-04-01T00:00:00Z');

      const userEmail = `account-deletion-events-test-${String(Date.now())}@example.com`;

      const [insertedUser] = await db
        .insert(users)
        .values({
          email: userEmail,
          username: `del_${String(Date.now()).slice(-10)}`,
          opaqueRegistration: new Uint8Array(64),
          publicKey: new Uint8Array(32),
          passwordWrappedPrivateKey: new Uint8Array(48),
          recoveryWrappedPrivateKey: new Uint8Array(48),
        })
        .returning();

      if (insertedUser === undefined) {
        throw new Error('User insert failed');
      }

      try {
        await db.insert(accountDeletionEvents).values({
          deletedAt: new Date(now.getTime() - 200 * DAY_MS),
        });

        const result = await purgeExpiredDeletionEvents(db, now);
        expect(result).toEqual({ purged: 1 });

        const remainingUsers = await db.select().from(users).where(eq(users.id, insertedUser.id));
        expect(remainingUsers).toHaveLength(1);
        expect(remainingUsers[0]?.email).toBe(userEmail);
      } finally {
        await db.delete(users).where(eq(users.id, insertedUser.id));
      }
    });
  });
});
