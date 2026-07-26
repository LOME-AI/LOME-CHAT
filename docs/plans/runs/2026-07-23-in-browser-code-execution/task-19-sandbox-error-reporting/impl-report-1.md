# impl-report-1 — sandbox error reporting (task-19)

## Objective

Make every sandbox failure mode surface as a bridge `error`, so the document panel —
which now runs code and treats silence as "still working" — can never sit at "loading"
forever. Window-level capture in the render frame, scoped to the pre-`rendered` phase, a
render deadline per kind, and a check of the python path.

## The defect, verified against real React (not assumed)

The reported symptom was "no bridge message at all". Measured instead, with **real React
19.2.7** bundled from `apps/web/node_modules` and driven through the committed
`public/render.js` in headless Chromium (throwaway probe, not committed):

```
76ms  ready
96ms  loading transpiling / loading-modules
86ms  rendered            ← posted while React had not yet mounted anything
90ms  window 'error' event: "Uncaught Error: boom from render"   ← lost, no listener
      #document-root innerHTML: ""
```

So the pre-fix behaviour was worse than silence: the frame reported **success** for a
document that rendered nothing, and the throw vanished. `createRoot().render()` schedules
the mount; it does not perform it, and it never throws back into the caller.

Second measurement, on the ordering the fix depends on: a microtask drain followed by one
MessageChannel round-trip lands **after** React's uncaught error in every trial — 5/5 for a
trivial throwing component, and also for a 20 001-node tree that throws at the end; a 20 000-node
tree that renders cleanly produced no error and committed all its children. `setTimeout(0)`
and `requestAnimationFrame` both fired *before* React's error, so neither is a usable wait.

After the fix, the same real-React probe produces:

```
error { requestId: 'r1', code: 'runtime_error', message: 'Error: boom from render\n at App … at MessagePort.performWorkUntilDeadline' }
```

and no `rendered`.

## Files changed

- `apps/sandbox/src/render/bootstrap.ts` — window `error`/`unhandledrejection` capture
  scoped to the in-flight request; one-terminal-message `settle()`; a `settleTick()` yield
  before a render is declared successful; a 20 s render deadline.
- `apps/sandbox/public/render.js` — regenerated committed bundle (`pnpm build:render`; a
  drift test pins it to source).
- `apps/sandbox/src/python/bootstrap.ts` — one-terminal-message `settle()` plus a 60 s
  deadline over the runtime-load/package-install phases (see "python path" below).
- `apps/sandbox/public/python.js` — regenerated committed bundle (`pnpm build:python`).
- `packages/shared/src/documents/bridge.ts` — **additive**: new `timed_out` error code (see
  "shared bridge" below).
- `apps/sandbox/src/render/render.browser.test.ts` — new tests; the react-dom stub now
  mirrors React's real mount ordering (deferred mount, `reportError` on throw) instead of
  mounting synchronously, so the react tests exercise the failure path that actually occurs.
- `apps/sandbox/src/python/python-core.browser.test.ts` — deadline test for a runtime load
  that never finishes.

## Tests added (all in real browser frames)

| Test | Behavior | Criterion |
| --- | --- | --- |
| `reports a typed error when a React component throws while mounting` | a mount throw surfaced asynchronously becomes `error{runtime_error}` and no `rendered` | brief 1 + TDD item 1 |
| `reports a typed error when an html document's inline script throws` | a synchronous inline-script throw (never propagates to the inserting code) fails the render | brief 1 |
| `reports a typed error when an inline script's throw is deferred` | a throw deferred out of the inserting task still fails the render | brief 1 + TDD item 2 |
| `still reports a successful render when a subresource fails to load` | a broken `<img>` does not fail a render (resource errors never reach a window-level listener) | boundary guard |
| `leaves a rendered document alone when it throws after it has rendered` | a post-render throw produces no `error`, and the preview stays intact | brief 2 + TDD item 3 |
| `reports a typed error when a render never reaches a terminal message` | deadline converts silence into `error{timed_out}` | brief 3 + TDD item 4 |
| `reports a typed error when the runtime never finishes loading` (python) | a hung Pyodide loader request becomes `error{timed_out}` | brief 3/4 |

RED verification (each watched failing for the stated reason before the code existed, or —
where the mechanism was already in — against a temporarily disabled control):

- React mount throw: `expected undefined to be 'runtime_error'` — no message at all. ✔
- html inline throw + React mount throw: both RED with the window listeners removed. ✔
- post-render boundary: RED with the pre-`rendered` scope guard removed (`expected true to
  be false` — an error arrived for a working preview). ✔
- deferred inline throw + React mount throw: both RED with `settleTick()` removed. ✔
- render deadline: `expected undefined to be 'timed_out'` — nothing reported. ✔
- python deadline: `expected undefined to be 'timed_out'` — nothing reported. ✔

Honest note: `still reports a successful render when a subresource fails to load` was
written after the mechanism, as a guard on a property the implementation must keep (it
passed on first run). It drove no production code.

## The pre/post-`rendered` boundary implemented

A render is **settled** by exactly one terminal message (`rendered` or `error`), and
`settle()` drops everything after the first. An uncaught window `error` or
`unhandledrejection` fails the render only while a request is unsettled.

The boundary is not "before we posted `rendered`" naively, because that is precisely the
trap the measurement exposed: React's mount error arrives after the render call returns.
The frame therefore declares success only after `settleTick()` — a microtask drain plus one
macrotask turn — which measurement shows lands after React's scheduled initial render.
Stated plainly: **a failure surfaced up to one task after the render call belongs to the
render; anything later belongs to the live document.** A click handler throwing, a timer
throwing 10 ms later, a broken image — none of them tear down a working preview.

Known limits of that boundary, accepted deliberately:

- An html document whose `<script type="module">` fails *after* fetching its imports
  reports nothing (it lands well past the settle window). It does not hang the panel —
  `rendered` has already arrived — it shows a broken preview instead of an error card.
- A very large React tree that time-slices past the first scheduler task would settle as
  `rendered` before a later throw. Same consequence: broken preview, never a hang.

## Deadlines and reasoning

- **Web render — 20 s**, armed on `init`, cleared by the terminal message. The only
  legitimately slow leg is the document's npm modules downloading (esm.sh over a poor
  mobile connection); transpile is ~4 ms. 20 s leaves large headroom over that while
  bounding the hang, and falsely failing a slow-but-working render is worse than a late
  error.
- **Python — 60 s over the load phases only** (armed on `run`, cleared when `executing` is
  announced or on the terminal message). A cold first load is legitimately ~10–12 s for the
  interpreter plus package downloads, so 60 s is ~5× the cold path. Execution itself is
  deliberately *not* bounded: once `executing` is announced the interpreter is alive running
  author code, a long computation is not a hang, and stopping it is the parent's job (it
  owns and tears down the frame). A timer could not police it anyway — Pyodide runs on the
  frame's main thread, so a spinning document blocks every callback in the frame, including
  the deadline's.

