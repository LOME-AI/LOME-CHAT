// Import the bridge from the narrow `@hushbox/shared/documents` subpath, never the
// top-level barrel: the barrel `export *`s the backend env-config registry, which
// esbuild cannot tree-shake out, so importing it would embed every backend env-var
// name (and dev-mode secret-shaped values) into the bundle this credential-free
// public origin serves.
import {
  parseParentToFrameMessage,
  type ErrorMessage,
  type FrameToParentMessage,
  type ResultMessage,
} from '@hushbox/shared/documents';
import { neutralizeWebRtc } from '../neutralize-webrtc.js';
import { classifyPythonError, INPUT_UNSUPPORTED_MARKER } from './error-classification.js';

/**
 * The Python runtime that runs inside the sandbox-origin iframe. It lazy-loads
 * the pinned, self-hosted Pyodide, executes a document's Python on `run`, streams
 * stdout/stderr as `console` messages, returns matplotlib figures as `image/png`
 * results, and surfaces tracebacks as typed `error`s.
 *
 * Pyodide runs on the iframe's MAIN THREAD, never a worker: a module worker (which
 * Pyodide 314 requires) cannot be spawned from a `blob:null` URL inside an opaque
 * `allow-scripts` sandbox, and keeping that strong sandbox is the security wall.
 * Origin isolation — not a worker — is the containment boundary. "Stop" is the
 * parent tearing down this iframe (it owns the element and can kill even a
 * main-thread-spinning frame); this page never self-interrupts, so nothing needs
 * to escape the frame and a fresh page load is a fresh interpreter.
 *
 * The embedding app is never trusted: inbound messages are validated by shape,
 * not by the sender's origin (which is `capacitor://localhost` on mobile), and
 * outbound messages echo no origin.
 */

interface PyProxy {
  destroy(): void;
}

