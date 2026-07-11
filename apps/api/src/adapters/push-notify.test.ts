import { describe, expect, it, vi } from 'vitest';
import { errAsync, okAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import {
  NEW_MESSAGE_PUSH_BODY,
  NEW_MESSAGE_PUSH_TITLE,
  createMessagePushNotify,
} from './push-notify.js';
import type { PushMembershipReader } from '../slices/conversations/adapters/realtime-room-bindings.js';
import type { Database } from '@hushbox/db';
import type { Bindings } from '../lib/context/app-env.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/** Development env selects the in-process mock push sender (no real push). */
const ENV = { NODE_ENV: 'development' } as Bindings;

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
 * A fake DB exposing only what `createDeviceTokenStore.listTokensForUsers`
 * touches: `select().from().where()`. The select spy fires only when the store
 * is asked for a NON-EMPTY recipient set (the store short-circuits on empty),
 * so its call count observes whether any member survived suppression.
 */
function fakeDb(): { db: Database; selectSpy: ReturnType<typeof vi.fn> } {
  const selectSpy = vi.fn(() => ({
    from: () => ({ where: () => Promise.resolve([{ token: 'device-token-1' }]) }),
  }));
  return { db: { select: selectSpy } as unknown as Database, selectSpy };
}

function membershipOf(
  members: readonly { readonly userId: string; readonly muted: boolean }[]
): PushMembershipReader {
  return { listActiveUserMembers: () => okAsync(members) };
}

describe('createMessagePushNotify', () => {
  it('uses fixed, content-free copy (the message itself never reaches the payload)', () => {
    expect(NEW_MESSAGE_PUSH_TITLE).toBe('New message');
    expect(NEW_MESSAGE_PUSH_BODY).toBe('You have a new message in a conversation.');
  });

  it('looks up device tokens for an eligible absent member', async () => {
    const { db, selectSpy } = fakeDb();
    const notify = createMessagePushNotify({
      env: ENV,
      db,
      telemetry: noopTelemetry(),
      membership: membershipOf([{ userId: 'member-1', muted: false }]),
    });
    await notify({ conversationId: 'c1', senderUserId: 'sender-1', presentUserIds: [] });
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses muted members, present users, and the sender before any lookup', async () => {
    const { db, selectSpy } = fakeDb();
    const notify = createMessagePushNotify({
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
      conversationId: 'c1',
      senderUserId: 'sender-1',
      presentUserIds: ['present-member'],
    });
    // Every member is filtered (mute / presence / sender), so the store is
    // never asked for tokens — a suppression regression would fire the lookup.
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('resolves without throwing when the membership read fails (best-effort)', async () => {
    const { db } = fakeDb();
    const notify = createMessagePushNotify({
      env: ENV,
      db,
      telemetry: noopTelemetry(),
      membership: { listActiveUserMembers: () => errAsync(unavailableError('members down')) },
    });
    await expect(
      notify({ conversationId: 'c1', senderUserId: 'sender-1', presentUserIds: [] })
    ).resolves.toBeUndefined();
  });
});
