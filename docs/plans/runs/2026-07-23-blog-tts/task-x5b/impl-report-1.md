# X5b — Web: verify the merged bundle before it is uploaded — impl report 1

## Objective

Make the `web-dist` artifact that deploys pass the bundle guard: add a verification step to
both deploy workflows between `Generate _headers` and `Upload web build artifact`, invoked
through a root pnpm script on the existing `appBundleOptions` + `verifyWebBundle` seam, and
correct the false single-gate claim in `scripts/build-web-bundle.ts`.

## Files changed

- `scripts/verify-web-bundle.ts` — added the CLI entry point (`isMainModule` + `runMain`)
  that verifies `apps/web/dist` through the existing seam; corrected the module docstring,
  which claimed the guards are "run by each app's build script" (untrue for admin since
  X5a, and untrue for the deployed web dist as of this change).
- `package.json` — added the root script `verify:web-bundle`, placed with the other
  `verify:*` scripts.
- `.github/workflows/ci.yml` — added the `Verify web bundle` step to the `build` job,
  between `Generate _headers` and `Upload web build artifact`.
- `.github/workflows/release.yml` — same step, same position, in the `prepare-web` job.
- `scripts/build-web-bundle.ts` — corrected the false comment at the `deps.verify` call.

## Tests added

None. Every acceptance criterion here is workflow YAML, a root script line, a
four-line CLI entry, or a comment correction — there is no new unit-testable logic.

- The CLI entry follows this directory's established shape for entry points: a
  `/* v8 ignore start -- CLI entry point … */` block containing only repo-root resolution
  and a call to an already-unit-tested function. `build-web-bundle.ts`,
  `merge-marketing-into-web.ts`, `generate-headers.ts` and `build-admin-bundle.ts` all do
  exactly this. A test here would assert `path.resolve`.
- The checker itself is already unit-pinned in both directions by
  `scripts/verify-web-bundle.test.ts` (49 tests across it and `build-web-bundle.test.ts`,
  all passing).
- §X5b criterion 4 defines the verification method for this task explicitly (run the script
  locally, prove the failing direction, confirm the YAML parses and the step is positioned
  correctly), which is what was done — see below.

## Red/green evidence (criterion 4)

The failing direction was proven **first**, so the very first run of the new script was a
red one. A stray ORT runtime copy was planted in the real merged dist
(`apps/web/dist/assets/ort-wasm-simd-threaded.jsep.wasm`, 26 bytes) before the entry point
existed:

```
$ pnpm verify:web-bundle
Web bundle verification failed (/…/apps/web/dist):
  - redundant ORT runtime copy outside ort/: assets/ort-wasm-simd-threaded.jsep.wasm (26 B)
 ELIFECYCLE  Command failed with exit code 1.
EXIT=1
```

The planted file was then removed and the script re-run against the untouched real merged
dist (1018 files, `_headers` present, marketing merged, `dist/ort/` self-hosted runtime):

```
$ rm apps/web/dist/assets/ort-wasm-simd-threaded.jsep.wasm && pnpm verify:web-bundle
Verified /…/apps/web/dist
EXIT=0
```

Confirmed after all edits that no planted artifact remains (`ls apps/web/dist/assets/ |
grep -c '^ort-'` → 0) and the final run is green.

**CI execution itself is unverified.** Agents cannot run GitHub Actions. What is
demonstrated is: the script passes on the real merged dist, it fails on a dirty one, the
step needs nothing beyond the repo and `node_modules`, both workflow files parse, and the
step sits in the required position. Whether the step behaves identically inside a runner
job is not proven by anything here.

## Workflow diffs

