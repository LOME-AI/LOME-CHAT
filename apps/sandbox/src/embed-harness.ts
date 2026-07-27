import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { contentTypeFor } from './mime.js';
import { SANDBOX_CSP } from './csp.js';
import { resolveWithinDir } from './dev-server.js';

/**
 * Test-only harness that drives a sandbox-origin page the way the app drives it
 * in production: embedded in a real `sandbox="allow-scripts"` iframe — so the
 * frame's origin is opaque — and talked to over the `MessageChannel` the frame
 * mints and transfers with its one-shot `ready`.
 *
 * The embedding is the point. A renderer loaded top-level has `parent ===
 * window` and no opaque origin anywhere, so a harness driving it that way tests
 * the renderer's mechanism while proving nothing about delivery; a parent→frame
 * channel that silently discards every message passes it. Everything here exists
 * to keep the transport under test identical to the shipped one.
 *
 * One server serves both roles, which is legitimate: opacity comes from the
 * `sandbox` attribute alone, not from a distinct host — a page embedding a
 * same-origin document with `allow-scripts` still sees `origin === "null"`
 * inside it. The embedder page is served without the sandbox CSP because it
 * stands in for the app origin, which serves its own policy; the sandbox CSP
 * pins `frame-src 'none'`, so a page carrying it could not embed anything.
 *
 * This file is excluded from the coverage gate: it is test infrastructure, not
 * shipped runtime logic.
 */

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** The synthetic path serving the embedder page; `?frame=` names what it embeds. */
const EMBEDDER_PATH = '/__embedder.html';

/** The id of the sandboxed iframe inside the embedder page. */
const FRAME_ELEMENT_ID = 'sandbox-frame';

/** Frame paths are interpolated into HTML, so the accepted shape stays narrow. */
const FRAME_PATH_PATTERN = /^\/[A-Za-z0-9._-]+$/;

/** A shape-loose view of a bridge message as the embedder collected it. */
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

/** What the embedder page collects, read back through `page.evaluate`. */
interface BridgeState {
  messages: BridgeLike[];
  port: MessagePort | null;
}

/**
 * The embedder page: the app's stand-in. Its `message` listener is registered by
 * an inline script *before* the `<iframe>` element exists, deliberately — the
 * frame's `ready` is one-shot and does not queue, so a listener installed after
 * the frame has begun loading can miss the handshake, and with it the
 * transferred port, permanently.
 *
 * The handshake is written in the app's shape, gate for gate — sender, message
 * type, first-ready-wins, `addEventListener` plus `start()`. A stand-in that
 * takes an easier route stops standing in: this is the only embedder of a real
 * sandboxed frame inside `pnpm test`, so the app's own pattern is exercised in a
 * real browser here or nowhere. `port.start()` is the line that costs: an
 * `onmessage` assignment auto-starts a port, while a listener added the app's
 * way leaves it paused until `start()`, and no unit test in the repo can see the
 * difference because Node's `MessagePort` starts on either.
 */
