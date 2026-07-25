import { describe, it, expect } from 'vitest';
import { NOTIFICATION_COPY } from '@hushbox/shared';
import { okAsync, errAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { notifyEvent } from './notify-event.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../ports/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SafeLogFields, Telemetry } from '../../../lib/telemetry/index.js';
import type {
  ConversationMemberView,
  MembershipReader,
  NotificationPreferences,
  NotificationPreferencesStore,
  PushDelivery,
  PushDeviceRef,
  PushMessage,
  PushRecipient,
  PushSender,
} from '../ports/index.js';

const NOON_UTC = new Date('2026-01-15T12:00:00Z');

function membershipOf(members: readonly ConversationMemberView[]): MembershipReader {
  return { listActiveUserMembers: () => okAsync(members) };
}

function prefsReaderOf(
  entries: readonly (readonly [string, NotificationPreferences])[]
): Pick<NotificationPreferencesStore, 'readForUsers'> {
  return { readForUsers: () => okAsync(new Map(entries)) };
}

interface RecordingTokenStore {
  listTokensForUsers(
    userIds: readonly string[]
  ): ResultAsync<readonly PushRecipient[], DomainError>;
  deleteByToken(userId: string, token: string): ResultAsync<true | null, DomainError>;
  touchLastSeen(references: readonly PushDeviceRef[]): ResultAsync<void, DomainError>;
  readonly deleted: PushDeviceRef[];
  readonly touched: PushDeviceRef[];
}

function tokenStoreOf(byUser: Record<string, readonly PushRecipient[]>): RecordingTokenStore {
  const deleted: PushDeviceRef[] = [];
  const touched: PushDeviceRef[] = [];
  return {
    deleted,
    touched,
    listTokensForUsers: (userIds) => okAsync(userIds.flatMap((id) => byUser[id] ?? [])),
    deleteByToken: (userId, token) => {
      deleted.push({ userId, token });
      return okAsync(true);
    },
    touchLastSeen: (references) => {
      touched.push(...references);
      return okAsync();
    },
  };
}

function recordingPush(delivery: PushDelivery): { push: PushSender; sent: PushMessage[] } {
  const sent: PushMessage[] = [];
  return {
    sent,
    push: {
      send: (message) => {
        sent.push(message);
        return okAsync(delivery);
      },
    },
  };
}

function silentLogger(): Telemetry {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Telemetry;
}

const iosToken = (userId: string, token: string): PushRecipient => ({
  platform: 'ios',
  userId,
  token,
});

describe('notifyEvent', () => {
  it('sends to an eligible member with per-category copy and generic data', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] }),
        push,
        logger: silentLogger(),
      },
      {
        category: 'runCompletion',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result._unsafeUnwrap()).toEqual({ successCount: 1, failureCount: 0 });
    expect(sent[0]?.title).toBe(NOTIFICATION_COPY.runCompletion.title);
    expect(sent[0]?.body).toBe(NOTIFICATION_COPY.runCompletion.body);
    expect(sent[0]?.data).toEqual({
      category: 'runCompletion',
      conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
    });
    expect(sent[0]?.recipients).toEqual([iosToken('u1', 'tok-1')]);
  });

  it('never sets a raw conversationId as the collapse key (composite derives it)', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] }),
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(sent[0]?.collapseKey).toBeUndefined();
  });

  it('narrows to recipientUserIds when given, keeping their mute flags', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([
          { userId: 'u1', muted: false },
          { userId: 'u2', muted: false },
        ]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({
          u1: [iosToken('u1', 'tok-1')],
          u2: [iosToken('u2', 'tok-2')],
        }),
        push,
        logger: silentLogger(),
      },
      {
        category: 'membership',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        recipientUserIds: ['u2'],
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(sent[0]?.recipients).toEqual([iosToken('u2', 'tok-2')]);
  });

  it('resolves without a send when no member is eligible', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: true }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] }),
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(sent).toEqual([]);
  });

  it('resolves without a send when eligible members carry no device tokens', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({}),
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(sent).toEqual([]);
  });

  it('prunes every dead token the sender reports', async () => {
    const { push } = recordingPush({
      successCount: 0,
      failureCount: 1,
      deadTokens: [{ userId: 'u1', token: 'tok-1' }],
    });
    const store = tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: store,
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(store.deleted).toEqual([{ userId: 'u1', token: 'tok-1' }]);
  });

  it('touches last-seen for every target the sender delivered to', async () => {
    const { push } = recordingPush({
      successCount: 1,
      failureCount: 0,
      deliveredTokens: [{ userId: 'u1', token: 'tok-1' }],
    });
    const store = tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: store,
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(store.touched).toEqual([{ userId: 'u1', token: 'tok-1' }]);
  });

  it('never touches last-seen for a target the sender failed to reach', async () => {
    const { push } = recordingPush({
      successCount: 1,
      failureCount: 1,
      deliveredTokens: [{ userId: 'u1', token: 'tok-1' }],
      deadTokens: [{ userId: 'u2', token: 'tok-2' }],
    });
    const store = tokenStoreOf({
      u1: [iosToken('u1', 'tok-1')],
      u2: [iosToken('u2', 'tok-2')],
    });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([
          { userId: 'u1', muted: false },
          { userId: 'u2', muted: false },
        ]),
        preferences: prefsReaderOf([]),
        deviceTokens: store,
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(store.touched).toEqual([{ userId: 'u1', token: 'tok-1' }]);
  });

  it('applies quiet hours through the injected clock', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const quiet: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      quietHoursStartMinutes: 6 * 60,
      quietHoursEndMinutes: 8 * 60,
      timezone: 'America/New_York',
    };
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([['u1', quiet]]),
        deviceTokens: tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] }),
        push,
        logger: silentLogger(),
        now: () => NOON_UTC, // 07:00 NY → inside the window
      },
      {
        category: 'message',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(sent).toEqual([]);
  });

  it('logs and returns the error when a downstream read fails', async () => {
    const logged: { msg: string; fields: SafeLogFields }[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, fields: SafeLogFields) => logged.push({ msg, fields }),
      error: () => {},
    } as unknown as Telemetry;
    const failing: MembershipReader = {
      listActiveUserMembers: () => errAsync(unavailableError('membership read failed')),
    };
    const result = await notifyEvent(
      {
        membership: failing,
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({}),
        push: recordingPush({ successCount: 0, failureCount: 0 }).push,
        logger,
      },
      {
        category: 'message',
        conversationId: '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60',
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result.isErr()).toBe(true);
    expect(logged[0]?.msg).toBe('push.delivery.degraded');
  });
});
