# impl-report-2 — H1: fix round for the `publicHoistPattern`-replaces-defaults finding

## Objective

Address the single validated finding from round 1: that declaring `publicHoistPattern`
replaces pnpm's default `['*eslint*', '*prettier*']` rather than extending it, and that the
fix is to restate the two defaults alongside `onnxruntime-common`.

## Outcome: the fix was NOT applied — its premise is false for this repo's pnpm

**No files were changed.** `pnpm-workspace.yaml` is byte-identical to the round-1 state.

The brief instructed me to verify the default values against the installed pnpm rather than
trust the rendering. I did. **pnpm 10.26.0's default `public-hoist-pattern` is `[]` — an
empty array.** The `['*eslint*', '*prettier*']` default was removed in pnpm 10 as a
deliberate breaking change. The finding's claim that declaring the key "replaces" a
non-empty default originates in my own round-1 report, where I stated it from stale
recollection of pre-v10 documentation without checking. That claim was wrong, and the
orchestrator's finding inherited it. I am correcting it here rather than shipping a change
built on it.

Applying the prescribed fix would therefore not restore a displaced default. It would
**add** hoisting behavior this repo has never had: every transitive-only eslint/prettier
package would be newly public-hoisted into the workspace root, reintroducing exactly the
phantom-dependency surface pnpm 10 removed on purpose. That is a strictly larger unintended
behavior change than the one the finding set out to prevent.

## Evidence — four independent confirmations

### 1. The installed pnpm's own defaults table

`/usr/lib/node_modules/pnpm/dist/pnpm.mjs` (pnpm 10.26.0, `readlink -f $(which pnpm)`),
in the defaults object at line 149013:

```
    "hoist-pattern": ["*"],
    ...
    "public-hoist-pattern": [],
```

The literal `*eslint*` does not occur anywhere in that dist as a hoist pattern — every
`eslint` hit in the file is unrelated (vendored fixture `package.json` bodies, CLI option
name lists). The only other assignments to `publicHoistPattern` in the binary are
`["*"]` when `shamefullyHoist: true`, and `[]`/`delete` otherwise (`applyDerivedConfig`,
line 310762). There is no merge with a built-in list.

### 2. Empirical — `pnpm config get` outside this workspace

```
$ cd <scratchpad>/pnpmdefault && pnpm config get public-hoist-pattern --json
(no output; exit=0)
```

Outside the workspace, with no `.npmrc` in play (`~/.npmrc` does not exist), the setting
resolves to nothing. Inside the workspace it returns `onnxruntime-common` — our declaration
is the only source of a value.

### 3. Empirical — nothing eslint/prettier-shaped was ever hoisted here

```
total root node_modules entries:        63
entries that are NOT direct root deps:  ["onnxruntime-common"]
eslint/prettier-shaped root entries:    19  (all 19 are direct root devDependencies)
```

If the two globs had ever been in effect, transitive-only plugins would be sitting at the
root. None are. This also re-confirms round 1's regression lens: our declaration displaced
nothing, because there was nothing to displace.

### 4. pnpm's published documentation

`https://pnpm.io/settings` — `publicHoistPattern`, "Default: **[]**", type `string[]`,
contrasted in the same entry with `hoistPattern` defaulting to `['*']`. The pnpm 10
discussion thread records the change from the former eslint/prettier default and states the
intended migration is to declare the packages as explicit `devDependencies` — which this
repo already does for all 19.

### Version pinning — the conclusion holds in CI too

- `package.json` → `"packageManager": "pnpm@10.26.0"`
- `.github/actions/setup/action.yml` and `.github/actions/setup-blacksmith/action.yml` →
  `pnpm/action-setup@v4` with `version: 10.26.0`

Local and CI run the same pnpm, so there is no environment in which the pre-v10 default
applies.

## A second, independent reason the prescribed edit is not free

pnpm records the pattern the modules directory was built with, in
`node_modules/.modules.yaml`:

```
3182:publicHoistPattern:
3183-  - onnxruntime-common
```

