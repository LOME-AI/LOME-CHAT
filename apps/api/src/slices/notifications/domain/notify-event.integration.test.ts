import { describe, it, expect, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  deviceTokens as deviceTokensTable,
  LOCAL_NEON_DEV_CONFIG,
  users,
} from '@hushbox/db';
import { placeholderBytes } from '@hushbox/db/factories';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createDeviceTokenStore } from '../adapters/device-token-store-db.js';
import { createNotificationPreferencesStore } from '../adapters/notification-preferences-store-db.js';
import { createMockPushSender } from '../adapters/push-mock.js';
import { notifyEvent } from './notify-event.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../ports/index.js';
import type { SafeLogFields, Telemetry } from '../../../lib/telemetry/index.js';
import type { ConversationMemberView, MembershipReader, PushSender } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for notifications integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const deviceTokens = createDeviceTokenStore(db);
const preferences = createNotificationPreferencesStore(db);
const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';

const createdUserIds: string[] = [];

async function createUserWithToken(token: string | null): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 13);
  const [row] = await db
    .insert(users)
    .values({
      email: `notify-evt-${suffix}@test.hushbox.ai`,
      username: `ne-${suffix}`,
      opaqueRegistration: placeholderBytes(32),
      publicKey: placeholderBytes(32),
      passwordWrappedPrivateKey: placeholderBytes(32),
      recoveryWrappedPrivateKey: placeholderBytes(32),
    })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  createdUserIds.push(row.id);
  if (token !== null) {
    const seeded = await deviceTokens.upsert({ userId: row.id, token, platform: 'ios' });
    seeded._unsafeUnwrap();
  }
  return row.id;
}

/**
 * Old enough that a delivery-driven refresh is unambiguously observable, recent
 * enough to stay inside the device-token retention window: the daily retention
 * pass commits a real delete against this shared local database, and rows older
 * than the window are fair game for it while these tests still assert on them.
 */
const STALE_LAST_SEEN = new Date(Date.now() - 60 * 60 * 1000);

/** Ages a row so a delivery-driven refresh is observable. */
async function makeStale(token: string): Promise<void> {
  await db
    .update(deviceTokensTable)
    .set({ lastSeenAt: STALE_LAST_SEEN })
    .where(eq(deviceTokensTable.token, token));
}

async function lastSeenAt(token: string): Promise<Date> {
  const [row] = await db
    .select({ lastSeenAt: deviceTokensTable.lastSeenAt })
    .from(deviceTokensTable)
    .where(eq(deviceTokensTable.token, token));
  if (row === undefined) throw new Error('no device_tokens row for token');
  return row.lastSeenAt;
}

function membershipOf(members: readonly ConversationMemberView[]): MembershipReader {
  return { listActiveUserMembers: () => okAsync(members) };
}

function recordingTelemetry(): { logger: Telemetry; warnings: { msg: string }[] } {
  const warnings: { msg: string }[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, _fields?: SafeLogFields) => warnings.push({ msg }),
    error: () => {},
    emitMetric: () => {},
    captureError: () => {},
  } as unknown as Telemetry;
  return { logger, warnings };
}

