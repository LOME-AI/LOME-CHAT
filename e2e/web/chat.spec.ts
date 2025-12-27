import { test, expect } from '../fixtures.js';
import { ChatPage, SidebarPage } from '../pages';

test.describe('Chat Functionality', () => {
  test.describe('New Chat', () => {
    test('displays new chat page with greeting and input', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();

      await chatPage.expectNewChatPageVisible();
      await chatPage.expectPromptInputVisible();
      await chatPage.expectSuggestionChipsVisible();
    });

    test('creates conversation when sending first message', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();

      const testMessage = `New chat test ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);

      await chatPage.waitForConversation();
      await chatPage.expectMessageVisible(testMessage);
    });
  });

  test.describe('Existing Conversation', () => {
    test('displays existing conversation with messages', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);

      // testConversation fixture already created a conversation and navigated to it
      // Verify the message input is visible
      await expect(chatPage.messageInput).toBeVisible();

      // The fixture creates a message starting with "Fixture setup"
      await expect(chatPage.messageList).toBeVisible();
    });

    test('can send additional messages', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      const followupMessage = `Follow-up ${String(Date.now())}`;

      await chatPage.sendFollowUpMessage(followupMessage);
      await chatPage.expectMessageVisible(followupMessage);
    });
  });

  test.describe('Sidebar Actions', () => {
    test('shows conversation in sidebar', async ({ authenticatedPage, testConversation }) => {
      const sidebar = new SidebarPage(authenticatedPage);
      await sidebar.expectConversationVisible(testConversation.id);
    });

    test('can rename conversation via dropdown menu', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const sidebar = new SidebarPage(authenticatedPage);

      await sidebar.renameConversation(testConversation.id, 'My Renamed Conversation');
      await sidebar.expectConversationTitle(testConversation.id, 'My Renamed Conversation');
    });

    test('can delete conversation via dropdown menu', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      const sidebar = new SidebarPage(authenticatedPage);

      await sidebar.deleteConversation(testConversation.id);

      // Should navigate back to /chat (new chat page)
      await expect(authenticatedPage).toHaveURL('/chat');
      await chatPage.expectNewChatPageVisible();
    });

    test('can cancel delete confirmation', async ({ authenticatedPage, testConversation }) => {
      const sidebar = new SidebarPage(authenticatedPage);

      await sidebar.cancelDelete(testConversation.id);

      // Should still be on the same URL
      await expect(authenticatedPage).toHaveURL(testConversation.url);
    });
  });
});
