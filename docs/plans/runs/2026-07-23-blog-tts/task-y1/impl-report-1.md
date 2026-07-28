# Y1 — Close the four guard-coverage gaps (implementation report 1)

## Objective

Every deployed artifact this repo produces passes the bundle guard, and the guard cannot be
replayed from a stale turbo cache after its own rules change.

## Files changed

- `scripts/verify-web-bundle.ts` — `apps/sandbox` declared TTS-free; `appBundleOptions`
  gained an optional dist-directory name so sibling dists of one app reuse that app's single
  declaration; new `requestedDistributionDirectories` for the CLI; new `_headers` assertion on
  the TTS-free path; CLI iterates the dist directories named as arguments; module docstring
  updated from five to six problem classes.
- `scripts/verify-web-bundle.test.ts` — tests for all of the above; the TTS-free fixture now
  writes a `_headers` file so the pre-existing cases keep testing what they tested.
- `apps/sandbox/src/build.ts` — the CLI entry verifies the dist it just assembled, at the
  point the artifact is final, calling the same seam `apps/admin/vite.config.ts` calls.
- `.github/workflows/build-android.yml` — verification step between `Build web for Android`
  and `Generate platform assets`, so the dist `cap sync` copies into the APK is gated.
- `.github/workflows/ci.yml` — verification step between `Build mobile OTA bundles (parallel)`
  and `Upload mobile build artifacts`, naming the three OTA dists.
- `apps/admin/turbo.json` (new) — package configuration extending the root, adding the guard's
  own sources to the admin build task's `inputs`.

Not changed, deliberately: `apps/crawler-view`'s entry in `APPS_SHIPPING_TTS` (criterion 6),
`turbo.json` at the repo root (see Deviation 1), `.github/workflows/release.yml`
(`build-android.yml` is `workflow_call`-only and release.yml invokes it twice, so the new
step covers both release paths; release.yml builds no OTA dists — `grep -n "dist-ios"`
matches only `ci.yml`).

## Tests added (`scripts/verify-web-bundle.test.ts`)

| Test | Behavior | Criterion |
| --- | --- | --- |
| `reports a dist whose _headers file is missing` | TTS-free path yields exactly one violation naming `_headers` | 4 |
| `expects no TTS in the sandbox origin bundle` | `apps/sandbox` resolves to `<root>/apps/sandbox/dist`, `shipsTts: false` | 3 |
| `keeps the app declaration when a sibling dist directory is named` | `appBundleOptions('/repo','apps/web','dist-ios')` → that directory, `shipsTts` still `true` | 2 |
| `verifies the primary dist when no directory is named` | CLI default is `['dist']` | 2 |
| `verifies every directory named on the command line` | CLI arguments pass through in order | 2 |

The existing `throws for an app that never declared a TTS expectation` now targets
`apps/marketing` (genuinely undeclared) rather than `apps/sandbox` (now declared); the
behavior it pins is unchanged.

Watched each fail first: 5 failed / 35 passed, with the expected messages —
`expected [] to have a length of 1`, `apps/sandbox has no declared TTS expectation`,
`expected {…} to deeply equal {…}`, and `requestedDistDirs is not a function` twice. After
implementation: 40 passed.

