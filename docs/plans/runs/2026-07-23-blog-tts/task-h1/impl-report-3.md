# impl-report-3 — H1: ruling applied (option 2 — comment line + round-1 report correction)

## Objective

Two jobs, per the orchestrator's ruling that round 1's change ships unchanged:

1. Record in `pnpm-workspace.yaml`'s existing comment the durable fact that pnpm 10's
   default `public-hoist-pattern` is empty, so declaring the key displaces nothing.
2. Correct the false claim in `impl-report-1.md` that declaring the key replaces a
   `['*eslint*', '*prettier*']` default.

The `publicHoistPattern` list itself is untouched; no eslint/prettier globs were added.

## Files changed

- `pnpm-workspace.yaml` — one comment line added. No dependency-affecting change.
- `docs/plans/runs/2026-07-23-blog-tts/task-h1/impl-report-1.md` — the incorrect
  default-value claim in the "Regression lens" section corrected in place, with a marked
  correction note recording the verified fact and why the record was amended.

## 1. The exact `pnpm-workspace.yaml` diff

Against `HEAD` (round 1's change plus this round's single comment line):

```diff
diff --git a/pnpm-workspace.yaml b/pnpm-workspace.yaml
index b9d96320..c06d5a32 100644
--- a/pnpm-workspace.yaml
+++ b/pnpm-workspace.yaml
@@ -23,5 +23,16 @@ overrides:
   vite: npm:rolldown-vite@7.3.1
   yaml: ^2.9.0

+# @huggingface/transformers imports `onnxruntime-common` as a bare specifier it never
+# declares, so the package is only reachable through pnpm's private hoist dir
+# (node_modules/.pnpm/node_modules). Vite's dep optimizer writes its output to
+# apps/<app>/node_modules/.vite/deps, which is outside that dir's resolution walk, so the
+# import is unresolvable from there and gets silently externalized into a cached prebundle.
+# Public-hoisting the package to the workspace root puts it back on that walk. Exactly this
+# one package: onnxruntime-web and onnxruntime-node carry native binaries and gain nothing.
+# pnpm 10's default for this key is empty, so declaring it displaces no other hoisting.
+publicHoistPattern:
+  - onnxruntime-common
+
 patchedDependencies:
   astro@5.18.2: patches/astro@5.18.2.patch
```

**This round's delta in isolation** — the round-1 file was copied to the scratchpad before
editing; `diff -u` between that copy and the current file is exactly one added line:

```diff
@@ -30,6 +30,7 @@
 # import is unresolvable from there and gets silently externalized into a cached prebundle.
 # Public-hoisting the package to the workspace root puts it back on that walk. Exactly this
 # one package: onnxruntime-web and onnxruntime-node carry native binaries and gain nothing.
+# pnpm 10's default for this key is empty, so declaring it displaces no other hoisting.
 publicHoistPattern:
   - onnxruntime-common

```

The added line states the fact only: no narration, no plan/task identifiers, no citation of
anything under `docs/plans/runs/`.

## 2. Proof the pattern list is byte-identical to round 1

The `publicHoistPattern:` key line plus its list items were extracted and hashed before the
edit (from the scratchpad copy of the round-1 file) and after the edit (from the live file):

| | extracted block | sha256 |
|---|---|---|
| before (round-1 state) | `"publicHoistPattern:\n  - onnxruntime-common"` | `3a745dbbc59998feb4aafc0d9e58c95ca804096cb81ff09eb6ca035260434d38` |
| after (this round) | `"publicHoistPattern:\n  - onnxruntime-common"` | `3a745dbbc59998feb4aafc0d9e58c95ca804096cb81ff09eb6ca035260434d38` |

Identical digests. Corroborated independently by the `diff -u` above, whose only hunk is a
comment-line insertion with `publicHoistPattern:` and `  - onnxruntime-common` appearing as
unchanged context lines. One entry, still exactly `onnxruntime-common`; no `*eslint*` or
`*prettier*` glob exists anywhere in the file.

`git diff --stat -- pnpm-lock.yaml` → 0 lines. Nothing dependency-affecting changed.

## 3. The corrected sentence in report 1 — before / after

**Before** (the false claim, origin of the finding):

