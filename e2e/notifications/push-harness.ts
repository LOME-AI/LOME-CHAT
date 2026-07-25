import { TIMEOUTS } from '../config/timeouts.js';
import { expect } from '../helpers/expect.js';
import type { NotificationCategory, PushEventPayload } from '@hushbox/shared';
import type { APIRequestContext, CDPSession, Locator, Page } from '@playwright/test';

/**
 * Browser-notification plumbing for the notifications suite: the account
 * preferences read/write, the one-time offer's locator, permission and
 * service-worker state, leaving and returning to the app, and push delivery.
 *
 * Delivery is injected through the Chrome DevTools Protocol
 * (`ServiceWorker.deliverPushMessage`), which hands the payload to the real
 * registered worker exactly as a push service would — so the shipped worker
 * runs its own validation, copy, tag and focus rules. The hop the injection
 * replaces (sender → push service → browser) is deliberately not exercised
 * here: it needs a live third party, which the suite forbids.
 *
 * Raw evaluation and protocol calls live in this module, never in the spec.
 */

/** The account-level preference view, as the API reads and writes it. */
export interface NotificationPreferences {
  readonly globalEnabled: boolean;
  readonly messages: boolean;
  readonly runCompletion: boolean;
  readonly membership: boolean;
  readonly quietHours: {
    readonly startMinutes: number;
    readonly endMinutes: number;
    readonly timezone: string;
  } | null;
}

/** Everything on, no quiet window — the state a fresh account starts in. */
export const ALL_NOTIFICATIONS_ON: NotificationPreferences = {
  globalEnabled: true,
  messages: true,
  runCompletion: true,
  membership: true,
  quietHours: null,
};

/**
 * The exact words a delivered notification may carry, stated here as the
 * suite's own expectation rather than imported from the worker: this is the
 * test of what a person actually reads, and a copy table that supplied both
 * sides would agree with itself no matter what it said.
 */
export const EXPECTED_NOTIFICATION_COPY: Record<
  NotificationCategory,
  { readonly title: string; readonly body: string }
> = {
  message: { title: 'New message', body: 'You have a new message.' },
  runCompletion: { title: 'Response ready', body: 'A response is ready to view.' },
  membership: { title: 'Conversation update', body: 'A conversation you are in was updated.' },
};

/**
 * Chromium's own refusal to hand out a push subscription in an incognito
 * profile, which every Playwright browser context is. The browser logs it as a
 * console error the moment the app calls `pushManager.subscribe()`, so any test
 * that drives the registration path has to allow it — it is browser chrome, not
 * an app fault, and the app's rejected subscribe is handled (the permission and
 * the registered worker are what the suite asserts on instead).
 */
export const PUSH_API_INCOGNITO_CONSOLE_ERROR = /does not support the Push API in incognito/;

/** Write the account preferences straight through the API (rule 4.2). */
export async function saveNotificationPreferences(
  request: APIRequestContext,
  preferences: NotificationPreferences
): Promise<void> {
  const response = await request.put('/notifications/preferences', { data: preferences });
  if (!response.ok()) {
    throw new Error(`notification preferences write failed: ${String(response.status())}`);
  }
}

/** Server truth for the account's preferences — the oracle for every UI change. */
export async function fetchNotificationPreferences(
  request: APIRequestContext
): Promise<NotificationPreferences> {
  const response = await request.get('/notifications/preferences');
  if (!response.ok()) {
    throw new Error(`notification preferences read failed: ${String(response.status())}`);
  }
  return (await response.json()) as NotificationPreferences;
}

/** One saved preference field — the poll-friendly projection of the account view. */
export async function savedPreference<Field extends keyof NotificationPreferences>(
  request: APIRequestContext,
  field: Field
): Promise<NotificationPreferences[Field]> {
  const preferences = await fetchNotificationPreferences(request);
  return preferences[field];
}

/**
 * The one-time offer to turn notifications on for this device.
 *
 * The app shell holds two `status` regions (this offer and the activity
 * announcer) and the offer carries no accessible name of its own, so it is
 * addressed by the answers inside it — the two buttons no other live region
 * has.
 */
export function enableOffer(page: Page): Locator {
  return page
    .getByRole('status')
    .filter({ has: page.getByRole('button', { name: 'Enable' }) })
    .filter({ has: page.getByRole('button', { name: 'Later' }) });
}

/**
 * Answer the browser's permission prompt with "allow" for this origin. Staged
 * from the harness rather than clicked, because the platform prompt is browser
 * chrome that no test can reach.
 */
export async function allowNotifications(page: Page): Promise<void> {
  await page.context().grantPermissions(['notifications'], {
    origin: new URL(page.url()).origin,
  });
}

/** What the page believes the platform has decided. */
export async function notificationPermission(page: Page): Promise<string> {
  return page.evaluate(() => Notification.permission);
}

