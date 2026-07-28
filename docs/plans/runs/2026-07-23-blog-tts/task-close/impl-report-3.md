# impl-report-3 — CLOSE FIX, one batch (three completeness-review findings)

**Filename note:** the brief specified `task-close/impl-report-1.md` and said to create the
directory. The directory already existed, holding `impl-report-1.md` and `impl-report-2.md`
from a different close-phase task (the 2026-07-25 plan-identifier sweep in `packages/ui`).
Writing to the specified name would have destroyed a run record, so this report takes the
next free index. Raised to the orchestrator.

## Objective

The three close-review findings as one batch: two comment fixes under fix-cycle-2's
deletion rule (ground in a caller by file:line or delete; no universal quantifiers about
reach; prefer deletion over qualification), and one build verification — force-build web,
marketing and admin, then run `pnpm verify:web-bundle`, confirming the module-load assert
X4 added does not fire on the TTS-free admin app.

## Files changed

- `apps/admin/vite.config.ts` — deleted the false reach claim about every admin build path
  coming through the plugin hook; kept the load-bearing ordering fact.
- `.github/workflows/ci.yml` — verify-step comment: removed one false universal and one
  false "reads only" premise (edit confined to this run's own added block).
- `.github/workflows/release.yml` — the identical twin comment, same edit.

No production code changed; no test added (nothing executable changed — two edits are
comments, the third finding is a verification).

## Tests added

None. Finding 3 is a verification, not an edit; findings 1 and 2 change comment text only.

## Finding 1 — `apps/admin/vite.config.ts`

**Old (lines 22-30):**

```
// Verification lives in this hook, not a second plugin, because Rollup runs
// `closeBundle` as a parallel hook — sibling plugins' hooks are started
// together, so plugin order would not sequence them. The order is load-bearing:
// `_headers` is an emitted file and the Cloudflare Pages file-count check counts
// it. Anchoring the guard in the app's own build config is what makes it
// unbypassable: the production `vite build` behind the deployed dist, the
// e2e-mode build, and any local one all come through here, whatever entry
// point invoked them — which a build-script step or a CI step cannot claim.
```

**New (lines 22-27):**

```
// Verification lives in this hook, not a second plugin, because Rollup runs
// `closeBundle` as a parallel hook — sibling plugins' hooks are started
// together, so plugin order would not sequence them. The order is load-bearing:
// `_headers` is an emitted file and the Cloudflare Pages file-count check
// counts it.
```

Deleted, not rewritten: the "any local one … whatever entry point invoked them" claim,
falsified by a cached `@hushbox/admin#build` replaying a dist without re-running the hook.
Under the deletion rule no replacement reach claim was written.

Kept, and why each survives:

- "Rollup runs `closeBundle` as a parallel hook — plugin order would not sequence them":
  a mechanism fact, not a reach claim, and independently confirmed by the X5a audit
  (`plan.md:933-935`).
- "`_headers` is an emitted file and the Pages file-count check counts it": the durable
  reason verification is sequenced after `generateAdminHeaders` inside one hook body —
  grounded at `apps/admin/vite.config.ts:36-37` (the two sequential awaits) and at
  `checkPagesLimits` in `scripts/verify-web-bundle.ts`, which counts the dist's files.

The first comment paragraph (lines 16-21) was re-read and left alone — it carries no reach
claim.

## Finding 2 — the two workflow step comments

Both files carried identical text. Verdict per claim:

1. **"The deployed bundle is assembled by the three steps above, not by a build script"** —
   **accurate, not changed.** In `ci.yml` the three steps immediately above are `Build`
   (`:284`), `Merge marketing into web dist` (`:298`), `Generate _headers` (`:301`); in
   `release.yml`, `:124`, `:137`, `:139`. Neither job invokes `buildWebBundle` on this
   path — the correction §X5b already established (`plan.md:955-962`).
2. **"after the last step that adds a file to the dist"** — **accurate, not changed.** The
   next step in both jobs is the upload (`ci.yml:319`, `release.yml:156`); nothing between
   headers and upload writes to `apps/web/dist`.
3. **"before the artifact anything deploys from is uploaded"** — **FALSE, changed.**
   `web-dist` is one of four artifacts the deploy job deploys from: `web-dist`
   (`ci.yml:322` uploaded, `:836-840` downloaded), `admin-dist` (`:328`, `:891-895`),
   `sandbox-dist` (`:337`, `:897-901`), `mobile-dist` (`:910-914`). "anything deploys from"
   is exactly the false-universal class this run has been eliminating. Replaced with
   "before the upload" — no quantifier, and the upload is the literal next step.
4. **"Reads only the dist and the installed packages, so it needs no env"** — **premise
   FALSE, changed.** For a TTS-shipping app, `collectWebBundleViolations` calls
   `declaredOrtCommonVersion()`, which reads `pnpm-workspace.yaml` (`PNPM_WORKSPACE_YAML`
   in `scripts/verify-web-bundle.ts`) — a third input that is neither the dist nor an
   installed package. The conclusion is true and is the fact a reader needs (every
   neighbouring step carries a generated `env:` block; this one deliberately does not), so
   the false premise was deleted and the conclusion kept as "The step needs no env block."
   Grounded by execution: `pnpm verify:web-bundle` exits 0 in this checkout with no
   `pnpm generate:env` run in this session, and `grep -n process.env` over
   `scripts/verify-web-bundle.ts`, `scripts/lib/ort-assets-plugin.ts`,
   `scripts/lib/run-main.ts` and `scripts/lib/is-main.ts` returns no matches (exit 1).

**Old (both files):**

```
# The deployed bundle is assembled by the three steps above, not by a
# build script, so the bundle guard runs as its own step: after the last
# step that adds a file to the dist (the Pages file-count check counts
# `_headers`) and before the artifact anything deploys from is uploaded.
# Reads only the dist and the installed packages, so it needs no env.
```

**New (both files):**

```
# The deployed bundle is assembled by the three steps above, not by a
# build script, so the bundle guard runs as its own step: after the last
# step that adds a file to the dist (the Pages file-count check counts
# `_headers`) and before the upload. The step needs no env block.
```

Confinement to this run's own hunk: `git diff -U0 .github/workflows/ci.yml` shows three
hunks — `@@ -142,0 +143,2 @@` and `@@ -222,5 +224,2 @@` (both foreign, untouched) and
`@@ -311,0 +311,7 @@`, which is entirely this run's added verify step plus its comment.
Both edits were unique-string replacements over the comment block only.

## Finding 3 — build verification (no edit)

Baseline before the rebuild (the staleness the finding names): `apps/web/dist` and
`apps/marketing/dist` mtime `Jul 27 09:57`, `apps/admin/dist` mtime `Jul 27 01:58`, all
predating X4's config edits (`packages/ui/.../tts.worker.ts` mtime `Jul 27 10:38`).

```
npx turbo build --filter=@hushbox/web --filter=@hushbox/marketing --filter=@hushbox/admin --force --continue
```

Run twice (the first run's stdout was truncated before the summary; repeated with the log
kept). Second run:

```
@hushbox/marketing:build: cache bypass, force executing fc2e20a6177314ff
@hushbox/admin:build:     cache bypass, force executing e97b4d11463721ee
@hushbox/web:build:       cache bypass, force executing d68eb1198ecd2a00
 Tasks:    3 successful, 3 total
Cached:    0 cached, 3 total
  Time:    13.348s
exit 0
```

Evidence the turbo cache did not replay a stale artifact: `--force` produced a
`cache bypass, force executing` line for each of the three tasks, the summary reports
`0 cached, 3 total`, and every dist was rewritten — newest file per dist after the run:
`apps/web/dist/sw.js 12:08:12`, `apps/marketing/dist/sitemap-index.xml 12:08:17`,
`apps/admin/dist/_headers 12:09` (second run), against pre-run dist mtimes of 09:57 /
09:57 / 01:58.

**The module-load assert passed.** `apps/admin/vite.config.ts:9` imports
`scripts/verify-web-bundle`, which imports `./lib/ort-assets-plugin.js`
(`scripts/verify-web-bundle.ts:30`), whose module body executes
`export const TTS_WORKER_SCAN_ENTRY = resolveTtsWorkerSource()`
(`scripts/lib/ort-assets-plugin.ts:129`) and throws if
`packages/ui/src/components/accessibility/lib/tts.worker.ts` is missing. That file exists
(10,139 bytes, mtime 10:38), the admin config therefore resolved, and
`@hushbox/admin#build` exited 0 — the assert did not fire on the app X2 made TTS-free.
That the hook body itself ran is shown by the freshly emitted `apps/admin/dist/_headers`,
which only `generateAdminHeaders` writes; `verifyWebBundle` is the await immediately after
it in the same `closeBundle`, and a violation there would have failed the build.

**`pnpm verify:web-bundle`** — run twice, both exit 0:

- against the freshly built (unmerged) `apps/web/dist` (932 files): `Verified …/apps/web/dist`.
- after `pnpm tsx scripts/merge-marketing-into-web.ts` (merged 83 files; 1,013 files total),
  reproducing CI's build → merge → verify shape: `Verified …/apps/web/dist`, exit 0.
  `Generate _headers` was not run in between because it needs `VITE_API_URL` from
  `pnpm generate:env`, which every brief in this run forbids; its only effect on this check
  is one fewer file in the Pages file count.

**Admin dist after the rebuild:** 1.5 MB, 33 files. Zero matches for `*tts*`, zero for
`ort-*.wasm`, zero for `*.wasm` anywhere under `apps/admin/dist`. Largest file
`assets/index-DDqkSULo.js` at 797,699 B.

**Workflow YAML still parses** (comment-only edit, but these are the deploy path):
`ci.yml` 13 jobs, `release.yml` 6 jobs, both `yaml.safe_load` clean, and the step order
around the guard is unchanged in both — `['Generate _headers (CSP hashes per marketing
route)', 'Verify web bundle', 'Upload web build artifact']`.

## Self-gate

| command | result |
| --- | --- |
| `npx eslint .` in `apps/admin` (the package's own `lint` script) | pass — exit 0, no output, run after the last edit |
| `npx eslint vite.config.ts` in `apps/admin` | exit 0 with "File ignored because of a matching ignore pattern" — `**/*.config.ts` is globally ignored at `packages/config/eslint.config.js:95`, repo-wide and pre-existing |
| `npx prettier --check apps/admin/vite.config.ts` | pass |
| `npx prettier --check .github/workflows/ci.yml .github/workflows/release.yml` | pass (ESLint does not cover `.yml` here — no yaml entry in the shared config) |
| `npx tsc --noEmit -p tsconfig.json` in `apps/admin` | pass — exit 0 |
| `npx turbo build --filter=@hushbox/{web,marketing,admin} --force --continue` | pass — 3 successful, 0 cached |
| `pnpm verify:web-bundle` (unmerged dist, then merged dist) | pass — exit 0 both times |

The foreign `TS6133` in `apps/api/src/slices/notifications/adapters/email-sender-factory.ts`
recorded in §CONCURRENCY CORRECTION no longer reproduces — admin typecheck is green. Not
this task's doing; another workstream evidently fixed it.

`scripts/refresh-catalog-run.test.ts` / `seed-run.test.ts` were not run: no `scripts/` file
was edited, so the `@hushbox/scripts` suite was not in this batch's path, and their remedy
is forbidden here regardless.

## Acceptance criteria

1. **Finding 1 — the false reach claim deleted, the WHY of the in-hook,
   post-`generateAdminHeaders` placement kept** — MET. Old/new text above; the surviving
   text asserts no reach and each clause is grounded (parallel-hook semantics; `_headers`
   counted by the Pages check).
2. **Finding 2 — both workflow comments re-read; fixed only where a claim is false** — MET.
   Two of four claims were false ("anything deploys from"; "reads only the dist and the
   installed packages"), both corrected by deleting the false part; the two accurate claims
   were left verbatim.
3. **Finding 3 — all three apps force-built and `pnpm verify:web-bundle` run; the admin
   module-load assert did not fire** — MET, with the cache-bypass evidence above.

## Deviations

1. **Report filename** — `impl-report-3.md` rather than the specified `impl-report-1.md`;
   see the note at the top. Nothing in the directory was overwritten.
2. **Extra step: `merge-marketing-into-web.ts` was run and `verify:web-bundle` repeated
   against the merged dist.** The brief asked for build-then-verify; a plain `vite build` of
   web empties `apps/web/dist`, so verifying only that output would have verified a shape CI
   never uploads. The merge is env-free, so this cost nothing and made the check faithful to
   `ci.yml`'s build → merge → verify order. It also leaves `apps/web/dist` merged rather
   than unmerged.
3. **The force build was run twice** — the first run's summary was lost to output
   truncation. Identical result; the second run's numbers are the ones reported.

## Concerns and limitations

- **The workflow steps themselves remain unexecuted here.** As §X5b recorded, agents cannot
  run GitHub Actions. What is verified is that the YAML parses, the step's position is
  unchanged, and the command it runs exits 0 locally against the real merged dist.
- **"The step needs no env block" is grounded on the current script.** If
  `verify-web-bundle` or anything under `scripts/lib/` later reads an environment variable,
  the sentence goes stale. Nothing pins it; the failure mode is a loud CI failure at that
  step, not silent drift.
- **Rebuilding `apps/web/dist` replaced whatever state it held from an earlier run**; it is
  now web's own build plus the marketing merge, with no `_headers` (that step needs
  generated env). A concurrent workstream expecting the previous dist must rebuild.
- Nothing pins the deleted admin comment's absence — comments are not testable, and this run
  has already established that guarding a comment with a mechanism would be the second
  mechanism CODE-RULES forbids.

## Confidence

High — both comment edits are deletions of claims falsified against named file:line
callers, with no new assertion introduced; the build verification is direct executable
evidence with the cache demonstrably bypassed.
