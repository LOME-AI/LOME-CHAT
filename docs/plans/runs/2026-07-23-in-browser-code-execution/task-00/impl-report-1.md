# T0 — Vertical-slice spike (gate) · impl-report-1

## Objective

Definitively prove the one-codepath in-browser code-execution architecture runs on
BOTH desktop Chromium and the Android WebView engine, before any real task is built.
Go/no-go gate for the whole run. Two legs on two surfaces:

- Leg A — cross-origin `sandbox="allow-scripts"` iframe: import map → esm.sh, in-browser
  JSX transpile, real npm import, React mount.
- Leg B — self-hosted (not CDN) Pyodide 314.x: numpy compute + matplotlib Agg→PNG,
  round-tripped out of the sandbox iframe.

## Verdict

**GO.** All four cells PASS. No leg is structurally blocked on Android.

| | Leg A (web renderer) | Leg B (Python/Pyodide) |
|---|---|---|
| **Desktop Chromium** (HeadlessChrome/150) | **PASS** | **PASS** |
| **Android 14 / WebView 113** (Chrome 113 == System WebView 113) | **PASS** | **PASS** |

Two load-bearing findings forced design changes vs. the plan (both solved in-spike, both
are required amendments for T2/T3 — see Concerns). Neither is a block.

## What was built (throwaway, in `task-00/spike/`)

- `serve.mjs` / `launch.mjs` — throwaway static servers; permissive CORS, `application/wasm`
  MIME, template-injects the sandbox origin into the app page (no hard-coded port), and a
  `POST /__result` beacon sink.
- `app/index.html` — parent "app" origin (`:8190`). Embeds two cross-origin
  `sandbox="allow-scripts"` (NO `allow-same-origin`) iframes, postMessages code in per the
  plan's bridge shapes, records `#spike-status`, and POSTs a full-result JSON beacon.
- `sandbox/render.html` — Leg A on the sandbox origin (`:8191`).
- `sandbox/python.html` + `pyodide-worker.js` — Leg B.
- `sandbox/probe.html` + `probe-worker.mjs` — worker-capability probe.
- `sandbox/pyodide/` — self-hosted Pyodide 314.0.2 core + numpy/matplotlib wheels (26 MB,
  **stripped** from the run record; `fetch-pyodide.sh` regenerates it).

Two distinct ports = two origins = genuine cross-origin. `sandbox="allow-scripts"` with no
`allow-same-origin` gives the iframe an **opaque origin** — the exact security posture (G3)
under test.

## Acceptance criteria

- **React render on desktop Chromium — MET.** `result-desktop-chromium.json`: `render:"PASS"`,
  `transpiler:"sucrase (3ms)"`, mounted text "React 19.1.0 rendered + confetti loaded: function".
  React 19.1.0 + react-dom + canvas-confetti imported from esm.sh, JSX transpiled in-browser.
- **React render on Android WebView — MET.** `result-android-chrome113.json` (UA `Android 14 …
  Chrome/113.0.0.0`): `render:"PASS"`, `sucrase (4ms)`. `android-chrome113-all-pass.png` shows
  the mounted component inside the sandboxed iframe.
- **Pyodide numpy result + PNG on desktop — MET.** `python:"PASS"`, console `numpy sum = 105`,
  PNG 11458 bytes, signature `137,80,78,71` (‰PNG). Decoded to `desktop-matplotlib.png`.
- **Pyodide numpy result + PNG on Android — MET.** `python:"PASS"`, PNG 11458 bytes, valid
  signature. Self-hosted assets served over the `adb reverse` tunnel (never a public CDN).