interface PushChannel {
  readonly session: CDPSession;
  readonly registrationId: string;
  readonly origin: string;
}

const channels = new WeakMap<Page, Promise<PushChannel>>();

async function openPushChannel(page: Page): Promise<PushChannel> {
  const origin = new URL(page.url()).origin;
  const session = await page.context().newCDPSession(page);
  const live = new Set<string>();
  // Registered before enabling the domain: the browser reports every existing
  // registration in response to `enable`, and a listener attached afterwards
  // would miss the app's worker entirely.
  session.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    for (const registration of registrations) {
      if (registration.isDeleted || !registration.scopeURL.startsWith(origin)) {
        live.delete(registration.registrationId);
      } else {
        live.add(registration.registrationId);
      }
    }
  });
  await session.send('ServiceWorker.enable');
  await expect.poll(() => live.size, { timeout: TIMEOUTS.API_SETUP }).toBe(1);
  const [registrationId] = [...live];
  if (registrationId === undefined) throw new Error('no service worker registration to push to');
  return { session, registrationId, origin };
}

/** The delivery channel for this page's worker, opened once and reused. */
async function pushChannel(page: Page): Promise<PushChannel> {
  const opening = channels.get(page) ?? openPushChannel(page);
  channels.set(page, opening);
  return opening;
}

/**
 * Hand a push payload to the app's registered service worker as the push
 * service would. The worker parses, validates and acts on it unaided.
 */
export async function deliverPush(page: Page, payload: PushEventPayload): Promise<void> {
  const channel = await pushChannel(page);
  await channel.session.send('ServiceWorker.deliverPushMessage', {
    origin: channel.origin,
    registrationId: channel.registrationId,
    data: JSON.stringify(payload),
  });
}

/** The script URL of the activated worker, or `null` while none is running. */
export async function activeServiceWorkerUrl(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.scriptURL ?? null;
  });
}

/**
 * Block until the app has registered and activated its push worker, and until
 * that worker is addressable for delivery. The delivery channel is opened here
 * because it is bound to the app's own tab: it has to exist before a test
 * navigates that tab away from the app to be pushed to.
 */
export async function waitForPushServiceWorker(page: Page): Promise<void> {
  await expect
    .poll(async () => activeServiceWorkerUrl(page), { timeout: TIMEOUTS.API_SETUP })
    .toContain('/sw.js');
  await pushChannel(page);
}

/**
 * Load a page and wait for the preferences read that decides whether the offer
 * is shown, so "still hidden" is a verdict the app has actually reached rather
 * than a screen it has not drawn yet.
 */
async function loadWithPreferences(page: Page, load: () => Promise<unknown>): Promise<void> {
  const preferences = page.waitForResponse(
    (response) =>
      response.url().includes('/notifications/preferences') &&
      response.request().method() === 'GET',
    { timeout: TIMEOUTS.API_SETUP }
  );
  await load();
  await preferences;
}

/** Reload, waiting for the offer's deciding read. See {@link loadWithPreferences}. */
export async function reloadWithPreferences(page: Page): Promise<void> {
  await loadWithPreferences(page, () => page.reload({ waitUntil: 'domcontentloaded' }));
}

/** Navigate, waiting for the offer's deciding read. See {@link loadWithPreferences}. */
export async function gotoWithPreferences(page: Page, path: string): Promise<void> {
  await loadWithPreferences(page, () => page.goto(path, { waitUntil: 'domcontentloaded' }));
}

/**
 * Leave the app — no window of it is open any more, the state someone is in
 * when a push is the only thing that can reach them.
 *
 * This, rather than "another window is in front", is how the suite states
 * "away". The worker withholds a notification only from a window focused on the
 * conversation it is about, and which window the host considers focused is not
 * something a run can promise while a parallel matrix drives several browsers at once — both
 * directions of that were seen to flip under load, and focus emulation does not
 * reach the worker's view. With no window of the app open at all there is
 * nothing to be focused and the outcome is fixed. The app-in-front half of the
 * rule is left to the worker's own unit tests rather than raced here.
 *
 * The delivery channel must already be open (see {@link waitForPushServiceWorker});
 * it survives the navigation, since it is bound to the tab and not the page.
 */
export async function leaveApp(page: Page): Promise<void> {
  await page.goto('about:blank');
}

/** Come back to the app, where the delivered notifications can be read. */
export async function returnToApp(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
}

/** One notification as the person would see it in the shade. */
export interface DeliveredNotification {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

/**
 * Everything the worker is currently showing, ordered by tag so the assertion
 * does not rest on the browser's undocumented listing order.
 */
export async function deliveredNotifications(page: Page): Promise<DeliveredNotification[]> {
  const shown = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration === undefined) return [];
    const notifications = await registration.getNotifications();
    return notifications.map((notification) => ({
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
    }));
  });
  return shown.toSorted((left, right) => left.tag.localeCompare(right.tag));
}
