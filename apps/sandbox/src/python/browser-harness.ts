import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { contentTypeFor } from '../mime.js';
import { SANDBOX_CSP } from '../csp.js';

/**
 * Test-only harness that drives the real `/python.html` page in a headless
 * browser, exactly as the sandbox origin serves it. It serves the committed
 * `public/` tree (the built `python.js` bundle plus the self-hosted Pyodide
 * assets) and applies the one authoritative sandbox Content-Security-Policy
 * (`../csp.ts`, the same string production `_headers` and the dev server serve)
 * to every response, so the integration tests prove Pyodide runs under the
 * deployed policy rather than an unconstrained dev server. This file is excluded
 * from the coverage gate: it is test infrastructure, not shipped runtime logic.
 */

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const pypiFixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test-fixtures',
  'pypi'
);

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

/** A shape-loose view of a bridge message as it arrives on the window. */
export interface BridgeLike {
  readonly type?: string;
  readonly requestId?: string;
  readonly stream?: string;
  readonly text?: string;
  readonly phase?: string;
  readonly code?: string;
  readonly message?: string;
  readonly outputs?: readonly { type?: string; data?: string }[];
}

/** A running sandbox-origin server backed by the committed `public/` tree. */
export interface PythonSandbox {
  readonly origin: string;
  close(): Promise<void>;
}

/** Start a static server for `public/` that applies the production sandbox CSP. */
export async function startPythonSandbox(): Promise<PythonSandbox> {
  const server: Server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const resolved = path.join(publicDir, `.${pathname}`);
    let body: Buffer;
    try {
      if (statSync(resolved).isDirectory()) throw new Error('is a directory');
      body = readFileSync(resolved);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    // The production sandbox origin serves these static assets cross-origin so
    // the opaque iframe can fetch its Pyodide wasm/wheels; it is credential-free
    // by design, so a wildcard here exposes nothing.
    // eslint-disable-next-line sonarjs/cors -- credential-free public asset origin; wildcard CORS is intentional
    res.writeHead(200, {
      'Content-Type': contentTypeFor(pathname),
      'Content-Security-Policy': SANDBOX_CSP,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server port');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Launch a headless Chromium for the Python integration tests. */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ args: ['--no-sandbox'] });
}

/** A loaded `/python.html` page that can run several documents in sequence. */
export interface PythonPage {
  /** Any uncaught page errors observed since load (should stay empty). */
  readonly pageErrors: string[];
  /** Init + run one document; resolve with the bridge messages for that request. */
  run(code: string, requestId: string, timeoutMs?: number): Promise<BridgeLike[]>;
  /** Read a JSON-serializable value out of the loaded page (security probes). */
  probe<T>(pageFunction: () => T): Promise<T>;
  close(): Promise<void>;
}

/**
 * Open a fresh `/python.html` page and wait for its `ready` handshake. An
 * optional `beforeLoad` hook runs on the page before it navigates — the seam for
 * installing `page.route` network interception (e.g. serving PyPI wheel/metadata
 * from local fixtures so the micropip path never reaches live PyPI).
 */
export async function openPythonPage(
  browser: Browser,
  origin: string,
  beforeLoad?: (page: Page) => Promise<void>
): Promise<PythonPage> {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  if (beforeLoad !== undefined) await beforeLoad(page);
  await page.addInitScript(() => {
    (globalThis as unknown as { __msgs: unknown[] }).__msgs = [];
    window.addEventListener('message', (event) =>
      (globalThis as unknown as { __msgs: unknown[] }).__msgs.push(event.data)
    );
  });
  await page.goto(`${origin}/python.html`);
  await page.waitForFunction(
    () =>
      (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some((m) => m.type === 'ready'),
    undefined,
    { timeout: 30_000 }
  );
  return {
    pageErrors,
    async run(code: string, requestId: string, timeoutMs = 90_000): Promise<BridgeLike[]> {
      await page.evaluate(
        (payload) => {
          // The renderer loads top-level, so `parent === window`; posting to the
          // window itself is exactly what the parent app does across the frame.
          // eslint-disable-next-line sonarjs/post-message -- test harness posts to its own window
          window.postMessage(
            { type: 'init', kind: 'python', code: payload.code, requestId: payload.requestId },
            '*'
          );
          // eslint-disable-next-line sonarjs/post-message -- test harness posts to its own window
          window.postMessage({ type: 'run', requestId: payload.requestId }, '*');
        },
        { code, requestId }
      );
      await page.waitForFunction(
        (rid) =>
          (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some(
            (m) => (m.type === 'result' || m.type === 'error') && m.requestId === rid
          ),
        requestId,
        { timeout: timeoutMs }
      );
      return page.evaluate(
        (rid) =>
          (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.filter(
            (m) => m.requestId === rid
          ),
        requestId
      );
    },
    probe: <T>(pageFunction: () => T): Promise<T> => page.evaluate(pageFunction),
    close: () => page.close(),
  };
}