No unit test was added for the two workflow steps or for the sandbox CLI wiring. Workflow
steps are not executable here (§X5b criterion 4's honest-boundary rule), and the sandbox
wiring sits in the `v8 ignore`d CLI entry — pinning it would need an injected verify seam,
which is the mechanism §X5a deliberately removed from `build-admin-bundle.ts`. Both are
evidenced by execution below instead.

## Self-gate

| Command | Result |
| --- | --- |
| `turbo test typecheck lint --filter=@hushbox/scripts --force` | **fail** — 88 files passed / 2 failed, 1881 tests passed, 0 assertion failures; typecheck 1 error. Both failures foreign, attributed below. |
| `turbo test typecheck lint --filter=@hushbox/sandbox --force` | pass — 4/4 tasks, 18 test files |
| `turbo test typecheck lint --filter=@hushbox/admin --force` | **fail** — test 70 files passed, lint pass, typecheck 1 error (the same foreign one) |
| `eslint verify-web-bundle.ts verify-web-bundle.test.ts` (from `scripts/`) | exit 0, after last edit |
| `eslint src/build.ts` (from `apps/sandbox/`) | exit 0, after last edit |
| `prettier --check` on all six changed files | pass |
| `pnpm arch:check` | pass — 12 rules / 2040 files |
| `pnpm lint:unused` (knip) | 2 items, both pre-existing (`packages/config/vitest.package.config.ts` unused file; `wrangler` ignoreDependencies hint in `apps/sandbox`) — recorded in §CLOSE as foreign. No new unused export. |
| coverage of `scripts/verify-web-bundle.ts` | 100% statements / branches / functions / lines |

Foreign failures, not mine:

- `@hushbox/scripts#typecheck` and `@hushbox/admin#typecheck`:
  `../apps/api/src/slices/models/domain/trial-eligibility.ts(120,5): error TS2353 …
  'releasedAtMs' does not exist in type 'PremiumClassificationInput'`. A file I never touched,
  in the `apps/api` tree the plan records as actively edited by other workstreams; same class
  as the TS6133s §CONCURRENCY CORRECTION attributed to them.
- `@hushbox/scripts#test`: `refresh-catalog-run.test.ts` and `seed-run.test.ts` both fail at
  module load with `ERR_MODULE_NOT_FOUND` on
  `scripts/node_modules/.vite/vitest/…/deps_ssr/@hushbox_db.js`. These are the two `deps_ssr`
  loaders §CLOSE records as the only remaining foreign reds, whose remedy (clearing the vite
  cache) is forbidden here. Neither imports anything I changed.
- Because the suite aborts on those two, the package's per-file coverage gate did not print;
  the file-scoped coverage run above stands in for it.

## Acceptance criteria

**1 — `build-android.yml` gains a verification step after `pnpm --filter web build`. MET.**
Step `Verify web bundle` / `run: pnpm verify:web-bundle`, mirroring X5b's shape (same name,
same script, a comment saying why it sits there, no env block). Parsed step order of the
`build` job: `… Build web for Android → Verify web bundle → Generate platform assets → Sync
Android → …`; nothing else moved.
_Guard runs on this artifact:_ that step verifies `apps/web/dist`, the output of a plain
`--filter web build`. I built exactly that shape locally (`pnpm --filter web exec vite build
--outDir dist-ios`, which differs from the workflow's build only in output directory) and the
guard passed on it: `Verified …/apps/web/dist-ios`. `pnpm verify:web-bundle` with no arguments
also passes today against the real `apps/web/dist`.
_Failing direction:_ removing `ort/*.wasm` from such a dist produced
`missing self-hosted ORT runtime file: ort/ort-wasm-simd-threaded.jsep.wasm` and exit 1. The
directories used for this (`apps/web/dist-ios`, `apps/web/dist-android`) were deleted
afterwards.

**2 — the three OTA dists are gated, with no second declaration. MET.**
`ci.yml` gains `Verify mobile OTA bundles` (`if: needs.version.result == 'success'`, matching
the build and upload steps around it) running
`pnpm verify:web-bundle dist-ios dist-android dist-android-direct`, positioned between the OTA
build step and the upload. Parsed step order: `… Build mobile OTA bundles (parallel) → Verify
mobile OTA bundles → Upload mobile build artifacts`.
_Shape change:_ `appBundleOptions(rootDir, appDir, distributionDirName = 'dist')`. `appDir`
still keys `APPS_SHIPPING_TTS` and nothing else; only the location varies. Existing call sites
(`apps/admin/vite.config.ts`, `scripts/build-web-bundle.ts`) are untouched because the third
parameter defaults.
_One declaration, proven repo-wide:_ `grep -rn -e shipsTts -e APPS_SHIPPING_TTS -e
appBundleOptions --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js'
--include='*.yml' --include='*.json'` (excluding `node_modules`, `dist`, `docs/plans`) returns
one producer — the `APPS_SHIPPING_TTS` map — read only through `appBundleOptions`, at four call
sites: `apps/admin/vite.config.ts:34`, `apps/sandbox/src/build.ts:46`,
`scripts/build-web-bundle.ts:86`, and the CLI at `scripts/verify-web-bundle.ts:494`. Every
other `shipsTts:` literal is a test fixture. No workflow YAML mentions TTS.
_Guard runs on these artifacts:_ built one OTA dist for real, copied it to a second name, and
ran the exact step command shape: two `Verified …/apps/web/dist-ios` and
`…/apps/web/dist-android` lines. Then deleted the ORT runtime from the **second** one and
re-ran: the first still verified, the second reported the violation and the command exited
non-zero — so a failure in any named dist fails the step, not just the first.

**3 — `apps/sandbox` declared TTS-free and gated from its own build script. MET.**
`['apps/sandbox', false]` added to `APPS_SHIPPING_TTS`; `main()` in
`apps/sandbox/src/build.ts` is now async and awaits
`verifyWebBundle(appBundleOptions(<repo root>, 'apps/sandbox'))` immediately after
`buildSandbox` returns — the point the dist is final, which is what `apps/admin/vite.config.ts`
does from `closeBundle`. `buildSandbox` itself is unchanged and still synchronous; it has no
other caller (`grep` shows `main()` and its own test file only).
_Guard runs on this artifact:_ `ESM_CDN_URL=https://esm.sh pnpm --filter @hushbox/sandbox
build` → `✓ sandbox dist assembled`, passing against the real 25-file dist as the orchestrator's
baseline predicted (largest file `pyodide/pyodide.asm.wasm`, well under the caps).
_Failing direction:_ a 13-byte `ort-wasm-simd-threaded.jsep.wasm` planted in
`apps/sandbox/public/` made the same command fail with
`TTS artifact in a bundle declared TTS-free: ort-wasm-simd-threaded.jsep.wasm (13 B)`, thrown
from `verifyWebBundle` inside `main`, exit 1. The planted file was deleted and the dist
rebuilt clean; `git status apps/sandbox` shows only `src/build.ts`.

**4 — the TTS-free check path additionally asserts the dist contains `_headers`. MET.**
`checkHeadersFile` runs only in the `!shipsTts` branch of `collectWebBundleViolations`; the
shipping-TTS path is untouched (`apps/web/dist` before merge legitimately has no `_headers`).
No config-shape test was added anywhere.
_Both directions at the artifact level:_ against a copy of the freshly built real
`apps/admin/dist`, the TTS-free checks return `[]`; delete `_headers` from that copy and they
return `['no _headers at the dist root — this origin ships without its CSP and the rest of its
security headers']`. On the sandbox's real build path, moving `apps/sandbox/public/_headers`
away made `pnpm --filter @hushbox/sandbox build` fail with that same violation; restoring it
made the build pass again.
_The admin build really runs this code:_ planting the same fake ORT wasm in
`apps/admin/public/` made `pnpm build` in `apps/admin` fail from
`PluginContextImpl.closeBundle` with the TTS-artifact violation; removed, and the build passes.
So admin's dist is checked by the post-change verifier, `_headers` assertion included.

**5 — the admin build task's `inputs` cover the verifier. MET (see Deviation 1 for where).**
_Before:_ resolved `@hushbox/admin#build` inputs were `["$TURBO_DEFAULT$", ".env*"]`, and
`$TURBO_DEFAULT$` covers only files inside the package. Measured: hash `47e1ea43861e45a3`
before appending a line to `scripts/verify-web-bundle.ts`, `47e1ea43861e45a3` after, and
`47e1ea43861e45a3` once restored — the guard was not part of the cache key at all.
_After:_ resolved inputs are `["$TURBO_DEFAULT$", "../../scripts/lib/is-main.ts",
"../../scripts/lib/ort-assets-plugin.ts", "../../scripts/lib/run-main.ts",
"../../scripts/verify-web-bundle.ts", ".env*"]`, with `outputs`, `dependsOn` and `env`
inherited unchanged from the root task (`dist/**`, `["^build","fetch-pyodide"]`,
`["ESM_CDN_URL"]`). Measured back to back: two idle runs both `6cc271ea62013dfb`; with a line
appended to the verifier `fba1a81f73355c6b`. An equivalent probe on
`scripts/lib/ort-assets-plugin.ts` also moved the hash. Every probe file was restored
byte-identically (`diff -q` clean).
_Narrowness:_ the four files are named individually rather than by a `scripts/**` glob, which
would rebuild admin on every unrelated script edit. `packages/shared/src/tts-hosts.ts` (the
plugin's only other local import) needs no entry — it belongs to `@hushbox/shared`, whose
build this task already depends on.
_A real cache-hit demonstration was not obtainable in this checkout:_ back-to-back
`turbo build --filter=@hushbox/admin` runs miss with different hashes even with no edit of
mine, because concurrent workstreams are editing `apps/api`, which admin's `dependsOn: ^build`
folds into its hash. The controlled before/after hash comparisons above are the evidence, and
the hash is the cache key.

**6 — `apps/crawler-view` keeps its entry, no claim of being guarded. MET.** Its map entry is
untouched; nothing was added that invokes the guard for it, and no comment or report line here
says it is guarded.

## Deviations

1. **The admin `inputs` change lives in a new `apps/admin/turbo.json`, not in the root
   `turbo.json` that §Y1's file list names.** I implemented it in the root first, as
   `"@hushbox/admin#build"`, and measured that a `package#task` entry there does **not**
   inherit from the base `build` task: with only `inputs` set, the resolved definition came
   back `outputs: []`, `dependsOn: []`, `env: []`. Making it correct in the root therefore
   requires copying `dependsOn`, `outputs` and `env` out of the base task — three fields that
   must then stay in sync by hand, which is the sync-contract smell CODE-RULES bans. A package
   configuration with `"extends": ["//"]` merges instead: only `inputs` is overridden and the
   other three are inherited (verified in the resolved task definition, quoted under criterion
   5). Same task, same effect, no duplicated configuration.
2. **One extra edit in `scripts/verify-web-bundle.ts`'s module docstring** — "Five classes"
   became "Six" plus a bullet for the new `_headers` class. Leaving it would have made the
   file's own header wrong. (The rest of that file's header diff against `HEAD` is prior
   X-series work already in the working tree, not mine.)

## Concerns and limitations

- **CI execution is unverified.** No agent can run GitHub Actions. Both new steps were
  verified by running their exact commands locally, by proving the failing direction is
  reachable and exits non-zero, by parsing both workflow files with a YAML loader, and by
  printing the parsed step order. Whether the runner reaches them is not verified.
- **The same stale-cache gap I closed for admin exists for `apps/sandbox#build`, and criterion
  5 named only admin.** Measured: appending a line to `scripts/verify-web-bundle.ts` leaves
  `@hushbox/sandbox#build`'s hash identical (`11fe7a308e428ed4` idle, changed, restored). So a
  cached sandbox dist can replay without re-running the guard whose rules changed. The fix is
  the same three-line package configuration; I did not make it because it is outside the
  criteria. Orchestrator's call.
- **`apps/admin`'s build hook has a second, older input gap.** The same `closeBundle` also runs
  `generateAdminHeaders` from `scripts/generate-headers.ts` (via
  `scripts/lib/headers-vite-plugin.ts`), and those are equally invisible to
  `$TURBO_DEFAULT$`. I scoped the new `inputs` to the verifier's own sources as criterion 5
  words it. Adding the two headers files is one line each if wanted.
- **`_headers` is asserted only on the TTS-free path**, as criterion 4 specifies. The merged
  `web-dist` also carries a generated `_headers`, and that is not asserted anywhere; extending
  it there is not free, because `apps/web/dist` before the merge step legitimately has none
  (the pre-merge dist is exactly what `build-android.yml` verifies).
- **A `apps/web/dist-ota` directory exists in this checkout** and is not one of the three OTA
  names any workflow builds. Not mine, not touched, mentioned only so nobody mistakes it for a
  fourth artifact.
- Working-tree hygiene: `git status --porcelain` diffed before and after shows my only
  additions are `.github/workflows/build-android.yml`, `apps/sandbox/src/build.ts` and
  `apps/admin/turbo.json` (plus the two `scripts/verify-web-bundle*` files, already modified
  when I started). Every temporary probe file — the planted ORT wasms, the appended comment
  lines, the local OTA dists — was removed and verified removed. `ci.yml`'s foreign FCM/Resend
  hunk was neither reverted nor touched: my hunk in that file is the single one at the OTA
  steps.

## Confidence

**High** for criteria 1–4 and 6: each is executed evidence, both directions, on real artifacts.
**Medium** for criterion 5 only in the sense that a genuine cache **hit** could not be
demonstrated in a checkout where concurrent edits move the hash on every run; the cache-key
sensitivity itself is measured and unambiguous.
