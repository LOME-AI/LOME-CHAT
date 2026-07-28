import { TEST_IDS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { BudgetHelper } from '../helpers/budget.js';
import { createWriteLinkWithBudget } from '../helpers/invite-link.js';
import { expectSharedConversationLoaded } from '../helpers/link-assertions.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Link Guest Chat', () => {
  test('write-privileged guest can send messages and get AI responses', async ({
    authenticatedPage,
    unauthenticatedPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    const helper = new BudgetHelper(authenticatedRequest);

    let inviteUrl: string;

    await test.step('create write-privileged invite link and setup budgets', async () => {
      await chatPage.gotoConversation(groupConversation.id);
      await chatPage.waitForConversationLoaded();

      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const result = await createWriteLinkWithBudget(authenticatedPage, sidebar, {
        helper,
        conversationId: groupConversation.id,
        withHistory: true,
        closeMethod: 'escape',
        displayName: 'Chat Guest',
      });
      inviteUrl = result.url;
      expect(inviteUrl).toContain('/share/c/');
      expect(inviteUrl).toContain('#');
    });

    const initialBalance = await helper.getBalance();

    await test.step('guest opens shared conversation and sees messages', async () => {
      await unauthenticatedPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });

      await expectSharedConversationLoaded(unauthenticatedPage);

      // Existing seeded messages should be visible (helper auto-scrolls if virtualised)
      const guestChatPage = new ChatPage(unauthenticatedPage);
      await guestChatPage.assertMessageVisible('Hello from Alice');
    });

    await test.step('guest does not see the premium payment prompt', async () => {
      await expect(unauthenticatedPage.getByText('Add credit')).not.toBeVisible();
      await expect(unauthenticatedPage.getByText('to unlock')).not.toBeVisible();
    });

    await test.step('guest sends message and receives AI response', async () => {
      const guestChatPage = new ChatPage(unauthenticatedPage);
      const guestInput = unauthenticatedPage.getByRole('textbox', { name: /message/i });
      await expect(guestInput).toBeVisible({ timeout: TIMEOUTS.MODAL });

      // Fill message first — send button requires text content to become enabled
      const guestMessage = `Guest says hello ${String(Date.now())}`;
      const spentBeforeFirst = await helper.getTotalSpent(groupConversation.id);
      await guestInput.fill(guestMessage);

      const sendButton = unauthenticatedPage.getByTestId(TEST_IDS.sendButton);
      await expect(sendButton).toBeEnabled({ timeout: TIMEOUTS.CONVERSATION_LOAD });
      await sendButton.click();

      await guestChatPage.assertMessageVisible(guestMessage);
      // Assert THIS turn's own echo, not a pre-existing "Echo:" from the seeded
      // history — otherwise a BALANCE_RESERVED error tile would satisfy the step.
      await guestChatPage.waitForAIResponse(guestMessage);

      // The owner-funded worst-case reservation is released in the post-stream
      // `finally` (stream-pipeline), AFTER the SSE `done` the client acted on.
      // Wait for this turn's spend to land before sending the next message: the
      // spend persists one step before the reservation release in that same
      // `finally`, so by the time this poll's round-trip observes it the release
      // has run — and two overlapping worst-case reservations can't trip the
      // cushion guard (402 BALANCE_RESERVED) against the modest budget.
      await expect
        .poll(() => helper.getTotalSpent(groupConversation.id), { timeout: TIMEOUTS.ASSERT })
        .toBeGreaterThan(spentBeforeFirst);
    });

    await test.step('guest selects a model and sends another message', async () => {
      const guestChatPage = new ChatPage(unauthenticatedPage);
      await guestChatPage.selectNonPremiumModel();

      const modelMessage = `Guest model test ${String(Date.now())}`;
      const guestInput = unauthenticatedPage.getByRole('textbox', { name: /message/i });
      await guestInput.fill(modelMessage);

      const sendButton = unauthenticatedPage.getByTestId(TEST_IDS.sendButton);
      await expect(sendButton).toBeEnabled({ timeout: TIMEOUTS.MODAL });
      await sendButton.click();

      await guestChatPage.assertMessageVisible(modelMessage);

      // Assert THIS turn's own echo (scoped to assistant role) so a
      // BALANCE_RESERVED error tile can't pass as a response.
      await guestChatPage.waitForAIResponse(modelMessage);
      // Sanity: React state knows about all 4 assistant messages
      await expect(guestChatPage.messageList).toHaveAttribute('data-assistant-count', '4', {
        timeout: TIMEOUTS.ASSERT,
      });
      // New nametag helper scrolls through every assistant message, so this
      // works even when Virtuoso virtualises earlier seeded messages.
      await guestChatPage.expectAllAIMessagesHaveNametag();
    });

    await test.step('owner balance decreased (owner-funded billing)', async () => {
      await expect
        .poll(
          async () => {
            const finalBalance = await helper.getBalance();
            return Number.parseFloat(finalBalance.balance);
          },
          { timeout: TIMEOUTS.ASSERT, intervals: [500, 1000, 2000] }
        )
        .toBeLessThan(Number.parseFloat(initialBalance.balance));
    });
  });
});
