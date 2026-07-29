import { TEST_IDS } from '@hushbox/shared';

import { test, expect } from '../fixtures.js';
import { ChatPage, DocumentPanelPage } from '../pages/index.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { personaEmail } from '../helpers/personas.js';
import { documentFixture } from '../helpers/documents.js';
import type { Page, APIRequestContext } from '../fixtures.js';

/**
 * Product-flow proof for runnable documents: an assistant message carrying a
 * fenced code block becomes a document card, opening the panel embeds the real
 * cross-origin sandbox iframe, and html/js/react/python execute inside it. Every
 * assertion is a web-first check on app-emitted state — the panel's
 * `#document-render-status` mirror and content inside the sandbox frame — never a
 * wall-clock wait.
 *
 * The sandbox origin is the same served-under-real-CSP server the containment
 * corpus uses (the shared Playwright webServer); the app embeds it directly, so
 * this suite adds no sandbox-serving of its own. npm imports resolve against the
 * pinned esm-stub fixture set (react/react-dom/canvas-confetti) and Python runs
 * on the self-hosted Pyodide dist, so there is no live network and no dependence
 * on a real model turn — the document content is seeded, not model-generated.
 *
 * Every fixture below is sized through `documentFixture`, which derives its
 * length from the shared extraction threshold. None of these tests is about
 * that boundary — they all just need their block to be a document — so none of
 * them may encode the threshold's current value.
 *
 * What a document is for is that a reader can see its output, so these proofs
 * are not satisfied by text. Every defect this suite exists to catch leaves the
 * text intact: bars that compute to `0px` under a perfect readout, a frame that
 * collapses to the iframe's intrinsic height, a canvas nothing was ever painted
 * on, a console strip squashed to a single line. Each kind therefore asserts on
 * the geometry or the pixels its output actually has, measured inside the frame
 * through `DocumentPanelPage`.
 */

const JS_FILLER = '// keeps this document clear of the extraction threshold';

/**
 * The colour the html fixture fills its canvas with (`#2266cc`) as channel
 * bytes, and the per-channel slack allowed when reading it back — enough for
 * an engine's rounding, nowhere near enough to accept an unpainted canvas.
 */
const CANVAS_FILL = [34, 102, 204, 255] as const;
const PIXEL_TOLERANCE = 2;

/** The unsorted values the js fixture visualises, and its pixels per unit. */
const SORT_VALUES = [5, 2, 9, 4, 7, 1, 8, 3, 6] as const;
const SORT_UNIT_PX = 12;

/** How much taller the react document's bar grows per click of its control. */
const REACT_BAR_STEP_PX = 24;

/**
 * The share of its container a rendered document must cover. Below 1 only for
 * sub-pixel rounding: the failures this guards — an iframe falling back to its
 * 300x150 intrinsic size, a root element that wraps only its own content — are
 * order-of-magnitude collapses, not a few pixels.
 */
const FILL_RATIO = 0.9;

/**
 * A panel content area shorter than this means the panel itself failed to lay
 * out, and a fill ratio would then be measuring one collapse against another.
 * Sits above the iframe's 150px intrinsic height and far below the shortest
 * project viewport.
 */
const MIN_CONTENT_AREA_PX = 200;

/** How many lines of program output the console strip must stand tall enough to show. */
const MIN_CONSOLE_LINES_VISIBLE = 4;

/** The fixtures' own selectors, which only the spec that authored them knows. */
const HTML_CANVAS = '#doc-canvas';
const SORT_BARS = '[data-bar]';
const REACT_BAR = '#react-bar';

/**
 * A minimal HTML document that renders, wires a real click handler, and paints
 * a canvas. The canvas is what a text assertion cannot reach: an unpainted one
 * is present, sized and visible, and only its pixels say otherwise.
 */
