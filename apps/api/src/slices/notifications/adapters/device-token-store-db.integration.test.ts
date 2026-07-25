import { describe, it, expect, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, deviceTokens, LOCAL_NEON_DEV_CONFIG, users } from '@hushbox/db';
import { placeholderBytes } from '@hushbox/db/factories';
import { createDeviceTokenStore } from './device-token-store-db.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for notifications integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const store = createDeviceTokenStore(db);

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 13);
  const [row] = await db
    .insert(users)
    .values({
      email: `device-token-${suffix}@test.hushbox.ai`,
      username: `dt-${suffix}`,
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

function freshToken(): string {
  return `device-token-${crypto.randomUUID()}`;
}

async function seedToken(
  userId: string,
  token: string,
  platform: 'ios' | 'android' = 'ios'
): Promise<void> {
  const seeded = await store.upsert({ userId, token, platform });
  seeded._unsafeUnwrap();
}

async function tokenRows(token: string): Promise<{ userId: string; platform: string }[]> {
  return db
    .select({ userId: deviceTokens.userId, platform: deviceTokens.platform })
    .from(deviceTokens)
    .where(eq(deviceTokens.token, token));
}

/**
 * Old enough that a refresh is unambiguously observable, recent enough to stay
 * inside the device-token retention window: the daily retention pass commits a
 * real delete against this shared local database, and rows older than the
 * window are fair game for it while these tests are still asserting on them.
 */
const STALE_LAST_SEEN = new Date(Date.now() - 60 * 60 * 1000);

/** Ages a row so a refresh is observable without depending on clock resolution. */
async function makeStale(token: string): Promise<void> {
  await db
    .update(deviceTokens)
    .set({ lastSeenAt: STALE_LAST_SEEN })
    .where(eq(deviceTokens.token, token));
}

async function lastSeenAt(token: string): Promise<Date> {
  const [row] = await db
    .select({ lastSeenAt: deviceTokens.lastSeenAt })
    .from(deviceTokens)
    .where(eq(deviceTokens.token, token));
  if (row === undefined) throw new Error('no device_tokens row for token');
  return row.lastSeenAt;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // device_tokens rows cascade with their users.
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('createDeviceTokenStore', () => {
  describe('upsert', () => {
    it('creates the row on first registration', async () => {
      const userId = await createUser();
      const token = freshToken();

      const result = await store.upsert({ userId, token, platform: 'ios' });

      expect(result.isOk()).toBe(true);
      expect(await tokenRows(token)).toEqual([{ userId, platform: 'ios' }]);
    });

    it('converges a repeated registration onto one row', async () => {
      const userId = await createUser();
      const token = freshToken();
      await seedToken(userId, token);

      const second = await store.upsert({ userId, token, platform: 'ios' });

      expect(second.isOk()).toBe(true);
      expect(await tokenRows(token)).toHaveLength(1);
    });

    it('moves a re-registered token to its new owner', async () => {
      const firstUser = await createUser();
      const secondUser = await createUser();
      const token = freshToken();
      await seedToken(firstUser, token);

      await seedToken(secondUser, token, 'android');

      expect(await tokenRows(token)).toEqual([{ userId: secondUser, platform: 'android' }]);
    });

    it('refreshes lastSeenAt on a repeated registration', async () => {
      const userId = await createUser();
      const token = freshToken();
      await seedToken(userId, token);
      await makeStale(token);

      const second = await store.upsert({ userId, token, platform: 'ios' });

      expect(second.isOk()).toBe(true);
      const refreshed = await lastSeenAt(token);
      expect(refreshed.getTime()).toBeGreaterThan(STALE_LAST_SEEN.getTime());
    });

    it('maps a constraint failure to an unavailable error', async () => {
      const result = await store.upsert({
        userId: crypto.randomUUID(), // no such user — FK violation
        token: freshToken(),
        platform: 'ios',
      });

      expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    });
  });

  describe('touchLastSeen', () => {
    it('refreshes lastSeenAt for the delivered tokens', async () => {
      const userId = await createUser();
      const token = freshToken();
      await seedToken(userId, token);
      await makeStale(token);

      const result = await store.touchLastSeen([{ userId, token }]);

      expect(result.isOk()).toBe(true);
      const refreshed = await lastSeenAt(token);
      expect(refreshed.getTime()).toBeGreaterThan(STALE_LAST_SEEN.getTime());
    });

    it('leaves a token that was not delivered to untouched', async () => {
      const userId = await createUser();
      const delivered = freshToken();
      const untouched = freshToken();
      await seedToken(userId, delivered);
      await seedToken(userId, untouched);
      await makeStale(delivered);
      await makeStale(untouched);

      const result = await store.touchLastSeen([{ userId, token: delivered }]);

      expect(result.isOk()).toBe(true);
      expect(await lastSeenAt(untouched)).toEqual(STALE_LAST_SEEN);
    });

    it('never refreshes another user’s token', async () => {
      const owner = await createUser();
      const intruder = await createUser();
      const token = freshToken();
      await seedToken(owner, token);
      await makeStale(token);

      const result = await store.touchLastSeen([{ userId: intruder, token }]);

      expect(result.isOk()).toBe(true);
      expect(await lastSeenAt(token)).toEqual(STALE_LAST_SEEN);
    });

    it('resolves without a write for an empty ref list', async () => {
      const result = await store.touchLastSeen([]);

      expect(result.isOk()).toBe(true);
    });

    it('maps a touch failure to an unavailable error', async () => {
      // A non-uuid userId fails uuid input parsing inside Postgres.
      const result = await store.touchLastSeen([{ userId: 'not-a-uuid', token: freshToken() }]);

      expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    });
  });

  describe('deleteByToken', () => {
    it('deletes the row and resolves true', async () => {
      const userId = await createUser();
      const token = freshToken();
      await seedToken(userId, token, 'android');

      const result = await store.deleteByToken(userId, token);

      expect(result._unsafeUnwrap()).toBe(true);
      expect(await tokenRows(token)).toEqual([]);
    });

    it('resolves null when the token is already absent', async () => {
      const userId = await createUser();

      const result = await store.deleteByToken(userId, freshToken());

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('maps a delete failure to an unavailable error', async () => {
      // A non-uuid userId fails uuid input parsing inside Postgres.
      const result = await store.deleteByToken('not-a-uuid', freshToken());

      expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    });

    it('never deletes another user’s token', async () => {
      const owner = await createUser();
      const intruder = await createUser();
      const token = freshToken();
      await seedToken(owner, token);

      const result = await store.deleteByToken(intruder, token);

      expect(result._unsafeUnwrap()).toBeNull();
      expect(await tokenRows(token)).toHaveLength(1);
    });
  });

  describe('listTokensForUsers', () => {
    it('returns the tokens of exactly the given users', async () => {
      const included = await createUser();
      const excluded = await createUser();
      const includedToken = freshToken();
      await seedToken(included, includedToken);
      await seedToken(excluded, freshToken());

      const result = await store.listTokensForUsers([included]);

      expect(result._unsafeUnwrap()).toEqual([
        { platform: 'ios', userId: included, token: includedToken },
      ]);
    });

    it('returns a web subscription as an endpoint-plus-keys target', async () => {
      const userId = await createUser();
      const endpoint = `https://push.example.com/${crypto.randomUUID()}`;
      const upserted = await store.upsert({
        userId,
        token: endpoint,
        platform: 'web',
        p256dh: 'p256dh-key-value',
        auth: 'auth-secret-value',
      });
      upserted._unsafeUnwrap();

      const result = await store.listTokensForUsers([userId]);

      expect(result._unsafeUnwrap()).toEqual([
        {
          platform: 'web',
          userId,
          endpoint,
          p256dh: 'p256dh-key-value',
          auth: 'auth-secret-value',
        },
      ]);
    });

    it('resolves empty for an empty user list', async () => {
      const result = await store.listTokensForUsers([]);

      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('maps a lookup failure to an unavailable error', async () => {
      // A non-uuid userId fails uuid input parsing inside Postgres.
      const result = await store.listTokensForUsers(['not-a-uuid']);

      expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    });
  });
});
