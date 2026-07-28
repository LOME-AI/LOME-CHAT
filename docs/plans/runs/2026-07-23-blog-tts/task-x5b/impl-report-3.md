# X5b — impl report 3 (fix cycle 2)

## Objective

Fix the three validated findings under fix cycle 2's rule: every claim in
`scripts/verify-web-bundle.ts` and `scripts/build-web-bundle.ts` about where the guard runs,
what calls what, or what is covered is either grounded in a caller citable by file:line, or
deleted. No universal quantifiers about reach. Prefer deletion over qualification. Comments
only; no behaviour change.

**All `:N` coordinates below are post-edit line numbers unless the quote is labelled "Old",
in which case they are the pre-edit ones this cycle started from.**

## Files changed

- `scripts/verify-web-bundle.ts` — three comment sites (module header, `APPS_SHIPPING_TTS`
  docstring, `VerifyBundle` docstring). No executable line changed.
- `scripts/build-web-bundle.ts` — five comment sites (module header, `selectE2eEnvMode`
  docstring, and three body comments). No executable line changed.

Both files were swept completely, not only at the three finding sites. One additional
instance of the class was found and fixed (the `VerifyBundle` docstring, below).

## Finding 1 — `verify-web-bundle.ts` module header — DELETED

**Old (`:2-5`, the text this cycle started from):**

```
 * Build-time guards on a built app bundle, run wherever a dist becomes final:
 * from admin's own vite build, from the e2e/preview web build script, and — via
 * this file's CLI entry — as the deploy workflows' step on the merged web dist,
 * which no build script assembles.
```

(The committed HEAD text differs — "run by each app's build script right after its dist is
final, so prod, e2e, and the preview build all pay them" — because cycle 1 rewrote this
header. Both spellings make the same universal claim; both are gone.)

**New (`:2-3`):**

```
 * Guards on a built app bundle. Five classes of problem it turns into a
 * verification failure:
```

**Why deleted rather than rewritten.** The claim is a universal over build paths ("run
wherever a dist becomes final" / "each app's build script"), and it is false in both
directions:

- `.github/workflows/build-android.yml:86-87` runs `pnpm --filter web build` to produce the
  web assets packaged into the Android app, and `apps/web/vite.config.ts` has no verify hook,
  so that dist becomes final without the guard.
- `.github/workflows/ci.yml:340-352` builds `apps/web/dist-{ios,android,android-direct}` OTA
  bundles that no guard reads.

Any accurate replacement would have to enumerate three unrelated invocation shapes and then
carve out the two ungated ones — a paragraph the next reader still cannot check in one hop,
and one that would paper over an ungated-artifact gap already escalated to the founder. The
guard's actual invocations are visible at each call site (`apps/admin/vite.config.ts:37`,
`scripts/build-web-bundle.ts:86`, `scripts/verify-web-bundle.ts:441`); the header now says
nothing about them. "build failure" also became "verification failure", because this module
throws and does not know what its caller does with the throw.

## Finding 2 — `APPS_SHIPPING_TTS` docstring — crawler-view claim DELETED

**Old (`:42-46`):**

```
 * Which apps ship the on-device TTS engine, keyed by workspace-relative app
 * directory. The single place the answer is written down: every verified build
 * reads it through `appBundleOptions`, so no call site can disagree with
 * another. `apps/crawler-view` has no build script yet and is listed anyway, so
 * the guard is already in force the day it gets one.
```

**New (`:38-40`):**

```
 * Which apps ship the on-device TTS engine, keyed by workspace-relative app
 * directory. Read by `appBundleOptions` below, which throws for an app absent
 * from this map rather than assuming an answer for it.
```

Three claims removed, one kept:

| Claim | Disposition |
| --- | --- |
| "`apps/crawler-view` … the guard is already in force the day it gets one" | **Deleted — false.** Verified `apps/crawler-view/package.json` declares `dev`/`lint`/`typecheck`/`test`/`test:watch` and no `build`, so the premise holds — but nothing wires a future crawler-view build to `verifyWebBundle`. The map entry only stops `appBundleOptions` throwing (`scripts/verify-web-bundle.ts:50-54`). The entry now stands with no explanation, which is the honest state. |
| "The single place the answer is written down" | **Deleted.** A banned universal about reach; unverifiable as written. |
| "every verified build reads it through `appBundleOptions`" | **Deleted.** Universal over builds. The three real call sites are `apps/admin/vite.config.ts:37`, `scripts/build-web-bundle.ts:86`, `scripts/verify-web-bundle.ts:441` — but "every verified build" asserts a closed set no reader can check. |
| "Read by `appBundleOptions` below, which throws for an app absent from this map" | **Kept — grounded in this file.** `scripts/verify-web-bundle.ts:50-54`: `APPS_SHIPPING_TTS.get(appDir)`, then `if (shipsTts === undefined) throw`. Checkable without leaving the file. Pinned by `scripts/verify-web-bundle.test.ts:468` (`appBundleOptions('/repo', 'apps/sandbox')` throws `/declared TTS expectation/`). |

