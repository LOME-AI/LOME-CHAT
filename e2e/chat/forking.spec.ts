import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from '../pages/index.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Fork Lifecycle', () => {
  test('create first fork shows tab UI with Main and Fork 1', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('verify no fork tabs initially', async () => {
      await expect(chatPage.getForkTabList()).not.toBeVisible();
    });

    await test.step('hover AI message and click fork', async () => {
      await chatPage.clickFork(1);
    });

    await test.step('verify fork tabs appear with Main and Fork 1', async () => {
      await expect(chatPage.getForkTabList()).toBeVisible();
      await chatPage.expectForkTabCount(2);
      await expect(chatPage.getForkTab('Main')).toBeVisible();
      await expect(chatPage.getForkTab('Fork 1')).toBeVisible();
    });

    await test.step('verify Fork 1 is active', async () => {
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('verify URL has fork param', () => {
      const forkId = chatPage.getForkIdFromUrl();
      expect(forkId).not.toBeNull();
    });
  });

  test('switch between fork tabs shows different messages', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create fork from AI message', async () => {
      await chatPage.clickFork(1);
      await expect(chatPage.getForkTabList()).toBeVisible();
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('on Fork 1: send follow-up and wait for AI', async () => {
      const msg = `Fork 1 msg ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(msg);
      await chatPage.waitForAIResponse(msg);
    });

    const fork1MessageCount = await chatPage.countMessages();

    await test.step('switch to Main tab — fewer messages', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await chatPage.clickForkTab('Main');
      await chatPage.expectActiveForkTab('Main');
      await chatPage.waitForConversationLoaded();
      // Poll, don't point-read: the tab switch swaps the active branch's
      // messages via a refetch that reconciles asynchronously. waitForConversationLoaded
      // can resolve against the outgoing branch's still-mounted rows, so a
      // one-shot count returns Fork 1's total. Retry until Main's branch lands.
      await expect
        .poll(() => chatPage.countMessages(), { timeout: TIMEOUTS.CONVERSATION_LOAD })
        .toBeLessThan(fork1MessageCount);
    });

    await test.step('switch back to Fork 1 — more messages', async () => {
      await expect(chatPage.getForkTab('Fork 1')).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await chatPage.clickForkTab('Fork 1');
      await chatPage.expectActiveForkTab('Fork 1');
      await chatPage.waitForConversationLoaded();
      await expect
        .poll(() => chatPage.countMessages(), { timeout: TIMEOUTS.CONVERSATION_LOAD })
        .toBe(fork1MessageCount);
    });
  });

  test('create second fork', async ({ authenticatedPage, testConversation: _testConversation }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create first fork from AI message', async () => {
      await chatPage.clickFork(1);
      await expect(chatPage.getForkTabList()).toBeVisible();
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('switch to Main and fork from AI message', async () => {
      await chatPage.clickForkTab('Main');
      await chatPage.clickFork(1);
    });

    await test.step('verify 3 tabs', async () => {
      await chatPage.expectForkTabCount(3);
      await expect(chatPage.getForkTab('Fork 2')).toBeVisible();
      await chatPage.expectActiveForkTab('Fork 2');
    });
  });

  test('rename fork via three-dot menu', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create fork to rename', async () => {
      await chatPage.clickFork(1);
      await expect(chatPage.getForkTabList()).toBeVisible();
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('open menu on Fork 1 and click Rename', async () => {
      await chatPage.clickForkTabMenuAction('Fork 1', 'Rename');
    });

    await test.step('rename to My Branch', async () => {
      await chatPage.confirmRename('My Branch');
    });

    await test.step('verify tab reads My Branch', async () => {
      await expect(chatPage.getForkTab('My Branch')).toBeVisible();
      await expect(chatPage.getForkTab('Fork 1')).not.toBeVisible();
    });
  });

  test('delete fork via three-dot menu', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create fork to delete', async () => {
      await chatPage.clickFork(1);
      await expect(chatPage.getForkTabList()).toBeVisible();
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('rename fork first so we have a named fork to delete', async () => {
      await chatPage.clickForkTabMenuAction('Fork 1', 'Rename');
      await chatPage.confirmRename('My Branch');
      await expect(chatPage.getForkTab('My Branch')).toBeVisible();
    });

    await test.step('open menu on My Branch and click Delete', async () => {
      await chatPage.clickForkTabMenuAction('My Branch', 'Delete');
    });

    await test.step('confirm delete', async () => {
      await chatPage.confirmDelete();
    });

    await test.step('verify tab bar disappears (only fork deleted)', async () => {
      await chatPage.expectNoForkTabs();
    });
  });

  test('delete last fork reverts to linear', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create fork to delete', async () => {
      await chatPage.clickFork(1);
      await expect(chatPage.getForkTabList()).toBeVisible();
    });

    await test.step('delete Fork 1', async () => {
      await chatPage.clickForkTabMenuAction('Fork 1', 'Delete');
      await chatPage.confirmDelete();
    });

    await test.step('verify tab bar disappears', async () => {
      await chatPage.expectNoForkTabs();
    });

    await test.step('verify URL has no fork param', async () => {
      await expect.poll(() => chatPage.getForkIdFromUrl(), { timeout: TIMEOUTS.MODAL }).toBeNull();
    });

    await test.step('verify messages display normally', async () => {
      await expect
        .poll(() => chatPage.countMessages(), { timeout: TIMEOUTS.ASSERT })
        .toBeGreaterThanOrEqual(2);
    });
  });

  test('fork limit enforced', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    // Deliberate: this test creates forks beyond the per-conversation cap
    // and asserts the 6th attempt 400s with FORK_LIMIT_REACHED.
    expectApiErrors(authenticatedPage, [
      /400 Bad Request POST .*\/conversations\/[0-9a-f-]+\/forks(?=\?|\s|$)/,
      /"code":"FORK_LIMIT_REACHED"/,
    ]);
    expectConsoleErrors(authenticatedPage, [
      /Failed to load resource: the server responded with a status of 400/,
    ]);
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create 5 forks (hitting MAX_FORKS_PER_CONVERSATION)', async () => {
      // Create fork 1 (creates Main + Fork 1 = 2 forks total)
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);

      // Create forks 2-4 via UI (fork from AI message on Main)
      for (let index = 2; index <= 4; index++) {
        await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: TIMEOUTS.ASSERT });
        await chatPage.clickForkTab('Main');
        await chatPage.clickFork(1);
        await chatPage.expectForkTabCount(index + 1);
      }
    });

    await test.step('try to create 6th fork — should fail', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await chatPage.clickForkTab('Main');
      await chatPage.prepareMessage(1);
      await chatPage.getForkButton(1).click();

      await chatPage.expectForkTabCount(5);
    });
  });
});

test.describe('Fork URL and Refresh', () => {
  test('fork URL param loads correct fork on page load', async ({
    authenticatedPage,
    testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create a fork', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);
    });

    const forkId = chatPage.getForkIdFromUrl();
    expect(forkId).not.toBeNull();

    await test.step('navigate directly to fork URL', async () => {
      await authenticatedPage.goto(`/chat/${testConversation.id}?fork=${forkId!}`, {
        waitUntil: 'domcontentloaded',
      });
      await chatPage.waitForConversationLoaded();
    });

    await test.step('verify correct tab is active', async () => {
      await chatPage.expectActiveForkTab('Fork 1');
    });
  });

  test('page refresh preserves active fork', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create fork and verify it is active', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('reload page', async () => {
      await authenticatedPage.reload();
      await chatPage.waitForConversationLoaded();
    });

    await test.step('verify same tab still active', async () => {
      await chatPage.expectActiveForkTab('Fork 1');
    });
  });

  test('invalid fork ID in URL falls back gracefully', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('navigate with invalid fork ID', async () => {
      await authenticatedPage.goto(`/chat/${testConversation.id}?fork=nonexistent-id`, {
        waitUntil: 'domcontentloaded',
      });
      await chatPage.waitForConversationLoaded();
    });

    await test.step('verify messages load without crash', async () => {
      // Use auto-retrying assertion — Virtuoso may not have rendered all items yet
      await expect(chatPage.getMessageGroups()).toHaveCount(2, {
        timeout: TIMEOUTS.ASSERT,
      });
    });
  });
});

test.describe('Group Chat Forking', () => {
  test('write+ member can fork, tabs visible to both users', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    test.slow();
    const aliceChatPage = new ChatPage(authenticatedPage);
    const bobChatPage = new ChatPage(testBobPage);

    await test.step('Alice navigates and creates fork', async () => {
      await aliceChatPage.gotoConversation(groupConversation.id);
      await aliceChatPage.waitForConversationLoaded();

      const aiMessage = aliceChatPage.messagesByRole('assistant').first();
      await aiMessage.hover();
      await aiMessage.getByRole('button', { name: 'Fork' }).click();

      await expect(aliceChatPage.getForkTabList()).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await aliceChatPage.expectForkTabCount(2);
    });

    await test.step('Bob navigates and sees same fork tabs', async () => {
      await bobChatPage.gotoConversation(groupConversation.id);
      await bobChatPage.waitForConversationLoaded();

      await expect(bobChatPage.getForkTabList()).toBeVisible();
      await bobChatPage.expectForkTabCount(2);
      await expect(bobChatPage.getForkTab('Main')).toBeVisible();
      await expect(bobChatPage.getForkTab('Fork 1')).toBeVisible();
    });
  });
});

test.describe('Fork History Preservation', () => {
  test('fork preserves all message history in both branches', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('send 3 exchanges (6 messages total)', async () => {
      // waitForAIResponse only checks for AI text becoming visible; the SSE
      // stream may still be open. Sending the next message would cancel
      // the in-flight POST → user/AI rows fail to persist via waitUntil().
      // waitForStreamComplete waits for streaming-message-id state to drain.
      const msg1 = `History test 1 ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(msg1);
      await chatPage.waitForConversation();
      await chatPage.waitForAIResponse(msg1);
      await chatPage.waitForStreamComplete();

      const msg2 = `History test 2 ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(msg2);
      await chatPage.waitForAIResponse(msg2);
      await chatPage.waitForStreamComplete();

      const msg3 = `History test 3 ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(msg3);
      await chatPage.waitForAIResponse(msg3);
      await chatPage.waitForStreamComplete();
    });

    const totalMessages = await chatPage.getMessageCountViaAPI();
    expect(totalMessages).toBe(6);

    await test.step('fork from 4th message (2nd AI response)', async () => {
      await chatPage.clickFork(3);
      await chatPage.expectForkTabCount(2);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('Fork 1 shows messages up to fork point', async () => {
      await expect.poll(() => chatPage.countMessages(), { timeout: TIMEOUTS.ASSERT }).toBe(4);
    });

    await test.step('Main still has all 6 messages', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await chatPage.clickForkTab('Main');
      await chatPage.expectActiveForkTab('Main');
      const mainCount = await chatPage.getMessageCountViaAPI();
      expect(mainCount).toBe(6);
    });

    await test.step('switching back to Fork 1 preserves 4 messages', async () => {
      await chatPage.clickForkTab('Fork 1');
      await chatPage.expectActiveForkTab('Fork 1');
      await expect.poll(() => chatPage.countMessages(), { timeout: TIMEOUTS.ASSERT }).toBe(4);
    });
  });

  test('messages before fork point visible on both branches', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    const msg1 = `Before fork ${String(Date.now())}`;
    const msg2 = `Fork point ${String(Date.now())}`;
    const msg3 = `After fork ${String(Date.now())}`;

    await test.step('send 3 exchanges', async () => {
      // See note in 'send 3 exchanges (6 messages total)' above — must drain
      // the SSE stream before sending the next message or persistence races.
      await chatPage.sendNewChatMessage(msg1);
      await chatPage.waitForConversation();
      await chatPage.waitForAIResponse(msg1);
      await chatPage.waitForStreamComplete();

      await chatPage.sendFollowUpMessage(msg2);
      await chatPage.waitForAIResponse(msg2);
      await chatPage.waitForStreamComplete();

      await chatPage.sendFollowUpMessage(msg3);
      await chatPage.waitForAIResponse(msg3);
      await chatPage.waitForStreamComplete();
    });

    expect(await chatPage.getMessageCountViaAPI()).toBe(6);

    await test.step('fork from 4th message (2nd AI response)', async () => {
      await chatPage.clickFork(3);
      await chatPage.expectForkTabCount(2);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('Fork 1 shows first message content', async () => {
      const forkCount = await chatPage.countMessages();
      expect(forkCount).toBe(4);
      await chatPage.expectMessageVisible(msg1);
      await chatPage.expectMessageVisible(msg2);
    });

    await test.step('Main shows first message content', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await chatPage.clickForkTab('Main');
      await chatPage.expectActiveForkTab('Main');
      const mainCount = await chatPage.getMessageCountViaAPI();
      expect(mainCount).toBe(6);
      await chatPage.expectMessageVisible(msg1);
      await chatPage.expectMessageVisible(msg2);
      await chatPage.expectMessageVisible(msg3);
    });
  });

  /**
   * E4 (image fork): forking a conversation that contains a generated image
   * must preserve the image content item in the forked branch. This covers
   * the case where the parent chain replay must re-attach the storage_key /
   * mime_type / size_bytes columns rather than just message text.
   */
  test('fork from a generated image preserves the image in both branches', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('generate an image then fork from the assistant message', async () => {
      const imageIcon = authenticatedPage.getByRole('button', { name: /switch to image/i });
      await expect(imageIcon).toBeVisible();
      await imageIcon.click();
      await expect(authenticatedPage.getByRole('button', { name: '1:1' })).toBeVisible();

      const prompt = `Image to fork ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(prompt);
      await chatPage.waitForConversation();
      await chatPage.expectImageVisible();
      await chatPage.waitForStreamComplete();

      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('Fork 1 still shows the inherited image', async () => {
      await chatPage.expectImageVisible();
    });

    await test.step('Main also still shows the original image', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await chatPage.clickForkTab('Main');
      await chatPage.expectActiveForkTab('Main');
      await chatPage.expectImageVisible();
    });
  });

  test('fork from multi-model response preserves sibling AI messages', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('select 2 models and send message', async () => {
      await chatPage.selectModels(2);
      await chatPage.expectComparisonBarVisible();
      const testMessage = `Multi-model fork ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);
      await chatPage.waitForConversation();
      await chatPage.waitForMultiModelResponses(2);
    });

    const totalMessages = await chatPage.getMessageCountViaAPI();
    expect(totalMessages).toBe(3); // 1 user + 2 AI

    const firstAiNametag = await chatPage
      .getMessage(1)
      .getByTestId(TEST_IDS.modelNametag)
      .textContent();

    await test.step('fork from first AI message', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('Fork 1 has the forked AI message only', async () => {
      const forkCount = await chatPage.countMessages();
      expect(forkCount).toBe(3); // 1 user + 2 AI siblings (multi-model responses always grouped)
      await chatPage.expectModelNametag(1, firstAiNametag!);
    });

    await test.step('Main still has all 3 messages', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await chatPage.clickForkTab('Main');
      await chatPage.expectActiveForkTab('Main');
      await expect.poll(() => chatPage.countMessages(), { timeout: TIMEOUTS.ASSERT }).toBe(3);
    });
  });
});