function messageInput(actorUserId: string, presentUserIds: readonly string[] = []) {
  return {
    category: 'message' as const,
    conversationId: CONVERSATION_ID,
    actorUserId,
    presentUserIds,
  };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('notifyEvent (message path over real stores)', () => {
  it('delivers to an absent, unmuted, prefs-default member', async () => {
    const sender = await createUserWithToken(null);
    const absentToken = `absent-${crypto.randomUUID()}`;
    const absent = await createUserWithToken(absentToken);
    const push = createMockPushSender();

    const result = await notifyEvent(
      {
        membership: membershipOf([
          { userId: sender, muted: false },
          { userId: absent, muted: false },
        ]),
        preferences,
        deviceTokens,
        push,
        logger: recordingTelemetry().logger,
      },
      messageInput(sender)
    );

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 1,
      failureCount: 0,
      deliveredTokens: [{ userId: absent, token: absentToken }],
      deadTokens: [],
    });
    expect(push.getSentMessages()[0]?.recipients).toEqual([
      { platform: 'ios', userId: absent, token: absentToken },
    ]);
  });

  it('suppresses a muted member', async () => {
    const sender = await createUserWithToken(null);
    const mutedToken = `muted-${crypto.randomUUID()}`;
    const muted = await createUserWithToken(mutedToken);
    const push = createMockPushSender();

    const delivery = await notifyEvent(
      {
        membership: membershipOf([
          { userId: sender, muted: false },
          { userId: muted, muted: true },
        ]),
        preferences,
        deviceTokens,
        push,
        logger: recordingTelemetry().logger,
      },
      messageInput(sender)
    );

    expect(delivery.isOk()).toBe(true);
    expect(push.getSentMessages()).toEqual([]);
  });

  it('suppresses a present member and the actor', async () => {
    const sender = await createUserWithToken(`sender-${crypto.randomUUID()}`);
    const presentToken = `present-${crypto.randomUUID()}`;
    const present = await createUserWithToken(presentToken);
    const push = createMockPushSender();

    const result = await notifyEvent(
      {
        membership: membershipOf([
          { userId: sender, muted: false },
          { userId: present, muted: false },
        ]),
        preferences,
        deviceTokens,
        push,
        logger: recordingTelemetry().logger,
      },
      messageInput(sender, [present])
    );

    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(push.getSentMessages()).toEqual([]);
  });

  it('respects a stored global-off preference for the message category', async () => {
    const sender = await createUserWithToken(null);
    const off = await createUserWithToken(`off-${crypto.randomUUID()}`);
    const stored = await preferences.upsert(off, {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      globalEnabled: false,
    });
    stored._unsafeUnwrap();
    const push = createMockPushSender();

    const delivery = await notifyEvent(
      {
        membership: membershipOf([
          { userId: sender, muted: false },
          { userId: off, muted: false },
        ]),
        preferences,
        deviceTokens,
        push,
        logger: recordingTelemetry().logger,
      },
      messageInput(sender)
    );
    expect(delivery.isOk()).toBe(true);

    expect(push.getSentMessages()).toEqual([]);
  });

  it('prunes a token the sender reports dead and leaves a live one registered', async () => {
    const sender = await createUserWithToken(null);
    const deadToken = `dead-${crypto.randomUUID()}`;
    const liveToken = `live-${crypto.randomUUID()}`;
    const deadUser = await createUserWithToken(deadToken);
    const liveUser = await createUserWithToken(liveToken);
    const push: PushSender = {
      send: () =>
        okAsync({
          successCount: 1,
          failureCount: 1,
          deadTokens: [{ userId: deadUser, token: deadToken }],
        }),
    };

    const result = await notifyEvent(
      {
        membership: membershipOf([
          { userId: sender, muted: false },
          { userId: deadUser, muted: false },
          { userId: liveUser, muted: false },
        ]),
        preferences,
        deviceTokens,
        push,
        logger: recordingTelemetry().logger,
      },
      messageInput(sender)
    );

    expect(result.isOk()).toBe(true);
    const remaining = await deviceTokens.listTokensForUsers([deadUser, liveUser]);
    expect(remaining._unsafeUnwrap()).toEqual([
      { platform: 'ios', userId: liveUser, token: liveToken },
    ]);
  });

  it('refreshes last-seen on the device it delivered to, so retention keeps it', async () => {
    const sender = await createUserWithToken(null);
    const activeToken = `active-${crypto.randomUUID()}`;
    const active = await createUserWithToken(activeToken);
    await makeStale(activeToken);
    const push = createMockPushSender();

    const result = await notifyEvent(
      {
        membership: membershipOf([
          { userId: sender, muted: false },
          { userId: active, muted: false },
        ]),
        preferences,
        deviceTokens,
        push,
        logger: recordingTelemetry().logger,
      },
      messageInput(sender)
    );

    expect(result.isOk()).toBe(true);
    const refreshed = await lastSeenAt(activeToken);
    expect(refreshed.getTime()).toBeGreaterThan(STALE_LAST_SEEN.getTime());
  });

  it('leaves last-seen stale on a device the send never reached', async () => {
    const sender = await createUserWithToken(null);
    const unreachedToken = `unreached-${crypto.randomUUID()}`;
    const unreached = await createUserWithToken(unreachedToken);
    await makeStale(unreachedToken);
    const push: PushSender = {
      send: () => okAsync({ successCount: 0, failureCount: 1 }),
    };

    const result = await notifyEvent(
      {
        membership: membershipOf([
          { userId: sender, muted: false },
          { userId: unreached, muted: false },
        ]),
        preferences,
        deviceTokens,
        push,
        logger: recordingTelemetry().logger,
      },
      messageInput(sender)
    );

    expect(result.isOk()).toBe(true);
    expect(await lastSeenAt(unreachedToken)).toEqual(STALE_LAST_SEEN);
  });

  it('logs and propagates a membership read failure', async () => {
    const { logger, warnings } = recordingTelemetry();
    const result = await notifyEvent(
      {
        membership: {
          listActiveUserMembers: () => errAsync(unavailableError('membership read failed')),
        },
        preferences,
        deviceTokens,
        push: createMockPushSender(),
        logger,
      },
      messageInput('someone')
    );

    expect(result.isErr()).toBe(true);
    expect(warnings[0]?.msg).toBe('push.delivery.degraded');
  });
});
