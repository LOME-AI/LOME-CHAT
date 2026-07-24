# Pyodide renderer design — decision material

Analyst research, 2026-07-23. Question: how should the Pyodide renderer (python documents
in the chat document panel, beside Sandpack) be designed? Founder decision already made:
Pyodide ships this run. This doc is the option space per design axis + a coherent
recommended design. Grades: **[V]** Verified (checked this session, source cited) ·
**[I]** Inferred · **[A]** Assumed.

## Version ground truth (2026)

- Pyodide switched to CPython-tracking version numbers: current release **314.0.2**
  (CPython 3.14), published 2026-06-30; npm `pyodide@314.0.2` is `latest`
  [V: `gh api repos/pyodide/pyodide/releases`; `npm view pyodide`].
- Core asset sizes at v314.0.2 (jsdelivr, measured this session): `pyodide.asm.wasm`
  **9.6 MB**, `python_stdlib.zip` 2.6 MB, `pyodide.asm.js` ~1 MB, `pyodide.mjs` +
  `pyodide-lock.json` small [V: `curl -w %{size_download}` against
  `cdn.jsdelivr.net/pyodide/v314.0.2/full/`]. Cloudflare Pages per-file limit is
  **25 MiB** [V: developers.cloudflare.com/pages/platform/limits] — every Pyodide core
  asset fits self-hosting with ~2.5× headroom.
- Built package distribution: **354 packages** including `numpy 2.4.3`, `pandas 3.0.2`,
  `matplotlib 3.10.8`, `micropip 0.11.1` [V: `pyodide-lock.json` v314.0.2].
