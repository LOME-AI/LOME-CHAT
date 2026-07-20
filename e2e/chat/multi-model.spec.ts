import { test, expect } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from '../pages/index.js';
import { BudgetHelper } from '../helpers/budget.js';
import { expectConversationChargeMatchesDisplay } from '../helpers/cost-display.js';
import { assertPartialFailurePersistence } from '../helpers/partial-failure.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Multi-Model Chat', () => {
  test.describe('Model Selection', () => {
    test('selects multiple models via toggle in modal', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('open modal and select 3 models', async () => {
        await chatPage.selectModels(3);
      });

      await test.step('verify header shows "3 models"', async () => {
        const button = authenticatedPage.getByTestId(TEST_IDS.modelSelectorButton);
        await expect(button).toContainText('3 models');
      });

      await test.step('verify comparison bar shows 3 pills', async () => {
        await chatPage.expectComparisonBarVisible();
        const count = await chatPage.getComparisonBarModelCount();
        expect(count).toBe(3);
      });
    });

    test('removes model from comparison bar', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 3 models', async () => {
        await chatPage.selectModels(3);
        await chatPage.expectComparisonBarVisible();
      });

      await test.step('remove one model via X — bar shows 2', async () => {
        const bar = authenticatedPage.getByTestId(TEST_IDS.selectedModelsBar);
        const firstRemoveButton = bar.getByRole('button', { name: /^Remove / }).first();
        await firstRemoveButton.click();

        const count = await chatPage.getComparisonBarModelCount();
        expect(count).toBe(2);
      });

      await test.step('remove another — bar disappears, single model in header', async () => {
        const bar = authenticatedPage.getByTestId(TEST_IDS.selectedModelsBar);
        const removeButton = bar.getByRole('button', { name: /^Remove / }).first();
        await removeButton.click();

        await chatPage.expectComparisonBarHidden();
        const button = authenticatedPage.getByTestId(TEST_IDS.modelSelectorButton);
        // Header shows "N models" only when ≥2 selected; with 1, it shows the model name.
        await expect(button).not.toContainText(/\d+ models/);
      });
    });

    test('enforces max model limit', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 5 models (max)', async () => {
        await chatPage.selectModels(5);
        await chatPage.expectComparisonBarVisible();
        const count = await chatPage.getComparisonBarModelCount();
        expect(count).toBe(5);
      });

      await test.step('verify unselected models are dimmed in modal', async () => {
        await chatPage.openModelSelector();

        // Find an unselected model (not disabled by premium lock)
        // Selecting the 5-model max guarantees unselected models remain (the
        // pinned catalog exposes more than five selectable models), so the
        // first unselected row must render dimmed.
        const unselectedModels = chatPage.unselectedSelectableModelItems();
        await expect(unselectedModels.first()).toHaveClass(/opacity-40/);
      });

      await test.step('deselect one model — dimming lifts', async () => {
        const selectedItems = chatPage.selectedModelItems();
        // Click the row body to toggle (no separate checkbox zone in the new design).
        await selectedItems.last().getByRole('button').first().click();

        // Deselecting one drops the selection below the max, so dimming lifts:
        // the first unselected row (at minimum the one just deselected) is no
        // longer opacity-40.
        const unselected = chatPage.unselectedSelectableModelItems();
        await expect(unselected.first()).not.toHaveClass(/opacity-40/);

        await chatPage.confirmModelSelection();
      });
    });

    test('modal opens with current selections checked', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 3 models and close modal', async () => {
        await chatPage.selectModels(3);
      });

      await test.step('reopen modal — same 3 have checkmarks', async () => {
        await chatPage.openModelSelector();
        const selectedCount = await chatPage.getSelectedModelCount();
        expect(selectedCount).toBe(3);
        await chatPage.confirmModelSelection();
      });
    });

    test('clear selected removes all selections', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 3 models', async () => {
        await chatPage.selectModels(3);
        await chatPage.expectComparisonBarVisible();
      });

      await test.step('reopen modal, clear, select 1 model, confirm', async () => {
        await chatPage.openModelSelector();
        // Picker remembers per-modality mode; tests selecting 3 left it in multi.
        await authenticatedPage.getByTestId(TEST_IDS.clearSelectionButton).first().click();
        await expect(chatPage.selectedModelItems()).toHaveCount(0);
        // Click row body to add the first non-premium back in.
        const firstNonPremium = chatPage.selectableModelItems();
        await firstNonPremium.first().getByRole('button').first().click();
        await chatPage.confirmModelSelection();
      });

      await test.step('verify single model in header, no comparison bar', async () => {
        await chatPage.expectComparisonBarHidden();
        const button = authenticatedPage.getByTestId(TEST_IDS.modelSelectorButton);
        // Header shows "N models" in multi mode; single mode must not.
        await expect(button).not.toContainText(/\d+ models/);
      });
    });

    test('persists selection across page reload', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 2 models', async () => {
        await chatPage.selectModels(2);
        await chatPage.expectComparisonBarVisible();
      });

      await test.step('reload page', async () => {
        await authenticatedPage.reload();
        await chatPage.waitForAppStable();
      });

      await test.step('verify 2 models still selected', async () => {
        await chatPage.expectComparisonBarVisible();
        const count = await chatPage.getComparisonBarModelCount();
        expect(count).toBe(2);
      });
    });

    test('picker mode (single/multi) persists across page reload', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('switch picker to multi mode and close', async () => {
        await chatPage.openModelSelector();
        await chatPage.switchPickerMode('multi');
        // Close via Cancel — mode persists even when no selection committed.
        await authenticatedPage
          .getByTestId(TEST_IDS.modelSelectorModal)
          .getByTestId(TEST_IDS.cancelButton)
          .click();
      });

      await test.step('reload, reopen — mode is still multi', async () => {
        await authenticatedPage.reload();
        await chatPage.waitForAppStable();
        await chatPage.openModelSelector();
        await expect(authenticatedPage.getByTestId(TEST_IDS.modelSelectorModal)).toHaveAttribute(
          'data-picker-mode',
          'multi'
        );
      });
    });

    test('single mode: clicking a row commits + closes the modal immediately', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await chatPage.openModelSelector();
      await chatPage.switchPickerMode('single');

      const modal = authenticatedPage.getByTestId(TEST_IDS.modelSelectorModal);
      const firstNonPremium = chatPage.nonPremiumModelItems().first();
      const targetId = (await firstNonPremium.getAttribute('data-testid')) ?? '';

      await firstNonPremium.getByRole('button').first().click();

      // Modal closed without needing a Use button click. The close is a Radix
      // CSS animation with no in-flight queries, so allow a generous timeout
      // for slow WebKit to finish painting the closed state.
      await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

      // Header reflects the new pick — should NOT show "N models" since this is single mode
      const button = authenticatedPage.getByTestId(TEST_IDS.modelSelectorButton);
      await expect(button).not.toContainText(/\d+ models/);
      // The picked model id was the one whose row we clicked
      expect(targetId).toContain('model-item-');
    });

    test('multi mode: Cancel discards local changes (does not commit)', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      // Start with one committed model (default Smart Model).
      await chatPage.selectSingleModel('smart-model');

      // Open picker, switch to multi, add another model, then Cancel
      await chatPage.openModelSelector();
      await chatPage.switchPickerMode('multi');
      const modal = authenticatedPage.getByTestId(TEST_IDS.modelSelectorModal);
      const firstNonPremium = chatPage.nonPremiumModelItems().first();
      await firstNonPremium.getByRole('button').first().click();

      await modal.getByTestId(TEST_IDS.cancelButton).click();
      // Close is a Radix CSS animation with no in-flight queries, so allow a
      // generous timeout for slow WebKit to finish painting the closed state.
      await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

      // Comparison bar should NOT appear because we discarded the second model
      await chatPage.expectComparisonBarHidden();
    });
  });

  test.describe('Multi-Model Streaming', () => {
    test('sends to multiple models and receives parallel responses', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 2 models and send message', async () => {
        await chatPage.selectModels(2);
        await chatPage.expectComparisonBarVisible();

        const testMessage = `Multi-stream test ${String(Date.now())}`;
        await chatPage.sendNewChatMessage(testMessage);
        await chatPage.waitForConversation();
      });

      await test.step('verify 2 AI responses appear', async () => {
        await chatPage.waitForMultiModelResponses(2);
      });
    });

    test('each AI response shows model nametag', async ({
      authenticatedPage,
      multiModelConversation: _multiModelConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      await test.step('verify all AI messages have nametags', async () => {
        await chatPage.expectAllAIMessagesHaveNametag();
      });

      await test.step('verify nametags show different model names', async () => {
        // Assert React-state count via countMessages (virtualization-safe).
        expect(await chatPage.countMessages('assistant')).toBe(2);

        // For index-based access use DOM count — the 2 multi-model responses
        // are always rendered because they're the newest messages.
        const assistantMessages = chatPage.messagesByRole('assistant');
        const nametag1 = assistantMessages.nth(0).getByTestId(TEST_IDS.modelNametag);
        const nametag2 =
          (await assistantMessages.nth(1).getByTestId(TEST_IDS.modelNametag).textContent()) ?? '';
        await expect(nametag1).not.toHaveText(nametag2);
      });
    });

    test('displays cost per model response', async ({
      authenticatedPage,
      multiModelConversation: _multiModelConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      const costElements = chatPage.messageList.locator(`[data-testid="${TEST_IDS.messageCost}"]`);
      const count = await costElements.count();
      expect(count).toBeGreaterThanOrEqual(2);
    });

    test('follow-up message includes all previous responses in history', async ({
      authenticatedPage,
      multiModelConversation: _multiModelConversation,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);

      await test.step('send follow-up message', async () => {
        const followup = `Follow-up ${String(Date.now())}`;
        await chatPage.sendFollowUpMessage(followup);
        await chatPage.expectMessageVisible(followup);
      });

      await test.step('wait for 2 more AI responses (4 total)', async () => {
        // Wait for streaming to complete — cost badge signals billing + persistence done
        await chatPage.waitForStreamComplete(TIMEOUTS.ROUTE);
        // Verify via data attribute (client state) — Virtuoso may not render all items on mobile
        await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '4', {
          timeout: TIMEOUTS.ROUTE,
        });
      });
    });

    // 10.2 — balance debit equals the sum of displayed per-message costs for N
    // models. Catches reservation/charge skew at the wallet boundary, not just
    // at the API.
    test('wallet debit equals the sum of per-model displayed costs for N=2', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      const budgetHelper = new BudgetHelper(authenticatedPage.request);

      await chatPage.goto();
      await chatPage.waitForAppStable();
      await chatPage.selectModels(2);

      const msg = `Wallet debit ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(msg);
      const conversationId = await chatPage.waitForConversation();
      await chatPage.waitForStreamComplete(TIMEOUTS.ROUTE);
      await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
        timeout: TIMEOUTS.ROUTE,
      });

      await expectConversationChargeMatchesDisplay(
        budgetHelper,
        conversationId,
        chatPage.messageList
      );
    });

    // 10.1 — web-search × multi-model reservation: regression for the N² bug
    // (stream-pipeline.ts:581). Pre-fix the debit included N² × search cost;
    // post-fix it tracks the displayed (correct) sum.
    test('wallet debit matches displayed cost when web search runs with N=2 models', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      const budgetHelper = new BudgetHelper(authenticatedPage.request);

      await chatPage.goto();
      await chatPage.waitForAppStable();
      await chatPage.selectModels(2);

      // Flip web search on via the toolbar toggle.
      const searchToggle = authenticatedPage.getByRole('button', {
        name: /Turn on internet search/i,
      });
      await searchToggle.click();
      await expect(
        authenticatedPage.getByRole('button', { name: /Turn off internet search/i })
      ).toBeVisible();

      const msg = `Search debit ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(msg);
      const conversationId = await chatPage.waitForConversation();
      await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);
      await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
        timeout: TIMEOUTS.ROUTE,
      });

      // Charge must equal the displayed search-inclusive cost.
      await expectConversationChargeMatchesDisplay(
        budgetHelper,
        conversationId,
        chatPage.messageList
      );
    });
  });

  test.describe('Multi-Model on Fork', () => {
    test('multi-model responses persist on fork after streaming completes', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('send single-model message and create fork', async () => {
        const setupMsg = `Fork setup ${String(Date.now())}`;
        await chatPage.sendNewChatMessage(setupMsg);
        await chatPage.waitForConversation();
        await chatPage.waitForAIResponse(setupMsg);
        await chatPage.waitForStreamComplete();

        await chatPage.clickFork(1);
        await chatPage.expectForkTabCount(2);
        await chatPage.expectActiveForkTab('Fork 1');
      });

      await test.step('select 2 models and send message on fork', async () => {
        await chatPage.selectModels(2);
        await chatPage.expectComparisonBarVisible();

        const forkMsg = `Multi-model on fork ${String(Date.now())}`;
        await chatPage.sendFollowUpMessage(forkMsg);
        await chatPage.expectMessageVisible(forkMsg);
      });

      await test.step('verify both AI responses visible after stream completes', async () => {
        // Verify via data attributes (client state) — Virtuoso may not render all items on mobile.
        // Cost count confirms: done SSE → saveChatTurn committed → invalidateQueries refetched.
        await expect(chatPage.messageList).toHaveAttribute('data-cost-count', '3', {
          timeout: TIMEOUTS.ROUTE,
        });
        await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '3', {
          timeout: TIMEOUTS.STREAM,
        });
      });

      await test.step('verify distinct model nametags on multi-model responses', async () => {
        // Index-based access needs DOM count (state count may exceed rendered
        // count under virtualization, causing nth() to wait for a non-existent
        // node). The multi-model responses are the two newest assistant items,
        // which Virtuoso always keeps rendered since it auto-scrolls on new
        // content.
        const assistantMessages = chatPage.messagesByRole('assistant');
        const domCount = await assistantMessages.count();
        const nametag1 = assistantMessages.nth(domCount - 2).getByTestId(TEST_IDS.modelNametag);
        const nametag2 =
          (await assistantMessages
            .nth(domCount - 1)
            .getByTestId(TEST_IDS.modelNametag)
            .textContent()) ?? '';
        await expect(nametag1).not.toHaveText(nametag2);
      });

      await test.step('page reload preserves all responses on fork', async () => {
        await authenticatedPage.reload();
        await chatPage.waitForConversationLoaded();

        await chatPage.expectActiveForkTab('Fork 1');

        await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '3', {
          timeout: TIMEOUTS.STREAM,
        });
      });
    });
  });

  test.describe('Single-Model Regression', () => {
    test('single model selection works identically to before', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 1 model — no comparison bar', async () => {
        await chatPage.selectModels(1);
        await chatPage.expectComparisonBarHidden();
      });

      await test.step('send message — 1 response, normal flow', async () => {
        const testMessage = `Single model ${String(Date.now())}`;
        await chatPage.sendNewChatMessage(testMessage);
        await chatPage.waitForConversation();
        await chatPage.waitForAIResponse();
        await chatPage.expectAssistantMessageContains('Echo:');
      });
    });
  });

  test.describe('Partial Failure', () => {
    test('handles partial model failure gracefully', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      const { successModelId, failModelId } = await chatPage.selectModelsWithFailTarget();
      await chatPage.expectComparisonBarVisible();

      await authenticatedPage.setExtraHTTPHeaders({ 'x-mock-failing-models': failModelId });

      try {
        await chatPage.sendNewChatMessage(`Partial failure test ${String(Date.now())}`);
        await chatPage.waitForConversation();

        const successResponse = chatPage.messagesByRole('assistant').filter({ hasText: 'Echo:' });
        await expect(successResponse.first()).toBeVisible({ timeout: TIMEOUTS.STREAM });

        // Gate on the server-side settle before the persistence read below: the
        // success token is visible in the DOM before saveChatTurn commits. The
        // Echo: wait above proves the stream ran, so waiting for streaming-count
        // to reach 0 here cannot pass on a pre-stream false positive (the bug
        // when this ran immediately after navigation).
        await chatPage.waitForStreamComplete();

        // Error renders on an optimistic message after stream ends — opt out of settled
        // to wait for the React re-render without premature failure
        const errorMessage = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
        await expect(errorMessage).toBeVisible({ timeout: TIMEOUTS.ASSERT });
        await expect(errorMessage).toContainText(/something went wrong/i);

        await assertPartialFailurePersistence(authenticatedPage, {
          succeededModelId: successModelId,
          failedModelId: failModelId,
          expectedSucceededCount: 1,
        });

        await expect(chatPage.messageInput).toBeVisible();
      } finally {
        await authenticatedPage.setExtraHTTPHeaders({});
      }
    });

    // 10.3 — partial-failure releases the failed slot's reservation: the user
    // is charged only for the successful model's actual cost, not for the
    // worst-case pre-reservation of the failing slot.
    test('wallet debit excludes the failed model on partial failure', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      const budgetHelper = new BudgetHelper(authenticatedPage.request);

      await chatPage.goto();
      await chatPage.waitForAppStable();

      const { failModelId } = await chatPage.selectModelsWithFailTarget();
      await authenticatedPage.setExtraHTTPHeaders({ 'x-mock-failing-models': failModelId });
      try {
        await chatPage.sendNewChatMessage(`Refund test ${String(Date.now())}`);
        const conversationId = await chatPage.waitForConversation();
        await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);

        const errorTile = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
        await expect(errorTile).toBeVisible({ timeout: TIMEOUTS.ASSERT });

        // The failed model persists no usage_records row, so the conversation's
        // charged total covers only the successful tile — the one tile with a
        // cost badge.
        await expectConversationChargeMatchesDisplay(
          budgetHelper,
          conversationId,
          chatPage.messageList
        );
      } finally {
        await authenticatedPage.setExtraHTTPHeaders({});
      }
    });
  });
});
