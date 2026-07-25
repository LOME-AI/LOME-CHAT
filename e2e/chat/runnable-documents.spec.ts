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
 */

const JS_FILLER = '// keeps this document clear of the extraction threshold';

/** A minimal HTML document that renders and wires a real click handler. */
const HTML_DOC = documentFixture(
  'html',
  [
    '<!doctype html>',
    '<main>',
    '  <h1 id="doc-heading">Hello from a HushBox document</h1>',
    '  <p id="doc-count">count: 0</p>',
    '  <button id="doc-inc" type="button">Increment</button>',
    '</main>',
    '<script>',
    '  let n = 0;',
    "  const label = document.getElementById('doc-count');",
    "  const button = document.getElementById('doc-inc');",
    "  button.addEventListener('click', function () {",
    '    n += 1;',
    "    label.textContent = 'count: ' + n;",
    '  });',
    '</script>',
  ],
  '<!-- keeps this document clear of the extraction threshold -->'
);

/**
 * A React document that imports an npm package by bare specifier and mounts its
 * default export. Reaching `rendered` proves the whole chain: JSX transpile,
 * rewriting the bare `canvas-confetti` specifier to an absolute module URL the
 * browser can load, invoking its default export, and mounting the component.
 */
const REACT_DOC = documentFixture(
  'jsx',
  [
    "import confetti from 'canvas-confetti';",
    '',
    '// A small React document that imports an npm package and renders its',
    '// default export. If the import or the mount failed, the panel would show',
    '// an error card instead of the rendered output below.',
    'export default function Widget() {',
    '  void confetti();',
    '  return (',
    '    <section id="react-widget">',
    '      <h1>Rendered by React</h1>',
    '      <p>Imported an npm package by bare specifier.</p>',
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
