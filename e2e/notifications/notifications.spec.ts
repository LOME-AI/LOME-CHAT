import { test, expectConsoleErrors } from '../fixtures.js';
import { expect } from '../helpers/expect.js';
import { waitForAppStable } from '../helpers/page-signals.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { SidebarPage } from '../pages/index.js';
import {
  ALL_NOTIFICATIONS_ON,
  EXPECTED_NOTIFICATION_COPY,
  PUSH_API_INCOGNITO_CONSOLE_ERROR,
  allowNotifications,
  deliverPush,
  deliveredNotifications,
  enableOffer,
  gotoWithPreferences,
  leaveApp,
  notificationPermission,
  reloadWithPreferences,
  savedPreference,
  saveNotificationPreferences,
  returnToApp,
  waitForPushServiceWorker,
} from './push-harness.js';

/**
 * Browser notifications end to end: the one-time offer, what the settings card
 * saves, and what the service worker does with a delivered push.
 *
 * Chromium-only, and on the full browser rather than the headless shell: the
 * shell has no notification backend at all, so it answers `denied` to every
 * permission grant and refuses `showNotification`. The full binary ships with
 * the same `chromium` install the suite already performs.
 *
 * Three things this cannot reach, all covered by unit tests instead:
 * `PushManager.subscribe()` needs a live push service (no browser in this
 * harness will issue a subscription); a notification click has no programmatic
 * trigger in any browser or protocol; and the rule that a push is dropped while
 * a window of the app is focused on that same conversation cannot be stated
 * deterministically here (see `leaveApp`).
 *
 * Every test states the account preferences it depends on through the API
 * first, so it holds whatever a sibling left behind.
 */
test.use({ channel: 'chromium' });

