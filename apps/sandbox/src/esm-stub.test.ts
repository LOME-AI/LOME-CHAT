import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { ESM_STUB_PREFIX, resolveEsmStub } from './esm-stub.js';
import { REACT_RUNTIME_VERSION } from './render/react-runtime.js';

/**
 * The dev server serves this fixture set in place of esm.sh so the renderer's
 * bare imports resolve against deterministic local modules in test mode (the env
 * `ESM_CDN_URL` points at `<origin>/esm-stub` there). The resolver strips the
 * version from every `pkg@ver` / `pkg@ver/subpath` shape and keys on the bare
 * package + subpath, so a document that pins any version still resolves.
 */
describe('resolveEsmStub', () => {
  it('resolves the pinned react module regardless of the requested version', () => {
    const a = resolveEsmStub(`${ESM_STUB_PREFIX}/react@${REACT_RUNTIME_VERSION}`);
    const b = resolveEsmStub(`${ESM_STUB_PREFIX}/react@18.0.0`);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a).toContain('createElement');
  });

  it('resolves the react automatic JSX runtime subpath', () => {
    const body = resolveEsmStub(`${ESM_STUB_PREFIX}/react@${REACT_RUNTIME_VERSION}/jsx-runtime`);
    expect(body).not.toBeNull();
    expect(body).toContain('jsx');
    expect(body).toContain('Fragment');
  });

  it('resolves the react-dom client subpath', () => {
    const body = resolveEsmStub(`${ESM_STUB_PREFIX}/react-dom@${REACT_RUNTIME_VERSION}/client`);
    expect(body).not.toBeNull();
    expect(body).toContain('createRoot');
  });

  it('resolves an unversioned package specifier (no @version segment)', () => {
    const body = resolveEsmStub(`${ESM_STUB_PREFIX}/canvas-confetti`);
    expect(body).not.toBeNull();
    expect(body).toContain('export default');
  });

  it('returns null for a package that has no fixture', () => {
    expect(resolveEsmStub(`${ESM_STUB_PREFIX}/left-pad@1.0.0`)).toBeNull();
  });

  it('returns null for a known package requested at an unknown subpath', () => {
    expect(resolveEsmStub(`${ESM_STUB_PREFIX}/react@${REACT_RUNTIME_VERSION}/server`)).toBeNull();
  });

  it('returns null for a path outside the esm-stub namespace', () => {
    expect(resolveEsmStub('/pyodide/pyodide.mjs')).toBeNull();
  });
});

/**
 * The react-dom fixture's mount timing is load-bearing, not cosmetic: React does
 * not mount during `render()`, and a component that throws is surfaced with
 * `reportError` rather than thrown back to the caller (measured against React
 * 19.2 in a real browser). A fixture that mounted synchronously would let tests
 * and E2E runs reach a mount failure by a route production never takes. The
 * fixtures are browser modules, so they are exercised in a real browser: the
 * react and react-dom sources are concatenated with the probe into one module
 * script, which needs no bundler and no network.
 */
