# impl-report-1

## Objective

Bring `docs/DEVELOPMENT.md` current: add bundle verification to the enumerated CI gate
list, add `pnpm verify:bundle` to the standalone gate commands, and record — durably and
densely — what the guard actually covers. Docs only; no code change.

## Files changed

- `docs/DEVELOPMENT.md` — the only file touched. Two edits (commands bullet, CI gates
  paragraph).

No new section was added. Both facts had a natural home: the standalone-gates bullet under
`## Commands` and the `Gates:` paragraph under `## CI`. The coverage sentence sits with the
gate it qualifies rather than in a section of its own.

## Edits — exact before/after

### Edit 1 — standalone gate commands (`## Commands`)

Before:

```
- `pnpm lint` / `lint:fix` / `typecheck` / `format` — plus the standalone gates:
  `pnpm arch:check` (ts-morph structural rules), `pnpm lint:duplication` (jscpd),
  `pnpm lint:unused` (knip).
```

After:

```
- `pnpm lint` / `lint:fix` / `typecheck` / `format` — plus the standalone gates:
  `pnpm arch:check` (ts-morph structural rules), `pnpm lint:duplication` (jscpd),
  `pnpm lint:unused` (knip), `pnpm verify:bundle` (an already-built `apps/web`
  dist; name other dist directories as arguments).
```

### Edit 2 — CI gate list + coverage (`## CI`)

Before:

```
Gates: lint + `arch:check` · typecheck + migration drift (an uncommitted
`packages/db/drizzle/` diff fails) · duplication (jscpd) · unused (knip) · gitleaks ·
test (AI calls replay from cassettes while the request is unchanged; a changed or
uncached request makes one real call and records it in the same run) · build.
Prettier runs as an ESLint rule, so formatting is covered by the lint gate (CI and
pre-push). Pre-commit regenerates derived files and re-stages them; pre-push runs
ESLint, typecheck, and tests (husky).
```

After:

```
Gates: lint + `arch:check` · typecheck + migration drift (an uncommitted
`packages/db/drizzle/` diff fails) · duplication (jscpd) · unused (knip) · gitleaks ·
test (AI calls replay from cassettes while the request is unchanged; a changed or
uncached request makes one real call and records it in the same run) · build +
bundle verification. Bundle verification is invoked, never ambient: `apps/admin` and
`apps/sandbox` verify themselves at build · the web dist is verified by workflow
steps — the merged bundle before upload, the pre-merge dist Android packages, the
three mobile OTA bundles. Presence in the guard's app map is a TTS declaration, not
coverage. Prettier runs as an ESLint rule, so formatting is covered by the lint gate
(CI and pre-push). Pre-commit regenerates derived files and re-stages them; pre-push
runs ESLint, typecheck, and tests (husky).
```

The last line's re-wrap (`pre-push runs` → `pre-push` / `runs`) is the ripple of the
inserted text on an unchanged sentence, not an independent edit.

## Fact-by-fact verification

