import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { SANDBOX_CSP } from '../csp.js';
import { resolveEsmStub } from '../esm-stub.js';
import { RENDER_BUNDLE_PATH } from './build-bundle.js';

/**
 * Drives the real renderer page in a headless browser: the committed
 * public/render.html + public/render.js (the actual bundle), with the module
 * CDN pointed at an in-test stub — exactly the shape test mode uses (a local
 * stub instead of esm.sh). This exercises the whole pipeline in a real engine:
 * specifier resolution, in-browser JSX transpile, module loading, mount, and the
 * typed bridge messages. Loaded top-level, `parent` is the window itself, so the
 * frame's outbound messages land on the same window the test posts `init` to.
 */

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const RENDER_HTML = readFileSync(path.join(publicDir, 'render.html'), 'utf8');
const RENDER_JS = readFileSync(RENDER_BUNDLE_PATH, 'utf8');

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

/** Resolve a module request to the shared fixture set, then the test-local extra. */
function moduleBodyFor(pathname: string): string | undefined {
  return resolveEsmStub(pathname) ?? EXTRA_MODULES[pathname];
}

interface BridgeLike {
  readonly type?: string;
  readonly requestId?: string;
  readonly code?: string;
  readonly message?: string;
  readonly stream?: string;
  readonly text?: string;
}

let browser: Browser;
let server: Server;
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      // Serve the one authoritative sandbox CSP on every response, exactly as the
      // production `_headers` and dev server do, so these tests prove the renderer
      // runs under the deployed policy rather than an unconstrained dev server.
      const send = (contentType: string, body: string): void => {
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Security-Policy': SANDBOX_CSP });
        res.end(body);
      };
      if (pathname === '/render.html') {
        send('text/html; charset=utf-8', RENDER_HTML);
        return;
      }
      if (pathname === '/render.js') {
        send('text/javascript; charset=utf-8', RENDER_JS);
        return;
      }
      if (pathname === '/config.js') {
        const config = JSON.stringify({ esmCdnUrl: `${origin}/esm-stub` });
        send('text/javascript; charset=utf-8', `globalThis['__SANDBOX_CONFIG__'] = ${config};`);
        return;
      }
      const stub = moduleBodyFor(pathname);
      if (stub !== undefined) {
        send('text/javascript; charset=utf-8', stub);
        return;
      }
      res.writeHead(404);
      res.end();
    }).listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no server port');
      origin = `http://127.0.0.1:${String(address.port)}`;
      resolve();
    });
  });
  browser = await chromium.launch({ args: ['--no-sandbox'] });
}, 60_000);

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    })
  );
});

/**
 * Load the renderer page fresh, send one `init`, and collect the bridge
 * messages. `observeAfterMs` keeps watching past the terminal message, so a test
 * can assert that nothing further arrives once a document has rendered.
 */
