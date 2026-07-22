# T25 — GC budget (ruled: shrink) — impl report 1

## Objective
Lower `MEDIA_GC_MAX_RUNTIME_MS` from legacy's 25s to 15s, leaving ~15s of the shared
30s `cpu_ms` cron isolate for the three co-running auditors (GC no longer owns the
isolate as legacy assumed). Only the threshold value + its durable comment change; bail
mechanism, `partialCompletion`, evidence-on-partial, and `durationMs` are unchanged.

## Files changed
- `apps/api/src/slices/media/domain/gc.ts` — `MEDIA_GC_MAX_RUNTIME_MS` 25_000 → 15_000;
  durable comment rewritten to state the 15s is a DELIBERATE shared-isolate margin (GC
  shares the 30s `cpu_ms` isolate with the ledger-conservation + snapshot-drift auditors
  under one `Promise.all`), no longer strict legacy parity (legacy's 25s assumed sole
  isolate ownership).
- `apps/api/src/slices/media/domain/gc.integration.test.ts` — the single hardcoded
  constant-assertion test updated from `toBe(25_000)` (legacy-parity framing) to
  `toBe(15_000)` (shared-isolate-margin framing). No other test hardcodes the value —
  the bail/within-budget clocks reference `MEDIA_GC_MAX_RUNTIME_MS` symbolically, so
  they track the new value automatically.

## Tests added / changed
- `soft runtime budget is the shared-isolate margin of 15s (below legacy 25s, which
  assumed sole isolate ownership)` — asserts the constant is now `15_000`. Watched fail
  RED first (`expected 25000 to be 15000`) against the un-changed source, then GREEN.
- Pre-existing symbolic bail tests continue to pin behavior against the new value:
  - `bails with partialCompletion when a page-fetch would exceed the runtime budget` —
    `budgetExceededClock` advances `MEDIA_GC_MAX_RUNTIME_MS + 1000` (= 16s > 15s) on the
    second read → sweep bails with `partialCompletion: true`. GREEN.
  - `records evidence flagged partialCompletion on a budget-bailed pass` — GREEN.
  - `reports a complete pass with a populated durationMs when within the runtime budget`
    — `withinBudgetClock` advances ~10ms/read (well under 15s) → completes,
    `partialCompletion: false`. GREEN.

## Self-gate
- `pnpm test:watch apps/api/src/slices/media/domain/gc.integration.test.ts` — pass — 18
  passed (18). (Required `pnpm db:up` + `pnpm db:migrate` first — stack was down and
  `service_evidence` unmigrated; both infra, not code.)
- `npx eslint src/slices/media/domain/gc.ts gc.integration.test.ts` (from `apps/api`,
  after last edit) — pass — exit 0.
- `pnpm typecheck` — fail, but the ONLY error is
  `apps/api/src/middleware/pipeline-bindings.ts(59,29): error TS2304: Cannot find name
  'ExecutionContext'`. Attributed OUT: that file is unmodified in the working tree (not
  in `git status`; pre-existing in committed code), the error is unrelated to a numeric
  constant + comment change in a different file, and the brief explicitly named
  `pipeline-bindings.ts` to attribute out. My two owned files are the only modifications
  and neither is reported by typecheck.

## Acceptance criteria
- Constant now `15_000` — met (gc.ts:56).
- Durable comment states DELIBERATE shared-isolate margin, names the co-runners
  (ledger-conservation + snapshot-drift under `Promise.all`), and marks it as no-longer
  strict legacy parity (legacy's 25s assumed sole isolate ownership) — met (gc.ts:45-55).
- Mock-clock test proves a sweep past 15s bails with `partialCompletion: true` and a
  within-15s sweep completes — met (symbolic bail/within-budget tests, both GREEN).
- Bail/report/evidence/`durationMs` logic otherwise unchanged — met (only the constant
  literal and its comment changed; `sweep`/`reclaim`/`deleteIsolated`/report shape
  untouched, diff confirms).

## Deviations
None. One-constant tuning as ruled.

## Concerns and limitations
- None on the change itself. The pre-existing `pipeline-bindings.ts` `ExecutionContext`
  typecheck error blocks a clean repo-wide `pnpm typecheck`; it is outside this task's
  ownership and was flagged for attribution in the brief.

## Confidence
High — a single founder-ruled constant change on top of T14's clean work; RED watched
before GREEN; full colocated suite (18/18) green with the stack up; the only gate miss
is an unrelated, brief-named, unmodified file.
