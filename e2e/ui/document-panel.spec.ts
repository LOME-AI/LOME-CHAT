import { isMobileWidth, TEST_IDS } from '@hushbox/shared';

import { test, expect } from '../fixtures.js';
import { ChatPage, DocumentPanelPage } from '../pages/index.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { documentFixture, belowThresholdFixture } from '../helpers/documents.js';

/**
 * A Python function that only needs to *be* a document — this test is about
 * the panel, not about where the extraction threshold falls — so it is sized
 * clear of the threshold rather than on it.
 */
const PYTHON_DOCUMENT = documentFixture(
  'python',
  [
    'def fibonacci(n):',
    '    """Calculate fibonacci number."""',
    '    if n <= 0:',
    '        return 0',
    '    if n == 1:',
    '        return 1',
    '    a = 0',
    '    b = 1',
    '    for i in range(2, n + 1):',
    '        c = a + b',
    '        a = b',
    '        b = c',
    '    return b',
    '',
    'print(fibonacci(10))',
  ],
  '# keeps this block clear of the extraction threshold'
);
const PYTHON_CODE_BLOCK = PYTHON_DOCUMENT.markdown;

/** Small mermaid diagram — mermaid has no minimum line count */
const MERMAID_BLOCK = [
  '```mermaid',
  'graph TD',
  '    A[Start] --> B{Decision}',
  '    B -->|Yes| C[OK]',
  '    B -->|No| D[End]',
  '```',
].join('\n');

/**
 * One line short of the extraction threshold. The step using it is *about* the
 * boundary, so its size is derived from the threshold — a hand-counted body
 * would keep passing while no longer sitting on the negative side.
 */
const SMALL_CODE_BLOCK = belowThresholdFixture(
  'python',
  ['def add(a, b):', '    return a + b', '', 'print(add(1, 2))'],
  '# keeps this block under the extraction threshold'
);

