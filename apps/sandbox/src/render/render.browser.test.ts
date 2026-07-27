import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from '@playwright/test';
import { resolveEsmStub } from '../esm-stub.js';
import {
  launchBrowser,
  openEmbeddedFrame,
  startSandboxOrigin,
  type BridgeLike,
  type EmbeddedFrame,
  type EmbedOptions,
  type SandboxOrigin,
} from '../embed-harness.js';

/**
 * Drives the real renderer page in a headless browser exactly as the app drives
 * it: the committed public/render.html + public/render.js (the actual bundle)
 * inside a real `sandbox="allow-scripts"` iframe, with the module CDN pointed at
 * an in-test stub — the shape test mode uses (a local stub instead of esm.sh).
 * This exercises the whole pipeline in a real engine: specifier resolution,
 * in-browser JSX transpile, module loading, mount, and the typed bridge
 * messages.
 *
 * The embedding is load-bearing. Driving the renderer top-level, where `parent`
 * is the window itself, exercises no opaque origin and no cross-document
 * transport at all — so it cannot observe whether the app's messages reach the
 * frame, only whether the renderer handles the ones it gets.
 */

// The renderer resolves bare specifiers through the same local fixture set test
// mode serves (`esm-stub.ts`), so these tests exercise the module bodies CI and
// E2E actually run — including the react-dom fixture's scheduled mount, which
// mirrors real React and is the path a mount failure travels. Only this one
// extra module is test-local: it stands for "a document importing some npm
// package" without pinning the tests to a fixture the stub set may rename.
const EXTRA_MODULES: Readonly<Record<string, string>> = {
  '/esm-stub/greeting-fixture': `export function greeting() { return 'hello from the fixture package'; }
    export default greeting;`,
};

const JS_CONTENT_TYPE = 'text/javascript; charset=utf-8';

/** The module URL the renderer resolves `react-dom/client` to, whatever the pin. */
const REACT_DOM_CLIENT_URL = /\/react-dom@[^/]+\/client$/;

/**
 * A `react-dom/client` stand-in whose root reports two failures from a single
 * commit round, which is what React does when two sibling effects throw: each
 * captured commit-phase error enqueues its own root error update, and each of
 * those calls the root's `onUncaughtError`. The shared module stub cannot stand
 * in here — its reconciler stops flushing effects at the first throw, so it
 * reports once no matter how many effects would have failed.
 */
const DOUBLE_REPORTING_REACT_DOM = `export function createRoot(container, options) {
  return {
    unmount() { container.textContent = ''; },
    render() {
      queueMicrotask(() => {
        // React tears the tree down before reporting, so the container is
        // already empty when either failure is handed over.
        container.textContent = '';
        options.onUncaughtError(new Error('first sibling boom'));
        options.onUncaughtError(new Error('second sibling boom'));
      });
    },
  };
}`;

/**
 * The routes the committed `public/` tree does not carry: the env-derived
 * `/config.js` (pointed at the in-test module stub) and the stub modules.
 */
function renderRoute(
  pathname: string,
  origin: string
): { contentType: string; body: string } | undefined {
  if (pathname === '/config.js') {
    const config = JSON.stringify({ esmCdnUrl: `${origin}/esm-stub` });
    return { contentType: JS_CONTENT_TYPE, body: `globalThis['__SANDBOX_CONFIG__'] = ${config};` };
  }
  const stub = resolveEsmStub(pathname) ?? EXTRA_MODULES[pathname];
  if (stub === undefined) return undefined;
  return { contentType: JS_CONTENT_TYPE, body: stub };
}

let browser: Browser;
let sandbox: SandboxOrigin;

/** Open the renderer inside a fresh sandboxed frame on the running origin. */
function openRenderer(beforeLoad?: EmbedOptions['beforeLoad']): Promise<EmbeddedFrame> {
  return openEmbeddedFrame(browser, sandbox.origin, { framePath: '/render.html', beforeLoad });
}

/** Read what the document rendered, from inside the frame's own realm. */
function rootHtmlOf(frame: EmbeddedFrame): Promise<string> {
  return frame.probeFrame(() => document.querySelector('#document-root')?.innerHTML ?? '');
}

/**
 * Measure the rendered root against the frame's own viewport, from inside it.
 * The panel gives the frame its size, so "fills" means the viewport — content
 * height would be satisfied by the collapsed root this measurement exists to
 * catch.
 */
