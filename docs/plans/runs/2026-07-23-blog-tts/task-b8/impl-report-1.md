# B8 — Replace the accidental `onnxruntime-web` pin with an exact-pinned `onnxruntime-common`

## Objective

Drop `packages/ui`'s accidental `onnxruntime-web: ^1.26.0` and declare `onnxruntime-common`
directly, exact-pinned to the version `@huggingface/transformers` actually depends on, so the
`Tensor` class the shipped TTS worker uses stops being chosen by an unstable caret range on a
package nothing imports.

Outcome: **done, and the two ORT copies in the shipped worker converged to one version.**

## Where the required version was read (verified, two independent sources)

1. `node_modules/.pnpm/@huggingface+transformers@3.8.1/node_modules/@huggingface/transformers/package.json`
   → `"dependencies": { "onnxruntime-node": "1.21.0", "onnxruntime-web": "1.22.0-dev.20250409-89f8206ba4", … }`
   — transformers pins onnxruntime-web **exactly** (no range).
2. `node_modules/.pnpm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-web/package.json`
   → `"dependencies": { …, "onnxruntime-common": "1.22.0-dev.20250409-89f8206ba4", … }`
   — that onnxruntime-web pins onnxruntime-common **exactly**, to the same string.

Required version: **`1.22.0-dev.20250409-89f8206ba4`**, unambiguous (both pins are exact,
not ranges). B7's string is confirmed independently, not taken on trust.

Corroborating: the same string is already inlined as a literal in ORT's own `ort.min.mjs`
inside the built worker chunk (see census below) — it is the version of the runtime that
consumes the externalized `Tensor`.

## Files changed

| path | why |
|---|---|
| `packages/ui/package.json` | `onnxruntime-web: ^1.26.0` → `onnxruntime-common: 1.22.0-dev.20250409-89f8206ba4` (exact, no `^`/`~`). |
| `knip.jsonc` | `packages/ui` `ignoreDependencies` retargeted to `onnxruntime-common`; comment rewritten to state the real mechanism and why the pin is exact. |
| `pnpm-lock.yaml` | onnxruntime-only: importer entry swapped, `onnxruntime-web@1.26.0` and `onnxruntime-common@1.26.0` dropped from `packages`/`snapshots`. |

No source file touched. No `packages/ui/src/**` file touched (B4/B5 own those concurrently).

### `packages/ui/package.json` (my hunk only)

```diff
-    "onnxruntime-web": "^1.26.0",
+    "onnxruntime-common": "1.22.0-dev.20250409-89f8206ba4",
```

(The export-map additions visible in `git diff` for this file are B2/B5's, pre-existing in the
working tree.)

### `knip.jsonc` (my hunk only)

```diff
     "packages/ui": {
       "project": ["src/**/*.{ts,tsx}"],
-      "ignoreDependencies": ["onnxruntime-web"],
+      // No source file imports onnxruntime-common; it is declared to pin the
+      // copy the bundlers resolve. @huggingface/transformers' browser build
+      // (reached via kokoro-js in the TTS worker) externalizes a bare
+      // `onnxruntime-common` import and re-exports its `Tensor` class — the one
+      // the engine passes into inference — but transformers' own dependency set
+      // does not contain that package, so resolution falls through to whichever
+      // copy pnpm hoists, and this declaration is what decides it. The version
+      // is exact-pinned (no range) to the one transformers' own
+      // onnxruntime-web dependency pins, so the externalized `Tensor` matches
+      // the `Tensor` inlined in the onnxruntime runtime that consumes it; a
+      // range would silently drift the shipped worker on any install.
+      // Unrelated to the self-hosted /ort/ runtime assets, which
+      // `ort-assets-plugin.ts` reads out of transformers' own dist.
+      "ignoreDependencies": ["onnxruntime-common"],
     },
```

The B7 comment was adapted, not deleted: the mechanism paragraph and the `/ort/` disclaimer
are kept; the "declaring onnxruntime-web makes that copy a current one" claim is replaced by
the real reason the pin is exact.

