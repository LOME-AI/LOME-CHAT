# impl-report-1 — H1: public-hoist the phantom `onnxruntime-common`

## Objective

Add `publicHoistPattern: ['onnxruntime-common']` to `pnpm-workspace.yaml` so the phantom
dependency is resolvable from the app root, removing the *sticky-forever* property of a
poisoned Vite dep cache.

## Files changed

- `pnpm-workspace.yaml` — adds `publicHoistPattern: ['onnxruntime-common']` plus a comment
  recording the durable mechanism (undeclared bare specifier; dep-optimizer output dir is
  outside the private hoist dir's resolution walk).

No other repo content changed. `node_modules` relinking and `apps/*/dist` rebuild artifacts
are not repo content.

## Exact diff

```diff
diff --git a/pnpm-workspace.yaml b/pnpm-workspace.yaml
index b9d96320..76b4b970 100644
--- a/pnpm-workspace.yaml
+++ b/pnpm-workspace.yaml
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

`npx prettier --check pnpm-workspace.yaml` → `All matched files use Prettier code style!`

## Verification, in the prescribed order

### Step 1 — pre-existing lockfile drift

```
$ git status --short pnpm-lock.yaml
(no output)
$ git diff --stat pnpm-lock.yaml
(no output)
```

**There is no pre-existing foreign drift on `pnpm-lock.yaml`** — the brief anticipated some;
the observed baseline is a clean lockfile. That makes the after-comparison strictly simpler:
any lockfile change at all would be attributable to this task.

Guard check that `--frozen-lockfile` was a fair test: the only modified `package.json` in the
tree is `packages/shared/package.json`, and its diff is an `exports` entry only — zero
dependency-line changes across every workspace manifest.

```
$ git diff -U0 -- '**/package.json' 'package.json' | grep -E '^[+-]' | grep -vE '^[+-]{3}' | grep -viE 'exports|"\./'
(no output)
```

### Step 2 — before-state of the hoist link

```
$ readlink node_modules/.pnpm/node_modules/onnxruntime-common
../onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common
$ ls node_modules/ | grep -c onnx
0
$ ls -d node_modules/onnxruntime*
zsh: no matches found: node_modules/onnxruntime*
```

### Step 3 — resolution probe BEFORE (verbatim)

```
$ node -e "createRequire('<repo>/apps/marketing/node_modules/.vite/deps/probe.js').resolve(...)"
onnxruntime-common => ERR MODULE_NOT_FOUND Cannot find module 'onnxruntime-common'
seedrandom => <repo>/node_modules/.pnpm/seedrandom@3.0.5/node_modules/seedrandom/index.js
tsx => <repo>/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs
@huggingface/transformers => ERR MODULE_NOT_FOUND Cannot find module '@huggingface/transformers'
```

`seedrandom`/`tsx` resolving from the same basedir reproduces the research doc's control:
the root `node_modules` *is* on that walk; only `onnxruntime-common` was absent from it.

### Step 4 — `pnpm install --frozen-lockfile`

```
Scope: all 17 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date
. postinstall$ tsx scripts/ensure-gitleaks.ts
. postinstall: gitleaks ready: <repo>/.cache/gitleaks/8.24.3/gitleaks
. prepare$ husky
Done in 8.4s using pnpm v10.26.0
```

Clean run, no lockfile write, resolution step skipped — direct evidence that
`publicHoistPattern` is not a lockfile-invalidating setting and CI's `--frozen-lockfile`
stays valid.

### Step 5 — lockfile diff AFTER: zero new lines

```
$ git status --short pnpm-lock.yaml
(no output)
$ git diff pnpm-lock.yaml | wc -l
0
```

PASS. Not proceeding was not required.

### Step 6 — the symlink

```
$ ls -l node_modules/onnxruntime-common
lrwxrwxrwx 1 dev dev 87 Jul 25 23:42 node_modules/onnxruntime-common
  -> .pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common
$ node -p "require('./node_modules/onnxruntime-common/package.json').version"
1.22.0-dev.20250409-89f8206ba4
```

**Deviation from the predicted outcome (benign, see Deviations):** the private link is NOT
gone.

```
$ ls -l node_modules/.pnpm/node_modules/onnxruntime-common
lrwxrwxrwx 1 dev dev 84 Jul 25 01:04 -> ../onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common
$ realpath node_modules/onnxruntime-common
<repo>/node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common
$ realpath node_modules/.pnpm/node_modules/onnxruntime-common
<repo>/node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common
```

Both links resolve to the **same realpath**, so there is exactly one physical package and no
possibility of two ORT copies. The private link is a stale leftover: pnpm reported "Already
up to date" and did not run a pruning relink pass over the private hoist dir.

### Step 7 — resolution probe AFTER (verbatim)

```
marketing onnxruntime-common => <repo>/node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common/dist/cjs/index.js
web       onnxruntime-common => <repo>/node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common/dist/cjs/index.js
```

RESOLVES, at the exact pinned version, from both apps' `.vite/deps` basedir. Criterion met.

### Step 8 — THE STOP CONDITION: inlined vs split. **INLINED. No split. PASS.**

Procedure: `rm -rf apps/*/node_modules/.vite/deps`, then for each app start a dev server on a
private port and fetch the real TTS worker module so Vite's import-analysis discovers
`kokoro-js` and optimizes it.

- marketing: `astro dev --port 4711` → `GET /blog/what-is-opaque-authentication/` = 200;
  `GET /@fs/<repo>/packages/ui/src/components/accessibility/lib/tts.worker.ts?worker_file&type=module`
  = 200, and its transformed source rewrites the kokoro import to
  `from "/node_modules/.vite/deps/kokoro-js.js?v=1e277a97"`.
- web: `tsx scripts/with-env.ts vite --port 4713` → same worker fetch = 200.
  (Bare `vite` fails with `HB_VITE_PORT is not set`; `with-env` supplies it.)

Emitted prebundles:

```
apps/marketing/node_modules/.vite/deps/kokoro-js.js  4218286  sha256 662e231a994c42a20635c05d5ac516ac752b3ace3ee3472c0a022a04bf5365ca
apps/web/node_modules/.vite/deps/kokoro-js.js        4218286  sha256 662e231a994c42a20635c05d5ac516ac752b3ace3ee3472c0a022a04bf5365ca
```

Byte-identical across both apps. **No `kokoro-js___onnxruntime-common.js` chunk exists in
either deps dir** (`ls | grep -i onnx` → nothing).

Every import/export-from statement in the emitted file, enumerated programmatically:

```
--- live import/export-from statements ---
   ./chunk-XkmBru0b.js
```

That is the whole list. One relative import of the 1,847-byte interop-helper chunk (which
itself has zero imports). **Zero bare specifiers, zero externalized modules.**

All 41 occurrences of the string `onnxruntime-common` are rolldown `//#region` source-path
comments for **inlined** ORT ESM modules:

```
1x  …u0b.js";\n\n//#region ../../node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-8…
13x …endregion\n//#region ../../node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-8…
1x  …/onnxruntime-common/dist/esm/tensor-impl.js\n…
1x  …/onnxruntime-common/dist/esm/tensor.js\n…
1x  …/onnxruntime-common/dist/esm/env.js\n…
1x  …/onnxruntime-common/dist/esm/version.js\n…      (plus backend-impl, env-impl,
                                                      tensor-conversion, tensor-factory,
                                                      tensor-impl-type-mapping, tensor-utils)
```

and the pinned version string `1.22.0-dev.20250409-89f8206ba4` appears 18 times inside the
bundle. ORT is compiled in, one copy, `instanceof Tensor` boundary intact.

**Attribution of the 132-byte delta vs the research doc's 4,218,418 figure.** The emitted
prebundle is 4,218,286 B, not 4,218,418 B. This is NOT caused by the change. Counterfactual,
run directly: I moved `node_modules/onnxruntime-common` aside (restoring pre-change
reachability exactly), cleared `apps/marketing/node_modules/.vite/deps`, re-optimized through
a fresh `astro dev --port 4712`, and compared:

```
662e231a994c42a20635c05d5ac516ac752b3ace3ee3472c0a022a04bf5365ca  <baseline, link removed>
662e231a994c42a20635c05d5ac516ac752b3ace3ee3472c0a022a04bf5365ca  <after, link present>
```

**Byte-identical.** The change is a provable no-op on prebundle content; the 132-byte
difference from the research figure is tree drift from tasks that landed since it was
written. The link was then restored and the probe re-run (resolves).

All three dev servers (4711, 4712, 4713) were stopped; all three ports return connection
refused.

### Step 9 — prod build + verifier

`pnpm build:web` (i.e. `scripts/build-web-bundle.ts --target=prod`) built both apps, merged
marketing into `apps/web/dist`, then failed at the wired-in verifier — the expected,
pre-existing failure.

`dist/ort/` sha256, before and after the rebuild (files re-emitted at 23:47, hashes
unchanged):

```
08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9  apps/web/dist/ort/ort-wasm-simd-threaded.jsep.mjs
c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39  apps/web/dist/ort/ort-wasm-simd-threaded.jsep.wasm
08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9  apps/marketing/dist/ort/ort-wasm-simd-threaded.jsep.mjs
c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39  apps/marketing/dist/ort/ort-wasm-simd-threaded.jsep.wasm
```

Both match the expected constants exactly.

`collectWebBundleViolations` run against both dists:

```
=== apps/web/dist : 2 violation(s) ===
  - built TTS worker reads `df.prototype` off the bundler's import.meta stand-in:
    _astro/tts.worker-Cnlg9VbG.js — the iife worker transform rewrote `new.target` as
    `import.meta`, so every worker throws "Object prototype may only be an Object or null:
    undefined" on load
  - built TTS worker reads `df.prototype` off the bundler's import.meta stand-in:
    assets/tts.worker-C2pJhHz0.js — (same cause)
=== apps/marketing/dist : 1 violation(s) ===
  - built TTS worker reads `df.prototype` off the bundler's import.meta stand-in:
    _astro/tts.worker-Cnlg9VbG.js — (same cause)
```

Exactly the counts and the single class the brief predicted (2 / 1, worker-`new.target`
rewrite only). **No new violation class**: no `/ort/` hash change, no stray runtime copy, no
ORT version-site violation, no Pages-limit breach.

Shipped ORT version, verified explicitly rather than inferred from the check's silence:

```
$ node -p "require('./packages/ui/package.json').dependencies['onnxruntime-common']"
1.22.0-dev.20250409-89f8206ba4
$ grep -oE '1\.22\.0-dev\.20250409-89f8206ba4|1\.21\.0' apps/web/dist/_astro/tts.worker-Cnlg9VbG.js | sort | uniq -c
      3 1.22.0-dev.20250409-89f8206ba4
$ grep -oE '1\.22\.0-dev\.20250409-89f8206ba4|1\.21\.0' apps/web/dist/assets/tts.worker-C2pJhHz0.js | sort | uniq -c
      3 1.22.0-dev.20250409-89f8206ba4
```

Zero occurrences of `1.21.0`. `checkOrtCommonVersion` passed non-vacuously (it emits a
violation when it finds zero `versions.common` sites; it emitted none). The exact pin held —
hoist order did not change which ORT copy ships, as the pnpm-source analysis predicted.

## Acceptance criteria

1. **`publicHoistPattern: ['onnxruntime-common']` beside `overrides:`, exactly one package,
   with a durable-fact comment, no plan/task identifiers, no `docs/plans/runs/` citation** —
   MET. See diff above. Pattern is the single literal `onnxruntime-common`; `onnxruntime-web`
   and `onnxruntime-node` are deliberately excluded and the comment says why.
2. **`pnpm install --frozen-lockfile` (safe form)** — MET. Clean run, resolution step skipped.
3. **`git diff pnpm-lock.yaml` shows zero new lines** — MET. Zero lines total; the baseline
   had no drift either.
4. **`node_modules/onnxruntime-common` exists as a symlink to the pinned `.pnpm` dir** — MET.
   Sub-clause "`.pnpm/node_modules/onnxruntime-common` gone" — NOT observed; see Deviations.
   Benign: identical realpath, single physical copy.
5. **Resolution probe from `apps/marketing/node_modules/.vite/deps/` now resolves (was
   `MODULE_NOT_FOUND`)** — MET, before and after recorded verbatim above; also verified for
   `apps/web`.
6. **Prebundle still inlines ORT, does not split into a second chunk** — MET, and stronger
   than required: byte-identical (sha256) to the pre-change baseline measured by
   counterfactual, on both apps, with a programmatic enumeration showing the only import is
   the local interop chunk.
7. **Prod build + `verify:web-bundle`: `dist/ort/*` sha256 unchanged, shipped ORT version
   still `1.22.0-dev.20250409-89f8206ba4`, only the pre-existing worker-rewrite violations** —
   MET.

## Self-gate

| command | result |
|---|---|
| `pnpm install --frozen-lockfile` | pass — lockfile untouched, resolution skipped |
| `git diff pnpm-lock.yaml \| wc -l` | pass — 0 |
| resolution probe (marketing + web) | pass — resolves at the pinned version |
| dev re-optimize, both apps | pass — ORT inlined, sha256 identical to baseline |
| `pnpm build:web` (prod, both apps + merge) | fails **only** on the pre-existing W-series worker-`new.target` defect; ORT hashes unchanged |
| `collectWebBundleViolations` on both dists | pass for every check except the pre-existing worker-rewrite class (2 web / 1 marketing) |
| `npx prettier --check pnpm-workspace.yaml` | pass |

### Regression lens: did any other package's resolution move?

Enumerated every entry in the root `node_modules` and cross-checked against the root
manifest's direct dependencies:

```
root node_modules entries that are NOT direct root deps:
onnxruntime-common
```

`onnxruntime-common` is the only one. This also settles a risk the brief did not name: pnpm
10's **default** `public-hoist-pattern` is `[]`, so declaring the key displaces nothing —
there is no built-in list to replace (`pnpm config get public-hoist-pattern` now returns
`onnxruntime-common`, our declaration being the only source of a value). Every
eslint/prettier package at the root is an explicit root `devDependency` and is linked there
regardless of hoisting.

> **Correction (round 3).** This paragraph originally asserted that the default is
> `['*eslint*', '*prettier*']` and that declaring the key replaces it, with a residual
> forward-looking effect that a future *transitive-only* eslint/prettier package would no
> longer be auto-hoisted. Both claims are false for the pnpm this repo pins (10.26.0,
> `packageManager` + both CI setup actions): `['*eslint*', '*prettier*']` was the pre-v10
> default and was removed in pnpm 10. Verified against the installed `pnpm.mjs` defaults
> table (`"public-hoist-pattern": []`) and pnpm's published settings docs
> (`https://pnpm.io/settings`, `publicHoistPattern` — Default: `[]`). Such a package would
> not be auto-hoisted under pnpm 10 with or without our declaration. The original claim was
> stated from stale recollection without checking; it is corrected here because a reader of
> this report alone would otherwise inherit the error. The rest of the section stands.

## Deviations

- **`.pnpm/node_modules/onnxruntime-common` still exists** (predicted: moved away). pnpm
  reported "Already up to date" and did not prune the private hoist dir. Both links share one
  realpath and one version, so there is a single physical package and no `instanceof Tensor`
  hazard. A from-scratch install would likely produce the predicted moved state; that was not
  tested because wiping `node_modules` is disproportionate and risks concurrent work.
- **Counterfactual baseline measured by temporarily moving the root symlink aside** rather
  than by reverting and reinstalling. This was the only way to attribute the 132-byte delta
  from the research figure without a second full install. The symlink was restored
  byte-identically and re-probed.
- **`pnpm build:web` exits non-zero.** Expected per the brief's correction; the failure is the
  W-series `new.target` worker defect being fixed separately, not this change.

## Concerns and limitations

- The change removes the *sticky* property, as designed; it does not close the poisoning
  window itself (an install that runs while a dev server is up can still re-poison). That
  framing is unchanged from the research doc.
- `apps/admin` is covered automatically — the hoist is workspace-wide, so if admin ever
  optimizes kokoro it resolves from the same root entry. No admin-specific action needed.
- Everything about the shipped bundle was verified against a dev-mode-sibling prod build, the
  same artifact CI's verifier covers today (the known GAP-5 divergence). Nothing in this task
  changes that.

## Confidence

**High.** Every claim is from an executed command on this tree. The load-bearing risk — a
split ORT chunk — was ruled out three independent ways: no ORT chunk file exists, the only
import statement in the prebundle is the local interop chunk, and the output is sha256
byte-identical to the pre-change baseline. The exact-pin invariant is confirmed directly in
the built worker chunks (3 sites at the pinned version, zero at 1.21.0), not merely by the
verifier's silence.
