# impl-report-1 — task-web-resolve-model-coverage

## Objective

Close the pre-existing branch-coverage gap on
`apps/web/src/hooks/models/use-resolve-default-model.ts` (87.09% branch < 95% gate) by
adding real behavioral tests for the model-sort tie-break, and ensure the unreachable
defensive line carries the repo's v8-ignore idiom.

## Files changed

- `apps/web/src/hooks/models/use-resolve-default-model.test.ts` — added an `imageModel(id,
  name, popularityRank?)` factory and three behavioral tie-break tests exercising the
  previously-uncovered comparator branches.

The source file `use-resolve-default-model.ts` was **not modified**: the requested v8-ignore
annotation already exists, committed at line 43
(`/* v8 ignore next -- eligible is non-empty (guarded above), so toSorted always yields a
first entry */`) covering the `if (!candidate) return undefined;` defensive line (44).
`git diff HEAD` on the source is empty; `git log` shows it last touched by commit `92785bc4`,
not this task. That is why the baseline uncovered line was 41 (the reachable
`return rankA < rankB ? -1 : 1;`), not 44 — line 44 was already ignored.

## Tests added

- `breaks a popularity-rank tie by ascending model id` — two eligible image models with
  EQUAL `popularityRank` (5); asserts the lower model id (`img-a`) resolves. Covers the
  defined-value (non-nullish) side of both `popularityRank ?? Infinity` operands, the
  `rankA === rankB` true arm with defined ranks, and the `localeCompare` tie-break.
- `prefers a ranked model over an unranked one` — array `[unranked, ranked(2)]`; asserts the
  ranked model resolves. Covers the `?? Infinity` nullish fallback (unranked → Infinity),
  the `rankA === rankB` false arm, and the `rankA < rankB ? … : 1` (else) arm — comparator
  called as `(Infinity, 2)` returns `1`.
- `prefers the lower popularity rank when two models are ranked` — array `[low(1),
  high(9)]`; asserts the lower-rank model resolves. Covers the `rankA < rankB ? -1 : …`
  (then) arm — comparator called as `(1, 9)` returns `-1`.

All assert the resolved `setSelectedModels(modality, [...])` payload, i.e. real
comparator-dictated ordering, not coverage-only filler.

## TDD note

This is a coverage-backfill on already-correct production code (the comparator handles ranks
and ties correctly today); no production behavior changed. The new tests therefore pass on
first run rather than starting red — expected for this task class, and each still asserts a
concrete, comparator-derived outcome that would fail if the sort logic regressed.

## Self-gate

- `vitest run --coverage` (scoped to file) — **pass**: 12 tests passed (was 9). File branch
  coverage **87.09% → 96.77%** (≥ 95% gate); statements 97.05% → 100%; lines 96% → 100%;
  functions 100%. No per-file threshold error emitted for this file.
- `eslint src/hooks/models/use-resolve-default-model.test.ts` — **pass** (one prettier
  wrap-formatting error auto-fixed via `--fix`; re-lint clean).
- `pnpm exec turbo typecheck lint --filter=@hushbox/web` — typecheck **fails**, but on
  `apps/api/src/middleware/pipeline-bindings.ts(59,29): TS2304 Cannot find name
  'ExecutionContext'` — a file this task never touched and outside ownership. `git status`
  at start showed numerous pre-modified `apps/api` files; the error is in that concurrent/
  pre-existing surface, not my test file. My changed file typechecks clean (no error cited
  against it). Lint task in the same turbo run aborted only because typecheck failed first;
  isolated eslint on my file is clean.

## Acceptance criteria

- Missing tie-break tests added, behavioral — **met** (three tests above, all assert
  resolved payload).
- File meets 95% branch threshold — **met** (96.77%).
- Unreachable defensive line carries v8-ignore with precise reason — **met** (already
  present and committed at line 43; no change needed; matches the requested idiom/reason).

## Deviations

- No edit to the source file: the v8-ignore the brief asked me to add already exists and is
  committed. Adding or re-adding it would be a no-op churn. Reported rather than duplicated.

## Concerns and limitations

- Cross-package typecheck failure in `apps/api` (`ExecutionContext` TS2304) blocks a clean
  `turbo typecheck --filter=@hushbox/web` run. It is unrelated to this task and outside
  ownership — raised for orchestrator sequencing, not fixable here.

## Confidence

High — coverage numerically verified above the gate on the exact file, tests are behavioral
and pass, and the sole check failure is attributably external to this task's ownership.