The same main-thread caveat applies to an html/js document with a synchronous infinite
loop: no in-frame timer can fire. Stop-by-teardown remains the only answer there, as
designed.

## Python path — what I found

- **Already covered:** execution is awaited inside `try/catch`, so a raised traceback, an
  `input()` call, and a failed interpreter load all reach `settle()` as typed errors. The
  existing tests confirm this; nothing was missing there.
- **Genuinely missing:** nothing bounded the *load*. Holding the `/pyodide/pyodide.mjs`
  request open forever produced **zero** bridge messages — the exact silence the panel reads
  as "still working". That is now the 60 s load deadline (RED-verified above).
- **Not added:** a window-level capture on the python page. I could not construct a case
  where it fires and the awaited chain does not already report — Pyodide surfaces failures
  through the promises the frame awaits. No demonstrable gap, no test, so no code. If one
  ever appears, the load deadline already bounds it.

## Shared bridge change

`packages/shared/src/documents/bridge.ts` gains one error code, `timed_out`. No existing
code expresses it honestly: nothing threw, the work simply never arrived, and
`runtime_error`/`import_failed` would both misreport it in a closed enum whose whole
purpose is to separate failure classes. The schema change is additive.

It is **not** source-compatible for the app: `apps/web/src/components/document-panel/document-sandbox.tsx:154`
declares `Record<DocumentErrorCode, string>`, so `apps/web` typecheck now fails with one
error until that map gains an entry (suggested copy: `timed_out: 'This document did not
finish in time.'`). apps/web is owned by a concurrent task and was not touched.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test` (apps/sandbox) | pass — 17 files, 138 tests, coverage 100% st/br/fn/ln |
| `pnpm test:shared` | pass |
| `turbo typecheck lint --filter=@hushbox/sandbox --force` | pass (2/2) |
| `turbo typecheck lint --filter=@hushbox/shared --force` | pass (2/2) |
| `npx eslint src/render src/python` (from apps/sandbox, after last edit) | exit 0 |
| `npx prettier --check` on changed dirs | pass |
| `jscpd` on `render/`, `python/`, `shared/src/documents` | 0.65% (< 2% threshold); the one clone is pre-existing (`build-bundle.ts` ↔ `build-python-bundle.ts` esbuild options), untouched |
| `apps/web` typecheck | 1 error, expected and reported above — the `Record<DocumentErrorCode, …>` entry |

Coverage on changed files: both `bootstrap.ts` entries are excluded from the coverage gate
by `vitest.config.ts` (browser entries never imported in Node); they are exercised by the
browser integration tests. Every other changed file is a test file or the shared bridge,
and both packages' per-file gates pass.

## Acceptance criteria

- **Window-level capture in the render frame** — met. `error` + `unhandledrejection` on the
  frame global, translated to a typed bridge `error` for the in-flight request; proven for
  React mount throws (including against real React 19.2.7), synchronous inline-script
  throws, and deferred throws.
- **Scoped to the pre-`rendered` phase** — met, with the boundary redefined as "up to one
  task after the render call" for the reason measured above; a post-render throw and a
  failed subresource both leave the preview alone (two tests).
- **A render deadline** — met: 20 s web, 60 s python load phases, both typed `timed_out`,
  both proven with mocked page clocks so the suite does not wait them out.
- **Check the python path** — done; findings stated plainly above.
- **Prefer existing error codes** — `runtime_error` reused for every captured uncaught
  error; one additive code added only for the timeout, which no existing code expresses.

## Deviations

- The brief's boundary ("after `rendered`, ignore") is implemented as written but with
  `rendered` made truthful — the frame yields before claiming success. Without that, the
  primary scenario (React) would still be missed, since React posts its error after the
  mount call returns. Argued with measurements rather than chosen silently.
- The brief's "inline script that throws asynchronously" is covered for throws deferred
  within the settle window (microtask). A module script that throws after a network fetch
  is not, and cannot be without withholding `rendered` indefinitely; it produces a broken
  preview, never a hang.
- The react-dom stub in the render browser test was changed to defer its mount and
  `reportError`, mirroring measured React 19 behavior. Without that, the mount-failure test
  would pass vacuously against a synchronous stand-in that does not exist in production.

## Concerns and limitations

- `apps/sandbox/src/esm-stub.ts` (out of bounds — owned elsewhere) still serves a react-dom
  stub that mounts synchronously and lets a throw propagate. E2E and CI runs that resolve
  modules through it therefore exercise a *different* failure path from production
  (synchronous catch → `runtime_error` instead of window capture → `runtime_error`). Same
  code and message shape, different route. Aligning it with the measured React ordering
  would make the seeded "jsx throws-on-mount" showcase document prove the real path.
- The deadline values are judgement calls sized against measurements available here
  (desktop Chromium); no real-device timing was collected in this task.
- A synchronous infinite loop in an html/js document still cannot be reported from inside
  the frame (its own event loop is blocked). Teardown by the parent remains the mechanism.

## Confidence

**High** for the render-frame behavior: the primary failure was reproduced and the fix
verified against real React 19 in a real browser, not only against test stubs, and every
new behavior was RED-verified. **Medium** on the two deadline constants — the mechanism is
proven, the numbers are reasoned rather than measured on a slow mobile device.

---

# Follow-up — aligning the shared esm-stub with real React's mount timing

Requested by the coordinator after this report's "concerns" item: the fixture set the dev
server, CI and E2E resolve modules through (`apps/sandbox/src/esm-stub.ts`) still mounted
react synchronously, so a mount failure reached the bridge by a route production never
takes — and the seeded "jsx throws on mount" showcase document would have proven that
wrong route.

## Files changed

- `apps/sandbox/src/esm-stub.ts` — the react-dom fixture's `createRoot().render()` now
  schedules the mount (microtask → MessageChannel task, the ordering measured against React
  19.2) and reports a component throw with `reportError` instead of throwing back into the
  caller.
- `apps/sandbox/src/esm-stub.test.ts` — two new browser tests pinning that timing; the
  hardcoded `19.1.0` literals now come from `REACT_RUNTIME_VERSION`, which owns the pin.
- `apps/sandbox/src/render/render.browser.test.ts` — the test server now resolves modules
  through `resolveEsmStub` (the shared fixture set) instead of its own private copies of
  react / react-dom / jsx-runtime; only one test-local extra module remains
  (`greeting-fixture`, standing for "a document importing some npm package").

## TDD

Both new tests were watched failing against the synchronous stub, for exactly the right
reasons:

- `schedules the mount instead of performing it during render()` —
  `expected '<p id="mounted">hi</p>' to be ''` (the container was already populated when
  `render()` returned).
- `surfaces a component throw as a window error event, not out of render()` —
  `expected true to be false` (the throw came back out of the render call, and no window
  `error` event was seen).

They are driven in a real browser: the react and react-dom fixture sources are concatenated
with the probe into one module script (`page.addScriptTag`), so no bundler, no network, and
the exact module text the dev server serves is what executes.

## Confirmation asked for

The mount-throwing React document now reports `error{code:'runtime_error'}` **through the
shared stub route**: with `render.browser.test.ts` resolving modules from `esm-stub.ts`, all
13 render browser tests pass, including "reports a typed error when a React component throws
while mounting" (which also asserts that no `rendered` is posted). That is the same code
path and the same bridge message the real-React probe produced earlier in this report, and
it is now reached by the same mechanism (window capture of a `reportError`), not by a
synchronous catch.

## Did any other test's behavior move?

No test had to be weakened or changed to accommodate the aligned stub, and no assertion
moved. Two side effects, both improvements, both handled:

- Routing the render browser tests through the shared fixtures **removed a duplicate**: the
  test file had its own react/react-dom/jsx-runtime copies, which is exactly how the two
  drifted (the private copy got the correct mount timing, the shared one did not). jscpd
  over `apps/sandbox/src` now reports 0.55% with a single clone, and it is the pre-existing
  `build-bundle.ts` ↔ `build-python-bundle.ts` esbuild-options block.
- That change left `render/react-runtime.ts` with no Node-side importer, dropping it to 0%
  and the package to 98.56% statements. Fixed at the cause: `esm-stub.test.ts` now builds
  its fixture paths from `REACT_RUNTIME_VERSION` instead of hardcoding `19.1.0`, which both
  restores coverage and removes a magic literal that could drift from the pin. Package back
  to 100%.

## Self-gate (re-run)

| Command | Result |
| --- | --- |
| `pnpm test` (apps/sandbox) | pass — 17 files, **140** tests, coverage 100% st/br/fn/ln |
| `turbo typecheck lint --filter=@hushbox/sandbox --force` | pass (2/2) |
| `npx eslint src` (from apps/sandbox, after last edit) | exit 0 |
| `npx prettier --check src` | pass |
| `jscpd apps/sandbox/src` | 0.55% (< 2%), single pre-existing clone |

`packages/shared` was not touched in this follow-up, so its earlier green run stands; the
one known `apps/web` typecheck error (the `timed_out` map entry) is unchanged.

## Environment note

Mid-follow-up, `@rolldown/binding-linux-x64-gnu` lost its files in `node_modules` (the
native binary survived only as an orphaned `.fuse_hidden*` inode) and every vitest run
failed at startup with "Cannot find native binding". Nothing in this task touches
`node_modules`; the directory repaired itself minutes later and all gates above ran clean
afterwards. Flagging it because another agent working in this checkout may hit the same
window.

## Confidence

**High.** The stub's timing is now pinned by tests that fail against the old behavior, and
the mount-failure path is proven end to end through the shared fixture set — the same
result the real-React probe gave.

---

# Fix pass 2 — audit findings 1 & 2, plus frame reuse across inits

Three items, one root cause between them: the frame is a long-lived shared realm that the
app re-`init`s roughly every 300 ms without remounting, and the first fix pass reasoned
about it as if each render owned a fresh frame.

## What I measured first (real React 19.2.7, throwaway probe, committed bundle)

| Failure | `onUncaughtError` fires at turn | window `error` |
| --- | --- | --- |
| render-phase throw (×3 trials) | 1 | never (React routes to the root handler when one is given) |
| layout-effect throw | 1 | never |
| passive-effect throw (×3 trials) | **2** | never |
| passive-effect throw, 20 001-node tree | **2** | never |
| healthy render, incl. 20 000-node tree | never | never |
| throw from a `setTimeout` scheduled inside an effect | never | yes, much later |

("Turn" = a microtask drain plus one macrotask.) React also **unmounts the tree** on an
uncaught error — the container measured empty afterwards — which is precisely why a
`rendered` claim over an effect failure is a claim over a blank preview. `onCaughtError`
and `onRecoverableError` never fired in any of these.

## Finding 1 — effect-phase throws (FIXED)

Adopted **`onUncaughtError` only**, passed to `createRoot` and bound to the request that
created the root. It covers render, commit and effect phases in one deterministic channel,
so the react kind no longer depends on the window-error heuristic at all — and the window
path is now closed for that kind, which is also what keeps a stale react tree's late
failure off a later request. `onCaughtError` was deliberately **not** adopted: it means an
error boundary in the document handled the error, i.e. the document is working as written.
`onRecoverableError` was **not** adopted either: it reports a recovery, not a failure.

Timing: a react document settles after **2 turns** (`REACT_SETTLE_TURNS`), every other kind
after 1. That is not a padded guess — it is the measured structure above: turn 1 is the
commit task, turn 2 is the passive-effect flush.

## Finding 2 — cross-request attribution (FIXED)

The window path is now bound to an explicit `captureRequestId` that is open only while a
document's own code is running, instead of "whatever request is pending":

- **html** — open across the insertion and the settle turn after it. The insertion executes
  the document's inline scripts synchronously and blocks this frame's event loop, so no
  other document's timer can interleave with it.
- **js** — open only for the settle turn *after* the module import resolves. A module fetch
  can take seconds; holding the capture open across it is exactly what handed r1's stale
  timer to r2 in the audit's reproduction.
- **react** — never open; React's own callback carries the whole failure channel.

`settle()` closes the capture along with the request, so a settled request can never absorb
a later error.

## Third item — frame reuse across inits

**Import map:** the frame now keeps a **single** map element and declares only specifiers it
has not declared before, replacing the element rather than appending a second one. Two
reasons for delta-over-union: a specifier that has already been resolved cannot be remapped,
and re-declaring one made Chromium log "An import map rule for specifier 'react' was
removed, as it conflicted with already resolved module specifiers" on every re-init (3
warnings per init, measured; now 0).

**Honest limit:** this does not rescue an engine that honors only the *first* import map.
Removing an element does not unregister an already-processed map, so on such an engine a
specifier that first appears in a later init still will not resolve. It fails loudly — the
import rejects and the frame reports typed `import_failed` — never as a silent wrong render.
The two fixes that would actually close it are outside this task: the panel remounting the
frame when the specifier set grows (apps/web, flagged not done), or resolving bare
specifiers to absolute URLs in the module source instead of relying on an import map (a
change to the T2 design mandated by plan item A7, which I will not make unilaterally).

**React root:** a container may host only one root, so the previous root is **unmounted**
before the next document takes the container over, and a fresh root is created per init.
Reuse was rejected deliberately: each root's `onUncaughtError` is bound to the request that
created it, which is the mechanism keeping an old tree's late failure off a new request —
reusing one root would either re-introduce that mis-attribution or require a mutable
"current request" pointer, which is the same bug wearing a different hat. Disposal runs at
the start of *every* init (html and js take the container over too). React routes a cleanup
throw to the old root's handler, which names an already-finished request and settles
nothing.

## Fixture work this required

The suite's react fixtures (`esm-stub.ts`, shared with dev/CI/E2E) could not express any of
this, so they now model the measured semantics: `useEffect`, an effect flush one turn after
the commit, `createRoot(container, { onUncaughtError })` with the `reportError` fallback,
tree teardown on an uncaught error, and `unmount()`. Pinned by three new tests in
`esm-stub.test.ts`.

## Tests added (all RED-verified first)

| Test | RED reason before the fix |
| --- | --- |
| `reports a typed error when a React effect throws after the commit` | `expected undefined to be 'runtime_error'` — `rendered` was posted over an empty preview |
| `does not fail a new request with the previous document's error` | `expected true to be false` — `fresh-2` received `error{runtime_error} "stale boom"` |
| `renders a second init on a live frame that imports a new specifier` | `expected 2 to be 1` — a second import map element accumulated |
| `flushes effects in the turn after the mount, as React does` (fixture) | `expected -1 to be 2` |
| `routes a throw to the root onUncaughtError handler and unmounts the tree` (fixture) | `expected '' to contain 'effect boom'` |