const HTML_DOC = documentFixture(
  'html',
  [
    '<!doctype html>',
    '<main>',
    '  <h1 id="doc-heading">Hello from a HushBox document</h1>',
    '  <p id="doc-count">count: 0</p>',
    '  <button id="doc-inc" type="button">Increment</button>',
    '  <canvas id="doc-canvas" width="120" height="60"></canvas>',
    '</main>',
    '<script>',
    '  let n = 0;',
    "  const label = document.getElementById('doc-count');",
    "  const button = document.getElementById('doc-inc');",
    "  button.addEventListener('click', function () {",
    '    n += 1;',
    "    label.textContent = 'count: ' + n;",
    '  });',
    "  const context = document.getElementById('doc-canvas').getContext('2d');",
    `  context.fillStyle = 'rgb(${CANVAS_FILL.slice(0, 3).join(', ')})';`,
    '  context.fillRect(0, 0, 120, 60);',
    '</script>',
  ],
  '<!-- keeps this document clear of the extraction threshold -->'
);

/**
 * A js document: a sorting lab drawn as real SVG rects, whose heights are the
 * values they stand for. This is the shape of the defect the suite exists to
 * catch — a visualiser whose readout stays perfect while every bar computes to
 * zero height — so the proof is the bars' measured geometry, never the readout
 * beside them. Reset restores the unsorted order, which is what makes the
 * second algorithm's click a real re-sort rather than a no-op over sorted data.
 */
const JS_DOC = documentFixture(
  'js',
  [
    "import confetti from 'canvas-confetti';",
    '',
    `const VALUES = [${SORT_VALUES.join(', ')}];`,
    `const UNIT = ${String(SORT_UNIT_PX)};`,
    'const TALLEST = Math.max(...VALUES);',
    "const SVG_NS = 'http://www.w3.org/2000/svg';",
    '',
    "const root = document.getElementById('document-root');",
    "const svg = document.createElementNS(SVG_NS, 'svg');",
    "svg.setAttribute('width', String(VALUES.length * 20));",
    "svg.setAttribute('height', String(TALLEST * UNIT));",
    "const controls = document.createElement('div');",
    'controls.innerHTML =',
    '  \'<button id="reset" type="button">Reset</button>\' +',
    '  \'<button id="bubble" type="button">Bubble sort</button>\' +',
    '  \'<button id="insertion" type="button">Insertion sort</button>\';',
    "const readout = document.createElement('p');",
    'root.append(svg, controls, readout);',
    '',
    'function paint(values, label) {',
    '  svg.replaceChildren();',
    '  values.forEach((value, index) => {',
    "    const bar = document.createElementNS(SVG_NS, 'rect');",
    "    bar.setAttribute('data-bar', String(value));",
    "    bar.setAttribute('x', String(index * 20));",
    "    bar.setAttribute('y', String((TALLEST - value) * UNIT));",
    "    bar.setAttribute('width', '16');",
    "    bar.setAttribute('height', String(value * UNIT));",
    '    svg.append(bar);',
    '  });',
    "  readout.textContent = 'order: ' + label;",
    '}',
    '',
    'function bubble(input) {',
    '  const values = [...input];',
    '  for (let pass = 0; pass < values.length; pass++) {',
    '    for (let index = 0; index + 1 < values.length; index++) {',
    '      if (values[index] > values[index + 1]) {',
    '        [values[index], values[index + 1]] = [values[index + 1], values[index]];',
    '      }',
    '    }',
    '  }',
    '  return values;',
    '}',
    '',
    'function insertion(input) {',
    '  const values = [...input];',
    '  for (let index = 1; index < values.length; index++) {',
    '    const key = values[index];',
    '    let scan = index - 1;',
    '    while (scan >= 0 && values[scan] > key) {',
    '      values[scan + 1] = values[scan];',
    '      scan -= 1;',
    '    }',
    '    values[scan + 1] = key;',
    '  }',
    '  return values;',
    '}',
    '',
    'function sortWith(algorithm, label) {',
    "  paint(algorithm(VALUES), 'sorted by ' + label);",
    '  void confetti();',
    '}',
    '',
    "document.getElementById('reset').addEventListener('click', () => {",
    "  paint(VALUES, 'unsorted');",
    '});',
    "document.getElementById('bubble').addEventListener('click', () => {",
    "  sortWith(bubble, 'bubble');",
    '});',
    "document.getElementById('insertion').addEventListener('click', () => {",
    "  sortWith(insertion, 'insertion');",
    '});',
    "paint(VALUES, 'unsorted');",
  ],
  JS_FILLER
);