pnpm 10.26 still carries the `ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF` path ("…created using a
different public-hoist-pattern value. Run …"). Changing this key makes the next install —
including CI's `--frozen-lockfile` install — recreate the root `node_modules` rather than
no-op. Round 1's clean "Already up to date" install result would not carry over unexamined.

## Files changed

None.

## Tests added

None. This task's acceptance is verification-based (no test surface); the round-1 criteria
are unchanged and remain met.

## Self-gate — current-state re-verification

No edit was made, so the verification is that the round-1 verified state still stands and
has not drifted under concurrent work.

| # | command | result |
|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | **not run** — deliberately. No file changed, and a live `pnpm test:api` vitest run (pid 1091039, 24 workers) was in progress; an install under it is the hazard round 1 flagged. |
| 2 | `git diff pnpm-lock.yaml \| wc -l` | pass — `0` |
| 3 | `ls -l node_modules/onnxruntime-common` | pass — `-> .pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common` |
| 4 | resolution probe from `apps/marketing/node_modules/.vite/deps/` | pass — resolves to `…/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/…/dist/cjs/index.js` |
| 5 | root `node_modules` before/after delta | **zero delta** — 63 entries, `onnxruntime-common` the only non-direct-dep, identical to round 1's enumeration |
| 6 | `npx prettier --check pnpm-workspace.yaml` | pass — "All matched files use Prettier code style!" |

`git diff pnpm-workspace.yaml` output is reproduced verbatim below; it is exactly the
round-1 diff, unchanged:

```diff
@@ -23,5 +23,15 @@ overrides:
   vite: npm:rolldown-vite@7.3.1
   yaml: ^2.9.0

+# @huggingface/transformers imports `onnxruntime-common` as a bare specifier it never
+# declares, so the package is only reachable through pnpm's private hoist dir
+# (node_modules/.pnpm/node_modules). Vite's dep optimizer writes its output to
+# apps/<app>/node_modules/.vite/deps, which is outside that dir's resolution walk, so the
+# import is unresolvable from there and gets silently externalized into a cached prebundle.
+# Public-hoisting the package to the workspace root puts it back on that walk. Exactly this
+# one package: onnxruntime-web and onnxruntime-node carry native binaries and gain nothing.
+publicHoistPattern:
+  - onnxruntime-common
+
 patchedDependencies:
   astro@5.18.2: patches/astro@5.18.2.patch
```

## The finding, re-judged

The finding's *concern* — "declaring this key silently changes hoisting policy for tooling"
— is void on this pnpm: there is no policy to change, because the default is already empty.
The residual forward-looking effect I described in round 1 ("a future transitive-only
eslint/prettier package would no longer be auto-hoisted") is also wrong for the same
reason: such a package would not be auto-hoisted under pnpm 10 with or without our
declaration.

## Options for the orchestrator

1. **Ship round 1 unchanged** (my recommendation). The file is correct and minimal; the
   finding it was to fix does not exist on pnpm 10.26.0.
2. **Ship round 1 plus one comment line** recording the newly verified durable fact — that
   pnpm 10's default for this key is empty, so declaring it displaces nothing. This answers
   the exact question the finding got wrong, for the next reader. I did not add it
   unilaterally: it is a scope judgment past a brief I am declining, and the fact is
   verifiable from pnpm's own docs rather than being repo-specific. Proposed wording, for a
   ruling:

   ```
   # pnpm 10's default for this key is empty, so declaring it displaces no other hoisting.
   ```

3. **Apply the brief as written** — not recommended, and I will not do it without an
   explicit override. It newly hoists transitive eslint/prettier packages to the root and
   forces a root `node_modules` recreation on the next install, including CI's.

## Deviations

- **The instructed edit was not made.** Per the implementer rules, a fix whose diagnosed
  premise cannot be confirmed is a stop, not a judgment call. I verified the premise as
  instructed and it falsified.
- **Check 1 (`pnpm install --frozen-lockfile`) was not run.** With no file change it would
  verify nothing new, and a live 24-worker `apps/api` vitest run was executing. If the
  orchestrator rules for option 2 or 3, the install must be run then, against a quiet tree.

## Concerns and limitations

- My round-1 report contains the incorrect default-value claim in its "Regression lens"
  section. That file is not my write target and is left as-is; this report is the
  correction of record. An auditor reading report 1 alone would inherit the error.
- Everything else in round 1 is unaffected: the resolution fix, the exact-pin invariant, and
  the inlined-prebundle result all stand and were spot-re-verified above.

## Confidence

**High.** The premise was falsified four independent ways — the installed binary's defaults
table, an empirical `pnpm config get` outside the workspace, the observed contents of the
root `node_modules`, and pnpm's published documentation — and the pnpm version is pinned
identically for local and CI, so there is no environment where the old default applies.