Honest note on the third: only its **structural** assertion was red. The resolution failure
it guards is engine-specific — this Chromium honors multiple import maps, so the second
init resolved its new specifier even before the fix. I could not manufacture a red for the
single-map engine and did not pretend otherwise.

## End-to-end verification against real React 19.2.7 (committed bundle, throwaway probe)

| Scenario | Result |
| --- | --- |
| `useEffect` throws | `error{runtime_error} "Error: effect boom"`, no `rendered`, root empty |
| render-phase throw | `error{runtime_error} "Error: render boom"`, no `rendered` |
| healthy document | `rendered`, root `<p id="ok">all good</p>` |
| throw from a timer started in an effect (live document) | `rendered`, **no error**, preview intact |
| second init on the live frame importing a new specifier | both `rendered`, root shows the new package's output, exactly 1 import map, 0 console warnings |
| stale html timer throwing during a later js request | `fresh-2` → `rendered`, no error, root `fresh output` |

## Residual, consciously accepted

- **A late async error in a shared realm is unattributable, and is dropped rather than
  guessed at.** Once a document is live, an error from its own timers — or from a previous
  document's — carries no request identity, so nothing is reported. That direction is chosen
  on purpose: a missed error is less harmful than an error card over a working preview.
- The html capture's settle turn is a ~1-task window in which a stale timer could still fire
  and be blamed on the new request. It cannot be closed without per-init frame remounting.
