# T0 spike — in-browser code execution (throwaway)

Proves the one-codepath architecture on desktop Chromium AND the Android WebView
engine, before any real task. Disposable (G7). Results live in `../impl-report-1.md`
and the sibling `../result-*.json` / `../*.png` evidence files.

## Layout

- `app/index.html` — the "app" (parent) origin page. Embeds two cross-origin
  `sandbox="allow-scripts"` iframes (Leg A renderer, Leg B python), postMessages
  code in, records the result to `#spike-status`, and POSTs a JSON beacon to
  `/__result` (so the result is readable on the host — device → host via `adb reverse`).
- `sandbox/render.html` — Leg A. Import map → esm.sh, in-browser JSX transpile
  (Sucrase primary + Babel measured), imports npm (react, react-dom, canvas-confetti),
  mounts React. **Bootstrap is a classic script on purpose** (see comment inside).
- `sandbox/python.html` — Leg B. Loads self-hosted Pyodide **on the iframe main
  thread** (module worker is blocked in an opaque-origin sandbox — see report),
  runs numpy + matplotlib, returns a PNG.
- `sandbox/probe.html` + `probe-worker.mjs` — worker-capability probe (classic vs
  module vs same-URL worker) at a real origin vs the opaque sandbox.
- `sandbox/pyodide/` — self-hosted Pyodide 314.0.2 assets. **Stripped from the run
  record** to save ~26 MB; regenerate with `./fetch-pyodide.sh`.
- `serve.mjs` / `launch.mjs` — throwaway static servers (permissive CORS, wasm MIME).

## Run (desktop)

```
./fetch-pyodide.sh
node launch.mjs           # app :8190, sandbox :8191 (distinct ports = cross-origin)
# open http://127.0.0.1:8190/ in Chromium; wait for Overall: ALL-PASS
cat spike-result.json     # app-emitted beacon
```

## Run (Android emulator)

```
# boot budtmo/docker-android:emulator_14.0 (see impl report for the exact docker run)
adb reverse tcp:8190 tcp:8190 && adb reverse tcp:8191 tcp:8191
adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main \
  -a android.intent.action.VIEW -d "http://127.0.0.1:8190/"
# device loads via the reverse tunnel; beacon lands in spike-result.json on the host
```