### `pnpm-lock.yaml` — complete diff vs. its pre-task state (onnxruntime-only)

```diff
@@ importers → packages/ui
-      onnxruntime-web:
-        specifier: ^1.26.0
-        version: 1.26.0
+      onnxruntime-common:
+        specifier: 1.22.0-dev.20250409-89f8206ba4
+        version: 1.22.0-dev.20250409-89f8206ba4
@@ packages
-  onnxruntime-common@1.26.0:
-    resolution: {integrity: sha512-qVyMR4lcWgbkc4getFV+GQijsTnbg/siteoqcDwa3sI/LxbrMSNw4ePyvCq/ymdQaRomCA7YuWmhzsswxvymdw==}
-  onnxruntime-web@1.26.0:
-    resolution: {integrity: sha512-LbRr/8zZt2xilI2smrVQGGKINo0U46i8qJp+UXyMBGfqN7KjnH1BiwCwLwyNIVV4i9CKFv7Sf4PwLKWnT8/bEA==}
@@ snapshots
-  onnxruntime-common@1.26.0: {}
-  onnxruntime-web@1.26.0:
-    dependencies:
-      flatbuffers: 25.9.23
-      guid-typescript: 1.0.9
-      long: 5.3.2
-      onnxruntime-common: 1.26.0
-      platform: 1.3.6
-      protobufjs: 7.6.4
```

`diff <pre-task lock> <final lock>` output contains **nothing else**. Zero non-onnxruntime
lines changed.

**Override integrity — confirmed untouched.** Final lock header:

```yaml
lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
overrides:
  sharp: ^0.34.5
  vite: npm:rolldown-vite@7.3.1     ← present, unchanged
  shell-quote: ^1.8.4
  kysely: ^0.28.17
  qs: ^6.15.2
  yaml: ^2.9.0
  minimatch@<3.1.4: ^3.1.5
patchedDependencies:
  astro@5.18.2: { hash: e0dfee…, path: patches/astro@5.18.2.patch }
```

The `apps/sandbox` importer block and the 24 `vite@8.1.5` peer references belonging to the
untracked sandbox workstream are still present, byte-identical. Not cleaned up (see
Deviations for how that was preserved).

## Tests added

None — and none are possible. The change contains no source code and no new behavior; the
only observable it moves is which bytes the bundler emits. The proof obligations are the
build-output census and the existing TTS suites (both below), which is the same shape B7 used.

## Self-gate

| command | result |
|---|---|
| `pnpm build:web` (prod target, BEFORE) | build + merge + `verifyWebBundle` pass; stops at `generate-headers.ts` with `VITE_API_URL must be set (got undefined)` — prod-env precondition unavailable locally, identical before and after (matches B7) |
| `npx turbo build --filter=@hushbox/web --filter=@hushbox/marketing --force` then `pnpm build:web` (AFTER) | 2/2 tasks successful, 0 cached; merge + `verifyWebBundle` pass; same `generate-headers` stop |
| `pnpm exec vitest run --coverage` (full `packages/ui` suite, from `packages/ui`) | 1874 tests, 1867 passed / 7 failed — all 7 in `blog-read-aloud.test.tsx`, a race with B5 editing that component *during* the run (see Deviations); re-run of that file alone: **42/42 pass** |
| `pnpm exec vitest run tts-engine.test.ts tts.worker.test.ts document-reader.test.ts sections.test.tsx` (packages/ui) | pass — 4 files, 185 tests |
| `pnpm exec vitest run src/lib/{prewarm-tts,chat-tts-stream,tts-dom-observer}.test.ts` (apps/web) | pass — 3 files, 41 tests |
| `npx turbo typecheck --filter=@hushbox/ui --filter=@hushbox/web --filter=@hushbox/marketing --force` | pass — 3 successful, 3 total, 0 errors |
| `npx turbo lint --filter=@hushbox/ui --filter=@hushbox/web --filter=@hushbox/marketing` | pass — 3 successful, 3 total |
| `pnpm lint:unused` (knip) | **clean for my entries** — no `Remove from ignoreDependencies` hint for `onnxruntime-common`, i.e. the ignore is still genuinely required. Exits 1 on the two ambient reds only (below) |
| `pnpm exec prettier --check knip.jsonc packages/ui/package.json` | pass |
| `pnpm install --frozen-lockfile` (final) | `Lockfile is up to date, resolution step is skipped` — the hand-applied lock edit is exactly what pnpm itself would produce |

