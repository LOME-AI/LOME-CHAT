# T3 — Pyodide runtime (`/python.html`) — impl report 1

## Objective

Stand up `/python.html`: pinned self-hosted Pyodide 314.x running on the iframe MAIN
THREAD (not a worker). On `run`: lazy-load Pyodide (emit `loading` phases), execute the
document's Python, stream stdout/stderr as `console`, return matplotlib figures as
`image/png` `result` outputs (Agg), surface tracebacks as typed `error`, auto-load imports
(`loadPackagesFromImports` + micropip fallback), `input()` fails fast typed, fresh globals
per run. Consume the bridge from `@hushbox/shared/documents`.

## Files changed

- `apps/sandbox/src/python/bootstrap.ts` (new) — the browser runtime that runs inside the
  sandbox iframe: message routing, lazy Pyodide load (main-thread), package auto-load +
  micropip fallback, execution with fresh globals, stdout/stderr streaming, figure→PNG
  collection, typed error/result emission. Browser-only entry (excluded from coverage,
  proven by the browser integration tests).
- `apps/sandbox/src/python/error-classification.ts` (new) — pure helper
  `classifyPythonError(text)` + shared `INPUT_UNSUPPORTED_MARKER`; the single source of the
  input-sentinel used by both the Python preamble and the JS classifier.
- `apps/sandbox/src/python/error-classification.test.ts` (new) — unit tests (covered).
- `apps/sandbox/src/python/build-python-bundle.ts` (new) — esbuild IIFE bundler →
  `public/python.js` (mirrors `render/build-bundle.ts`).
- `apps/sandbox/src/python/build-python-bundle.test.ts` (new) — drift test + A9
  bundle-content assertion (no backend env-var names / `to:["backend"]`).
- `apps/sandbox/src/python/browser-harness.ts` (new) — test-only harness: serves committed
  `public/` under the production sandbox CSP + drives Playwright. Excluded from coverage as
  test infrastructure.
- `apps/sandbox/src/python/python-core.browser.test.ts` (new) — print, phases (fresh page),
  numpy, traceback, input fail-fast, fresh globals, no-page-errors.
- `apps/sandbox/src/python/python-figures.browser.test.ts` (new) — matplotlib Agg → PNG.
- `apps/sandbox/src/python/python-micropip.browser.test.ts` (new) — micropip install of a
  pure-Python PyPI package (`cowsay`) not in the Pyodide lock.
- `apps/sandbox/public/python.html` (modified) — stub → loads `/python.js` classic script.
- `apps/sandbox/public/python.js` (new, committed generated bundle).
- `apps/sandbox/scripts/fetch-pyodide.sh` (modified) — completed the wheel closure of
  numpy+matplotlib+micropip (added kiwisolver, pillow, packaging, pyparsing, dateutil,
  pytz, micropip — exact lock filenames). Verified complete against `pyodide-lock.json`.
- `apps/sandbox/package.json` (modified) — added `build:python` script (parity with
  `build:render`).