function embedderHtml(framePath: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>sandbox embed harness</title>
  </head>
  <body>
    <script>
      globalThis.__bridge = { messages: [], port: null };
      window.addEventListener('message', function (event) {
        var frame = document.getElementById(${JSON.stringify(FRAME_ELEMENT_ID)});
        if (!frame || event.source !== frame.contentWindow) return;
        // The window carries the handshake and nothing else; everything the
        // frame reports about a request comes back over the port.
        if (!event.data || event.data.type !== 'ready') return;
        // First port wins, matching the app: a later 'ready' must not be able to
        // redirect parent→frame traffic onto a channel a document minted.
        if (globalThis.__bridge.port) return;
        var port = event.ports[0];
        if (!port) return;
        globalThis.__bridge.messages.push(event.data);
        globalThis.__bridge.port = port;
        port.addEventListener('message', function (portEvent) {
          globalThis.__bridge.messages.push(portEvent.data);
        });
        // A listener added this way leaves the port paused, unlike an
        // 'onmessage' assignment; without this nothing the frame reports after
        // the handshake is ever delivered.
        port.start();
      });
    </script>
    <iframe
      id="${FRAME_ELEMENT_ID}"
      sandbox="allow-scripts"
      src="${framePath}"
      width="800"
      height="600"
    ></iframe>
  </body>
</html>`;
}

/**
 * Resolve an in-test route the committed `public/` tree does not contain (the
 * synthetic `/config.js`, module fixtures). Returning `undefined` falls through
 * to the static tree. The live origin is passed in because a fixture body may
 * need to name it — the port is only known once the server is listening.
 */
export type ExtraRoute = (
  pathname: string,
  origin: string
) => { readonly contentType: string; readonly body: string } | undefined;

/** A running sandbox origin backed by the committed `public/` tree. */
export interface SandboxOrigin {
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * Start a static server for `public/` that applies the production sandbox CSP,
 * and serves the embedder page alongside it.
 *
 * The host is `localhost`, not `127.0.0.1`: the sandbox CSP's `frame-ancestors`
 * admits `http://localhost:*` and nothing else on loopback, so a `127.0.0.1`
 * embedder would be refused by the very policy these tests exist to run under.
 */
export async function startSandboxOrigin(extraRoute?: ExtraRoute): Promise<SandboxOrigin> {
  let origin = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Decoded before anything looks at it: the URL parser strips literal dot
    // segments, but an encoded separator (`..%2f`) survives it and only becomes
    // a traversal once decoded — which is the point the containment check below
    // has to run on.
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === EMBEDDER_PATH) {
      const framePath = url.searchParams.get('frame') ?? '';
      if (!FRAME_PATH_PATTERN.test(framePath)) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(embedderHtml(framePath));
      return;
    }
    const send = (contentType: string, body: string | Buffer): void => {
      // The sandbox origin serves its assets to an opaque-origin frame, so every
      // fetch it makes — module scripts included — is cross-origin and needs
      // CORS. The origin is credential-free by design, so a wildcard exposes
      // nothing.
      // eslint-disable-next-line sonarjs/cors -- credential-free public asset origin; wildcard CORS is intentional
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Security-Policy': SANDBOX_CSP,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    };
    const extra = extraRoute?.(pathname, origin);
    if (extra !== undefined) {
      send(extra.contentType, extra.body);
      return;
    }
    // Containment goes through the one implementation of this check the package
    // has (`dev-server.ts`), never a second technique: two guards for one job
    // can only drift, and a harness that resolves paths differently from the
    // server it stands in for is testing something the product does not do.
    const resolved = resolveWithinDir(publicDir, pathname);
    if (resolved === null) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body: Buffer;
    try {
      if (statSync(resolved).isDirectory()) throw new Error('is a directory');
      body = readFileSync(resolved);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    send(contentTypeFor(pathname), body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server port');
  origin = `http://localhost:${String(address.port)}`;
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

/** Launch a headless Chromium for the sandbox integration tests. */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ args: ['--no-sandbox'] });
}

/** Options for embedding one sandbox page. */
export interface EmbedOptions {
  /** Path on the sandbox origin the sandboxed iframe loads (`/render.html`). */
  readonly framePath: string;
  /** Runs on the fresh page before it navigates — `page.route`, `page.clock.install`. */
  readonly beforeLoad?: ((page: Page) => Promise<void>) | undefined;
  /** How long to wait for the frame's one-shot `ready` handshake. */
  readonly readyTimeoutMs?: number;
}

/** A loaded embedder page holding one sandboxed frame. */
export interface EmbeddedFrame {
  /** Uncaught errors seen on the page since load (should stay empty). */
  readonly pageErrors: string[];
  /** The Playwright page, for the few tests that drive its clock directly. */
  readonly page: Page;
  /** Send a parent→frame message down the transferred port. */
  send(message: unknown): Promise<void>;
  /**
   * Post a message at the frame's *window* with `'*'` — the forgery path open to
   * anything sharing the embedder's realm. Exists so tests can prove the frame
   * ignores it; nothing in the product may take this path.
   */
  postToFrameWindow(message: unknown): Promise<void>;
  /** Whether the frame transferred a port with its `ready`. */
  hasPort(): Promise<boolean>;
  /** Every frame→parent message collected so far, oldest first. */
  messages(): Promise<BridgeLike[]>;
  /** Resolve with all collected messages once one matches `predicate`. */
  waitForMessage(
    predicate: (message: BridgeLike) => boolean,
    timeoutMs?: number
  ): Promise<BridgeLike[]>;
  /** Evaluate inside the frame's own realm, which the embedder cannot reach. */
  probeFrame<T>(pageFunction: () => T): Promise<T>;
  close(): Promise<void>;
}

/** Sleep in Node, so a page with a mocked clock cannot stall the waiter. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Open the embedder page around `framePath` and wait for the frame's handshake.
 *
 * Every wait polls from Node rather than through `page.waitForFunction`: tests
 * that mock the page clock would otherwise deadlock, since a page-side waiter
 * needs the page's own timers to tick.
 */
export async function openEmbeddedFrame(
  browser: Browser,
  origin: string,
  options: EmbedOptions
): Promise<EmbeddedFrame> {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  if (options.beforeLoad !== undefined) await options.beforeLoad(page);
  await page.goto(`${origin}${EMBEDDER_PATH}?frame=${encodeURIComponent(options.framePath)}`);

  const messages = (): Promise<BridgeLike[]> =>
    page.evaluate(() => (globalThis as unknown as { __bridge: BridgeState }).__bridge.messages);

  const waitForMessage = async (
    predicate: (message: BridgeLike) => boolean,
    timeoutMs = 15_000
  ): Promise<BridgeLike[]> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const collected = await messages();
      if (collected.some((message) => predicate(message))) return collected;
      if (Date.now() >= deadline) {
        throw new Error(
          `no matching frame→parent message within ${String(timeoutMs)}ms; collected ${JSON.stringify(collected)}`
        );
      }
      await sleep(25);
    }
  };

  const embedded: EmbeddedFrame = {
    pageErrors,
    page,
    messages,
    waitForMessage,
    send: (message: unknown) =>
      page.evaluate((payload) => {
        const bridge = (globalThis as unknown as { __bridge: BridgeState }).__bridge;
        if (bridge.port === null) throw new Error('the frame transferred no port with its ready');
        bridge.port.postMessage(payload);
      }, message),
    postToFrameWindow: (message: unknown) =>
      page.evaluate(
        (payload) => {
          const frame = document.querySelector<HTMLIFrameElement>(`#${payload.id}`);
          if (frame?.contentWindow === null || frame?.contentWindow === undefined) {
            throw new Error('sandbox frame has no contentWindow');
          }
          // eslint-disable-next-line sonarjs/post-message -- the forgery path under test; a wildcard is what an attacker would use
          frame.contentWindow.postMessage(payload.message, '*');
        },
        { id: FRAME_ELEMENT_ID, message }
      ),
    hasPort: () =>
      page.evaluate(
        () => (globalThis as unknown as { __bridge: BridgeState }).__bridge.port !== null
      ),
    probeFrame: <T>(pageFunction: () => T): Promise<T> => {
      const target = page.frames().find((candidate) => candidate !== page.mainFrame());
      if (target === undefined) throw new Error('sandbox frame is not attached');
      return target.evaluate(pageFunction);
    },
    close: () => page.close(),
  };

  await waitForMessage((message) => message.type === 'ready', options.readyTimeoutMs ?? 30_000);
  return embedded;
}
