# impl-report-1 — split2-edge

## Objective

Split `apps/api/src/slices/identity/routes-edge.integration.test.ts` (a ~187s coverage
pole, 27 tests across 4 top-level describes) into 2 cohesive sibling files, each importing
the UNCHANGED `./routes.integration.setup.ts`, so they parallelize on separate workers.
Behavior-preserving: every test survives with identical name/body; coverage unchanged.

## Files changed

- `apps/api/src/slices/identity/routes-edge.integration.test.ts` — rewritten to keep only
  the two edge-states describes: "identity routes: edge states for coverage" (10 tests) +
  "identity routes: more edge states for coverage" (9 tests) = 19 tests. Imports left
  identical to the original (this half uses every original import).
- `apps/api/src/slices/identity/routes-timing-store.integration.test.ts` — new file holding
  "identity routes: enumeration timing" (3 tests, incl. the real `performance.now()`
  sampling, moved verbatim) + "identity routes: store-outcome and decode edges" (5 tests) =
  8 tests. Imports trimmed to only what this half uses (no unused imports; type imports
  none needed).

Original file name reused for the edge half, so no file was orphaned/removed.

## Split axis

Kept each of the 4 describe blocks whole. File A (edge) = 10 + 9 = 19; File B
(timing+store) = 3 + 5 = 8. Balance is secondary to intact describes per the brief.

The "enumeration timing" describe (real `performance.now()` medians, WARMUP/interleave
logic) was moved verbatim into File B — no line altered.

## Imports (File B trimmed set)

File B uses: vitest (describe/expect/it); `eq` (drizzle-orm); `users` (@hushbox/db); crypto
(`OPAQUE_SERVER_IDENTIFIER`, `createOpaqueClient`, `finishLogin`, `finishRegistration`,
`generateTotpCodeSync`, `startLogin`, `startRegistration`); `ERROR_CODES` (@hushbox/shared);
setup (`PREFIX`, `db`, `enrollTotp`, `expectStatus`, `login`, `post`, `registerAccount`,
`registerLoginFull`, `sessionCookieOf`, `stepUpKe3`). Dropped (unused in File B):
`Hono`, `applyPipeline`, `errAsync`, `unavailableError`, `IDENTITY_KEYS`,
`checkSessionRevocation`, `createIdentityManifest`, `createIdentityStores`, `KEY_BLOBS`,
`NEW_WRAPPED_KEY`, `emailPortFailure`, `get`, `manifestDeps`, `redis`, `testEnv`,
`wrongCode`, and the `AppEnv`/`IdentityStores` type imports.

## Self-gate

- `grep -cF "  it(" routes-edge...` — 19; `routes-timing-store...` — 8. Sum = 27. pass.
- `describe` blocks: edge file has the 2 edge describes; timing-store file has enumeration
  timing + store-outcome. All 4 original describes present exactly once across the pair. pass.
- `git status` confirms `routes.integration.setup.ts` untouched (not in the modified set). pass.
- `pnpm ensure-stack` — pass (stack ready).
- `tsx scripts/with-env.ts vitest run --root apps/api <the 2 files>` — **pass**: Test Files
  2 passed (2); Tests 27 passed (27); Duration 24.49s (vs ~187s pole — parallelized).
- `turbo typecheck lint --filter=@hushbox/api`: typecheck **pass** (1 successful). Package
  lint **failed** with `ENOENT: ... routes-deletion.integration.test.ts` — a file this task
  never touched, deleted by a concurrent sibling split task mid-run (git status shows it as
  `D` plus new `routes-deletion-execute`/`routes-deletion-gate`/`routes-2fa-disable`/
  `routes-revocation` unstaged files from other in-flight tasks). Attributed to concurrent
  work, not this task. Direct lint of only my two files from the package dir
  (`pnpm exec eslint <both files>`) exits 0 — clean.

Note: the brief anticipated a `pipeline-bindings.ts` ExecutionContext typecheck error from
other in-flight work; typecheck was clean this run, so it did not appear.

## Acceptance criteria

- Split into 2 cohesive sibling files, each importing unchanged setup — **met** (both import
  `./routes.integration.setup.js`; setup file unmodified).
- Each describe kept whole; 2 balanced-ish files — **met** (19 / 8; describes intact).
- Behavior-preserving, every test identical name/body — **met** (bodies copied verbatim;
  27/27 green).
- Enumeration timing moved verbatim — **met** (real `performance.now()` sampling unaltered).
- No describe/test dropped; original name reused (no orphan) — **met** (4 describes, 27 tests
  total across the pair).
- No unused imports; type imports last — **met** (File A keeps all-used original import block
  with type imports last; File B trimmed, no type imports needed).
- Files parallelize on separate workers — **met** (2 test files → 2 workers; 24.49s wall).

## Deviations

None.

## Concerns and limitations

- The package-wide `lint`/`typecheck` gate cannot be run cleanly to completion while sibling
  split tasks are concurrently deleting/adding files in `src/slices/identity/`; the ENOENT is
  a file-discovery race on another task's deleted file. My two files lint clean in isolation.
  Orchestrator should re-run the package lint gate once all concurrent identity-split tasks
  settle.

## Confidence

high — 27/27 tests green on a clean stack run; typecheck clean; both files lint clean in
isolation; setup untouched; the only gate failure is provably from concurrent sibling work.
