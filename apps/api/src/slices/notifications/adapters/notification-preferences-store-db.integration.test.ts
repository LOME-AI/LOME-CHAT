import { describe, it, expect, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG, users } from '@hushbox/db';
import { placeholderBytes } from '@hushbox/db/factories';
import { createNotificationPreferencesStore } from './notification-preferences-store-db.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../ports/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { NotificationPreferences } from '../ports/index.js';

async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for notifications integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const store = createNotificationPreferencesStore(db);

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 13);
  const [row] = await db
    .insert(users)
    .values({
      email: `notif-prefs-${suffix}@test.hushbox.ai`,
      username: `np-${suffix}`,
      opaqueRegistration: placeholderBytes(32),
      publicKey: placeholderBytes(32),
      passwordWrappedPrivateKey: placeholderBytes(32),
      recoveryWrappedPrivateKey: placeholderBytes(32),
    })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  createdUserIds.push(row.id);
  return row.id;
}

const quietHours: NotificationPreferences = {
  globalEnabled: true,
  messages: false,
  runCompletion: true,
  membership: false,
  quietHoursStartMinutes: 22 * 60,
  quietHoursEndMinutes: 7 * 60,
  timezone: 'America/New_York',
};

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('createNotificationPreferencesStore', () => {
  it('reads null for a user with no row (lazy defaults)', async () => {
    const userId = await createUser();

    const result = await store.read(userId);

    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('round-trips a written preferences row', async () => {
    const userId = await createUser();
    await unwrap(store.upsert(userId, quietHours));

    const result = await store.read(userId);

    expect(result._unsafeUnwrap()).toEqual(quietHours);
  });

  it('converges a repeated upsert onto one updated row', async () => {
    const userId = await createUser();
    await unwrap(store.upsert(userId, DEFAULT_NOTIFICATION_PREFERENCES));

    await unwrap(store.upsert(userId, quietHours));

    expect(await unwrap(store.read(userId))).toEqual(quietHours);
  });

  it('reads only the requested users in a batch', async () => {
    const included = await createUser();
    const excluded = await createUser();
    const noRow = await createUser();
    await unwrap(store.upsert(included, quietHours));
    await unwrap(store.upsert(excluded, DEFAULT_NOTIFICATION_PREFERENCES));

    const result = await store.readForUsers([included, noRow]);

    const map = result._unsafeUnwrap();
    expect([...map.keys()]).toEqual([included]);
    expect(map.get(included)).toEqual(quietHours);
  });

  it('resolves an empty batch to an empty map', async () => {
    const result = await store.readForUsers([]);

    expect([...result._unsafeUnwrap()]).toEqual([]);
  });

  it('maps a read failure to an unavailable error', async () => {
    const result = await store.read('not-a-uuid');

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a batch lookup failure to an unavailable error', async () => {
    const result = await store.readForUsers(['not-a-uuid']);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps an upsert failure to an unavailable error', async () => {
    const result = await store.upsert(crypto.randomUUID(), DEFAULT_NOTIFICATION_PREFERENCES);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
