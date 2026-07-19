import { describe, it, expect, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG, users } from '@hushbox/db';
import { placeholderBytes } from '@hushbox/db/factories';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createDeviceTokenStore } from '../adapters/device-token-store-db.js';
import { createMockPushSender } from '../adapters/push-mock.js';
import { sendPushForNewMessage } from './notify-message.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { SafeLogFields } from '../../../lib/telemetry/index.js';
import type {
  ConversationMemberView,
  MembershipReader,
  PresenceReader,
  PushSender,
} from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for notifications integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const deviceTokenStore = createDeviceTokenStore(db);

const createdUserIds: string[] = [];

async function createUserWithToken(token: string | null): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 13);
  const [row] = await db
    .insert(users)
    .values({
      email: `notify-${suffix}@test.hushbox.ai`,
      username: `nf-${suffix}`,
      opaqueRegistration: placeholderBytes(32),
      publicKey: placeholderBytes(32),
      passwordWrappedPrivateKey: placeholderBytes(32),
      recoveryWrappedPrivateKey: placeholderBytes(32),
    })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  createdUserIds.push(row.id);
  if (token !== null) {
    const seeded = await deviceTokenStore.upsert({ userId: row.id, token, platform: 'ios' });
    seeded._unsafeUnwrap();
  }
  return row.id;
}

function membershipOf(members: readonly ConversationMemberView[]): MembershipReader {
  return { listActiveUserMembers: () => okAsync(members) };
}

function presenceOf(presentUserIds: readonly string[]): PresenceReader {
  return { presence: () => okAsync(presentUserIds) };
}

interface RecordingTelemetry extends Telemetry {
  readonly warnings: { msg: string; fields?: SafeLogFields }[];
}

function recordingTelemetry(): RecordingTelemetry {
  const warnings: { msg: string; fields?: SafeLogFields }[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: SafeLogFields) => {
      warnings.push(fields === undefined ? { msg } : { msg, fields });
    },
    error: () => {},
    emitMetric: () => {},
    captureError: () => {},
  };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

interface Scenario {
  senderUserId: string;
  mutedUserId: string;
  presentUserId: string;
  absentUserId: string;
  absentToken: string;
}

async function buildScenario(): Promise<Scenario> {
  const absentToken = `absent-${crypto.randomUUID()}`;
  return {
    senderUserId: await createUserWithToken(`sender-${crypto.randomUUID()}`),
    mutedUserId: await createUserWithToken(`muted-${crypto.randomUUID()}`),
    presentUserId: await createUserWithToken(`present-${crypto.randomUUID()}`),
    absentUserId: await createUserWithToken(absentToken),
    absentToken,
  };
}

function depsFor(scenario: Scenario, push: ReturnType<typeof createMockPushSender>) {
  return {
    membership: membershipOf([
      { userId: scenario.senderUserId, muted: false },
      { userId: scenario.mutedUserId, muted: true },
      { userId: scenario.presentUserId, muted: false },
      { userId: scenario.absentUserId, muted: false },
    ]),
    presence: presenceOf([scenario.presentUserId]),
    deviceTokens: deviceTokenStore,
    push,
    logger: recordingTelemetry(),
  };
}

const input = (conversationId: string, senderUserId: string) => ({
  conversationId,
  senderUserId,
  title: 'New message',
  body: 'You have a new message',
});