## Finding 3 — `build-web-bundle.ts` prod-caller comments — DELETED (three sites)

All three spoke in the present tense of a `--target=prod` caller that does not exist.
Re-verified this cycle: a repo-wide grep for `build:web` / `build-web-bundle` outside
`node_modules`, `dist`, `legacy`, and the plan dirs returns `package.json:14` (the
definition) and nothing that invokes `build:web`.

**Site 3a — `selectE2eEnvMode` docstring. Old `:52-53` → new `:46-47`:**

```
-  * direct `process.env.CI` check. Prod has no analogue: its `VITE_*` arrive inline
-  * from the caller (CI build env), so nothing is generated.
+  * direct `process.env.CI` check. Prod has no analogue: only `--target=e2e`
+  * generates env files (see `buildWebBundle`).
```

Kept clause grounded in this file: `scripts/build-web-bundle.ts:68-72` — the
`deps.generateEnv(…)` call sits inside `if (target === 'e2e')`. No claim about any caller.

**Site 3b — env-generation body comment. Old `:72-75` → new `:66-67`:**

```
-  // e2e self-generates its env files (VITE_E2E, localhost, sandbox tokens). prod
-  // takes its VITE_* inline from the caller, exactly like the existing prod build
-  // — there is nothing to generate, and Mode.Production targets wrangler.toml, not
-  // this web bundle.
+  // e2e self-generates its env files (VITE_E2E, localhost, sandbox tokens); prod
+  // generates none.
```

"takes its `VITE_*` inline from the caller, exactly like the existing prod build" — deleted,
no such caller. The `Mode.Production targets wrangler.toml` clause **is** groundable
(`scripts/generate-env.ts:278` resolves `apps/api/wrangler.toml`; `:275-306` writes its
`[vars]` under `Mode.Production`), but it only earned its place as the reason prod's caller
supplies env another way — the very claim being deleted — so it went with it rather than
being left as a dangling half-fact. What remains is grounded at
`scripts/build-web-bundle.ts:68-72`.

**Site 3c — headers-generation body comment. Old `:98-100` → new `:88-89`:**

```
   // e2e re-runs under with-env so the freshly generated VITE_API_URL / minio port
-  // reach the CSP generator; prod reads them from the inline build env directly,
-  // matching the existing prod build's invocation.
+  // reach the CSP generator.
```

"matching the existing prod build's invocation" — deleted; the referent is a caller that does
not exist. The kept sentence explains the `e2e` branch only, grounded at
`scripts/build-web-bundle.ts:90-92` (the ternary: e2e goes through `scripts/with-env.ts`,
prod does not).

## Fourth instance found in the sweep — `VerifyBundle` docstring — FIXED

Not listed in the three findings. Found by sweeping `verify-web-bundle.ts` end to end.

```
-/** The seam each build script injects, so its own tests need no real dist. */
+/** The seam `build-web-bundle.ts` injects, so its tests need no real dist. */
```

(post-edit `:131`)

"each build script" was a universal over injectors, and it is stale as of X5a: the only
`VerifyBundle` injector left is `scripts/build-web-bundle.ts:57` (`readonly verify:
VerifyBundle` on `BuildWebBundleDeps`), stubbed at `scripts/build-web-bundle.test.ts:47`
(`verify: vi.fn<BuildWebBundleDeps['verify']>()`). `scripts/build-admin-bundle.ts` no longer
injects it — X5a removed that call — and `apps/admin/vite.config.ts:37` calls `verifyWebBundle`
directly rather than through the seam type. One named injector, so the comment names it.

## Also changed in `build-web-bundle.ts` — module header

