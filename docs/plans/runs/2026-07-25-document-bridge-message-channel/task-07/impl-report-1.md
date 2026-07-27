# task-07 — standing python realm-reachability test (A11)

## Objective

Close the asymmetry amendment A11 names: render carries a standing test that no `MessagePort` is
reachable from the frame's realm; python's equivalent had only been answered three times by throwaway
scripts. Add a standing test to `apps/sandbox/src/python/python-core.browser.test.ts` that asserts, from
inside Python through the Pyodide FFI, that no `MessagePort` instance is reachable from `js.globalThis`.

## Files changed

- `apps/sandbox/src/python/python-core.browser.test.ts` — one added test (+40 lines); the only file
  touched. No production code, bootstrap, bundle, or config change.

## Tests added

- `keeps the embedder port out of reach of the interpreter realm` — runs a Python document on the shared
  warm page that enumerates `Object.getOwnPropertyNames(globalThis)` through the FFI, reads each value's
  JS constructor name via `Reflect.get`, and reports the names whose constructor is `MessagePort`.
  Asserts the global scan yields no hits. Covers A11's criterion (python has a standing realm probe).

Non-vacuity is built into the same run, not assumed:

- a **control object** created in the same Python run does hold a port (`js.MessageChannel.new().port1`);
  the test asserts the scan reports `CONTROL_HITS=['leaked']`, so a detector that could never fire fails
  the test;
- the test asserts the scan actually **read** constructor names off the real global
  (`GLOBAL_READ > 100`), so an FFI that threw on every property cannot pass by emptiness.

Observed values on the real global this run: `GLOBAL_NAMES=1226`, `GLOBAL_READ=1063`, `GLOBAL_HITS=[]`.
The 1226 figure matches the ~1225 prior probes reported; per the brief it is **not** asserted — only the
read-count floor is, so the test is not brittle against a Chromium version bump.

The `MessagePort` constructor function itself is present on the frame global and is correctly not a hit:
matching is on `value.constructor.name`, and the constructor function's own constructor is `Function`.

## Falsification run (the negative test seen failing)

Method: a **scratchpad route override**, no repo edit to any served file. `startSandboxOrigin()` accepts
an `ExtraRoute` that is consulted before the static `public/` tree, so `beforeAll` was temporarily
changed to serve `/python.js` as the real committed bytes plus
`;globalThis.__leakedPort = new MessageChannel().port1;`. Both the override and its `node:fs` import were
reverted afterwards; the final file diff contains only the test.

RED, for the right reason — the failure names the leaked global, and the control fired:

```
AssertionError: expected 'CONTROL_HITS=[\'leaked\']GLOBAL_NAMES…' to contain 'GLOBAL_HITS=[]'
Received: "CONTROL_HITS=['leaked']GLOBAL_NAMES=1226GLOBAL_READ=1063GLOBAL_HITS=['__leakedPort']"
 Test Files  1 failed (1)   Tests  1 failed | 11 passed (12)
```

GREEN after reverting the override, against the shipped bundle: `Tests 12 passed (12)`, the new test
65 ms.

## Self-gate

| Command (from `apps/sandbox`) | Result |
| --- | --- |
| `npx vitest run src/python/python-core.browser.test.ts` | pass — 12/12 (was 11/11) |
| `npx turbo test --filter=@hushbox/sandbox --force` (full package, coverage + pole gate) | pass — 17 files, **162 tests** (was 161), coverage 100/100/100/100 all files |
| `npx eslint src/python/python-core.browser.test.ts` (run after the last edit, from the package dir) | pass — exit 0 |
| `npx tsgo --noEmit` | pass — exit 0 |

## Pole check

Thresholds (`scripts/run-package-tests.ts`): a file is a pole iff wall ≥ 15,000 ms **and** > 50% of the
package's total test work. Both must hold.

| | before | after |
| --- | --- | --- |
| `python-core.browser.test.ts` wall | 3,165 ms | 3,237 ms (+72 ms) |
| share of package test work | 20.1% | 20.9% |
| package total test work | 15,742 ms | 15,461 ms |

Not a pole, and not near one: it is ~4.6× under the absolute floor and the largest file in the package is
still `render.browser.test.ts` (6,557 ms, 42.4%). The run reported no pole.

## Acceptance criteria

- **Standing test that the embedder port is unreachable from the Pyodide realm** — met. It runs on every
  `@hushbox/sandbox` test run, against the shipped `public/python.js`, in a real opaque-origin frame
  through the shared embed harness.
- **Probe from inside Python via the FFI, after the interpreter has loaded** — met. The scan is Python
  code executed by the interpreter via the normal `init`/`run` intake, not a JS `probeFrame` evaluation.
- **No hard-coded property count** — met (only `GLOBAL_READ > 100`).
- **Does not trip on the `MessagePort` constructor function** — met, and verified by the run passing while
  that constructor is present in the realm.
- **A3 respected** — met: no new harness code. The origin is the harness's `localhost`, waits poll from
  Node via `page.run` → `waitForMessage`, and no `page.evaluate` reaches into the frame (the observation
  channel is the bridge's own stdout).
- **Global Constraint 9 (no plan identifiers in shipped code/comments)** — met.
- **File ownership** — met: one file, nothing else.

## Deviations

None.

## Concerns and limitations

- The scan covers **own properties of `globalThis`**, matching the render test's shape. A port hidden
  behind a prototype chain, inside a nested object, or in a closure would not be found by either test.
  That is the invariant both were written to guard (the bundles are IIFEs; the risk being pinned is an
  accidental global assignment), not a general unreachability proof.
- `except Exception` skips properties whose read throws (SecurityError getters, primitives Reflect
  rejects). 163 of 1226 names were skipped this run. The `GLOBAL_READ` floor keeps a mass-skip regression
  from passing silently, but a port stored under a property whose *own read* throws would be missed —
  not a reachable configuration for document code either.
- Test-work share is measured on this machine; the pole gate recomputes per run.

## Confidence

High — the test was observed failing against a deliberately leaked port and passing against the shipped
bytes in the same session, the detector self-check fires in every run, and all four gates are green.