`.github/workflows/ci.yml` — **the file already carried an uncommitted foreign diff before
this task started** (recorded in the plan's §CONCURRENCY CORRECTION): another workstream's
`pnpm generate:env` run added two FCM env lines at `@@ -140` and rewrote the
Resend/FCM evidence steps at `@@ -219`. Those hunks are **not mine**, were not touched, and
`pnpm generate:env` was not run by this task. My change is the single hunk at `@@ -309`:

```diff
@@ -309,6 +308,14 @@ jobs:
           SANDBOX_ORIGIN_URL: https://sandbox.hushbox.ai
         # END GENERATED: headers-env

+      # The deployed bundle is assembled by the three steps above, not by a
+      # build script, so the bundle guard runs as its own step: after the last
+      # step that adds a file to the dist (the Pages file-count check counts
+      # `_headers`) and before the artifact anything deploys from is uploaded.
+      # Reads only the dist and the installed packages, so it needs no env.
+      - name: Verify web bundle
+        run: pnpm verify:web-bundle
+
       - name: Upload web build artifact
```

`.github/workflows/release.yml` — no foreign diff; the whole diff is mine:

```diff
@@ -146,6 +146,13 @@ jobs:
           SANDBOX_ORIGIN_URL: https://sandbox.hushbox.ai
         # END GENERATED: headers-env
+      # The deployed bundle is assembled by the three steps above, not by a
+      # build script, so the bundle guard runs as its own step: after the last
+      # step that adds a file to the dist (the Pages file-count check counts
+      # `_headers`) and before the artifact anything deploys from is uploaded.
+      # Reads only the dist and the installed packages, so it needs no env.
+      - name: Verify web bundle
+        run: pnpm verify:web-bundle
       - name: Upload web build artifact
```

Both steps sit outside the generator-written `# BEGIN/END GENERATED:` blocks, so a future
`generate:env` run does not disturb them.

`release.yml`'s `prepare-web` job has the same step sequence as `ci.yml`'s `build` job
(`Build` → `Merge marketing into web dist` → `Generate _headers` → `Upload web build
artifact`), so the placement is identical in both; no NEEDS_CONTEXT trigger fired.

### YAML parses, position confirmed

Parsed both files with the repo's installed `yaml` package and printed the three steps
starting at `Generate _headers` in every job that has one:

```
.github/workflows/ci.yml      :: build       ["Generate _headers (CSP hashes per marketing route)","Verify web bundle","Upload web build artifact"]
.github/workflows/release.yml :: prepare-web ["Generate _headers (CSP hashes per marketing route)","Verify web bundle","Upload web build artifact"]
BOTH PARSED OK
```

## Corrected comment (criterion 3)

`scripts/build-web-bundle.ts`, at the `deps.verify` call. Removed text:

> Every caller — prod, e2e, preview — comes through here, so this is the single gate.

Replacement (the first two lines of the comment were true and are unchanged):

```
  // After the merge, because the merged dist is what actually deploys: a stray
  // ORT copy or a Pages-limit breach only exists once marketing's output has
  // landed on top of web's. This is not the only gate — the deploy workflows
  // never call this script, they re-spell build → merge → headers as their own
  // steps and run the same guard through `pnpm verify:web-bundle` before
  // uploading the artifact. What comes through here is the e2e/preview bundle.
```

**Precision correction to the plan's premise.** §X5b states "no workflow calls
`buildWebBundle` at all". That is not quite right: `ci.yml:395` (`e2e-build` job) runs
`pnpm build:e2e`, which is `build-web-bundle.ts --target=prod|e2e`, and
`playwright.config.ts:96` does the same for the preview server. What no workflow does is
reach the **deployed** artifact through this script — `ci.yml`'s `build` job and
`release.yml`'s `prepare-web` job run `pnpm build` plus their own merge/headers steps.
`pnpm build:web` (`--target=prod`) has no caller outside `package.json`. The comment was
written to the accurate fact, not the plan's phrasing.

Also corrected: the `verify-web-bundle.ts` module docstring said the guards are "run by
each app's build script right after its dist is final". Admin has run it from its vite
build since X5a, and this change adds a third invocation shape, so the sentence was made
accurate rather than left more wrong than before. This is an edit beyond the four files
§X5b lists, confined to one comment in a file this task owns.

## Self-gate

| command | result |
| --- | --- |
| `eslint verify-web-bundle.ts build-web-bundle.ts` (run from `scripts/`, after the last edit) | pass — exit 0 |
| `prettier --check package.json .github/workflows/ci.yml .github/workflows/release.yml` | pass |
| `turbo typecheck lint --filter=@hushbox/scripts --force` | pass — 2/2 tasks |
| `turbo test --filter=@hushbox/scripts --force` | **fail — 2 failed files / 88 passed, 1868 tests passed.** Both failures foreign, see below |
| `vitest run verify-web-bundle.test.ts build-web-bundle.test.ts` | pass — 2 files, 49 tests |
| `pnpm lint:unused` (knip) | **exit 1 — one foreign unused file + one foreign config hint; unchanged by this task**, see below |
| `pnpm verify:web-bundle` (the new script, real merged dist) | pass — exit 0 |
| `pnpm --filter @hushbox/admin build` | pass — exit 0 (see "TLA risk" below) |

### Attributed failures

`turbo test --filter=@hushbox/scripts` — the only two failing files are
`refresh-catalog-run.test.ts` and `seed-run.test.ts`, both `ERR_MODULE_NOT_FOUND` on
`scripts/node_modules/.vite/vitest/…/deps_ssr/@hushbox_db.js`. These are the
foreign-and-unstable failures recorded in the plan's §KNOWN PRE-EXISTING FAILURES. Neither
file is touched by this task, neither imports anything this task changed, and this run's
observed cause is the deps_ssr one (the plan notes the cause varies between runs).
`generate-env.test.ts`, also listed there, passed in this run.

`pnpm lint:unused` — reports `packages/config/vitest.package.config.ts` as an unused file
(the known foreign finding) plus a configuration hint about `wrangler` in `apps/sandbox`'s
`ignoreDependencies`. **Both are independent of this change, proven by a control run**: with
the `verify:web-bundle` line deleted from `package.json`, knip printed byte-identical
output; the line was then restored (`prettier --check package.json` green afterwards).
`knip.jsonc` and `apps/sandbox` are unmodified in the working tree. `scripts`' knip
workspace already declares `entry: ["*.ts", "!*.test.ts", …]`, so `verify-web-bundle.ts`
was already an entry and the new script line adds no finding of its own.

## Acceptance criteria

1. **Met.** Step added to `ci.yml` (`build` job) and `release.yml` (`prepare-web` job),
   both between `Generate _headers` and `Upload web build artifact` — parser-confirmed
   above.
2. **Met.** The step runs `pnpm verify:web-bundle`, a root script pointing at
   `scripts/verify-web-bundle.ts`'s CLI entry, which calls
   `verifyWebBundle(appBundleOptions(repoRoot, 'apps/web'))` — the same seam X1 established
   and `build-web-bundle.ts` / `apps/admin/vite.config.ts` use. No inline `tsx -e`, no
   reimplementation, no second declaration of which apps ship TTS. `pnpm lint:unused`
   findings unchanged (control run above).
3. **Met.** Comment corrected, text quoted above, with the plan's own premise sharpened.
4. **Met.** Red run, green run, YAML parse, and step position all shown above; the CI
   execution boundary is stated plainly.
5. **Met.** `verifyWebBundle` reads only `apps/web/dist`, `packages/ui/package.json`, and
   the installed `onnxruntime-web` runtime under `node_modules` (via `resolveOrtAssets`).
   No env var, no secret, no generated `.env`. The script is invoked bare (`tsx
   scripts/verify-web-bundle.ts`), not through `scripts/with-env.ts`, matching
   `verify:env` / `verify:typecheck-coverage`. Both jobs run `./.github/actions/setup`
   (install) and a full build before this point, so the dist and `node_modules` are present.

## Deviations

1. **The docstring of `scripts/verify-web-bundle.ts` was corrected** in addition to the
   §X5b file list's four files (the file itself is in the list; the extra edit is one
   comment beyond the CLI entry). Reason: the sentence "run by each app's build script"
   became more wrong because of this change, and CODE-RULES treats a wrong comment as worse
   than none.
