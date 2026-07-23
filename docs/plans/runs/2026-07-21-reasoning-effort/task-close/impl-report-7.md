# impl-report-7 — close item: package-aware `pnpm test:watch`

## Objective

Root `pnpm test:watch <apps/web file>` failed `@/` alias resolution because vitest never loads the owning package's config from a root invocation. Fix: detect the owning package from each file arg (nearest package.json walking up) and invoke vitest FROM that package directory, same with-env environment. Same-package multi-file: allowed; cross-package: clear error; in-package and no-file (watch-all) behavior preserved.

## Files changed

- `scripts/test-watch.ts` — new package-aware entry: `findOwningPackageDir` (walk up to nearest package.json), `planInvocation` (splits argv into existing paths → absolute + package detection vs passthrough flags/name-filters; 0 packages → invocation dir, 1 → that package dir, >1 → error), `runVitest` (execa `vitest` with `cwd`/`localDir` = planned dir, `preferLocal` so the package's own vitest wins). CLI entry reuses `loadEnvironment`/`appendNodeOption`/`NODE_OPTION_FLAG` exported by `with-env.ts` — identical env behavior to the old wrapper.
- `scripts/test-watch.test.ts` — unit tests (TDD; scripts dir has a vitest harness).
- `package.json` (root) — `"test:watch": "tsx scripts/test-watch.ts"` (was `tsx scripts/with-env.ts vitest`). `test:watch:ui` untouched (out of bounds).

## Tests added (name — behavior — criterion)

`scripts/test-watch.test.ts`, 15 tests:

- findOwningPackageDir: nearest-ancestor package.json; falls through to root; clear throw when none — detection criterion.
- planInvocation: empty args → invocation dir (watch-all preserved); flags passthrough; single web file → cwd = package dir, arg absolutized; multiple same-package files fine; existing directory arg detected; cross-package files → clear error; root-owned file (e2e/) stays at invocation dir; non-existent positional passthrough as vitest name filter; relative args resolve against the invocation dir (in-package invocation preserved).
- runVitest: spawns `vitest` with `{stdio inherit, reject false, preferLocal, localDir, cwd}`; propagates non-zero exit; 1 on non-numeric exit.

TDD: first run failed with "module not found" (red for the right reason); one intermediate red was a fake-fs helper bug (conflated is-directory with has-package.json) — fixed in the test helper, not by weakening any assertion.

## Self-gate

- `npx vitest run test-watch.test.ts` (from scripts/) — pass, 15/15.
- Per-file coverage of `test-watch.ts` (`--coverage.include=test-watch.ts`) — 100% stmts/branch/funcs/lines (CLI block under the dir's standard `/* v8 ignore */` entry-point convention, same as `with-env.ts`/`run-package-tests.ts`).
- `npx eslint test-watch.ts test-watch.test.ts` (from scripts/, after final edit) — pass, 0 problems (ran `--fix` once for unicorn/prevent-abbreviations renames + one prettier wrap, then re-linted clean).
- `npx prettier --check` on both new files + root `package.json` — pass.
- `npx tsgo --noEmit` (scripts package) — pass.

## Acceptance verification (brief-mandated runs)

- (a) root `pnpm test:watch apps/web/src/components/chat/message/thinking-disclosure.test.tsx --run --sequence.concurrent=false` — **passes** (banner shows `RUN v4.1.8 …/apps/web`; 23/23). Previously this invocation failed alias resolution.
- (b) in-package `cd apps/web && npx vitest --run src/…/thinking-disclosure.test.tsx` — unchanged, 23/23 pass.
- (c) root `pnpm test:watch apps/api/src/slices/chat/domain/turn-definition.test.ts --run` — passes, 90/90 (env loaded correctly via the shared with-env exports).
- Cross-package live check: web + api files together → exits 1 with `test:watch: files span multiple packages (apps/web, apps/api); run one package at a time`.

## Deviations

- Existing **directory** args also drive package detection (e.g. `pnpm test:watch apps/api/src/slices/chat`) — natural extension of "file path"; non-existent positionals still pass through as vitest name filters with root behavior, exactly as before.
- Rewritten file args are passed as absolute paths (vitest accepts them regardless of cwd); flags/filters pass through untouched in order.

## Concerns / limitations

- A bare name filter (`pnpm test:watch thinking-disclosure`) still runs from root and keeps whatever behavior it had before — package detection only engages for args that exist on disk (deliberate: preserves current behavior).
- `preferLocal` walks node_modules/.bin from the package dir upward, so packages without their own vitest fall back to the workspace root binary.

## Confidence

High — pure logic fully unit-tested at 100% file coverage, and all three brief-mandated live verifications plus the error path observed passing/failing exactly as specified.