/**
 * A React document that imports an npm package by bare specifier and mounts its
 * default export. Reaching `rendered` proves the whole chain: JSX transpile,
 * rewriting the bare `canvas-confetti` specifier to an absolute module URL the
 * browser can load, invoking its default export, and mounting the component.
 *
 * Its bar's height is its own state, so a click is observable as geometry
 * rather than as text alone. The click is wired from an effect rather than
 * through a `onClick` prop because the panel's own output is what is under
 * test, not React's event system.
 */
const REACT_DOC = documentFixture(
  'jsx',
  [
    "import confetti from 'canvas-confetti';",
    "import { useEffect, useState } from 'react';",
    '',
    '// A small React document that imports an npm package and renders its',
    '// default export. If the import or the mount failed, the panel would show',
    '// an error card instead of the rendered output below.',
    `const STEP = ${String(REACT_BAR_STEP_PX)};`,
    '',
    'export default function Widget() {',
    '  const [height, setHeight] = useState(STEP);',
    '  void confetti();',
    '  useEffect(() => {',
    "    const button = document.getElementById('react-grow');",
    "    if (!button || button.dataset.wired === 'yes') return;",
    "    button.dataset.wired = 'yes';",
    "    button.addEventListener('click', () => {",
    '      setHeight((current) => current + STEP);',
    '    });',
    '  });',
    '  return (',
    '    <section id="react-widget">',
    '      <h1>Rendered by React</h1>',
    '      <p>Imported an npm package by bare specifier.</p>',
    '      <button id="react-grow" type="button">Grow</button>',
    '      <canvas id="react-bar" width="40" height={height} />',
    '    </section>',
    '  );',
    '}',
  ],
  JS_FILLER
);

/**
 * A Python document computing with numpy and plotting with matplotlib. The
 * runtime captures the open figure as a PNG result; both packages ship in the
 * self-hosted Pyodide dist, so the run needs no network.
 *
 * It prints eight lines, more than the console strip shows at once, so the
 * strip's own height and overflow are observable: a run whose output is
 * squashed into one scrolling line reads identically in text.
 */
const PYTHON_DOC = documentFixture(
  'python',
  [
    'import numpy as np',
    'import matplotlib.pyplot as plt',
    '',
    '# Compute a sine wave with numpy and plot it with matplotlib.',
    '# The runtime captures the open figure and returns it as a PNG.',
    'x = np.linspace(0, 2 * np.pi, 200)',
    'y = np.sin(x)',
    '',
    'print("sample count:", x.size)',
    'for step in range(6):',
    '    window = y[step * 30 : step * 30 + 30]',
    '    # Short lines on purpose: a wrapped console line is a taller one, and',
    "    # the strip's height is judged in units of a line.",
    '    print("peak", step, round(float(window.max()), 3))',
    'print("max value:", round(float(y.max()), 3))',
    '',
    'plt.plot(x, y)',
    'plt.title("sine wave")',
    'plt.xlabel("x")',
    'plt.ylabel("sin(x)")',
  ],
  '# keeps this document clear of the extraction threshold'
);

/**
 * A document with almost nothing in it, for the panel's own layout. Short on
 * purpose: a root element that fills the frame here can only be filling it
 * because the layout says so, never because its content is long enough to.
 */
const FILL_DOC = documentFixture(
  'html',
  ['<!doctype html>', '<main>', '  <p id="fill-note">A short document.</p>', '</main>'],
  '<!-- keeps this document clear of the extraction threshold -->'
);

/**
 * A React document with a deliberate syntax error — the array literal is never
 * closed, so the in-browser transpiler rejects it and the panel must surface a
 * readable error card rather than a blank frame.
 */