- **Worker spawn from iframe on Android — MET (with a caveat that changes the design).**
  Worker capability was fully characterised (`probe.html`): a **classic** worker spawns fine
  from the opaque-origin sandbox; a **module** worker from a `blob:null` URL does NOT (fails
  instantly, empty error) — while ALL worker types work at a real origin. Pyodide 314 *requires*
  a module worker (classic is explicitly rejected: "Classic web workers are not supported").
  Resolution: Pyodide runs on the **iframe main thread** (no worker); "stop" becomes the parent
  tearing down the iframe. Leg B passes on both surfaces this way. (See Concerns → T3.)
- **Pyodide load time + memory noted — MET.** Below.

## Measurements

**Pyodide (314.0.2), self-hosted:**
- Runtime init (`loadPyodide`, import loader + init): ~2.0 s both surfaces (desktop 2012 ms,
  Android 2023 ms). Similar because assets are served from localhost (adb-reverse tunnel);
  real-world remote-CDN + slower-CPU cold load will be higher and network-bound.
- Full first run to matplotlib PNG (init + numpy/matplotlib wheel load ~10 MB + exec):
  ~10–12 s wall on the emulator. numpy compute correct (`sum=105`), matplotlib Agg PNG valid.
- Android memory after the run: `com.android.chrome` PSS ~91 MB / RSS ~257 MB (whole app,
  `dumpsys meminfo`); device MemAvailable stayed ~1.85 GB of 4 GB — no pressure, no OOM.
  Caveat: the site-isolated iframe renderer may be a separate process; low-RAM (2–3 GB)
  phones under pressure remain the plan's accepted MEDIUM risk (this emulator is 4 GB).

