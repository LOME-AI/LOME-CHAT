// Pyodide worker (CLASSIC worker). Spawned as a blob worker by the sandboxed
// (opaque-origin) python.html. Loads self-hosted Pyodide via importScripts
// (UMD build) — NOT from any public CDN. Runs user code, streams stdout/stderr,
// returns matplotlib PNG output.
let pyodide = null;

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  const { requestId, code, base } = msg;
  const post = (m) => self.postMessage(m);
  try {
    const t0 = performance.now();
    if (!pyodide) {
      // loadPyodide is provided by pyodide.js, prepended into this blob by
      // python.html (fetched cross-origin via CORS). Avoids importScripts, which
      // fails for a cross-origin URL from a null-origin (blob) worker.
      post({ type: 'loading', requestId, phase: 'init-runtime' });
      // eslint-disable-next-line no-undef
      pyodide = await loadPyodide({ indexURL: `${base}/pyodide/` });
    }
    const loadMs = Math.round(performance.now() - t0);

    post({ type: 'loading', requestId, phase: 'load-packages' });
    // Auto-load numpy/matplotlib (+deps) from the self-hosted lock — the T3 path.
    await pyodide.loadPackagesFromImports(code);

    post({ type: 'loading', requestId, phase: 'execute' });
    // Fresh globals per run.
    const globals = pyodide.toPy({});
    let pngB64 = null;
    // Capture PNG_B64 stdout marker; stream everything else as console.
    pyodide.setStdout({
      batched: (s) => {
        const i = s.indexOf('PNG_B64:');
        if (i >= 0) pngB64 = s.slice(i + 'PNG_B64:'.length).trim();
        else post({ type: 'console', requestId, stream: 'stdout', text: s });
      },
    });
    pyodide.setStderr({ batched: (s) => post({ type: 'console', requestId, stream: 'stderr', text: s }) });

    await pyodide.runPythonAsync(code, { globals });
    globals.destroy();

    const outputs = [];
    if (pngB64) outputs.push({ type: 'image/png', data: pngB64 });
    post({ type: 'result', requestId, outputs, loadMs });
  } catch (e) {
    post({ type: 'error', requestId, code: 'python_error', message: (e && e.stack) || String(e) });
  }
};