describe('sendPushForNewMessage', () => {
  it('delivers to the absent unmuted member', async () => {
    const scenario = await buildScenario();
    const push = createMockPushSender();

    const result = await sendPushForNewMessage(
      depsFor(scenario, push),
      input('conv-1', scenario.senderUserId)
    );

    expect(result._unsafeUnwrap()).toEqual({ successCount: 1, failureCount: 0 });
    expect(push.getSentMessages()[0]?.recipients.map((recipient) => recipient.token)).toEqual([
      scenario.absentToken,
    ]);
  });

  it('sends no push to a muted member', async () => {
    const scenario = await buildScenario();
    const push = createMockPushSender();

    const result = await sendPushForNewMessage(
      depsFor(scenario, push),
      input('conv-1', scenario.senderUserId)
    );

    expect(result.isOk()).toBe(true);
    const sentTokens = push
      .getSentMessages()
      .flatMap((m) => m.recipients.map((recipient) => recipient.token));
    expect(sentTokens.some((token) => token.startsWith('muted-'))).toBe(false);
  });

  it('sends no push to a present member', async () => {
    const scenario = await buildScenario();
    const push = createMockPushSender();

    const result = await sendPushForNewMessage(
      depsFor(scenario, push),
      input('conv-1', scenario.senderUserId)
    );

    expect(result.isOk()).toBe(true);
    const sentTokens = push
      .getSentMessages()
      .flatMap((m) => m.recipients.map((recipient) => recipient.token));
    expect(sentTokens.some((token) => token.startsWith('present-'))).toBe(false);
  });

  it('attaches the conversation id as the data payload', async () => {
    const scenario = await buildScenario();
    const push = createMockPushSender();

    const result = await sendPushForNewMessage(
      depsFor(scenario, push),
      input('conv-42', scenario.senderUserId)
    );

    expect(result.isOk()).toBe(true);
    expect(push.getSentMessages()[0]?.data).toEqual({ conversationId: 'conv-42' });
  });

  it('skips the push call when every member is filtered out', async () => {
    const scenario = await buildScenario();
    const push = createMockPushSender();
    const deps = {
      ...depsFor(scenario, push),
      membership: membershipOf([
        { userId: scenario.senderUserId, muted: false },
        { userId: scenario.mutedUserId, muted: true },
        { userId: scenario.presentUserId, muted: false },
      ]),
    };

    const result = await sendPushForNewMessage(deps, input('conv-1', scenario.senderUserId));

    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(push.getSentMessages()).toEqual([]);
  });

  it('skips the push call when recipients have no registered devices', async () => {
    const senderUserId = await createUserWithToken(null);
    const tokenlessUserId = await createUserWithToken(null);
    const push = createMockPushSender();
    const deps = {
      membership: membershipOf([
        { userId: senderUserId, muted: false },
        { userId: tokenlessUserId, muted: false },
      ]),
      presence: presenceOf([]),
      deviceTokens: deviceTokenStore,
      push,
      logger: recordingTelemetry(),
    };

    const result = await sendPushForNewMessage(deps, input('conv-1', senderUserId));

    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(push.getSentMessages()).toEqual([]);
  });

  it('prunes a token FCM reported dead and leaves a live one registered', async () => {
    const senderUserId = await createUserWithToken(null);
    const deadToken = `dead-${crypto.randomUUID()}`;
    const liveToken = `live-${crypto.randomUUID()}`;
    const deadUserId = await createUserWithToken(deadToken);
    const liveUserId = await createUserWithToken(liveToken);

    const pushReportingDead: PushSender = {
      send: () =>
        okAsync({
          successCount: 1,
          failureCount: 1,
          deadTokens: [{ userId: deadUserId, token: deadToken }],
        }),
    };

    const deps = {
      membership: membershipOf([
        { userId: senderUserId, muted: false },
        { userId: deadUserId, muted: false },
        { userId: liveUserId, muted: false },
      ]),
      presence: presenceOf([]),
      deviceTokens: deviceTokenStore,
      push: pushReportingDead,
      logger: recordingTelemetry(),
    };

    const result = await sendPushForNewMessage(deps, input('conv-prune', senderUserId));

    expect(result.isOk()).toBe(true);
    const remaining = await deviceTokenStore.listTokensForUsers([deadUserId, liveUserId]);
    expect(remaining._unsafeUnwrap()).toEqual([{ userId: liveUserId, token: liveToken }]);
  });

  it('logs and propagates a membership read failure', async () => {
    const scenario = await buildScenario();
    const push = createMockPushSender();
    const logger = recordingTelemetry();
    const deps = {
      ...depsFor(scenario, push),
      membership: {
        listActiveUserMembers: () =>
          errAsync<readonly ConversationMemberView[], ReturnType<typeof unavailableError>>(
            unavailableError('membership read failed')
          ),
      },
      logger,
    };

    const result = await sendPushForNewMessage(deps, input('conv-1', scenario.senderUserId));

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(logger.warnings).toEqual([
      {
        msg: 'push.delivery.degraded',
        fields: { errorCode: 'unavailable', conversationId: 'conv-1' },
      },
    ]);
    expect(push.getSentMessages()).toEqual([]);
  });
});