2. **No test was added.** Rationale in "Tests added" above: the added code is a
   coverage-ignored CLI entry matching four sibling scripts, and §X5b criterion 4 specifies
   the verification method for this task.

## Concerns and limitations

- **CI execution is unverified.** Stated in criterion 4's evidence and repeated here
  because it is the honest limit of this task: nothing here proves the step passes or fails
  correctly inside a GitHub Actions runner. First real proof arrives on the next CI run.
- **Top-level `await` was introduced into a module that `apps/admin/vite.config.ts`
  imports.** The CLI entry uses the repo's dominant `await runMain(…)` shape, which makes
  the module top-level-await. `scripts/generate-headers.ts` — imported by the same vite
  config since before this task — already carries that shape, so the pattern was already
  proven in this path; it was re-proven directly by running `pnpm --filter @hushbox/admin
  build` after the change (exit 0, `dist/_headers` re-emitted, closeBundle guard passed).
  The lower-risk `void runMain(…)` alternative (used by `ensure-gitleaks.ts`,
  `gitleaks.ts`) was rejected as an unnecessary deviation from the dominant convention.
- **The guard's non-vacuity in CI depends on the dist being final at that point.** The step
  is placed after the last dist-mutating step in both jobs today. A future step inserted
  between `Verify web bundle` and `Upload web build artifact` that writes into
  `apps/web/dist` would silently escape the guard. Nothing pins that ordering; the comment
  on the step states the constraint.
- **The web half is a CI step, the admin half is a build hook.** Unlike X5a's, this guard
  can be bypassed by anything that assembles a deploy artifact without going through these
  two workflow jobs. §X5b's design context accepts this — the merged dist has no build
  script to anchor to — but the asymmetry is real and worth the founder knowing.

## Confidence

**High** for what is demonstrated: the script, its failing direction, the step placement,
the YAML validity, and the comment corrections are all directly observed. **The CI run
itself is unobserved**, and that is the one thing this task cannot close.
