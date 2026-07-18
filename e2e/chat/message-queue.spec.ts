import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Message Queue', () => {
  test('queued message auto-sends after active run completes', async ({
    authenticatedPage,
    testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    const stamp = String(Date.now());
    const messageA = `Queue A ${stamp}`;
    const messageB = `Queue B ${stamp}`;
    const messageC = `Queue C ${stamp}`;

    // Captured before any send: A's run and B's auto-sent run each advance
    // stream-cycle counter by one; C is canceled and must never advance it.
    const streamBaseline = await chatPage.captureStreamBaseline();

    await test.step('send A held open — streaming pinned active after first chunk', async () => {
      // Pin A's stream open at its first chunk so every enqueue below gates on a
      // deterministically-active stream, not the mock's brief real streaming
      // window. Released explicitly further down.
      await chatPage.holdPrimaryStreamForNextSends();
      await chatPage.sendFollowUpMessage(messageA);
      await chatPage.waitForStreamingActive();
    });

    await test.step('queue B while A streams — pill shown, B not yet sent', async () => {
      await chatPage.enqueueWhileStreaming(messageB);
      await expect(chatPage.queuedPill(0)).toBeVisible();
      await chatPage.expectMessageAbsent(messageB);
    });

    await test.step('queue C while A streams — two pills shown', async () => {
      // A is still parked, so streaming is deterministically active — re-gate so
      // C's enqueue is coupled to the in-flight run, never a settled one.
      await chatPage.waitForStreamingActive();
      await chatPage.enqueueWhileStreaming(messageC);
      await expect(chatPage.queuedPill(0)).toBeVisible();
      await expect(chatPage.queuedPill(1)).toBeVisible();
      await expect.poll(async () => chatPage.queuedPillCount()).toBe(2);
      await chatPage.expectMessageAbsent(messageC);
    });

    await test.step('cancel C — one pill remains', async () => {
      await chatPage.cancelQueuedPill(1);
      await expect(chatPage.queuedPill(1)).not.toBeVisible();
      await expect(chatPage.queuedPill(0)).toBeVisible();
      await expect.poll(async () => chatPage.queuedPillCount()).toBe(1);
    });

    await test.step('release A, then B auto-drains and streams', async () => {
      // Clear the hold BEFORE releasing: B's auto-drain send fires at A's settle
      // and must stream to completion on its own — inheriting the hold header
      // would park B with no release and hang the test.
      await chatPage.stopHoldingStreams();
      await chatPage.releaseHeldStream(testConversation.id);
      // The queue drains at A's settle: B leaves the pill stack and sends, so
      // the region unmounts once its last pill (B) is dequeued.
      await expect(chatPage.queuedRegion()).not.toBeVisible({
        timeout: TIMEOUTS.STREAM_SATURATED,
      });
      // Two cycles since baseline: A's run and B's auto-sent run, both settled.
      await chatPage.waitForStreamCyclesCompleted(streamBaseline, 2);
      await chatPage.assertMessageVisible(messageB);
    });

    await test.step('persisted turns are A then B — C was never sent', async () => {
      const count = await chatPage.getMessageCountViaAPI();
      // Seed (2) + A turn (user + assistant) + B turn (user + assistant) = 6.
      expect(count).toBe(6);
      await chatPage.expectMessageAbsent(messageC);
    });
  });
});