- A js document's deferred throw (`queueMicrotask` during module evaluation) is now usually
  missed, since the capture opens after the import resolves. The equivalent html case is
  still covered and tested.
- A react tree that time-slices its first render past turn 1 on a slow device would settle
  as `rendered` before a later error; the error is then dropped, not mis-attributed.
- Single-import-map engines: as described above — reported as `import_failed`, never silent.

## Self-gate (re-run)

| Command | Result |
| --- | --- |
| `pnpm test` (apps/sandbox) | pass — 17 files, **145** tests, coverage 100% st/br/fn/ln |
| `turbo typecheck lint --filter=@hushbox/sandbox --force` | pass (2/2) |
| `npx eslint src` (from apps/sandbox, after last edit) | exit 0 |
| `npx prettier --check src` | pass |
| `jscpd apps/sandbox/src` | 0.51% (< 2%), single pre-existing clone |

Both committed bundles were rebuilt (`build:render`, `build:python`) and their drift tests
pass. `packages/shared` was untouched in this pass; the one known `apps/web` typecheck error
(the `timed_out` map entry) is unchanged.

## Confidence

**High** on findings 1 and 2 and on the React-root handling — each is measured against real
React, RED-verified, and the fix is deterministic rather than a timing heuristic. **Medium**
on the import-map item: the DOM-level invariant is proven and the warning noise is gone, but
the failure it guards cannot be reproduced in the test engine, and the complete fix lies
outside this task.

---

# Fix pass 3 — import maps removed; bare specifiers resolved in the module source

## The empirical question, answered first

**Do the modules esm.sh returns import their own dependencies by bare specifier, or by
absolute URL?** Fetched from the real CDN:

```
$ curl https://esm.sh/react-dom@19.1.0/client
/* esm.sh - react-dom@19.1.0/client */
import "/react-dom@19.1.0/es2022/react-dom.mjs";
import "/react@19.1.0/es2022/react.mjs";
import "/scheduler@^0.26.0?target=es2022";
export * from "/react-dom@19.1.0/es2022/client.mjs";
```

**Absolute URLs, never bare specifiers** — root-relative to esm.sh's own origin, so they
resolve with no import map involved. Confirmed across every shape that matters: a plain
package (`canvas-confetti`), a scoped package (`@tanstack/react-query` → `/@tanstack/query-core@…`
plus `/react@^19.2.0?target=es2022`), a subpath entry (`react-dom@19.1.0/server`), and a deep
transitive module (`/react-dom@19.1.0/es2022/react-dom.mjs` → `import*as __0$ from
"/react@19.1.0/es2022/react.mjs"`). The one bare-looking token in that deep module —
`case "react":` — is esm.sh's internal CJS `require` shim switching over an
already-imported namespace, not an import.

So the import map existed **solely** to serve the document's own specifiers. Rewriting them
removes the entire class, and no engine's import-map support matters any more. Took the
rewrite path.

## What changed

- **New `render/resolve-imports.ts`** — `rewriteBareImports({ code, cdnBase, pins })`
  rewrites every bare specifier in a module source to an absolute CDN URL through the same
  `moduleUrlFor` the map used, so resolution rules (pins, author-declared versions, scopes,
  subpaths) are byte-for-byte what they were.
- **`render/import-map.ts` and its test are deleted** — `assembleImportMap`,
  `scanBareImports`, the `ImportMap` type, `injectImportMap`, the frame's specifier set and
  its `<script type="importmap">` element are all gone. No second mechanism was left behind.
- **react** — the transpiled source is rewritten before it becomes a blob module; the
  renderer's own `react` / `react-dom/client` imports now go through `moduleUrlFor`
  directly (`importRuntimeModule`), which keeps them the exact same URLs the document
  resolves, so there is still one React instance.
