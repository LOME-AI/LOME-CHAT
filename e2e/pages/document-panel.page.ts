import { type Page, type Locator, type FrameLocator, type Frame } from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { ChatPage } from './chat.page.js';

/** The renderer page the sandbox origin serves for html/js/react documents. */
const RENDER_FRAME_PATH = '/render.html';

/** The renderer page's root element, which a document's output is placed in. */
const DOCUMENT_ROOT_SELECTOR = '#document-root';

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A box, or a throw naming what had none. A caller reading geometry always
 * wants the numbers; `null` means the element is not rendered, which is a
 * failure to report rather than a value to carry into an assertion.
 */
function requireBox(box: BoundingBox | null, what: string): BoundingBox {
  if (box === null) throw new Error(`${what} has no bounding box — it is not rendered`);
  return box;
}

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

  /**
   * The marker canvas the `canvas-confetti` fixture module appends when it is
   * actually invoked — the visible difference between a bare specifier that
   * merely resolved and one whose module ran.
   */
  confettiCanvas(): Locator {
    return this.sandboxFrame().locator('canvas[data-confetti="fired"]');
  }

  // --- Geometry and paint inside the sandbox frame ---
  //
  // A rendered document's real failures are geometric and chromatic: bars that
  // compute to 0px, a frame that collapses to the iframe's 300x150 intrinsic
  // size, a canvas that was never painted, a console squashed to one line. None
  // of them changes any text, so none is reachable by a text assertion.
  //
  // Measuring them means evaluating inside the frame, and `FrameLocator` hands
  // out locators without an `evaluate`. The `Frame` behind it has one, and it
  // reaches this frame despite the frame being cross-origin with an opaque
  // origin: the evaluation is injected through the protocol, so no same-origin
  // check applies. `page.frames()` is how that `Frame` is obtained.

  /**
   * The sandbox renderer frame. Throws when it is not attached, so a caller
   * polling on a value retries instead of measuring a torn-down frame.
   */
  private renderFrame(): Frame {
    const frame = this.page
      .frames()
      .find((candidate) => candidate.url().includes(RENDER_FRAME_PATH));
    if (frame === undefined) throw new Error('the sandbox renderer frame is not attached');
    return frame;
  }

  /** The sandbox iframe element's own box, measured in the app. */
  async frameElementBox(): Promise<BoundingBox> {
    return requireBox(await this.panel.locator('iframe').boundingBox(), 'the sandbox iframe');
  }

  /** The panel's scrolling content area — the space a rendered document must fill. */
  async contentAreaBox(): Promise<BoundingBox> {
    return requireBox(await this.scrollArea.boundingBox(), "the panel's content area");
  }

  /**
   * Rendered heights, in CSS pixels and document order, of every element inside
   * the frame matching `selector`. The selector belongs to the document fixture
   * the caller authored — the panel knows nothing about a document's own
   * markup — which is why it is passed in rather than named here.
   */
  async renderedHeights(selector: string): Promise<number[]> {
    return this.renderFrame().evaluate(
      (query) =>
        [...document.querySelectorAll(query)].map(
          (element) => element.getBoundingClientRect().height
        ),
      selector
    );
  }

  /**
   * How much of the frame's own viewport the renderer's root element covers.
   * A document that renders as a strip across the top of an otherwise empty
   * panel reports exactly the same lifecycle status as one that fills it.
   */
  async documentRootFill(): Promise<{ rootHeight: number; frameHeight: number }> {
    return this.renderFrame().evaluate((rootSelector) => {
      const root = document.querySelector(rootSelector);
      if (root === null) throw new Error('the renderer root element is missing');
      return {
        rootHeight: root.getBoundingClientRect().height,
        frameHeight: document.documentElement.clientHeight,
      };
    }, DOCUMENT_ROOT_SELECTOR);
  }

  /** The colour the frame's root element paints, as the engine serializes it. */
  async frameBackgroundColour(): Promise<string> {
    return this.renderFrame().evaluate(
      () => globalThis.getComputedStyle(document.documentElement).backgroundColor
    );
  }

  /**
   * The same colour on the app's side of the boundary. The panel carries the
   * app's `--background` token, so a frame painted with the appearance the
   * bridge sent resolves to this exact string in the same engine.
   */
  async appBackgroundColour(): Promise<string> {
    return this.panel.evaluate((element) => globalThis.getComputedStyle(element).backgroundColor);
  }

  /**
   * The four channel bytes of the pixel at the centre of the canvas matching
   * `selector` inside the frame. A canvas that was never painted is present,
   * sized and visible — only its pixels say whether anything was drawn.
   */
  async canvasCentrePixel(selector: string): Promise<number[]> {
    return this.renderFrame().evaluate((query) => {
      const canvas = document.querySelector(query);
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`no canvas matches ${query}`);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('the canvas has no 2d context');
      const { data } = context.getImageData(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1
      );
      return [...data];
    }, selector);
  }

  /**
   * The console strip's visible height, the height of everything in it, and the
   * height of a line. A strip that shows one line of a run's output reads the
   * same in text as one that shows five and scrolls.
   *
   * `contentHeight` is the strip's content box — `clientHeight` less its own
   * vertical padding — because only that band holds lines. Judging a padded
   * `clientHeight` in line units silently credits the strip with the padding's
   * worth of lines it does not show.
   *
   * `lineHeight` is the shortest line rather than the first, so a line long
   * enough to wrap on a narrow panel cannot inflate the unit that the strip's
   * own height is judged in.
   */
  async consoleMetrics(): Promise<{
    clientHeight: number;
    contentHeight: number;
    scrollHeight: number;
    lineHeight: number;
  }> {
    return this.consoleOutput().evaluate((element) => {
      const lines = [...element.children].map((line) => line.getBoundingClientRect().height);
      if (lines.length === 0) throw new Error('the console strip has no lines');
      const style = globalThis.getComputedStyle(element);
      const verticalPadding =
        Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      return {
        clientHeight: element.clientHeight,
        contentHeight: element.clientHeight - verticalPadding,
        scrollHeight: element.scrollHeight,
        lineHeight: Math.min(...lines),
      };
    });
  }

  /**
   * The decoded size of the figure PNG. A broken image still occupies a box and
   * still passes a visibility check; only the decoded size proves real bytes.
   */
  async figureNaturalSize(): Promise<{ width: number; height: number }> {
    return this.figureOutput().evaluate((element) => {
      if (!(element instanceof HTMLImageElement)) throw new Error('the figure is not an image');
      return { width: element.naturalWidth, height: element.naturalHeight };
    });
  }
}
