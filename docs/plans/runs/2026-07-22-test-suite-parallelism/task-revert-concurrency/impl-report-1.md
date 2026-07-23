# impl-report-1 — revert intra-file test-concurrency from vitest configs

## Objective

Manually remove the intra-file test-concurrency mechanism from 6 vitest config files,
returning each to its `HEAD` state. Manual edits only — no git write commands.

## Files changed (all reverted to HEAD)

- `packages/config/vitest.config.ts` — four edits:
  1. Import: `import { defineConfig, mergeConfig } from 'vitest/config';` → `import { defineConfig } from 'vitest/config';`
  2. Deleted the two `test:` block lines `sequence: { concurrent: true },` and `maxConcurrency: 12,` (kept `...coverageWorkerCap,` and `retry: 1,`).
  3. `const rootConfig = defineConfig({` → `export default defineConfig({`
  4. Deleted the trailing block: blank line, `export default rootConfig;`, the `// Browser-env packages …` comment paragraph, and the `export const browserConfig = mergeConfig(rootConfig, defineConfig({ test: { sequence: { concurrent: false } } }));` export. File now ends at the main config's `});`.
- `apps/web/vitest.config.ts` — import `{ browserConfig, BROWSER_TEST_ENVIRONMENT }` → default `rootConfig, { BROWSER_TEST_ENVIRONMENT }`; mergeConfig base arg `browserConfig,` → `rootConfig,`.
- `apps/admin/vitest.config.ts` — same two edits (mergeConfig base is the `const merged` assignment).
- `apps/marketing/vitest.config.ts` — same two edits.
- `apps/crawler-view/vitest.config.ts` — same two edits (`const merged`).
- `packages/ui/vitest.config.ts` — same two edits.

## Self-gate

- `git diff HEAD -- <the 6 files>` — **empty** (exit 0, no output). Proves exact byte-for-byte revert to HEAD across all 6.
- `grep -rn "browserConfig\|sequence.*concurrent\|maxConcurrency" packages/config/vitest.config.ts apps/*/vitest.config.ts packages/ui/vitest.config.ts` — **no matches** (exit 1). No lingering references to the removed mechanism.
- `pnpm exec turbo typecheck --filter=@hushbox/config --filter=@hushbox/web` — `@hushbox/config` **passed**. `@hushbox/web` **failed**, but only on files outside my ownership and unrelated to vitest config:
  - `apps/web/src/components/chat/input/reasoning-effort-rail.tsx(198)` — `Object is possibly 'undefined'`. This file is a pre-existing uncommitted modification (in the startup `git status` M-list; `git status --short` confirms `M`). Not touched by this task; it is another (reasoning-effort) task's work.
  - `apps/api/src/middleware/pipeline-bindings.ts(59)` — `Cannot find name 'ExecutionContext'`. Cross-package error surfaced by web's typecheck; apps/api is a concurrent task's area. Not touched by this task.
  - Attribution: my edits changed only import specifiers inside `vitest.config.ts` files, which are not imported by any product source and are not part of the tsc program that raises these errors. The failures reproduce independent of my changes.
- `cd apps/crawler-view && pnpm exec vitest run` — **16 files, 130 tests, all passed** (3.07s). Confirms suites load and run serially with the reverted config; no concurrency-related failures.

## Acceptance criteria

- All 6 files reverted to HEAD (`git diff HEAD` empty) — **met**.
- No `browserConfig` / `sequence.concurrent` / `maxConcurrency` references remain — **met** (grep clean).
- `@hushbox/config` typecheck passes — **met**. `@hushbox/web` typecheck failure attributed to two out-of-scope, pre-existing/concurrent files (see above) — **met** insofar as no failure traces to this task's edits.
- crawler-view runs green serially — **met** (130/130).

## Deviations

None.

## Concerns and limitations

- `@hushbox/web` typecheck does not pass on its own right now due to two out-of-scope
  files being actively edited by other tasks (reasoning-effort-rail.tsx, pipeline-bindings.ts).
  This is not introduced by, nor fixable within, this task. Raised to the orchestrator.
- Did not touch `scripts/run-package-tests.ts` (owned by another in-flight task), per brief.

## Confidence

high — `git diff HEAD` empty across all 6 files is the strongest possible proof of an
exact revert; grep clean; crawler-view green; the only typecheck failure is fully
attributed to unowned files.
