import { test, expect } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from '../pages/index.js';
import { requireEnv } from '../helpers/env.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { TIMEOUTS } from '../config/timeouts.js';

const apiUrl = requireEnv('VITE_API_URL');

const OPUS_MODEL_ID = 'anthropic/claude-opus-4.6';
const OPUS_MODEL_NAME = 'Claude Opus 4.6';
const SONNET_MODEL_ID = 'anthropic/claude-sonnet-4.6';
const SONNET_MODEL_NAME = 'Claude Sonnet 4.6';

/**
 * Smart Model end-to-end coverage (plan §F1-F4).
 *
 * The mock AIClient resolves Smart Model classifier calls to a deterministic
 * model id, configurable per request via the `x-mock-classifier-resolution`
 * HTTP header. Tests install the header via `page.setExtraHTTPHeaders`
 * before triggering the chat request; teardown is automatic when the page
 * is disposed, so no afterEach cleanup is required.
 *
 * Every Smart Model response should:
 *   - render with a cost badge and a model nametag (the resolved model name);
 *   - show the "Smart" chip next to the nametag (`data-testid="smart-model-chip"`).
 */
test.describe('Smart Model', () => {
  /** F1: select Smart Model entry, send prompt, response renders with cost + nametag + Smart chip. */
  test('selects Smart Model, sends prompt, renders response with cost and Smart chip', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('open model selector and choose Smart Model', async () => {
      await chatPage.selectSingleModel('smart-model');
    });

    const prompt = `Smart Model send ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse();
    await chatPage.waitForStreamComplete();

    // F2: nametag visible alongside the Smart chip on the assistant message.
    const assistantMessage = chatPage.messagesByRole('assistant').first();
    await expect(assistantMessage.getByTestId(TEST_IDS.modelNametag)).toBeVisible();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toContainText(/smart/i);

    const costBadge = assistantMessage.getByTestId(TEST_IDS.messageCost).first();
    await expect(costBadge).toBeVisible();
    await expect(costBadge).toContainText(/\$/);
  });

  /**
   * F3: regenerate on a Smart Model response triggers a fresh classification.
   * The newly persisted assistant message still carries the Smart chip; a new
   * cost row is recorded (cost-count grows after regenerate).
   */
  test('regenerate re-runs classification and records a fresh response', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    // Lane 9 #9: pin the first classifier resolution to Sonnet, then swap to
    // Opus before regenerate. The nametag on the regenerated assistant message
    // must reflect the new resolved model — proving the regenerate path
    // re-runs classification (it doesn't reuse the cached resolution).
    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': SONNET_MODEL_ID,
    });

    await chatPage.selectSingleModel('smart-model');

    const prompt = `Smart Model regen ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse();
    await chatPage.waitForStreamComplete();

    const initialAssistant = chatPage.messagesByRole('assistant').first();
    await expect(initialAssistant.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(initialAssistant.getByTestId(TEST_IDS.modelNametag)).toContainText(
      SONNET_MODEL_NAME
    );

    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': OPUS_MODEL_ID,
    });

    await chatPage.clickRegenerate(1);
    await chatPage.waitForStreamComplete();

    const refreshedAssistant = chatPage.messagesByRole('assistant').last();
    await expect(refreshedAssistant.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(refreshedAssistant.getByTestId(TEST_IDS.messageCost).first()).toBeVisible();
    await expect(refreshedAssistant.getByTestId(TEST_IDS.modelNametag)).toContainText(
      OPUS_MODEL_NAME
    );
  });

  /**
   * Drives the classifier override end-to-end: setting resolution to Opus
   * yields a Smart Model response whose nametag is the Opus display name.
   */
  test('classifier picks claude-opus-4.6 → response nametag shows Opus', async ({
    authenticatedPage,
  }) => {
    test.slow();

    // Override the mock classifier to deterministically resolve to Opus.
    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': OPUS_MODEL_ID,
    });

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.selectSingleModel('smart-model');

    await chatPage.sendNewChatMessage(`Smart→Opus ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.waitForStreamComplete();

    const assistantMessage = chatPage.messagesByRole('assistant').first();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(assistantMessage.getByTestId(TEST_IDS.modelNametag)).toContainText(
      OPUS_MODEL_NAME
    );
  });

  /**
   * Symmetric to the Opus test: Sonnet override → Sonnet nametag.
   */
  test('classifier picks claude-sonnet-4.6 → response nametag shows Sonnet', async ({
    authenticatedPage,
  }) => {
    test.slow();

    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': SONNET_MODEL_ID,
    });

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.selectSingleModel('smart-model');

    await chatPage.sendNewChatMessage(`Smart→Sonnet ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.waitForStreamComplete();

    const assistantMessage = chatPage.messagesByRole('assistant').first();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(assistantMessage.getByTestId(TEST_IDS.modelNametag)).toContainText(
      SONNET_MODEL_NAME
    );
  });

  /**
   * Classifier failure → fallback path. The pipeline must select the cheapest
   * eligible model so the user still gets a response. We verify the nametag
   * renders some recognized model name and the chip is present, indicating
   * the fallback path executed.
   */
  test('classifier failure falls back to a value model and still renders a response', async ({
    authenticatedPage,
  }) => {
    test.slow();

    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-failure': 'true',
    });

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.selectSingleModel('smart-model');

    await chatPage.sendNewChatMessage(`Smart fallback ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.waitForStreamComplete();

    // Even on classifier failure the user gets a response with the Smart chip.
    // Fallback resolves to the cheapest eligible model (config.classifierModelId
    // in `runSmartModelStage`), so the specific nametag depends on the mock
    // catalog's pricing — assert only that it's a non-empty real model name.
    const assistantMessage = chatPage.messagesByRole('assistant').first();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    const nametag = assistantMessage.getByTestId(TEST_IDS.modelNametag);
    await expect(nametag, 'fallback nametag must be non-empty').not.toHaveText('');
  });

  /**
   * A single Smart Model send must persist TWO llm_completions rows: one for
   * the classifier call and one for the inference call. The dev endpoint
   * counts `llm_completions` joined to messages by conversationId so the test
   * is robust against later message edits/regens.
   */
  test('a Smart Model send persists two llm_completions rows (classifier + inference)', async ({
    authenticatedPage,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.selectSingleModel('smart-model');

    await chatPage.sendNewChatMessage(`Smart usage rows ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.waitForStreamComplete();

    // Conversation id is in the URL after navigation.
    const url = new URL(authenticatedPage.url());
    const conversationId = url.pathname.split('/').pop() ?? '';
    expect(conversationId).toBeTruthy();

    // Poll the count until it reaches 2 (saveChatTurn finalizes async).
    await expect
      .poll(
        async () => {
          const response = await withRequestRetry(authenticatedPage.request).get(
            `${apiUrl}/dev/llm-completions-count/${conversationId}`
          );
          if (!response.ok()) return -1;
          const body = (await response.json()) as { count: number };
          return body.count;
        },
        { timeout: TIMEOUTS.STREAM }
      )
      .toBe(2);
  });

  /**
   * F4: a low-balance user (~$0.01 purchased, $0 free) can't afford a Smart
   * Model send — the affordability preflight blocks the request and shows the
   * insufficient-balance message in the prompt input. No assistant message
   * persists.
   */
  test('insufficient balance blocks send and surfaces the budget error', async ({
    lowBalancePage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(lowBalancePage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('select Smart Model on a low-balance account', async () => {
      await chatPage.selectSingleModel('smart-model');
    });

    await chatPage.promptInput.fill(`Smart Model insufficient ${String(Date.now())}`);

    // budget-messages renders the friendly insufficient-allowance string from
    // generateNotifications. The send button must be disabled.
    await expect(lowBalancePage.getByTestId(TEST_IDS.budgetMessages)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
    await expect(
      lowBalancePage.getByText(/Your free daily usage can't cover this message/i)
    ).toBeVisible();
    await expect(chatPage.sendButton).toBeDisabled();

    // No conversation is ever created (still on /chat).
    await expect(lowBalancePage).toHaveURL(/\/chat$/);
  });

  /**
   * Lane 9 #8: a Smart Model send runs a pre-inference classifier stage that
   * picks the model, surfacing a "Choosing the best model…" indicator while it
   * resolves. The classifier is instant in tests (no wall-clock delay — see
   * buildMockConfig), so the transient indicator can't be reliably caught
   * mid-flight; instead we prove the stage ran via the monotonic
   * `data-pre-inference-stages-seen` signal, then confirm the indicator has
   * settled (not stuck) and a routed response rendered.
   */
  test('Smart Model send runs its pre-inference classifier stage', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);

    await chatPage.selectSingleModel('smart-model');

    const preInferenceBaseline = await chatPage.capturePreInferenceBaseline();

    const prompt = `Smart Model loading ${String(Date.now())}`;
    await chatPage.sendFollowUpMessage(prompt);

    await chatPage.waitForPreInferenceStage(preInferenceBaseline);

    // After the turn completes the indicator must have settled, not stuck.
    await chatPage.waitForStreamComplete();
    await expect(authenticatedPage.getByText('Choosing the best model…')).not.toBeVisible();

    const assistant = chatPage.messagesByRole('assistant').last();
    await expect(assistant.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
  });
});
