# P3 — Showcase documents worth showing

## Objective

Make the seeded document showcase demonstrate real capability, add the missing `js`-kind
document, and label the two intentional failures as intentional without changing how they break.

## Files changed

- `scripts/lib/seed-documents.ts` — replaced the HTML, React and Python documents with small
  applications, added a `js` document, relabelled both failure documents, rewrote the lead-ins
  and the opening user prompt.
- `scripts/lib/seed-documents.test.ts` — new assertions for the `js` document, the richer HTML /
  React / Python documents, the deliberate-failure labelling, and the npm-specifier allowlist;
  index-based lookups replaced by a named `POSITIONS` map so document order lives in one place.

## The documents

| Constant           | Kind      | Lines | What it is                                                                          |
| ------------------ | --------- | ----: | ----------------------------------------------------------------------------------- |
| `HTML_LIFE`        | `html`    |   255 | Conway's Game of Life: canvas, toroidal grid, age-coloured cells, four seed patterns (Gosper gun, pulsar, R-pentomino, random soup), play/step/clear, pointer drawing, live generation / alive / born / died counters |
| `REACT_BUDGET`     | `jsx`     |   267 | Run-rate dashboard: `useReducer` entry list, `useMemo` aggregates, inline-SVG donut, animated category bars, budget slider, validated add-form, four components, confetti on crossing under budget |
| `JS_SORTING_LAB`   | `js`      |   226 | Sorting visualiser: four algorithms as generators, stepped one comparison at a time, DOM built with `createElement`, algorithm/speed/shuffle controls, comparison and swap counters |
| `PYTHON_ANALYSIS`  | `python`  |    58 | Twelve weeks × four regions: per-region totals, averages, growth, least-squares trend and R² printed as an aligned table; two-panel figure (series + trend, totals with mean line) |
| `MERMAID_FLOW`     | `mermaid` |    15 | Unchanged — still accurate about the extraction rules                                |
| `REACT_COMPILE_ERROR` | `jsx`  |    22 | Unchanged breakage; relabelled                                                       |
| `REACT_RUNTIME_ERROR` | `jsx`  |    23 | Unchanged breakage; relabelled                                                       |
| `UNTAGGED_LOG`     | (none)    |    16 | Unchanged                                                                            |

`MIN_LINES_FOR_DOCUMENT` is 15; every block clears it, mermaid included.

## How each document was verified to run (criterion 4)

A scratchpad harness executes each document exactly the way the frame does — the repo's installed
Sucrase (`apps/sandbox/src/render/transpile.ts`), the repo's real specifier rewrite
(`resolve-imports.ts` + `react-runtime.ts`), real `esm.sh` imports, and the real vendored Pyodide
distribution — inside headless Chromium, with `pageerror` / `console.error` collected. Command:

```
npx tsx <scratchpad>/verify-documents.ts
```

Results (last run, after the final edit):

| Document | Executed as | Result |
| --- | --- | --- |
| `html` | `root.innerHTML = code` + script re-creation (mirrors `renderHtml`) | OK, 26 elements; after 700 ms the readouts showed `generation 7 alive 48 born 122 died 110` — the simulation is genuinely running |
| `react` | `transpileReact` → `rewriteBareImports` → blob module import → `createRoot(...).render` with `onUncaughtError` | OK, 88 elements; clicking the contractor row's remove button recomputed to `spending $1,150 / budget $1,800 / left over $650` and canvas-confetti appended its canvas (1 canvas) — reducer, memos and the npm package all exercised |
| `js` | `rewriteBareImports` → blob module import (mirrors `renderJs`) | OK, 72 elements; after 700 ms `comparisons 143 swaps 121 status sorting` |
| `python` | real Pyodide from `apps/sandbox/public/pyodide` with `MPLBACKEND=Agg`, `loadPackagesFromImports`, then figure collection | OK, one 55,653-byte PNG; full table printed (`North 2039 169.9 93.3% 9.8 0.979`, …) |
| `compile failure` | same react path | Fails as intended: `TranspileError: SyntaxError: Unexpected token (18:20)` |
| `runtime failure` | same react path | Fails as intended: `TypeError: Cannot read properties of undefined (reading 'accent')` |

## npm packages and their resolution

The rewrite output was printed from the actual document sources, then each URL was fetched:

| Document specifier | Rewritten to | HTTP |
| --- | --- | --- |
| `react` (hooks only) | `https://esm.sh/react@19.1.0` (via `REACT_PINS`) | 200 `application/javascript` |
| `canvas-confetti` | `https://esm.sh/canvas-confetti` | 200 `application/javascript` |
| (runtime, not authored) `react-dom/client` | `https://esm.sh/react-dom@19.1.0/client` | 200 `application/javascript` |

Because the document's `react` import and the bootstrap's own runtime import resolve to the same
pinned URL, there is one React instance and hooks work — confirmed by the tree mounting rather than
throwing an invalid-hook-call. A new test pins the bare-specifier set to exactly these two, so an
unverified import cannot be added silently.

No document fetches anything at runtime: no `fetch`, no XHR, no remote images or fonts, no WebRTC.
All visuals are inline SVG, canvas, CSS gradients and system fonts.

## Intentional failures — breakage unchanged

Both documents keep their exact defect. Only the first declaration (which is what the panel turns
into the card title) and the prose changed:

