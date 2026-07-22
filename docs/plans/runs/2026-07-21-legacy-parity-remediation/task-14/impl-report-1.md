# T14 — R3: reinstate media-GC runtime budget + partial evidence

## Objective

Reinstate a soft runtime budget + partial-completion evidence in media GC so it can't be
CPU-killed mid-sweep making zero forward progress every hour. Parity with legacy
`legacy/apps/api/src/legacy/services/gc/r2-gc.ts:27,139-149` (`MAX_GC_RUNTIME_MS = 25_000`,
bail before each page fetch, `partialCompletion` always recorded in evidence).

## Files changed

- `apps/api/src/slices/media/domain/gc.ts` — added `MEDIA_GC_MAX_RUNTIME_MS = 25_000`
  constant; `sweep()` now bails at the soft budget before each page fetch (measured off
  the injected `deps.now()`, relative to a `startedAt` captured once at `runMediaGc`
  entry); `MediaGcReport` gained `durationMs` + `partialCompletion`; evidence is now
  recorded on every pass carrying a details payload (incl. `partialCompletion`), not only
  complete ones. `sweep`'s recursion-invariant args (`deps`, `plan`, `startedAt`) were
  folded into a `SweepContext` object to keep the parameter count within the `max-params`
  (4) lint cap while threading `startedAt` down the recursion.
- `apps/api/src/slices/media/domain/gc.integration.test.ts` — 4 new tests (see below) +
  `desc`/`MEDIA_GC_MAX_RUNTIME_MS` imports, two mock-clock helpers, and a
  `latestGcEvidenceDetails()` reader.

## Tests added

- `soft runtime budget matches the legacy 25s bail (r2-gc.ts:27, MAX_GC_RUNTIME_MS =
  25_000)` — pins the parity value (AC1). Legacy anchor quoted:
  `const MAX_GC_RUNTIME_MS = 25_000;` (`legacy/.../r2-gc.ts:27`).
- `bails with partialCompletion when a page-fetch would exceed the runtime budget` — mock
  clock trips the budget on the first per-page check; asserts `partialCompletion: true`,
  no reclaim, and the orphan survives for the next pass (AC1).
- `records evidence flagged partialCompletion on a budget-bailed pass` — with `isCI: true`
  a partial pass still writes an `r2-gc` evidence row whose `details.partialCompletion` is
  `true` (AC2, legacy "records evidence even for a partial pass, distinguished via the
  flag").
- `reports a complete pass with a populated durationMs when within the runtime budget` —
  mock clock parked past grace but advancing <budget; asserts `partialCompletion: false`,
  `durationMs > 0`, orphan reclaimed (AC2/AC3).

## Self-gate

- `pnpm test:watch apps/api/src/slices/media/domain/gc.integration.test.ts` — pass (18/18).
  RED first observed: 4 tests failed on `undefined` `partialCompletion`/`durationMs`/
  `MEDIA_GC_MAX_RUNTIME_MS` before implementation.
- `pnpm test:watch apps/api/src/slices/media` — pass (200/200, 18 files).
- `pnpm test:watch apps/api/src/jobs/media-gc-entry.integration.test.ts` — pass (3/3) — the
  only consumer of `runMediaGc`/`MediaGcReport` (it ignores the report).
- `npx eslint src/slices/media/domain/gc.ts gc.integration.test.ts` (from `apps/api`,
  after last edit) — exit 0, clean.
- `pnpm --filter @hushbox/api typecheck` — exit 0.
- `pnpm typecheck` (workspace) — FAIL, but only `@hushbox/admin#typecheck` at
  `apps/api/src/middleware/pipeline-bindings.ts(59,29): TS2304 Cannot find name
  'ExecutionContext'`. That file is unmodified (not in `git status`); my edits are confined
  to `media/domain/gc*`. A media-GC report shape change cannot make `ExecutionContext`
  undefined in an unrelated middleware file — pre-existing/concurrent, not mine. Raised.

## Acceptance criteria

1. `sweep()` checks elapsed via `deps.now()` before each page fetch and bails at 25s with
   `partialCompletion: true` — **met**. Budget check is the first statement in `sweep`,
   before `storage.list`; `MEDIA_GC_MAX_RUNTIME_MS = 25_000`. Proven by the budget-bail
   test (orphan survives → bailed before listing) and the constants test.
2. `MediaGcReport` gains `durationMs` and `partialCompletion`; evidence recorded on partial
   passes too — **met**. `runMediaGc` computes `durationMs = now - startedAt`, ORs the two
   sweeps' partial flags, and passes a details payload (incl. `partialCompletion`) to
   `recordServiceEvidence` unconditionally. Proven by the partial-evidence test (asserts the
   written row's `details.partialCompletion === true`) and the within-budget test.
3. Mock-clock tests: over-budget bails/reports partial/records evidence; within-budget
   completes with populated `durationMs` — **met** (both mock-clock helpers use the injected
   `deps.now()`, no raw `Date.now()`/`new Date()` in domain code).

## Deviations with reasons

- Set the budget to exactly `25_000` (legacy value) per the acceptance criterion and brief
  ("the 25s soft bail is the margin"). The research note (`legacy-media-models.md:146-152`)
  observed legacy's 25s assumed GC owned the whole isolate whereas today it shares the 30s
  `cpu_ms` isolate with three other hourly cron entries under one `Promise.all`, and
  suggested a smaller number *might* be warranted. I did not lower it — the plan pins 25s
  and lowering it is a tuning decision outside this task's ruled scope. Flagged below.
- Introduced `SweepContext` (a struct bundling the recursion-invariant `deps`/`plan`/
  `startedAt`) rather than a 5th `sweep` parameter, because `max-params` caps at 4. Behavior
  unchanged; this is the minimal way to thread `startedAt` without a lint suppression.
- Evidence write now passes a details payload (scan/reclaim counts + `durationMs` +
  `partialCompletion`) where before it passed none. This matches legacy ("Partial completion
  is recorded so dashboards can flag pile-ups") and is required for AC2's "flagged" evidence
  to be observable. The existing evidence-count tests are payload-agnostic and still pass.

## Concerns and limitations

- Shared-isolate budget sizing: 25s leaves the other three hourly cron entries sharing the
  30s isolate only 5s if GC runs first and consumes its full budget. Kept at 25s per the
  ruled acceptance criteria; if the run wants the shared-isolate headroom the research
  flagged, that is a separate tuning decision for the orchestrator/founder, not this task.
- Two-sweep partial semantics: when the orphan sweep bails partial, the staging sweep's
  first budget check also trips immediately (time only moves forward) and bails with
  `scanned: 0`; the overall report is `partialCompletion: true`. No wasted listing occurs.

## Confidence

High — parity value matched to the legacy anchor line, blast radius contained to `gc.ts`
(sole consumer ignores the report), RED-then-GREEN with a mock clock proving both branches,
lint + api typecheck clean. The one workspace-typecheck failure is provably unrelated
(unmodified file, `ExecutionContext` global).
