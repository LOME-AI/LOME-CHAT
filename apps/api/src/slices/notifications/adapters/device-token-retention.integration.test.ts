import { describe, it, expect, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  deviceTokens as deviceTokensTable,
  LOCAL_NEON_DEV_CONFIG,
  users,
} from '@hushbox/db';
import { placeholderBytes } from '@hushbox/db/factories';
import { okAsync } from '../../../lib/result/index.js';
import { notifyEvent } from '../domain/index.js';
import { createDeviceTokenStore } from './device-token-store-db.js';
import { createNotificationPreferencesStore } from './notification-preferences-store-db.js';
import { createPushSenderFromEnv } from './push-sender-factory.js';
import { DEVICE_TOKEN_STALE_DAYS, purgeStaleDeviceTokens } from './device-token-retention.js';
import type { DbTransaction } from '../../../lib/idempotency/transaction.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { ConversationMemberView, MembershipReader } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for device-token retention integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const deviceTokens = createDeviceTokenStore(db);
const preferences = createNotificationPreferencesStore(db);
const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f61';

const createdUserIds: string[] = [];

class Rollback extends Error {}

/**
 * Runs the delete inside a rolled-back transaction: the local database is
 * shared with every other integration test, and a committed retention pass
 * would reach their rows too.
 */
async function withRollback<T>(function_: (tx: DbTransaction) => Promise<T>): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      captured = { value: await function_(tx) };
      throw new Rollback('roll back test writes');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (captured === undefined) throw new Error('withRollback: body did not complete');
  return captured.value;
}

function newUserValues(): typeof users.$inferInsert {
  const suffix = crypto.randomUUID().slice(0, 13);
  return {
    email: `dt-retention-${suffix}@test.hushbox.ai`,
    username: `dtr-${suffix}`,
    opaqueRegistration: placeholderBytes(32),
    publicKey: placeholderBytes(32),
    passwordWrappedPrivateKey: placeholderBytes(32),
    recoveryWrappedPrivateKey: placeholderBytes(32),
  };
}

async function createUserWithToken(token: string): Promise<string> {
  const [row] = await db.insert(users).values(newUserValues()).returning({ id: users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  createdUserIds.push(row.id);
  const registered = await deviceTokens.upsert({ userId: row.id, token, platform: 'ios' });
  registered._unsafeUnwrap();
  return row.id;
}

function agedAt(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Ages a row past the retention window. */
async function age(token: string, days: number): Promise<void> {
  await db
    .update(deviceTokensTable)
    .set({ lastSeenAt: agedAt(days) })
    .where(eq(deviceTokensTable.token, token));
}

/**
 * Seeds an aged device inside the caller's transaction, so it never reaches a
 * commit. The daily cron runs this same delete committed against the shared
 * local database, and a committed row past the retention window is deletable
 * from under whichever test is holding it.
 */
async function seedAgedToken(tx: DbTransaction, token: string, days: number): Promise<void> {
  const [row] = await tx.insert(users).values(newUserValues()).returning({ id: users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  await tx
    .insert(deviceTokensTable)
    .values({ userId: row.id, token, platform: 'ios', lastSeenAt: agedAt(days) });
}

async function lastSeenAt(token: string): Promise<Date> {
  const [row] = await db
    .select({ lastSeenAt: deviceTokensTable.lastSeenAt })
    .from(deviceTokensTable)
    .where(eq(deviceTokensTable.token, token));
  if (row === undefined) throw new Error('no device_tokens row for token');
  return row.lastSeenAt;
}

async function survives(tx: DbTransaction, token: string): Promise<boolean> {
  const rows = await tx
    .select({ id: deviceTokensTable.id })
    .from(deviceTokensTable)
    .where(eq(deviceTokensTable.token, token));
  return rows.length === 1;
}

function membershipOf(members: readonly ConversationMemberView[]): MembershipReader {
  return { listActiveUserMembers: () => okAsync(members) };
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
} as unknown as Telemetry;

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('purgeStaleDeviceTokens', () => {
  it('deletes a device whose last-seen predates the retention window', async () => {
    const token = `stale-${crypto.randomUUID()}`;

    const stillThere = await withRollback(async (tx) => {
      await seedAgedToken(tx, token, DEVICE_TOKEN_STALE_DAYS + 1);
      await purgeStaleDeviceTokens(tx, { batchSize: 1000 });
      return survives(tx, token);
    });

    expect(stillThere).toBe(false);
  });

  it('keeps a device the delivery path refreshed', async () => {
    const token = `refreshed-${crypto.randomUUID()}`;
    const recipient = await createUserWithToken(token);
    const actor = crypto.randomUUID();
    await age(token, DEVICE_TOKEN_STALE_DAYS + 1);

    // The real delivery path: the composite sender the composition root binds
    // in dev, over the real device-token store, which refreshes `lastSeenAt`
    // for every target the send reports delivered.
    const delivered = await notifyEvent(
      {
        membership: membershipOf([{ userId: recipient, muted: false }]),
        preferences,
        deviceTokens,
        push: createPushSenderFromEnv({
          NODE_ENV: 'development',
          NOTIFICATION_TAG_SECRET: 'retention-collapse-alias-key',
        }),
        logger: silentLogger,
      },
      {
        category: 'message',
        conversationId: CONVERSATION_ID,
        actorUserId: actor,
        presentUserIds: [],
      }
    );
    expect(delivered._unsafeUnwrap().successCount).toBe(1);
    const refreshed = await lastSeenAt(token);
    expect(refreshed.getTime()).toBeGreaterThan(
      Date.now() - DEVICE_TOKEN_STALE_DAYS * 24 * 60 * 60 * 1000
    );

    const stillThere = await withRollback(async (tx) => {
      await purgeStaleDeviceTokens(tx, { batchSize: 1000 });
      return survives(tx, token);
    });

    expect(stillThere).toBe(true);
  });

  it('keeps a device seen inside the retention window', async () => {
    const token = `recent-${crypto.randomUUID()}`;
    await createUserWithToken(token);
    await age(token, DEVICE_TOKEN_STALE_DAYS - 1);

    const stillThere = await withRollback(async (tx) => {
      await purgeStaleDeviceTokens(tx, { batchSize: 1000 });
      return survives(tx, token);
    });

    expect(stillThere).toBe(true);
  });

  it('deletes no more than the batch size in one pass', async () => {
    const first = `batched-${crypto.randomUUID()}`;
    const second = `batched-${crypto.randomUUID()}`;

    const deleted = await withRollback(async (tx) => {
      await seedAgedToken(tx, first, DEVICE_TOKEN_STALE_DAYS + 1);
      await seedAgedToken(tx, second, DEVICE_TOKEN_STALE_DAYS + 1);
      return purgeStaleDeviceTokens(tx, { batchSize: 1 });
    });

    expect(deleted).toBe(1);
  });
});