- **js** — the source is rewritten before becoming a blob module.
- **html** — only the body of a `<script type="module">` is rewritten. This is strictly more
  precise than before: the map was assembled by scanning the *whole* html document, whereas
  now the rest of the document keeps the author's text untouched.
- Stale comments describing import-map injection updated across `csp.ts`, `config.ts`,
  `headers.test.ts`, `transpile.ts`, `build-bundle.ts` + test, `esm-stub.ts` + test, and the
  renderer's own header.

## Edge cases, decided deliberately

- **Computed dynamic import** (`import(name)`) — cannot be rewritten and is left exactly as
  written; it fails at run time as an unresolvable specifier. No regression: the old map was
  built by scanning the same static text, so a computed specifier was never in it either.
  Pinned by a test.
- **Scoped packages, subpaths, version-pinned specifiers** — resolved by `moduleUrlFor`,
  unchanged from the map path; each has a unit test, and `@scope/pkg@2.0.0/sub` is pinned
  explicitly.
- **Author-declared version beats a pin** — unchanged, tested.
- **Import-shaped text inside a string literal** is rewritten too, since the matcher is
  syntactic rather than a parser. The consequence is a changed string in the document's own
  text, never a broken import; under the old design the same imprecision produced a spurious
  map entry instead. Called out rather than hidden. For html documents the exposure is now
  gone entirely (only module-script bodies are touched).

## Verified against the real CDN and the local stub

Real `https://esm.sh`, committed bundle, headless Chromium:

| Scenario | Result |
| --- | --- |
| react document, `canvas-confetti` specifier arriving on the **second** init of a live frame (the seeded fixture's exact shape) | both inits `rendered`, root `confetti loaded`, **0 import map elements** |
| js document importing a versioned subpath (`react@19.1.0/jsx-runtime`) | `rendered`, `scoped subpath resolved`, 0 map elements |
| html document whose `<script type="module">` imports a bare specifier | `rendered`, `html module resolved`, 0 map elements |

Against the local stub, the whole suite covers the same paths, and the second-init test now
asserts `document.querySelectorAll('script[type="importmap"]').length === 0`.

## Why this closes the WebView 113 concern

Nothing in the frame depends on import maps, on how many an engine honors, or on when one
was injected. A frame resolves the same specifiers on its tenth init as on its first,
because resolution happens in the source before the engine ever sees it — and absolute-URL
imports from a blob module are ordinary ESM, supported everywhere the renderer runs.
Genuinely unresolvable specifiers still fail loudly as typed `import_failed`.

## Self-gate (re-run)

| Command | Result |
| --- | --- |
| `pnpm test` (apps/sandbox) | pass — 17 files, **147** tests, coverage 100% st/br/fn/ln |
| `turbo typecheck lint --filter=@hushbox/sandbox --force` | pass (2/2) |
| `npx eslint src` (from apps/sandbox, after last edit) | exit 0 |
| `npx prettier --check src` | pass |
| `jscpd apps/sandbox/src` | 0.52% (< 2%), single pre-existing clone |

Both committed bundles rebuilt; drift tests pass.

## Residual

- One stale comment lives outside apps/sandbox and I did not touch it:
  `e2e/chat/runnable-documents.spec.ts:49` still describes "import-map resolution of the
  bare `canvas-confetti` specifier". The spec's assertions are unaffected (it asserts the
  document renders), but the sentence is now wrong and belongs to whoever owns that suite.
- The string-literal rewrite imprecision described above, for js and react documents.

## Confidence

**High.** The load-bearing unknown was answered by fetching the real CDN rather than from
memory, the replacement resolves through the same function the map used, and the seeded
fixture's exact mid-stream shape was proven end to end against live esm.sh with zero import
maps in the frame.

---

# Fix pass 4 — react settles on quiescence; stale comments; capture-scope honesty

## What settles a react render now

Not a turn count. After `root.render()`, the renderer watches the root's subtree with a
`MutationObserver` and keeps the request open while the tree is still changing: a baseline
two turns first (a component that renders `null` mutates nothing, so quiet turns alone would
declare it finished before its effects ran), then one more turn per observed change until a
turn passes quietly. The request's existing 20 s deadline bounds the wait, so a tree that
never stops mutating is never waited on forever.

That keeps the whole chained mount sequence inside the render window — commit, effects, the
state update an effect makes, the commit it schedules, and that round's effects — while a
document that has settled down leaves it.

## The defect, reproduced and fixed (real react@19.1.0 via live esm.sh, committed bundle)

| Shape | Before | After |
| --- | --- | --- |
| (a) `setReady(true)` in one effect, `ref.current.getContext('2d')` in the effect that runs once ready | `rendered`, root `""` | `error:runtime_error`, no `rendered` |
| (b) effect sets state to `undefined`; second-round render throws on `items.map` | `rendered`, root `""` | `error:runtime_error`, no `rendered` |
| (c) `Suspense` + `lazy` child throwing on render | `rendered` | **still `rendered`** — see residual |
| (d) `Suspense` + `lazy` child throwing in its effect | `rendered` | **still `rendered`** — see residual |

Controls, all still correct after the change: first-round render throw, mount-effect throw,
layout-effect throw, a 20 001-node tree with a throwing effect → all `error:runtime_error`
with no `rendered`; healthy document, healthy document with chained state updates (0→3), a
document animating forever on a 16 ms interval, and a live document throwing from a timer
300 ms after mount → all `rendered`, previews intact.

In the suite, the shape is pinned by `reports a typed error when a React effect throws in a
later commit round`, RED-verified (`expected undefined to be 'runtime_error'`). Reproducing
it required teaching the shared react fixture what a second commit round is: `useState`,
and a state update from an effect scheduling another render+commit. That fixture behavior
has its own RED-verified test (`commits a second round when an effect updates state`).

## The residual, on its true trigger set

The render window ends at the first genuinely idle gap. Measured boundary, real React:

| Second round scheduled by | Inside the window? |
| --- | --- |
| synchronous chain (effect → setState → commit → effects) | yes |
| an awaited microtask chain | yes |
| `setTimeout(…, 0)` | yes |
| `setTimeout(…, 100)` | **no** |
| a `lazy()` module fetch (Suspense) | **no** |

So the accurate statement is: **a commit round that begins after a real idle gap — a
network fetch or a delayed timer — falls outside the render window, on any device.** It is
not about slowness and not about time-slicing; my earlier "slow device" wording was wrong
and is retracted. `React.lazy`/`Suspense` is the shape that hits it in practice, since the
child arrives from a fetch.

I could find no sound signal that separates "a lazy child is still coming" from "this
document is live and idle": React exposes no suspension state to the frame, and a dynamic
`import()` is not observable through `fetch`, XHR, or resource timing before it resolves.
Extending the window by a fixed grace would delay every healthy render and still only cover
fast fetches. So I did not paper over it — I am handing it back for a ruling, with the
consequence stated plainly: `rendered` is posted while the fallback is on screen, the child
then fails, React unmounts, and the panel shows an empty preview with no error card. It is a
missed error, never a false one, and never a hang.

