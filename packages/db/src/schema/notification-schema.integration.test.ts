import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { userFactory } from '../factories';
import { deviceTokens, notificationPreferences, users } from './index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

let db: Database;
const insertedUserIds: string[] = [];

async function insertUser(): Promise<string> {
  const [row] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  insertedUserIds.push(row.id);
  return row.id;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  // Deleting the user cascades its notification rows away, keeping reruns clean.
  for (const id of insertedUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await db.$client.end();
});

describe('notification_preferences table', () => {
  it('defaults every category on and quiet-hours off for a bare insert', async () => {
    const userId = await insertUser();
    const [row] = await db.insert(notificationPreferences).values({ userId }).returning();
    if (!row) throw new Error('preferences insert returned no row');
    expect(row.globalEnabled).toBe(true);
    expect(row.messages).toBe(true);
    expect(row.runCompletion).toBe(true);
    expect(row.membership).toBe(true);
    expect(row.quietHoursStartMinutes).toBeNull();
    expect(row.quietHoursEndMinutes).toBeNull();
    expect(row.timezone).toBeNull();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it('accepts a fully specified quiet-hours window with a timezone', async () => {
    const userId = await insertUser();
    const [row] = await db
      .insert(notificationPreferences)
      .values({
        userId,
        quietHoursStartMinutes: 1320,
        quietHoursEndMinutes: 420,
        timezone: 'America/New_York',
      })
      .returning();
    if (!row) throw new Error('preferences insert returned no row');
    expect(row.quietHoursStartMinutes).toBe(1320);
    expect(row.quietHoursEndMinutes).toBe(420);
    expect(row.timezone).toBe('America/New_York');
  });

  it('rejects one-sided quiet hours (start set, end null)', async () => {
    const userId = await insertUser();
    const error = await captureError(
      db.insert(notificationPreferences).values({ userId, quietHoursStartMinutes: 1320 })
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('rejects quiet hours without a timezone', async () => {
    const userId = await insertUser();
    const error = await captureError(
      db
        .insert(notificationPreferences)
        .values({ userId, quietHoursStartMinutes: 1320, quietHoursEndMinutes: 420 })
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('keeps at most one preferences row per user', async () => {
    const userId = await insertUser();
    await db.insert(notificationPreferences).values({ userId });
    const error = await captureError(db.insert(notificationPreferences).values({ userId }));
    expect(error).toBeInstanceOf(Error);
  });
});

describe('device_tokens web-push extension', () => {
  it('stores a web subscription with both encryption keys and stamps last_seen_at', async () => {
    const userId = await insertUser();
    const [row] = await db
      .insert(deviceTokens)
      .values({
        userId,
        token: `https://push.example/${userId}`,
        platform: 'web',
        p256dh: 'BExamplePublicKey',
        auth: 'authsecret16byte',
      })
      .returning();
    if (!row) throw new Error('device token insert returned no row');
    expect(row.platform).toBe('web');
    expect(row.p256dh).toBe('BExamplePublicKey');
    expect(row.auth).toBe('authsecret16byte');
    expect(row.lastSeenAt).toBeInstanceOf(Date);
  });

  it('stores a native token with null encryption keys', async () => {
    const userId = await insertUser();
    const [row] = await db
      .insert(deviceTokens)
      .values({ userId, token: `fcm-${userId}`, platform: 'android' })
      .returning();
    if (!row) throw new Error('device token insert returned no row');
    expect(row.platform).toBe('android');
    expect(row.p256dh).toBeNull();
    expect(row.auth).toBeNull();
  });

  it('rejects a web row missing its encryption keys', async () => {
    const userId = await insertUser();
    const error = await captureError(
      db
        .insert(deviceTokens)
        .values({ userId, token: `https://push.example/bad-${userId}`, platform: 'web' })
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('rejects a native row that carries encryption keys', async () => {
    const userId = await insertUser();
    const error = await captureError(
      db.insert(deviceTokens).values({
        userId,
        token: `fcm-bad-${userId}`,
        platform: 'ios',
        p256dh: 'BExamplePublicKey',
        auth: 'authsecret16byte',
      })
    );
    expect(error).toBeInstanceOf(Error);
  });
});
