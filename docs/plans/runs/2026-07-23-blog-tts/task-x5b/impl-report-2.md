# X5b — impl report 2 (fix cycle 1)

## Objective

Fix the single validated finding: `scripts/build-web-bundle.ts`'s module header still claimed
the production build/deploy paths come through this script, directly contradicting the
comment ~80 lines below in the same file. Fix the header and the loose trailing sentence in
one coherent edit, so the file gives exactly one answer to "does the production deploy path
come through here?". Nothing else.

## Files changed

- `scripts/build-web-bundle.ts` — two comments only (module header; the comment above the
  `deps.verify` call). No executable line changed.

That is the whole diff for this cycle:

```
$ git diff --stat -- scripts/build-web-bundle.ts   # (vs HEAD, so it also contains cycle-1's edit)
 scripts/build-web-bundle.ts | 26 +++++++++++++++++---------
```

Every added/removed line in that diff is inside a `/** */` block or a `//` comment — verified
by reading the full diff (reproduced below).

## Site 1 — module header

**Old (`:3-8`):**

```
 * The single web-bundle build path: build web + marketing, merge marketing's
 * output on top of web's, then generate the CSP `_headers`. Shared by every
 * caller so the sequence lives in one place:
 *   - `playwright.config.ts` (E2E preview server) and CI's `e2e-build` job, via
 *     `--target=e2e` (dev-mode build, loads `.env.development`)
 *   - the production build/deploy paths, via `--target=prod`
```

**New (`:3-13`):**

```
 * The web-bundle build sequence: build web + marketing, merge marketing's output
 * on top of web's, then generate the CSP `_headers`. It lives here so its two
 * callers spell it once, both via `--target=e2e` (dev-mode build, loads
 * `.env.development`):
 *   - `playwright.config.ts` (the E2E preview server)
 *   - CI's `e2e-build` job (`pnpm build:e2e`)
 *
 * `--target=prod` runs the same sequence in prod mode and has no caller beyond
 * its own `build:web` script definition: the jobs that produce the deployed
 * bundle re-spell build → merge → headers as their own workflow steps, so the
 * artifact that deploys never comes through this file.
```

### Grounding, clause by clause (all re-verified this cycle, not carried over)

| Clause asserted | Caller / evidence |
| --- | --- |
| "its two callers … both via `--target=e2e`" | Repo-wide grep for `build:web\|build:e2e\|build-web-bundle` (excluding `node_modules`, `dist`, `legacy`, plan/history dirs) returns exactly two invocation sites: `playwright.config.ts:96` and `.github/workflows/ci.yml:403`. Other hits are the `package.json` definitions, this file itself, its test, and prose. |
| "`playwright.config.ts` (the E2E preview server)" | `playwright.config.ts:96` — `(process.env['HB_E2E_PREBUILT'] ? '' : 'pnpm build:e2e && ') + …` inside the `webServer` block (comment at `:91` names it the single web-bundle build path). |
| "CI's `e2e-build` job (`pnpm build:e2e`)" | `.github/workflows/ci.yml:403` — `run: pnpm build:e2e`, step `Build merged e2e web bundle`, in the job declared `e2e-build:` at `.github/workflows/ci.yml:380`. |
| "dev-mode build, loads `.env.development`" | Unchanged pre-existing clause; `buildWebBundle` pushes `--mode development` for `e2e` (`scripts/build-web-bundle.ts:86`). |
| "`--target=prod` … has no caller beyond its own `build:web` script definition" | Same grep: the only `--target=prod` occurrence outside this file is `package.json:14` (`"build:web": "tsx scripts/build-web-bundle.ts --target=prod"`), and `build:web` itself has zero call sites. |
| "the jobs that produce the deployed bundle re-spell build → merge → headers as their own workflow steps" | YAML-parsed step lists (below): `ci.yml::build` and `release.yml::prepare-web` each run `Build` → `Merge marketing into web dist` → `Generate _headers …` → `Verify web bundle` → `Upload web build artifact`. |
| "the artifact that deploys never comes through this file" | Follows from the two rows above: the only jobs uploading `web-dist` are those two, and neither invokes this script. |

