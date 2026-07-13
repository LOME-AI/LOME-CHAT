import { test, expect } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from '../pages';
import { assertCostAndNametagForFreshGeneration } from '../helpers/media-flows.js';
import { captureChatRoutePayload } from '../helpers/route-payload.js';
import { expectVideoDecoded } from '../helpers/webkit-media-decode.js';
import { TIMEOUTS } from '../config/timeouts.js';

/**
 * Video generation flow end-to-end.
 *
 * Uses the mock AIClient (dev/E2E default) which returns a canned MP4 via
 * `google/veo-3.1-lite`. The test asserts the UI round-trip: switch modality,
 * configure video, send prompt, see a `<video>` element render with a download
 * button. Doesn't assert playback — the canned bytes aren't enough frames.
 *
 * Coverage matrix: see plan §C (C1..C17). Each test below is mapped to its
 * plan id in the test name comment.
 */
test.describe('Video Generation', () => {
  test('switches to video modality, generates, and renders inline', async ({
    authenticatedPage,
    browserName,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    // Aspect-ratio pills, resolution pills, and the duration slider live
    // inline on desktop and inside the bottom sheet on mobile. Open the
    // sheet to make them reachable on both layouts, then close it so the
    // composer isn't obscured.
    await chatPage.openGenerationSheetIfNeeded();

    await expect(
      authenticatedPage.getByRole('button', { name: '16:9', exact: true })
    ).toBeVisible();
    await expect(
      authenticatedPage.getByRole('button', { name: '9:16', exact: true })
    ).toBeVisible();
    const durationSlider = authenticatedPage.getByRole('slider', {
      name: /video duration in seconds/i,
    });
    await expect(durationSlider).toBeVisible();

    await chatPage.closeGenerationSheetIfOpen();

    const prompt = `Generate a clip of a cat surfing ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectMessageVisible(prompt);

    await chatPage.expectVideoVisible();
    await chatPage.expectDownloadLinkVisible();

    // Proves the browser parsed the bytes (positive finite duration => moov
    // atom / EBML header read). expectVideoDecoded degrades to a "src bound"
    // check on engines that can't decode — see helper for the why.
    const videoElement = chatPage.videosIn(chatPage.messageList).first();
    await expectVideoDecoded(videoElement, browserName, { timeout: TIMEOUTS.ASSERT });
  });

  test('resolution buttons render with quality-tier label and pixel row', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.openGenerationSheetIfNeeded();

    // Mock Veo 3.1 supports 720p and 1080p. Each pill renders the quality
    // tier (HD/FHD) above the pixel row (720p/1080p). The accessible name is
    // the pixel row alone — price lives on `MediaCostLine`, not the button.
    const hdPill = authenticatedPage.getByRole('button', { name: '720p', exact: true });
    await expect(hdPill).toBeVisible();
    await expect(hdPill).toContainText('HD');
    await expect(hdPill).toContainText('720p');

    const fhdPill = authenticatedPage.getByRole('button', { name: '1080p', exact: true });
    await expect(fhdPill).toBeVisible();
    await expect(fhdPill).toContainText('FHD');
    await expect(fhdPill).toContainText('1080p');
  });

  /** C1+C2: cost AND nametag visible on the generated video message. */
  test('generated video displays cost badge and model nametag', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await assertCostAndNametagForFreshGeneration(chatPage, 'video');
  });

  /**
   * C3: page reload re-renders the generated video (presigned URL re-mint).
   * Uses the videoConversation fixture so the generation is already finalized
   * before the test body runs.
   */
  test('page reload re-renders the generated video', async ({ videoConversation }) => {
    test.slow();
    const chatPage = new ChatPage(videoConversation.page);
    await chatPage.expectVideoVisible();

    await videoConversation.page.reload();
    await chatPage.waitForConversationLoaded();

    await chatPage.expectVideoVisible();
    await chatPage.expectDownloadLinkVisible();
  });

  /** C5: regenerate replaces the video with a fresh response. */
  test('regenerate replaces the video with a fresh response', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Regenerate video ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamComplete();

    await chatPage.clickRegenerate(1);
    await chatPage.waitForStreamComplete();
    await chatPage.expectVideoVisible();
  });

  /**
   * Edit on the user prompt opens the prompt editor; saving with new content
   * re-runs generation. The rendered <video> blob URL changes.
   */
  test('edit on user prompt regenerates a new video with edited content', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Edit-video initial ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamComplete();

    const originalSource = await chatPage
      .videosIn(chatPage.messageList)
      .first()
      .getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.clickEdit(0);
    await chatPage.expectEditModeActive();

    const editedMessage = `Edit-video edited ${String(Date.now())}`;
    await chatPage.messageInput.clear();
    await chatPage.messageInput.fill(editedMessage);
    await expect(chatPage.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
    await chatPage.sendButton.click();

    // Optimistic prune: the pre-edit user message and its AI reply both
    // disappear in the same React commit as the new edited message lands,
    // matching the state of a fresh send at the end of the conversation.
    await expect(chatPage.messageList.getByText(prompt, { exact: true })).toHaveCount(0, {
      timeout: TIMEOUTS.MODAL,
    });
    await expect(chatPage.videosWithSrcIn(chatPage.messageList, originalSource ?? '')).toHaveCount(
      0,
      { timeout: TIMEOUTS.MODAL }
    );

    await chatPage.expectMessageVisible(editedMessage);
    await chatPage.waitForStreamComplete();
    await chatPage.expectVideoVisible();

    await expect
      .poll(async () => chatPage.videosIn(chatPage.messageList).first().getAttribute('src'), {
        timeout: TIMEOUTS.ASSERT,
      })
      .not.toBe(originalSource);
  });

  /** Retry on the user prompt re-runs the same prompt and yields a fresh video. */
  test('retry on user prompt regenerates the video with the same prompt', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Retry-video ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamComplete();

    const originalSource = await chatPage
      .videosIn(chatPage.messageList)
      .first()
      .getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.clickRetry(0);
    await chatPage.waitForStreamComplete();
    await chatPage.expectVideoVisible();

    await chatPage.expectMessageVisible(prompt);
    await expect
      .poll(async () => chatPage.videosIn(chatPage.messageList).first().getAttribute('src'), {
        timeout: TIMEOUTS.ASSERT,
      })
      .not.toBe(originalSource);
  });

  /** C7: trial user sees the video modality icon disabled with sign-up tooltip. */
  test('trial user sees video modality icon disabled with sign-up tooltip', async ({
    unauthenticatedPage,
  }) => {
    const chatPage = new ChatPage(unauthenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    const videoIconWrapper = unauthenticatedPage.getByRole('button', {
      name: /video generation.*sign up to unlock/i,
    });
    await expect(videoIconWrapper).toBeVisible();
  });

  /** C13: resolution choice flows through to the /chat request payload. */
  test('resolution choice flows through to /chat request payload', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.selectResolution('1080p');
    // `selectResolution` opens the bottom sheet on mobile; close it before
    // sending so the composer is interactive.
    await chatPage.closeGenerationSheetIfOpen();

    const captured = await captureChatRoutePayload(authenticatedPage);

    const prompt = `Resolution payload check ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    await expect.poll(captured.get, { timeout: TIMEOUTS.ASSERT }).toBeDefined();
    expect(JSON.stringify(captured.get())).toContain('1080p');
  });

  /**
   * C14: duration slider drives both request payload AND the live cost preview.
   * The preview shows `≈ $X.YYY` based on duration × per-second price.
   */
  test('duration slider drives the live cost preview', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    // Both the slider and the cost preview live in the bottom sheet on mobile.
    // Open it once for the whole test; no need to close — the test never
    // sends a prompt.
    await chatPage.openGenerationSheetIfNeeded();

    const slider = authenticatedPage.getByRole('slider', { name: /video duration in seconds/i });
    const initialValue = await slider.inputValue();
    expect(Number(initialValue)).toBeGreaterThanOrEqual(1);

    const costLine = authenticatedPage.getByText(/^≈\s+\$\d+\.\d{3}$/).first();
    await expect(costLine).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    const initialCost = await costLine.textContent();

    // Bump duration up to its max (8 seconds for video on the mock).
    await chatPage.setVideoDuration(8);

    await expect(costLine).not.toHaveText(initialCost ?? '', { timeout: TIMEOUTS.MODAL });
  });

  /** C15: 9:16 aspect ratio choice flows through to the /chat request. */
  test('9:16 aspect ratio choice flows through to /chat request', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.selectAspectRatio('9:16');
    // `selectAspectRatio` opens the bottom sheet on mobile; close it before
    // sending so the composer is reachable.
    await chatPage.closeGenerationSheetIfOpen();

    const captured = await captureChatRoutePayload(authenticatedPage);

    const prompt = `Portrait video ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    await expect.poll(captured.get, { timeout: TIMEOUTS.ASSERT }).toBeDefined();
    expect(JSON.stringify(captured.get())).toContain('9:16');
  });

  /**
   * Layout: the rendered <video> stays within the viewport width and within
   * the surrounding message bubble. Catches CSS regressions that would let
   * media overflow horizontally.
   */
  test('rendered video fits within viewport and message bubble bounds', async ({
    videoConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(videoConversation.page);
    await chatPage.expectVideoVisible();

    const viewport = videoConversation.page.viewportSize();
    expect(viewport, 'viewport size is required').not.toBeNull();
    const viewportWidth = viewport!.width;

    const videoElement = chatPage.videosIn(chatPage.messageList).first();
    const videoBox = await videoElement.boundingBox();
    expect(videoBox).not.toBeNull();
    expect(videoBox!.width).toBeLessThanOrEqual(viewportWidth);

    const bubble = chatPage.messagesByRole('assistant').first();
    const bubbleBox = await bubble.boundingBox();
    expect(bubbleBox).not.toBeNull();

    expect(videoBox!.x).toBeGreaterThanOrEqual(bubbleBox!.x - 1);
    expect(videoBox!.x + videoBox!.width).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 1);
  });

  /** C16: <video> element has the `controls` attribute (per MediaPreview). */
  test('rendered video has playback controls', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Controls check ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();

    const videoElement = chatPage.videosIn(chatPage.messageList).first();
    // The `controls` HTML attribute is present (any value, including empty string).
    const hasControls = await videoElement.evaluate((el) => (el as HTMLVideoElement).controls);
    expect(hasControls).toBe(true);
  });

  /**
   * C17: cost reflects duration × resolution multiplier. We don't assert exact
   * values (those come from server-side billing); we assert that switching from
   * 1080p to 4k strictly increases the live cost preview at the same duration.
   *
   * Pinned to a model that surfaces a 4k resolution tier: some video models
   * price 720p and 1080p the same (real provider pricing — not a mock bug), so a
   * per-resolution differential only shows up against models that surface 4k.
   */
  test('cost preview increases when switching from 1080p to 4k at fixed duration', async ({
    authenticatedPage,
  }) => {
    test.fixme(
      true,
      'no exposed video model in the live catalog surfaces a 4k resolution (veo-3.1-lite: 720p/1080p, kling-video-o1: 720p) — re-enable when a 4k-capable video model is ZDR-exposed'
    );
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.selectSingleModel('google/veo-3.1-lite');
    // Open the sheet once; setVideoDuration / selectResolution rely on the
    // controls being mounted and the cost line lives in the sheet on mobile.
    await chatPage.openGenerationSheetIfNeeded();
    await chatPage.setVideoDuration(6);

    const costLine = authenticatedPage.getByText(/^≈\s+\$\d+\.\d{3}$/).first();
    await expect(costLine).toBeVisible({ timeout: TIMEOUTS.ASSERT });

    await chatPage.selectResolution('1080p');
    await expect(costLine).toBeVisible();
    const lower = await costLine.textContent();

    await chatPage.selectResolution('4k');
    // Re-fetch text — the same locator targets the updated DOM.
    await expect(costLine).not.toHaveText(lower ?? '', { timeout: TIMEOUTS.MODAL });
    const higher = await costLine.textContent();
    const lowerCents = Number((lower ?? '').replaceAll(/[^0-9.]/g, ''));
    const higherCents = Number((higher ?? '').replaceAll(/[^0-9.]/g, ''));
    expect(higherCents).toBeGreaterThan(lowerCents);
  });

  /**
   * C10: download link href is a blob URL (the user can save it locally).
   * Reuses the videoConversation fixture so the generate-and-wait pipeline
   * runs once during fixture setup rather than per-test.
   */
  test('download link href is a blob URL for the generated video', async ({
    videoConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(videoConversation.page);

    const href = await chatPage.getDownloadLinkHref();
    expect(href).toBeTruthy();
    expect(href).toMatch(/^blob:/);
  });

  /**
   * Free-tier user (zero balance) in video mode: every video model is premium
   * so no model auto-resolves and the resolution panel renders its empty-state
   * hint ("Select a video model to see resolution options"). Model selector
   * shows the lock icon on every video model. Cost preflight is unreachable
   * by design — the test verifies the gating UX, not a cost-denial banner.
   */
  test('free-tier user sees video models locked and cannot generate', async ({
    lowBalancePage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(lowBalancePage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    // Don't use `switchToVideoMode()` — that helper asserts the 720p button is
    // visible, which only happens once a video model is selected. Free-tier
    // users can enter the modality but the resolution panel stays empty.
    const videoIcon = lowBalancePage.getByRole('button', { name: /switch to video/i });
    await expect(videoIcon).toBeVisible();
    await videoIcon.click();
    // VideoResolutionControl (and its empty-state hint) lives in the bottom
    // sheet on mobile. Open it so the assertions below can find it on either
    // layout. Close before opening the model selector so the two overlays
    // don't stack.
    await chatPage.openGenerationSheetIfNeeded();

    await expect(
      lowBalancePage.getByText(/Select a video model to see resolution options/i)
    ).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    await expect(lowBalancePage.getByRole('button', { name: '720p', exact: true })).toHaveCount(0);

    await chatPage.closeGenerationSheetIfOpen();

    await test.step('all video models in the modal show the premium lock icon', async () => {
      await chatPage.openModelSelector();
      const modal = lowBalancePage.getByTestId(TEST_IDS.modelSelectorModal);
      await expect(modal).toBeVisible();
      const items = chatPage.modelItems();
      const total = await items.count();
      expect(total).toBeGreaterThan(0);
      const locked = chatPage.lockedModelItems();
      await expect(locked).toHaveCount(total);
      await lowBalancePage.keyboard.press('Escape');
      await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
    });

    await expect(lowBalancePage).toHaveURL(/\/chat$/);
    await expect(chatPage.videosIn(chatPage.messageList)).toHaveCount(0);
  });
});
