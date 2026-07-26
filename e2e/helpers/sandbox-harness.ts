import { createServer } from 'node:http';
import { expect } from './expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from './env.js';
import type { AddressInfo } from 'node:net';
import type { Locator, Page } from '@playwright/test';

/**
 * Shared harness for driving the document sandbox iframe from a Playwright page,
 * used by the security-containment corpus and reusable by the document-flow
 * suite. It embeds the real sandbox-origin renderer (served under its real CSP
 * by the sandbox web server) inside a cross-origin parent page and exposes the
 * typed bridge as observable DOM, so every assertion is a web-first retrying
 * check on app-emitted state — never a wall-clock wait.
 *
 * The transport is the shipped one: the frame mints a `MessageChannel` and
 * transfers one end with its one-shot `ready` broadcast, and every message after
 * that — both directions — rides that port. The parent never posts into
 * `contentWindow`; an `allow-scripts` frame has an opaque (`"null"`) origin, so
 * an origin-targeted post is discarded silently and a wildcard post is readable
 * by any document sharing the frame's realm. Driving the corpus through the port
 * is what makes it a test of the delivery path rather than only of containment.
 *
 * The parent page is served from a throwaway loopback HTTP server on an
 * ephemeral port, never a real app route, so the corpus exercises pure
 * containment (sandbox-origin CSP + iframe attributes) without dragging in the
 * chat flow. Its origin is a ported `http://localhost:<port>` — a real network
 * origin, deliberately different from the sandbox, so origin isolation is
 * genuinely under test. It must be a real served document, not a `page.route`
 * fulfilment: a fulfilled response has no network address space, so Chromium's
 * Local Network Access checks would block the loopback sandbox-iframe subresource
 * (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`) before the policy under test
 * ever runs. A loopback-served parent shares the iframe's address space, so the
 * embed is admitted and the containment policy is what is exercised. The ported
 * origin also confirms the sandbox `frame-ancestors http://localhost:*` admits a
 * ported embedder (the portless form matched only port 80).
 */

/**
 * The exact `sandbox` attribute the app applies to the document iframe. One
 * constant is the single source the harness embeds with and the corpus pins, so
 * a future edit that loosens it (adding `allow-same-origin`, `allow-popups`,
 * `allow-top-navigation`, or `allow-modals`) changes this one place and the
 * behavioural corpus fails.
 */
export const DOCUMENT_IFRAME_SANDBOX_ATTR = 'allow-scripts';

/** How the parent delivers its `frame-src` policy: an HTTP header (web) or a `<meta>` (Capacitor). */
export type FrameSourceDelivery = 'header' | 'meta';

/** Which renderer page the sandbox iframe loads. */
export type SandboxRenderer = 'render' | 'python';

/** The path the loopback parent server answers on (the port is assigned at listen time). */
const HARNESS_PATH = '/__document-sandbox-harness';

const BRIDGE_LOG_ID = 'doc-bridge-log';
const STATUS_ID = 'doc-ready-status';

/** Resolve the sandbox origin the app embeds (the frontend mirror), trailing slash stripped. */
export function sandboxOriginUrl(): string {
  return requireEnv('VITE_SANDBOX_ORIGIN_URL').replace(/\/+$/, '');
}

/**
 * Build the parent-page HTML. It embeds the sandbox iframe with the pinned
 * sandbox attribute, mirrors every frame→parent bridge message and every
 * parent-side CSP violation (frame-src blocking a child self-navigation) into a
 * `<pre>` log, tracks how many frames have announced `ready` so a re-created
 * frame is a positive fence, and exposes a control object to send bridge
 * messages, tear the frame down, and re-create it.
 *
 * The window `message` listener is registered before the iframe is created, and
 * that ordering is load-bearing: `ready` is sent once per frame instance and
 * does not queue, so a listener installed after the frame begins loading loses
 * the handshake — and with it the only port into the frame — permanently.
 */