- compile failure: first declaration is now `failsToCompileOnPurpose`; still exactly one `<div>`
  and no `</div>`; still rejected by Sucrase.
- runtime failure: first declaration is now `failsToMountOnPurpose`; `config` and the
  `config.palette.accent` read are untouched; still one balanced `<section>`; still throws on mount.

The pinning tests (`leaves a JSX tag unclosed…`, `reads through an undefined property…`) are
unmodified and pass.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch scripts/lib/seed-documents.test.ts` | pass — 18 tests |
| `pnpm test:watch scripts/seed.test.ts` (the consumer suite) | pass — 30 tests |
| `npx eslint lib/seed-documents.ts lib/seed-documents.test.ts` (run from `scripts/`, after the last edit) | pass — exit 0 |
| `npx turbo typecheck lint --filter=@hushbox/scripts --force` | pass — 2/2 tasks |

Coverage is structurally unchanged: `seed-documents.ts` gained only string constants, no new
functions or branches; its single function (`fenced`) still runs at module load.

## Acceptance criteria

1. **Failures labelled as deliberate — met.** Card titles derive from the first declaration
   (`extractCodeTitle` in `apps/web/src/lib/document-parser.ts`), so both were renamed to
   `failsToCompileOnPurpose` / `failsToMountOnPurpose`; both lead-ins open with "Broken on purpose";
   both bodies say so in rendered prose. A test pins the `OnPurpose` suffix and the lead-in wording.
   Breakage unchanged — the two original pinning tests still pass, and the harness still reproduces
   both failures with the same errors.
2. **`js` document added — met.** `JS_SORTING_LAB`, fenced as `js`, exercises `renderJs`; verified
   running in the harness.
3. **HTML / React / Python replaced with capable programs — met, with one deviation.** All three are
   multi-part applications with real state. The Python one does genuine analysis (least-squares fits,
   R², growth, aggregates, two-panel figure) but uses **numpy only — pandas is not installable in
   this sandbox** (see deviations).
4. **Every document runs — met.** Table above; each verified by execution, not inspection.
5. **Line threshold and existing tests — met.** Smallest non-mermaid block is 16 lines; all existing
   seed tests pass, plus `scripts/seed.test.ts`, which compares the whole transcript.
6. **Sandbox constraints respected — met.** No network access from any document; npm imports resolve
   through esm.sh (verified 200); nothing depends on WebRTC, storage, cookies, or workers.

## Deviations

- **Criterion 3's "pandas alongside matplotlib" is not implemented; the Python document uses numpy
  only.** pandas cannot run in this sandbox from anything inside my file ownership:
  - `apps/sandbox/public/pyodide/` vendors 13 wheels (numpy, matplotlib and its deps, micropip).
    There is no pandas wheel, and `apps/sandbox/scripts/fetch-pyodide.sh` — the committed, pinned
    fetch list — does not fetch one.
  - Verified empirically in real Pyodide: `import pandas` →
    `ModuleNotFoundError: The module 'pandas' is included in the Pyodide distribution, but it is not
    installed.` `micropip.install("pandas")` returns without raising and the import still fails the
    same way (its wheel 404s against `indexURL`, and PyPI has no emscripten build).
  - The out-of-scope fix is one line in `apps/sandbox/scripts/fetch-pyodide.sh` plus a re-fetch:
    pandas' declared deps (numpy, python-dateutil, pytz) are already vendored, so only the ~12 MB
    pandas wheel is missing. Not made — that file is outside this task's ownership.
- **One existing assertion was narrowed.** `expect(react).not.toMatch(/from ['"]react['"]/)` became
  `expect(react).not.toMatch(/import\s+(?:React|\*)/)`. A stateful component must import its hooks
  from `react`; the property the original assertion protected (the automatic JSX runtime means no
  React namespace import is needed) is still pinned, and the hook import resolves to the same pinned
  URL the renderer uses, so there is still exactly one React instance.

## Concerns and limitations

- The runnability guarantee is **out-of-band**: the shipped test suite pins structure and the
  npm-specifier allowlist, but nothing in CI transpiles these documents. `sucrase` is a dependency of
  `@hushbox/sandbox` only, so a permanent guard would need `sucrase` added as a devDependency of
  `@hushbox/scripts` — a package.json change outside this task's ownership.
- `docs/DOCUMENTS.md` states that Python imports load "from the bundled distribution
  (numpy/pandas/matplotlib and the rest of Pyodide's package set)". That is stale: only the 13
  vendored wheels load; the other 341 packages in `pyodide-lock.json` 404. It likely explains why the
  plan asked for pandas.
- `scripts/.cache/seed-crypto.json` is **not** invalidated by this change — its cache key is the
  persona OPAQUE/crypto material, not message content. Checked, no regeneration needed.
- The documents paint their own dark palettes rather than following the app theme. A cross-origin
  document cannot read the app's CSS variables, and P1's theme init styles the frame's canvas, not
  the document's own elements — a self-contained palette is what a model-generated document does and
  is theme-independent by construction.

## Confidence

**High** — every document was executed, not inspected: four run and animate/compute with observed
output, and the two intentional failures reproduce with their original errors. The only unmet item is
the pandas parenthetical, which is impossible from this task's file ownership and is evidenced above.
