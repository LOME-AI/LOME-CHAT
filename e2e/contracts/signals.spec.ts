import { test, expect } from '../fixtures.js';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { ChatPage } from '../pages';
import { setupRealtimePair } from '../helpers/realtime.js';
import { TIMEOUTS } from '../config/timeouts.js';

/**
 * `TEST_SIGNALS` is the typed registry of `data-*`
 * readiness attributes the production app emits. The unit test
 * (`packages/shared/src/test-signals.test.ts`) locks the registry's *shape*.
 * This e2e contract locks the other half: that the running production app
 * actually emits each signal once driven into the state where it renders. A
 * signal that silently stops being emitted (renamed/removed at its DOM site)
 * breaks here rather than as a mystery wall-clock flake in whichever spec
 * gates on it.
 *
 * Tests are grouped by the app state required to render each signal so setup is
 * shared. Every signal in `TEST_SIGNALS` is exercised:
 *   - page-load:   appStable, settled
 *   - conversation: messagesReady, messageCount, decryptedCount, assistantCount,
 *                   costCount, rowsCount, virtuosoScrolling, messageId, role
 *   - stream:      streamingCount, streamsCompleted, preInferenceStagesSeen
 *   - websocket:   wsConnected, wsReady
 *   - roadmap:     roadmapReady
 *   - leaderboard: statsSettled, statsReady
 *   - banner:      bannerSettled
 */
