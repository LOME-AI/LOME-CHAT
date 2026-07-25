// Import the bridge from the narrow `@hushbox/shared/documents` subpath, never the
// top-level barrel: the barrel `export *`s the backend env-config registry, which
// esbuild cannot tree-shake out of the bundle. Pulling it in would embed every
// backend env-var name (and dev-mode secret-shaped values) into the renderer bundle
// this credential-free public sandbox origin serves.
import {
  parseParentToFrameMessage,
  type ErrorMessage,
  type FrameToParentMessage,
  type InitMessage,
  type RenderedMessage,
} from '@hushbox/shared/documents';
import { SANDBOX_CONFIG_GLOBAL } from '../config.js';
import { neutralizeWebRtc } from '../neutralize-webrtc.js';
import { rewriteBareImports } from './resolve-imports.js';
import { REACT_PINS } from './react-runtime.js';
import { moduleUrlFor } from './specifier.js';
import { transpileReact, TranspileError } from './transpile.js';

/**
 * The web renderer that runs inside the sandbox-origin iframe. This file is
 * bundled (with its imports and Sucrase) into a single classic script the page
 * loads, so it runs immediately and fetches nothing. A document's bare imports
 * are resolved by rewriting them to absolute CDN URLs in its source
 * (`resolve-imports.ts`); the frame installs no import map, so nothing depends
 * on how many maps an engine honors or on when one was injected.
 *
 * The embedding app is never trusted: inbound messages are validated by shape
 * (not by the sender's origin, which may be `capacitor://localhost`), and
 * results are broadcast without echoing any origin. Containment is the opaque
 * sandbox origin itself, enforced by the frame's attributes and CSP.
 */

const ROOT_ID = 'document-root';

interface ResolvedConfig {
  readonly esmCdnUrl: string;
}

/**
 * How long a web render may take before the frame declares it failed. The panel
 * treats silence as "still working", so a render that never reports anything at
 * all would leave it waiting forever; this bounds that wait. Sized for the slow
 * leg — a document's npm modules downloading over a poor mobile connection —
 * because falsely failing a slow-but-working render costs more than a late
 * error does.
 */
const RENDER_DEADLINE_MS = 20_000;

/**
 * React commits in the task after `render()` returns and flushes passive effects
 * in the task after that (measured against React 19.2), so nothing about a react
 * render is known before two turns have passed — not even that it has started.
 * Beyond those, the tree is watched until it stops changing (see
 * `awaitTreeQuiescence`).
 */
const REACT_SETTLE_TURNS = 2;

/**
 * The React root this frame mounted, if the last document was a react one. A
 * container may host only one root, so the previous one is unmounted before the
 * next document takes the container over — rather than reused, because each
 * root's error handler is bound to the request that created it, which is what
 * keeps an old tree's late failure off a new request.
 */
let activeRoot: { unmount: () => void } | null = null;

/** The request being rendered right now, or `null` when nothing is in flight. */
let pendingRequestId: string | null = null;

/**
 * The most recent request the frame was given, settled or not. A react
 * document's failure can arrive after its render was reported, and this is what
 * says whether the tree that died is still the one on screen — an older root's
 * failure belongs to a document the frame has already replaced.
 */
let latestRequestId: string | null = null;

/** Whether the live react tree has already reported its own death. */
let reactFailureReported = false;

/**
 * The request an uncaught window error may be blamed on, or `null` when no such
 * error can be trusted to belong to the current render. The frame is a shared
 * realm that the app re-`init`s without remounting it, so a previous document's
 * timers keep firing here long after its request ended; a window error names no
 * request, and blaming whichever one happens to be in flight would put an error
 * card over a working preview. It is therefore opened only around the moments a
 * document's own code is running (see `handleInit`), and never for react, which
 * reports through its own root callback instead.
 */
let captureRequestId: string | null = null;

let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

/** Post a typed message back to the embedding app. */
function post(message: FrameToParentMessage): void {
  // Broadcast with '*' on purpose: this opaque-origin frame cannot know its
  // embedder's origin (it is capacitor://localhost on mobile), and the payload
  // carries no secret — containment is the sandbox boundary, not an origin match.
  // eslint-disable-next-line sonarjs/post-message -- intentional '*' to an unknowable embedder origin; payload is non-secret
  parent.postMessage(message, '*');
}

