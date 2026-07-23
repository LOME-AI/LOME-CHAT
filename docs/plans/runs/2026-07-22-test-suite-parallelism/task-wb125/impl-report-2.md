# impl-report-2 — Task WB125 fix (remove false `maxConcurrency` log field)

## Objective
The worker-budget wrapper's allocation log line printed a now-false `maxConcurrency=12`
field. The global `sequence.concurrent`/`maxConcurrency:12` was reverted out of
`packages/config/vitest.config.ts`; vitest no longer sets any maxConcurrency and the wrapper
never passed `--maxConcurrency` to vitest — it only printed the value. Remove the token and
delete the now-unused `MAX_CONCURRENCY` constant.

## Files changed
- `scripts/run-package-tests.ts` — deleted `const MAX_CONCURRENCY = 12;` (line 26) and dropped
  the ` · maxConcurrency=${String(MAX_CONCURRENCY)}` suffix from the allocation log line
  (~line 236). Log line is now `[<pkg>] scope=<s> · work-share=<share> · workers=<n>`.
- `scripts/run-package-tests.test.ts` — removed the ` · maxConcurrency=12` suffix from the 5
  log-line expectations the audit named (235, 275, 290, 298, 304). `eslint --fix` (prettier)
  then collapsed the newly-shortened multi-line `expect(...).toHaveBeenCalledWith(...)` calls
  onto single lines.

## Grep / non-functional verification
- `MAX_CONCURRENCY` had exactly two references, both non-functional (the constant declaration
  and the print). Nothing else in `scripts/`, `packages/config/`, or the repo referenced it.
- The vitest args are unchanged and never contained a maxConcurrency flag:
  `['run', '--coverage', `--maxWorkers=<n>`, ...passthrough]` plus, on full runs,
  `--reporter=default --reporter=json --outputFile.json=...`. Confirmed by reading the
  `vitestArgs` construction and by the passing `exec` assertions.
- `grep -n "maxConcurrency\|MAX_CONCURRENCY" scripts/run-package-tests.ts` → NONE.

## Tests changed (TDD)
No test cases added; 5 existing log-line expectations updated to the new line. Watched RED
first against the current source: `pnpm test:watch scripts/run-package-tests.test.ts` →
4 failed / 21 passed, each failure the expected diff (received string still carried
`· maxConcurrency=12`; the 5th and 6th assertions share one test, so 5 assertions → 4 failed
tests). Removed the token from source → GREEN: 25/25.

## Self-gate
- `pnpm test:watch scripts/run-package-tests.test.ts` — pass, 25/25 (coverage-free watch mode).
- File coverage via `coverage/coverage-final.json` (authoritative — from a
  `vitest run --coverage` on the file, `success:true`, 25/25): `run-package-tests.ts` =
  statements 72/72, functions 11/11, branches 21/21 = **100%**, no uncovered lines. (72 vs the
  prior 73 statements: the deleted constant line is gone; everything remaining is covered.)
- `cd scripts && pnpm typecheck` (tsgo --noEmit) — pass, no errors.
- `cd scripts && npx eslint --fix run-package-tests.ts run-package-tests.test.ts` — pass,
  "No issues found" (initial run flagged 5 prettier/prettier line-length issues from the
  shortened expectations; `--fix` reformatted them; no logic touched).

## Acceptance criteria (validated finding)
- `maxConcurrency` token removed from the allocation log line — MET (grep NONE; log line ends
  at `workers=<n>`).
- `MAX_CONCURRENCY` constant deleted, nothing else references it — MET (grep NONE repo-wide).
- Wrapper still never passes `--maxConcurrency` to vitest — MET (unchanged `vitestArgs`; exec
  assertions green).
- Colocated test expectations updated TDD-style (fail first) — MET (RED 4/25 observed → GREEN
  25/25).
- Coverage intact — MET (100% per the coverage map).

## Deviations
None.

## Concerns and limitations
- Ran the file-scoped colocated suite only, not the whole `scripts` package suite — per
  report-1 the full `scripts` run self-invokes the wrapper and hangs under the pre-existing
  global-concurrency flaky-red state, which is outside this task's ownership. This change is
  print-only and cannot affect it.

## Confidence
High — a two-line deletion (constant + log token) fully pinned by the colocated suite
(RED→GREEN observed), 100% file coverage, clean tsgo typecheck and eslint, and grep confirming
no residual references and no maxConcurrency flag ever reaching vitest.