One option exists that I did not take because it is a protocol change owned elsewhere: for
the react kind, `onUncaughtError` is unambiguous evidence that *this* request's tree failed
and was torn down (unlike a stray window error, it is bound to this root and this request),
so an error *after* `rendered` would be safe to report for that kind specifically. That
needs the bridge's one-terminal-message rule relaxed and the panel taught to handle it —
apps/web, which I am not to touch.

## Minor items

- **Stale comments fixed**: `build-bundle.ts` (classic-script rationale), `public/render.html`
  (same, plus "import-map assembly" in the render.js description), `react-runtime.ts`
  ("so the import map resolves them"), and the duplicated paragraph in `resolve-imports.ts`
  (edit residue — one copy removed). The classic-script constraint is now stated on its real
  ground: a module script is deferred, and the page's own script must run first because it
  closes the WebRTC egress channel before any document code can execute.
- **`unhandledrejection` is now tested** where it can fire: a js document that leaves a
  promise rejected reports `error{runtime_error}`, RED-verified by removing the listener.
  The listener is kept rather than deleted because that half genuinely works. For the html
  kind it cannot fire — the rejection is only declared unhandled in a later task, after the
  document's capture window has closed — which is the same accepted direction as the item
  below.
- **html module-script scope restated**: my earlier disclosure said a module script failing
  "after fetching its imports" reports nothing. The auditor is right that it is broader —
  **any** html module-script failure is missed, including one with no imports that simply
  throws and one importing a 404, because a module script is deferred past the document's
  capture window. Accepted in the missed-not-false direction; the classic inline-script path
  (the common html shape) is covered and tested.
- **Outside my package, reported not edited**: `packages/shared/src/env.config.ts:138` still
  mentions the import map in its `ESM_CDN_URL` description.

## Self-gate (re-run)

| Command | Result |
| --- | --- |
| `pnpm test` (apps/sandbox) | pass — 17 files, **150** tests, coverage 100% st/br/fn/ln |
| `turbo typecheck lint --filter=@hushbox/sandbox --force` | pass (2/2) |
| `npx eslint src` (from apps/sandbox, after last edit) | exit 0 |
| `npx prettier --check src public/render.html` | pass |
| `jscpd apps/sandbox/src` | 0.51% (< 2%), single pre-existing clone |

Both committed bundles rebuilt; drift tests pass.

## Confidence

**High** on the fix: the failing shapes and every control were verified against real React
through the committed bundle, before and after, and the quiescence signal is derived from
observed DOM behavior rather than a guessed interval. **High** on the residual being stated
accurately this time — its boundary was measured (0 ms timer in, 100 ms timer out), not
estimated.

---

# Fix pass 5 — quiescence measured in milliseconds, not turns

## The measurement that decided the design

The audit was right that one quiet turn exits mid-round. But two quiet turns does not fix
it, and I could only find that out by tracing what the quiescence loop actually sees. A
harness recorded, turn by turn, every mutation of the root while a document mounted (real
react@19.1.0 via live esm.sh, committed bundle), for chains of depth 1–5 and for four
continuously-mutating documents:

| Shape | Wall time between rounds/frames | Quiet **turns** between them |
| --- | --- | --- |
| chain depth 1 | 0.5–0.8 ms | 0–1 |
| chain depth 2 | 0.6–0.7 ms | 0–3 |
| chain depth 3 | 5.0 ms | ~700 |
| chain depth 4 | 13–21 ms | 638–2062 |
| chain depth 5 | 4.7–22 ms | 626–3515 |
| 16 ms interval animation | ~16 ms | 2508–3481 |
| rAF animation | ~16 ms | 1421–3312 |
| recursive `setTimeout(0)` | ~8 ms | 1103–1601 |
| MessageChannel mutation loop | every task | 0–1 |

A turn is ~7 µs (100–148 turns/ms measured), so the gaps inside a deep mount chain
(up to 3515 turns) and the gaps between animation frames (up to 3481 turns) are the **same
magnitude and overlap**. No quiet-turn count separates them: a threshold high enough to hold
depth-5 together also holds a 16 ms animation open forever, which the deadline would then
report as `timed_out` over a working preview. Reproduced twice with consistent numbers.

Wall time does separate them, because the two differ in what they are waiting on.

## The new settle rule

After the baseline two turns (a component rendering `null` mutates nothing), the renderer
waits in **50 ms sleeps**: each sleep that sees no mutation ends the render; each mutation
buys another. A **400 ms budget** caps the whole wait.

- `QUIESCENCE_QUIET_MS = 50` — roughly twice the widest inter-round gap measured (22 ms),
  and comfortably above an animation frame so an animating document never satisfies it.
- `QUIESCENCE_BUDGET_MS = 400` — an order of magnitude above the tens of milliseconds a
  chained mount takes, so a document that simply never stops changing is called rendered
  instead of being held to the 20 s deadline.

Sleeping rather than spinning turns also stops the renderer competing with React's own
scheduler for task slots.

## Measured outcome (real react@19.1.0, live esm.sh, committed bundle)

Deep chains — every one now caught, where 2–5 previously reported success:

| Shape | Before | After |
| --- | --- | --- |
| chain depth 1 (throws in last round) | `error:runtime_error` | `error:runtime_error` @196 ms |
| depth 2 | `rendered`, root `""` | `error:runtime_error` @164 ms |
| depth 3 | `rendered`, root `""` | `error:runtime_error` @189 ms |
| depth 4 | `rendered`, root `""` | `error:runtime_error` @167 ms |
| depth 5 | `rendered`, root `""` | `error:runtime_error` @182 ms |

Continuously-mutating documents — all settle promptly, previews intact, none near the
20 s deadline:

| Shape | Terminal | At |
| --- | --- | --- |
| healthy static | `rendered` | 244 ms |
| 16 ms interval animation | `rendered` (n=147) | 562 ms |
| rAF animation | `rendered` (n=141) | 557 ms |
| recursive `setTimeout(0)` | `rendered` (n=578) | 566 ms |
| MessageChannel mutation loop | `rendered` | 563 ms |

The MessageChannel loop is worth calling out: under the one-quiet-turn rule it produced **no
terminal message at all** within 2.5 s (it mutates every task, so it never had a quiet turn)
— it would have settled as `timed_out` at 20 s. The budget fixes that case too.

Live-document controls still correct: a timer throwing 300 ms after mount → `rendered`,
preview intact; a click handler throwing → `rendered`, preview intact.

## Corrected residual boundary

Re-measured under the new rule; my previous table was wrong (it reported `setTimeout(0)` as
inside on a build where it was not, and I did not re-check after changing the rule):