interface PyGlobals {
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

interface PyodideInterface {
  runPythonAsync(code: string, options?: { globals?: PyProxy }): Promise<unknown>;
  loadPackagesFromImports(code: string): Promise<unknown>;
  loadPackage(names: string | readonly string[]): Promise<unknown>;
  toPy(value: unknown): PyProxy;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  globals: PyGlobals;
}

interface PyodideModule {
  loadPyodide(options: { indexURL: string }): Promise<PyodideInterface>;
}

// Runtime setup, run once after the interpreter loads:
//  - matplotlib is pinned to the Agg backend before the author imports it, so
//    figures render to a buffer with no DOM canvas the sandbox cannot provide.
//  - `input()` is replaced with a raise carrying the shared marker; interactive
//    stdin has no transport into the opaque frame, so the call fails fast and the
//    JS side classifies it as `input_unsupported`.
//  - two helpers return JSON strings (never PyProxies) so results cross into JS as
//    plain strings with no proxy lifetime to manage: the set of imported top-level
//    modules that are still missing (the micropip-fallback list), and the base64
//    PNGs of every open matplotlib figure.
const SETUP_SOURCE = `
import builtins, os
os.environ['MPLBACKEND'] = 'Agg'

def _hushbox_input(*args, **kwargs):
    raise RuntimeError('${INPUT_UNSUPPORTED_MARKER}')

builtins.input = _hushbox_input

def _hushbox_missing_imports_json(src):
    import json
    try:
        from pyodide.code import find_imports
        names = find_imports(src)
    except Exception:
        return json.dumps([])
    import importlib.util
    missing, seen = [], set()
    for name in names:
        top = name.split('.')[0]
        if top in seen:
            continue
        seen.add(top)
        try:
            found = importlib.util.find_spec(top) is not None
        except Exception:
            found = False
        if not found:
            missing.append(top)
    return json.dumps(missing)

def _hushbox_collect_figures_json():
    import json
    try:
        import matplotlib.pyplot as plt
    except Exception:
        return json.dumps([])
    import base64, io
    figures = []
    for num in plt.get_fignums():
        buffer = io.BytesIO()
        plt.figure(num).savefig(buffer, format='png')
        figures.append(base64.b64encode(buffer.getvalue()).decode('ascii'))
    plt.close('all')
    return json.dumps(figures)
`;

let pyodidePromise: Promise<PyodideInterface> | null = null;
/**
 * How long the interpreter has to load and install the document's packages
 * before the frame declares the run failed. The panel treats silence as "still
 * working", so a load that never finishes — a runtime asset request that hangs
 * rather than failing — would leave it waiting forever. Sized well above a cold
 * first load (interpreter, then package downloads, on a poor mobile connection),
 * because falsely failing a slow-but-working load costs more than a late error.
 *
 * Execution itself is deliberately not bounded: once `executing` is announced
 * the interpreter is alive and running the author's code, and a long computation
 * is not a hang — ending it is the parent's job, which owns the frame and tears
 * it down on Stop. A timer could not police it anyway, because Pyodide runs on
 * this frame's main thread and a spinning document blocks every callback here.
 */
const RUNTIME_LOAD_DEADLINE_MS = 60_000;

let pendingCode: string | null = null;
let currentRequestId = '';
let runSettled = false;
let loadDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

/** Post a typed message back to the embedding app. */
function post(message: FrameToParentMessage): void {
  // '*' on purpose: this opaque-origin frame cannot know its embedder's origin
  // (capacitor://localhost on mobile) and the payload carries nothing secret —
  // containment is the sandbox boundary, not an origin match.
  // eslint-disable-next-line sonarjs/post-message -- intentional '*' to an unknowable embedder origin; payload is non-secret
  parent.postMessage(message, '*');
}

/**
 * Post the one terminal message a run is allowed — `result` or `error` — and
 * mark the run finished. The app treats silence as "still working", so a run
 * that ends without either leaves the panel waiting forever; anything after the
 * first terminal message would contradict it.
 */
function settle(message: ResultMessage | ErrorMessage): void {
  if (runSettled || message.requestId !== currentRequestId) return;
  runSettled = true;
  clearTimeout(loadDeadlineTimer);
  post(message);
}

/** Extract human-readable text from an unknown thrown value. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** Route Pyodide's batched stdout/stderr to typed console messages. */
function installStreams(pyodide: PyodideInterface): void {
  pyodide.setStdout({
    batched: (text: string) => {
      post({ type: 'console', requestId: currentRequestId, stream: 'stdout', text });
    },
  });
  pyodide.setStderr({
    batched: (text: string) => {
      post({ type: 'console', requestId: currentRequestId, stream: 'stderr', text });
    },
  });
}

/** Lazy-load the pinned self-hosted Pyodide exactly once; announce the load. */
function ensureRuntime(requestId: string): Promise<PyodideInterface> {
  pyodidePromise ??= (async (): Promise<PyodideInterface> => {
    post({ type: 'loading', requestId, phase: 'loading-runtime' });
    const base = location.origin;
    // The loader is fetched from this same sandbox origin (self-hosted); nothing
    // is loaded from a public CDN at runtime. A runtime-computed specifier keeps
    // the bundler from trying to resolve it at build time.
    const module = (await import(`${base}/pyodide/pyodide.mjs`)) as PyodideModule;
    const pyodide = await module.loadPyodide({ indexURL: `${base}/pyodide/` });
    installStreams(pyodide);
    await pyodide.runPythonAsync(SETUP_SOURCE);
    return pyodide;
  })();
  return pyodidePromise;
}

/** Auto-load the document's imports: lock packages first, then micropip for PyPI. */
async function loadDocumentPackages(pyodide: PyodideInterface, code: string): Promise<void> {
  try {
    await pyodide.loadPackagesFromImports(code);
  } catch {
    // A detection-time failure (e.g. a syntax error the import scanner trips on)
    // must not preempt execution — the real error surfaces when the code runs.
  }
  pyodide.globals.set('_hushbox_src', code);
  let missing: string[];
  try {
    missing = JSON.parse(
      (await pyodide.runPythonAsync('_hushbox_missing_imports_json(_hushbox_src)')) as string
    ) as string[];
  } finally {
    pyodide.globals.delete('_hushbox_src');
  }
  if (missing.length === 0) return;
  // Pure-Python PyPI packages not in the Pyodide lock: micropip fetches them from
  // pypi.org + files.pythonhosted.org (the only hosts the sandbox connect-src
  // allows). The package list crosses into Python as JSON so there is no proxy.
  await pyodide.loadPackage('micropip');
  pyodide.globals.set('_hushbox_pkgs_json', JSON.stringify(missing));
  try {
    await pyodide.runPythonAsync(
      'import micropip as _hushbox_micropip, json as _hushbox_json\n' +
        'await _hushbox_micropip.install(_hushbox_json.loads(_hushbox_pkgs_json))'
    );
  } finally {
    pyodide.globals.delete('_hushbox_pkgs_json');
  }
}

/** Render every open matplotlib figure to a base64 PNG result output. */
async function collectFigureOutputs(
  pyodide: PyodideInterface
): Promise<{ type: 'image/png'; data: string }[]> {
  const figures = JSON.parse(
    (await pyodide.runPythonAsync('_hushbox_collect_figures_json()')) as string
  ) as string[];
  return figures.map((data) => ({ type: 'image/png', data }));
}

/** Execute the pending document's Python and report console, result, or error. */
async function execute(requestId: string): Promise<void> {
  currentRequestId = requestId;
  runSettled = false;
  loadDeadlineTimer = setTimeout(() => {
    settle({
      type: 'error',
      requestId,
      code: 'timed_out',
      message: `python runtime reported nothing within ${String(RUNTIME_LOAD_DEADLINE_MS)}ms`,
    });
  }, RUNTIME_LOAD_DEADLINE_MS);
  const code = pendingCode ?? '';
  let pyodide: PyodideInterface;
  try {
    pyodide = await ensureRuntime(requestId);
  } catch (error) {
    settle({ type: 'error', requestId, code: 'python_error', message: errorText(error) });
    return;
  }
  try {
    post({ type: 'loading', requestId, phase: 'loading-packages' });
    await loadDocumentPackages(pyodide, code);
    post({ type: 'loading', requestId, phase: 'executing' });
    clearTimeout(loadDeadlineTimer);
    // Fresh globals per run: each run executes in its own namespace, so nothing an
    // earlier run bound is visible to a later one.
    const globals = pyodide.toPy({});
    try {
      await pyodide.runPythonAsync(code, { globals });
    } finally {
      globals.destroy();
    }
    settle({ type: 'result', requestId, outputs: await collectFigureOutputs(pyodide) });
  } catch (error) {
    const message = errorText(error);
    settle({ type: 'error', requestId, code: classifyPythonError(message), message });
  }
}

/** Wire the message listener and announce readiness. */
export function startPythonRuntime(): void {
  // Shape-validated, never origin-checked: the embedder is capacitor://localhost
  // on mobile, so authentication is by message shape alone. This frame is opaque
  // and holds nothing worth spoofing into.
  // eslint-disable-next-line sonarjs/post-message -- shape-validated instead of origin-checked; embedder origin is unknowable
  window.addEventListener('message', (event: MessageEvent) => {
    const parsed = parseParentToFrameMessage(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    // Python requires an explicit Run: `init` only stashes the code, `run`
    // executes it. `stop` is handled by the parent tearing down the frame.
    if (message.type === 'init' && message.kind === 'python') {
      pendingCode = message.code;
      return;
    }
    if (message.type === 'run') {
      void execute(message.requestId);
    }
  });
  post({ type: 'ready' });
}

// Close the WebRTC egress channel before any document code can run. This classic
// bootstrap script executes before the author's Python (and any JS it could reach
// through Pyodide) evaluates, so the constructors are gone first.
neutralizeWebRtc();
startPythonRuntime();