function buildHarnessHtml(
  sandboxOrigin: string,
  renderer: SandboxRenderer,
  frameSourceMeta: string | null
): string {
  const rendererPath = renderer === 'python' ? '/python.html' : '/render.html';
  const frameSource = `${sandboxOrigin}${rendererPath}`;
  const metaTag =
    frameSourceMeta === null
      ? ''
      : `<meta http-equiv="Content-Security-Policy" content="${frameSourceMeta}" />`;
  // The inline script is classic and self-contained; it references only browser
  // globals. `sandboxAttr` and `frameSource` are interpolated as JSON so the
  // values cannot break out of the string context. Newlines in the log use a
  // char code so this generator carries no escaped-backslash literals.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />${metaTag}<title>document sandbox harness</title></head><body>
<pre id="${BRIDGE_LOG_ID}"></pre>
<span id="${STATUS_ID}">ready:0</span>
<script>
(function () {
  var logEl = document.getElementById(${JSON.stringify(BRIDGE_LOG_ID)});
  var statusEl = document.getElementById(${JSON.stringify(STATUS_ID)});
  var readyCount = 0;
  var frame = null;
  var port = null;
  function append(line) { logEl.textContent += line + String.fromCharCode(10); }
  // A frame-src violation on a child self-navigation is reported to THIS
  // (embedding) document, so the parent is where the block is observable.
  document.addEventListener('securitypolicyviolation', function (e) {
    append('CSPV ' + e.violatedDirective + ' ' + e.blockedURI);
  });
  // Every frame->parent message except the handshake arrives on the port.
  function record(d) {
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'console') { append('MSG console:' + d.stream + ' ' + d.text); return; }
    if (d.type === 'error') { append('MSG error ' + d.code + ' ' + d.message); return; }
    if (d.type === 'result') { append('MSG result ' + JSON.stringify(d.outputs)); return; }
    append('MSG ' + d.type + (d.requestId ? (' ' + d.requestId) : '') + (d.phase ? (' ' + d.phase) : ''));
  }
  // The window carries the handshake and nothing else. Registered before the
  // first frame exists, because 'ready' fires once and does not queue.
  globalThis.addEventListener('message', function (ev) {
    if (!frame || ev.source !== frame.contentWindow) return;
    var d = ev.data;
    if (!d || d.type !== 'ready') return;
    // First ready wins, until the frame is replaced: document code shares the
    // frame's realm and can announce a channel of its own, but the bootstrap
    // runs first, so only its port is ever taken.
    if (port) return;
    var p = ev.ports[0];
    if (!p) return;
    port = p;
    p.addEventListener('message', function (pe) { record(pe.data); });
    // A port added to with addEventListener stays paused; without this start()
    // nothing the frame reports is ever delivered.
    p.start();
    readyCount += 1;
    statusEl.textContent = 'ready:' + readyCount;
    append('MSG ready');
  });
  function makeFrame() {
    // A new frame instance mints a new channel, so the captured port is dropped
    // here and re-captured from that frame's own handshake.
    port = null;
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', ${JSON.stringify(DOCUMENT_IFRAME_SANDBOX_ATTR)});
    f.setAttribute('title', 'document sandbox');
    f.src = ${JSON.stringify(frameSource)};
    document.body.appendChild(f);
    return f;
  }
  frame = makeFrame();
  globalThis.__docFrame = {
    // Fail loudly rather than drop: a silently discarded parent->frame message
    // is the exact defect this transport exists to prevent.
    send: function (msg) {
      if (!port) throw new Error('document sandbox harness: no port captured');
      port.postMessage(msg);
    },
    teardown: function () { frame.remove(); port = null; },
    recreate: function () { frame = makeFrame(); },
  };
})();
</script></body></html>`;
}

/** The typed shape the parent page exposes for Playwright to drive the frame. */
interface DocumentFrameControl {
  send: (msg: unknown) => void;
  teardown: () => void;
  recreate: () => void;
}

/** A parent→frame bridge message. Kept structural so the harness needs no cross-package import. */
type ParentMessage =
  | { type: 'init'; kind: string; code: string; requestId: string }
  | { type: 'run'; requestId: string }
  | { type: 'stop'; requestId: string };

/**
 * Drives one document sandbox iframe embedded in a synthetic cross-origin
 * parent. Construct it, `open()` it (installs the route, navigates, waits for
 * the first `ready`), then send bridge messages and assert on `bridgeLog`.
 */
export class DocumentSandboxHarness {
  readonly page: Page;
  private readonly sandbox: string;

  constructor(page: Page) {
    this.page = page;
    this.sandbox = sandboxOriginUrl();
  }

  /** The accumulated bridge log — every frame message and parent CSP violation, one line each. */
  bridgeLog(): Locator {
    return this.page.locator(`#${BRIDGE_LOG_ID}`);
  }

  private status(): Locator {
    return this.page.locator(`#${STATUS_ID}`);
  }

  /**
   * Serve the parent page from a loopback server and load it.
   * `frameSourceDelivery` selects how the parent's `frame-src 'self' <sandbox>`
   * reaches the browser: a real HTTP header (the web `_headers` path) or a
   * `<meta http-equiv>` (the Capacitor bundle path). Both govern a child
   * self-navigation; testing both proves the mobile delivery is as effective as
   * the web one. The server is torn down when the page closes (fixture
   * teardown), never in a spec.
   */
  async open(
    options: { renderer?: SandboxRenderer; frameSourceDelivery?: FrameSourceDelivery } = {}
  ): Promise<this> {
    const renderer = options.renderer ?? 'render';
    const delivery = options.frameSourceDelivery ?? 'header';
    const frameSource = `frame-src 'self' ${this.sandbox}`;
    const html = buildHarnessHtml(this.sandbox, renderer, delivery === 'meta' ? frameSource : null);
    const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
    if (delivery === 'header') headers['Content-Security-Policy'] = frameSource;

    const server = createServer((_req, res) => {
      res.writeHead(200, headers);
      res.end(html);
    });
    // Loopback bind; the browser reaches it as ported `http://localhost:<port>`.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const parentUrl = `http://localhost:${String(port)}${HARNESS_PATH}`;
    // Close over the page's own lifecycle so cleanup rides fixture teardown, not
    // an afterEach in the spec. closeAllConnections drops the browser's keep-alive
    // socket so the listener does not linger past the page.
    this.page.once('close', () => {
      server.closeAllConnections();
      server.close();
    });

    await this.page.goto(parentUrl);
    await this.waitForReady(1);
    return this;
  }

  /**
   * Wait until `count` frames have completed the handshake (a re-created frame
   * is a positive fence). The counter advances only after that frame's port is
   * captured and started, so it also fences the frame being drivable.
   */
  async waitForReady(count: number): Promise<void> {
    await expect(this.status()).toHaveText(`ready:${String(count)}`, { timeout: TIMEOUTS.MODAL });
  }

  /** Load a document into the frame (renders html/js/react; arms python for `run`). */
  async sendInit(kind: string, code: string, requestId = 'r1'): Promise<void> {
    await this.dispatch({ type: 'init', kind, code, requestId });
  }

  /** Execute a previously-armed python document. */
  async sendRun(requestId = 'r1'): Promise<void> {
    await this.dispatch({ type: 'run', requestId });
  }

  /** Send the cooperative stop signal (the app also tears the frame down). */
  async sendStop(requestId = 'r1'): Promise<void> {
    await this.dispatch({ type: 'stop', requestId });
  }

  /** Remove the iframe element — the app's real Stop/teardown, which kills any in-frame execution. */
  async teardownFrame(): Promise<void> {
    await this.page.evaluate(() => {
      (globalThis as unknown as { __docFrame: DocumentFrameControl }).__docFrame.teardown();
    });
  }

  /** Re-embed a fresh frame; combined with `waitForReady(n)` it is a real-time fence. */
  async recreateFrame(): Promise<void> {
    await this.page.evaluate(() => {
      (globalThis as unknown as { __docFrame: DocumentFrameControl }).__docFrame.recreate();
    });
  }

  private async dispatch(message: ParentMessage): Promise<void> {
    await this.page.evaluate((msg) => {
      (globalThis as unknown as { __docFrame: DocumentFrameControl }).__docFrame.send(msg);
    }, message);
  }
}
