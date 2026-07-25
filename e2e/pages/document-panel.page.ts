import { type Page, type Locator, type FrameLocator } from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { ChatPage } from './chat.page.js';

/**
 * The lifecycle values the panel mirrors into `#document-render-status`.
 * `rendered` is a real html/js/react paint; `complete` is a settled python run
 * (a `result`); `error` is a surfaced failure. Keeps the runnable-document
 * proofs keyed on app-emitted state rather than any wall-clock wait.
 */
export type DocumentRenderStatus = 'rendered' | 'complete' | 'error';

export class DocumentPanelPage {
  readonly page: Page;
  readonly panel: Locator;
  readonly scrollArea: Locator;
  readonly resizeHandle: Locator;
  readonly highlightedCode: Locator;
  readonly closeButton: Locator;
  readonly downloadButton: Locator;
  readonly mermaidDiagram: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByTestId(TEST_IDS.documentPanel);
    this.scrollArea = page.getByTestId(TEST_IDS.documentPanelScroll);
    this.resizeHandle = page.getByTestId(TEST_IDS.resizeHandle);
    this.highlightedCode = page.getByTestId(TEST_IDS.highlightedCode);
    this.closeButton = page.getByRole('button', { name: 'Close panel' });
    this.downloadButton = this.panel.getByRole('button', { name: 'Download file' });
    this.mermaidDiagram = page.getByTestId(TEST_IDS.mermaidDiagram);
  }

  /** The currently active (selected) document card */
  activeCard(): Locator {
    // `data-active` is the card's own selection-state attribute, not an app signal.
    return this.page
      .getByTestId(TEST_IDS.documentCard)
      .and(this.page.locator('[data-active="true"]'));
  }

  /** Copy button (changes aria-label to "Copied" after click) */
  copyButton(): Locator {
    return this.panel.getByRole('button', { name: 'Copy code' });
  }

  /** Copy button in "Copied" feedback state */
  copiedButton(): Locator {
    return this.panel.getByRole('button', { name: 'Copied' });
  }

  /** Fullscreen button (toggles between "Fullscreen" and "Exit fullscreen") */
  fullscreenButton(): Locator {
    return this.panel.getByRole('button', { name: 'Fullscreen' });
  }

  exitFullscreenButton(): Locator {
    return this.panel.getByRole('button', { name: 'Exit fullscreen' });
  }

  /** Raw/rendered toggle (mermaid only) */
  showRawButton(): Locator {
    return this.panel.getByRole('button', { name: 'Show raw' });
  }

  showRenderedButton(): Locator {
    return this.panel.getByRole('button', { name: 'Show rendered' });
  }

  /** Panel title heading */
  panelTitle(): Locator {
    return this.panel.locator('h2');
  }

  async closePanel(): Promise<void> {
    await this.closeButton.click();
  }

  /**
   * Return the document card belonging to the message at `messageIndex`.
   * Addressing by message index (rather than nth-among-all-cards) is robust
   * to Virtuoso virtualization: on small viewports only one document-card
   * row is mounted at a time, so `.nth(N)` will silently fail. The caller
   * is expected to know which message holds the card it wants.
   */
  cardInMessage(chatPage: ChatPage, messageIndex: number): Locator {
    return chatPage.getMessage(messageIndex).getByTestId(TEST_IDS.documentCard).first();
  }

  /**
   * Park the row at `messageIndex` in Virtuoso's mounted window, then assert
   * its document card is visible. Returns the card locator for the caller.
   */
  async scrollToCardInMessage(
    chatPage: ChatPage,
    messageIndex: number,
    timeout: number = TIMEOUTS.ASSERT
  ): Promise<Locator> {
    await chatPage.scrollMessageIntoView(messageIndex);
    const card = this.cardInMessage(chatPage, messageIndex);
    await expect(card).toBeVisible({ timeout });
    return card;
  }

  /**
   * Click the card belonging to the message at `messageIndex` after parking
   * its row in Virtuoso's mounted window.
   */
  async clickCardInMessage(chatPage: ChatPage, messageIndex: number): Promise<void> {
    const card = await this.scrollToCardInMessage(chatPage, messageIndex);
    await card.click();
  }

  async waitForPanelOpen(timeout: number = TIMEOUTS.MODAL): Promise<void> {
    await this.panel.waitFor({ state: 'visible', timeout });
  }

  async waitForMermaidRendered(timeout: number = TIMEOUTS.ASSERT): Promise<void> {
    await this.mermaidDiagram.waitFor({ state: 'visible', timeout });
  }

  async expectTitle(text: string): Promise<void> {
    await expect(this.panelTitle()).toContainText(text);
  }

  async getPanelWidth(): Promise<number> {
    const box = await this.panel.boundingBox();
    return box?.width ?? 0;
  }

  // --- Runnable documents (html/js/react/python) ---
  //
  // A runnable document executes inside the cross-origin sandbox iframe the app
  // embeds. `#document-render-status` is the app-DOM lifecycle mirror the panel
  // exposes (a11y + the Playwright/Maestro proofs); the iframe carries a `title`
  // and its content lives under `#document-root`. These are the app's real
  // selectors, not the containment harness — the product flow drives the actual
  // panel.

  /** The panel's lifecycle status element; `data-status` flips only on real bridge events. */
  renderStatus(): Locator {
    return this.page.locator('#document-render-status');
  }

  /** Wait until the render-status element reports `status` (a genuine bridge lifecycle transition). */
  async expectRenderStatus(
    status: DocumentRenderStatus,
    timeout: number = TIMEOUTS.ASSERT
  ): Promise<void> {
    await expect(this.renderStatus()).toHaveAttribute('data-status', status, { timeout });
  }

  /** The sandbox iframe's document as a FrameLocator, so content assertions reach inside it. */
  sandboxFrame(): FrameLocator {
    return this.panel.locator('iframe').contentFrame();
  }

  /** Python-only: the explicit Run trigger (html/js/react auto-render, python waits for Run). */
  runButton(): Locator {
    return this.panel.getByRole('button', { name: 'Run', exact: true });
  }

  /** Python-only: Stop tears the frame down, killing even a main-thread run. */
  stopButton(): Locator {
    return this.panel.getByRole('button', { name: 'Stop', exact: true });
  }

  /** The `aria-live` console strip that streams program stdout/stderr. */
  consoleOutput(): Locator {
    return this.panel.getByRole('log', { name: 'Program output' });
  }

  /** A matplotlib (or other) PNG output rendered via `<Img>`. */
  figureOutput(): Locator {
    return this.panel.getByRole('img', { name: 'Generated figure' });
  }

  /** The readable error card shown instead of a blank frame on any document failure. */
  errorCard(): Locator {
    return this.panel.getByRole('alert');
  }
}
