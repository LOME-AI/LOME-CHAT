import { type Page, type Locator } from '@playwright/test';
import { TEST_IDS, TEST_ID_BUILDERS, TEST_SIGNALS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from '../helpers/env.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { getBrowserName, lacksMediaDecode } from '../helpers/webkit-media-decode.js';

const apiUrl = requireEnv('VITE_API_URL');

const MESSAGE_ID_SELECTOR = `[${TEST_SIGNALS.messageId}]`;
const ROLE_ATTR = TEST_SIGNALS.role;
const MODEL_ITEM_PREFIX = `[data-testid^="${TEST_ID_BUILDERS.modelItem('')}"]`;
const LOCK_ICON_SELECTOR = `[data-testid="${TEST_IDS.lockIcon}"]`;

/**
 * Selects every selectable non-premium model row in the picker: any
 * `model-item-*` that isn't the Smart Model and doesn't carry a lock icon.
 * Derived entirely from the registry so a renamed id/builder breaks here too.
 */
const NON_PREMIUM_MODEL_ITEMS =
  MODEL_ITEM_PREFIX +
  `:not([data-testid="${TEST_ID_BUILDERS.modelItem('smart-model')}"])` +
  `:not(:has(${LOCK_ICON_SELECTOR}))`;

/** Escape a value for safe interpolation into a `[attr="…"]` CSS selector. */
function escapeAttributeValue(value: string): string {
  return value.replaceAll(/["\\]/g, String.raw`\$&`);
}

export class ChatPage {
  readonly page: Page;
  readonly promptInput: Locator;
  readonly messageInput: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;
  readonly newChatPage: Locator;
  readonly suggestionChips: Locator;
  readonly viewport: Locator;

  constructor(page: Page) {
    this.page = page;
    // Locate the prompt textarea by stable testid — the placeholder/aria-label
    // changes per modality (e.g. "Describe the image you want..." for image),
    // so name-based locators silently break after switchToImageMode/Video/Audio.
    this.promptInput = page.getByTestId(TEST_IDS.promptInput);
    this.messageInput = page.locator('main').getByTestId(TEST_IDS.promptInput);
    this.sendButton = page.getByTestId(TEST_IDS.sendButton);
    this.messageList = page.getByRole('log', { name: 'Chat messages' });
    this.newChatPage = page.getByTestId(TEST_IDS.newChatPage);
    this.suggestionChips = page.getByText('Need inspiration? Try these:');
    this.viewport = page.locator('[data-slot="scroll-area-viewport"]');
  }

  async goto(): Promise<void> {
    await this.page.goto('/chat', { waitUntil: 'domcontentloaded' });
  }

  async waitForAppStable(timeout: number = TIMEOUTS.APP_STABLE): Promise<void> {
    await this.page
      .locator(`[${TEST_SIGNALS.appStable}="true"]`)
      .waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for the app to report explicit quiescence — all TanStack Query
   * fetches, mutations, and SSE streams have completed (the `data-settled`
   * signal). Use only where a flow genuinely needs to wait for the app to go
   * idle; prefer a specific readiness signal otherwise.
   */
  async waitForSettled(timeout: number = TIMEOUTS.APP_STABLE): Promise<void> {
    await expect(this.page.getByTestId(TEST_IDS.settledIndicator)).toHaveAttribute(
      TEST_SIGNALS.settled,
      'true',
      { timeout }
    );
  }

  /** Wait for the group chat WebSocket to be connected. Use before actions that send events via WebSocket. */
  async waitForWebSocketConnected(timeout: number = TIMEOUTS.WS_HANDSHAKE): Promise<void> {
    await expect(this.page.locator(`[${TEST_SIGNALS.wsConnected}="true"]`)).toBeVisible({
      timeout,
    });
  }

  /** Wait for the WebSocket server-side registration to complete (DO ready for fan-out). */
  async waitForWebSocketReady(timeout: number = TIMEOUTS.WS_HANDSHAKE): Promise<void> {
    await this.page
      .locator(`[${TEST_SIGNALS.wsReady}="true"]`)
      .waitFor({ state: 'attached', timeout });
  }

  /** Wait for the message list to finish scrolling (layout stable). Use after programmatic scroll operations. */
  async waitForScrollStable(timeout: number = TIMEOUTS.SCROLL_STABLE): Promise<void> {
    await this.page
      .locator(`[${TEST_SIGNALS.virtuosoScrolling}="false"]`)
      .waitFor({ state: 'attached', timeout });
  }

  /**
   * Assert the message list is pinned at the bottom (auto-scroll settled). Gates
   * on the app's `data-at-bottom` signal, which flips false while post-stream
   * layout (code-block highlight, controls bar) grows and back to true once
   * auto-scroll re-pins — so this verifies the final settled state rather than a
   * one-shot pixel read taken mid-layout.
   *
   * Budgeted at STREAM_SATURATED, not SCROLL_STABLE/ASSERT: the re-pin waits on
   * an async layout pass (Shiki highlighting a code block, then a controls bar
   * mounting) whose ResizeObserver lands late on WebKit, and on a saturated
   * mobile engine that settle can run past 10s — the same saturated-stream tier
   * the turn it follows uses, so a loaded machine still observes the final pin.
   */
  async waitForAtBottom(timeout: number = TIMEOUTS.STREAM_SATURATED): Promise<void> {
    await expect(this.messageList).toHaveAttribute(TEST_SIGNALS.atBottom, 'true', { timeout });
  }

  /**
   * Wait for a conversation page to load. Use instead of waitForAppStable on
   * conversation pages. Waits for the message list to mount, for either a
   * message-item or the empty state to render, and for every message to
   * finish decrypting (so a follow-up assertion can scroll to any message
   * without racing the decrypt result).
   */
  async waitForConversationLoaded(timeout: number = TIMEOUTS.CONVERSATION_LOAD): Promise<void> {
    await this.messageList.waitFor({ state: 'visible', timeout });
    await this.messageList
      .getByTestId(TEST_IDS.messageItem)
      .first()
      .or(this.messageList.getByText('No messages yet'))
      .waitFor({ state: 'visible', timeout });
    await this.waitForDecryptionComplete(timeout);
  }

  /**
   * Wait until every message in the conversation has been decrypted, using
   * the `data-decrypted-count` attribute exposed by `MessageList`. Resolves
   * immediately when the conversation is empty.
   */
  async waitForDecryptionComplete(timeout: number = TIMEOUTS.CONVERSATION_LOAD): Promise<void> {
    await this.page.waitForFunction(
      (selectors: { list: string; empty: string; count: string; decrypted: string }) => {
        const list = document.querySelector<HTMLElement>(`${selectors.list}, ${selectors.empty}`);
        if (!list) return false;
        const messageCount = Number(list.getAttribute(selectors.count));
        const decryptedCount = Number(list.getAttribute(selectors.decrypted));
        if (Number.isNaN(messageCount) || Number.isNaN(decryptedCount)) return false;
        return decryptedCount >= messageCount;
      },
      {
        list: `[data-testid="${TEST_IDS.messageList}"]`,
        empty: `[data-testid="${TEST_IDS.messageListEmpty}"]`,
        count: TEST_SIGNALS.messageCount,
        decrypted: TEST_SIGNALS.decryptedCount,
      },
      { timeout }
    );
  }

  async gotoTrialChat(): Promise<void> {
    await this.page.goto('/chat/trial', { waitUntil: 'domcontentloaded' });
  }

  async gotoConversation(conversationId: string): Promise<void> {
    await this.page.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
  }

  /**
   * Trap for tests asserting on transient streaming UI (classifier indicator,
   * first tokens, etc.): this method triggers a /chat → /chat/<new-id>
   * navigation that remounts MessageList. react-virtuoso applies
   * `visibility: hidden` to its item-list during its initial measure-and-scroll,
   * so content is in DOM but invisible during that ~1s window. Prefer a seeded
   * conversation (testConversation fixture) + sendFollowUpMessage instead.
   */
  async sendNewChatMessage(message: string): Promise<void> {
    await this.waitForAppStable();
    await this.promptInput.fill(message);
    await expect(this.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
    await this.sendButton.click();
  }

  async sendFollowUpMessage(message: string): Promise<void> {
    await this.messageInput.fill(message);
    // Wait for streaming to complete (button enabled means canSubmit = true)
    await expect(this.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
    await this.messageInput.press('Enter');
    await expect(this.messageInput).toHaveValue('');
  }

  async waitForConversation(timeout: number = TIMEOUTS.ROUTE): Promise<string> {
    await expect(this.page).toHaveURL(/\/chat\/[a-f0-9-]+(\?.*)?$/, { timeout });
    const url = new URL(this.page.url());
    return url.pathname.split('/').pop() ?? '';
  }

  async expectMessageVisible(message: string, timeout: number = TIMEOUTS.ASSERT): Promise<void> {
    // Thin alias so existing call sites keep working. Prefer assertMessageVisible
    // for new code — it is virtualization-agnostic and auto-scrolls if needed.
    await this.assertMessageVisible(message, { exact: true, timeout });
  }

  /**
   * Count messages in the conversation. Gates on the app-emitted
   * `data-messages-ready="true"` signal first so we never read
   * `data-message-count` mid-decryption, where it sits at 0 momentarily on
   * fork-tab switch / fresh navigation and would be mistaken for an empty
   * conversation.
   *
   * Happy path: returns `stateCount` when it matches the DOM count of
   * `[data-message-id]` (every message currently mounted). Otherwise scrolls
   * top→bottom once collecting unique `data-message-id` values — covers
   * virtualized chats where Virtuoso unmounts off-screen rows.
   *
   * @param role - optional filter ('user' | 'assistant'); when set, counts only
   *               messages of that role (still scrolling through all to collect
   *               them reliably).
   */
  async countMessages(role?: 'user' | 'assistant'): Promise<number> {
    await this.messageList
      .and(this.page.locator(`[${TEST_SIGNALS.messagesReady}="true"]`))
      .waitFor({ timeout: TIMEOUTS.ASSERT });

    const stateCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.messageCount));

    // A fork-switch (or fresh navigation) remounts the virtualized list; Virtuoso
    // mounts its rows asynchronously, so the DOM `[data-message-id]` count briefly
    // lags the authoritative `data-message-count`. Wait for the DOM to catch up
    // before comparing — otherwise the mismatch drops us into the scroll-collect
    // path below, which then reads a transient under-count mid-remount (the
    // fork-switch "0/0/1 instead of 3" flake). A long virtualized list never fully
    // mounts, so this times out and falls through to scroll-collect as before.
    if (stateCount > 0) {
      await expect(this.messageList.locator(MESSAGE_ID_SELECTOR))
        .toHaveCount(stateCount, { timeout: TIMEOUTS.SCROLL_STABLE })
        .catch(() => {
          // Long virtualized list never mounts all rows — fall through to scroll-collect.
        });
    }

    const domCount = await this.messageList.locator(MESSAGE_ID_SELECTOR).count();

    // Happy path: every message is already rendered, no scrolling needed.
    if (stateCount === domCount) {
      if (role === undefined) return stateCount;
      return await this.messageList.locator(`[${ROLE_ATTR}="${role}"]`).count();
    }

    // Slow path: scroll through and collect unique ids.
    const seen = await this.collectMessagesByScrolling(role);
    return seen.size;
  }

  /**
   * Assert a message containing the given text exists somewhere in the
   * conversation. Happy path: already visible in the current DOM, optionally
   * after a short wait to cover decryption lag. Otherwise scrolls to find
   * it, auto-detecting direction from the current scroll position (closer
   * to top → scroll down first; closer to bottom → scroll up first). Falls
   * back to the opposite direction if the first direction exhausts.
   */
  async assertMessageVisible(
    text: string,
    options?: { exact?: boolean; timeout?: number }
  ): Promise<void> {
    const exact = options?.exact ?? false;
    const timeout = options?.timeout ?? TIMEOUTS.ASSERT;
    const locator = this.messageList.getByText(text, { exact }).first();

    // Happy path: already visible, or appears within a short wait window.
    // The short wait covers normal async lag (decryption, streaming) without
    // needing to scroll. If the message is genuinely off-screen due to
    // virtualization, this wait returns fast (locator stays not-visible)
    // and we fall through to the scroll path.
    const happyWait = Math.min(TIMEOUTS.ASSERT, timeout);
    const appeared = await locator
      .waitFor({ state: 'visible', timeout: happyWait })
      .then(() => true)
      .catch(() => false);
    if (appeared) return;

    // Slow path: the row is mounted but clipped/virtualized out of view. Reveal
    // it by parking each Virtuoso row and re-checking the text locator.
    const remaining = Math.max(TIMEOUTS.QUICK, timeout - happyWait);
    await this.revealByRowScan(locator, remaining);
  }

  /**
   * Reveal a clipped/virtualized row: walk Virtuoso's rows bottom→top, parking
   * each via the imperative `scrollMessageIntoView` backdoor, until `check`
   * passes. `scrollMessageIntoView` resolves only once the row is measured and
   * painted, so this reveals a clipped row deterministically regardless of host
   * load (no wall-clock scroll loop). Re-anchors every poll iteration because a
   * row can re-virtualize between the scroll and the check. On timeout, surfaces
   * Playwright's rich locator error against `locator` instead of `expect.poll`'s
   * opaque boolean mismatch (the poll already consumed the budget, so the
   * re-assertion needs only a short window).
   */
  private async revealByRowScan(
    locator: Locator,
    timeout: number,
    check?: () => Promise<boolean>
  ): Promise<void> {
    const matches =
      check ??
      (async (): Promise<boolean> => {
        try {
          return await locator.isVisible();
        } catch {
          return false;
        }
      });
    try {
      await expect
        .poll(
          async () => {
            const rowsCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.rowsCount));
            if (!Number.isFinite(rowsCount) || rowsCount <= 0) return false;
            for (let index = rowsCount - 1; index >= 0; index--) {
              try {
                await this.scrollMessageIntoView(index);
              } catch {
                return false;
              }
              if (await matches()) return true;
            }
            return false;
          },
          { timeout }
        )
        .toBe(true);
    } catch {
      await expect(locator).toBeVisible({ timeout: TIMEOUTS.QUICK });
    }
  }

  /**
   * Assert no message containing the given text exists anywhere in the
   * conversation. Happy path (instant): every message is already in the DOM
   * (`data-message-count` === DOM `[data-message-id]` count), so a single
   * negative check is definitive. Otherwise scrolls top→bottom confirming the
   * text never appears at any scroll position.
   */
  async assertMessageNotVisible(text: string, options?: { exact?: boolean }): Promise<void> {
    const exact = options?.exact ?? false;
    const locator = this.messageList.getByText(text, { exact });

    // Same gate as countMessages: don't read `data-message-count` until the
    // app has finished its decryption pass, or the negative check could
    // succeed against a transient "messages.length=0" render.
    await this.messageList
      .and(this.page.locator(`[${TEST_SIGNALS.messagesReady}="true"]`))
      .waitFor({ timeout: TIMEOUTS.ASSERT });

    const stateCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.messageCount));
    const domCount = await this.messageList.locator(MESSAGE_ID_SELECTOR).count();

    // Happy path: all messages are rendered — one negative check is definitive.
    if (stateCount === domCount) {
      await expect(locator).not.toBeVisible();
      return;
    }

    // Slow path: scroll top→bottom, confirm text never appears.
    await this.scrollToTop();
    await this.waitForScrollStable();
    let done = false;
    while (!done) {
      if (
        await locator
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        throw new Error(`assertMessageNotVisible: found message with text "${text}"`);
      }
      if (await this.isAtScrollBottom()) {
        done = true;
      } else {
        await this.scrollByViewportFraction(0.8);
        await this.waitForScrollStable();
      }
    }
  }

  /**
   * Scroll top→bottom collecting unique `data-message-id` values that enter
   * the DOM. Used internally by `countMessages` and the nametag assertion.
   */
  private async collectMessagesByScrolling(role?: 'user' | 'assistant'): Promise<Set<string>> {
    const seen = new Set<string>();
    await this.scrollToTop();
    await this.waitForScrollStable();

    const selector =
      role === undefined ? MESSAGE_ID_SELECTOR : `[${ROLE_ATTR}="${role}"]${MESSAGE_ID_SELECTOR}`;

    let done = false;
    while (!done) {
      const ids = await this.messageList
        .locator(selector)
        .evaluateAll(
          (els, attribute: string) => els.map((el) => el.getAttribute(attribute)),
          TEST_SIGNALS.messageId
        );
      for (const id of ids) {
        if (id !== null) seen.add(id);
      }

      if (await this.isAtScrollBottom()) {
        done = true;
      } else {
        await this.scrollByViewportFraction(0.8);
        await this.waitForScrollStable();
      }
    }
    return seen;
  }

  private async scrollByViewportFraction(frac: number): Promise<void> {
    await this.viewport.evaluate((el, f) => {
      el.scrollTop += el.clientHeight * f;
    }, frac);
  }

  private async isAtScrollBottom(): Promise<boolean> {
    const { scrollTop, scrollHeight, clientHeight } = await this.getScrollPosition();
    return scrollTop + clientHeight >= scrollHeight - 10;
  }

  async expectNewChatPageVisible(): Promise<void> {
    await expect(this.newChatPage).toBeVisible();
  }

  async expectPromptInputVisible(): Promise<void> {
    await expect(this.promptInput).toBeVisible();
  }

  async expectSuggestionChipsVisible(): Promise<void> {
    await expect(this.suggestionChips).toBeVisible();
  }

  async waitForAIResponse(
    expectedContent?: string,
    // STREAM_SATURATED, not STREAM: a first message to a fresh conversation cold-
    // starts its ConversationRoom DO, and under the saturated matrix that first
    // token is starved (the stream POST sits open, not dropped) well past the
    // warm-path budget. Callers wanting the tighter warm bound pass it explicitly.
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<void> {
    const assistantMessages = this.messageList.locator(`[${ROLE_ATTR}="assistant"]`);

    const target = expectedContent
      ? assistantMessages.getByText(expectedContent, { exact: false }).first()
      : assistantMessages.getByText(/^Echo:/).first();

    await expect(target).toBeVisible({ timeout });
    await this.waitForStreamComplete();
  }

  async expectAssistantMessageContains(text: string): Promise<void> {
    await expect(this.messageList.getByText(text).first()).toBeVisible();
  }

  async expectMessageCostVisible(): Promise<void> {
    await expect(this.messageList.getByTestId(TEST_IDS.messageCost).first()).toBeVisible();
  }

  /**
   * Read the current value of `data-streams-completed` — a monotonic counter
   * the MessageList increments each time `streamingMessageIds` transitions
   * from non-empty to empty (i.e. each completed stream cycle).
   *
   * Capture this BEFORE the action that triggers a stream, then pair with
   * `waitForStreamCycle(baseline)` (or use `withStreamCycle(action)`) to
   * deterministically wait for the cycle to complete. This is strictly
   * better than `waitForStreamComplete()` for new callers: there's no
   * window in which the stream can start-and-finish faster than a poller
   * can observe `data-streaming-count > 0`.
   */
  async captureStreamBaseline(): Promise<number> {
    return Number((await this.messageList.getAttribute(TEST_SIGNALS.streamsCompleted)) ?? '0');
  }

  /**
   * Read the monotonic pre-inference-stage counter; capture before a Smart Model
   * send, then `waitForPreInferenceStage(baseline)` to prove the stage ran.
   */
  async capturePreInferenceBaseline(): Promise<number> {
    return Number(
      (await this.messageList.getAttribute(TEST_SIGNALS.preInferenceStagesSeen)) ?? '0'
    );
  }

  /** Wait for at least one pre-inference stage to be observed since `baseline`. */
  async waitForPreInferenceStage(
    baseline: number,
    timeout: number = TIMEOUTS.STREAM
  ): Promise<void> {
    await expect
      .poll(
        async () =>
          Number((await this.messageList.getAttribute(TEST_SIGNALS.preInferenceStagesSeen)) ?? '0'),
        { timeout }
      )
      .toBeGreaterThan(baseline);
  }

  /**
   * Wait for at least one stream cycle to complete since `baseline`. Pair with
   * `captureStreamBaseline()` taken before the action that triggers the stream.
   *
   * Unlike the legacy `waitForStreamComplete`, the assertion is over the
   * cycle counter (a fact: "a cycle finished") rather than over a transient
   * state (`streaming-count > 0`) that can transition too quickly to observe.
   */
  async waitForStreamCycle(
    baseline: number,
    // STREAM_SATURATED, not STREAM: a stream cycle (including a regeneration that
    // deletes then re-streams) completes far slower when the conversation DO is
    // CPU-starved under the saturated matrix. The cycle counter still advances —
    // it is delayed, not lost.
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<void> {
    await expect
      .poll(
        async () =>
          Number((await this.messageList.getAttribute(TEST_SIGNALS.streamsCompleted)) ?? '0'),
        { timeout }
      )
      .toBeGreaterThan(baseline);
    // After the cycle counter increments, streaming-count is by definition 0;
    // a short deadline catches any incoherent state.
    await expect(this.messageList).toHaveAttribute(TEST_SIGNALS.streamingCount, '0', {
      timeout: TIMEOUTS.QUICK,
    });
    // Toolbar is in the DOM once isStreaming clears; assert attachment, not
    // viewport visibility — see waitForStreamComplete for the full rationale.
    const lastToolbar = this.messageList.getByTestId(TEST_IDS.messageActions).last();
    await expect(lastToolbar).toBeAttached({ timeout: TIMEOUTS.ASSERT });
  }

  /**
   * Strict cycle-bounded helper: capture baseline, run `action`, wait for one
   * stream cycle to complete. Prefer this for tests that submit a turn and
   * then assert on the post-turn state.
   */
  async withStreamCycle<T>(
    action: () => Promise<T>,
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<T> {
    const baseline = await this.captureStreamBaseline();
    const result = await action();
    await this.waitForStreamCycle(baseline, timeout);
    return result;
  }

  /**
   * Wait for the active streaming turn (text or media) to complete and persist.
   * Gates on the message list's live `data-streaming-count` — the size of the
   * client's `streamingMessageIds`, which only returns to 0 after the SSE `done`
   * event, i.e. after the turn's messages are persisted server-side.
   *
   * Contract: caller must have already established that a stream is incoming
   * (e.g. via `waitForAIResponse(specificContent)`), otherwise this returns
   * immediately on a pre-existing `data-streaming-count === '0'`. For strict
   * cycle gating that doesn't rely on caller discipline, prefer
   * `withStreamCycle(action)` or `captureStreamBaseline()` +
   * `waitForStreamCycle(baseline)`.
   *
   * The previous implementation tried to bridge the contract gap with an
   * `expect.poll(...).toBeGreaterThan(0).catch(...)` grace window. The
   * `.catch` swallowed the throw but Playwright still recorded the failed
   * assertion on the test result, causing the test to retry. The grace is
   * removed; callers that need start-or-skip-equivalence should adopt the
   * cycle-counter helpers above.
   */
  async waitForStreamComplete(timeout: number = TIMEOUTS.STREAM_SATURATED): Promise<void> {
    await expect(this.messageList).toHaveAttribute(TEST_SIGNALS.streamingCount, '0', {
      timeout,
    });
    // Once streaming has drained (data-streaming-count === 0) the assistant's
    // toolbar is already in the DOM — isStreaming cleared earlier, at the
    // model:done flip. Assert attachment, not viewport visibility: the toolbar
    // is `translate-y-full` and `.last()` can sit below the scroll fold (short
    // mobile viewports, or after a deliberate scroll-up), and scrolling it into
    // view here would corrupt the caller's scroll-position assertions. This
    // still catches the "frozen UI / toolbar never renders" regression (the
    // Bug 6 cost-settlement anti-pattern); tests that click the toolbar gate
    // its visibility explicitly via prepareMessage() + a polled scroll-into-view.
    const lastToolbar = this.messageList.getByTestId(TEST_IDS.messageActions).last();
    await expect(lastToolbar).toBeAttached({ timeout: TIMEOUTS.ASSERT });
  }

  // --- Message queue (pending sends while a run streams) ---

  /**
   * The queued-messages region above the composer. Only mounted while at least
   * one message is queued, so `not.toBeVisible()` on it proves the queue drained.
   */
  queuedRegion(): Locator {
    return this.page.getByTestId(TEST_IDS.queuedMessages);
  }

  /** The queued-message pill at `index` (0 = oldest, sends next). */
  queuedPill(index: number): Locator {
    return this.page.getByTestId(TEST_ID_BUILDERS.queuedMessageItem(index));
  }

  /** Number of queued pills currently rendered (0 when the region is unmounted). */
  async queuedPillCount(): Promise<number> {
    return this.queuedRegion().getByRole('listitem').count();
  }

  /** Cancel (dequeue) the queued pill at `index` via its X control. */
  async cancelQueuedPill(index: number): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.queuedMessageCancel(index)).click();
  }

  /**
   * Enqueue `text` while a run is streaming: type it and submit. During
   * `isProcessing` the composer routes Enter to the queue (onQueue) and clears
   * the input, so the text becomes a pending pill rather than a sent turn. Gate
   * on `waitForStreamingActive()` first so the run is genuinely in-flight —
   * submitting once the run has settled would send the message instead.
   */
  async enqueueWhileStreaming(text: string): Promise<void> {
    await this.messageInput.fill(text);
    await this.messageInput.press('Enter');
    await expect(this.messageInput).toHaveValue('');
  }

  /**
   * Wait until a run is actively streaming — the message list's
   * `data-streaming-count` signal is above zero. Pairs with a send to gate on
   * the run being in-flight without waiting for it to finish.
   */
  async waitForStreamingActive(timeout: number = TIMEOUTS.STREAM_SATURATED): Promise<void> {
    await expect
      .poll(
        async () =>
          Number((await this.messageList.getAttribute(TEST_SIGNALS.streamingCount)) ?? '0'),
        { timeout }
      )
      .toBeGreaterThan(0);
  }

  /**
   * Wait for `count` stream cycles to complete since `baseline`
   * (`data-streams-completed` advanced by at least `count`) and for streaming to
   * be fully drained. Use to gate an auto-draining queue where one run's settle
   * chains into the next send: asserting the intermediate `streaming-count === 0`
   * (as `waitForStreamCycle` does) would race the next cycle starting.
   */
  async waitForStreamCyclesCompleted(
    baseline: number,
    count: number,
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<void> {
    await expect
      .poll(
        async () =>
          Number((await this.messageList.getAttribute(TEST_SIGNALS.streamsCompleted)) ?? '0'),
        { timeout }
      )
      .toBeGreaterThanOrEqual(baseline + count);
    await expect(this.messageList).toHaveAttribute(TEST_SIGNALS.streamingCount, '0', {
      timeout: TIMEOUTS.ASSERT,
    });
  }

  /**
   * Assert no message with `text` is present in the conversation list. Unlike
   * `assertMessageNotVisible`, it skips the `data-messages-ready` gate so it can
   * run mid-stream — where a queued (not sent) message must be absent.
   */
  async expectMessageAbsent(text: string): Promise<void> {
    await expect(this.messageList.getByText(text, { exact: true })).not.toBeVisible();
  }

  /**
   * Arm the dev/E2E-only "hold primary stream" mock for every subsequent chat
   * send: the mocked stream emits its first chunk, then parks (streaming stays
   * observably active) until `releaseHeldStream` resolves the barrier. This lets
   * a test pin the stream open and enqueue mid-stream with zero wall-clock
   * racing. The header rides on `page.request` too, so clear it via
   * `stopHoldingStreams()` before any send that must stream to completion on its
   * own (e.g. a queue's auto-drain) — otherwise that send parks with no release.
   */
  async holdPrimaryStreamForNextSends(): Promise<void> {
    await this.page.setExtraHTTPHeaders({ 'x-mock-hold-primary-stream': 'true' });
  }

  /** Clear the hold header so subsequent sends stream to completion normally. */
  async stopHoldingStreams(): Promise<void> {
    await this.page.setExtraHTTPHeaders({});
  }

  /**
   * Release a stream parked by the hold mock via the dev-only Worker route,
   * letting the held run complete. Idempotent server-side — releasing when
   * nothing is held is a harmless no-op. Uses the same request context as the
   * other API-backed helpers so it shares the page's auth/base URL.
   */
  async releaseHeldStream(conversationId: string): Promise<void> {
    const url = `${apiUrl}/chat/mock/release-stream?conversationId=${conversationId}`;
    const response = await withRequestRetry(this.page.request).get(url);
    if (!response.ok()) {
      throw new Error(`Failed to release held stream: ${String(response.status())}`);
    }
  }

  /** Switch the prompt input to image generation modality. Click the image icon button. */
  async switchToImageMode(): Promise<void> {
    await this.waitForAppStable();
    const imageIcon = this.page.getByRole('button', { name: /switch to image/i });
    await expect(imageIcon).toBeVisible();
    await imageIcon.click();
    // Confirmation: either the inline aspect-ratio pill (desktop) or the
    // GenerationSummaryChip (mobile) — both carry "1:1" in their accessible
    // name when 1:1 is the default. Substring match accepts either layout.
    await expect(this.page.getByRole('button', { name: /1:1/i })).toBeVisible();
  }

  /** Switch the prompt input back to the text modality. Click the text icon button. */
  async switchToTextMode(): Promise<void> {
    await this.waitForAppStable();
    const textIcon = this.page.getByRole('button', { name: /switch to text/i });
    await expect(textIcon).toBeVisible();
    await textIcon.click();
    // Confirmation: the image/video config pills unmount once text is active.
    await expect(this.page.getByRole('button', { name: /1:1|720p/i })).not.toBeVisible();
  }

  /** Switch the prompt input to video generation modality. Click the video icon button. */
  async switchToVideoMode(): Promise<void> {
    await this.waitForAppStable();
    const videoIcon = this.page.getByRole('button', { name: /switch to video/i });
    await expect(videoIcon).toBeVisible();
    await videoIcon.click();
    // Confirmation: either the inline 720p resolution pill (desktop) or the
    // GenerationSummaryChip (mobile, name embeds the default "720p"). Either
    // layout satisfies the substring match.
    await expect(this.page.getByRole('button', { name: /720p/i })).toBeVisible();
  }

  /**
   * Locator for the open `GenerationConfigSheet`. The Overlay component renders
   * as a Radix Dialog (desktop) or vaul Drawer (mobile); both expose `role=dialog`
   * with the sr-only Title text as the accessible name. Anchoring on the
   * "* generation settings" suffix keeps this distinct from other dialogs
   * (model selector, invite link, etc.) that may also live in the tree.
   */
  private generationSheet(): Locator {
    return this.page.getByRole('dialog', { name: /generation settings$/i });
  }

  /**
   * Opens the mobile `GenerationConfigSheet` bottom sheet if it isn't open.
   * No-op on desktop (the chip doesn't exist) and when the sheet is already
   * open. Tests that interact with aspect-ratio / resolution / duration
   * controls call this so the underlying `*Control` components are
   * actually rendered — on mobile they live inside the sheet, not inline.
   *
   * Uses `waitFor` so a still-mounting DOM (e.g. caller invoked the helper
   * before the modality-switch render had committed) doesn't race a one-shot
   * `count()` and short-circuit into the wrong branch. `getByRole` excludes
   * `aria-hidden` elements, so the "sheet already open" case naturally times
   * out into the no-op branch — the chip is in the inert subtree and won't
   * attach by role.
   */
  async openGenerationSheetIfNeeded(): Promise<void> {
    const chip = this.page.getByRole('button', { name: /^(Image|Video) settings:/i });
    const present = await chip
      .first()
      .waitFor({ state: 'visible', timeout: TIMEOUTS.MODAL })
      .then(() => true)
      .catch(() => false);
    if (!present) return;
    await chip.first().click();
    await expect(this.generationSheet()).toBeVisible();
  }

  /**
   * Closes the mobile `GenerationConfigSheet` if it's open. No-op otherwise.
   * Tests call this between configuring generation settings and sending the
   * prompt, so the sheet doesn't block the composer interaction.
   *
   * The presence probe is short by design: on desktop the sheet is never
   * mounted, so the wait always times out into the no-op branch and shouldn't
   * stall the suite.
   */
  async closeGenerationSheetIfOpen(): Promise<void> {
    const sheet = this.generationSheet();
    const open = await sheet
      .waitFor({ state: 'visible', timeout: TIMEOUTS.QUICK })
      .then(() => true)
      .catch(() => false);
    if (!open) return;
    await this.page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
  }

  /** Click an aspect-ratio toggle pill ('1:1' | '16:9' | '9:16' | '4:5' etc). */
  async selectAspectRatio(ratio: string): Promise<void> {
    await this.openGenerationSheetIfNeeded();
    const pill = this.page.getByRole('button', { name: ratio, exact: true });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  }

  /**
   * Click a video resolution toggle pill ('720p' | '1080p' | '4k'). The pill's
   * accessible name is the bare resolution string — the visible "HD"/"FHD"
   * label and price live elsewhere in the row. Exact match avoids colliding
   * with the mobile `GenerationSummaryChip`, whose name embeds the resolution.
   */
  async selectResolution(resolution: '720p' | '1080p' | '4k'): Promise<void> {
    await this.openGenerationSheetIfNeeded();
    const pill = this.page.getByRole('button', { name: resolution, exact: true });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  }

  /** Drag the video duration slider to N seconds (uses keyboard for determinism). */
  async setVideoDuration(seconds: number): Promise<void> {
    await this.openGenerationSheetIfNeeded();
    const slider = this.page.getByRole('slider', { name: /video duration in seconds/i });
    await expect(slider).toBeVisible();
    await slider.focus();
    // Range inputs are controlled by React state; setting `input.value` alone
    // is overwritten on the next render. Use the native HTMLInputElement value
    // setter so React's onChange synthetic event picks up the new value.
    await slider.evaluate((el, value) => {
      const input = el as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      // eslint-disable-next-line @typescript-eslint/unbound-method -- descriptor.set is invoked via .call(input)
      const setter = descriptor?.set;
      setter?.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, seconds);
    await expect(slider).toHaveValue(String(seconds));
  }

  /**
   * Wait until the matched media element has decoded bytes — `naturalWidth > 0`
   * for `<img>`, `readyState >= HAVE_METADATA` (with no `el.error`) for
   * `<video>`. `toBeVisible()` alone is insufficient on iPhone-15: a
   * freshly-mounted lazy `<img>` with no `width`/`height` attributes can be
   * in the DOM with a 0×0 bounding box and report as "hidden" until the bytes
   * actually decode.
   *
   * The video branch one-shot-nudges `el.load()` on first poll because
   * WebKitGTK's GStreamer pipeline doesn't always fire `loadedmetadata` for
   * `<video src=blob: preload="metadata">` without a programmatic kick. The
   * sentinel keeps it idempotent so we don't restart the load on every poll.
   * `el.error === null` is checked first so corrupt bytes still fail fast
   * instead of being papered over by the nudge.
   *
   * On engines where Playwright cannot decode video (Linux WebKit — see
   * `../helpers/webkit-media-decode.ts`), the video branch downgrades to a
   * "non-empty src" check so the rest of the test still runs end-to-end.
   * Production Safari decodes the same bytes natively.
   */
  private async expectMediaLoaded(
    media: Locator,
    timeout: number = TIMEOUTS.MEDIA_DECODE
  ): Promise<void> {
    const skipVideoDecode = lacksMediaDecode(getBrowserName(this.page));
    await expect
      .poll(
        async () =>
          media.evaluate((el, skipDecode: boolean) => {
            if (el instanceof HTMLImageElement) return el.naturalWidth;
            if (!(el instanceof HTMLVideoElement)) return 0;
            const v = el as HTMLVideoElement & { __pwLoadNudged?: boolean };
            if (v.error !== null) return 0;
            if (skipDecode) return v.currentSrc || v.src ? 1 : 0;
            if (v.readyState >= 1) return 1;
            if (!v.__pwLoadNudged) {
              v.__pwLoadNudged = true;
              v.load();
            }
            return 0;
          }, skipVideoDecode),
        { timeout }
      )
      .toBeGreaterThan(0);
  }

  /**
   * Wait for an inline media element to render anywhere in the message
   * list. Each poll iteration re-walks rows bottom→top so a late-arriving
   * row (post-`waitForStreamComplete` refetch) gets visited. Success
   * requires decoded bytes — `naturalWidth > 0` or a playable duration —
   * to avoid passing on a `MediaPlaceholder` or a still-decrypting `<img>`
   * with a 0×0 bounding box.
   */
  async expectMediaVisible(
    kind: 'img' | 'video',
    timeout: number = TIMEOUTS.MEDIA_DECODE
  ): Promise<void> {
    const media = this.messageList.locator(kind).first();
    const skipVideoDecode = lacksMediaDecode(getBrowserName(this.page));
    await this.revealByRowScan(media, timeout, async () => {
      if (!(await media.isVisible().catch(() => false))) return false;
      return media
        .evaluate((el, skipDecode: boolean) => {
          if (el instanceof HTMLImageElement) return el.naturalWidth > 0;
          if (el instanceof HTMLVideoElement) {
            // Mirrors expectMediaLoaded: one-shot `el.load()` nudge
            // for WebKitGTK's lazy-metadata-on-blob behavior, sentinel
            // prevents repeated cancel/restart cycles. Real corrupt
            // bytes still surface via `el.error`. On engines that
            // can't decode (Linux WebKit — see
            // `../helpers/webkit-media-decode.ts`), pass as soon as
            // the element has a non-empty src.
            const v = el as HTMLVideoElement & { __pwLoadNudged?: boolean };
            if (v.error !== null) return false;
            if (skipDecode) return Boolean(v.currentSrc || v.src);
            if (v.readyState >= 1) return true;
            if (!v.__pwLoadNudged) {
              v.__pwLoadNudged = true;
              v.load();
            }
            return false;
          }
          return false;
        }, skipVideoDecode)
        .catch(() => false);
    });
    await this.expectMediaLoaded(media);
  }

  /**
   * Park the message at `index` in Virtuoso's mounted window and assert
   * that an `<img>` (or `<video>`) inside that row is visible and
   * dimensionally settled. Use this when a test needs media at a specific
   * row; use `expectImageVisible` / `expectVideoVisible` for "anywhere".
   *
   * Polls scroll-then-check (not scroll-once-then-poll): on iPhone-15
   * Virtuoso can re-virtualize the row between our scroll and the
   * visibility check; re-anchoring each iteration recovers from that.
   */
  async expectMediaVisibleAt(
    index: number,
    kind: 'img' | 'video',
    timeout: number = TIMEOUTS.MEDIA_DECODE
  ): Promise<void> {
    const media = this.getMessage(index).locator(kind).first();
    try {
      await expect
        .poll(
          async () => {
            try {
              await this.scrollMessageIntoView(index);
            } catch {
              return false;
            }
            return media.isVisible().catch(() => false);
          },
          { timeout }
        )
        .toBe(true);
    } catch {
      // Surface Playwright's rich locator error (attached/visible state) on
      // failure instead of `expect.poll`'s opaque boolean mismatch. The poll
      // above already consumed the real budget, so this re-assertion only needs
      // a short window to render the rich error against the still-failing
      // locator.
      await expect(media).toBeVisible({ timeout: TIMEOUTS.QUICK });
    }
    await this.expectMediaLoaded(media);
  }

  async expectImageVisible(timeout: number = TIMEOUTS.MEDIA_DECODE): Promise<void> {
    await this.expectMediaVisible('img', timeout);
  }

  async expectVideoVisible(timeout: number = TIMEOUTS.MEDIA_DECODE): Promise<void> {
    await this.expectMediaVisible('video', timeout);
  }

  /** Confirm the "Download media" link is rendered alongside the inline media element. */
  async expectDownloadLinkVisible(): Promise<void> {
    const downloadLink = this.messageList.getByRole('link', { name: /download media/i }).first();
    await expect(downloadLink).toBeVisible();
  }

  /** Returns the href of the first download media link in the assistant message list. */
  async getDownloadLinkHref(): Promise<string | null> {
    const downloadLink = this.messageList.getByRole('link', { name: /download media/i }).first();
    return downloadLink.getAttribute('href');
  }

  getSenderLabels(): Locator {
    return this.messageList.getByTestId(TEST_IDS.senderLabel);
  }

  getAiToggleButton(): Locator {
    return this.page.getByRole('button', { name: /AI response/ });
  }

  getTypingIndicator(): Locator {
    return this.page.getByTestId(TEST_IDS.typingIndicator);
  }

  getMessageGroups(): Locator {
    return this.messageList.getByTestId(TEST_IDS.messageItem);
  }

  /** Message items carrying the given role signal (`data-role`). */
  messagesByRole(role: 'assistant' | 'user'): Locator {
    return this.messageList.locator(`[${ROLE_ATTR}="${role}"]`);
  }

  /** A message item addressed by its message-id signal. */
  messageById(messageId: string): Locator {
    return this.messageList.locator(
      `[${TEST_SIGNALS.messageId}="${escapeAttributeValue(messageId)}"]`
    );
  }

  /** A role-tagged message within a specific Virtuoso row (`data-item-index`). */
  messageAtRow(rowIndex: number, role: 'assistant' | 'user'): Locator {
    return this.messageList.locator(
      `[data-item-index="${String(rowIndex)}"] [${ROLE_ATTR}="${role}"]`
    );
  }

  /** Persisted assistant tiles — assistant messages carrying a message-id. */
  assistantTilesWithId(): Locator {
    return this.messageList.locator(`[${ROLE_ATTR}="assistant"][${TEST_SIGNALS.messageId}]`);
  }

  /** `<video>` elements within a scope. `<video>` has no ARIA role, so a raw element locator is required. */
  videosIn(scope: Locator): Locator {
    return scope.locator('video');
  }

  /** `<video>` elements with a specific `src` within a scope. */
  videosWithSrcIn(scope: Locator, source: string): Locator {
    return scope.locator(`video[src="${escapeAttributeValue(source)}"]`);
  }

  /** `<img>` elements within a scope. Selected by element since generated images may carry an empty alt (presentation role). */
  imagesIn(scope: Locator): Locator {
    return scope.locator('img');
  }

  /** `<img>` elements with an empty `src` (would render as a broken image). */
  brokenImagesIn(scope: Locator): Locator {
    return scope.locator('img[src=""]');
  }

  /** Model rows in the open selector matching the model-item id prefix plus a CSS suffix. */
  private modelItemsMatching(suffix: string): Locator {
    return this.page
      .getByTestId(TEST_IDS.modelSelectorModal)
      .locator(`${MODEL_ITEM_PREFIX}${suffix}`);
  }

  /** Model rows in the open model selector that are currently selected. */
  selectedModelItems(): Locator {
    return this.modelItemsMatching('[data-selected="true"]');
  }

  /** Unselected, selectable (not premium-locked) model rows in the open selector. */
  unselectedSelectableModelItems(): Locator {
    return this.modelItemsMatching(`[data-selected="false"]:not(:has(${LOCK_ICON_SELECTOR}))`);
  }

  /** Selectable (not premium-locked) model rows in the open selector. */
  selectableModelItems(): Locator {
    return this.modelItemsMatching(`:not(:has(${LOCK_ICON_SELECTOR}))`);
  }

  /** Selectable model rows excluding the Smart Model (a concrete provider model). */
  nonPremiumModelItems(): Locator {
    return this.page.getByTestId(TEST_IDS.modelSelectorModal).locator(NON_PREMIUM_MODEL_ITEMS);
  }

  /** All model rows in the open selector. */
  modelItems(): Locator {
    return this.modelItemsMatching('');
  }

  /** Premium-locked model rows in the open selector. */
  lockedModelItems(): Locator {
    return this.modelItemsMatching(`:has(${LOCK_ICON_SELECTOR})`);
  }

  async getScrollPosition(): Promise<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }> {
    return this.viewport.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
  }

  async scrollToTop(): Promise<void> {
    await this.viewport.evaluate((el) => {
      // Dispatch the wheel gesture the app's break-away listener keys off (see
      // scrollUp) BEFORE moving the scroller. A bare `scrollTop = 0` fires no
      // user-scroll event, so auto-follow never disengages and re-pins the list
      // to the bottom on the next post-stream re-render — under a saturated
      // mobile engine that snaps the just-revealed top message back off-screen.
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -el.scrollHeight }));
      el.scrollTop = 0;
    });
  }

  async scrollUp(pixels: number): Promise<void> {
    // The app disengages auto-follow ("break away from bottom") only on a real
    // wheel/touchmove/keydown event (message-list markUserScroll); a bare
    // scrollTop write fires no such event, so the list re-pins to bottom and the
    // breakaway never registers. Dispatch the wheel event the breakaway listener
    // keys off (the same gesture the app's own unit tests use), then move the
    // scroller. markUserScroll does not check isTrusted, so the synthetic event
    // counts and this stays engine-portable (WebKit mouse-wheel support varies).
    await this.viewport.evaluate((el, px) => {
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -px }));
      el.scrollTop = Math.max(0, el.scrollTop - px);
    }, pixels);
  }

  async isInputFocused(): Promise<boolean> {
    return this.messageInput.evaluate((el) => el === document.activeElement);
  }

  async selectNonPremiumModel(): Promise<void> {
    await this.selectModels(1);
  }

  async findOverflowingElements(): Promise<string[]> {
    return this.page.evaluate(() => {
      const skipPattern = /sr-only|truncate|overflow-hidden/;
      return [...document.querySelectorAll('*')]
        .map((element) => {
          const el = element as HTMLElement;
          const overflow = el.scrollWidth - el.clientWidth;
          return { el, overflow };
        })
        .filter(({ el, overflow }) => overflow > 100 && el.clientWidth > 0)
        .filter(({ el }) => !skipPattern.test(el.className))
        .map(({ el, overflow }) => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className ? `.${el.className.replaceAll(/\s+/g, '.')}` : '';
          const testId = el.dataset['testid'] ? `[data-testid="${el.dataset['testid']}"]` : '';
          const slot = el.dataset['slot'] ? `[data-slot="${el.dataset['slot']}"]` : '';
          return `${tag}${id}${testId}${slot} overflow:${String(overflow)} scrollW:${String(el.scrollWidth)} clientW:${String(el.clientWidth)}\n  classes: ${cls.slice(0, 200)}`;
        });
    });
  }

  async getViewportWidth(): Promise<number> {
    return this.page.evaluate(() => window.innerWidth);
  }

  async getDocumentDimensions(): Promise<{ scrollWidth: number; clientWidth: number }> {
    return this.page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
  }

  async scrollToBottom(): Promise<void> {
    await this.viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }

  async getMessageCountViaAPI(): Promise<number> {
    const conversationId = this.getConversationIdFromUrl();
    const url = `${apiUrl}/conversations/${conversationId}/messages`;
    const response = await withRequestRetry(this.page.request).get(url);
    if (!response.ok()) {
      throw new Error(`Failed to get conversation: ${String(response.status())}`);
    }
    const data = (await response.json()) as { messages: unknown[] };
    return data.messages.length;
  }

  /**
   * Get the message-item at Virtuoso row index N (0-indexed). Addresses by
   * `data-item-index` (Virtuoso's per-row attribute) rather than by DOM
   * position, so callers don't get the wrong message when some rows are
   * virtualized out of the DOM.
   */
  getMessage(index: number): Locator {
    // `data-item-index` is Virtuoso's own per-row attribute, not an app signal.
    return this.messageList
      .locator(`[data-item-index="${String(index)}"]`)
      .getByTestId(TEST_IDS.messageItem);
  }

  /** Get the last message item. */
  getLastMessage(): Locator {
    return this.messageList.getByTestId(TEST_IDS.messageItem).last();
  }

  /** Get message count in the visible list. */
  async getMessageCount(): Promise<number> {
    return this.messageList.getByTestId(TEST_IDS.messageItem).count();
  }

  /**
   * Read the current Virtuoso row count from `data-rows-count` and return
   * the index of the last row. Throws if no rows exist — callers that
   * capture an index for later use should fail loudly here rather than
   * silently propagate a sentinel.
   */
  async getLastRowIndex(): Promise<number> {
    const rowsCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.rowsCount));
    if (!Number.isFinite(rowsCount) || rowsCount <= 0) {
      throw new Error(
        `getLastRowIndex: data-rows-count is ${String(rowsCount)}; expected at least one row`
      );
    }
    return rowsCount - 1;
  }

  /**
   * Deterministically park a virtualized row in view. Uses Virtuoso's native
   * `scrollIntoView({ index, done })` via the dev/E2E-gated window backdoor in
   * `MessageList`. Resolves when the target row is measured and mounted —
   * `getMessage(index)` is guaranteed to resolve afterwards. Avoids the
   * iPhone-15 virtualization failure mode where `scrollTop = 0` alone leaves
   * the target unmounted because a tall media tile dominates the viewport.
   *
   * `index` is a Virtuoso row index, NOT a message index. In group chats
   * consecutive same-sender messages are collapsed into a single row, so
   * `rowsCount < messageCount`. Use `data-rows-count` (exposed by the
   * MessageList component) to bound the index.
   */
  async scrollMessageIntoView(index: number): Promise<void> {
    const rowsCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.rowsCount));
    if (Number.isNaN(rowsCount) || index < 0 || index >= rowsCount) {
      throw new Error(
        `scrollMessageIntoView: index ${String(index)} out of range [0, ${String(rowsCount)})`
      );
    }
    await this.page.evaluate(async (index_) => {
      const function_ = (
        globalThis as unknown as { __virtuosoScrollToIndex?: (n: number) => Promise<void> }
      ).__virtuosoScrollToIndex;
      if (typeof function_ !== 'function') {
        throw new TypeError(
          '__virtuosoScrollToIndex not exposed — check env.isLocalDev or env.isE2E is true'
        );
      }
      await function_(index_);
    }, index);
    // Short deadline so the outer poll can retry on re-virtualize.
    await expect(this.getMessage(index)).toBeAttached({ timeout: TIMEOUTS.QUICK });
  }

  /**
   * Park the row at `index` in Virtuoso's mounted window so its action buttons
   * are reachable. Polls to survive Virtuoso remount on fork-tab switch.
   * The predicate is not wrapped in try/catch — expect.poll retries on thrown
   * errors and surfaces the last one on timeout, so genuine "index out of range"
   * bugs are reported with their original message instead of "expected true,
   * received false".
   */
  async prepareMessage(index: number): Promise<void> {
    await expect
      .poll(
        async () => {
          await this.scrollMessageIntoView(index);
          return true;
        },
        { timeout: TIMEOUTS.SCROLL_STABLE, intervals: [100, 250, 500, 500, 500, 500] }
      )
      .toBe(true);
  }

  /**
   * Park the last row. `getLastRowIndex()` is intentionally inside the poll —
   * during streaming the last index can grow between attempts.
   */
  async prepareLastMessage(): Promise<void> {
    await expect
      .poll(
        async () => {
          await this.scrollMessageIntoView(await this.getLastRowIndex());
          return true;
        },
        { timeout: TIMEOUTS.SCROLL_STABLE, intervals: [100, 250, 500, 500, 500, 500] }
      )
      .toBe(true);
  }

  /** Get action button on a specific message by aria-label. */
  private getActionButton(messageIndex: number, label: string): Locator {
    return this.getMessage(messageIndex).getByRole('button', { name: label });
  }

  /** Get action button on the last message by aria-label. */
  private getLastMessageActionButton(label: string): Locator {
    return this.getLastMessage().getByRole('button', { name: label });
  }

  getRetryButton(index: number): Locator {
    return this.getActionButton(index, 'Retry');
  }

  getEditButton(index: number): Locator {
    return this.getActionButton(index, 'Edit');
  }

  getRegenerateButton(index: number): Locator {
    return this.getActionButton(index, 'Regenerate');
  }

  getForkButton(index: number): Locator {
    return this.getActionButton(index, 'Fork');
  }

  /**
   * Gate a retry/regenerate dispatch on the decrypted message set being ready —
   * the app no-ops a regenerate whose anchor content isn't decrypted yet, so an
   * early click would never start a stream.
   */
  async waitForMessagesReady(): Promise<void> {
    await expect(this.messageList).toHaveAttribute(TEST_SIGNALS.messagesReady, 'true', {
      timeout: TIMEOUTS.CONVERSATION_LOAD,
    });
  }

  async clickRetry(index: number): Promise<void> {
    await this.waitForMessagesReady();
    await this.prepareMessage(index);
    await this.getRetryButton(index).click();
  }

  async clickEdit(index: number): Promise<void> {
    await this.prepareMessage(index);
    await this.getEditButton(index).click();
  }

  async clickRegenerate(index: number): Promise<void> {
    await this.waitForMessagesReady();
    await this.prepareMessage(index);
    await this.getRegenerateButton(index).click();
  }

  async clickFork(index: number): Promise<void> {
    await this.prepareMessage(index);
    await this.getForkButton(index).click();
  }

  async clickForkOnLastMessage(): Promise<void> {
    await this.prepareLastMessage();
    await this.getLastMessageActionButton('Fork').click();
  }

  getForkTabList(): Locator {
    return this.page.getByRole('tablist', { name: 'Conversation forks' });
  }

  getForkTab(name: string): Locator {
    return this.getForkTabList().getByRole('tab', { name });
  }

  async clickForkTab(name: string): Promise<void> {
    await this.getForkTab(name).click();
  }

  async expectForkTabCount(count: number): Promise<void> {
    await expect(this.getForkTabList().getByRole('tab')).toHaveCount(count);
  }

  async expectActiveForkTab(name: string): Promise<void> {
    await expect(this.getForkTab(name)).toHaveAttribute('aria-selected', 'true');
  }

  async expectNoForkTabs(): Promise<void> {
    await expect(this.getForkTabList()).not.toBeVisible();
  }

  /** Open the three-dot menu on a fork tab by name, then click an action. */
  async clickForkTabMenuAction(tabName: string, action: 'Rename' | 'Delete'): Promise<void> {
    const tabWrapper = this.getForkTabList().locator(
      `[data-testid^="${TEST_ID_BUILDERS.forkTab('')}"]`,
      { has: this.page.getByRole('tab', { name: tabName }) }
    );
    await tabWrapper.getByRole('button', { name: 'More options' }).click();
    await this.page.getByRole('menuitem', { name: action }).click();
  }

  async expectEditModeActive(): Promise<void> {
    await expect(this.page.getByText('Editing message')).toBeVisible();
  }

  async expectEditModeInactive(): Promise<void> {
    await expect(this.page.getByText('Editing message')).not.toBeVisible();
  }

  async cancelEdit(): Promise<void> {
    await this.page.getByRole('button', { name: 'Cancel' }).click();
  }

  getForkIdFromUrl(): string | null {
    const url = new URL(this.page.url());
    return url.searchParams.get('fork');
  }

  // --- Rename / Delete modals (shared with sidebar) ---

  async confirmRename(newName: string): Promise<void> {
    await expect(this.page.getByText('Rename conversation', { exact: true })).toBeVisible();
    const input = this.page.locator('input[placeholder="Conversation title"]');
    await input.clear();
    await input.fill(newName);
    await this.page.getByTestId(TEST_IDS.saveRenameButton).click();
    await expect(this.page.getByText('Rename conversation', { exact: true })).not.toBeVisible();
  }

  async confirmDelete(): Promise<void> {
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId(TEST_IDS.confirmDeleteButton).click();
    await expect(this.page.getByText('Delete conversation?')).not.toBeVisible();
  }

  /** Open the model selector modal by clicking the header button. */
  async openModelSelector(): Promise<void> {
    await this.page.getByTestId(TEST_IDS.modelSelectorButton).click();
    await expect(this.page.getByTestId(TEST_IDS.modelSelectorModal)).toBeVisible();
  }

  /**
   * Switch the picker between single and multi modes by clicking the
   * appropriate option in the segmented PickerModeToggle. The toggle renders
   * twice (once per responsive layout); click the first visible option.
   */
  async switchPickerMode(mode: 'single' | 'multi'): Promise<void> {
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    const targetTestId = mode === 'single' ? TEST_IDS.pickerModeSingle : TEST_IDS.pickerModeMulti;
    await modal.getByTestId(targetTestId).first().click();
    await expect(modal).toHaveAttribute('data-picker-mode', mode);
  }

  /**
   * Toggle a model in the picker. In single mode this commits + closes; in
   * multi mode it toggles a checkbox in the local pending selection. Either
   * way, the row body is the click target now (no more checkbox-only zone).
   */
  async toggleModelInModal(modelId: string): Promise<void> {
    const item = this.page.getByTestId(TEST_ID_BUILDERS.modelItem(modelId));
    // Click the row's main button (the part that holds the model name + checkbox).
    await item.locator('button').first().click();
  }

  /**
   * Confirm the multi-mode pending selection via the footer Use button. In
   * single mode, row clicks commit + close immediately so this helper is
   * unnecessary — it falls through to closing via X if the modal is still
   * open with no Use button.
   */
  async confirmModelSelection(): Promise<void> {
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    const useButton = modal.getByTestId(TEST_IDS.useModelsButton);
    const isUseVisible = await useButton.isVisible().catch(() => false);
    if (isUseVisible) {
      await useButton.click();
    } else if (await modal.isVisible().catch(() => false)) {
      // Single mode after a row click already closed the modal; nothing to do.
      // If it's still open (no row was clicked), close via X.
      const closeButton = modal.getByRole('button', { name: 'Close' }).first();
      if (await closeButton.isVisible().catch(() => false)) {
        await closeButton.click();
      }
    }
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /**
   * The self-labeling reasoning-effort chip ("Effort · <current>") in the
   * composer controls row, immediately left of the send button.
   */
  effortChip(): Locator {
    return this.page.getByTestId(TEST_IDS.effortChip);
  }

  /**
   * Pick an effort level from the chip's upward menu (open-then-pick): open
   * the chip, click the menuitemradio carrying the full display word
   * (Medium's display word is "Mid"; "Min" is the OFF row — reasoning
   * disabled, not a low effort level), then assert the selection took via
   * the chip's own label — the app-emitted state, no wall-clock waits.
   */
  async selectReasoningEffort(
    level: 'Auto' | 'Min' | 'Lite' | 'Low' | 'Mid' | 'High' | 'Max'
  ): Promise<void> {
    await this.effortChip().click();
    await this.page.getByRole('menuitemradio', { name: level, exact: true }).click();
    await expect(this.effortChip()).toContainText(`Effort · ${level}`);
  }

  /**
   * The thinking disclosure inside one assistant message (per-message, like
   * the nametag assertions — never a page-global testid query, so a
   * multi-message conversation can't satisfy the assertion with the wrong
   * message's disclosure).
   */
  thinkingDisclosureFor(assistantMessage: Locator): Locator {
    return assistantMessage.getByTestId(TEST_IDS.thinkingDisclosure);
  }

  /**
   * Select a single model by name in single mode. Opens the picker, makes
   * sure single mode is active, clicks the row → commits + closes.
   */
  async selectSingleModel(modelId: string): Promise<void> {
    await this.openModelSelector();
    await this.switchPickerMode('single');
    const item = this.page.getByTestId(TEST_ID_BUILDERS.modelItem(modelId));
    await item.locator('button').first().click();
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /**
   * Select N non-premium models via the modal in multi mode. Opens, switches
   * to multi mode, clears any pending state, clicks the first N non-premium
   * rows, and confirms via Use.
   */
  async selectModels(count: number): Promise<void> {
    await this.openModelSelector();
    await this.switchPickerMode('multi');
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);

    const nonPremiumItems = modal.locator(NON_PREMIUM_MODEL_ITEMS);

    // Clear all pending selections to start from a known state.
    const clearButton = modal.getByTestId(TEST_IDS.clearSelectionButton).first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(modal.locator('[data-selected="true"]')).toHaveCount(0);
    }

    const available = await nonPremiumItems.count();
    const toSelect = Math.min(count, available);
    for (let index = 0; index < toSelect; index++) {
      const item = nonPremiumItems.nth(index);
      const isSelected = (await item.getAttribute('data-selected')) === 'true';
      if (!isSelected) {
        await item.locator('button').first().click();
        await expect(item).toHaveAttribute('data-selected', 'true');
      }
    }

    await this.confirmModelSelection();
  }

  /**
   * Select an explicit list of models by id in multi mode (used by tests that
   * need a specific model combination, e.g. multi-model media). Opens the
   * picker, switches to multi mode, clears any pending selection, clicks each
   * model id, then confirms via Use.
   */
  async selectModelsByIds(ids: readonly string[]): Promise<void> {
    await this.openModelSelector();
    await this.switchPickerMode('multi');
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);

    const clearButton = modal.getByTestId(TEST_IDS.clearSelectionButton).first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(modal.locator('[data-selected="true"]')).toHaveCount(0);
    }

    for (const id of ids) {
      const item = modal.getByTestId(TEST_ID_BUILDERS.modelItem(id));
      await expect(item).toBeVisible();
      await item.locator('button').first().click();
      await expect(item).toHaveAttribute('data-selected', 'true');
    }

    await this.confirmModelSelection();
  }

  /**
   * Select 2 models for partial failure testing:
   * - First non-premium model (will succeed)
   * - LAST non-premium model (will be configured to fail)
   * Returns { successModelId, failModelId }.
   * The fail model is never picked by selectModels(N) since that picks from the front.
   */
  async selectModelsWithFailTarget(): Promise<{ successModelId: string; failModelId: string }> {
    await this.openModelSelector();
    await this.switchPickerMode('multi');
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    const nonPremiumItems = modal.locator(NON_PREMIUM_MODEL_ITEMS);

    const clearButton = modal.getByTestId(TEST_IDS.clearSelectionButton).first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(modal.locator('[data-selected="true"]')).toHaveCount(0);
    }

    const modelItemPrefix = TEST_ID_BUILDERS.modelItem('');
    const available = await nonPremiumItems.count();

    const firstItem = nonPremiumItems.nth(0);
    await firstItem.locator('button').first().click();
    await expect(firstItem).toHaveAttribute('data-selected', 'true');
    const firstTestId = await firstItem.getAttribute('data-testid');
    const successModelId = (firstTestId ?? '').replace(modelItemPrefix, '');

    // Select LAST model (fail target) — never picked by selectModels(N)
    const lastItem = nonPremiumItems.nth(available - 1);
    await lastItem.locator('button').first().click();
    await expect(lastItem).toHaveAttribute('data-selected', 'true');
    const lastTestId = await lastItem.getAttribute('data-testid');
    const failModelId = (lastTestId ?? '').replace(modelItemPrefix, '');

    await this.confirmModelSelection();
    return { successModelId, failModelId };
  }

  /** Count selected (checked) models in the open modal. */
  async getSelectedModelCount(): Promise<number> {
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    return modal
      .locator(`[data-testid^="${TEST_ID_BUILDERS.modelItem('')}"][data-selected="true"]`)
      .count();
  }

  /** Assert the comparison bar (multi-model pill bar) is visible. */
  async expectComparisonBarVisible(): Promise<void> {
    await expect(this.page.getByTestId(TEST_IDS.selectedModelsBar)).toBeVisible();
  }

  /** Assert the comparison bar is not visible (single model or none). */
  async expectComparisonBarHidden(): Promise<void> {
    await expect(this.page.getByTestId(TEST_IDS.selectedModelsBar)).not.toBeVisible();
  }

  /** Count model pills in the comparison bar. */
  async getComparisonBarModelCount(): Promise<number> {
    const bar = this.page.getByTestId(TEST_IDS.selectedModelsBar);
    return bar.locator('button[aria-label^="Remove "]').count();
  }

  /** Remove a model from the comparison bar by clicking its X button. */
  async removeModelFromBar(modelName: string): Promise<void> {
    await this.page
      .getByTestId(TEST_IDS.selectedModelsBar)
      .getByRole('button', { name: `Remove ${modelName}` })
      .click();
  }

  /** Assert the nametag text on the nth message item (0-indexed). */
  async expectModelNametag(messageIndex: number, expectedName: string): Promise<void> {
    const message = this.getMessage(messageIndex);
    await expect(message.getByTestId(TEST_IDS.modelNametag)).toContainText(expectedName);
  }

  /**
   * Assert every assistant message in the conversation has a model nametag.
   * Uses an atomic negative selector ("zero assistants lack a nametag") so
   * there is no TOCTOU gap between counting and per-item checks — the bug
   * that caused the WebKit flake in the first place. We check the items
   * Virtuoso has currently rendered rather than scrolling through every
   * virtualised row, because (a) nametag visibility is a per-item render
   * concern (if rendered, the nametag is there), and (b) scrolling through
   * a long conversation on mobile burns too much test time.
   */
  async expectAllAIMessagesHaveNametag(): Promise<void> {
    const assistantsWithoutNametag = this.messageList.locator(
      `[${ROLE_ATTR}="assistant"]:not(:has([data-testid="${TEST_IDS.modelNametag}"]))`
    );
    // Atomic: Playwright re-queries the locator each poll.
    await expect(assistantsWithoutNametag).toHaveCount(0, { timeout: TIMEOUTS.ASSERT });

    const renderedAssistants = await this.messageList.locator(`[${ROLE_ATTR}="assistant"]`).count();
    if (renderedAssistants === 0) {
      throw new Error('expectAllAIMessagesHaveNametag: no assistant messages rendered');
    }
  }

  /**
   * Wait for N AI response messages to appear after sending.
   * Waits for all N to have visible content (not just thinking indicators).
   */
  async waitForMultiModelResponses(
    count: number,
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<void> {
    const assistantMessages = this.messageList.locator(`[${ROLE_ATTR}="assistant"]`);
    await expect(assistantMessages).toHaveCount(count, { timeout });
    for (let index = 0; index < count; index++) {
      await expect(
        assistantMessages
          .nth(index)
          .getByText(/^Echo:/)
          .first()
      ).toBeVisible({
        timeout,
      });
    }
    // Token visibility (DOM) runs ahead of the server-side settle: the streamed
    // text appears before `saveChatTurn` commits. Callers that then read the
    // conversation via the API (e.g. getMessageCountViaAPI) would race the
    // commit, so gate on persistence here. Safe from a pre-stream false positive
    // because the `Echo:` text above proves the stream already ran.
    await this.waitForStreamComplete(timeout);
  }

  /** Get the message content text for an AI response identified by its nametag model name. */
  async getAIResponseByModel(modelName: string): Promise<string> {
    const assistantMessages = this.messageList.locator(`[${ROLE_ATTR}="assistant"]`);
    const count = await assistantMessages.count();
    for (let index = 0; index < count; index++) {
      const nametag = assistantMessages.nth(index).getByTestId(TEST_IDS.modelNametag);
      const nametagText = await nametag.textContent();
      if (nametagText?.includes(modelName)) {
        const messageText = await assistantMessages.nth(index).textContent();
        return messageText ?? '';
      }
    }
    throw new Error(`No AI response found with model nametag "${modelName}"`);
  }

  private getConversationIdFromUrl(): string {
    const url = new URL(this.page.url());
    const id = url.pathname.split('/').pop();
    if (!id || id === 'chat' || id === 'trial') {
      throw new Error('Not on a conversation page');
    }
    return id;
  }
}
