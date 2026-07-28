# Y6 — Durable renames — implementation report 1

## Objective

Three renames plus the scope extension from the Y2 ruling, with no behaviour change:

1. `scripts/verify-web-bundle.ts` → `scripts/verify-bundle.ts`
2. `scripts/lib/ort-assets-plugin.ts` → `scripts/lib/build-seam.ts`
3. pnpm script `verify:web-bundle` → `verify:bundle`
4. `parseTarget` in `scripts/build-web-bundle.ts` → a name that reads as an assertion,
   keeping its behaviour (loud rejection of a stale `--target=prod`) intact.

## Files changed

Renames performed with `git mv`; all four show as `R` in `git status`, so history follows.

| Path | Why |
| --- | --- |
| `scripts/verify-bundle.ts` (from `verify-web-bundle.ts`) | The guard covers web, admin, sandbox, the Android dist and three OTA dists. "web" was wrong. Internal edits: import of the seam, and the `v8 ignore` comment naming the package script. |
| `scripts/verify-bundle.test.ts` (from `verify-web-bundle.test.ts`) | Colocated test follows its subject; both its imports rewritten. |
| `scripts/lib/build-seam.ts` (from `ort-assets-plugin.ts`) | Carries the ORT assets plugin, `ORT_EXTERN_WASM_CONDITION`, `WORKER_BUILD_OPTIONS` and `TTS_WORKER_SCAN_ENTRY` — it stopped being only an ORT plugin two tasks ago. Internal edit: one doc-comment reference to the guard's old filename. |
| `scripts/lib/build-seam.test.ts` (from `ort-assets-plugin.test.ts`) | Colocated test follows its subject. |
| `scripts/build-web-bundle.ts` | `parseTarget` → `assertE2eTarget` (declaration + sole call site). No other change. |
| `scripts/build-web-bundle.test.ts` | Same rename in imports, `describe` block and four assertions; test names moved from parser language ("parses") to assertion language ("accepts"). |
| `package.json` | `verify:web-bundle` → `verify:bundle`, and the file it invokes. |
| `apps/admin/turbo.json` | Two `inputs` entries repointed. **The cache-key hazard** — see measurements below. |
| `apps/sandbox/turbo.json` | Same two `inputs` entries repointed. |
| `apps/admin/vite.config.ts` | Import path only. |
| `apps/sandbox/src/build.ts` | Import path only. |
| `apps/web/vite.config.ts` | Import path only. |
| `apps/marketing/astro.config.mjs` | Import path only. |
| `.github/workflows/ci.yml` | Two `run:` lines (`:316`, `:369`). Nothing else — the file's pre-existing foreign diff (FCM env block, Resend evidence step) was left untouched. |
| `.github/workflows/release.yml` | One `run:` line. |
| `.github/workflows/build-android.yml` | One `run:` line. |

No doc outside the run directory referenced either name, so no doc edit was required.

### On the name `build-seam.ts`

Justified by the file's own language: its `WORKER_BUILD_OPTIONS` doc already describes
itself as living at "the build-config seam both `apps/web/vite.config.ts` and
`apps/marketing/astro.config.mjs` already import from". The file is exactly that seam —
plugin, resolve condition, worker format, and dev scan entry. No better name surfaced on
reading the full contents, so the plan's proposed name stands.

## Tests

No new behaviour, so no new tests. Existing tests were carried onto the new names and each
rename was driven RED-first rather than mechanically applied:

| Rename | RED observed | GREEN |
| --- | --- | --- |
| `parseTarget` → `assertE2eTarget` | Test updated first: 4 failed / 9 passed, `"(0 , __vite_ssr_import_2__.assertE2eTarget) is not a function"` | 13/13 |
| `ort-assets-plugin` → `build-seam` | Import path updated first: 1 file failed, "no tests" (module resolution) | 14/14 |
| `verify-web-bundle` → `verify-bundle` | Import path updated first: 1 file failed, "no tests" (module resolution) | 40/40 |

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch scripts/verify-bundle.test.ts` | pass — 40/40 |
| `pnpm test:watch scripts/lib/build-seam.test.ts` | pass — 14/14 |
| `pnpm test:watch scripts/build-web-bundle.test.ts` | pass — 13/13 |
| `pnpm test:watch scripts/build-admin-bundle.test.ts` | pass — 5/5 |
| `turbo run test --filter=@hushbox/scripts` | 88/90 files, **1879/1879 tests pass**; 2 files fail to load — pre-existing, see below |
| `eslint` over owned files, from `scripts/` | exit 0 (run after the last edit) |
| `eslint` — `apps/sandbox/src/build.ts`, `apps/marketing/astro.config.mjs` | exit 0 |
| `eslint` — `apps/{web,admin}/vite.config.ts` | exit 0 (both are eslint-ignored by pre-existing config; reported as a warning, not an error) |
| `tsgo --noEmit` — scripts, apps/web, apps/admin, apps/sandbox | all clean |
| `pnpm arch:check` | pass — OK, 12 rules over 2046 files |
| `pnpm lint:unused` (knip) | RED with 2 findings, both foreign — see below |
| `pnpm verify:bundle` (renamed CLI, real web dist) | `Verified …/apps/web/dist`, exit 0 |

**The 2 failing test files are the pair the plan already records** under §KNOWN
PRE-EXISTING FAILURES: `refresh-catalog-run.test.ts` and `seed-run.test.ts`, both
`ERR_MODULE_NOT_FOUND` on `@hushbox/db` from a stale `scripts/node_modules/.vite`
`deps_ssr` cache. Verbatim cause as recorded. Attribution evidence: neither file
references any symbol or path I touched (`grep -lE "verify-bundle|build-seam|
verify-web-bundle|ort-assets|assertE2eTarget|parseTarget"` over both returns nothing), and
zero *tests* fail — both are module-load failures. `generate-env.test.ts`, also listed as
known-red, now passes.

