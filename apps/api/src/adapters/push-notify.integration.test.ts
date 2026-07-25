import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  deviceTokens,
  notificationPreferences,
  users,
} from '@hushbox/db';
import { listCapturedPushes } from '../slices/notifications/index.js';
import { createPushMembershipReader } from '../slices/conversations/adapters/push-membership-reader.js';
import { createMembershipPushNotify, createRunCompletionPushNotify } from './push-notify.js';
import type { Database } from '@hushbox/db';
import type { Bindings } from '../lib/context/app-env.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/**
 * The composition-root notification capabilities the ConversationRoom's
 * terminal sink and the conversations routes fire, exercised over real
 * Postgres membership/preferences/device-token rows. Development selects the
 * in-process mock transports, whose capture log is the delivery assertion.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the push-notify integration tests');
}

const db: Database = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const ENV = {
  NODE_ENV: 'development',
  NOTIFICATION_TAG_SECRET: 'push-notify-integration-secret',
} as Bindings;

const BYTES = new Uint8Array([4, 4, 4]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

function silentTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    emitMetric: noop,
    captureError: noop,
  } as unknown as Telemetry;
}

async function seedUser(): Promise<string> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@push-notify.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  return userId;
}

async function seedConversation(ownerUserId: string): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId: ownerUserId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = rows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  return conversationId;
}

/** Seats a user with a device token, so a notification for them is observable. */
async function seatMember(
  conversationId: string,
  options: { muted?: boolean; category?: 'runCompletion' | 'membership' | 'off' } = {}
): Promise<{ userId: string; token: string }> {
  const userId = await seedUser();
  await db.insert(conversationMembers).values({
    conversationId,
    userId,
    privilege: 'write',
    visibleFromEpoch: 1,
    muted: options.muted ?? false,
  });
  const token = `tok-${crypto.randomUUID()}`;
  await db.insert(deviceTokens).values({ userId, token, platform: 'ios' });
  if (options.category !== undefined) {
    await db.insert(notificationPreferences).values({
      userId,
      runCompletion: options.category !== 'runCompletion' && options.category !== 'off',
      membership: options.category !== 'membership' && options.category !== 'off',
      globalEnabled: options.category !== 'off',
    });
  }
  return { userId, token };
}

function pushesFor(conversationId: string): {
  category: unknown;
  tokens: string[];
}[] {
  return listCapturedPushes()
    .filter((captured) => captured.message.data?.['conversationId'] === conversationId)
    .map((captured) => ({
      category: captured.message.data?.['category'],
      tokens: captured.message.recipients.map((recipient) =>
        recipient.platform === 'web' ? recipient.endpoint : recipient.token
      ),
    }));
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('run-completion push', () => {
  let conversationId = '';
  let actorUserId = '';

  beforeEach(async () => {
    actorUserId = await seedUser();
    conversationId = await seedConversation(actorUserId);
    await db.insert(conversationMembers).values({
      conversationId,
      userId: actorUserId,
      privilege: 'owner',
      visibleFromEpoch: 1,
    });
  });

  function notifyRunCompletion(presentUserIds: readonly string[] = []): Promise<void> {
    return createRunCompletionPushNotify({
      env: ENV,
      db,
      telemetry: silentTelemetry(),
      membership: createPushMembershipReader(db),
    })({ conversationId, senderUserId: actorUserId, presentUserIds });
  }

  it('notifies an absent, unmuted member exactly once under the run-completion category', async () => {
    const member = await seatMember(conversationId);

    await notifyRunCompletion();

    expect(pushesFor(conversationId)).toEqual([
      { category: 'runCompletion', tokens: [member.token] },
    ]);
  });

  it('notifies the requester in a solo conversation — the run finished for them', async () => {
    const token = `tok-${crypto.randomUUID()}`;
    await db.insert(deviceTokens).values({ userId: actorUserId, token, platform: 'ios' });

    await notifyRunCompletion();

    expect(pushesFor(conversationId)).toEqual([{ category: 'runCompletion', tokens: [token] }]);
  });

  it('excludes a member present at fire time', async () => {
    const present = await seatMember(conversationId);
    const absent = await seatMember(conversationId);

    await notifyRunCompletion([present.userId]);

    expect(pushesFor(conversationId)).toEqual([
      { category: 'runCompletion', tokens: [absent.token] },
    ]);
  });

  it('excludes a member who muted the conversation', async () => {
    await seatMember(conversationId, { muted: true });

    await notifyRunCompletion();

    expect(pushesFor(conversationId)).toEqual([]);
  });

  it('excludes a member who turned the run-completion category off', async () => {
    await seatMember(conversationId, { category: 'runCompletion' });

    await notifyRunCompletion();

    expect(pushesFor(conversationId)).toEqual([]);
  });
});

describe('membership push', () => {
  it('notifies only the targeted new member under the membership category', async () => {
    const actorUserId = await seedUser();
    const conversationId = await seedConversation(actorUserId);
    await db.insert(conversationMembers).values({
      conversationId,
      userId: actorUserId,
      privilege: 'owner',
      visibleFromEpoch: 1,
    });
    const added = await seatMember(conversationId);
    const bystander = await seatMember(conversationId);

    await createMembershipPushNotify(
      ENV,
      db
    )({
      conversationId,
      actorUserId,
      recipientUserIds: [added.userId],
      presentUserIds: [],
    });

    expect(pushesFor(conversationId)).toEqual([{ category: 'membership', tokens: [added.token] }]);
    expect(pushesFor(conversationId)[0]?.tokens).not.toContain(bystander.token);
  });

  it('notifies every eligible member when no recipient is targeted', async () => {
    const actorUserId = await seedUser();
    const conversationId = await seedConversation(actorUserId);
    await db.insert(conversationMembers).values({
      conversationId,
      userId: actorUserId,
      privilege: 'owner',
      visibleFromEpoch: 1,
    });
    const first = await seatMember(conversationId);
    const second = await seatMember(conversationId, { category: 'membership' });

    await createMembershipPushNotify(
      ENV,
      db
    )({
      conversationId,
      actorUserId,
      presentUserIds: [],
    });

    expect(pushesFor(conversationId)).toEqual([{ category: 'membership', tokens: [first.token] }]);
    expect(pushesFor(conversationId)[0]?.tokens).not.toContain(second.token);
  });
});
