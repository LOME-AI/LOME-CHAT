# impl-report-2 — Task-36 revert of per-project worker caps

## Objective

Revert the per-project `workers` overrides Task-36 added to the `iphone-15`, `pixel-7`, and
`ipad-pro` project blocks in `playwright.config.ts`. Founder ruling: legacy ran these e2e
tests at 12 workers with zero flakes, so throttling is the wrong fix. Keep the earlier
top-level worker pin and the firefox caps untouched.

## Files changed

- `playwright.config.ts` — removed the three per-project `workers: isCI ? 4 : '25%'`
  overrides (and their explanatory comments) from the `iphone-15`, `pixel-7`, and `ipad-pro`
  project blocks. Those three projects now inherit the top-level `workers` again.

## Tests added

None. This is a config revert restoring prior behavior; no TDD per the brief.

## Self-gate

- `npx prettier --check playwright.config.ts` — pass — exit 0 ("All matched files use
  Prettier code style").
- `pnpm typecheck` — pass — exit 0 (15/15 turbo tasks successful).
- `pnpm lint` — fail — exit 1, but the sole error is **outside this task's ownership**:
  `apps/api/src/app.ts:388:34` prettier/prettier. `apps/api/src/app.ts` is an
  independently-modified file (`git status` shows `M` — another task's uncommitted work);
  I did not touch it. My owned file `playwright.config.ts` passes prettier cleanly (see
  above) and lints clean. No lint rule flags my change.

## Acceptance criteria

- Per-project caps removed from all three mobile projects — met. `grep -n "workers"
  playwright.config.ts` shows only: line 50 (top-level `isCI ? 7 : E2E_WORKER_POOL_SIZE`),
  line 150 and line 245 (firefox / setup-firefox `isCI ? 4 : '30%'`, pre-existing). The
  three mobile project blocks have no `workers` field.
- Top-level pin, `E2E_WORKER_POOL_SIZE` import, and firefox caps preserved — met.
- Final `git diff -- playwright.config.ts` shows ONLY the earlier top-level pin change
  (workers → `E2E_WORKER_POOL_SIZE`, its comment, the import) and no per-project caps on the
  three mobile projects — met (verified).

## Final diff (playwright.config.ts)

```diff
@@ import
+import { E2E_WORKER_POOL_SIZE } from './scripts/lib/seed-personas';
@@ top-level config
-  workers: isCI ? 7 : '50%',
+  // Pinned to the persona pool size ... (comment block)
+  workers: isCI ? 7 : E2E_WORKER_POOL_SIZE,
```

The three per-project `workers: isCI ? 4 : '25%'` additions and their comments are gone;
diff no longer touches the mobile project blocks.

## Deviations with reasons

None.

## Concerns and limitations

- `pnpm lint` does not exit clean, but strictly due to a pre-existing prettier error in
  `apps/api/src/app.ts` owned by another task — not caused by and not fixable within this
  task's scope.

## Confidence

High — surgical revert, diff matches the brief's expected end state exactly; prettier and
typecheck clean; the only lint error is provably in another task's file.