test.describe('Document Panel', () => {
  // eslint-disable-next-line no-restricted-syntax -- serial: both tests send messages as the shared per-project test-alice account; the auto rate-limit reset and message sends mutate that account's usage state, so concurrent runs race the same daily allowance.
  test.describe.configure({ mode: 'serial' });

  test('code document: extraction, panel, copy, download, and close', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    const documentPanel = new DocumentPanelPage(authenticatedPage);

    let pythonMessageIndex: number;

    await test.step('send code block and verify card', async () => {
      // Code blocks ≥ MIN_LINES_FOR_DOCUMENT get extracted into a card, so
      // the response text is not in DOM. Wait for assistant-count to grow.
      const beforeAssistantCount = Number(
        (await chatPage.messageList.getAttribute('data-assistant-count')) ?? '0'
      );
      await chatPage.sendFollowUpMessage(PYTHON_CODE_BLOCK);
      await expect(chatPage.messageList).toHaveAttribute(
        'data-assistant-count',
        String(beforeAssistantCount + 1),
        { timeout: TIMEOUTS.ASSERT }
      );
      pythonMessageIndex = await chatPage.getLastRowIndex();
      const card = await documentPanel.scrollToCardInMessage(
        chatPage,
        pythonMessageIndex,
        TIMEOUTS.LONG
      );
      await expect(card).toContainText('fibonacci');
      await expect(card).toContainText('python');
      await expect(card).toContainText(`${String(PYTHON_DOCUMENT.lineCount)} lines`);
    });

    await test.step('click card opens panel', async () => {
      await documentPanel.clickCardInMessage(chatPage, pythonMessageIndex);
      await documentPanel.waitForPanelOpen();

      await documentPanel.expectTitle('fibonacci');
      await expect(documentPanel.highlightedCode).toBeVisible();
    });

    await test.step('copy button shows feedback', async () => {
      // Copy feedback is a UI timer transition, not an async query — opt out of settled
      await documentPanel.copyButton().click();
      await expect(documentPanel.copiedButton()).toBeVisible();

      // Wait for feedback to revert (2000ms timer + buffer)
      await expect(documentPanel.copyButton()).toBeVisible({ timeout: TIMEOUTS.MODAL });
    });

    await test.step('download button triggers file download', async () => {
      const downloadPromise = authenticatedPage.waitForEvent('download');
      await documentPanel.downloadButton.click();
      const download = await downloadPromise;

      expect(download.suggestedFilename()).toBe('fibonacci.py');
    });

    await test.step('close panel', async () => {
      await documentPanel.closePanel();
      await expect(documentPanel.panel).not.toBeVisible();
      await expect(documentPanel.activeCard()).not.toBeVisible();
    });
  });

  test('mermaid, multi-document switching, fullscreen, and extraction threshold', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    const documentPanel = new DocumentPanelPage(authenticatedPage);

    let pythonMessageIndex: number;
    let mermaidMessageIndex: number;

    await test.step('send Python code block (for multi-document switching)', async () => {
      const beforeAssistantCount = Number(
        (await chatPage.messageList.getAttribute('data-assistant-count')) ?? '0'
      );
      await chatPage.sendFollowUpMessage(PYTHON_CODE_BLOCK);
      await expect(chatPage.messageList).toHaveAttribute(
        'data-assistant-count',
        String(beforeAssistantCount + 1),
        { timeout: TIMEOUTS.ASSERT }
      );
      pythonMessageIndex = await chatPage.getLastRowIndex();
      const card = await documentPanel.scrollToCardInMessage(
        chatPage,
        pythonMessageIndex,
        TIMEOUTS.LONG
      );
      await expect(card).toBeVisible();
    });

    await test.step('send mermaid and verify rendered diagram', async () => {
      const beforeAssistantCount = Number(
        (await chatPage.messageList.getAttribute('data-assistant-count')) ?? '0'
      );
      await chatPage.sendFollowUpMessage(MERMAID_BLOCK);
      await expect(chatPage.messageList).toHaveAttribute(
        'data-assistant-count',
        String(beforeAssistantCount + 1),
        { timeout: TIMEOUTS.ASSERT }
      );
      mermaidMessageIndex = await chatPage.getLastRowIndex();
      await documentPanel.clickCardInMessage(chatPage, mermaidMessageIndex);
      await documentPanel.waitForPanelOpen();

      await documentPanel.expectTitle('Graph Diagram');
      await documentPanel.waitForMermaidRendered();
      await expect(documentPanel.showRawButton()).toBeVisible();
    });

    await test.step('raw/rendered toggle', async () => {
      await documentPanel.showRawButton().click();

      await expect(documentPanel.highlightedCode).toBeVisible();
      await expect(documentPanel.mermaidDiagram).not.toBeVisible();
      await expect(documentPanel.showRenderedButton()).toBeVisible();

      await documentPanel.showRenderedButton().click();

      await documentPanel.waitForMermaidRendered();
      await expect(documentPanel.showRawButton()).toBeVisible();
    });

    await test.step('switch to Python card', async () => {
      // On mobile, panel covers the message list — close first so cards are clickable
      await documentPanel.closePanel();
      await expect(documentPanel.panel).not.toBeVisible();

      // Find the Python card by its anchoring message — robust to virtualization
      await documentPanel.clickCardInMessage(chatPage, pythonMessageIndex);
      await documentPanel.waitForPanelOpen();

      // After panel opens (100% width on mobile), Virtuoso recalculates and may
      // remove the card from DOM. Verify via panel title instead of card attribute.
      await documentPanel.expectTitle('fibonacci');
      // Raw toggle should not be visible for code documents
      await expect(documentPanel.showRawButton()).not.toBeVisible();
      await expect(documentPanel.showRenderedButton()).not.toBeVisible();
    });

    await test.step('switch back to mermaid resets raw toggle', async () => {
      // Close panel so message list cards are accessible (mobile = 100% width panel)
      await documentPanel.closePanel();
      await expect(documentPanel.panel).not.toBeVisible();

      await documentPanel.clickCardInMessage(chatPage, mermaidMessageIndex);
      await documentPanel.waitForPanelOpen();

      // Should show rendered diagram (toggle resets on doc switch)
      // After close+reopen, mermaid remounts from scratch (async import + SVG render).
      // Under CI load on iPad Pro WebKit this can exceed the default 15s timeout.
      await documentPanel.waitForMermaidRendered(TIMEOUTS.MEDIA_DECODE);
      await expect(documentPanel.showRawButton()).toBeVisible();
    });

    await test.step('fullscreen toggle', async () => {
      // Fullscreen is desktop-only (useIsMobile() hides it on mobile viewports)
      const viewport = authenticatedPage.viewportSize();
      if (viewport && isMobileWidth(viewport.width)) return;

      const initialWidth = await documentPanel.getPanelWidth();

      await documentPanel.fullscreenButton().click();
      await expect(async () => {
        const w = await documentPanel.getPanelWidth();
        expect(w).toBeGreaterThan(initialWidth);
      }).toPass({ timeout: TIMEOUTS.MODAL });
      await expect(documentPanel.exitFullscreenButton()).toBeVisible();

      await documentPanel.exitFullscreenButton().click();
      await expect(async () => {
        const w = await documentPanel.getPanelWidth();
        expect(Math.abs(w - initialWidth)).toBeLessThan(10);
      }).toPass({ timeout: TIMEOUTS.MODAL });
      await expect(documentPanel.fullscreenButton()).toBeVisible();
    });

    await test.step('small code block not extracted', async () => {
      // Close panel and wait for CSS transition to complete before interacting
      // with the message input — on iPad the width transition causes Virtuoso
      // re-layout that can interfere with sendFollowUpMessage.
      await documentPanel.closePanel();
      await expect(documentPanel.panel).not.toBeVisible();

      await chatPage.sendFollowUpMessage(SMALL_CODE_BLOCK);
      await chatPage.waitForAIResponse();

      // The echo of the below-threshold code block should NOT contain a
      // document card. Resolve the target row by index
      // and park it in Virtuoso's mounted window — `.last()` would match the
      // last currently-mounted assistant, which on a virtualized list may be a
      // prior (mermaid) row that does have a card.
      const lastRowIndex = await chatPage.getLastRowIndex();
      await chatPage.scrollMessageIntoView(lastRowIndex);
      const lastAssistant = chatPage.messageAtRow(lastRowIndex, 'assistant');
      await expect(lastAssistant.getByTestId(TEST_IDS.documentCard)).toHaveCount(0);
    });
  });
});