Parsed step lists (repo's installed `yaml` package):

```
.github/workflows/ci.yml :: build
  ["actions/checkout@v6","./.github/actions/setup-blacksmith","Cache Turbo","Verify production environment",
   "Cache Pyodide assets","Build","Merge marketing into web dist",
   "Generate _headers (CSP hashes per marketing route)","Verify web bundle","Upload web build artifact",
   "Upload admin build artifact","Upload sandbox build artifact","Build mobile OTA bundles (parallel)",
   "Upload mobile build artifacts"]
.github/workflows/release.yml :: prepare-web
  ["actions/checkout@v6","./.github/actions/setup","Cache Pyodide assets","Build web",
   "Merge marketing into web dist","Generate _headers (CSP hashes per marketing route)",
   "Verify web bundle","Upload web build artifact"]
```

## Site 2 — the comment above `deps.verify`

**Old (`:86-91`, i.e. cycle-1's text):**

```
  // After the merge, because the merged dist is what actually deploys: a stray
  // ORT copy or a Pages-limit breach only exists once marketing's output has
  // landed on top of web's. This is not the only gate — the deploy workflows
  // never call this script, they re-spell build → merge → headers as their own
  // steps and run the same guard through `pnpm verify:web-bundle` before
  // uploading the artifact. What comes through here is the e2e/preview bundle.
```

**New (`:91-95`):**

```
  // After the merge, because the defects it catches only exist once marketing's
  // output has landed on top of web's: a stray ORT copy, or a file count past
  // the Pages limit. This gates the e2e/preview bundle and is not the only gate
  // — the jobs that produce the deployed bundle run the same guard on their own
  // merged dist, as a step invoking `pnpm verify:web-bundle` before the upload.
```

Two changes of substance:

1. The loose "the merged dist is what actually deploys" opener is gone. The dist this call
   verifies is the e2e/preview one; the reason the check sits after the merge is the defect
   class, not the deploy. Grounded: `verifyWebBundle` checks stray ORT copies and the
   Cloudflare Pages file/size caps (`scripts/verify-web-bundle.ts:14-26`, constants at
   `:37-39`), both of which are properties of the merged tree.
2. "the deploy workflows never call this script" became "the jobs that produce the deployed
   bundle …" — the same fact stated as the positive, so it no longer reads as a second,
   competing description of this file's reach. The `pnpm verify:web-bundle` step it names is
   `ci.yml::build` / `release.yml::prepare-web`'s `Verify web bundle` step, immediately
   before `Upload web build artifact` (parsed lists above).

## No remaining self-contradiction

Swept every occurrence of `single`, `deploy`, and `prod` in the file:

- The word "single" no longer appears anywhere in it.
- The only statements about the deploy path are the header's `:10-13` and the verify
  comment's `:93-95`. Both say the same thing: the deploy jobs assemble and verify the
  bundle themselves and do not route through this file.
- Left unchanged, and checked for the same defect class rather than assumed: `:72-73`
  ("prod takes its `VITE_*` inline from the caller, exactly like the existing prod build")
  and `:99-100` ("matching the existing prod build's invocation"). Neither claims this
  script is on the deploy path — they compare `--target=prod`'s env handling to the deploy
  job's `Build` step, which is grounded: `ci.yml:284-295` supplies `VITE_API_URL`,
  `VITE_PLATFORM`, `VITE_WEB_URL` etc. inline to that step. So they are accurate and out of
  scope; no edit made.

## Nothing but comments changed

Full diff of the file (against HEAD, so it includes cycle 1's edits as well):

```diff
@@ -1,11 +1,16 @@
 #!/usr/bin/env tsx
 /**
- * The single web-bundle build path: build web + marketing, merge marketing's
...
+ * artifact that deploys never comes through this file.
  *
  * Self-contained: regenerates the env files for its target mode before building,
@@ -83,10 +88,11 @@ export async function buildWebBundle(
   await deps.merge({ repoRoot: rootDir });
 
-  // After the merge, because the merged dist is what actually deploys: a stray
...
+  // merged dist, as a step invoking `pnpm verify:web-bundle` before the upload.
   await deps.verify(appBundleOptions(rootDir, 'apps/web'));
```

Every hunk line is comment text; `parseTarget`, `selectE2eEnvMode`, `buildWebBundle`, and the
CLI entry are byte-identical to cycle 1. Behaviour is therefore unchanged, and the two unit
files that pin this module (49 tests) pass untouched.

Explicitly **not** done, per the brief and both auditors: no workflow-shape assertion pinning
the verify step's position was added. No workflow file, `package.json`, or test was touched
this cycle.

## Self-gate

| command (cwd) | result |
| --- | --- |
| `eslint build-web-bundle.ts` (`scripts/`, run after the last edit) | **pass — exit 0** (prettier runs as an ESLint rule, so formatting is covered) |
| `tsgo --noEmit` (`scripts/`) | **pass — exit 0** |
| `vitest run build-web-bundle.test.ts verify-web-bundle.test.ts` (`scripts/`) | **pass — 2 files, 49 tests** |
| `pnpm verify:web-bundle` (repo root, real merged `apps/web/dist`) | **pass — `Verified …/apps/web/dist`, exit 0** |
| `turbo lint typecheck --filter=@hushbox/scripts --force` | **pass — 2/2 tasks** |
| `turbo test --filter=@hushbox/scripts --force` | **fail — 2 failed files / 88 passed, 1868 tests passed.** Both foreign, see below |

### Attribution of the two failures

`refresh-catalog-run.test.ts` and `seed-run.test.ts`, both `ERR_MODULE_NOT_FOUND` on
`scripts/node_modules/.vite/vitest/…/deps_ssr/@hushbox_db.js`. These are the
foreign-and-unstable failures recorded in the plan's §KNOWN PRE-EXISTING FAILURES and observed
identically in cycle 1, before this cycle's edit existed. Attribution evidence:

- This cycle changed comment text only, in one file. A comment cannot produce a module
  resolution error.
- Neither failing file imports `build-web-bundle` (`grep -l build-web-bundle` over both
  returns nothing); both fail resolving `@hushbox/db`, which this file never imports.
- Neither file appears in this cycle's diff.

Separately noted, not a regression and not attributed to this task: a bare `vitest run` in
`scripts/` (bypassing the package's `test` script, hence its stack/env setup) fails a third
file, `verify-db-objects.integration.test.ts`. It needs the DB stack. Under the scoped check
as the plan defines it (`turbo test --filter=@hushbox/scripts`) only the two foreign files
fail. Recording it because it is a fact about the suite, not because anything here caused it.

Per the brief, `pnpm generate:env` was not run, `.github/workflows/ci.yml` (which carries a
foreign diff) was not touched, and knip was not re-run — its single finding is foreign and
this cycle adds no file, export, or dependency.

## Acceptance criteria (fix cycle 1)

- **Module header no longer claims the production build/deploy paths come through this
  script — met.** Old text quoted above; new text names the two real callers and states
  `--target=prod`'s absence of one. Every clause grounded in the table above.
- **The loose trailing sentence at the old `:90` fixed in the same edit — met.** Site 2
  above; the "what actually deploys" framing and the standalone trailing sentence are both
  gone, replaced by one statement consistent with the header.
- **File gives one answer to "does the production deploy path come through here?" — met.**
  Sweep documented under "No remaining self-contradiction".
- **No workflow-shape assertion added — met.** No workflow file touched; no test added.
- **Nothing else changed — met.** Diff is comment-only, in one file.

## Deviations

None. The edit is confined to the two comment sites the finding names, in the one file it
names.

## Concerns and limitations

- **These comments are true as of the current callers, and nothing enforces that.** The
  header now names `playwright.config.ts` and `ci.yml`'s `e2e-build` job; if a future change
  adds a `pnpm build:web` caller (or moves the deploy jobs onto this script), the header goes
  stale exactly as before. This is the fourth instance of the class in this run, and the fix
  is still a comment — verified today, unpinned tomorrow. The only mechanical alternative
  (asserting workflow shape from a test) was examined by both auditors and declined.
- **The `--target=prod` branch is now documented as having no caller, which raises a product
  question this task does not answer:** whether `build:web` should exist at all. Not touched —
  deleting it is a behaviour change and outside this fix. Flagged for the orchestrator.

## Confidence

**High.** The change is comment-only and every factual clause in it was re-derived this cycle
from a grep, a YAML parse, or a file:line read — none carried over from the prior report's
prose. Lint, typecheck, the module's own tests, and the real-dist bundle verification are all
green after the last edit.