> `onnxruntime-common` is the only one. This also settles a risk the brief did not name:
> pnpm's **default** `public-hoist-pattern` is `['*eslint*', '*prettier*']`, and declaring
> the key replaces that default (`pnpm config get public-hoist-pattern` now returns
> `onnxruntime-common`). In this repo the replacement displaces nothing — every
> eslint/prettier package at the root is an explicit root `devDependency` and is linked
> there regardless of hoisting. The residual effect is forward-looking only: a future
> *transitive-only* eslint/prettier package would no longer be auto-hoisted to the root.

**After**:

> `onnxruntime-common` is the only one. This also settles a risk the brief did not name:
> pnpm 10's **default** `public-hoist-pattern` is `[]`, so declaring the key displaces
> nothing — there is no built-in list to replace (`pnpm config get public-hoist-pattern`
> now returns `onnxruntime-common`, our declaration being the only source of a value).
> Every eslint/prettier package at the root is an explicit root `devDependency` and is
> linked there regardless of hoisting.
>
> > **Correction (round 3).** This paragraph originally asserted that the default is
> > `['*eslint*', '*prettier*']` and that declaring the key replaces it, with a residual
> > forward-looking effect that a future *transitive-only* eslint/prettier package would no
> > longer be auto-hoisted. Both claims are false for the pnpm this repo pins (10.26.0,
> > `packageManager` + both CI setup actions): `['*eslint*', '*prettier*']` was the pre-v10
> > default and was removed in pnpm 10. Verified against the installed `pnpm.mjs` defaults
> > table (`"public-hoist-pattern": []`) and pnpm's published settings docs
> > (`https://pnpm.io/settings`, `publicHoistPattern` — Default: `[]`). Such a package
> > would not be auto-hoisted under pnpm 10 with or without our declaration. The original
> > claim was stated from stale recollection without checking; it is corrected here because
> > a reader of this report alone would otherwise inherit the error. The rest of the
> > section stands.

Scope of the amendment: the false technical fact only. The narrative, the raise, the
regression-lens conclusion (`onnxruntime-common` is the sole non-direct-dep root entry), and
every other section of report 1 are untouched.

## Self-gate

| command | result |
|---|---|
| `npx prettier --check pnpm-workspace.yaml` | pass — "All matched files use Prettier code style!", exit 0 |
| pattern-block sha256, before vs after | pass — identical (`3a745dbb…34d38`) |
| `diff -u <round-1 copy> pnpm-workspace.yaml` | pass — exactly one added comment line |
| `git diff --stat -- pnpm-lock.yaml \| wc -l` | pass — `0` |
| `pnpm install --frozen-lockfile` | **not run** — see below |

**Which install choice I made: I did not run any install.** Nothing dependency-affecting
changed (a YAML comment cannot alter resolution, and `publicHoistPattern`'s value is
byte-identical, so `node_modules/.modules.yaml` still matches and no
`ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF` recreation is possible). The optional reassurance run
was also unavailable: a vitest run is still live in this tree — `pid 1103350`,
`apps/api … vitest run --coverage --maxWorkers=24`, a *different* pid from the round-2
observation (1091039), so this is a fresh run, not a stale one. Running an install under it
remains the hazard round 1 flagged.

## Acceptance criteria

1. **Durable fact added to the `pnpm-workspace.yaml` comment; fact only, no narration, no
   plan/task identifiers, no `docs/plans/runs/` citation** — MET. Diff in §1.
2. **`publicHoistPattern` list unchanged; no eslint/prettier globs added** — MET. Byte-level
   proof in §2.
3. **False claim in `impl-report-1.md` corrected in place; narrative and raise preserved** —
   MET. Before/after in §3.
4. **Prettier check passes** — MET.

## Deviations

None. Both jobs applied as ruled, within the stated bounds (`pnpm-workspace.yaml` and
`impl-report-1.md` only).

## Concerns and limitations

- Amending a run record is against the run's normal rule; done here only under the
  orchestrator's explicit exception for a verified-false technical claim, and marked in the
  file as a correction rather than silently rewritten, so the audit trail survives.
- Report 2 already carries the same correction with its four independent confirmations; the
  two records now agree.
- The pnpm-10-default fact is version-scoped. It is true for the pinned 10.26.0 (local and
  both CI setup actions); a future pnpm major could change the default again, at which point
  the comment line is the thing to re-verify.

## Confidence

**High.** Both edits are textual, and every claim here comes from a command executed against
this tree this round: the prettier check, the two matching block digests, the isolated
one-line `diff -u`, the zero-line lockfile diff, and the live-vitest pid from `ps`/`pgrep`.