**Transpiler — Sucrase vs Babel-standalone (for T2's decision):**
| | Sucrase 3.35.0 | Babel-standalone 7.26.4 |
|---|---|---|
| esm.sh resolved chunk | **40 KB gzip / 180 KB raw** | 637 KB gzip / 2902 KB raw (~16×) |
| transpile time (this JSX snippet) | **2.5–4 ms** | 9.5–16 ms (~4×) |
| works desktop + Android 113 | yes | yes |

**Recommendation: Sucrase** — 16× smaller, ~4× faster, works on both surfaces. Both were
exercised live; Babel is a viable fallback only if a syntax-coverage gap surfaces.

## Self-gate

None. T0 is the explicit G7 TDD/coverage exemption (exploratory, throwaway). No production
paths touched; all writes confined to `task-00/` (BOUNDS honoured).

## Surfaces & how they were driven

- **Desktop Chromium** — Playwright MCP (Chromium 150). Navigated the app page, waited for
  `ALL-PASS`, read the DOM and the beacon JSON, saved `desktop-chromium-all-pass.png` +
  decoded the returned PNG.
- **Android** — `budtmo/docker-android:emulator_14.0` (Android 14; System WebView
  **113.0.5672.136**; Chrome is the same 113 build). Booted the container (KVM), `adb reverse`
  8190/8191 so the device loopback reaches the host servers, launched the page in Chrome, and
  read the app-emitted beacon on the host (device→host, no DOM scraping). `android-chrome113-
  all-pass.png` is the on-device screenshot. Chrome 113 IS the same Chromium build as the
  System WebView Capacitor uses on this image, so it faithfully exercises the Capacitor engine.

## Deviations from the plan

1. **Leg B uses main-thread Pyodide, not a worker.** The plan (T3) specifies a Pyodide *worker*
   spawned by the iframe with `stop = worker.terminate()`. Empirically a module worker (which
   Pyodide 314 mandates) cannot be created from a `blob:null` URL in an opaque-origin sandbox
   (G3's `allow-scripts`-only posture). Main-thread Pyodide is the working path; stop becomes
   parent-side iframe teardown. Reported below for T3.
2. **Android proven via Chrome 113 (== System WebView 113), not the Capacitor app shell.** BOUNDS
   forbid touching `apps/web`, so I could not build the real Capacitor APK with the spike page.
   Chrome 113 is the identical Chromium engine; the `capacitor://localhost`-parent → https-iframe
   embedding is unproven-by-test (low risk; T1/T9). See Concerns.
3. **Bridge shapes followed loosely** (added `diag`/`measure` for the spike). The plan's typed
   contract is T2/G5's job.

## Concerns & limitations (carry-forward for T1/T2/T3/T6/T9)

- **[T3 — design change, RAISED] Pyodide runs on the iframe main thread; no worker.** Module
  workers are unspawnable from the opaque sandbox; Pyodide 314 refuses classic workers.
  Consequence: `stop` = parent removes/reloads the sandbox iframe (parent owns the element and
  can tear down even a main-thread-spinning frame) — replaces `worker.terminate()`. `research/
  pyodide-renderer-design.md` (recommended design 1c, worker+terminate) needs revisiting.
  This does not fork web vs mobile — the main-thread path is one codepath on both (G1 intact).
- **[T2 — hard requirement, RAISED] Import map must be present before ANY module load.** Android
  WebView/Chrome 113 IGNORES an import map injected after the page's own inline `type="module"`
  ran ("import map added after module load") → bare `react` fails to resolve. Newer Chromium 150
  tolerated it, masking the bug on desktop. Fix proven in-spike: the renderer bootstrap is a
  **classic** script (no early module load) and injects the import map before the first dynamic
  `import()`. T2's real renderer must guarantee this ordering or it breaks on real Android WebViews.
- **[worker/CORS gotchas, for T3/T6] documented in-spike:** (a) module-worker-from-blob blocked in
  opaque origin (above); (b) `importScripts` of a cross-origin URL from a null-origin worker fails
  with NetworkError even with `ACAO:*` — so Pyodide's UMD loader can't be pulled via importScripts
  from such a worker (moot now that Leg B is main-thread; relevant if a worker is ever reintroduced);
  (c) cross-origin `fetch`/dynamic-`import()` with CORS from the opaque frame works fine (esm.sh,
  self-hosted wasm/wheels). Sandbox origin must send permissive CORS + `application/wasm` (T1/T6).
- **[T1/T9 — unproven-by-test] Capacitor app-shell embedding.** The spike parent was
  `http://127.0.0.1:8190`, not `capacitor://localhost`. Embedding an https cross-origin sandbox
  iframe inside the `capacitor://localhost` shell (frame-src CSP + cross-scheme) is standard WebView
  behaviour (Inferred low risk) but is not test-proven. It belongs to T1's integration and T9's
  Maestro flow. The app-DOM marker pattern A4 wants is demonstrated by `#spike-status`
  (flips to `ALL-PASS`/`FAIL` on bridge terminal) — T4's `document-render-status` is the real one.
- **[T9 — mechanism note] Maestro `androidWebViewHierarchy: devtools` needs a debuggable app.**
  I read results via an app-emitted HTTP beacon (stronger than DOM scraping and surface-agnostic)
  rather than Maestro, because Chrome-stable's renderer isn't reliably devtools-inspectable. T9's
  flow must run against the debuggable HushBox APK's WebView to read the marker — same as the
  existing `03-webview-renders` flow. The functional result is already proven here.
- **WebView version skew.** The emulator ships WebView 113 (mid-2023). Real Android devices auto-update
  the System WebView to current; 113 is a conservative floor and it passed. Import maps, dynamic
  import, wasm, and Pyodide all work on 113 given the classic-bootstrap fix.
- **esm.sh / self-host.** esm.sh served react/react-dom/canvas-confetti/sucrase/babel fine (runtime
  third-party dep, plan-accepted). Pyodide + wheels were genuinely self-hosted (R1) and worked.

## Confidence

**High** that the architecture runs on both surfaces — every cell passed with concrete artifacts
(beacon JSON with valid PNG bytes + on-device screenshot). **Medium** specifically on the
untested `capacitor://` app-shell embedding and on Pyodide memory headroom on low-RAM devices —
both are pre-existing plan-accepted risks, not spike regressions.