- iOS: Pyodide 0.27.1–0.27.x was **broken on iOS** (Safari's faulty wasm-gc); fixed in
  0.28 [V: pyodide 0.28 changelog via search; issue pyodide/pyodide#5428]. 314.x
  presumed to retain the fix [I].

---

## Axis 1 — Execution host

The security question first, because it decides everything else.

**Does a plain worker share react-runner's host-realm flaw?** Substantially yes, in a
weakened form. Pyodide's `js` module exposes the **worker's global scope** to Python
code — untrusted LLM-generated Python can call any JS API the worker has [V: Pyodide FFI
docs; this is the documented bridge, not an escape]. A same-origin dedicated worker has
no DOM, but it has:
- `fetch` to our own origin **with credentials** → the iron-session cookie rides along;
  untrusted code could call our authenticated API as the user (mutations gated by
  `Idempotency-Key` are still callable — the client can mint keys).
- Same-origin **IndexedDB** → the non-extractable device CryptoKey (the E2E export-key
  store) cannot be exported but **can be used** to decrypt/sign from the worker [I: key
  non-extractability from memory of the device-key design; usability-from-same-origin is
  how WebCrypto works].
- Same-origin Cache/OPFS storage.

In a zero-knowledge product whose whole pitch is that plaintext and keys stay out of
reach, "untrusted code runs with the user's cookie and key handle" is disqualifying —
the same reason react-runner was rejected (research/package-landscape.md:97-103).
"Neuter the worker scope" (delete `fetch`/`indexedDB` before running user code) is a
denylist defense: Pyodide itself needs `fetch` for package loading, held references
survive deletion, and new APIs appear — fails No-Security-Through-Obscurity's spirit
(design, not patching).

### Options

- **1a. Plain same-origin dedicated worker** (open-webui pattern) — serves: simplicity,
  zero CSP change beyond `worker-src`. Violates: the security posture above. Rejected.
- **1b. Worker inside an opaque-origin sandboxed iframe** (`sandbox="allow-scripts"`,
  srcdoc, blob-URL worker) — strongest isolation on paper, but `new Worker(sameOriginUrl)`
  throws SecurityError from origin `null`, and the blob-worker workaround is **blocked by
  Safari** (mixed-content/trustworthiness check on `blob://null/...`) [V: search —
  Chrome loads blob workers non-secure-context, Safari refuses; bugzilla #1260388 and
  w3c/webappsec-mixed-content#41]. Safari/WKWebView is our entire iOS story → dead on
  mobile. Rejected as the primary mechanism.
- **1c. Dedicated real sandbox origin** — a tiny static host page + worker script served
  from a separate origin (e.g. `pysandbox.hushbox.ai`, an assets-only Worker exactly like
  the admin SPA precedent [V: ARCHITECTURE.md §Hosting]), embedded as a cross-origin
  `<iframe sandbox="allow-scripts allow-same-origin">`. `allow-same-origin` here grants
  the iframe *its own* origin (not ours) — the MDN sandbox-escape warning applies only
  when the framed document is same-origin with the embedder [V: search, MDN via
  discourse]. Workers are then plain same-origin workers *of the sandbox origin*: work in
  every browser incl. Safari. The sandbox origin has no cookies, no keys, no app storage;
  its own `_headers` CSP confines network to Pyodide assets + PyPI. Parent↔iframe talk
  over `postMessage` with origin checks. This exactly parallels the Sandpack
  self-hosted-bundler decision (separate first-party static origin, one `frame-src`
  entry) [V: research/package-landscape.md:35-42,139-152].
- **1d. Main thread** — blocks the UI for the whole run; no interrupt at all; freezes
  screen readers and the accessibility widget. Violates accessibility + DX. Rejected.

**Judgment**: 1c serves security (untrusted code confined to a cookie-less, key-less
origin), local parity (static assets, servable by the local stack), serverless/cost
(static files, zero compute), minimal lock-in (plain web platform). Its costs: one more
deploy target + `frame-src https://pysandbox.hushbox.ai` in the generated app CSP
(scripts/generate-headers.ts — generated, never hand-edited [V:
research/codebase-integration.md §4]) + a `postMessage` protocol. That protocol is
needed for a worker anyway (1a needs the same message shapes) — the iframe hop adds one
relay, not a new protocol.

---

## Axis 2 — Loading the runtime

- **2a. Public CDN (jsdelivr)** — zero hosting work; but third-party availability
  dependency, no local-dev parity (offline dev breaks), version drift risk, and the
  sandbox page's CSP must allow the CDN. Violates local parity + minimal external
  dependence; the Sandpack call already rejected the analogous hosted bundler.
- **2b. npm `pyodide` package bundled into the app build** — puts 13+ MB into the app
  origin's assets and (worse) back into our origin for execution unless combined with 1c
  anyway; also entangles Vite chunking with `.whl`/`.zip` assets. No advantage over 2c
  once a sandbox origin exists.
- **2c. Self-host on the sandbox origin, version-pinned** — copy the needed subset of the
  npm package (or the release tarball's runtime files) into the sandbox origin's static
  build: `pyodide.mjs`, `pyodide.asm.js`, `pyodide.asm.wasm` (9.6 MB < 25 MiB ✓ [V]),
  `python_stdlib.zip`, `pyodide-lock.json`, plus a **curated wheel set** (numpy, pandas,
  matplotlib + deps — order tens of MB total, each wheel well under 25 MiB [I: wheel
  sizes from lock-file scale; verify at implementation]). Long-tail packages come from
  PyPI at runtime (Axis 4). Immutable-cached (`Cache-Control: immutable`, versioned
  path) so the 12 MB first-load happens once per version.

**Lazy-load UX**: nothing loads until a python document is opened *and* the user hits
Run (explicit run button, never auto-execute LLM code — security + surprise-cost).
First run shows a determinate "loading Python runtime (~12 MB)" progress state; the
iframe itself mounts lazily like the panel already does (`React.lazy` precedent,
chat-layout.tsx:52-54 [V: research/codebase-integration.md]). Auto-executing untrusted
code on document-open is rejected outright.

**Judgment**: 2c. Serves local parity, cost (static bytes on CF, ~free), fail-fast
(pinned version = no surprise upstream breakage), and mirrors the Sandpack stance so the
two renderers have one hosting doctrine.

---

## Axis 3 — Output rendering

- **stdout/stderr**: `loadPyodide({ stdout, stderr })` line callbacks (or
  `pyodide.setStdout({batched})`) → `postMessage` line events → panel renders an
  append-only console region. Accessibility: the console is a `role="log"`/`aria-live`
  region; monospace via Tailwind classes only [V: repo lint rules ban inline styles].
- **Result value**: `repr()` of the final expression (Jupyter convention), shown after
  stdout.
- **Tracebacks**: `PythonError.message` contains the Python traceback; strip the Pyodide
  eval-frame noise above the user's `<exec>` frames and render in the stderr style.
  Expected failures are values, not Sentry events — client-side has no Sentry anyway
  [V: ARCHITECTURE.md deliberate limits].
- **matplotlib**: in a worker there is no DOM, so the default `matplotlib-pyodide` HTML5
  backend is unusable; set `MPLBACKEND=agg` before first import and monkeypatch
  `plt.show()` to `savefig(BytesIO, format='png')` → transfer PNG bytes →
  `blob:`/data URL rendered through the repo's `<Img>` wrapper (alt text required —
  "Figure N from Python output"; genuinely better than most: the a11y rule forces alt
  text on generated figures) [I: standard Pyodide-in-worker pattern (JupyterLite,
  open-webui); agg backend availability in the matplotlib 3.10.8 wheel assumed [A],
  verify at implementation].
- **pandas DataFrames**: two options — (i) plain-text `repr` (safe, ugly), (ii)
  `_repr_html_()` rendered as HTML. Raw HTML from code that consumed LLM output is an
  injection vector into the app origin; if (ii) ships it must render **inside the
  sandbox iframe** (which already owns an untrusted-content origin) or be
  DOMPurify-sanitized. Recommend (i) text-first at launch, (ii) as a follow-up inside
  the iframe — Simplicity First.
- **Interrupt / long-running code**: `SharedArrayBuffer` + `setInterruptBuffer` is the
  official mechanism but requires cross-origin isolation (top-level COOP/COEP) [V:
  pyodide keyboard-interrupts doc via search] — the exact app-wide tax already rejected
  for WebContainers [V: package-landscape.md:59-64]. An `<iframe>` cannot become
  cross-origin-isolated unless the top-level document is. **Without SAB the one interrupt
  mechanism is `worker.terminate()`** [V: pyodide discussion #4047 + community
  consensus]. Design it as the *first-class* Stop: terminate the worker, mark the run
  "stopped", next Run boots fresh. One mechanism, made recoverable — no second
  cooperative-interrupt path. A soft watchdog (e.g. 30 s) surfaces a "Still running — 
  Stop?" affordance rather than auto-killing (user may want long compute).
- **`input()`**: cannot block a worker without SAB. Fail fast: stub `input` to raise
  `RuntimeError("input() is not supported in HushBox's Python runner")` with the message
  surfaced in stderr. A prompt-bridge is impossible synchronously and a fake-async
  rewrite of user code is a correctness lie. (Re-entry: if COOP/COEP ever lands for
  another reason, both SAB-interrupt and blocking `input()` unlock together.)

---

## Axis 4 — Packages / micropip

- **4a. Explicit requirements** (user edits a manifest) — wrong UX for chat; the code is
  LLM-authored and the user just clicks Run.
- **4b. Auto-resolve (recommended)**: after parsing, call
  `pyodide.loadPackagesFromImports(code)` — resolves imports against the 354-package
  built distribution [V: package present-set from lock file; API long-stable [I]] — then
  for still-missing imports run `micropip.install` (open-webui pattern). Failures render
  as a clear stderr line ("package X is not available in the browser runtime"), never a
  silent skip — fail-fast.
- **Network/CSP**: micropip hits `pypi.org` (JSON API) and `files.pythonhosted.org`
  (wheels, CORS-enabled today) [V: micropip docs via search]; built packages come from
  our self-hosted wheel set (2c) or `cdn.jsdelivr.net` for non-curated ones. Because
  execution lives on the **sandbox origin (1c), these hosts go in the sandbox origin's
  own CSP `connect-src` — the app's generated CSP is untouched** except the one
  `frame-src` entry. This containment is a major point for 1c: PyPI allowlisting never
  widens the app's own policy next to plaintext messages.
- C-extension long tail: micropip installs only pure-Python or Pyodide-built wasm wheels
  [V: micropip docs] — arbitrary native deps will fail; the stderr message must say so
  plainly.

---

## Axis 5 — Re-run semantics & memory

Facts: Pyodide has **no dispose/destroy API**; the only way to reclaim its memory is to
terminate the worker [I: no such API exists in current docs; community answer of record].
So worker termination is simultaneously the interrupt (Axis 3), the reset, and the
memory-reclaim mechanism — one mechanism, three duties.

- **5a. Fresh worker per run** — perfectly deterministic, idempotent re-runs; but
  re-boots the interpreter (~1–3 s from HTTP cache, more on mobile) and re-installs
  packages every run. Sluggish iterate-on-code UX.
- **5b. Persistent interpreter, accumulate state** — REPL-like, fast; but re-running an
  edited document against mutated module state gives different results run-to-run —
  violates the idempotency instinct and confuses users.
- **5c. Warm worker, fresh namespace per run (recommended)** — keep one worker per open
  python document; each Run executes with a fresh `globals` dict
  (`pyodide.runPythonAsync(code, { globals: pyodide.toPy({}) })`) + `plt.close('all')`
  and stdout reset between runs. Terminate the worker on: Stop, panel close, document
  switch, and page hide on mobile (memory pressure). Not perfect isolation (module-level
  monkeypatching survives) [I], but the escape hatch is the same single mechanism:
  terminate + fresh boot, exposed as a "Restart runtime" affordance if ever needed.

---

## Axis 6 — Mobile (Capacitor)

- WKWebView WebContent process has a hard jetsam ceiling (~2 GB "ActiveHard" on iPhone,
  higher on iPad) regardless of device RAM [V: Apple dev-forum reports via search].
  Pyodide + numpy/pandas fits comfortably for typical snippets [I], but pathological
  allocations kill the WebContent process — which in Capacitor is **the whole app UI**,
  not just the sandbox iframe (iframes share the WebContent process) [I]. Mitigations:
  aggressive worker termination (5c), and accepting that an OOM kill is a crash-fast
  event, not a degraded mode.
- iOS wasm-gc breakage is fixed as of 0.28; ship ≥314.x and never pin into the 0.27
  range [V: changelog via search].
- The sandbox origin is remote HTTPS, so the iframe + worker + wasm fetch all work
  identically under `capacitor://` app scheme (cross-origin iframe to a real HTTPS
  origin) [I — flagged as an on-device verification item, same as the existing
  Capacitor-CSP gap noted in codebase-integration.md §4].
- Android WebView: no known Pyodide blocker [A]; verify on device.

---

## Recommended coherent design

**A `python` document type dispatching (via the same renderer seam as Sandpack) to a
run-panel whose execution host is a version-pinned, self-hosted Pyodide 314.x on a
dedicated first-party sandbox origin (`pysandbox.hushbox.ai`, assets-only Worker),
embedded as a cross-origin sandboxed iframe, running Pyodide in a worker inside that
iframe.** Explicit Run button (never auto-exec), lazy first load with progress; stdout/
stderr line-streamed to an aria-live console; matplotlib via agg→PNG→`<Img>`;
DataFrames as text at launch; `loadPackagesFromImports` + micropip auto-install with
PyPI allowlisted only in the sandbox origin's CSP; warm worker + fresh-globals per run;
`worker.terminate()` as the single stop/reset/reclaim mechanism; `input()` fails fast
with a clear message. Rendered↔raw toggle generalizes the existing mermaid-only
`supportsRawToggle` (document-panel.tsx:283) [V: codebase-integration.md §1].

Why it wins on values: unbreakable-by-design security boundary (origin, not denylist)
next to a zero-knowledge crypto product; serverless + ~zero cost (static assets); local
parity (self-hosted, pinned); one-mechanism recoverability (terminate); fail-fast
(explicit errors for input()/missing packages/OOM); accessibility (live-region console,
alt-texted figures, no main-thread blocking). What would change the call: if standing up
the second origin is ruled too heavy for this run, the *only* acceptable fallback is 1b
(opaque iframe + blob worker) **with iOS explicitly cut** — never 1a; if Safari ships
blob-worker support, 1b becomes competitive again.

## Rejected options

- **Plain same-origin worker (1a)** — untrusted code gets credentialed fetch to our API
  and use-access to the IndexedDB device key; the react-runner disqualifier survives in
  worker form. Security disqualifier.
- **Opaque sandboxed iframe + blob worker (1b)** — Safari blocks blob workers from
  opaque origins → no iOS. Platform disqualifier (kept as documented fallback with iOS
  cut).
- **Main-thread execution (1d)** — UI freeze, no stop at all; accessibility violation.
- **Public-CDN loading (2a)** — third-party availability + no local parity; contradicts
  the Sandpack self-host doctrine.
- **COOP/COEP for SAB interrupts** — app-wide cross-origin-isolation tax already
  rejected in the Sandpack/WebContainers analysis; terminate() covers Stop.
- **Auto-execute on document open** — running untrusted code without a user gesture.
- **Persistent accumulate-state interpreter (5b)** — non-deterministic re-runs.
- **HTML DataFrame rendering in the app origin at launch** — injection surface;
  deferred into the sandbox iframe if wanted.

## Raised / for the decision-maker

1. **New deploy target**: the sandbox origin (assets-only Worker + DNS + generated
   `_headers` for it) is new infrastructure — an agent "Cannot Decide" item
   [V: AGENT-RULES.md]; this design needs founder sign-off on the origin.
2. **Shared seam with Sandpack**: the type→renderer dispatch and the raw/rendered
   toggle generalization must be built once and shared by both renderers (One
   Implementation, Shared) — coordinate the two workstreams on that seam.
3. **`pnpm add pyodide`** (or vendored release assets) — Must-Ask-Approval item.
4. On-device verification items: Capacitor iframe/worker behavior, agg backend in the
   matplotlib wheel, curated-wheel-set total size, Android WebView.

## Sources

- Pyodide releases/assets: github.com/pyodide/pyodide/releases (gh api, 2026-07-23);
  cdn.jsdelivr.net/pyodide/v314.0.2/full/ (measured); npm registry (`npm view pyodide`).
- Interrupts: pyodide.org/en/stable/usage/keyboard-interrupts.html;
  github.com/pyodide/pyodide/discussions/4047.
- micropip/PyPI: micropip.pyodide.org (usage/api docs);
  pyodide.org/en/stable/usage/loading-packages.html.
- Sandboxed-iframe workers: bugzilla.mozilla.org #1260388;
  github.com/w3c/webappsec-mixed-content/issues/41 (Safari blob-worker refusal).
- iOS: github.com/pyodide/pyodide/issues/5428; Pyodide 0.28 changelog; Apple dev forums
  (WebContent ActiveHard 2048 MB jetsam reports).
- Cloudflare Pages 25 MiB/file: developers.cloudflare.com/pages/platform/limits.
- Repo: research/codebase-integration.md; research/package-landscape.md;
  scripts/generate-headers.ts:137; apps/web/src/components/document-panel/document-panel.tsx.
