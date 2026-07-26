# T2 — Python bootstrap on the port

## Objective

Move `apps/sandbox/src/python/bootstrap.ts` onto the frame-minted `MessageChannel`, drive its
browser tests through the shared embed harness, and collapse the duplication that leaves behind
(A2) plus the third "serve `public/` safely" implementation (A8).

## Files changed

| File | Why |
| --- | --- |
| `apps/sandbox/src/python/bootstrap.ts` | Mints the channel, listens on `port1`, starts it, transfers `port2` with the one-shot `ready`; `post()` now sends through the port; the `window` message listener is gone. |
| `apps/sandbox/src/python/browser-harness.ts` | Reduced to the Python-specific parts (PyPI fixture replay, the init-then-run sequence, the frame handle); the server, the embedding, `launchBrowser` and `BridgeLike` now come from `../embed-harness.ts`. |
| `apps/sandbox/src/python/python-core.browser.test.ts` | Driven through the embedded frame; the mocked-clock test rebuilt on the harness; two transport tests added. |
| `apps/sandbox/src/python/python-figures.browser.test.ts` | Imports the origin/browser helpers from the shared harness. |
| `apps/sandbox/src/python/python-micropip.browser.test.ts` | Same import move. |
| `apps/sandbox/public/python.js` | Regenerated from the changed bootstrap (`build:python`). |
| `apps/sandbox/src/embed-harness.ts` | A8: containment routed through `resolveWithinDir`; the second technique (`path.posix.normalize` clamp) removed. |
| `apps/sandbox/vitest.config.ts` | One comment sentence: the coverage-exclusion note said both harnesses "spin a server", which stopped being true of `browser-harness.ts`. Exclusion list itself unchanged. |

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `runs a document from an init and run delivered only through the transferred port` (python-core) | A port is transferred with `ready`, and an `init`+`run` sent only over it reaches `result` with the document's stdout. | 6 |
| `ignores an init and run posted at its window instead of the port` (python-core) | An `init`+`run` posted at the frame's *window* with `'*'` produces nothing; a port run right after proves the frame was alive. | 2 (the removed window listener) |

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm --filter @hushbox/sandbox test` | pass — 17 files, 161 tests, coverage gate green |
| `npx turbo typecheck lint --filter=@hushbox/sandbox --force` | pass — 2/2 tasks |
| `npx eslint <owned files>` from `apps/sandbox` (after the last edit) | pass — exit 0 |
| `npx jscpd --threshold 2 apps/sandbox/src/python apps/sandbox/src/embed-harness.ts` | pass — 0 clones |

## Acceptance criteria

1. **`startPythonRuntime()` mints a channel, handles `init`/`run` on `port1`, sends `ready` with
   `[port2]` — met.** `bootstrap.ts:303-333`. Bundle evidence:
   `let t=new MessageChannel;wu=t.port1,t.port1.addEventListener("message",…)` …
   `parent.postMessage(r,"*",[t.port2])`.
2. **`window` message listener removed; `parseParentToFrameMessage` still validates; the
   `init`-stashes / `run`-executes split and the absent `stop` branch unchanged — met.** The
   built bundle contains zero `window.addEventListener` / `globalThis.addEventListener`
   occurrences and exactly one `addEventListener("message")`, on `port1`. The handler body is the
   previous one verbatim.
3. **`post()` sends through the port; only `ready` uses `parent.postMessage` — met.** The bundle's
   two `postMessage` sites are `wu.postMessage(t)` (the port, reached by `loading`, `console`,
   `result`, `error`, and both `settle()` paths including the load deadline) and the single
   wildcard `parent.postMessage(r,"*",[t.port2])`. Regex over the bundle for
   `postMessage(<args>,"*")` returns exactly one match.
4. **`browser-harness.ts` drives the python page through the shared embed harness — met.** It now
   imports `openEmbeddedFrame`, `BridgeLike`, `EmbeddedFrame` and contains no server, no
   `chromium.launch`, no `BridgeLike` declaration. Surface change recorded under *Deviations*.
5. **All 11 existing tests pass with assertions intact — met.** 9 in python-core (9 → 11 with the
   two additions), 1 in python-figures, 1 in python-micropip. No test weakened or deleted; the two
   most fragile are called out below.
6. **Regression test proves port-only delivery reaches `result` — met.** RED observation recorded
   below.
7. **`public/python.js` regenerated; both drift tests pass — met.** `build-python-bundle.test.ts`
   4/4 green (`expect(committed).toBe(fresh)`); a second `build:python` after the final source
   state left the file byte-identical (md5 `f522d7e409cad8f76e52031f54c8cb06` before and after).

## The RED observation (criterion 6)

Sequence: the harness and the tests were written first and run against the **unchanged**
bootstrap and its committed bundle.

- `runs a document from an init and run delivered only through the transferred port` failed at
  `expect(await page.frame.hasPort()).toBe(true)` — *expected true, received false*: the
  pre-change `ready` carried no transferable, so the embedder captured no port.
- Every test that went through `page.run()` failed with
  `page.evaluate: Error: the frame transferred no port with its ready` (thrown by the shared
  harness's `send`), i.e. 9 failed / 2 passed in that file. The two that passed are the ones that
  never need the transport (the WebRTC probe, the page-errors assertion).
- `ignores an init and run posted at its window instead of the port` failed the *other* way:
  `expect(afterForgery.some((m) => m.requestId === 'forged-1')).toBe(false)` received `true` — the
  old bootstrap really did accept a window-posted `init`+`run` from anything sharing the
  embedder's realm. That is the forgery path this task closes.

After the bootstrap change and `build:python`: 11/11 in that file, 13/13 across the three python
browser files.

## A5 — how `port.start()` is satisfied by construction

The listener is registered with `channel.port1.addEventListener('message', …)` (the
`unicorn/prefer-add-event-listener` rule forbids the `onmessage` form), so the port is paused
until started. `channel.port1.start()` sits at `apps/sandbox/src/python/bootstrap.ts:325` —
**after** the listener registration and **before** `parent.postMessage(ready, '*', [port2])`, so
anything the embedder sends the instant it receives the port is queued rather than dropped.

This is not resting on a green suite. Deleting the single `start()` line, rebuilding the bundle
and re-running the port-delivery test in real Chromium produced:

```
Error: no matching frame→parent message within 120000ms; collected [{"type":"ready"}]
```

— the handshake arrives, and nothing else ever does. Source and bundle were restored immediately
afterwards (md5 back to `f522d7e409cad8f76e52031f54c8cb06`, full suite re-run green). So unlike
the happy-dom/Node environments A5 warns about, this frame's tests *do* fail without the call.

## Duplication collapse (A2) and containment (A8)

`npx jscpd --threshold 2 apps/sandbox/src` — **before**: 5 clones, 51 duplicated lines (2.3%),
over the threshold at that scope.

| Pair | Before | After |
| --- | --- | --- |
| `embed-harness.ts:44-55` ↔ `browser-harness.ts:64-75` (`BridgeLike`) | clone | gone — one declaration, imported |
| `embed-harness.ts:164-174` ↔ `browser-harness.ts:85-95` (static file read) | clone | gone — no server in browser-harness |
| `embed-harness.ts:174-183` ↔ `browser-harness.ts:104-113` (CSP/CORS response + listen) | clone | gone |
| `embed-harness.ts:183-195` ↔ `browser-harness.ts:113-125` (origin + close) | clone | gone |
| `python/build-python-bundle.ts:27-36` ↔ `render/build-bundle.ts:28-37` (esbuild options) | clone | **still present — pre-existing, not this task's** |

**After**: 1 clone, 9 duplicated lines (0.41%) over `apps/sandbox/src`; 0 clones over this task's
owned files. The four A2 pairs are gone.

Containment now routes through **one** helper: `resolveWithinDir(publicDir, pathname)`, exported
from `apps/sandbox/src/dev-server.ts:66` (resolve, then assert prefix containment — the technique
that refuses every traversal payload, and the one with unit tests in `dev-server.test.ts`).
`embed-harness.ts` imports it and 404s on `null`; its `path.posix.normalize` clamp is deleted, and
with it A8's flagged posix/platform-`path` mixing. The third implementation — the server inside
`python/browser-harness.ts` — no longer exists at all. The package is left with two servers (the
dev server and the test origin) and one containment check. T1's traversal test
(`/..%2fpackage.json` → 404, `render.browser.test.ts:135`) still passes against the shared helper.

## Byte-exact drift

`apps/sandbox/public/python.js` regenerated with `pnpm --filter @hushbox/sandbox build:python`.
`build-python-bundle.test.ts` — 4/4 pass, including `keeps the committed public/python.js in sync
with the source` (`toBe`) and `writePythonBundle rewrites the committed bundle from source`.
Re-running the build against the final source produced an identical file (md5 unchanged), so the
committed bundle is exactly what the current source builds.

## Test counts, per file

| File | Before | After |
| --- | --- | --- |
| `python-core.browser.test.ts` | 9 | 11 |
| `python-figures.browser.test.ts` | 1 | 1 |
| `python-micropip.browser.test.ts` | 1 | 1 |
| package total | 159 | 161 |

**The mocked-clock `timed_out` test** now opens its page through `openPythonPage(..., beforeLoad)`
with `page.clock.install()` and the hanging `pyodide.mjs` route, then sends `init`+`run` over the
port. Two things changed in its shape, both strengthening: the ad-hoc page-side `__msgs` collector
and the hand-rolled Node polling loop are gone (the harness polls from Node for every wait, per
A3), and the test now waits for the frame's `loading` message before `clock.fastForward(600_000)`
— that message is the frame saying it has armed the deadline, so the fast-forward can no longer
race ahead of the timer it is meant to fire. Assertions unchanged (`error.code === 'timed_out'`,
no `result`). Passes; 11/11 in the file.

**The WebRTC probe** needed no change at the call site: `PythonPage.probe` now delegates to the
harness's `probeFrame()`, which evaluates inside the opaque frame's own realm rather than the page
(A3 — `page.evaluate` cannot reach into it). All five assertions intact. It was one of the two
tests that passed even in the RED run, which is the expected signature of a test that does not
touch the transport.

## Deviations

1. **`browser-harness.ts`'s exported surface is smaller than criterion 4 enumerates.**
   `startPythonSandbox`, `launchBrowser`, `PythonSandbox` and `BridgeLike` are deleted rather than
   re-exported; the three spec files import `startSandboxOrigin`, `launchBrowser`, `SandboxOrigin`
   and `BridgeLike` from `../embed-harness.js` directly. Keeping them as aliases would have left
   two names for one thing, which is the naming half of the same One-Implementation-Shared
   problem A2 asks to close. Criterion 4 permits signature changes with all call sites updated in
   the same task; all three call sites are updated and there are no other consumers in the repo
   (`grep` for `browser-harness|startPythonSandbox|PythonSandbox` finds only these files and the
   coverage-exclusion entry). `installPyPIInterception`, `openPythonPage`, and
   `PythonPage.run/.probe/.close/.pageErrors` are unchanged in name and signature.
2. **`PythonPage` gained a `frame: EmbeddedFrame` member.** The two transport tests need `send`,
   `postToFrameWindow` and `hasPort` on an already-warm page; without it they would each have to
   pay a fresh Pyodide load, and the mocked-clock test would need its own embedding.
3. **Two files edited outside the enumerated ownership.** `embed-harness.ts` — required by A8 and
   authorized in the brief. `vitest.config.ts` — one comment sentence made false by this change
   (`browser-harness.ts` no longer spins a server); the exclusion entries are untouched.
4. **Two tests added beyond the enumerated criteria** (the transport `describe`). One is
   criterion 6; the other is the evidence for criterion 2, mirroring what T1 was required to pin
   for the renderer.

## Concerns and limitations

- **One pre-existing clone pair remains in the package**: the esbuild options block shared by
  `python/build-python-bundle.ts` and `render/build-bundle.ts` (9 lines, 0.41% over
  `apps/sandbox/src`, under the 2% gate and present before this task). Collapsing it would mean
  editing the render bundle builder, which is outside this task; flagged, not touched.
- **`embed-harness.ts` returns 404 where `dev-server.ts` returns 403** for the same
  `resolveWithinDir` → `null` outcome. The containment *decision* is now shared; only the status
  code differs, and 404 was kept because T1's traversal test asserts it and "not in the served
  tree" is the honest answer from a test origin. Worth a ruling if uniformity is wanted.
- A8's two deliberately-unassigned observations: the `dev-server.ts:88-90` `v8 ignore`
  justification is still inaccurate (untouched, as instructed). The posix/platform `path` mixing
  it flagged disappeared with the clamp.
- E2E was not run (Global Constraint 11). The `e2e/` harness still speaks the old transport until
  T4 lands; nothing in this task touches it.
- The package's coverage summary prints an empty per-file table (131 statements total). That
  shape is unchanged by this task — no coverage-config semantics were touched, only a comment —
  and the per-file gate passes.

## Confidence

**High.** The transport change is pinned by a test that failed for the right reason before it and
passes in a real browser after it; `port.start()` was verified by deletion in Chromium rather than
by a green suite; the bundle is byte-reproducible; the collapse is confirmed by jscpd going from
5 clones to 1 pre-existing one, with the four A2 pairs gone and one containment helper left.