/**
 * Post the terminal message that ends a request — `rendered` or `error` — and
 * mark it finished. The app treats silence as "still working", so a render that
 * ends without either leaves the panel waiting forever, and a second verdict
 * about a live preview would contradict the first.
 *
 * One exception, and only one: a react document's own failure may follow its
 * `rendered` (see `reportReactFailure`). React calls a root's handler solely
 * when that root's tree threw, and unmounts the tree in response — so a late
 * failure is not a competing verdict about a working preview, it is the death of
 * the preview already reported. Everything else keeps exactly one terminal
 * message per request.
 */
function settle(message: RenderedMessage | ErrorMessage): void {
  if (pendingRequestId !== message.requestId) return;
  pendingRequestId = null;
  captureRequestId = null;
  clearTimeout(deadlineTimer);
  post(message);
}

/** Take ownership of a request and start its deadline. */
function beginRequest(requestId: string): void {
  pendingRequestId = requestId;
  latestRequestId = requestId;
  reactFailureReported = false;
  deadlineTimer = setTimeout(() => {
    settle({
      type: 'error',
      requestId,
      code: 'timed_out',
      message: `render reported nothing within ${String(RENDER_DEADLINE_MS)}ms`,
    });
  }, RENDER_DEADLINE_MS);
}

/**
 * Report a react document's own failure, whether or not its render has already
 * been reported.
 *
 * This is the one channel allowed to speak after a request settles, and only
 * because of what it is: React calls a root's handler when that root's tree
 * threw, and it unmounts the tree in response. So by the time this runs there is
 * no working preview left to protect — the panel is showing an empty frame, and
 * silence would leave it with no explanation. Every other path keeps one
 * terminal message per request, because none of them can prove the document on
 * screen is dead.
 *
 * The fences still hold: an older root's failure is dropped once a newer
 * document owns the frame, and a tree reports its death once.
 */
function reportReactFailure(requestId: string, error: unknown): void {
  if (latestRequestId !== requestId) return;
  const failure = {
    type: 'error',
    requestId,
    code: 'runtime_error',
    message: errorText(error),
  } as const;
  if (pendingRequestId === requestId) {
    settle(failure);
    return;
  }
  if (reactFailureReported) return;
  reactFailureReported = true;
  post(failure);
}

/**
 * Fail a render on an error the frame never saw thrown. An html document's
 * inline script throws into the window rather than back into the code that
 * inserted it, so without this a broken document would report success. The error
 * is blamed on a request only while that request's own code is running; outside
 * those moments the error belongs to a document that is already live — its click
 * handler, its timer, or a previous document's — and reporting it would tear a
 * working preview down.
 */
function reportUncaught(error: unknown): void {
  if (captureRequestId === null) return;
  settle({
    type: 'error',
    requestId: captureRequestId,
    code: 'runtime_error',
    message: errorText(error),
  });
}

/**
 * Yield long enough for an asynchronously surfaced failure to arrive before the
 * render is declared a success. One turn is a microtask drain plus a macrotask,
 * which is how far the browser's scheduling carries work queued during the
 * render call.
 */
async function settleTick(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.addEventListener('message', () => {
        resolve();
      });
      // A port delivers nothing until it is started; `addEventListener` (unlike
      // assigning `onmessage`) does not start it implicitly.
      channel.port1.start();
      channel.port2.postMessage(null);
    });
  }
}

/**
 * How long the root must go unchanged before a react render counts as finished.
 *
 * A render is not one commit. An effect that sets state schedules another render
 * and commit round, and the common generated shape chains several — flip a
 * loading flag, fill in data, then touch the DOM — failing in the last one.
 * React unmounts the tree when that happens, so ending the render early claims
 * success over a preview that is about to be emptied.
 *
 * The window is measured in milliseconds, not scheduler turns, because turns
 * cannot tell the two situations apart: measured against React 19.1, the gaps
 * between a chain's rounds ran to ~22 ms — thousands of turns — which is the
 * same magnitude as an animation frame. Any turn count large enough to hold a
 * deep chain together would also hold an animating document open forever. Wall
 * time separates them: 50 ms is roughly twice the widest gap observed between
 * chained rounds, while an animation keeps mutating well inside it.
 */
const QUIESCENCE_QUIET_MS = 50;

/**
 * Hard cap on that wait. A document that never stops changing — an animation, a
 * game loop — is alive rather than still mounting, and must not be held until
 * the request deadline turns it into a reported timeout. Chained mount work
 * completes tens of milliseconds after its first commit, so this leaves an order
 * of magnitude of headroom; a chain still going after it settles as `rendered`,
 * which is the missed-error direction, never a false one.
 */
const QUIESCENCE_BUDGET_MS = 400;