Not one of the three findings, but part of the same sweep: cycle 1's header carried "its two
callers" (a closed-set completeness claim) and a negative universal ("`--target=prod` … has no
caller beyond its own `build:web` script definition … the artifact that deploys never comes
through this file"). A negative reach claim cannot be grounded in a caller by construction, so
under this cycle's rule it is deleted rather than re-argued.

**New (`:3-7`):**

```
 * The web-bundle build sequence: build web + marketing, merge marketing's output
 * on top of web's, then generate the CSP `_headers`. `--target=e2e` builds in dev
 * mode (loads `.env.development`); `playwright.config.ts`'s preview server and
 * CI's `e2e-build` job invoke it that way, via `pnpm build:e2e`. `--target=prod`
 * runs the same sequence in prod mode.
```

Grounding, clause by clause (all re-derived this cycle):

| Clause | Caller |
| --- | --- |
| "`playwright.config.ts`'s preview server … via `pnpm build:e2e`" | `playwright.config.ts:96` — `(process.env['HB_E2E_PREBUILT'] ? '' : 'pnpm build:e2e && ') + …` inside the `webServer` block. |
| "CI's `e2e-build` job … via `pnpm build:e2e`" | `.github/workflows/ci.yml:403` — `run: pnpm build:e2e`, step "Build merged e2e web bundle", in the job declared at `.github/workflows/ci.yml:380`. |
| "`--target=e2e` builds in dev mode (loads `.env.development`)" | `scripts/build-web-bundle.ts:78` — `turboArgs.push('--', '--mode', 'development')` for `e2e` only. |
| "`--target=prod` runs the same sequence in prod mode" | Same function, single code path; the only `target` branches are `:68` (env), `:78` (mode) and `:90` (with-env). |

Two enumerated call sites; no "the two callers", no statement about what has no caller, and no
statement about the deploy path. The verify comment below it (`:83-85`, quoted next) makes no
competing claim either, so the file still gives one answer — by saying less.

## Also changed in `build-web-bundle.ts` — the `deps.verify` comment

Old `:86-91` → new `:83-85`:

```
-  // After the merge, because the merged dist is what actually deploys: a stray
-  // ORT copy or a Pages-limit breach only exists once marketing's output has
-  // landed on top of web's. This gates the e2e/preview bundle and is not the only
-  // gate — the jobs that produce the deployed bundle run the same guard on their
-  // own merged dist, as a step invoking `pnpm verify:web-bundle` before the upload.
+  // After the merge, because the defects it catches only exist once marketing's
+  // output has landed on top of web's: a stray ORT copy, or a file count past
+  // the Pages limit.
```

The remaining sentence states only the ordering constraint and its reason, both grounded in
the checker itself: `checkStrayRuntimeCopies` (`scripts/verify-web-bundle.ts:181-197`) and
`checkPagesLimits` (`scripts/verify-web-bundle.ts:386-401`) both read the merged file list.
Cycle 1's "not the only gate — the jobs that produce the deployed bundle run the same guard …"
is gone: it was a claim about workflow-job reach, and under this cycle's rule a comment that
says nothing about other gates beats one that characterises them.

## Complete-sweep statement

Both files were read end to end and grepped for the class markers (`every`, `all`, `each`,
`wherever`, `the single`, `deploy`, `prod`, `caller`, `call site`, `workflow`, `build script`,
`covered`, `gate`). Every surviving hit was individually judged; the ones left standing and
why:

| Site (post-edit) | Text | Why it stays |
| --- | --- | --- |
| `verify-web-bundle.ts:13`, `:19` | "every Pages deploy, APK, and OTA zip"; "every built site" | Consequences of the *defect* if it ships, not claims about where the guard runs or what calls it. Out of the defect class. |
| `verify-web-bundle.ts:20` | "exceeding either one fails the deploy" | Cloudflare Pages behaviour; not a reach claim. |
| `verify-web-bundle.ts:77` | "The version every ORT copy in the bundle must report" | The invariant `checkOrtCommonVersion` enforces over the files it reads (`:266-301`), in-file. |
| `verify-web-bundle.ts:98` | "wherever a bundler emitted them" | Describes what the regex matches across the dist file list (`checkStrayRuntimeCopies`, `:181-197`), not where the guard runs. Left as-is: rewriting a correct in-file statement is how earlier cycles introduced new false assertions. |
| `verify-web-bundle.ts:408`, `:411` | "Every ORT and worker check below…"; "replaces all four" | About the checks in this file's own `collectWebBundleViolations`, verifiable by reading `:417-424`. |
| `verify-web-bundle.ts:437` | v8-ignore reason: "CLI entry point exercised via the verify:web-bundle package script" | Grounded: `package.json:75` defines it; `.github/workflows/ci.yml:317` and `.github/workflows/release.yml:155` run it. |
| `build-web-bundle.ts:74` | "`^build` is free here (workspace packages have no build script)" | **Checked, not assumed:** all six `packages/*/package.json` manifests (`config`, `crypto`, `db`, `realtime`, `shared`, `ui`) declare no `build` script. True today; not a claim about the guard. |
| `build-web-bundle.ts:95` | v8-ignore reason: "CLI entry point exercised via the build:* package scripts" | `package.json:14-15` define `build:web` and `build:e2e` against this file; `build:e2e` is invoked at `playwright.config.ts:96` and `.github/workflows/ci.yml:403`. |