const SYNTAX_ERROR_DOC = documentFixture(
  'jsx',
  [
    '// This document is intentionally malformed so the renderer must surface a',
    '// typed error. The array literal on the next declaration is never closed,',
    '// which the transpiler rejects before any render can happen. The panel must',
    '// show a readable error card, never a blank frame.',
    'export default function Broken() {',
    '  const items = [1, 2, 3;',
    '  return (',
    '    <ul>',
    '      {items.map((value) => (',
    '        <li>{value}</li>',
    '      ))}',
    '    </ul>',
    '  );',
    '}',
  ],
  JS_FILLER
);

/**
 * Seed a conversation whose assistant message contains `documentMarkdown`, then
 * navigate the authenticated page to it and wait for both messages to load. The
 * assistant content is stored verbatim and rendered through the same markdown
 * path a streamed turn uses, so the fenced block extracts into a document card.
 * Returns the ready ChatPage.
 */
async function seedDocumentConversation(
  page: Page,
  request: APIRequestContext,
  documentMarkdown: string
): Promise<ChatPage> {
  const ownerEmail = personaEmail('test-alice');
  const response = await request.post('/dev/conversation', {
    data: {
      ownerEmail,
      messages: [
        { content: 'Show me a runnable document.', senderType: 'user' },
        { content: documentMarkdown, senderType: 'ai' },
      ],
    },
  });
  expect(response.ok(), `conversation seed failed: ${String(response.status())}`).toBe(true);
  const { conversationId } = (await response.json()) as { conversationId: string };

  await page.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
  const chatPage = new ChatPage(page);
  await chatPage.waitForConversationLoaded();
  await expect(chatPage.messageList.getByTestId(TEST_IDS.messageItem)).toHaveCount(2);
  return chatPage;
}

/** Whether `heights` never steps down — the visual signature of a sorted array. */
function isAscending(heights: readonly number[]): boolean {
  return heights.every((height, index) => index === 0 || heights[index - 1]! <= height);
}

/** Assert a sampled pixel matches `expected`, channel by channel, within tolerance. */
function expectPixelNear(pixel: readonly number[], expected: readonly number[]): void {
  expect(pixel).toHaveLength(expected.length);
  for (const [index, channel] of expected.entries()) {
    expect(pixel[index]).toBeGreaterThanOrEqual(channel - PIXEL_TOLERANCE);
    expect(pixel[index]).toBeLessThanOrEqual(channel + PIXEL_TOLERANCE);
  }
}