| Second round scheduled by | Inside the render window? |
| --- | --- |
| synchronous chain, any depth (1–5) | **yes** (was: depth 1 only) |
| awaited microtask chain | yes |
| `setTimeout(…, 0)` | yes |
| `setTimeout(…, 25)` | yes |
| `setTimeout(…, 40)` | yes |
| `setTimeout(…, 50)` | yes |
| `setTimeout(…, 75)` | **no** |
| `setTimeout(…, 100)` | no |
| `lazy()` + `Suspense`, child from a local fast fetch | **no** |

So the boundary is not "the first idle gap" — that phrasing is retracted. It is: **a commit
round that starts more than ~50 ms after the last DOM change falls outside the render
window.** Everything closer stays inside, at any chain depth.

What that leaves as the residual, stated on the measured terms: `React.lazy`/`Suspense`
(the child arrives well past the window even from a local fetch), and any document that
defers its next round by more than ~50 ms. In both cases `rendered` is posted while the tree
is still incomplete, the later failure is dropped, and the panel shows an empty preview with
no error card — missed, never false, never a hang. Raising the window would start catching
live documents' own updates (the 300 ms timer control is only 6× away), which is the failure
direction we rejected; the sound fix remains the one flagged in pass 4 — letting the react
kind report an error after `rendered`, since `onUncaughtError` is unambiguous — and that
needs a bridge change and panel support in apps/web.

## Tests

- `reports a typed error when a React effect throws three rounds deep` — the audit's
  canonical shape (loading flag → data → DOM touch), RED-verified in-suite against the
  committed esm-stub fixture (`expected undefined to be 'runtime_error'`); no live esm.sh
  needed, as the auditor found.
- `reports a React document that never stops mutating as rendered, promptly` — a document
  whose effect mutates the DOM every 16 ms must terminate as `rendered` (not `timed_out`)
  well inside the deadline. This is the guard against a future rule that over-holds.
- All earlier tests unchanged and green, including the depth-1 effect throw, the mount
  throw, the post-render boundary, and the stale-request cases.

## Minor

- `public/_headers:34-35` no longer references injecting an inline `<script type="importmap">`;
  it now matches the corrected `src/csp.ts` wording (an html document is inline `<script>`,
  classic or module).

## Self-gate (re-run)

| Command | Result |
| --- | --- |
| `pnpm test` (apps/sandbox) | pass — 17 files, **152** tests, coverage 100% st/br/fn/ln |
| `turbo typecheck lint --filter=@hushbox/sandbox --force` | pass (2/2) |
| `npx eslint src` (from apps/sandbox, after last edit) | exit 0 |
| `npx prettier --check src public/render.html` | pass (`_headers` has no prettier parser) |
| `jscpd apps/sandbox/src` | 0.5% (< 2%), single pre-existing clone |

Both committed bundles rebuilt; drift tests pass.

## Confidence

**High** on the rule and on both constraints: every number above came from driving the
committed bundle against real React, before and after, including the animation shapes that
would have regressed. **High** on the corrected boundary — it was re-measured at 0/25/40/50/75/100 ms
under the shipped rule rather than carried over.

---

# Fix pass 6 — a react document may report its death after `rendered`

Founder-approved protocol change, spanning three packages because splitting it would leave a
window where the frame emits a message the panel does not understand.

## What changed

- **`apps/sandbox/src/render/bootstrap.ts`** — `reportReactFailure()` replaces the direct
  `settle()` call in the react root's `onUncaughtError`. While the request is still pending
  it settles as before; once the render has been reported it posts the `error` anyway. Two
  fences hold: an older root's failure is dropped once a newer document owns the frame
  (`latestRequestId`), and a dead tree reports its death once (`reactFailureReported`). The
  window capture is unchanged and still closed after settle, non-react kinds still send
  exactly one terminal message, and the requestId fence and deadlines are untouched.
- **`packages/shared/src/documents/bridge.ts`** — the contract is stated on `RenderedMessage`
  (an `error` may follow it for the react kind, and what that means: the tree died, the frame
  is empty) and on `ErrorMessage`. **The Zod schema needs no change** — the message shape is
  identical and `requestId` already ties the failure to the render it invalidates. Stated
  explicitly in the file rather than left implicit.
- **`apps/web/.../document-sandbox.tsx`** — state gains `currentAttemptRendered`. On an
  `error` naming the attempt that painted, `hasRendered` is cleared: the preview is gone, so
  the panel stops offering it as the last good render. The error reaches the reader through
  the existing suppression rule and nothing else — hidden while `isStreaming || superseded`,
  shown as the error card once settled. No second display path.

## The behavior question, measured

**Does `onUncaughtError` fire for a render triggered by user interaction?** Yes — measured,
real react@19.1.0 through the committed bundle:

| Interaction | Messages | Root after |
| --- | --- | --- |
| click → `setState` → re-render throws | `rendered`, then `error:runtime_error` | `""` |
| click → `setState` → effect throws | `rendered`, then `error:runtime_error` | `""` |
| click handler throws directly, no re-render | `rendered` only | `<button id="press">press</button>` — **preview intact** |
| click → `setState` → healthy re-render | `rendered` only | `<button id="press">pressed 1</button>` |

So a live document that crashes on a click now shows an error card where it previously
blanked silently — a behavior change beyond the residual, and the root is genuinely empty in
both crashing cases, so the card describes what the reader is looking at. A throw inside an
event handler that triggers no re-render does **not** reach the handler and leaves the
working preview alone, as required.

## Pass-5 audit shapes: mitigation verified

All three re-run against this build, 4 trials each, real react@19.1.0:

| Shape | Result |
| --- | --- |
| canvas shape, DOM output identical every round, 30 ms hops | `[rendered, error:runtime_error]` 4/4, root `""` |
| purely synchronous chain, depth 12, constant DOM output | `[rendered, error:runtime_error]` 4/4, root `""` |
| `createPortal(…, document.body)` then throws | `[error:runtime_error]` 4/4 (the root never mutates, so the window expires and the failure lands while the request is still pending — reported as the terminal message, no `rendered` at all) |
| control: healthy document | `[rendered]` only, preview intact |

None goes silent. The react channel is not closed anywhere it should not be.

## In-suite coverage of the mutation-invisible class — what I found

The fixture cannot express it, and making it able to would distort the fixture rather than
sharpen it. Two reasons, the second decisive:

1. `esm-stub.ts` rebuilds the container on every commit, so every stub round mutates. That
   part is fixable in ~5 lines (stage the tree, replace only when the output differs), which
   is what React actually does.