**knip findings, both foreign:** `packages/config/vitest.package.config.ts` reported unused,
plus a `wrangler`/`apps/sandbox` configuration hint. Neither renamed file appears anywhere
in knip's output. Root `knip.jsonc` carries an uncommitted foreign diff (another workstream
deleted the `packages/ui` `ignoreDependencies: ["onnxruntime-common"]` block); I did not
touch that file.

## Acceptance criteria

**1. `verify-web-bundle.ts` → `verify-bundle.ts`** — met. `git status` shows
`RM scripts/verify-web-bundle.ts -> scripts/verify-bundle.ts`.

**2. `ort-assets-plugin.ts` → `build-seam.ts`** — met. `git status` shows
`RM scripts/lib/ort-assets-plugin.ts -> scripts/lib/build-seam.ts`.

**3. pnpm script renamed** — met, and exercised end to end: `pnpm verify:bundle` runs the
renamed file against the real `apps/web/dist` and prints `Verified …`, exit 0.

**4. `parseTarget` renamed to read as an assertion, behaviour unchanged** — met.
Now `assertE2eTarget`. Behaviour verified at the CLI, not just in unit tests:

```
$ npx tsx scripts/build-web-bundle.ts --target=prod
build-web-bundle requires --target=e2e (got: prod)
EXIT=1
```

Not deleted, signature and return type unchanged, and the four tests covering
reject-`prod` / reject-missing / reject-invalid / accept-`e2e` all still pass.

### Zero surviving references

Repo-wide, excluding `node_modules`, `.git`, `docs/plans/runs/` (run records, which
CODE-RULES says are never updated) and `.claude/skills/` (an unrelated `parseTargetOptions`
helper):

```
$ grep -rn "verify-web-bundle\|verify:web-bundle\|ort-assets-plugin\|parseTarget" .
GREP_EXIT=1   # 1 = zero hits
```

Covers code, tests, workflows, JSON and docs. Both old files are gone from disk.

### THE CACHE-KEY HAZARD — hash probe measurements

Method: read `@hushbox/<pkg>#build`'s task hash from `turbo run build --filter=<pkg>
--dry=json`, append one comment line to the renamed file, re-read, restore the file
byte-exactly (sha256 compared), re-read. The turbo daemon was warmed first — the plan
records that the first `--dry=json` can return a degenerate shape.

| Package | Edited file | Task hash: before → moved → restored | Moved? | Returned? |
| --- | --- | --- | --- | --- |
| `@hushbox/admin` | `scripts/verify-bundle.ts` | `1a50a82720e44874` → `d055c10862e536fa` → `1a50a82720e44874` | yes | yes |
| `@hushbox/admin` | `scripts/lib/build-seam.ts` | `1a50a82720e44874` → `031f768ab3d8e9f3` → `1a50a82720e44874` | yes | yes |
| `@hushbox/sandbox` | `scripts/verify-bundle.ts` | `1e44230a383ceae0` → `3e8154440279cae7` → `1e44230a383ceae0` | yes | yes |
| `@hushbox/sandbox` | `scripts/lib/build-seam.ts` | `1e44230a383ceae0` → `e14bcb26e45deabc` → `1e44230a383ceae0` | yes | yes |

All four restores byte-identical. Both files also appear in each task's **resolved** inputs
with a per-file content hash that moves and returns in step, so the declaration resolves to
a real file rather than silently matching nothing:

```
@hushbox/admin   resolved inputs: 159
  ../../scripts/generate-headers.ts, ../../scripts/lib/build-seam.ts,
  ../../scripts/lib/headers-vite-plugin.ts, ../../scripts/lib/is-main.ts,
  ../../scripts/lib/run-main.ts, ../../scripts/verify-bundle.ts
