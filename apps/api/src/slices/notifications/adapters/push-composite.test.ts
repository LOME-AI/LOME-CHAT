import { describe, it, expect } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { createCompositePushSender } from './push-composite.js';
import { createMockPushSender } from './push-mock.js';
import type { PushMessage, PushRecipient, PushSender } from '../ports/index.js';

const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';

const ios = (userId: string, token: string): PushRecipient => ({
  platform: 'ios',
  userId,
  token,
});
const web = (userId: string, endpoint: string): PushRecipient => ({
  platform: 'web',
  userId,
  endpoint,
  p256dh: 'p256dh',
  auth: 'auth',
});

function message(recipients: readonly PushRecipient[]): PushMessage {
  return {
    recipients,
    payload: { category: 'message', conversationId: CONVERSATION_ID },
  };
}

const stubDerive = (): ((conversationId: string) => Promise<string>) => (id) =>
  Promise.resolve(`alias-${id.slice(0, 4)}`);

describe('createCompositePushSender', () => {
  it('routes native targets to FCM and web targets to Web Push', async () => {
    const fcm = createMockPushSender();
    const webPush = createMockPushSender();
    const sender = createCompositePushSender({ fcm, webPush, deriveCollapseKey: stubDerive() });

    const delivery = await sender.send(
      message([ios('u1', 'ios-tok'), web('u2', 'https://push/aaa'), ios('u3', 'ios-tok-3')])
    );
    expect(delivery.isOk()).toBe(true);

    expect(fcm.getSentMessages()[0]?.recipients).toEqual([
      ios('u1', 'ios-tok'),
      ios('u3', 'ios-tok-3'),
    ]);
    expect(webPush.getSentMessages()[0]?.recipients).toEqual([web('u2', 'https://push/aaa')]);
  });

  it('stamps the derived collapse alias on both partitions, never the raw id', async () => {
    const fcm = createMockPushSender();
    const webPush = createMockPushSender();
    const sender = createCompositePushSender({ fcm, webPush, deriveCollapseKey: stubDerive() });

    const delivery = await sender.send(
      message([ios('u1', 'ios-tok'), web('u2', 'https://push/aaa')])
    );
    expect(delivery.isOk()).toBe(true);

    const alias = `alias-${CONVERSATION_ID.slice(0, 4)}`;
    expect(fcm.getSentMessages()[0]?.collapseKey).toBe(alias);
    expect(webPush.getSentMessages()[0]?.collapseKey).toBe(alias);
    expect(fcm.getSentMessages()[0]?.collapseKey).not.toBe(CONVERSATION_ID);
  });

  it('skips a partition with no targets', async () => {
    const fcm = createMockPushSender();
    const webPush = createMockPushSender();
    const sender = createCompositePushSender({ fcm, webPush, deriveCollapseKey: stubDerive() });

    const delivery = await sender.send(message([ios('u1', 'ios-tok')]));
    expect(delivery.isOk()).toBe(true);

    expect(fcm.getSentMessages()).toHaveLength(1);
    expect(webPush.getSentMessages()).toEqual([]);
  });

  it('sums delivery counts and concatenates delivered and dead tokens across partitions', async () => {
    const fcm: PushSender = {
      send: () =>
        okAsync({
          successCount: 1,
          failureCount: 1,
          deliveredTokens: [{ userId: 'u3', token: 'ios-live' }],
          deadTokens: [{ userId: 'u1', token: 'ios-tok' }],
        }),
    };
    const webPush: PushSender = {
      send: () =>
        okAsync({
          successCount: 2,
          failureCount: 0,
          deliveredTokens: [{ userId: 'u4', token: 'https://push/live' }],
          deadTokens: [{ userId: 'u2', token: 'https://push/aaa' }],
        }),
    };
    const sender = createCompositePushSender({ fcm, webPush, deriveCollapseKey: stubDerive() });

    const result = await sender.send(
      message([ios('u1', 'ios-tok'), web('u2', 'https://push/aaa')])
    );

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 3,
      failureCount: 1,
      deliveredTokens: [
        { userId: 'u3', token: 'ios-live' },
        { userId: 'u4', token: 'https://push/live' },
      ],
      deadTokens: [
        { userId: 'u1', token: 'ios-tok' },
        { userId: 'u2', token: 'https://push/aaa' },
      ],
    });
  });

  it('folds a partition that reports neither delivered nor dead targets', async () => {
    const bare: PushSender = { send: () => okAsync({ successCount: 1, failureCount: 0 }) };
    const sender = createCompositePushSender({
      fcm: bare,
      webPush: bare,
      deriveCollapseKey: stubDerive(),
    });

    const result = await sender.send(
      message([ios('u1', 'ios-tok'), web('u2', 'https://push/aaa')])
    );

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 2,
      failureCount: 0,
      deliveredTokens: [],
      deadTokens: [],
    });
  });

  it('rejects a payload whose conversation id is malformed, before either transport is reached', async () => {
    const fcm = createMockPushSender();
    const webPush = createMockPushSender();
    const sender = createCompositePushSender({ fcm, webPush, deriveCollapseKey: stubDerive() });

    const result = await sender.send({
      recipients: [ios('u1', 'ios-tok'), web('u2', 'https://push/aaa')],
      payload: { category: 'message', conversationId: '../../etc/passwd' },
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(fcm.getSentMessages()).toEqual([]);
    expect(webPush.getSentMessages()).toEqual([]);
  });

  it('surfaces an unavailable error when alias derivation fails', async () => {
    const fcm = createMockPushSender();
    const webPush = createMockPushSender();
    const sender = createCompositePushSender({
      fcm,
      webPush,
      deriveCollapseKey: () => Promise.reject(new Error('subtle crypto unavailable')),
    });

    const result = await sender.send(message([ios('u1', 'ios-tok')]));

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(fcm.getSentMessages()).toEqual([]);
  });
});