2. But the class only manifests when a round *starts after the 50 ms quiet window*. The
   stub's rounds are a microtask plus a MessageChannel task apart — microseconds — so even a
   50-round chain finishes inside the first window and is caught as the terminal error. To
   reproduce the class the fixture would have to fake React's scheduler yield timing with
   real sleeps, which would slow and destabilise every other react test.

So I did not write a test that cannot fail. What **is** covered in-suite is the mechanism the
class relies on: `reports a React failure that lands after the render was reported` drives a
deferred round through the same post-settle path (`rendered` first, then `error`). The
class-specific reproductions stay in the browser probes recorded above.

## Corrected residual, restated for what remains after late failures are reported

The pass-5 framing no longer applies: for a react document the timing boundary no longer
decides *whether* the reader is told, only which shape the telling takes.

| Failure | Reported? |
| --- | --- |
| any uncaught error in the react tree — render, commit, or effect; any round; any delay; portal; `Suspense`/`lazy`; interaction-triggered | **yes** — as the terminal `error` if it lands inside the render window, otherwise as an `error` after `rendered` |
| a react error caught by the document's own error boundary | no — deliberately; the document handled it |
| a throw in a react event handler with no re-render | no — deliberately; the preview still works |
| an async callback a react document started throwing outside React (e.g. its own `setTimeout`) | no — the window capture is closed for react and this never reaches React's root handler |
| an html document's module-script failure (no imports, 404 import, or a plain throw) | no — deferred past the capture window; the classic inline-script path is covered |
| a js document's deferred throw after the import resolved | no — capture opens only for the settle turn |
| non-react kinds after settle | no — one terminal message per request stands for them |

The corrections the audit asked for are folded in and no longer describe a user-visible gap
for react: `setTimeout(…, 50)` being a knife edge (IN/IN/OUT across runs), a 25 ms two-hop
with unchanged output falling out, and "synchronous chain, any depth" holding only to depth 8
with constant output all now decide **error-before-`rendered` vs error-after-`rendered`**,
not reported vs silent. The window's remaining job is to keep a healthy document's `rendered`
honest, and its constants stay as measured in pass 5 (50 ms window, ~3.2× margin under 10×
CPU throttling; 400 ms budget, ~3.3× a 12-round mount).

What genuinely remains unreported is the list above — html/js late failures, and react errors
that never reach React (a bare event-handler throw, an error boundary catch). All are the
missed-not-false direction, and none leaves the panel waiting.

## Tests

- Sandbox: `reports a React failure that lands after the render was reported` — RED-verified
  (`rendered` was posted and nothing followed).
- Panel: `stops offering a render the live document has since died in` — RED-verified
  (`expected 'rendered' to be 'streaming'`), plus `surfaces that death as soon as the message
  settles` (error card + `document-render-status` = `error`).
- Panel: `never flashes a superseded failure over the render it is holding` rewritten so its
  failing attempt is a genuinely later request (req-2 via the debounce), which is what a
  later attempt looks like on the wire — preserving the last-good-render behavior it guards.
- A fixture bug surfaced and fixed on the way: the stub kept committing scheduled rounds after
  an uncaught error, so a torn-down tree could resurrect its content. Real React does no
  further work on a failed root. This was making the depth-3 test flaky (1 in 3); it is now
  stable 3/3.
- `document-render-status` transitions confirmed: healthy documents still reach `rendered`
  and stay there (the Playwright and Maestro proofs are unaffected); a post-render death
  moves it `rendered` → `error` only once the message settles.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test` (apps/sandbox) | pass — 17 files, **153** tests, coverage 100% st/br/fn/ln |
| `pnpm test:shared` | pass — `src/documents` 100% |
| `turbo test --filter=@hushbox/web --force` with a private `--coverage.reportsDirectory` | pass (1/1) |
| `turbo typecheck lint --filter=@hushbox/sandbox --filter=@hushbox/shared --force` | pass (4/4) |
| `turbo typecheck lint --filter=@hushbox/web --force` | pass (2/2) |
| `eslint` from each package dir after the last edit | exit 0 in all three |
| `prettier --check` | pass |
| `jscpd` over the three changed areas | 0.24%, single pre-existing clone |

Both committed bundles rebuilt; drift tests pass.

## Confidence

**High.** The protocol change is small and fenced, every claim above was measured against
real React through the committed bundle rather than reasoned, and the three shapes the
previous audit found silent now all report. The one thing I declined to do — an in-suite test
for the mutation-invisible class — is declined for a stated reason rather than skipped.

---

# Fix pass 7 — the once-only guard now covers the whole react channel

## The comment was a promise the code did not keep

`reportReactFailure`'s doc said a tree "reports its death once", but
`reactFailureReported` was set only on the post-settle branch. Two failures inside one
pre-settle commit round therefore posted two `error` messages for the same request: the
first settled (clearing `pendingRequestId`), and the second fell through to the late branch
with the flag still unset. Confirmed by the auditor 3/3 with two sibling `useEffect`s each
throwing in the same round.

I made the comment true rather than narrowing it. The guard now runs before either branch,
so the first failure is reported and the rest of that round's failures are dropped —
whichever branch each would have taken. The reason is stated where the guard sits: React can
hand over several errors from one commit round, and the first already carries the only fact
the app acts on, which is that this tree is gone.

## Verified, real react@19.1.0 through the committed bundle, 3 trials each

| Document | Messages |
| --- | --- |
| two sibling effects each throwing in the same round (pre-settle) | `error:runtime_error("boom A")` — exactly one, 3/3, never silent |
| two sibling effects throwing in a deferred round (post-settle) | `rendered`, then `error:runtime_error("boom A")` — exactly one error, 3/3 |
| control: healthy document | `rendered` only, 2/2 |

The first error wins in both branches, and neither case goes quiet.

## Correction to the pass-6 residual mechanism

My pass-6 table recorded `createPortal(…, document.body)` as producing `[error]` alone,
with the explanation that the root never mutates so the failure lands while the request is
still pending. The auditor measured `[rendered, error:runtime_error]` instead, and their
mechanism is the right one: with no root mutations the quiescence loop exits after its first
re-read, so `rendered` posts at ~60 ms and the failure arrives after it. The outcome is
identical for the reader — the panel retires the render and shows the error card — but the
sentence explaining *why* was wrong, and a future reader would have taken it as evidence
that a portal document is caught inside the render window. It is not; it is caught by the
post-`rendered` channel, like the other late failures.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test` (apps/sandbox) | pass — 17 files, 153 tests, coverage 100% st/br/fn/ln |
| `turbo typecheck lint --filter=@hushbox/sandbox --force` | pass (2/2) |
| `npx eslint src` (from apps/sandbox, after the last edit) | exit 0 |
| `npx prettier --check src` | pass |

`public/render.js` rebuilt (the source changed); the drift test passes. `packages/shared` and
`apps/web` were not touched in this pass.