/** Resolve after `ms`, letting the frame run everything it has scheduled. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Wait for a freshly mounted React tree to stop changing (see the constants). */
async function awaitTreeQuiescence(root: Element, isPending: () => boolean): Promise<void> {
  let changes = 0;
  const observer = new MutationObserver(() => {
    changes += 1;
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  try {
    // The baseline turns come first: a component that renders nothing at all
    // mutates nothing, so a quiet window alone would declare it finished before
    // its effects had run.
    await settleTick(REACT_SETTLE_TURNS);
    const start = performance.now();
    let seen = -1;
    while (seen !== changes && isPending() && performance.now() - start < QUIESCENCE_BUDGET_MS) {
      seen = changes;
      await delay(QUIESCENCE_QUIET_MS);
    }
  } finally {
    observer.disconnect();
  }
}

/** Read the env-derived config the page's `/config.js` published; fail loud if absent. */
function readConfig(): ResolvedConfig {
  const raw = (globalThis as Record<string, unknown>)[SANDBOX_CONFIG_GLOBAL];
  if (
    raw === null ||
    typeof raw !== 'object' ||
    typeof (raw as ResolvedConfig).esmCdnUrl !== 'string'
  ) {
    throw new Error('sandbox config missing — /config.js did not publish esmCdnUrl');
  }
  return { esmCdnUrl: (raw as ResolvedConfig).esmCdnUrl };
}

/** The root element documents render into; fail loud if the page shape changed. */
function requireRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>(`#${ROOT_ID}`);
  if (root === null) throw new Error(`missing #${ROOT_ID}`);
  return root;
}

/** Forward the document's console output to the app as typed messages. */
function installConsoleForwarding(requestId: string): void {
  const routes: readonly [keyof Console, 'stdout' | 'stderr'][] = [
    ['log', 'stdout'],
    ['info', 'stdout'],
    ['debug', 'stdout'],
    ['warn', 'stderr'],
    ['error', 'stderr'],
  ];
  for (const [method, stream] of routes) {
    const original = console[method] as (...args: unknown[]) => void;
    (console[method] as unknown) = (...args: unknown[]): void => {
      post({ type: 'console', requestId, stream, text: args.map(String).join(' ') });
      original.apply(console, args);
    };
  }
}

/** Turn a module source string into an importable object URL. */
function moduleUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

// Imported by resolved URL, like everything else the frame loads: a
// runtime-computed specifier also keeps esbuild from bundling these at build
// time and TypeScript from resolving a module the sandbox does not depend on.
async function importRuntimeModule(
  specifier: string,
  cdnBase: string
): Promise<Record<string, unknown>> {
  return (await import(moduleUrlFor(specifier, cdnBase, REACT_PINS))) as Record<string, unknown>;
}

/** Render a react document by mounting its default-export component. */
async function renderReact(
  msg: InitMessage,
  config: ResolvedConfig,
  root: HTMLElement
): Promise<void> {
  post({ type: 'loading', requestId: msg.requestId, phase: 'transpiling' });
  const js = rewriteBareImports({
    code: transpileReact(msg.code),
    cdnBase: config.esmCdnUrl,
    pins: REACT_PINS,
  });
  post({ type: 'loading', requestId: msg.requestId, phase: 'loading-modules' });

  let documentModule: Record<string, unknown>;
  let react: Record<string, unknown>;
  let reactDomClient: Record<string, unknown>;
  try {
    documentModule = (await import(moduleUrl(js))) as Record<string, unknown>;
    react = await importRuntimeModule('react', config.esmCdnUrl);
    reactDomClient = await importRuntimeModule('react-dom/client', config.esmCdnUrl);
  } catch (error) {
    settle({
      type: 'error',
      requestId: msg.requestId,
      code: 'import_failed',
      message: errorText(error),
    });
    return;
  }

  const Component = documentModule['default'];
  if (typeof Component !== 'function') {
    settle({
      type: 'error',
      requestId: msg.requestId,
      code: 'mount_failed',
      message: 'react document has no default-export component',
    });
    return;
  }

  const createElement = react['createElement'] as (type: unknown) => unknown;
  const createRoot = reactDomClient['createRoot'] as (
    el: Element,
    options: { onUncaughtError: (error: unknown) => void }
  ) => { render: (node: unknown) => void; unmount: () => void };
  // React reports a failure from any phase — render, commit, or an effect — to
  // the root's own handler, and unmounts the tree, so this is the whole failure
  // channel for a react document: the window path stays closed for this kind.
  // Binding the handler to this request is also what keeps an earlier document's
  // failure off a later one, since an older root's handler names an older
  // request, which can no longer settle anything.
  const reactRoot = createRoot(root, {
    onUncaughtError: (error: unknown) => {
      reportReactFailure(msg.requestId, error);
    },
  });
  activeRoot = reactRoot;
  reactRoot.render(createElement(Component));
  await awaitTreeQuiescence(root, () => pendingRequestId === msg.requestId);
}

/** Render an html document, re-executing its inline scripts. */
function renderHtml(msg: InitMessage, config: ResolvedConfig, root: HTMLElement): void {
  root.innerHTML = msg.code;
  // Assigning innerHTML does not run <script> elements; recreate each so it does.
  for (const stale of root.querySelectorAll('script')) {
    const fresh = document.createElement('script');
    for (const attribute of stale.attributes) fresh.setAttribute(attribute.name, attribute.value);
    // Only a module script can carry imports, and only its body is rewritten —
    // the rest of the document keeps the author's text exactly as written.
    fresh.textContent =
      stale.type === 'module'
        ? rewriteBareImports({
            code: stale.textContent,
            cdnBase: config.esmCdnUrl,
            pins: REACT_PINS,
          })
        : stale.textContent;
    stale.replaceWith(fresh);
  }
}

/** Run a js document for its DOM side effects. */
async function renderJs(msg: InitMessage, config: ResolvedConfig): Promise<void> {
  try {
    await import(
      moduleUrl(rewriteBareImports({ code: msg.code, cdnBase: config.esmCdnUrl, pins: REACT_PINS }))
    );
  } catch (error) {
    settle({
      type: 'error',
      requestId: msg.requestId,
      code: 'runtime_error',
      message: errorText(error),
    });
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** Route a validated `init` to the renderer for its kind. */
async function handleInit(msg: InitMessage): Promise<void> {
  beginRequest(msg.requestId);
  installConsoleForwarding(msg.requestId);
  // Every kind takes the container over, so a React tree left by the previous
  // document is torn down first. React routes a cleanup failure to that tree's
  // own root handler, which names the request that is already finished.
  const previousRoot = activeRoot;
  activeRoot = null;
  previousRoot?.unmount();
  try {
    const config = readConfig();
    const root = requireRoot();
    switch (msg.kind) {
      case 'html': {
        // The document's inline scripts run synchronously as it is inserted, and
        // a throw there arrives only on the window — so the capture is open
        // across the insertion and the settle turn that follows it. The
        // insertion blocks this frame's event loop, so no other document's timer
        // can interleave with it.
        captureRequestId = msg.requestId;
        renderHtml(msg, config, root);
        break;
      }
      case 'js': {
        // A failure while the module loads or evaluates rejects the import and
        // is typed above, so the capture opens only for the settle turn after
        // that — the module fetch can take seconds, and holding the capture open
        // across it would hand any stale error to this request.
        await renderJs(msg, config);
        captureRequestId = msg.requestId;
        break;
      }
      case 'react': {
        await renderReact(msg, config, root);
        break;
      }
      case 'python': {
        // Python runs on the dedicated Pyodide page, never this renderer.
        settle({
          type: 'error',
          requestId: msg.requestId,
          code: 'unsupported_kind',
          message: 'python renders on the python page',
        });
        return;
      }
    }
  } catch (error) {
    const code = error instanceof TranspileError ? 'transpile_failed' : 'runtime_error';
    settle({ type: 'error', requestId: msg.requestId, code, message: errorText(error) });
    return;
  }
  await settleTick(1);
  settle({ type: 'rendered', requestId: msg.requestId });
}

/** Wire the message listener and announce readiness. */
export function startRenderer(): void {
  globalThis.addEventListener('error', (event) => {
    reportUncaught(event.error ?? event.message);
  });
  globalThis.addEventListener('unhandledrejection', (event) => {
    reportUncaught(event.reason);
  });
  // The sender's origin is deliberately not checked: the embedder is
  // capacitor://localhost on mobile, so authentication is by message *shape*
  // (schema validation below), never by origin string. This frame is opaque and
  // holds nothing worth spoofing into.
  // eslint-disable-next-line sonarjs/post-message -- shape-validated instead of origin-checked; embedder origin is unknowable
  window.addEventListener('message', (event: MessageEvent) => {
    const parsed = parseParentToFrameMessage(event.data);
    // Only `init` drives this page; run/stop belong to the Python runtime page.
    if (!parsed.success || parsed.data.type !== 'init') return;
    void handleInit(parsed.data);
  });
  post({ type: 'ready' });
}

// Close the WebRTC egress channel before any document code can run. This classic
// bootstrap script executes before the first untrusted module import, so the
// constructors are gone by the time author code evaluates.
neutralizeWebRtc();
startRenderer();