describe('react-dom fixture mount timing', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
  }, 60_000);

  afterAll(async () => {
    await browser.close();
  });

  interface Observed {
    readonly duringRender?: string;
    readonly afterTask?: string;
    readonly threwFromRender?: boolean;
    readonly errors?: readonly string[];
    readonly effectRanAtTurn?: number;
    readonly commits?: number;
    readonly secondRoundThrewAtTurn?: number;
    readonly reported?: readonly string[];
    readonly htmlAfterEffectThrow?: string;
  }

  /** Run a probe against the real fixture sources and read back what it observed. */
  async function observe(probe: string): Promise<Observed> {
    const react = resolveEsmStub(`${ESM_STUB_PREFIX}/react@${REACT_RUNTIME_VERSION}`);
    const client = resolveEsmStub(`${ESM_STUB_PREFIX}/react-dom@${REACT_RUNTIME_VERSION}/client`);
    if (react === null || client === null) throw new Error('missing react fixtures');
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ type: 'module', content: `${react}\n${client}\n${probe}` });
      await page.waitForFunction(() => '__observed' in globalThis, undefined, { timeout: 10_000 });
      return await page.evaluate(
        () => (globalThis as unknown as { __observed: Observed }).__observed
      );
    } finally {
      await page.close();
    }
  }

  it('schedules the mount instead of performing it during render()', async () => {
    const observed = await observe(`
      const root = document.querySelector('#root');
      createRoot(root).render(createElement('p', { id: 'mounted' }, 'hi'));
      const duringRender = root.innerHTML;
      await new Promise((resolve) => setTimeout(resolve, 50));
      globalThis.__observed = { duringRender, afterTask: root.innerHTML };
    `);
    expect(observed.duringRender).toBe('');
    expect(observed.afterTask).toContain('id="mounted"');
  }, 60_000);

  it('surfaces a component throw as a window error event, not out of render()', async () => {
    const observed = await observe(`
      const root = document.querySelector('#root');
      const errors = [];
      globalThis.addEventListener('error', (event) => errors.push(event.message));
      const Boom = () => { throw new Error('stub mount boom'); };
      let threwFromRender = false;
      try { createRoot(root).render(createElement(Boom, null)); } catch { threwFromRender = true; }
      await new Promise((resolve) => setTimeout(resolve, 50));
      globalThis.__observed = { threwFromRender, errors };
    `);
    expect(observed.threwFromRender).toBe(false);
    expect(observed.errors?.join(' ')).toContain('stub mount boom');
  }, 60_000);
  it('flushes effects in the turn after the mount, as React does', async () => {
    // Measured against React 19.2: the tree commits in the task after `render()`
    // and passive effects flush in the task after that. The renderer's decision
    // about when a render may be called successful rests on that ordering.
    const observed = await observe(`
      const root = document.querySelector('#root');
      let effectRanAtTurn = -1;
      let turn = 0;
      const App = () => {
        useEffect(() => { effectRanAtTurn = turn; });
        return createElement('p', { id: 'mounted' }, 'hi');
      };
      createRoot(root).render(createElement(App));
      const yieldTurn = () => new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
      for (turn = 1; turn <= 4; turn++) { await Promise.resolve(); await yieldTurn(); }
      globalThis.__observed = { effectRanAtTurn, afterTask: root.innerHTML };
    `);
    expect(observed.effectRanAtTurn).toBe(2);
    expect(observed.afterTask).toContain('id="mounted"');
  }, 60_000);

  it('routes a throw to the root onUncaughtError handler and unmounts the tree', async () => {
    // React hands an uncaught error to the root's own callback rather than to
    // `reportError` when one is supplied, and tears the tree down — which is why
    // a "rendered" claim over an effect failure is a claim over an empty preview.
    const observed = await observe(`
      const root = document.querySelector('#root');
      const reported = [];
      const App = () => {
        useEffect(() => { throw new Error('effect boom'); });
        return createElement('p', { id: 'mounted' }, 'hi');
      };
      createRoot(root, { onUncaughtError: (error) => reported.push(String(error)) })
        .render(createElement(App));
      await new Promise((resolve) => setTimeout(resolve, 50));
      globalThis.__observed = { reported, htmlAfterEffectThrow: root.innerHTML };
    `);
    expect(observed.reported?.join(' ')).toContain('effect boom');
    expect(observed.htmlAfterEffectThrow).toBe('');
  }, 60_000);

  it('commits a second round when an effect updates state', async () => {
    // A state update from an effect schedules another render and commit. React
    // does that in later turns than the first commit, and a failure in any of
    // those rounds is still a failure of the render — so the fixture has to be
    // able to produce one.
    const observed = await observe(`
      const root = document.querySelector('#root');
      let commits = 0;
      let secondRoundThrewAtTurn = -1;
      let turn = 0;
      const App = () => {
        const [ready, setReady] = useState(false);
        useEffect(() => { setReady(true); });
        useEffect(() => { if (ready) { secondRoundThrewAtTurn = turn; } });
        commits++;
        return createElement('p', { id: 'round' }, String(ready));
      };
      createRoot(root).render(createElement(App));
      const yieldTurn = () => new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
      for (turn = 1; turn <= 6; turn++) { await Promise.resolve(); await yieldTurn(); }
      globalThis.__observed = { commits, secondRoundThrewAtTurn, afterTask: root.innerHTML };
    `);
    expect(observed.commits).toBe(2);
    expect(observed.secondRoundThrewAtTurn).toBe(4);
    expect(observed.afterTask).toContain('true');
  }, 60_000);
});