test.describe('State-signal contract', () => {
  test('page-load signals render on the new-chat page', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();

    // appStable: the SPA has hydrated and settled (new-chat page).
    await expect(chatPage.newChatPage).toHaveAttribute(TEST_SIGNALS.appStable, 'true', {
      timeout: TIMEOUTS.APP_STABLE,
    });

    // settled: explicit-quiescence marker once all queries/mutations/streams idle.
    await expect(authenticatedPage.getByTestId(TEST_IDS.settledIndicator)).toHaveAttribute(
      TEST_SIGNALS.settled,
      'true',
      { timeout: TIMEOUTS.APP_STABLE }
    );
  });

  test('banner-settled signal renders once the banner decision is applied', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();

    // bannerSettled: the banner payload fetch resolved AND the show/hide
    // decision was applied. Emitted 'true' regardless of whether a banner is
    // active (that is the point — it distinguishes "no banner" from "not
    // loaded yet"), so no banner_config seed is required. Attached, not
    // visible: with no active banner the mount node is an empty div.
    await expect(authenticatedPage.locator(`[${TEST_SIGNALS.bannerSettled}="true"]`)).toBeAttached({
      timeout: TIMEOUTS.APP_STABLE,
    });
  });

  test('conversation signals render on a seeded conversation', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(testConversation.id);
    await chatPage.waitForConversationLoaded();

    const list = chatPage.messageList;

    // messagesReady: the decrypt pass has run (distinguishes "no messages" from
    // "decryption in flight").
    await expect(list).toHaveAttribute(TEST_SIGNALS.messagesReady, 'true', {
      timeout: TIMEOUTS.CONVERSATION_LOAD,
    });

    // The seeded conversation has one user + one AI message.
    await expect(list).toHaveAttribute(TEST_SIGNALS.messageCount, '2');
    await expect(list).toHaveAttribute(TEST_SIGNALS.decryptedCount, '2');

    // Count signals render regardless of value; assert presence (the contract).
    // assistantCount/costCount/rowsCount/virtuosoScrolling carry dynamic values
    // (cost is null on dev-seeded AI messages, so costCount is "0").
    await expect(list).toHaveAttribute(TEST_SIGNALS.assistantCount);
    await expect(list).toHaveAttribute(TEST_SIGNALS.costCount);
    await expect(list).toHaveAttribute(TEST_SIGNALS.rowsCount);
    await expect(list).toHaveAttribute(TEST_SIGNALS.virtuosoScrolling);
    await expect(list).toHaveAttribute(TEST_SIGNALS.atBottom);

    // Per-message identity/role on the rendered message items.
    const firstMessage = list.locator(`[${TEST_SIGNALS.messageId}]`).first();
    await expect(firstMessage).toHaveAttribute(TEST_SIGNALS.messageId);
    await expect(firstMessage).toHaveAttribute(TEST_SIGNALS.role);
  });

  test('stream signals render and advance when a turn completes', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(testConversation.id);
    await chatPage.waitForConversationLoaded();

    const list = chatPage.messageList;

    // Both stream signals are present on the populated list before any new turn.
    await expect(list).toHaveAttribute(TEST_SIGNALS.streamingCount);
    await expect(list).toHaveAttribute(TEST_SIGNALS.streamsCompleted);

    // streamsCompleted is a monotonic cycle counter: it advances once a sent
    // turn streams to completion. Capturing the baseline and asserting an
    // increment proves the signal tracks real stream lifecycle, not a constant.
    const baseline = await chatPage.captureStreamBaseline();
    await chatPage.sendFollowUpMessage(`Signal stream check ${testConversation.id}`);
    await chatPage.waitForStreamCycle(baseline);
    await expect
      .poll(async () => Number((await list.getAttribute(TEST_SIGNALS.streamsCompleted)) ?? '0'), {
        timeout: TIMEOUTS.STREAM,
      })
      .toBeGreaterThan(baseline);
  });

  test('pre-inference signal renders and advances on a Smart Model turn', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(testConversation.id);
    await chatPage.waitForConversationLoaded();

    const list = chatPage.messageList;

    // Present on the populated list before any Smart Model turn.
    await expect(list).toHaveAttribute(TEST_SIGNALS.preInferenceStagesSeen);

    // Monotonic: a Smart Model send runs a pre-inference (classifier) stage,
    // advancing the counter. Capturing the baseline and asserting an increment
    // proves the signal tracks the real stage, not a constant.
    await chatPage.selectSingleModel('smart-model');
    const baseline = await chatPage.capturePreInferenceBaseline();
    await chatPage.sendFollowUpMessage(`Signal pre-inference check ${testConversation.id}`);
    await chatPage.waitForPreInferenceStage(baseline);
  });

  test('websocket signals render on a group conversation', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    const { aliceChatPage } = await setupRealtimePair(
      authenticatedPage,
      testBobPage,
      groupConversation.id
    );

    // wsConnected / wsReady are emitted as "true" only on a group chat once the
    // socket connects and the Durable Object reports server-side readiness.
    await expect(aliceChatPage.page.locator(`[${TEST_SIGNALS.wsConnected}="true"]`)).toBeVisible({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });
    await expect(aliceChatPage.page.locator(`[${TEST_SIGNALS.wsReady}="true"]`)).toBeAttached({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });
  });

  test('roadmap-ready signal renders on the public roadmap', async ({ unauthenticatedPage }) => {
    await unauthenticatedPage.goto('/roadmap', { waitUntil: 'domcontentloaded' });

    // roadmapReady: the marketing roadmap board finished loading its
    // (Linear-mocked, deterministic) data.
    await expect(unauthenticatedPage.locator(`[${TEST_SIGNALS.roadmapReady}]`)).toBeVisible({
      timeout: TIMEOUTS.APP_STABLE,
    });
  });

  test('stats signals render on the public leaderboard', async ({ unauthenticatedPage }) => {
    await unauthenticatedPage.goto('/leaderboard', { waitUntil: 'domcontentloaded' });

    // statsSettled: the stats fetch resolved (either branch); with seeded
    // usage data the settled element is also the statsReady wrapper.
    const settled = unauthenticatedPage.locator(`[${TEST_SIGNALS.statsSettled}="true"]`);
    await expect(settled).toBeVisible({ timeout: TIMEOUTS.APP_STABLE });
    await expect(settled).toHaveAttribute(TEST_SIGNALS.statsReady);
  });
});