test.describe('Runnable documents', () => {
  test('html document renders inside the sandbox, is interactive, and toggles raw/rendered', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    const chatPage = await seedDocumentConversation(
      authenticatedPage,
      authenticatedRequest,
      HTML_DOC.markdown
    );
    const documentPanel = new DocumentPanelPage(authenticatedPage);
    const rowIndex = await chatPage.getLastRowIndex();

    await test.step('assistant message carries a document card', async () => {
      const card = await documentPanel.scrollToCardInMessage(chatPage, rowIndex, TIMEOUTS.LONG);
      await expect(card).toContainText('html');
      await expect(card).toContainText(`${String(HTML_DOC.lineCount)} lines`);
    });

    await test.step('opening the panel renders the HTML inside the sandbox iframe', async () => {
      await documentPanel.clickCardInMessage(chatPage, rowIndex);
      await documentPanel.waitForPanelOpen();
      // Rendered is the default: the app reports a real bridge `rendered`.
      await documentPanel.expectRenderStatus('rendered', TIMEOUTS.LONG);
      await expect(
        documentPanel.sandboxFrame().getByText('Hello from a HushBox document')
      ).toBeVisible();
      await expect(documentPanel.sandboxFrame().getByText('count: 0')).toBeVisible();
    });

    await test.step('the rendered document is interactive', async () => {
      await documentPanel.sandboxFrame().getByRole('button', { name: 'Increment' }).click();
      await expect(documentPanel.sandboxFrame().getByText('count: 1')).toBeVisible();
    });

    await test.step('the document canvas was really painted', async () => {
      // The pixels, not the element. An unpainted canvas is present, correctly
      // sized and visible — every text and visibility assertion above passes
      // over one — and only reading it back tells the two apart.
      expectPixelNear(await documentPanel.canvasCentrePixel(HTML_CANVAS), CANVAS_FILL);
    });

    await test.step('the raw/rendered toggle switches source and back', async () => {
      await documentPanel.showRawButton().click();
      await expect(documentPanel.highlightedCode).toBeVisible();
      await expect(documentPanel.showRenderedButton()).toBeVisible();

      await documentPanel.showRenderedButton().click();
      await documentPanel.expectRenderStatus('rendered', TIMEOUTS.LONG);
      await expect(
        documentPanel.sandboxFrame().getByText('Hello from a HushBox document')
      ).toBeVisible();
    });
  });

  test('react document imports an npm package and renders inside the sandbox', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    const chatPage = await seedDocumentConversation(
      authenticatedPage,
      authenticatedRequest,
      REACT_DOC.markdown
    );
    const documentPanel = new DocumentPanelPage(authenticatedPage);
    const rowIndex = await chatPage.getLastRowIndex();

    const card = await documentPanel.scrollToCardInMessage(chatPage, rowIndex, TIMEOUTS.LONG);
    await expect(card).toContainText('jsx');

    await documentPanel.clickCardInMessage(chatPage, rowIndex);
    await documentPanel.waitForPanelOpen();
    // A `rendered` status here is only reachable if the bare `canvas-confetti`
    // specifier was rewritten to an absolute module URL the browser could load,
    // its default export ran, and the component mounted — the whole react +
    // npm-import path end to end.
    await documentPanel.expectRenderStatus('rendered', TIMEOUTS.LONG);
    await expect(documentPanel.sandboxFrame().getByText('Rendered by React')).toBeVisible();

    await test.step('the imported module ran, not merely resolved', async () => {
      // The marker canvas exists only because the package's default export was
      // called. A resolved-but-never-invoked import reaches `rendered` too.
      await expect(documentPanel.confettiCanvas().first()).toBeVisible();
    });

    await test.step('state recomputes on interaction, and the output has real geometry', async () => {
      // The bar's height is the component's state. A readout of that number
      // would update just as happily with a bar of zero height, so the height
      // itself is what is measured — before the click and after it.
      const initial = await documentPanel.renderedHeights(REACT_BAR);
      expect(initial).toHaveLength(1);
      expect(initial[0]).toBeCloseTo(REACT_BAR_STEP_PX, 0);

      await documentPanel.sandboxFrame().getByRole('button', { name: 'Grow' }).click();
      await expect
        .poll(async () => {
          const [height] = await documentPanel.renderedHeights(REACT_BAR);
          return height === undefined ? null : Math.round(height);
        })
        .toBe(REACT_BAR_STEP_PX * 2);
    });
  });

  test('python document runs on Pyodide and returns a matplotlib figure', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    test.slow();
    const chatPage = await seedDocumentConversation(
      authenticatedPage,
      authenticatedRequest,
      PYTHON_DOC.markdown
    );
    const documentPanel = new DocumentPanelPage(authenticatedPage);
    const rowIndex = await chatPage.getLastRowIndex();

    const card = await documentPanel.scrollToCardInMessage(chatPage, rowIndex, TIMEOUTS.LONG);
    await expect(card).toContainText('python');
    await expect(card).toContainText(`${String(PYTHON_DOC.lineCount)} lines`);

    await documentPanel.clickCardInMessage(chatPage, rowIndex);
    await documentPanel.waitForPanelOpen();

    // Python does not auto-run — it waits for an explicit Run.
    await expect(documentPanel.runButton()).toBeVisible();
    await documentPanel.runButton().click();

    // Loading Pyodide + numpy + matplotlib on a cold, saturated host is the
    // heaviest path in the suite, so allow the longest sanctioned budget for the
    // run to settle into `complete` (a `result`, distinct from `rendered`).
    await documentPanel.expectRenderStatus('complete', TIMEOUTS.XXLONG);
    await expect(documentPanel.consoleOutput()).toContainText('sample count:');
    await expect(documentPanel.figureOutput()).toBeVisible();

    await test.step('the console keeps its height and scrolls the rest', async () => {
      // Every line of the run is in the strip, including the last one written
      // after it filled up.
      await expect(documentPanel.consoleOutput()).toContainText('peak 5');

      const strip = await documentPanel.consoleMetrics();
      // Squashed to a line or two is the failure: the strip must stand several
      // lines tall, and cap by scrolling rather than by growing without end.
      expect(strip.clientHeight).toBeGreaterThanOrEqual(
        strip.lineHeight * MIN_CONSOLE_LINES_VISIBLE
      );
      expect(strip.scrollHeight).toBeGreaterThan(strip.clientHeight);
    });

    await test.step('output sits above the source, not below the fold', async () => {
      const runBox = await documentPanel.runButton().boundingBox();
      const consoleBox = await documentPanel.consoleOutput().boundingBox();
      const sourceBox = await documentPanel.highlightedCode.boundingBox();
      expect(runBox).not.toBeNull();
      expect(consoleBox).not.toBeNull();
      expect(sourceBox).not.toBeNull();

      expect(consoleBox!.y).toBeGreaterThan(runBox!.y);
      expect(sourceBox!.y).toBeGreaterThan(consoleBox!.y);
    });

    // Last, because parking the figure in view moves the panel's scroll
    // position, and the layout order above is read at its natural one.
    await test.step('the figure is a decoded PNG, not a broken image', async () => {
      // The figure is `loading="lazy"`, so it is brought into view before its
      // size is read: a deferred decode would otherwise look like no bytes.
      await documentPanel.figureOutput().scrollIntoViewIfNeeded();
      // A broken image occupies a box and passes a visibility check; only the
      // decoded size proves the run returned real bytes.
      await expect
        .poll(async () => {
          const figure = await documentPanel.figureNaturalSize();
          return figure.width;
        })
        .toBeGreaterThan(0);
    });
  });

  test('js document draws bars with real height and re-sorts them on interaction', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    const chatPage = await seedDocumentConversation(
      authenticatedPage,
      authenticatedRequest,
      JS_DOC.markdown
    );
    const documentPanel = new DocumentPanelPage(authenticatedPage);
    const rowIndex = await chatPage.getLastRowIndex();

    const card = await documentPanel.scrollToCardInMessage(chatPage, rowIndex, TIMEOUTS.LONG);
    await expect(card).toContainText('js');

    await documentPanel.clickCardInMessage(chatPage, rowIndex);
    await documentPanel.waitForPanelOpen();
    // A plain js document is a module the frame imports and runs for its DOM
    // side effects; `rendered` means that module evaluated without throwing.
    await documentPanel.expectRenderStatus('rendered', TIMEOUTS.LONG);

    // Each measurement below is fenced by the readout the same `paint()` call
    // writes after it has placed the bars, so the geometry it reads is final.
    await test.step('every bar has real height, in the unsorted order', async () => {
      await expect(documentPanel.sandboxFrame().getByText('order: unsorted')).toBeVisible();

      const heights = await documentPanel.renderedHeights(SORT_BARS);
      expect(heights).toHaveLength(SORT_VALUES.length);
      // The defect this test exists for: a lab whose readout is perfect while
      // every bar computes to 0px. No text assertion can see it; this one can.
      expect(Math.min(...heights)).toBeGreaterThan(0);
      expect(isAscending(heights)).toBe(false);
    });

    await test.step('bubble sort reorders the bars themselves', async () => {
      await documentPanel.sandboxFrame().getByRole('button', { name: 'Bubble sort' }).click();
      await expect(documentPanel.sandboxFrame().getByText('order: sorted by bubble')).toBeVisible();

      const heights = await documentPanel.renderedHeights(SORT_BARS);
      expect(Math.min(...heights)).toBeGreaterThan(0);
      expect(isAscending(heights)).toBe(true);
      // The npm import ran: the package's default export appends this canvas.
      await expect(documentPanel.confettiCanvas().first()).toBeVisible();
    });

    await test.step('switching algorithm re-sorts a restored order', async () => {
      await documentPanel.sandboxFrame().getByRole('button', { name: 'Reset' }).click();
      await expect(documentPanel.sandboxFrame().getByText('order: unsorted')).toBeVisible();
      expect(isAscending(await documentPanel.renderedHeights(SORT_BARS))).toBe(false);

      await documentPanel.sandboxFrame().getByRole('button', { name: 'Insertion sort' }).click();
      await expect(
        documentPanel.sandboxFrame().getByText('order: sorted by insertion')
      ).toBeVisible();

      const heights = await documentPanel.renderedHeights(SORT_BARS);
      expect(Math.min(...heights)).toBeGreaterThan(0);
      expect(isAscending(heights)).toBe(true);
    });
  });

  test('a rendered document fills the panel and paints the app background', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    const chatPage = await seedDocumentConversation(
      authenticatedPage,
      authenticatedRequest,
      FILL_DOC.markdown
    );
    const documentPanel = new DocumentPanelPage(authenticatedPage);
    const rowIndex = await chatPage.getLastRowIndex();

    await documentPanel.clickCardInMessage(chatPage, rowIndex);
    await documentPanel.waitForPanelOpen();
    await documentPanel.expectRenderStatus('rendered', TIMEOUTS.LONG);
    await expect(documentPanel.sandboxFrame().getByText('A short document.')).toBeVisible();

    await test.step('the frame takes the panel content area, not its intrinsic size', async () => {
      const contentArea = await documentPanel.contentAreaBox();
      const frameBox = await documentPanel.frameElementBox();

      expect(contentArea.height).toBeGreaterThan(MIN_CONTENT_AREA_PX);
      // The frame is a replaced element: once any link in the height chain
      // above it resolves to auto, it falls back to 300x150 and a document is
      // 150px tall however tall the panel is. Its text stays exactly as visible.
      expect(frameBox.height).toBeGreaterThan(contentArea.height * FILL_RATIO);
    });

    await test.step('the document root fills the frame, not just its own content', async () => {
      const { rootHeight, frameHeight } = await documentPanel.documentRootFill();
      expect(frameHeight).toBeGreaterThan(MIN_CONTENT_AREA_PX);
      expect(rootHeight).toBeGreaterThan(frameHeight * FILL_RATIO);
    });

    await test.step('the frame paints the app background, before and after a theme toggle', async () => {
      // The frame is cross-origin and cannot read the app's tokens, so the app
      // resolves them and sends them over the bridge. Comparing the two
      // computed colours is what proves that round trip actually landed —
      // an unthemed frame paints the browser's default canvas instead.
      const before = await documentPanel.appBackgroundColour();
      await expect.poll(() => documentPanel.frameBackgroundColour()).toBe(before);

      await authenticatedPage.getByTestId(TEST_IDS.themeToggle).click();
      await expect.poll(() => documentPanel.appBackgroundColour()).not.toBe(before);

      const after = await documentPanel.appBackgroundColour();
      await expect.poll(() => documentPanel.frameBackgroundColour()).toBe(after);
      // The restyle must not have cost the document its render.
      await expect(documentPanel.sandboxFrame().getByText('A short document.')).toBeVisible();
    });
  });

  test('a syntax-error document shows an error card, not a blank frame', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    const chatPage = await seedDocumentConversation(
      authenticatedPage,
      authenticatedRequest,
      SYNTAX_ERROR_DOC.markdown
    );
    const documentPanel = new DocumentPanelPage(authenticatedPage);
    const rowIndex = await chatPage.getLastRowIndex();

    await documentPanel.clickCardInMessage(chatPage, rowIndex);
    await documentPanel.waitForPanelOpen();

    // Auto-render attempts and fails at transpile: the panel surfaces a readable
    // error card and the status mirror reports `error`, never a blank frame.
    await documentPanel.expectRenderStatus('error', TIMEOUTS.LONG);
    await expect(documentPanel.errorCard()).toBeVisible();
    await expect(documentPanel.errorCard()).toContainText('could not be compiled');
  });
});
