import { test, expect } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage, SidebarPage } from '../pages';
import { TIMEOUTS } from '../config/timeouts.js';
import { E2E_MODELS } from '../../scripts/lib/e2e-model-ids.js';

/**
 * A reasoning-capable text model (structured `reasoning` catalog metadata →
 * the effort chip renders for it). Validated present in the live catalog at
 * `e2e:prepare`, like every E2E model id.
 */
const REASONING_MODEL_ID = E2E_MODELS.text[1];

test.describe('Chat Functionality', () => {
  test.describe('New Chat', () => {
    test('displays UI, creates conversation, receives response, appears once in sidebar', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      const sidebar = new SidebarPage(authenticatedPage);
      await chatPage.goto();

      await chatPage.expectNewChatPageVisible();
      await chatPage.expectPromptInputVisible();
      await chatPage.expectSuggestionChipsVisible();

      const uniqueId = `combined-new-${String(Date.now())}`;
      const testMessage = `Test ${uniqueId}`;
      await chatPage.sendNewChatMessage(testMessage);

      await chatPage.waitForConversation();
      await chatPage.expectMessageVisible(testMessage);

      await chatPage.waitForAIResponse();
      await chatPage.expectAssistantMessageContains('Echo:');

      await expect
        .poll(() => sidebar.countConversationsWithText(uniqueId), { timeout: TIMEOUTS.MODAL })
        .toBe(1);
    });
  });

  test.describe('Existing Conversation', () => {
    test('displays messages and accepts followup', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await expect(chatPage.messageInput).toBeVisible();
      await expect(chatPage.messageList).toBeVisible();

      const followupMessage = `Follow-up ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(followupMessage);
      await chatPage.expectMessageVisible(followupMessage);
    });

    test('send button re-enables after streaming completes', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      const firstMessage = `First followup ${String(Date.now())}`;
      await chatPage.messageInput.fill(firstMessage);

      await expect(chatPage.sendButton).toBeEnabled();
      await chatPage.sendButton.click();

      await chatPage.expectMessageVisible(firstMessage);
      await chatPage.waitForAIResponse(firstMessage);

      const secondMessage = `Second followup ${String(Date.now())}`;
      await chatPage.messageInput.fill(secondMessage);
      await chatPage.sendButton.click();

      await chatPage.expectMessageVisible(secondMessage);
      await chatPage.waitForAIResponse(secondMessage);
      // Button is disabled after streaming when input is empty (correct behavior)
    });
  });

  test.describe('Sidebar Actions', () => {
    // eslint-disable-next-line no-restricted-syntax -- serial: rename/delete/cancel-delete mutate the same shared Alice sidebar conversation list; concurrent runs cross-talk on the shared authenticated page.
    test.describe.configure({ mode: 'serial' });

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

      // Delete refreshes only the conversation list; it no longer cascades a
      // refetch into the deleted conversation's detail/messages queries, so no
      // 404 fires against the gone id — no error opt-out is needed.
      await sidebar.deleteConversation(testConversation.id);

      await expect(authenticatedPage).toHaveURL('/chat');
      await chatPage.expectNewChatPageVisible();
    });

    test('can cancel delete confirmation', async ({ authenticatedPage, testConversation }) => {
      const sidebar = new SidebarPage(authenticatedPage);

      await sidebar.cancelDelete(testConversation.id);

      await expect(authenticatedPage).toHaveURL(testConversation.url);
    });
  });

  test.describe('AI Response Streaming', () => {
    test('displays streaming AI response with reasoning effort after sending message', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.expectNewChatPageVisible();

      await test.step('chip hidden while only non-reasoning models are selected', async () => {
        // The image-generation selection carries no reasoning metadata, so the
        // effort chip must slide out entirely.
        await chatPage.switchToImageMode();
        await expect(chatPage.effortChip()).not.toBeVisible();
        await chatPage.switchToTextMode();
      });

      await test.step('select a reasoning model and the High effort level', async () => {
        await chatPage.selectSingleModel(REASONING_MODEL_ID);
        await expect(chatPage.effortChip()).toBeVisible();
        await chatPage.selectReasoningEffort('High');
      });

      const testMessage = `Echo test ${String(Date.now())}`;
      let conversationId = '';

      await test.step('send held open — thoughts stream into the glazed preview', async () => {
        // Hold parks the mock stream after its reasoning deltas and first
        // answer chunk, so the in-flight disclosure is assertable with zero
        // wall-clock racing.
        await chatPage.holdPrimaryStreamForNextSends();
        await chatPage.sendNewChatMessage(testMessage);
        conversationId = await chatPage.waitForConversation();
        await chatPage.waitForStreamingActive();

        const assistant = chatPage.messagesByRole('assistant').last();
        const disclosure = chatPage.thinkingDisclosureFor(assistant);
        await expect(disclosure).toBeVisible();
        await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosurePreview)).toContainText(
          'Reading the request'
        );
      });

      await test.step('expand the disclosure — full thoughts visible', async () => {
        const assistant = chatPage.messagesByRole('assistant').last();
        const disclosure = chatPage.thinkingDisclosureFor(assistant);
        await disclosure.getByTestId(TEST_IDS.thinkingDisclosureToggle).click();
        await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosureContent)).toContainText(
          'Ready to answer now.'
        );
      });

      await test.step('release the stream — answer arrives with cost', async () => {
        await chatPage.stopHoldingStreams();
        await chatPage.releaseHeldStream(conversationId);
        await chatPage.waitForAIResponse(testMessage);
        await chatPage.expectAssistantMessageContains('Echo:');
        await chatPage.expectMessageCostVisible();
      });

      await test.step('reload — persisted thoughts still render per message', async () => {
        await authenticatedPage.goto(`/chat/${conversationId}`, {
          waitUntil: 'domcontentloaded',
        });
        await chatPage.waitForConversationLoaded();

        const assistant = chatPage.messagesByRole('assistant').last();
        const disclosure = chatPage.thinkingDisclosureFor(assistant);
        await expect(disclosure).toBeVisible();
        await disclosure.getByTestId(TEST_IDS.thinkingDisclosureToggle).click();
        await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosureContent)).toContainText(
          'Reading the request'
        );
      });
    });
  });

  test.describe('Message Layout', () => {
    test('long unbroken strings do not push previous messages off screen', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      const firstMessage = chatPage.messageList
        .locator(`[data-testid="${TEST_IDS.messageItem}"]`)
        .first();
      const initialBoundingBox = await firstMessage.boundingBox();
      expect(initialBoundingBox).not.toBeNull();

      const longString = 'test'.repeat(50);
      await chatPage.sendFollowUpMessage(longString);

      await chatPage.waitForAIResponse(longString);

      const { scrollWidth, clientWidth } = await chatPage.getDocumentDimensions();
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      await expect(firstMessage).toBeAttached();

      // Re-issue scrollToTop each poll, not once: under a saturated mobile engine
      // a late post-stream re-render (Virtuoso re-measuring the long message's
      // height, the toolbar mounting) can re-pin the list to the bottom after a
      // single scroll, snapping the just-revealed first message back off-screen.
      // Keep scrolling up — what a user does — until it holds in view. A first
      // message that can never be scrolled into view (a real regression) never
      // satisfies the check and the poll times out.
      await expect(async () => {
        await chatPage.scrollToTop();
        await expect(firstMessage).toBeInViewport({ ratio: 0.5, timeout: TIMEOUTS.QUICK });
      }).toPass({ timeout: TIMEOUTS.STREAM_SATURATED });
    });

    test('long messages wrap properly without horizontal overflow', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }, testInfo) => {
      const chatPage = new ChatPage(authenticatedPage);

      const longString = 'a'.repeat(500);
      await chatPage.sendFollowUpMessage(longString);
      await chatPage.waitForAIResponse(longString);

      const overflowingElements = await chatPage.findOverflowingElements();
      if (overflowingElements.length > 0) {
        await testInfo.attach('overflowing-elements', {
          body: JSON.stringify(overflowingElements, null, 2),
          contentType: 'application/json',
        });
      }

      expect(
        overflowingElements.length,
        `Found ${String(overflowingElements.length)} overflowing elements:\n${overflowingElements.join('\n')}`
      ).toBe(0);

      const messageItem = chatPage.messageList
        .locator(`[data-testid="${TEST_IDS.messageItem}"]`)
        .last();
      await expect(messageItem).toBeVisible();
      const [messageBox, viewportWidth] = await Promise.all([
        messageItem.boundingBox(),
        chatPage.getViewportWidth(),
      ]);

      if (messageBox === null) throw new Error('Expected last message bounding box');
      expect(messageBox.width).toBeLessThanOrEqual(viewportWidth);
      expect(messageBox.x + messageBox.width).toBeLessThanOrEqual(viewportWidth);
    });
  });
});
