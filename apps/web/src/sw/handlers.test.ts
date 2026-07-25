import { describe, it, expect, vi } from 'vitest';
import { NOTIFICATION_COPY } from '@hushbox/shared';
import { handlePush, handleNotificationClick, handlePushSubscriptionChange } from './handlers.js';
import type {
  ServiceWorkerScope,
  WindowClientLike,
  PushEventLike,
  NotificationClickEventLike,
  PushSubscriptionChangeEventLike,
} from './handlers.js';

const VALID_ID = '0192f0c1-2222-7333-8444-555566667777';
const OTHER_ID = '0192f0c1-2222-7333-8444-555566667778';
const VIEWING_URL = `https://app.example/chat/${VALID_ID}`;

function makeClient(overrides: Partial<WindowClientLike> = {}): WindowClientLike {
  return {
    focused: false,
    url: 'https://app.example/chat',
    focus: vi.fn(() => Promise.resolve()),
    navigate: vi.fn(() => Promise.resolve()),
    postMessage: vi.fn(),
    ...overrides,
  };
}

function makeScope(
  overrides: {
    clients?: readonly WindowClientLike[];
    subscribe?: ReturnType<typeof vi.fn>;
    showNotification?: ReturnType<typeof vi.fn>;
    openWindow?: ReturnType<typeof vi.fn>;
  } = {}
): ServiceWorkerScope {
  const clients = overrides.clients ?? [];
  return {
    clients: {
      matchAll: vi.fn(() => Promise.resolve(clients)),
      openWindow: overrides.openWindow ?? vi.fn(() => Promise.resolve()),
    },
    registration: {
      showNotification: overrides.showNotification ?? vi.fn(() => Promise.resolve()),
      pushManager: {
        subscribe: overrides.subscribe ?? vi.fn(() => Promise.resolve({ toJSON: () => ({}) })),
      },
    },
    addEventListener: vi.fn(),
  } as unknown as ServiceWorkerScope;
}

function pushEvent(
  data: unknown,
  options: { throws?: boolean; empty?: boolean } = {}
): PushEventLike {
  return {
    waitUntil: vi.fn(),
    data: options.empty
      ? null
      : {
          json: options.throws
            ? () => {
                throw new SyntaxError('bad json');
              }
            : () => data,
        },
  };
}

describe('handlePush', () => {
  it('shows a generic notification when no client is focused', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [makeClient({ focused: false })] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalledWith(
      NOTIFICATION_COPY.message.title,
      expect.objectContaining({ body: NOTIFICATION_COPY.message.body, tag: VALID_ID })
    );
  });

  it('shows no notification while a focused client is viewing that conversation', async () => {
    const focused = makeClient({ focused: true, url: VIEWING_URL });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'runCompletion', conversationId: VALID_ID }));

    expect(showNotification).not.toHaveBeenCalled();
  });

  it('shows the notification when the focused client is viewing another conversation', async () => {
    const focused = makeClient({ focused: true, url: `https://app.example/chat/${OTHER_ID}` });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalled();
  });

  it('shows the notification when the focused client is on an unrelated page', async () => {
    const focused = makeClient({ focused: true, url: 'https://app.example/blog/some-post' });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalled();
  });

  it('shows the notification when the client on that conversation is not focused', async () => {
    const background = makeClient({ focused: false, url: VIEWING_URL });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [background] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalled();
  });

  it('does not mistake a longer path segment for the conversation being viewed', async () => {
    const focused = makeClient({ focused: true, url: `https://app.example/chat/${VALID_ID}-copy` });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalled();
  });

  it('hands the client viewing that conversation nothing', async () => {
    const focused = makeClient({ focused: true, url: VIEWING_URL });
    const scope = makeScope({ clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'runCompletion', conversationId: VALID_ID }));

    expect(focused.postMessage).not.toHaveBeenCalled();
  });

  it('drops a push with no data', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    await handlePush(scope, pushEvent(undefined, { empty: true }));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('drops a push whose data is not valid JSON', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    await handlePush(scope, pushEvent(undefined, { throws: true }));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('drops a push whose payload fails the shared schema (unknown key)', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    await handlePush(
      scope,
      pushEvent({ category: 'message', conversationId: VALID_ID, title: 'secret' })
    );
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('drops a push whose conversationId is not a uuid', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: '../etc' }));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('stores the validated payload as notification data for the click handler', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    const payload = { category: 'membership' as const, conversationId: VALID_ID };
    await handlePush(scope, pushEvent(payload));
    expect(showNotification).toHaveBeenCalledWith(
      NOTIFICATION_COPY.membership.title,
      expect.objectContaining({ data: payload })
    );
  });
});

