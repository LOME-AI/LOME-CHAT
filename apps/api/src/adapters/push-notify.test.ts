import { describe, expect, it, vi } from 'vitest';
import { errAsync, okAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import { createChatMessagePushNotify, createRunCompletionPushNotify } from './push-notify.js';
import type { PushMembershipReader } from '../slices/conversations/adapters/push-membership-reader.js';
import type { Database } from '@hushbox/db';
import type { Bindings } from '../lib/context/app-env.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/** Development env selects the in-process mock push sender (no real push). */
const ENV = { NODE_ENV: 'development', NOTIFICATION_TAG_SECRET: 'test-secret' } as Bindings;

/**
 * Must be a real uuid: the composite push sender validates the wire payload
 * against the shared schema and refuses to dispatch a malformed conversation
 * id, so a placeholder here would silently stop the pipeline short of `send`.
 */
const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';

function noopTelemetry(): Telemetry {
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

/**
 * A fake DB whose `select().from().where()` yields the queued result sets in
 * order. The message pipeline reads (for an injected-membership caller) the
 * per-user preferences then, if any member survives, the device tokens; the
 * `select` spy's call count observes how far it got.
 */
function queuedDb(...resultSets: readonly unknown[][]): {
  db: Database;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const queue = [...resultSets];
  const select = vi.fn(() => ({
    from: () => ({ where: () => Promise.resolve(queue.shift() ?? []) }),
  }));
  // The delivery path refreshes `lastSeenAt` on every target the sender
  // accepted; the spy observes that write.
  const update = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) }));
  return { db: { select, update } as unknown as Database, select, update };
}

function membershipOf(
  members: readonly { readonly userId: string; readonly muted: boolean }[]
): PushMembershipReader {
  return { listActiveUserMembers: () => okAsync(members) };
}

describe('createRunCompletionPushNotify', () => {
  it('reads preferences then device tokens for an eligible absent member', async () => {
    // [prefs rows, token rows] — no prefs row means defaults; the token row
    // makes the surviving recipient reachable.
    const { db, select, update } = queuedDb(
      [],
      [{ platform: 'ios', userId: 'member-1', token: 'device-1' }]
    );
    const notify = createRunCompletionPushNotify({
      env: ENV,
      db,
      telemetry: noopTelemetry(),
      membership: membershipOf([{ userId: 'member-1', muted: false }]),
    });

    await notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] });

    // Preferences read, then the token lookup for the surviving recipient.
    expect(select).toHaveBeenCalledTimes(2);
    // …and the delivered device's last-seen clock is refreshed.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('never looks up tokens when every member is suppressed', async () => {
    const { db, select } = queuedDb([]); // only the preferences read runs
    const notify = createRunCompletionPushNotify({
      env: ENV,
      db,
      telemetry: noopTelemetry(),
      membership: membershipOf([
        { userId: 'muted-member', muted: true },
        { userId: 'present-member', muted: false },
        { userId: 'sender-1', muted: false },
      ]),
    });

    await notify({
      conversationId: CONVERSATION_ID,
      senderUserId: 'sender-1',
      presentUserIds: ['present-member', 'sender-1'],
    });

    // Preferences are read over the candidates, but no member survives mute /
    // presence, so the token lookup never fires. A run completion does not
    // suppress its requester — only their watching the run does.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when the membership read fails (best-effort)', async () => {
    const { db } = queuedDb();
    const notify = createRunCompletionPushNotify({
      env: ENV,
      db,
      telemetry: noopTelemetry(),
      membership: { listActiveUserMembers: () => errAsync(unavailableError('members down')) },
    });

    await expect(
      notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] })
    ).resolves.toBeUndefined();
  });
});

describe('createChatMessagePushNotify', () => {
  it('reads active members, preferences, then device tokens for an eligible member', async () => {
    const { db, select } = queuedDb(
      [{ userId: 'member-1', muted: false }],
      [],
      [{ platform: 'ios', userId: 'member-1', token: 'device-1' }]
    );
    const notify = createChatMessagePushNotify(ENV, db);

    await expect(
      notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] })
    ).resolves.toBeUndefined();

    // Members query, preferences query, then the token lookup.
    expect(select).toHaveBeenCalledTimes(3);
  });

  it('excludes a link-guest (null userId) member — no recipient, no further reads', async () => {
    const { db, select } = queuedDb([{ userId: null, muted: false }]);
    const notify = createChatMessagePushNotify(ENV, db);

    await expect(
      notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] })
    ).resolves.toBeUndefined();

    // Only the member read runs: the null-userId row is dropped, leaving no
    // candidate, so neither the preferences nor the token lookup fires.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when the member read fails (best-effort)', async () => {
    const select = vi.fn(() => ({
      from: () => ({ where: () => Promise.reject(new Error('members down')) }),
    }));
    const db = { select } as unknown as Database;
    const notify = createChatMessagePushNotify(ENV, db);

    await expect(
      notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] })
    ).resolves.toBeUndefined();
  });
});