| Asserted in the doc                                        | Verified against                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify:bundle` exists as a script                    | `package.json:74` — `"verify:bundle": "tsx scripts/verify-bundle.ts"`                                                                                                                                      |
| It runs over an **already-built** dist, `apps/web`, and takes dist directory names as arguments | `scripts/verify-bundle.ts` CLI entry: iterates `requestedDistributionDirectories(process.argv.slice(2))` and calls `appBundleOptions(repoRoot, 'apps/web', distributionDirName)` — the app is hardcoded, argv only selects dist directories; it reads a dist, never builds one |
| Bundle verification is a CI gate                            | `.github/workflows/ci.yml:315-316` (`- name: Verify web bundle` / `run: pnpm verify:bundle`) and `:367-369` (`run: pnpm verify:bundle dist-ios dist-android dist-android-direct`), both inside the build job |
| `apps/admin` verifies itself at build                       | `apps/admin/vite.config.ts:9,34` — `verifyBundle(appBundleOptions(rootDir, 'apps/admin'))` inside the `finalizeAdminDistPlugin` `closeBundle` hook, so it fires on every `vite build`; `apps/admin/package.json` `build` = `vite build`  |
| `apps/sandbox` verifies itself at build                     | `apps/sandbox/src/build.ts:5,46` — `verifyBundle(appBundleOptions(..., 'apps/sandbox'))`; `apps/sandbox/package.json` `build` = `tsx src/build.ts`                                                          |
| The web dist is verified by **workflow steps**, not its build script | `apps/web/package.json` `build` = plain `vite build`; `apps/web/vite.config.ts` imports from `scripts/lib/build-seam` only — no `verifyBundle` call anywhere in the web build                                |
| "the merged bundle before upload"                           | `.github/workflows/ci.yml:298-322` and `.github/workflows/release.yml:137-159`: merge-marketing → generate `_headers` → `Verify web bundle` → `Upload web build artifact`                                    |
| "the pre-merge dist Android packages"                       | `.github/workflows/build-android.yml:86-107`: `Build web for Android` (`pnpm --filter web build`, no marketing merge) → `Verify web bundle` → `Sync Android` (`npx cap sync android`)                        |
| "three mobile OTA bundles"                                  | `.github/workflows/ci.yml:344-369` — the loop builds `dist-ios`, `dist-android`, `dist-android-direct`, then the verify step names exactly those three                                                       |
| iOS is not listed separately — and is not a gap             | `.github/workflows/build-ios.yml:29-48`: the iOS job **downloads** the `web-dist` artifact and runs `cap sync ios`; it builds no web dist, so it packages bytes already verified before upload. Covered by "the merged bundle before upload"; naming it would be inventory |
| "Presence in the guard's app map is a TTS declaration, not coverage" | `scripts/verify-bundle.ts` — `APPS_SHIPPING_TTS` is documented as "Which apps ship the on-device TTS engine … Read by `appBundleOptions`", and lists `apps/crawler-view`; `apps/crawler-view/package.json` has `dev`/`lint`/`typecheck`/`test` and **no `build` script**, so no build of it can invoke the guard |

`apps/crawler-view` is deliberately unnamed in the doc — the sentence states the durable
constraint (map membership ≠ coverage) that prevents the mistake, without a name that a
concurrent task is editing and without implying the app is verified.

## What I chose not to add, and why

Each candidate was put to the repo's own test — would removing it cause a reader to make a
mistake?

- **What the guard checks** (TTS/ORT payload duplication, onnxruntime version skew, worker
  `new.target` corruption, missing `_headers`, Cloudflare Pages limits). Cut: this is the
  guard's own doc-comment, six classes long, and it is exactly the "why it exists" the
  brief forbids. A reader who needs it reads the script; a stale summary here would be a
  wrong comment at file scale.
- **The `pnpm build:e2e` path** (`scripts/build-web-bundle.ts:27,106` also calls
  `verifyBundle`). Verified to exist, deliberately omitted: it produces a test-only bundle,
  nothing ships from it, and listing it turns a constraint into an inventory. This is why
  the coverage sentence is phrased as "invoked, never ambient" rather than as a closed
  "nothing else is verified" — the framing carries the consequence for shipped output
  without asserting a universal negative that the e2e build would falsify.
- **iOS as a separate covered entry.** Covered transitively via the uploaded artifact
  (evidence above); "before upload" already carries it in four fewer words.
- **Line numbers, counts, and file lists.** None appear. The only counted thing is "three
  mobile OTA bundles", which is a fixed platform set (ios / android / android-direct)
  named as such in the workflow, not a count of files that drifts.
- **A new section.** Not needed; stated above.
- **Fixing a stale `apps/crawler-view` claim in this file.** `grep -n "crawler"
  docs/DEVELOPMENT.md` returns nothing — the file carried no such claim, so there was
  nothing to correct here. The stale-claim work elsewhere is another task's.

## Self-gate

| Command                              | Result                                       |
| ------------------------------------ | -------------------------------------------- |
| `npx prettier --check docs/DEVELOPMENT.md` | pass — "All matched files use Prettier code style!" (run after the final edit) |
| `git diff docs/DEVELOPMENT.md`       | pass — diff confined to the two hunks quoted above |
| `git status --porcelain`             | pass — no code file modified by this task     |

No test, typecheck, or lint run applies: the change is prose in a Markdown doc. Prettier is
the formatting authority the lint gate enforces for it.

## Acceptance criteria

1. **Bundle verification appears in the enumerated CI gate list** — met. `· build + bundle
   verification`, in the compound style the list already uses for `lint + arch:check` and
   `typecheck + migration drift`; the compound is accurate because the verify steps run
   inside the build job.
2. **`pnpm verify:bundle` appears with the other standalone gate commands** — met. Appended
   to the `arch:check` / `lint:duplication` / `lint:unused` run, with the one usage
   constraint a caller needs (it wants an existing dist; other dist directories are args).
3. **One line records what the guard covers, exactly accurately** — met. Covers admin,
   sandbox, the merged web bundle before upload, the pre-merge Android dist, the three OTA
   bundles; asserts coverage is per-invocation; states that app-map presence is not
   coverage. Nothing implies `apps/crawler-view` is verified.
4. **Dense and durable** — met to the best of my judgement; the cut list above makes the
   density calls reviewable.

## Deviations

None from the acceptance criteria. Two judgement calls are recorded rather than deviated
silently: omitting the `build:e2e` invocation, and omitting iOS as a separate entry — both
with evidence and reasoning above.

## Concerns and limitations

- The clause "Presence in the guard's app map is a TTS declaration, not coverage" refers to
  `APPS_SHIPPING_TTS` without naming it. A concurrent task is editing
  `scripts/verify-bundle.ts`; per its stated criteria it keeps the map and the
  `apps/crawler-view` entry with no logic change, so the clause holds. If that task instead
  removes the map or the entry, the clause becomes vacuous rather than wrong — but it
  should then be revisited.
- The doc now says the web dist is verified by workflow steps. That is true of every
  shipping path today. It is a statement about where the calls live, so it rots only if
  someone moves verification into the web build — which is the change that should also
  update this line.

## Confidence

High — every asserted fact was read at its source this session (package scripts, vite
config, sandbox build script, three workflow files, the guard's CLI entry and app map), the
one omission that could be argued (`build:e2e`) is documented with the reasoning, and
prettier passes after the final edit.