async function render(
  kind: string,
  code: string,
  observeAfterMs = 0
): Promise<{ messages: BridgeLike[]; rootHtml: string }> {
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      (globalThis as unknown as { __msgs: unknown[] }).__msgs = [];
      window.addEventListener('message', (event) =>
        (globalThis as unknown as { __msgs: unknown[] }).__msgs.push(event.data)
      );
    });
    await page.goto(`${origin}/render.html`);
    await page.waitForFunction(() =>
      (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some((m) => m.type === 'ready')
    );
    await page.evaluate(
      (payload) => {
        // eslint-disable-next-line sonarjs/post-message -- test harness posts init to its own window (the renderer loads top-level, so parent === window)
        window.postMessage({ type: 'init', requestId: 'r1', ...payload }, '*');
      },
      { kind, code }
    );
    await page.waitForFunction(
      () =>
        (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some(
          (m) => m.type === 'rendered' || m.type === 'error'
        ),
      undefined,
      { timeout: 15_000 }
    );
    if (observeAfterMs > 0) await page.waitForTimeout(observeAfterMs);
    const messages = await page.evaluate(
      () => (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs
    );
    const rootHtml = await page.evaluate(
      () => document.querySelector('#document-root')?.innerHTML ?? ''
    );
    return { messages, rootHtml };
  } finally {
    await page.close();
  }
}

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
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        (globalThis as unknown as { __msgs: unknown[] }).__msgs = [];
        window.addEventListener('message', (event) =>
          (globalThis as unknown as { __msgs: unknown[] }).__msgs.push(event.data)
        );
      });
      await page.goto(`${origin}/render.html`);
      const waitFor = async (requestId: string): Promise<void> => {
        await page.waitForFunction(
          (rid) =>
            (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some(
              (m) => (m.type === 'rendered' || m.type === 'error') && m.requestId === rid
            ),
          requestId,
          { timeout: 15_000 }
        );
      };
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some(
            (m) => m.type === 'ready'
          ),
        undefined,
        { timeout: 15_000 }
      );
      await page.evaluate(() => {
        // eslint-disable-next-line sonarjs/post-message -- test harness posts init to its own window
        window.postMessage(
          {
            type: 'init',
            kind: 'react',
            requestId: 'grow-1',
            code: 'export default function App() { return <p id="first">first</p>; }',
          },
          '*'
        );
      });
      await waitFor('grow-1');
      await page.evaluate(() => {
        // eslint-disable-next-line sonarjs/post-message -- test harness posts init to its own window
        window.postMessage(
          {
            type: 'init',
            kind: 'react',
            requestId: 'grow-2',
            code: `import greeting from 'greeting-fixture';
              export default function App() { return <p id="second">{greeting()}</p>; }`,
          },
          '*'
        );
      });
      await waitFor('grow-2');
      const messages = await page.evaluate(() =>
        (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.filter(
          (m) => m.requestId === 'grow-2'
        )
      );
      const rootHtml = await page.evaluate(
        () => document.querySelector('#document-root')?.innerHTML ?? ''
      );
      const importMaps = await page.evaluate(
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
      await page.close();
    }
  }, 30_000);

  it("does not fail a new request with the previous document's error", async () => {
    // The app re-`init`s the same frame as a document streams and deliberately
    // never remounts it, so the previous document is still live — its timers keep
    // firing. Attributing one of those to the request that happens to be in
    // flight would put a sticky error card over a working preview.
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        (globalThis as unknown as { __msgs: unknown[] }).__msgs = [];
        window.addEventListener('message', (event) =>
          (globalThis as unknown as { __msgs: unknown[] }).__msgs.push(event.data)
        );
      });
      await page.goto(`${origin}/render.html`);
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some(
            (m) => m.type === 'ready'
          ),
        undefined,
        { timeout: 15_000 }
      );
      await page.evaluate(() => {
        // eslint-disable-next-line sonarjs/post-message -- test harness posts init to its own window
        window.postMessage(
          {
            type: 'init',
            kind: 'html',
            requestId: 'stale-1',
            code: `<script>setTimeout(() => { throw new Error('stale boom'); }, 300);</script>`,
          },
          '*'
        );
      });
      await page.waitForTimeout(280);
      await page.evaluate(() => {
        // eslint-disable-next-line sonarjs/post-message -- test harness posts init to its own window
        window.postMessage(
          {
            type: 'init',
            kind: 'js',
            requestId: 'fresh-2',
            code: `await new Promise((resolve) => setTimeout(resolve, 400));
              const root = document.querySelector('#document-root');
              root.textContent = 'fresh output';`,
          },
          '*'
        );
      });
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some(
            (m) => (m.type === 'rendered' || m.type === 'error') && m.requestId === 'fresh-2'
          ),
        undefined,
        { timeout: 15_000 }
      );
      await page.waitForTimeout(200);
      const messages = await page.evaluate(() =>
        (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.filter(
          (m) => m.requestId === 'fresh-2'
        )
      );
      const rootHtml = await page.evaluate(
        () => document.querySelector('#document-root')?.innerHTML ?? ''
      );
      expect(messages.some((m) => m.type === 'error')).toBe(false);
      expect(messages.some((m) => m.type === 'rendered')).toBe(true);
      expect(rootHtml).toContain('fresh output');
    } finally {
      await page.close();
    }
  }, 30_000);

  it('reports a typed error when a render never reaches a terminal message', async () => {
    // A document whose module never finishes loading (here: a top-level await
    // that never resolves) reports nothing at all, and the panel reads silence
    // as "still working". Time is mocked, so the deadline is exercised without
    // the test waiting it out.
    const page = await browser.newPage();
    try {
      await page.clock.install();
      await page.addInitScript(() => {
        (globalThis as unknown as { __msgs: unknown[] }).__msgs = [];
        window.addEventListener('message', (event) =>
          (globalThis as unknown as { __msgs: unknown[] }).__msgs.push(event.data)
        );
      });
      await page.goto(`${origin}/render.html`);
      // Polled from Node: the page's own timers are mocked, so a page-side wait
      // would never tick.
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await page.evaluate(() =>
          (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some((m) => m.type === 'ready')
        );
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await page.evaluate(() => {
        // eslint-disable-next-line sonarjs/post-message -- test harness posts init to its own window (the renderer loads top-level, so parent === window)
        window.postMessage(
          { type: 'init', kind: 'js', requestId: 'r1', code: 'await new Promise(() => {});' },
          '*'
        );
      });
      await page.clock.fastForward(120_000);
      const messages = await page.evaluate(
        () => (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs
      );
      const error = messages.find((m) => m.type === 'error');
      expect(error?.code).toBe('timed_out');
      expect(messages.some((m) => m.type === 'rendered')).toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);

  it('neutralizes the WebRTC constructors on the frame before document code runs', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/render.html`);
      const probe = await page.evaluate(() => {
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
      await page.close();
    }
  }, 30_000);
});
