import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { TEST_IDS, WEB_SEARCH_STORAGE_KEY } from '@hushbox/shared';
import { ChatPage } from '../pages';
import { requireEnv } from '../helpers/env.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { Page } from '../fixtures.js';

const apiUrl = requireEnv('VITE_API_URL');

/**
 * The 6th send in a trial session deliberately trips the daily cap. The
 * resulting 429 from POST /chat/trial is the behavior under test, not a
 * regression — silence it on the page's allow-list so the default guard
 * (`fixtures.ts:455-459`) doesn't fire at teardown. Patterns split into
 * status-line + body-code matches the `account-deletion.spec.ts` convention;
 * combining them with `.*` doesn't work because the captured entry is
 * multi-line and `.` doesn't cross `\n`.
 */
function allowTrialRateLimitErrors(page: Page): void {
  expectApiErrors(page, [
    /429 Too Many Requests POST .*\/chat\/trial/,
    /"code":"TRIAL_LIMIT_REACHED"/,
  ]);
  expectConsoleErrors(page, [/Failed to load resource: .*status of 429/]);
}

// All trial chat tests share localhost IP for rate limiting - run only on chromium, serially.
// @chromium-only gates these to the chromium project (config grepInvert excludes the tag
// from every other project), replacing the former in-body project-name skip.
test.describe('Trial Chat', { tag: '@chromium-only' }, () => {
  // eslint-disable-next-line no-restricted-syntax -- serial: every trial test shares the same localhost IP whose per-day trial cap is the behavior under test; concurrent runs would consume each other's allowance.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    const response = await request.delete(`${apiUrl}/dev/trial-usage`);
    expect(response.ok()).toBe(true);
  });
  test.describe('New Chat Page', () => {
    test('displays new chat UI with focused prompt input', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();

      await chatPage.expectNewChatPageVisible();
      await chatPage.expectPromptInputVisible();
      await chatPage.expectSuggestionChipsVisible();

      await expect(chatPage.promptInput).toBeEnabled({ timeout: TIMEOUTS.MODAL });
      await expect(chatPage.promptInput).toBeFocused({ timeout: TIMEOUTS.QUICK });
    });
  });

  test.describe('Chat Streaming', () => {
    test('trial user can send message and receive response', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      // Regression guard: a web-search preference persists across sign-out and the
      // trial toggle can't clear it. It must not reserve the worst-case search cost
      // (≈5.75¢, far above the 1¢ trial cap) and gate trial sends with
      // "This message is too costly for the free trial."
      await unauthenticatedPage.addInitScript((storageKey) => {
        globalThis.localStorage.setItem(
          storageKey,
          JSON.stringify({ state: { webSearchEnabled: true }, version: 0 })
        );
      }, WEB_SEARCH_STORAGE_KEY);
      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      const testMessage = `Trial test ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);

      await expect(unauthenticatedPage).toHaveURL('/chat/trial');
      await expect(chatPage.messageList).toBeVisible({ timeout: TIMEOUTS.MODAL });
      await chatPage.expectMessageVisible(testMessage);
      await chatPage.waitForAIResponse();
      await chatPage.expectAssistantMessageContains('Echo:');

      await expect(chatPage.messageInput).toBeVisible();
      await expect(chatPage.messageInput).toBeEnabled();
    });

    test('trial user can have multi-turn conversation', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      const firstMessage = `Trial first ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(firstMessage);
      await expect(chatPage.messageList).toBeVisible({ timeout: TIMEOUTS.MODAL });
      await chatPage.waitForAIResponse();

      const secondMessage = `Trial second ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(secondMessage);
      await chatPage.expectMessageVisible(secondMessage);
    });
  });

  test.describe('Rate Limiting', () => {
    test.beforeEach(async ({ request }) => {
      const response = await request.delete(`${apiUrl}/dev/trial-usage`);
      expect(response.ok()).toBe(true);
    });

    test('shows rate limit message after 5 messages', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      allowTrialRateLimitErrors(unauthenticatedPage);

      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      for (let index = 1; index <= 5; index++) {
        const message = `Rate limit test ${String(index)} ${String(Date.now())}`;
        if (index === 1) {
          await chatPage.sendNewChatMessage(message);
          await expect(chatPage.messageList).toBeVisible({ timeout: TIMEOUTS.MODAL });
        } else {
          await chatPage.sendFollowUpMessage(message);
        }
        await chatPage.waitForAIResponse(message, TIMEOUTS.MEDIA_DECODE);
      }

      // Don't use sendFollowUpMessage - rate limiting prevents input from clearing
      const rateLimitMessage = `Rate limit trigger ${String(Date.now())}`;
      await chatPage.messageInput.fill(rateLimitMessage);
      await chatPage.messageInput.press('Enter');

      // Rate limit shows inline message instead of modal
      await expect(unauthenticatedPage.getByText(/5 free messages/i)).toBeVisible({
        timeout: TIMEOUTS.ASSERT,
      });
      await expect(unauthenticatedPage.getByText(/continue chatting/i)).toBeVisible();
    });

    test('input is disabled after rate limit', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      allowTrialRateLimitErrors(unauthenticatedPage);

      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      for (let index = 1; index <= 5; index++) {
        const message = `Disable test ${String(index)} ${String(Date.now())}`;
        if (index === 1) {
          await chatPage.sendNewChatMessage(message);
          await expect(chatPage.messageList).toBeVisible({ timeout: TIMEOUTS.MODAL });
        } else {
          await chatPage.sendFollowUpMessage(message);
        }
        await chatPage.waitForAIResponse(message, TIMEOUTS.MEDIA_DECODE);
      }

      // Don't use sendFollowUpMessage - rate limiting prevents input from clearing
      const rateLimitMessage = `Disable trigger ${String(Date.now())}`;
      await chatPage.messageInput.fill(rateLimitMessage);
      await chatPage.messageInput.press('Enter');

      await expect(unauthenticatedPage.getByText(/You've used all 5 free messages/i)).toBeVisible({
        timeout: TIMEOUTS.ASSERT,
      });
      await expect(chatPage.messageInput).toBeDisabled();
    });
  });

  test.describe('Premium Model Access', () => {
    test('shows signup modal when trial user clicks premium model', async ({
      unauthenticatedPage,
    }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      const signupModal = unauthenticatedPage.getByTestId(TEST_IDS.signupModal);

      await chatPage.goto();

      const modelSelector = unauthenticatedPage.getByTestId(TEST_IDS.modelSelectorButton);
      await expect(modelSelector).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await modelSelector.click();

      const modal = unauthenticatedPage.getByTestId(TEST_IDS.modelSelectorModal);
      await expect(modal).toBeVisible({ timeout: TIMEOUTS.MODAL });

      const premiumModel = chatPage.lockedModelItems().first();
      await expect(premiumModel).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      // Single click on a premium row triggers onPremiumClick now that the
      // dual-zone (focus vs commit) pattern was removed in the picker rewrite.
      await premiumModel.getByRole('button').first().click();

      await expect(signupModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
      const heading = signupModal.getByRole('heading');
      await expect(heading).toContainText(/premium/i);
    });
  });
});