function layoutOf(
  frame: EmbeddedFrame
): Promise<{ rootHeight: number; viewportHeight: number; scrollHeight: number }> {
  return frame.probeFrame(() => ({
    rootHeight: document.querySelector('#document-root')?.getBoundingClientRect().height ?? -1,
    viewportHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
}

/** Read the appearance the frame is actually painting, from inside its realm. */
function appearanceOf(
  frame: EmbeddedFrame
): Promise<{ colorScheme: string; backgroundColor: string; color: string }> {
  return frame.probeFrame(() => {
    const computed = getComputedStyle(document.documentElement);
    return {
      colorScheme: computed.colorScheme,
      backgroundColor: computed.backgroundColor,
      color: computed.color,
    };
  });
}

/**
 * Wait for the frame to be painting a given background.
 *
 * A `theme` message names no request and gets no answer — restyling is not a
 * render — so there is no terminal message to wait on and the appearance has to
 * be watched instead.
 */
async function waitForBackground(
  frame: EmbeddedFrame,
  backgroundColor: string
): Promise<{ colorScheme: string; backgroundColor: string; color: string }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const appearance = await appearanceOf(frame);
    if (appearance.backgroundColor === backgroundColor) return appearance;
    if (Date.now() >= deadline) {
      throw new Error(`frame background stayed ${appearance.backgroundColor}`);
    }
    await sleep(50);
  }
}

/** Sleep in Node: one of these tests mocks the page's own clock. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  sandbox = await startSandboxOrigin(renderRoute);
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser.close();
  await sandbox.close();
});

/**
 * Embed the renderer fresh, send one `init` over the port, and collect the
 * bridge messages. `observeAfterMs` keeps watching past the terminal message, so
 * a test can assert that nothing further arrives once a document has rendered.
 */
async function render(
  kind: string,
  code: string,
  observeAfterMs = 0
): Promise<{ messages: BridgeLike[]; rootHtml: string }> {
  const frame = await openRenderer();
  try {
    await frame.send({ type: 'init', requestId: 'r1', kind, code });
    await frame.waitForMessage((m) => m.type === 'rendered' || m.type === 'error');
    if (observeAfterMs > 0) await sleep(observeAfterMs);
    return { messages: await frame.messages(), rootHtml: await rootHtmlOf(frame) };
  } finally {
    await frame.close();
  }
}

describe('sandbox origin static server', () => {
  it('refuses a percent-encoded path that would escape the served directory', async () => {
    // `new URL()` normalizes literal dot segments, so a request has to hide the
    // separator to keep them: `..%2f` survives parsing and only becomes `../`
    // when the pathname is decoded, after the normalization that would have
    // removed it.
    const response = await fetch(`${sandbox.origin}/..%2fpackage.json`);
    expect(response.status).toBe(404);
  });
});

describe('web renderer bridge transport (embedded in a sandboxed frame)', () => {
  it('transfers a MessagePort with its ready broadcast', async () => {
    const frame = await openRenderer();
    try {
      expect(await frame.hasPort()).toBe(true);
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('keeps its end of the channel off the frame global', async () => {
    // Probed against the shipped bundle, not the source: the port is the
    // embedder's authority over this frame, and document code shares this
    // realm. Anything reachable from `globalThis` is reachable by the document.
    const frame = await openRenderer();
    try {
      const reachable = await frame.probeFrame(() => {
        const scope = globalThis as unknown as Record<string, unknown>;
        return Object.getOwnPropertyNames(globalThis).filter((key) => {
          try {
            return scope[key] instanceof MessagePort;
          } catch {
            return false;
          }
        });
      });
      expect(reachable).toEqual([]);
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('renders a document from an init delivered only through the transferred port', async () => {
    // The delivery test the top-level harness could not express. The embedder's
    // origin never reaches the frame — its own origin is opaque, so an
    // explicitly-targeted `window.postMessage` is discarded without an error —
    // and the port is the only channel the app has.
    const frame = await openRenderer();
    try {
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'port-1',
        code: '<p id="port-out">delivered over the port</p>',
      });
      const messages = await frame.waitForMessage(
        (m) => m.type === 'rendered' && m.requestId === 'port-1'
      );
      expect(messages.some((m) => m.type === 'error')).toBe(false);
      expect(await rootHtmlOf(frame)).toContain('delivered over the port');
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('ignores an init posted at its window instead of the port', async () => {
    // Anything sharing the embedder's realm — including a document the app is
    // showing elsewhere — can post at this frame's window with '*', and the
    // browser delivers it. The frame registers no window listener, so the
    // forgery reaches nothing. The port init that follows is the control: it
    // proves the frame was alive and simply refused the window message.
    const frame = await openRenderer();
    try {
      await frame.postToFrameWindow({
        type: 'init',
        kind: 'html',
        requestId: 'forged-1',
        code: '<p id="forged-out">forged</p>',
      });
      await sleep(500);
      const afterForgery = await frame.messages();
      expect(afterForgery.some((m) => m.requestId === 'forged-1')).toBe(false);
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'genuine-1',
        code: '<p id="genuine-out">genuine</p>',
      });
      await frame.waitForMessage((m) => m.type === 'rendered' && m.requestId === 'genuine-1');
      const rootHtml = await rootHtmlOf(frame);
      expect(rootHtml).toContain('id="genuine-out"');
      expect(rootHtml).not.toContain('id="forged-out"');
    } finally {
      await frame.close();
    }
  }, 30_000);
});

describe('web renderer (real browser)', () => {
  it('renders a plain HTML document', async () => {
    const { messages, rootHtml } = await render('html', `<p id="html-out">hello html</p>`);
    expect(messages.some((m) => m.type === 'rendered')).toBe(true);
    expect(rootHtml).toContain('id="html-out"');
    expect(rootHtml).toContain('hello html');
  }, 30_000);

  it("runs an HTML document's own inline <script> under the served CSP", async () => {
    // The html kind IS inline scripts: the sandbox exists to execute the
    // document's own scripts, which a static CSP cannot nonce. This proves the
    // served script-src permits them; without 'unsafe-inline' the browser blocks
    // the inline script and #inline-out never appears.
    const code = `<p id="static-out">static</p>
      <script>
        const p = document.createElement('p');
        p.id = 'inline-out';
        p.textContent = 'from the inline script';
        document.getElementById('document-root').appendChild(p);
      </script>`;
    const { messages, rootHtml } = await render('html', code);
    expect(messages.some((m) => m.type === 'rendered')).toBe(true);
    expect(rootHtml).toContain('id="inline-out"');
    expect(rootHtml).toContain('from the inline script');
  }, 30_000);

  it('keeps WebRTC neutralized inside an inline script the CSP now permits', async () => {
    // 'unsafe-inline' lets the document's inline script run, but the WebRTC
    // constructors are deleted from the frame global before any document code
    // executes, so constructing one still throws no matter how the script runs.
    const code = `<script>
        let outcome = 'reachable';
        try { new RTCPeerConnection(); } catch { outcome = 'blocked'; }
        const p = document.createElement('p');
        p.id = 'rtc-probe';
        p.textContent = outcome;
        document.getElementById('document-root').appendChild(p);
      </script>`;
    const { rootHtml } = await render('html', code);
    expect(rootHtml).toContain('id="rtc-probe"');
    expect(rootHtml).toContain('>blocked</p>');
  }, 30_000);

  it('runs a JS document that manipulates the DOM and forwards console output', async () => {
    const code = `console.log('js-log-line');
      const p = document.createElement('p');
      p.id = 'js-out';
      p.textContent = 'from js';
      document.getElementById('document-root').appendChild(p);`;
    const { messages, rootHtml } = await render('js', code);
    expect(messages.some((m) => m.type === 'rendered')).toBe(true);
    expect(rootHtml).toContain('id="js-out"');
    expect(
      messages.some(
        (m) => m.type === 'console' && m.stream === 'stdout' && m.text === 'js-log-line'
      )
    ).toBe(true);
  }, 30_000);

  it('mounts a React component that imports an npm package', async () => {
    const code = `import { greeting } from 'greeting-fixture';
      export default function App() {
        return <div id="react-out">{greeting()}</div>;
      }`;
    const { messages, rootHtml } = await render('react', code);
    expect(messages.some((m) => m.type === 'rendered')).toBe(true);
    expect(rootHtml).toContain('id="react-out"');
    expect(rootHtml).toContain('hello from the fixture package');
  }, 30_000);

  it('reports a typed error when a js document leaves a promise rejected', async () => {
    // A rejection nobody handles never reaches the code that started the module,
    // only the window — the other half of the uncaught-error capture.
    const code = `Promise.reject(new Error('unhandled boom'));`;
    const { messages } = await render('js', code);
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('runtime_error');
    expect(error?.message).toContain('unhandled boom');
    expect(messages.some((m) => m.type === 'rendered')).toBe(false);
  }, 30_000);

  it('resolves a bare import inside an html document module script', async () => {
    // An html document carries its own `<script type="module">`, and its bare
    // imports are resolved the same way a js or react document's are.
    const code = `<div id="html-module-out"></div>
      <script type="module">
        import greeting from 'greeting-fixture';
        document.querySelector('#html-module-out').textContent = greeting();
      </script>`;
    const { messages, rootHtml } = await render('html', code, 300);
    expect(messages.some((m) => m.type === 'rendered')).toBe(true);
    expect(rootHtml).toContain('hello from the fixture package');
  }, 30_000);

  it("reports a typed error when an html document's inline script throws", async () => {
    // An inline script's throw never propagates back to the code that inserted
    // it — it reaches the frame only as a window `error` event — so without the
    // window-level capture this render reports success over a broken document.
    const code = `<p id="partial-out">partial</p>
      <script>throw new Error('inline boom');</script>`;
    const { messages } = await render('html', code);
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('runtime_error');
    expect(error?.message).toContain('inline boom');
    expect(messages.some((m) => m.type === 'rendered')).toBe(false);
  }, 30_000);

  it("reports a typed error when an inline script's throw is deferred", async () => {
    // The failure need not be thrown while the document is being inserted: a
    // render is declared successful only after the frame has yielded, so a throw
    // deferred out of the inserting task still fails the render.
    const code = `<script>queueMicrotask(() => { throw new Error('deferred boom'); });</script>`;
    const { messages } = await render('html', code);
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('runtime_error');
    expect(error?.message).toContain('deferred boom');
    expect(messages.some((m) => m.type === 'rendered')).toBe(false);
  }, 30_000);

  it('still reports a successful render when a subresource fails to load', async () => {
    // A failed image is not a failed render: resource errors fire on the element
    // and never reach a window-level `error` listener, so the capture must not
    // turn every document with a broken image into a failure.
    const code = `<p id="with-image">with image</p><img src="/nope.png" alt="missing">`;
    const { messages, rootHtml } = await render('html', code, 200);
    expect(messages.some((m) => m.type === 'rendered')).toBe(true);
    expect(messages.some((m) => m.type === 'error')).toBe(false);
    expect(rootHtml).toContain('id="with-image"');
  }, 30_000);

  it('leaves a rendered document alone when it throws after it has rendered', async () => {
    // A live document's own runtime errors are its business: reporting them
    // would tear down a preview that is working.
    const code = `<p id="live-out">live</p>
      <script>setTimeout(() => { throw new Error('later boom'); }, 10);</script>`;
    const { messages, rootHtml } = await render('html', code, 300);
    expect(messages.some((m) => m.type === 'rendered')).toBe(true);
    expect(messages.some((m) => m.type === 'error')).toBe(false);
    expect(rootHtml).toContain('id="live-out"');
  }, 30_000);

  it('reports a typed error when a React component throws while mounting', async () => {
    const code = `export default function App() {
      throw new Error('boom on mount');
    }`;
    const { messages } = await render('react', code);
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('runtime_error');
    expect(error?.message).toContain('boom on mount');
    expect(messages.some((m) => m.type === 'rendered')).toBe(false);
  }, 30_000);

  it('reports a typed error when a React effect throws after the commit', async () => {
    // The most common failure in generated React: the tree renders, then an
    // effect touching the DOM throws. React unmounts the tree, so claiming
    // `rendered` here would be claiming success over an empty preview.
    const code = `import { useEffect } from 'react';
      export default function App() {
        useEffect(() => { throw new Error('effect boom'); });
        return <div id="effect-out">ok</div>;
      }`;
    const { messages, rootHtml } = await render('react', code);
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('runtime_error');
    expect(error?.message).toContain('effect boom');
    expect(messages.some((m) => m.type === 'rendered')).toBe(false);
    expect(rootHtml).toBe('');
  }, 30_000);

  it('reports a typed error when a React effect throws in a later commit round', async () => {
    // The common generated-React shape: an effect flips state, and the effect
    // that then touches the DOM throws. That failure lands in a second commit
    // round, well after the first, and React unmounts — so a render declared
    // finished on a fixed number of turns would claim success over a blank
    // preview.
    const code = `import { useState, useEffect } from 'react';
      export default function App() {
        const [ready, setReady] = useState(false);
        useEffect(() => { setReady(true); });
        useEffect(() => { if (ready) { throw new Error('second round boom'); } });
        return <div id="chained">{String(ready)}</div>;
      }`;
    const { messages, rootHtml } = await render('react', code);
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('runtime_error');
    expect(error?.message).toContain('second round boom');
    expect(messages.some((m) => m.type === 'rendered')).toBe(false);
    expect(rootHtml).toBe('');
  }, 30_000);

  it('reports a typed error when a React effect throws three rounds deep', async () => {
    // The canonical generated-React shape: one effect flips a loading flag, the
    // next fills in data once loaded, and the one after that touches the DOM.
    // Each link is a further commit round, and the failure lands in the third —
    // with no idle gap anywhere in the chain for the render to settle in.
    const code = `import { useState, useEffect } from 'react';
      export default function App() {
        const [loading, setLoading] = useState(true);
        const [data, setData] = useState(null);
        useEffect(() => { setLoading(false); });
        useEffect(() => { if (!loading) { setData([1, 2, 3]); } });
        useEffect(() => { if (data) { throw new Error('third round boom'); } });
        return <div id="deep">{String(loading)}</div>;
      }`;
    const { messages, rootHtml } = await render('react', code);
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('runtime_error');
    expect(error?.message).toContain('third round boom');
    expect(messages.some((m) => m.type === 'rendered')).toBe(false);
    expect(rootHtml).toBe('');
  }, 30_000);

  it('reports a React document that never stops mutating as rendered, promptly', async () => {
    // The other side of waiting for the tree to go quiet: a document that keeps
    // changing is alive, not still mounting. Holding the request open for it
    // would end in the deadline reporting a working preview as timed out.
    const code = `import { useEffect } from 'react';
      export default function App() {
        useEffect(() => {
          setInterval(() => {
            const node = document.querySelector('#anim');
            if (node !== null) node.textContent = String(Math.random());
          }, 16);
        });
        return <p id="anim">start</p>;
      }`;
    const started = Date.now();
    const { messages } = await render('react', code);
    const terminal = messages.find((m) => m.type === 'rendered' || m.type === 'error');
    expect(terminal?.type).toBe('rendered');
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);

  it('reports a React failure that lands after the render was reported', async () => {
    // A round that starts after the tree has gone quiet — a deferred state
    // update, or a lazily imported child arriving — falls outside the render
    // window, so the frame has already reported success. React only calls its
    // root handler when the tree threw and was torn down, so the preview is gone
    // and saying nothing would leave a blank frame with no explanation.
    const code = `import { useState, useEffect } from 'react';
      export default function App() {
        const [boom, setBoom] = useState(false);
        useEffect(() => { setTimeout(() => setBoom(true), 120); });
        if (boom) throw new Error('deferred round boom');
        return <p id="deferred">waiting</p>;
      }`;
    const { messages, rootHtml } = await render('react', code, 600);
    expect(messages.some((m) => m.type === 'rendered')).toBe(true);
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('runtime_error');
    expect(error?.message).toContain('deferred round boom');
    expect(rootHtml).toBe('');
  }, 30_000);

  it('reports one error when a React root reports two failures from one commit round', async () => {
    // The tree died once, so the app is owed one explanation, not two: the
    // second failure carries no fact the first did not. Nothing else in the
    // suite can reach this — the shared module stub reports a single failure per
    // root — so the react-dom this frame loads is replaced for this test alone.
    const frame = await openRenderer(async (page) => {
      await page.route(REACT_DOM_CLIENT_URL, (route) =>
        route.fulfill({
          contentType: JS_CONTENT_TYPE,
          // The frame's origin is opaque, so even a same-server module fetch is
          // cross-origin and needs CORS, exactly as the harness's own responses do.
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: DOUBLE_REPORTING_REACT_DOM,
        })
      );
    });
    try {
      await frame.send({
        type: 'init',
        kind: 'react',
        requestId: 'twice-1',
        code: 'export default function App() { return <p id="doomed">doomed</p>; }',
      });
      await frame.waitForMessage((m) => m.type === 'error' && m.requestId === 'twice-1');
      // Both reports land in the same round, but the frame's second message —
      // if it sent one — would follow the first by a turn, so the count is only
      // meaningful after watching past it.
      await sleep(300);
      const collected = await frame.messages();
      const errors = collected.filter((m) => m.type === 'error' && m.requestId === 'twice-1');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('first sibling boom');
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('reports a typed transpile error for a syntax-error React document', async () => {
    const { messages } = await render('react', `export default () => <div>`);
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('transpile_failed');
    expect(messages.some((m) => m.type === 'rendered')).toBe(false);
  }, 30_000);

  it('renders a second init on a live frame that imports a new specifier', async () => {
    // The streaming path: the app re-`init`s the same frame as a document grows,
    // and a bare import can first appear in a later version of it. The frame must
    // resolve a specifier its first init never saw, and mount over its own
    // previous React tree.
    const frame = await openRenderer();
    try {
      const waitFor = (requestId: string): Promise<BridgeLike[]> =>
        frame.waitForMessage(
          (m) => (m.type === 'rendered' || m.type === 'error') && m.requestId === requestId
        );
      await frame.send({
        type: 'init',
        kind: 'react',
        requestId: 'grow-1',
        code: 'export default function App() { return <p id="first">first</p>; }',
      });
      await waitFor('grow-1');
      await frame.send({
        type: 'init',
        kind: 'react',
        requestId: 'grow-2',
        code: `import greeting from 'greeting-fixture';
          export default function App() { return <p id="second">{greeting()}</p>; }`,
      });
      const collected = await waitFor('grow-2');
      const messages = collected.filter((m) => m.requestId === 'grow-2');
      const rootHtml = await rootHtmlOf(frame);
      const importMaps = await frame.probeFrame(
        () => document.querySelectorAll('script[type="importmap"]').length
      );
      expect(messages.find((m) => m.type === 'error')?.message).toBeUndefined();
      expect(messages.some((m) => m.type === 'rendered')).toBe(true);
      expect(rootHtml).toContain('hello from the fixture package');
      // No import map exists at all: specifiers are resolved into the module
      // source, so a frame resolves the same on its tenth init as on its first —
      // including on an engine that honors only the first map in a document.
      expect(importMaps).toBe(0);
    } finally {
      await frame.close();
    }
  }, 30_000);

  it("does not fail a new request with the previous document's error", async () => {
    // The app re-`init`s the same frame as a document streams and deliberately
    // never remounts it, so the previous document is still live — its timers keep
    // firing. Attributing one of those to the request that happens to be in
    // flight would put a sticky error card over a working preview.
    const frame = await openRenderer();
    try {
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'stale-1',
        code: `<script>setTimeout(() => { throw new Error('stale boom'); }, 300);</script>`,
      });
      await sleep(280);
      await frame.send({
        type: 'init',
        kind: 'js',
        requestId: 'fresh-2',
        code: `await new Promise((resolve) => setTimeout(resolve, 400));
          const root = document.querySelector('#document-root');
          root.textContent = 'fresh output';`,
      });
      await frame.waitForMessage(
        (m) => (m.type === 'rendered' || m.type === 'error') && m.requestId === 'fresh-2'
      );
      await sleep(200);
      const collected = await frame.messages();
      const messages = collected.filter((m) => m.requestId === 'fresh-2');
      const rootHtml = await rootHtmlOf(frame);
      expect(messages.some((m) => m.type === 'error')).toBe(false);
      expect(messages.some((m) => m.type === 'rendered')).toBe(true);
      expect(rootHtml).toContain('fresh output');
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('reports a typed error when a render never reaches a terminal message', async () => {
    // A document whose module never finishes loading (here: a top-level await
    // that never resolves) reports nothing at all, and the panel reads silence
    // as "still working". Time is mocked, so the deadline is exercised without
    // the test waiting it out. Every wait here polls from Node — a page-side
    // waiter would need the page's own (mocked) timers to tick.
    const frame = await openRenderer((page) => page.clock.install());
    try {
      await frame.send({
        type: 'init',
        kind: 'js',
        requestId: 'r1',
        code: 'await new Promise(() => {});',
      });
      await frame.page.clock.fastForward(120_000);
      const messages = await frame.waitForMessage((m) => m.type === 'error');
      const error = messages.find((m) => m.type === 'error');
      expect(error?.code).toBe('timed_out');
      expect(messages.some((m) => m.type === 'rendered')).toBe(false);
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('gives a short document the whole frame to occupy', async () => {
    // The panel sizes the frame; the document has to fill it. A root sized to
    // its own content instead leaves the document as a strip at the top of an
    // empty panel — and reports success while doing it, which is why this is
    // measured rather than eyeballed.
    const frame = await openRenderer();
    try {
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'fill-1',
        code: '<p id="short">short</p>',
      });
      await frame.waitForMessage((m) => m.type === 'rendered' && m.requestId === 'fill-1');
      const { rootHeight, viewportHeight } = await layoutOf(frame);
      expect(viewportHeight).toBeGreaterThan(0);
      expect(Math.abs(rootHeight - viewportHeight)).toBeLessThanOrEqual(2);
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('lets a document taller than the frame scroll to exactly its own height', async () => {
    // Filling the frame must not mean capping it: a long document scrolls. The
    // exact equality is the other half — a default body margin would inset the
    // document from the frame's edges and pad the scroll extent past its
    // content.
    const frame = await openRenderer();
    try {
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'tall-1',
        code: '<div id="tall" style="height: 2000px"></div>',
      });
      await frame.waitForMessage((m) => m.type === 'rendered' && m.requestId === 'tall-1');
      const { scrollHeight, viewportHeight } = await layoutOf(frame);
      expect(scrollHeight).toBeGreaterThan(viewportHeight);
      expect(scrollHeight).toBe(2000);
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('paints the canvas and colour scheme the embedder asked for', async () => {
    // The frame is cross-origin: it cannot read the app's variables, and the OS
    // preference is not the app's theme. What the embedder states is the only
    // thing it has to go on — including the colours, which it holds none of.
    const frame = await openRenderer();
    try {
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'dark-1',
        code: '<p id="themed">themed</p>',
        theme: 'dark',
        background: '#1a1816',
        foreground: '#f2f1ef',
      });
      await frame.waitForMessage((m) => m.type === 'rendered' && m.requestId === 'dark-1');
      const appearance = await appearanceOf(frame);
      expect(appearance.colorScheme).toBe('dark');
      expect(appearance.backgroundColor).toBe('rgb(26, 24, 22)');
      expect(appearance.color).toBe('rgb(242, 241, 239)');
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('restyles a live frame when a later init names the other theme', async () => {
    // A theme change must not cost a remount: the frame element stays, so a
    // running document keeps running and a rendered one stays on screen.
    const frame = await openRenderer();
    try {
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'theme-dark',
        code: '<p id="living">living</p>',
        theme: 'dark',
        background: '#1a1816',
        foreground: '#f2f1ef',
      });
      await frame.waitForMessage((m) => m.type === 'rendered' && m.requestId === 'theme-dark');
      const dark = await appearanceOf(frame);
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'theme-light',
        code: '<p id="living">living</p>',
        theme: 'light',
        background: '#faf9f6',
        foreground: '#1a1a1a',
      });
      await frame.waitForMessage((m) => m.type === 'rendered' && m.requestId === 'theme-light');
      const light = await appearanceOf(frame);
      expect(light.colorScheme).toBe('light');
      expect(light.colorScheme).not.toBe(dark.colorScheme);
      expect(light.backgroundColor).not.toBe(dark.backgroundColor);
      expect(light.color).not.toBe(dark.color);
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('restyles a live frame without re-running the document', async () => {
    // Restyling has its own message because the alternative does damage: a
    // second `init` is how a document is loaded, so it unmounts what is on
    // screen and executes the source again from the top. A reader toggling the
    // app's theme would lose whatever the document had built up.
    const frame = await openRenderer();
    try {
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'keeps-running',
        // The run counter is the discriminator: a re-execution shares this realm
        // with the run before it, so a restart shows up as a second increment.
        code: `<p id="live"></p>
          <script>
            globalThis.__runs = (globalThis.__runs ?? 0) + 1;
            document.querySelector('#live').textContent = 'run ' + globalThis.__runs;
          </script>`,
        theme: 'light',
        background: '#faf9f6',
        foreground: '#1a1a1a',
      });
      await frame.waitForMessage((m) => m.type === 'rendered' && m.requestId === 'keeps-running');
      // State the document acquired after it rendered — a stand-in for anything
      // a live document holds. Nothing recreates it, so it survives a restyle
      // only if the document was left alone.
      await frame.probeFrame(() => {
        const live = document.querySelector<HTMLElement>('#live');
        if (live !== null) live.dataset['live'] = 'kept';
      });

      await frame.send({
        type: 'theme',
        theme: 'dark',
        background: '#1a1816',
        foreground: '#f2f1ef',
      });
      const restyled = await waitForBackground(frame, 'rgb(26, 24, 22)');
      expect(restyled.colorScheme).toBe('dark');
      expect(restyled.color).toBe('rgb(242, 241, 239)');

      const survived = await frame.probeFrame(() => ({
        runs: (globalThis as unknown as { __runs?: number }).__runs,
        marker: document.querySelector<HTMLElement>('#live')?.dataset['live'],
        text: document.querySelector('#live')?.textContent,
      }));
      expect(survived.runs).toBe(1);
      expect(survived.marker).toBe('kept');
      expect(survived.text).toBe('run 1');
    } finally {
      await frame.close();
    }
  }, 30_000);

  it("keeps a document's own root-level colours over the frame's", async () => {
    // The frame's theme is the canvas a document sits on, not a house style
    // imposed on it. This is the unconditional half of that promise: `:root` is
    // a class-level selector (0,1,0) and outranks the frame's type selector
    // (0,0,1), so a document's `:root` rule wins wherever it sits relative to
    // the frame's — source order never enters into it.
    const frame = await openRenderer();
    try {
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'own-colours',
        code: `<style>:root { background-color: rgb(0, 128, 0); color: rgb(255, 0, 255); }</style>
          <p id="own">own colours</p>`,
        // Colours the frame is actually painting, so there is something for the
        // document's rule to beat.
        theme: 'dark',
        background: '#1a1816',
        foreground: '#f2f1ef',
      });
      await frame.waitForMessage((m) => m.type === 'rendered' && m.requestId === 'own-colours');
      const appearance = await appearanceOf(frame);
      expect(appearance.backgroundColor).toBe('rgb(0, 128, 0)');
      expect(appearance.color).toBe('rgb(255, 0, 255)');
    } finally {
      await frame.close();
    }
  }, 30_000);

  it("keeps a document's own html-level colours over the frame's", async () => {
    // The order-dependent half, and the reason the frame styles `html` rather
    // than `:root`: those select the same element with equal specificity, so a
    // document's `html` rule wins only by being later — which it is, because
    // the frame's style element is appended at init, ahead of the document. A
    // frame rule written at `:root` would outrank every `html { … }` a document
    // ships no matter the order — silently, and only for documents that style
    // the root that way.
    const frame = await openRenderer();
    try {
      await frame.send({
        type: 'init',
        kind: 'html',
        requestId: 'own-html-colours',
        code: `<style>html { background-color: rgb(0, 128, 0); color: rgb(255, 0, 255); }</style>
          <p id="own-html">own colours</p>`,
        theme: 'dark',
        background: '#1a1816',
        foreground: '#f2f1ef',
      });
      await frame.waitForMessage(
        (m) => m.type === 'rendered' && m.requestId === 'own-html-colours'
      );
      const appearance = await appearanceOf(frame);
      expect(appearance.backgroundColor).toBe('rgb(0, 128, 0)');
      expect(appearance.color).toBe('rgb(255, 0, 255)');
    } finally {
      await frame.close();
    }
  }, 30_000);

  it('neutralizes the WebRTC constructors on the frame before document code runs', async () => {
    const frame = await openRenderer();
    try {
      const probe = await frame.probeFrame(() => {
        const w = globalThis as unknown as Record<string, unknown>;
        const construct = (): boolean => {
          try {
            new (w['RTCPeerConnection'] as new () => unknown)();
            return false;
          } catch {
            return true;
          }
        };
        return {
          peer: w['RTCPeerConnection'],
          webkit: w['webkitRTCPeerConnection'],
          moz: w['mozRTCPeerConnection'],
          dataChannel: w['RTCDataChannel'],
          constructThrows: construct(),
        };
      });
      expect(probe.peer).toBeUndefined();
      expect(probe.webkit).toBeUndefined();
      expect(probe.moz).toBeUndefined();
      expect(probe.dataChannel).toBeUndefined();
      expect(probe.constructThrows).toBe(true);
    } finally {
      await frame.close();
    }
  }, 30_000);
});