@hushbox/sandbox resolved inputs: 59
  ../../scripts/lib/build-seam.ts, ../../scripts/lib/is-main.ts,
  ../../scripts/lib/run-main.ts, ../../scripts/verify-bundle.ts
```

159 and 59 are exactly the counts §"Y1 FIX CYCLE 1 — result" recorded after that fix, and
`resolvedTaskDefinition.inputs` still opens with `["$TURBO_DEFAULT$", …, ".env*"]`.
**Nothing was narrowed** — the superset property auditor 2 verified is preserved.

**Differential control.** A "moved" reading only means something if an *undeclared* file
does not move the hash. `scripts/lib/headers-vite-plugin.ts` is named by admin's `inputs`
but not by sandbox's, so the same edit is a positive and a negative control at once:

| Package | Edited file | Task hash | Moved? |
| --- | --- | --- | --- |
| `@hushbox/sandbox` | `headers-vite-plugin.ts` (**not** in its inputs) | `1e44230a383ceae0` → `1e44230a383ceae0` → `1e44230a383ceae0` | **no** |
| `@hushbox/admin` | `headers-vite-plugin.ts` (in its inputs) | `1a50a82720e44874` → `079c42ac4bdfe9e5` → `1a50a82720e44874` | yes |

So the hash moves if and only if the edited file is declared. A missed rename entry would
have shown the sandbox row's NO-MOVE signature — which is precisely the state §"Y1 FIX
CYCLE 1" measured before that fix (`ac5205a5257e5140` unchanged across edit and restore).

### Import resolution proven, not inferred

Rather than rebuild web/marketing dists (the plan flags concurrent artifact rebuilds as a
hazard this run has already hit twice), resolution was proven through each consumer's real
loader or typecheck program:

- `apps/web`, `apps/admin`, `apps/sandbox` — `tsgo --noEmit --listFiles` shows
  `scripts/lib/build-seam.ts` and/or `scripts/verify-bundle.ts` inside each program
  alongside the consuming config, with a clean typecheck. An unresolvable import would fail
  here.
- `apps/marketing/astro.config.mjs` — loaded directly under `node --import tsx`:
  `resolved OK: apps/marketing/astro.config.mjs -> default`.
- `scripts/verify-bundle.ts` — executed for real via `pnpm verify:bundle`.

## Deviations

None from the acceptance criteria.

## Concerns and limitations

1. **Exported symbols still say "Web" — deliberately not renamed.** `verifyWebBundle`,
   `VerifyWebBundleOptions`, `collectWebBundleViolations` and the thrown message
   `"Web bundle verification failed (…)"` carry the same wrongness the filename did: they
   now cover admin and sandbox too. This is the debt recorded in §NAMING DEBT. I left it
   because Y6's criteria name the two files and the pnpm script and nothing else, and
   because §NAMING DEBT says the symbol rename is "a follow-up decision". Flagged for a
   ruling; it is a mechanical, behaviour-free change across 6 call sites if wanted.
2. **Turbo baselines drift between readings, for a legitimate reason.** `@hushbox/admin`'s
   `dependencies` include `@hushbox/api#build`, `@hushbox/shared#build`, `@hushbox/ui#build`
   and `@hushbox/config#build`, all of which concurrent workstreams edit continuously. My
   first probe pass showed a spurious non-return on admin for this reason; the structured
   re-run (which also diffs dependency task hashes) came back clean. Anyone re-measuring
   must compare before/moved/restored inside one tight window and must not compare against
   the hash values recorded here — they will have moved for reasons unrelated to this task.
3. **Real cache HIT not demonstrated**, only cache-key sensitivity — the same honest
   limitation the Y1 implementer disclosed. Sensitivity is the property the fix is about.
4. **A foreign in-flight edit carries a stale reference to the old filename.** The
   uncommitted `knip.jsonc` diff deletes the `packages/ui` `ignoreDependencies:
   ["onnxruntime-common"]` block, whose comment ended "…which `ort-assets-plugin.ts` reads
   out of transformers' own dist." It is currently deleted, so my grep is legitimately
   clean — but if that block's owner restores it, the stale filename returns with it.
   Not mine to fix.

## Confidence

**High.** Every criterion is backed by an executed measurement rather than inspection: the
rename is proven by `git status` rename detection, the wiring by four hash probes plus a
differential control that shows the probe can detect the failure it is guarding against,
the resolution by each consumer's own loader or typecheck program, the CLI by a real run
against a real dist, and the preserved validator behaviour by a real invocation exiting 1.
The only judgement call is the deliberate scope boundary in concern 1.
