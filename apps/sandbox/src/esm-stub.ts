import { parseSpecifier } from './render/specifier.js';

/**
 * A deterministic stand-in for esm.sh, served by the dev server so a document's
 * bare imports resolve against local modules in test mode (production
 * and dev-default resolve real npm modules from esm.sh; the env `ESM_CDN_URL`
 * selects between them, pointing at `<sandbox-origin>/esm-stub` under test). The
 * fixture set is the packages the renderer's own documents import — the React
 * family the JSX runtime pulls in, plus one arbitrary npm package
 * (`canvas-confetti`) that stands for "a react/js document importing a bare
 * specifier". Keeping these local means CI and E2E never reach live esm.sh,
 * mirroring the AI-cassette doctrine (mock at the true external seam).
 *
 * The modules are minimal functional stand-ins, not the real builds: enough for
 * a document to mount a React component and call an npm default export in a real
 * browser, without pulling megabytes of framework into a test.
 */

/** The URL namespace the stub occupies on the sandbox origin. */
export const ESM_STUB_PREFIX = '/esm-stub';

// A tiny React whose `createElement` returns a plain vdom node the paired
// react-dom stub walks. `react/jsx-runtime` is the automatic-runtime entry the
// transpiled JSX calls; both `jsx` and `jsxs` collapse to one implementation.
const REACT_MODULE = `export function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), ...(children.length ? { children } : {}) } };
}
// Stands in for the internals React keeps for a render: the effect queue that
// components push to during render, and the hook state a component reads across
// renders. The two fixtures are separate modules served separately, so both live
// on a shared global rather than in module scope. Dependency arrays are ignored;
// what the fixture does model is that an effect updating state schedules another
// render and commit, because a failure in that later round is still a failure of
// the render.
export function useEffect(effect) {
  (globalThis.__hushboxStubEffects ??= []).push(effect);
}
export function useState(initial) {
  const hooks = (globalThis.__hushboxStubHooks ??= { states: [], index: 0, schedule: null });
  const slot = hooks.index++;
  if (!(slot in hooks.states)) hooks.states[slot] = initial;
  const set = (next) => {
    const value = typeof next === 'function' ? next(hooks.states[slot]) : next;
    // An update to the same value is not a render: without this the fixture
    // would loop forever on an effect that sets state on every commit.
    if (Object.is(value, hooks.states[slot])) return;
    hooks.states[slot] = value;
    hooks.schedule?.();
  };
  return [hooks.states[slot], set];
}
export default { createElement, useEffect, useState };`;

const REACT_JSX_RUNTIME_MODULE = `export function jsx(type, props) { return { type, props: props ?? {} }; }
export const jsxs = jsx;
export const Fragment = Symbol.for('react.fragment');`;

// A minimal reconciler: recursively realise a vdom node into DOM under the
// container. Function components are invoked; strings/numbers become text.
const REACT_DOM_CLIENT_MODULE = `function mount(parent, node) {
  if (node == null || node === false || node === true) return;
  if (Array.isArray(node)) { for (const child of node) mount(parent, child); return; }
  if (typeof node === 'string' || typeof node === 'number') {
    parent.appendChild(document.createTextNode(String(node))); return;
  }
  const { type, props } = node;
  if (typeof type === 'function') { mount(parent, type(props)); return; }
  if (typeof type !== 'string') { mount(parent, props?.children); return; }
  const element = document.createElement(type);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'children') continue;
    element.setAttribute(key, String(value));
  }
  mount(element, props?.children);
  parent.appendChild(element);
}
// One scheduled turn: a microtask hop and then a task, which is how React's
// scheduler reaches its work.
function schedule(task) {
  queueMicrotask(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => task();
    channel.port2.postMessage(null);
  });
}
export function createRoot(container, options) {
  // React hands an uncaught error to the root's own \`onUncaughtError\` when one is
  // supplied and to \`reportError\` (a window 'error' event) otherwise, and it
  // unmounts the tree either way — so a failure leaves an empty container, never
  // a half-rendered one.
  const report = (error) => {
    // The root is dead after an uncaught error: React unmounts the tree and does
    // no further work on it, so scheduled rounds must not resurrect the content.
    failed = true;
    container.textContent = '';
    if (options && typeof options.onUncaughtError === 'function') options.onUncaughtError(error);
    else reportError(error);
  };
  let disposed = false;
  let failed = false;
  const hooks = (globalThis.__hushboxStubHooks ??= { states: [], index: 0, schedule: null });
  let tree = null;
  const commit = () => {
    if (disposed || failed) return;
    hooks.index = 0;
    hooks.schedule = () => schedule(commit);
    const effects = (globalThis.__hushboxStubEffects ??= []);
    effects.length = 0;
    try { container.textContent = ''; mount(container, tree); }
    catch (error) { report(error); return; }
    schedule(() => {
      if (disposed || failed) return;
      for (const effect of effects.splice(0)) {
        try { effect(); } catch (error) { report(error); return; }
      }
    });
  };
  return {
    // A root owns its container until it is unmounted; work already scheduled
    // must not land afterwards.
    unmount() { disposed = true; container.textContent = ''; },
    render(node) {
    // React does not mount during \`render()\`: it schedules the work, commits in
    // a later task, and flushes effects in the task after that — a throw from
    // either phase is reported, never thrown back to the caller. Measured against
    // React 19.2 in a real browser. The fixture reproduces that ordering because
    // the renderer's failure handling depends on it: a synchronously-mounting
    // stand-in would let every test reach a mount failure by a route production
    // never takes.
    tree = node;
    hooks.states.length = 0;
    hooks.index = 0;
    schedule(commit);
  } };
}`;

// An arbitrary npm package a document might import. The real canvas-confetti
// draws a burst; the stub appends a marker canvas so a caller can observe that
// the imported module actually ran, then resolves like the real async API.
const CANVAS_CONFETTI_MODULE = `export default function confetti() {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-confetti', 'fired');
  document.body.appendChild(canvas);
  return Promise.resolve();
}`;

/** Fixture modules keyed by bare package name plus any subpath. */
const FIXTURES: Readonly<Record<string, string>> = {
  react: REACT_MODULE,
  'react/jsx-runtime': REACT_JSX_RUNTIME_MODULE,
  'react-dom/client': REACT_DOM_CLIENT_MODULE,
  'canvas-confetti': CANVAS_CONFETTI_MODULE,
};

/**
 * Resolve a request pathname under `/esm-stub/` to a fixture module body, or
 * `null` when the path is outside the namespace or names no fixture. The version
 * segment (`@1.2.3`) is discarded: the stub pins one build per package, so any
 * version an author or the renderer requests maps to the same module.
 */
export function resolveEsmStub(pathname: string): string | null {
  const prefix = `${ESM_STUB_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const specifier = pathname.slice(prefix.length);
  const { name, subpath } = parseSpecifier(specifier);
  const key = `${name}${subpath}`;
  return FIXTURES[key] ?? null;
}