Nothing beyond the three findings and the `VerifyBundle` docstring turned out to be in the
class.

## Observed but NOT changed (out of the two-file scope) — for the orchestrator

Two files outside this task's scope carry the same "single build path" phrasing that fix
cycle 1 removed from `build-web-bundle.ts`. Neither is in the brief's scope and neither was
touched:

- `playwright.config.ts:91` — "`build:e2e` is the single web-bundle build path (Turbo-cached
  + parallel, …)". In context it explains why the preview server shells out to that script,
  and it is not making the deploy-path claim — but it is the same phrase.
- `.github/workflows/ci.yml:376` — "…instead of rebuilding it (6 cold builds -> 1).
  `build:e2e` is the single…". `ci.yml` also carries a foreign uncommitted diff, and the brief
  forbids touching it.

Recording, not proposing.

## Self-gate

This task was interrupted by a session limit after the edits were complete and re-verified
afterwards. Everything below is the **post-resume** run, executed after the last edit. Before
re-running it I confirmed neither file had been touched by the concurrent workstreams during
the gap (`git status` shows only my two modifications; both mtimes are still my own edit
times), and I re-read every `:N` coordinate cited in this report against the current files
rather than trusting the numbers recorded before the pause. One was stale and is corrected:
`checkStrayRuntimeCopies` spans `:181-197`, not `:181-193`. Every other in-file and external
citation re-verified exact — including the ones in `.github/workflows/ci.yml`, which carries a
foreign diff and could have shifted (`:317`, `:340-352`, `:376`, `:380`, `:403` all still
land on the quoted lines).

| command (cwd) | result |
| --- | --- |
| `eslint verify-web-bundle.ts build-web-bundle.ts` (`scripts/`, run after the last edit) | **pass — exit 0** (prettier runs as an ESLint rule, so formatting is covered) |
| `tsgo --noEmit` (`scripts/`) | **pass — exit 0** |
| `vitest run build-web-bundle.test.ts verify-web-bundle.test.ts` (`scripts/`) | **pass — 2 files, 49 tests** |
| `pnpm verify:web-bundle` (repo root, real merged `apps/web/dist`) | **pass — `Verified …/apps/web/dist`, exit 0** |
| `turbo test --filter=@hushbox/scripts --force` | **fail — 2 failed files / 88 passed, 1868 tests passed.** Both foreign, attributed below |

### Attribution of the two failures

`refresh-catalog-run.test.ts` and `seed-run.test.ts`, both `ERR_MODULE_NOT_FOUND` on
`scripts/node_modules/.vite/vitest/…/deps_ssr/@hushbox_db.js`. The brief names these two files
as foreign with an unstable cause; this run's observed cause is the deps_ssr one. Evidence
they are not mine:

- This cycle changed comment text only, in two files. A comment cannot produce a module
  resolution error.
- `grep -l "build-web-bundle\|verify-web-bundle"` over both failing files returns nothing —
  neither imports either changed module. Both fail resolving `@hushbox/db`, which neither
  changed file imports.
- `git status --porcelain` for both failing files is empty — untouched by this task.

Not re-run, per the brief: `pnpm lint:unused` (knip's single finding is foreign and this cycle
adds no file, export, or dependency), `pnpm generate:env` (not run), and the DB stack for
`verify-db-objects.integration.test.ts`. `.github/workflows/ci.yml` — which carries the foreign
diff — was not touched; nor was `release.yml`, `package.json`, or any test.

## Nothing but comments changed

Mechanically checked rather than asserted — every changed line with comment lines filtered
out:

```
$ git diff -U0 -- scripts/build-web-bundle.ts scripts/verify-web-bundle.ts \
    | grep -E "^[+-]" | grep -vE "^(\+\+\+|---)" \
    | grep -vE "^[+-]\s*(\*|//|/\*)" | grep -vE "^[+-]\s*$"
+import { isMainModule } from './lib/is-main.js';
+import { runMain } from './lib/run-main.js';
+if (isMainModule(import.meta.url)) {
+  await runMain(async () => {
+    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
+    await verifyWebBundle(appBundleOptions(repoRoot, 'apps/web'));
+    console.log(`Verified ${path.join(repoRoot, 'apps/web', 'dist')}`);
+  });
+}
```

Those nine lines are **cycle 1's** CLI entry in `verify-web-bundle.ts` (the diff is against
HEAD, which predates cycle 1). `build-web-bundle.ts` contributes zero non-comment lines, and
this cycle contributed none in either file. `parseTarget`, `selectE2eEnvMode`,
`buildWebBundle`, the `APPS_SHIPPING_TTS` map entries, every check function,
`collectWebBundleViolations`, `verifyWebBundle`, and both CLI entries are byte-identical to
cycle 2's starting state. Behaviour is unchanged, which the 49 untouched unit tests and the
green run against the real merged dist confirm.

## Acceptance criteria (fix cycle 2)

1. **`verify-web-bundle.ts:2-5` reach claim — met (deleted).** Quoted above; nothing replaced
   it.
2. **`verify-web-bundle.ts:44-46` crawler-view claim — met (deleted).** Quoted above; the map
   entry remains, unexplained rather than falsely explained.
3. **`build-web-bundle.ts:52-53`, `:72-73`, `:99-100` prod-caller claims — met (deleted at all
   three sites).** Quoted above, with the surviving text grounded in this file.
   (Criteria 1–3 cite the plan's pre-edit coordinates.)
4. **Both files swept completely — met.** Table above; one additional instance found
   (`VerifyBundle` docstring) and fixed this cycle, plus the two sites cycle 1 had rewritten
   (this file's module header and the `deps.verify` comment), which this cycle deletes.
5. **No universal quantifier about reach anywhere in the two files — met.** The surviving
   `every`/`all`/`wherever` uses are about defect consequences or this file's own check set,
   itemised in the sweep table.
6. **Instructed non-actions honoured — met.** No workflow-shape assertion added; `build:web`
   and `--target=prod` untouched; `.github/workflows/ci.yml` untouched; `pnpm generate:env` not
   run; no behaviour change.

## Deviations

Two edits beyond the three findings, both required by the brief's "sweep BOTH files
completely" instruction and reported as findings rather than silently made:

1. `VerifyBundle`'s docstring (fourth instance of the class, detailed above).
2. `build-web-bundle.ts`'s module header and `deps.verify` comment — cycle 1's own rewrites,
   which still carried a closed-set completeness claim and a negative universal about the
   deploy path. Deleted under this cycle's rule rather than left standing, because cycle 1
   had already touched them and the rule now supersedes cycle 1's approach.

## Concerns and limitations

- **The remaining comments are smaller and in-file, which is the point, but the two enumerated
  call sites in `build-web-bundle.ts`'s header are still unpinned.** If a third `pnpm
  build:e2e` caller appears, the header does not become false (it does not claim
  completeness), but it becomes incomplete. That is the weakest form of staleness available
  short of naming no callers at all, which would have cost the reader the one fact worth
  having.
- **The ungated artifacts are now undocumented in these files.** Deleting the header claim
  removes the false impression of coverage, but nothing in-code now points at
  `build-android.yml`'s unmerged web dist or `ci.yml`'s OTA bundles. The plan already carries
  that escalation for the founder; a comment restating it would be a fifth reach claim.
- **`apps/crawler-view`'s map entry now has no rationale.** A future reader may not know why a
  buildless app is listed. The truthful rationale is what the kept sentence above the map
  already implies — `appBundleOptions` throws for an app absent from the map.

## Confidence

**High.** Every surviving factual clause was re-derived this cycle from a grep, a file:line
read, or a manifest check — none carried over from the prior reports' prose — and every
`:N` coordinate in this report was re-checked against the post-edit files after the last
edit. The strong bias this cycle was deletion, so there are materially fewer claims left to
be wrong. Lint, typecheck, the modules' own 49 tests, and the real-dist verification are all
green after the last edit.