- `apps/sandbox/eslint.config.js` (modified) — added `public/python.js` to ignores (build
  output; without it ESLint's formatter crashes on the 331 KB minified line).
- `apps/sandbox/vitest.config.ts` (modified) — added `src/python/bootstrap.ts` and
  `src/python/browser-harness.ts` to the coverage exclude (browser entry + test infra,
  mirroring the existing `render/bootstrap.ts` exclusion).

## Tests added (name — behavior — criterion)

- `classifyPythonError` × 4 — marker→`input_unsupported`, ordinary/empty→`python_error` —
  typed input error + traceback classification.
- Python bundle × 4 — IIFE shape, drift-in-sync, rewrite, **A9 no-backend-env** — durable
  A9 pin.
- python-core × 7 — print round-trip (`console` stdout + `result`); **loading phases**
  (`loading-runtime`/`loading-packages`/`executing` on a fresh page); numpy compute;
  traceback→`python_error`; `input()`→`input_unsupported` fail-fast; **fresh globals per
  run** (name bound in run 1 absent in run 2 → NameError); no uncaught page errors.
- python-figures × 1 — matplotlib → single `image/png` output, base64 begins `iVBORw0KGgo`.
- python-micropip × 1 — imports `cowsay` (absent from lock) → micropip installs from PyPI →
  runs clean.

TDD: `error-classification` written test-first (watched RED: module missing → GREEN). The
browser orchestration was driven by `python-core.browser.test.ts` — watched RED (stub page
never posts `ready`, `beforeAll` timeout) before implementing `bootstrap.ts` → GREEN.
Figures/micropip watched RED (`ModuleNotFoundError: packaging`/`micropip` — incomplete wheel
closure) → GREEN after completing the closure.

## Self-gate

- `pnpm test` (sandbox, coverage gate perFile 95) — **pass**, 15 files / 106 tests;
  package coverage 100% (111/111 stmts, 60/60 branch, 23/23 func, 107/107 lines). No pole
  (heaviest browser file ~3.3s ≪ 15s).
- `turbo typecheck lint --filter=@hushbox/sandbox` — **pass** (typecheck clean; lint clean
  after fixing real rule violations + the `public/python.js` ignore).
- `npx eslint src/python public/python.html` (package dir, after LAST edit) — **exit 0**;
  full package `eslint .` — **exit 0**.
- `jscpd --threshold 2 apps/sandbox/src/python` — **0 clones**.

## Acceptance criteria

- print round-trip — **met** (python-core: stdout console + result).
- numpy compute — **met** (`sum(arange(15))==105`).
- matplotlib PNG (Agg) — **met** (figures test; `MPLBACKEND=Agg` set in preamble before
  import; figures savefig'd to base64 PNG).
- micropip install of a pure-Python PyPI package — **met** (`cowsay`, live PyPI, under CSP).
- traceback → typed `error` — **met** (`python_error` with traceback in `message`).
- `input()` fails fast typed — **met** (`builtins.input` overridden to raise the shared
  marker; classified `input_unsupported`; no `result` emitted).
- fresh globals per run — **met** (`toPy({})` per run; run-2 cannot see run-1 binding).
- loading phases emitted — **met** (`loading-runtime` first-load, `loading-packages`,
  `executing`).
- main-thread, no worker; stop = parent teardown — **met** (Pyodide loaded via main-thread
  dynamic `import()`; no worker; page never self-interrupts; fresh page = fresh interpreter;
  no state escapes the frame). The teardown-kills-a-spinning-run assertion is T4's.
- bridge consumed from `@hushbox/shared/documents` narrow subpath (A9) — **met**; A9
  bundle-content assertion green.

## T6 reconcile verdict — CLOSED, NO CHANGE NEEDED

The committed browser tests serve `/python.html` under T6's exact strict CSP
(`script-src 'self' 'wasm-unsafe-eval' blob: https://esm.sh` — `'unsafe-eval'` ABSENT;
`connect-src 'self' https://pypi.org https://files.pythonhosted.org`) and all pass:
Pyodide 314 loads, numpy computes, matplotlib renders a PNG, and micropip installs from
PyPI — all under that policy.

Additionally probed under a fuller production-shaped CSP
(`default-src 'none'; worker-src 'none'; img-src 'none'` + the two named directives):
numpy + matplotlib + micropip all ran with **ZERO CSP violations / page errors**. This
proves (a) Pyodide needs no `'unsafe-eval'` (wasm instantiation is covered by
`'wasm-unsafe-eval'`), and (b) micropip reaches ONLY `pypi.org` + `files.pythonhosted.org`
— no other host (any other would have raised a connect-src violation, and none did).

**Verdict: everything works under the strict CSP as-is. No `script-src`/`connect-src`
change required from T6.**

## Bridge-enum gap

None. `loading-runtime`/`loading-packages`/`executing` and `python_error`/`input_unsupported`
all already exist in the closed `LoadingPhase`/`DocumentErrorCode` enums. No T2 bridge change
needed.

## Carry-forward for T4

- **Python drive protocol:** parent sends `init {kind:'python', code, requestId}` to stash
  the code (does NOT execute — R10 explicit Run), then `run {requestId}` to execute.
  Terminal success = `result {requestId, outputs}` (`image/png` figures, possibly empty
  `[]`); failure = `error {requestId, code, message}`. `console {stream, text}` streams
  during the run. Python's success terminal is `result`, NOT `rendered`.
- **Loading phases:** `loading-runtime` fires only on the first (actual) interpreter load;
  `loading-packages` and `executing` fire every run.
- **Stop:** parent removes/reloads the iframe element; the page is main-thread and does not
  self-interrupt. A fresh page load is a fresh interpreter (fresh globals per run within one
  page).
- **Console streaming caveat (A7):** during a long synchronous run the main thread is
  blocked, so console messages may not paint live — teardown is the responsiveness escape.
- **`input_unsupported`** is the error code the panel should map for `input()` calls.

## Deviations

- `python.html` no longer references `/config.js` — the Python runtime derives its base from
  `location.origin` and needs no `esmCdnUrl` (the web renderer's config seam). Minimal and
  in-scope.

## Concerns / limitations (RAISED)

- **CI determinism — micropip hits live PyPI.** The micropip integration test reaches
  `pypi.org` + `files.pythonhosted.org` (no cassette/stub exists — unlike A2's esm.sh stub
  for the web renderer). The brief required validating micropip against real PyPI for the
  T6 reconcile, so live PyPI here is intended; but the standing CI doctrine is 100% cassette
  hits / zero live network. Orchestrator: decide whether CI accepts live PyPI for this one
  test or a local PyPI-wheel stub (analogous to A2) must be added (not owned by T3 per plan).
- **Sandbox suite now requires the fetched Pyodide assets.** `public/pyodide/**` is
  gitignored (regenerated by `fetch-pyodide.sh`). My browser tests are the first consumers
  that REQUIRE those bytes present; CI/turbo must run
  `pnpm --filter @hushbox/sandbox fetch-pyodide` before the sandbox test suite or the
  numpy/matplotlib/micropip tests fail. Flag for the CI-wiring task.
- **Shared-config touches within apps/sandbox** (report in case a concurrent task edits the
  same files): `vitest.config.ts` (coverage exclude), `eslint.config.js` (ignore
  `public/python.js`), `package.json` (`build:python`), `scripts/fetch-pyodide.sh` (wheel
  closure). All additive.
- **iOS/mobile memory** remains the plan's accepted MEDIUM risk; not exercised here (this
  task validates desktop Chromium under CSP; T1 integration + T9 cover the WebView shell).

## Confidence

High — every acceptance behavior is proven by a real-browser integration test under the
production CSP; the reconcile is doubly confirmed (strict + fuller CSP, zero violations).
Medium only on the two RAISED coordination items (CI live-PyPI policy; CI fetch-pyodide
step), which are orchestration decisions outside T3's ownership.
