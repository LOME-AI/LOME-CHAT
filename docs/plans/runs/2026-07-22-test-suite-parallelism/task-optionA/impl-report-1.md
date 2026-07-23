# impl-report-1 — task-optionA: browser-env serial-within-file preset

## Objective

Make the 5 browser-env vitest packages run tests serially-within-file (`sequence.concurrent:false`) via ONE shared preset in `packages/config/vitest.config.ts`, while node-env packages (api) keep the concurrent default. Config-only; no per-test-file edits.

## Files changed (6)

- `packages/config/vitest.config.ts` — import `mergeConfig`; assign the existing `defineConfig({...})` to `const rootConfig`; `export default rootConfig` (unchanged concurrent:true root); add named `export const browserConfig = mergeConfig(rootConfig, defineConfig({ test: { sequence: { concurrent: false } } }))`.
- `apps/web/vitest.config.ts` — base import switched from default `rootConfig` to named `browserConfig`; `mergeConfig(browserConfig, …)`.
- `packages/ui/vitest.config.ts` — same switch.
- `apps/admin/vitest.config.ts` — same switch (const `merged` base).
- `apps/marketing/vitest.config.ts` — same switch.
- `apps/crawler-view/vitest.config.ts` — same switch (const `merged` base). Its `BROWSER_TEST_ENVIRONMENT` import is retained — it is used at `environment: BROWSER_TEST_ENVIRONMENT` (line 25), so no unused import.

`apps/api/vitest.config.ts` and all other node-env packages: untouched.

### Exact diff

All six diffs are 2-line import/base swaps except `packages/config/vitest.config.ts`. Key hunks:

```
packages/config/vitest.config.ts
-import { defineConfig } from 'vitest/config';
+import { defineConfig, mergeConfig } from 'vitest/config';
-export default defineConfig({
+const rootConfig = defineConfig({
     ... (root test config unchanged: sequence.concurrent:true, maxConcurrency:12, retry, testTimeout, setupFiles, deps.optimizer, coverage) ...
   });
+
+export default rootConfig;
+
+export const browserConfig = mergeConfig(
+  rootConfig,
+  defineConfig({ test: { sequence: { concurrent: false } } })
+);

apps/{web,admin,marketing,crawler-view}/vitest.config.ts + packages/ui/vitest.config.ts
-import rootConfig, { BROWSER_TEST_ENVIRONMENT } from '@hushbox/config/vitest';
+import { browserConfig, BROWSER_TEST_ENVIRONMENT } from '@hushbox/config/vitest';
-  rootConfig,      (mergeConfig base)
+  browserConfig,
```
(marketing/ui: no `BROWSER_TEST_ENVIRONMENT` change needed beyond the named-import switch — both use it. crawler-view uses it too.)

## Self-gate

- `pnpm exec eslint .` in packages/config — pass (exit 0).
- `pnpm exec tsgo --noEmit` in packages/config — pass (exit 0).
- `pnpm exec eslint .` in apps/web — pass (exit 0).
- `prettier --check` on all 6 files — pass ("All matched files use Prettier code style").
- `turbo typecheck lint --filter=@hushbox/config --filter=@hushbox/web` — FAILS on `@hushbox/web#typecheck` ONLY, with a single error in a file I did not touch:
  `apps/api/src/middleware/pipeline-bindings.ts(59,29): error TS2304: Cannot find name 'ExecutionContext'.`
  This is the Cloudflare Workers ambient `ExecutionContext` type failing to resolve during web's cross-project (AppType) typecheck of api source. `git status` shows `pipeline-bindings.ts` is unmodified in the working tree. A vitest.config.ts edit cannot introduce a missing-ambient-type error in api middleware. Attributed to pre-existing state or concurrent api-slice work (git status showed many modified/staged api files). Not attributable to this task; not fixed (outside ownership). config lint, config typecheck, and web lint all pass.

## Resolved-config verification (node eval of resolved configs)

- root default export: `sequence.concurrent === true`.
- `browserConfig`: `sequence.concurrent === false`.
- All other keys identical between the two: maxConcurrency 12, retry 1, testTimeout 15000, setupFiles (same path), coverage.thresholds {95×4}, deps.optimizer.ssr.include [db,shared,crypto], exclude length 5.
- `apps/api/vitest.config.ts` resolved: `sequence.concurrent === true`, projects [api, smoke] — node stays concurrent.

## Functional verification

- `apps/web/.../share-message-modal.test.tsx` (18/23 failing under global concurrency at baseline): **23 passed (23)**, 0 failed. Fix confirmed.
- `apps/crawler-view` full run (`pnpm exec vitest run`): **130 passed (130)**, 16 files, 0 failed — no regression. Brief noted 2 baseline non-concurrency failures; none remain in this run (either concurrency-class after all or fixed by concurrent work — no regression from this change either way).

## Acceptance criteria

- Both exports present, all other root settings identical — met (node eval above).
- 5 browser configs consume `browserConfig`; api + node configs untouched — met.
- share-message-modal all pass — met (23/23).
- Small browser package green, no regression — met (crawler-view 130/130).
- Node stays concurrent — met (api resolves concurrent:true).
- turbo typecheck/lint passes for touched files — met for config + web lint + config typecheck + prettier; the web typecheck failure is an unrelated pre-existing/concurrent error in an api file (see self-gate).

## Deviations

None from the approved mechanism.

## Concerns and limitations

- The `turbo … typecheck` gate does not fully pass because of `apps/api/src/middleware/pipeline-bindings.ts` (`ExecutionContext` unresolved) — unrelated to this task and outside ownership. Raised to orchestrator.

## Confidence

High — config-only change; resolved-config eval confirms the exact intended delta (concurrent flip, everything else identical), the target regression test goes 23/23, and a full browser package stays green. The one gate failure is provably in an untouched api file.