function clickEvent(data: unknown): NotificationClickEventLike {
  return {
    waitUntil: vi.fn(),
    notification: { data, close: vi.fn() },
  };
}

describe('handleNotificationClick', () => {
  it('focuses and navigates an existing client to the deep link', async () => {
    const client = makeClient();
    const scope = makeScope({ clients: [client] });
    await handleNotificationClick(
      scope,
      clickEvent({ category: 'message', conversationId: VALID_ID })
    );

    expect(client.focus).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith(`/chat/${VALID_ID}`);
  });

  it('opens a new window when no client is available', async () => {
    const openWindow = vi.fn(() => Promise.resolve());
    const scope = makeScope({ clients: [], openWindow });
    await handleNotificationClick(
      scope,
      clickEvent({ category: 'message', conversationId: VALID_ID })
    );

    expect(openWindow).toHaveBeenCalledWith(`/chat/${VALID_ID}`);
  });

  it('closes the notification on click', async () => {
    const scope = makeScope({ clients: [] });
    const event = clickEvent({ category: 'message', conversationId: VALID_ID });
    await handleNotificationClick(scope, event);
    expect(event.notification.close).toHaveBeenCalled();
  });

  it('drops a click whose id is invalid (no navigation, no window)', async () => {
    const openWindow = vi.fn(() => Promise.resolve());
    const scope = makeScope({ clients: [], openWindow });
    await handleNotificationClick(
      scope,
      clickEvent({ category: 'message', conversationId: 'nope' })
    );
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('drops a click whose data is missing entirely', async () => {
    const openWindow = vi.fn(() => Promise.resolve());
    const scope = makeScope({ clients: [], openWindow });
    await handleNotificationClick(scope, clickEvent(null));
    expect(openWindow).not.toHaveBeenCalled();
  });
});

function subscriptionChangeEvent(
  applicationServerKey: ArrayBuffer | null
): PushSubscriptionChangeEventLike {
  return {
    waitUntil: vi.fn(),
    oldSubscription: applicationServerKey === null ? null : { options: { applicationServerKey } },
  };
}

describe('handlePushSubscriptionChange', () => {
  it('re-subscribes with the stored key and notifies open clients to re-register', async () => {
    const newSubscription = { toJSON: () => ({ endpoint: 'https://push/new' }) };
    const subscribe = vi.fn(() => Promise.resolve(newSubscription));
    const client = makeClient();
    const scope = makeScope({ subscribe, clients: [client] });
    const key = new Uint8Array([1, 2, 3]).buffer;

    await handlePushSubscriptionChange(scope, subscriptionChangeEvent(key));

    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
    expect(client.postMessage).toHaveBeenCalledWith({
      type: 'pushsubscriptionchange',
      subscription: { endpoint: 'https://push/new' },
    });
  });

  it('does nothing when there is no stored applicationServerKey', async () => {
    const subscribe = vi.fn(() => Promise.resolve({ toJSON: () => ({}) }));
    const scope = makeScope({ subscribe });
    await handlePushSubscriptionChange(scope, subscriptionChangeEvent(null));
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('resolves without rejecting and notifies no client when re-subscribe fails', async () => {
    const subscribe = vi.fn(() => Promise.reject(new Error('subscribe failed')));
    const client = makeClient();
    const scope = makeScope({ subscribe, clients: [client] });
    const key = new Uint8Array([1, 2, 3]).buffer;

    await expect(
      handlePushSubscriptionChange(scope, subscriptionChangeEvent(key))
    ).resolves.toBeUndefined();
    expect(client.postMessage).not.toHaveBeenCalled();
  });
});
