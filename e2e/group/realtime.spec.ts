import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';
import { setupRealtimePair } from '../helpers/realtime.js';
import {
  hasAppBadgeApi,
  hasWindowFocus,
  installAppBadgeSpy,
  lastAppBadgeCall,
  minimizeAndBlurWindow,
  restoreAndFocusWindow,
} from '../helpers/window-attention.js';
import { TIMEOUTS } from '../config/timeouts.js';

/** The app's own title, and the stem every unread prefix is added to. */
const APP_TITLE = 'HushBox';

test.describe('Real-time WebSocket events', () => {
  test('user-only message appears for other member in real time', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    const { aliceChatPage, bobChatPage } = await setupRealtimePair(
      authenticatedPage,
      testBobPage,
      groupConversation.id
    );

    // Alice toggles AI off (avoids waiting for streaming)
    const aiToggle = aliceChatPage.getAiToggleButton();
    await aiToggle.click();
    await expect(aiToggle).toHaveAccessibleName(/AI response off/);

    const timestamp = String(Date.now());
    const testMessage = `Realtime test ${timestamp}`;
    await aliceChatPage.sendFollowUpMessage(testMessage);

    await aliceChatPage.expectMessageVisible(testMessage);

    // Bob sees Alice's message appear WITHOUT refresh (via WebSocket)
    await expect(bobChatPage.messageList.getByText(testMessage).first()).toBeVisible({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });
  });

  test('AI streaming: Bob sees Alice user message immediately and AI response progressively', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    test.slow();
    const { aliceChatPage, bobChatPage } = await setupRealtimePair(
      authenticatedPage,
      testBobPage,
      groupConversation.id
    );

    const timestamp = String(Date.now());
    const testMessage = `AI test ${timestamp}`;
    await aliceChatPage.sendFollowUpMessage(testMessage);

    // Bob sees Alice's user message appear (via message:new with content — phantom)
    await expect(bobChatPage.messageList.getByText(testMessage).first()).toBeVisible({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });

    // Bob sees an assistant message element appear (via message:stream — phantom AI)
    await expect(bobChatPage.messagesByRole('assistant').last()).toBeVisible({
      timeout: TIMEOUTS.STREAM,
    });

    await aliceChatPage.waitForAIResponse(testMessage);

    // Bob sees complete AI "Echo:" response (phantoms replaced by real messages via message:complete)
    await expect(bobChatPage.messageList.getByText('Echo:').last()).toBeVisible({
      timeout: TIMEOUTS.STREAM,
    });
  });

  // Chromium-only: looking away is staged over the DevTools Protocol, which no
  // other engine speaks (see the window-attention helper).
  test(
    'a message arriving while the user is looking away raises the unread title and app badge, and returning clears both',
    {
      tag: '@chromium-only',
    },
    async ({ authenticatedPage, testBobPage, groupConversation }) => {
      await installAppBadgeSpy(authenticatedPage.context());

      const { bobChatPage } = await setupRealtimePair(
        authenticatedPage,
        testBobPage,
        groupConversation.id
      );

      // Bob turns AI off: an assistant reply would be a second countable arrival
      // and the unread count would depend on which one landed first.
      const bobAiToggle = bobChatPage.getAiToggleButton();
      await bobAiToggle.click();
      await expect(bobAiToggle).toHaveAccessibleName(/AI response off/);

      await expect(authenticatedPage).toHaveTitle(APP_TITLE);
      // The app badges only where the platform offers one, so a browser without
      // the API would silently make the badge half of this test vacuous.
      await expect.poll(() => hasAppBadgeApi(authenticatedPage)).toBe(true);

      // Alice looks away. Asserted rather than assumed: everything below is about
      // what the app does while unfocused, so a page that kept focus would fail
      // on the consequences and say nothing about the cause.
      await minimizeAndBlurWindow(authenticatedPage);
      await expect.poll(() => hasWindowFocus(authenticatedPage)).toBe(false);

      const testMessage = `Away message ${String(Date.now())}`;
      await bobChatPage.sendFollowUpMessage(testMessage);

      await expect(authenticatedPage).toHaveTitle(`(1) ${APP_TITLE}`);
      await expect
        .poll(() => lastAppBadgeCall(authenticatedPage))
        .toEqual({ kind: 'set', count: 1, settled: 'fulfilled' });

      // Alice comes back: a real focus event, and both signals stand down. Zero
      // routes through `clearAppBadge`, never `setAppBadge(0)`.
      await restoreAndFocusWindow(authenticatedPage);
      await expect.poll(() => hasWindowFocus(authenticatedPage)).toBe(true);

      await expect(authenticatedPage).toHaveTitle(APP_TITLE);
      await expect
        .poll(() => lastAppBadgeCall(authenticatedPage))
        .toEqual({ kind: 'clear', count: null, settled: 'fulfilled' });

      // The spy wrapped the platform API rather than standing in for it: the
      // capability the app checks for is still there, and the calls above were
      // settled by the real implementation behind it.
      await expect.poll(() => hasAppBadgeApi(authenticatedPage)).toBe(true);
    }
  );

  test('typing indicator shows for other member', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    // Both navigate to the group conversation (no DO wait needed for typing)
    const aliceChatPage = new ChatPage(authenticatedPage);
    const bobChatPage = new ChatPage(testBobPage);

    await aliceChatPage.gotoConversation(groupConversation.id);
    await bobChatPage.gotoConversation(groupConversation.id);

    await aliceChatPage.waitForConversationLoaded();
    await bobChatPage.waitForConversationLoaded();

    // Wait for WebSocket connections (both must be connected for typing events to flow)
    await aliceChatPage.waitForWebSocketConnected();
    await bobChatPage.waitForWebSocketConnected();

    await aliceChatPage.messageInput.fill('typing test');

    await expect(bobChatPage.getTypingIndicator()).toBeVisible({ timeout: TIMEOUTS.WS_HANDSHAKE });

    // Alice toggles AI off and submits (faster, no streaming)
    const aiToggle = aliceChatPage.getAiToggleButton();
    await aiToggle.click();
    await aliceChatPage.messageInput.press('Enter');

    await expect(bobChatPage.getTypingIndicator()).not.toBeVisible({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });
  });
});