test.describe('Notifications', { tag: '@chromium-only' }, () => {
  // The conversation the worker is asked to notify about. It is an id and
  // nothing more — the worker never looks one up — and deliberately not one of
  // the signed-in user's, so the app's dismiss-on-read tidying can never close
  // a notification this suite is about to assert on.
  const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

  test('offers notifications once, and remembers "Later" on this device', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    await saveNotificationPreferences(authenticatedRequest, ALL_NOTIFICATIONS_ON);

    await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
    await waitForAppStable(authenticatedPage);

    // The offer lives in the sidebar body, and the sidebar remembers being
    // collapsed, so a fresh profile lands on the rail. Expanding it is the
    // step a person takes to reach anything the sidebar holds.
    const sidebar = new SidebarPage(authenticatedPage);
    await sidebar.ensureSidebarExpanded();

    const offer = enableOffer(authenticatedPage);
    await expect(offer).toBeVisible();
    // It announces; it never takes the cursor out of the composer.
    await expect(offer.getByRole('button', { name: 'Enable' })).not.toBeFocused();
    await expect(offer.getByRole('button', { name: 'Later' })).not.toBeFocused();

    await offer.getByRole('button', { name: 'Later' }).click();
    await expect(offer).toBeHidden();

    // "Later" is permanent on this device: the app asks the account again on
    // the next load and still declines to offer.
    await reloadWithPreferences(authenticatedPage);
    await waitForAppStable(authenticatedPage);
    // Expanded again rather than assumed: the assertion below only means
    // something while the place the offer would render is on screen.
    await sidebar.ensureSidebarExpanded();
    await expect(offer).toBeHidden();
  });

  test('takes the browser permission from the offer and registers the push service worker', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    await saveNotificationPreferences(authenticatedRequest, ALL_NOTIFICATIONS_ON);
    expectConsoleErrors(authenticatedPage, [PUSH_API_INCOGNITO_CONSOLE_ERROR]);

    await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
    await waitForAppStable(authenticatedPage);
    await new SidebarPage(authenticatedPage).ensureSidebarExpanded();

    const offer = enableOffer(authenticatedPage);
    await expect(offer).toBeVisible();

    // The browser's answer is staged before the click, because the platform
    // prompt the click raises is chrome no test can operate.
    await allowNotifications(authenticatedPage);
    await offer.getByRole('button', { name: 'Enable' }).click();

    await expect
      .poll(async () => notificationPermission(authenticatedPage), { timeout: TIMEOUTS.ASSERT })
      .toBe('granted');
    await waitForPushServiceWorker(authenticatedPage);
    await expect(offer).toBeHidden();

    // Answered platforms are never asked again.
    await reloadWithPreferences(authenticatedPage);
    await waitForAppStable(authenticatedPage);
    await expect(offer).toBeHidden();
  });

  test('shows one generic, content-free notification for a push that arrives while the app is not open', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    await saveNotificationPreferences(authenticatedRequest, ALL_NOTIFICATIONS_ON);
    expectConsoleErrors(authenticatedPage, [PUSH_API_INCOGNITO_CONSOLE_ERROR]);

    await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
    await allowNotifications(authenticatedPage);
    // An already-permitted device registers its worker on its own at app start.
    await reloadWithPreferences(authenticatedPage);
    await waitForAppStable(authenticatedPage);
    await waitForPushServiceWorker(authenticatedPage);

    await leaveApp(authenticatedPage);
    await deliverPush(authenticatedPage, {
      category: 'message',
      conversationId: CONVERSATION_ID,
    });
    await returnToApp(authenticatedPage, '/chat');
    await expect
      .poll(async () => deliveredNotifications(authenticatedPage), { timeout: TIMEOUTS.ASSERT })
      .toEqual([{ ...EXPECTED_NOTIFICATION_COPY.message, tag: CONVERSATION_ID }]);

    // A second event in the same conversation replaces the first rather than
    // stacking: notifications are tagged by conversation, so someone who was
    // away for an hour comes back to one line per conversation.
    await leaveApp(authenticatedPage);
    await deliverPush(authenticatedPage, {
      category: 'runCompletion',
      conversationId: CONVERSATION_ID,
    });
    await returnToApp(authenticatedPage, '/chat');
    await expect
      .poll(async () => deliveredNotifications(authenticatedPage), { timeout: TIMEOUTS.ASSERT })
      .toEqual([{ ...EXPECTED_NOTIFICATION_COPY.runCompletion, tag: CONVERSATION_ID }]);

    // Nothing a person can read names the conversation it came from.
    for (const notification of await deliveredNotifications(authenticatedPage)) {
      expect(`${notification.title} ${notification.body}`).not.toContain(notification.tag);
    }
  });

  test('saves every notification preference to the account, and turning them all off retires the offer', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    await saveNotificationPreferences(authenticatedRequest, ALL_NOTIFICATIONS_ON);

    // `/settings` emits no app-stability signal — that one belongs to the chat
    // index — so the card's own arrival is the gate: the preferences read lands,
    // then the switches replace the loading block.
    await gotoWithPreferences(authenticatedPage, '/settings');
    const globalSwitch = authenticatedPage.getByRole('switch', { name: 'All notifications' });
    await expect(globalSwitch).toBeVisible();

    const categorySwitch = authenticatedPage.getByRole('switch', { name: 'Finished runs' });
    await expect(categorySwitch).toBeChecked();
    await categorySwitch.click();
    await expect
      .poll(async () => savedPreference(authenticatedRequest, 'runCompletion'), {
        timeout: TIMEOUTS.API_SETUP,
      })
      .toBe(false);

    // Quiet hours arrive as a whole window or not at all — the card has no way
    // to write half of one.
    await authenticatedPage.getByRole('switch', { name: 'Quiet hours' }).click();
    await expect
      .poll(async () => savedPreference(authenticatedRequest, 'quietHours'), {
        timeout: TIMEOUTS.API_SETUP,
      })
      .toEqual({ startMinutes: 22 * 60, endMinutes: 7 * 60, timezone: 'UTC' });

    await authenticatedPage.getByRole('combobox', { name: 'From' }).click();
    await authenticatedPage.getByRole('option', { name: '23:00' }).click();
    await expect
      .poll(async () => savedPreference(authenticatedRequest, 'quietHours'), {
        timeout: TIMEOUTS.API_SETUP,
      })
      .toEqual({ startMinutes: 23 * 60, endMinutes: 7 * 60, timezone: 'UTC' });

    await globalSwitch.click();
    await expect
      .poll(async () => savedPreference(authenticatedRequest, 'globalEnabled'), {
        timeout: TIMEOUTS.API_SETUP,
      })
      .toBe(false);

    // With the account switch off there is nothing to offer this device.
    await gotoWithPreferences(authenticatedPage, '/chat');
    await waitForAppStable(authenticatedPage);
    // The sidebar is opened first so the absence below is the account switch
    // talking, not a collapsed rail hiding the offer either way.
    await new SidebarPage(authenticatedPage).ensureSidebarExpanded();
    await expect(enableOffer(authenticatedPage)).toBeHidden();

    // The account is a pooled persona shared with every other suite: hand it
    // back in the state it was found in, which is also the state a new account
    // starts in. This is the only test that leaves preferences off.
    await saveNotificationPreferences(authenticatedRequest, ALL_NOTIFICATIONS_ON);
  });
});
