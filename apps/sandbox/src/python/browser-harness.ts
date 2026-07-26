import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEmbeddedFrame, type BridgeLike, type EmbeddedFrame } from '../embed-harness.js';
import type { Browser, Page } from '@playwright/test';

/**
 * Test-only harness that drives the real `/python.html` runtime the way the app
 * drives it: embedded in a `sandbox="allow-scripts"` iframe on the sandbox
 * origin, talked to over the `MessageChannel` the frame mints and transfers with
 * its one-shot `ready`. The server, the embedding, and the transport all come
 * from the shared embed harness (`../embed-harness.ts`) — everything here is the
 * part that is specific to Python: the PyPI fixture replay and the
 * init-then-run sequence Python's intake requires.
 *
 * This file is excluded from the coverage gate: it is test infrastructure, not
 * shipped runtime logic.
 */

const pypiFixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test-fixtures',
  'pypi'
);

/** The path on the sandbox origin that hosts the Python runtime. */
const PYTHON_FRAME_PATH = '/python.html';

/**
 * Serve the `micropip.install('cowsay')` path from committed fixtures so it never
 * reaches live PyPI. micropip 0.11 fetches three resources — the PEP 691 simple
 * index, the PEP 658 `.metadata`, and the wheel — all recorded once and replayed
 * here (the AI-cassette doctrine applied to the PyPI seam). The sandbox
 * connect-src already allows both PyPI hosts, so the production CSP is unchanged:
 * the requests are real and CSP-legal, only their bytes are local. Install this
 * on a page via `openPythonPage(browser, origin, installPyPIInterception)`.
 */
export async function installPyPIInterception(page: Page): Promise<void> {
  const index = readFileSync(path.join(pypiFixtureDir, 'cowsay-simple-index.json'));
  const wheel = readFileSync(path.join(pypiFixtureDir, 'cowsay-6.1-py3-none-any.whl'));
  const metadata = readFileSync(path.join(pypiFixtureDir, 'cowsay-6.1-py3-none-any.whl.metadata'));
  // Registered first, so the specific fixture routes below (matched most-recent
  // first by Playwright) win: any PyPI request the fixtures do NOT cover aborts
  // instead of reaching the live network — the zero-live-network guarantee.
  await page.route(
    (url) => url.hostname === 'pypi.org' || url.hostname === 'files.pythonhosted.org',
    (route) => route.abort()
  );
  await page.route(
    (url) => url.href === 'https://pypi.org/simple/cowsay/',
    (route) => route.fulfill({ contentType: 'application/vnd.pypi.simple.v1+json', body: index })
  );
  await page.route(
    (url) => url.pathname.endsWith('/cowsay-6.1-py3-none-any.whl.metadata'),
    (route) => route.fulfill({ contentType: 'text/plain', body: metadata })
  );
  await page.route(
    (url) => url.pathname.endsWith('/cowsay-6.1-py3-none-any.whl'),
    (route) => route.fulfill({ contentType: 'application/octet-stream', body: wheel })
  );
}

/** An embedded `/python.html` runtime that can run several documents in sequence. */
export interface PythonPage {
  /** Any uncaught page errors observed since load (should stay empty). */
  readonly pageErrors: string[];
  /** The embedded frame, for the tests that drive the transport itself. */
  readonly frame: EmbeddedFrame;
  /** Init + run one document; resolve with the bridge messages for that request. */
  run(code: string, requestId: string, timeoutMs?: number): Promise<BridgeLike[]>;
  /** Read a JSON-serializable value out of the frame's own realm (security probes). */
  probe<T>(pageFunction: () => T): Promise<T>;
  close(): Promise<void>;
}

/**
 * Embed a fresh `/python.html` frame and wait for its handshake. The optional
 * `beforeLoad` hook runs on the page before it navigates — the seam for
 * `page.route` interception (serving the PyPI wheel/metadata from local
 * fixtures) and for `page.clock.install()`.
 *
 * The handshake this waits for costs nothing: `ready` is sent as the bootstrap
 * script finishes, long before any Pyodide asset is fetched — the interpreter
 * loads on the first `run`.
 */
export async function openPythonPage(
  browser: Browser,
  origin: string,
  beforeLoad?: (page: Page) => Promise<void>
): Promise<PythonPage> {
  const frame = await openEmbeddedFrame(browser, origin, {
    framePath: PYTHON_FRAME_PATH,
    beforeLoad,
  });
  return {
    pageErrors: frame.pageErrors,
    frame,
    async run(code: string, requestId: string, timeoutMs = 90_000): Promise<BridgeLike[]> {
      // Python's intake is two messages, deliberately: `init` only stashes the
      // code, and nothing runs until `run` arrives.
      await frame.send({ type: 'init', kind: 'python', code, requestId });
      await frame.send({ type: 'run', requestId });
      const collected = await frame.waitForMessage(
        (message) =>
          (message.type === 'result' || message.type === 'error') &&
          message.requestId === requestId,
        timeoutMs
      );
      return collected.filter((message) => message.requestId === requestId);
    },
    probe: <T>(pageFunction: () => T): Promise<T> => frame.probeFrame(pageFunction),
    close: () => frame.close(),
  };
}