Ambient knip reds, attributed out per brief (not mine, not fixed):

```
Unused files (1)
packages/config/vitest.package.config.ts
Configuration hints (1)
wrangler  apps/sandbox  knip.jsonc  Remove from ignoreDependencies
```

ESLint does not lint `.json`/`.jsonc` in this repo (no jsonc processor in
`packages/config/eslint.config.js`; `eslint knip.jsonc` from the root exits 2 with "couldn't
find eslint.config" because the root is not an ESLint package). Prettier is the applicable
formatting gate for both owned files and it passes.

## Acceptance criteria

**(1) `onnxruntime-web` dropped, `onnxruntime-common` declared exact — MET.**
`packages/ui/package.json` now carries `"onnxruntime-common": "1.22.0-dev.20250409-89f8206ba4"`.
No range operator. Version verified from two exact upstream pins (above).

**(2) knip ignore retargeted with a comment stating the real mechanism — MET.**
`onnxruntime-web` ignore removed; `onnxruntime-common` ignore added with the mechanism
(externalized bare import + `Tensor` re-export + hoist-dir resolution) and the reason the pin
is exact. Verified still required: knip reports no removal hint for it.

**(3) `pnpm lint:unused` clean for these entries — MET.** See self-gate.

**(4) `dist/ort/` sha256 UNCHANGED — MET.** Identical before and after, and identical to the
brief's expected values:

```
BEFORE and AFTER (byte-identical):
c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39  dist/ort/ort-wasm-simd-threaded.jsep.wasm
08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9  dist/ort/ort-wasm-simd-threaded.jsep.mjs
```

Both match the brief's STOP-condition hashes exactly. `verifyWebBundle` (B6) passed on the
merged dist in both builds.

**(5) Embedded ORT version reported BEFORE and AFTER, matching the exact pin — MET, and the
two copies converged.**

`versions:{common:…}` census in the built web TTS worker chunk:

| | site A (external `onnxruntime-common` module) | site B (inlined in ORT's `ort.min.mjs`) | distinct versions |
|---|---|---|---|
| BEFORE (`dist/assets/tts.worker-D064fVjB.js`, sha256 `e631687b…5bcc875`) | `versions:{common:\`1.26.0\`}` | `versions:{common:be}` where `be=\`1.22.0-dev.20250409-89f8206ba4\`` | **2** |
| AFTER (`dist/assets/tts.worker-D-wlGi7z.js`, sha256 `abc7bddb…4af5bcc`) | `versions:{common:\`1.22.0-dev.20250409-89f8206ba4\`}` | `versions:{common:ve}` where `ve=\`1.22.0-dev.20250409-89f8206ba4\`` | **1** |

All ORT version literals in the chunk:

```
BEFORE:  2 × 1.22.0-dev.20250409-89f8206ba4   +   1 × 1.26.0
AFTER:   3 × 1.22.0-dev.20250409-89f8206ba4   (zero 1.26.0; `grep -l 1.26.0 dist/assets/*.js` → no hits anywhere in the web dist)
```

The marketing-merged worker chunk (`dist/_astro/tts.worker-D6dVk0ay.js`) shows the same
converged result: both `versions:{common:…}` sites report `1.22.0-dev.20250409-89f8206ba4`,
and 3/3 version literals are that string.

**Verdict on convergence — they converged on version, not on module count.** Both
`versions:{common:}` sites still exist (2 sites before, 2 after), and the two `Tensor`
implementations still exist (`"Tensor constructor: unsupported"` ×2 and `"Tensor's size("` ×2,
unchanged before and after). What changed is that the two copies are now *the same version* —
before, transformers' externalized `Tensor` was ORT 1.26.0 while the runtime consuming it was
1.22.0-dev; now both are 1.22.0-dev. Structural deduplication was never achievable here
without patching ORT's own pre-bundled `ort.min.mjs`, which inlines its copy of
onnxruntime-common at publish time and is out of the repo's reach. The mismatch that mattered
— an ORT runtime being handed a `Tensor` built by a different ORT version — is gone.

**(6) Every TTS test green and UNMODIFIED — MET.** `tts-engine`, `tts.worker`,
`document-reader`, `blog-read-aloud`, accessibility `sections`, and the three `apps/web`
chat-TTS files all pass. `git status` confirms I modified no `.ts`/`.tsx` file anywhere; the
modifications visible under `packages/ui/src/components/accessibility` and
`.../blog-reader` are B1–B5's pre-existing working-tree state.

**(7) `turbo typecheck --filter=@hushbox/ui --filter=@hushbox/web --filter=@hushbox/marketing`
clean — MET.** 3 successful, 0 errors (run with `--force`, no cache).

**(8) Lockfile discipline — MET.** Diff vs. pre-task state is onnxruntime-only (full diff
reproduced above). Overrides header and `vite: npm:rolldown-vite@7.3.1` untouched; sandbox
workstream drift preserved verbatim.

## Deviations and reasons

**D1 — the lockfile edit was applied by hand, then validated, rather than by `pnpm install`.**
`pnpm install --lockfile-only` re-resolves the whole graph: it produced the correct
onnxruntime change *plus* 528 unrelated lines, including removal of all 24 `vite@8.1.5` peer
references belonging to the untracked `apps/sandbox` workstream. That violates the brief's
lockfile discipline, so it was reverted. The three onnxruntime edits were applied by hand and
then **validated by pnpm itself**: `pnpm install --frozen-lockfile` reports `Lockfile is up to
date, resolution step is skipped` and `Packages: -2`, which is only possible if the
hand-written lock is byte-consistent with every `package.json` in the workspace. This is
verification, not assertion.

**D2 — the full `packages/ui` suite's 7 initial failures were a race with B5, not a
regression.** All 7 were `Error: missing blog-reader-disclosure` in
`blog-read-aloud.test.tsx`. `blog-read-aloud.tsx` has mtime `2026-07-25 01:10:38`, i.e. it was
rewritten by the concurrent B5 agent *while the suite was running* (suite started 01:09:36);
the `data-slot="blog-reader-disclosure"` element the tests look for now exists at
`blog-read-aloud.tsx:447`. Re-running that file alone: 42/42 pass. A dependency-version change
cannot add or remove a DOM `data-slot`, so the failures are structurally unattributable to
this task. The STOP-AND-REPORT condition ("any TTS test fails") was evaluated against the
re-run, which is green.

**D3 — I repaired collateral damage I caused to `node_modules`, which is outside the three
owned files but is not a repo change.** Detailed under Concerns; nothing tracked by git was
touched.

## Concerns and limitations

**C1 — I damaged and then repaired the shared `node_modules`; other agents were running
against it during that window.** Sequence, recorded honestly:

- After the surgical lock edit, `packages/ui/node_modules/onnxruntime-common` pointed at
  1.22.0-dev but `node_modules/.pnpm/node_modules/onnxruntime-common` (the hoist dir — the
  path transformers actually resolves through) was **missing**, and `.modules.yaml` recorded
  1.21.0 as the intended hoist. That looked like the task's premise failing.
- Attempting to reconcile, I ran `pnpm install --frozen-lockfile --force`. It aborted partway
  with `ERR_PNPM_ENOTEMPTY` on `@rolldown/binding-linux-x64-gnu@1.1.5` (a `.fuse_hidden…` file
  — a deleted-but-still-open `.node` binary held by a concurrent process), leaving the hoist
  dir at 34 of 1215 entries, `@rolldown+binding-linux-x64-gnu@1.0.0-beta.53` emptied, and the
  `astro@5.18.2` patch **unapplied** (which made the marketing build fail with
  `Cannot set property code of #<OutputChunkImpl> which has only a getter` — exactly what
  `patches/astro@5.18.2.patch` exists to prevent).
- Repaired by removing each damaged package dir plus `node_modules/.modules.yaml` and
  re-running `pnpm install --frozen-lockfile`. Verified afterwards: hoist dir back to 1215
  entries, rolldown binding present, astro patch present at `plugin.js:39`, no empty package
  dirs anywhere under `.pnpm` (`find … -type d -empty` → 0), marketing build green, full ui
  suite green, all three typechecks and lints green.
- **The premise did not fail.** After a clean relink pnpm hoists
  `onnxruntime-common@1.22.0-dev.20250409-89f8206ba4`, and it resolves from transformers'
  own dist path (`createRequire(<transformers>/dist/transformers.mjs).resolve('onnxruntime-common')`
  lands in the hoist dir). The earlier "missing" state was stale incremental-install debris.

**C2 — hoist selection is deterministic on a clean install, but an incremental install can
disagree.** The one incremental `pnpm install --frozen-lockfile` that transitioned away from
`onnxruntime-web@1.26.0` recorded `onnxruntime-common@1.21.0` as the hoist target in
`.modules.yaml` (the 1.21.0 copy comes from `onnxruntime-node`); every clean relink records
1.22.0-dev. CI installs into an empty `node_modules`, so CI gets 1.22.0-dev. This fragility is
inherent to the hoist-dir mechanism B7 documented, not introduced by this change — but the
change does *improve* it: `onnxruntime-common` is now a depth-1 direct dependency, strictly
shallower than the depth-2 `onnxruntime-node → onnxruntime-common@1.21.0` competitor, whereas
before both candidates sat at depth 2. A developer who sees a stale local hoist should
re-run a clean install.

**C3 — the mechanism is still implicit and unpinned by any test.** Nothing in the repo would
fail if a future dependency bump changed which `onnxruntime-common` gets hoisted; the only
guard is the knip comment plus B6's `verifyWebBundle` (which checks the `/ort/` assets, not
the bundled `Tensor` version). A build-output assertion on the worker chunk's
`versions:{common:…}` string would close that, but adding one is outside this task's file
bounds (it would live in `scripts/verify-web-bundle.ts`, owned by B6). Flagging for the
orchestrator rather than doing it.

**C4 — cross-version `Tensor` compatibility is now moot but was never tested.** The old
1.26.0-vs-1.22.0-dev mismatch was tolerated in practice; it is now eliminated rather than
proven harmless. No test exercises real inference, so the evidence for "the worker still
works" is the unchanged `/ort/` bytes plus green TTS suites, not a live model run.

**C5 — a stale `@rolldown+binding-linux-x64-gnu@1.1.5` directory (holding a fuse-hidden 19 MB
file another process had open) was moved to my scratchpad rather than deleted, since it could
not be removed in place.** pnpm re-created the real directory and it is intact. The scratchpad
copy is disposable.

## Confidence

**High** on the change itself: the required version is doubly-confirmed from exact upstream
pins, the lockfile diff is provably onnxruntime-only and pnpm-validated, `dist/ort/` bytes are
unchanged and match the brief's hashes, the worker chunk converged from two ORT versions to
one with zero 1.26.0 bytes remaining anywhere in the dist, and every named suite, typecheck,
lint, and knip entry is green.

**Medium** on install-state hygiene: I disturbed and repaired the shared `node_modules` and
verified the repair from several angles, but I cannot rule out that some package I did not
think to check was re-extracted without a postinstall step during the aborted `--force` run.
The broadest evidence that it is healthy is that both app builds, three typechecks, three
lints, and 1874 ui tests all pass on the repaired tree.
