# B6 — ORT wasm debloat + build-time bundle verifier (impl report 1)

## Objective

Stop emitting two redundant ~21.6 MB onnxruntime-web wasm copies into the built web
bundle, and turn the Cloudflare Pages per-file / file-count caps into a build failure
instead of a deploy failure.

## Files changed

- `scripts/verify-web-bundle.ts` (new) — the four bundle guards, run against the real
  merged `apps/web/dist`.
- `scripts/verify-web-bundle.test.ts` (new) — colocated fixture-dir unit tests in the
  `scripts` vitest project.
- `scripts/lib/ort-assets-plugin.ts` — exports the `ORT_EXTERN_WASM_CONDITION` string
  once (with the durable PR-#24014 comment), and exports the already-existing `ORT_DIR`
  so the verifier does not re-derive the self-host directory name.
- `apps/web/vite.config.ts` — `resolve.conditions: [ORT_EXTERN_WASM_CONDITION,
  ...defaultClientConditions]`.
- `apps/marketing/astro.config.mjs` — the same `vite.resolve.conditions`, importing the
  same constant.
- `scripts/build-web-bundle.ts` — calls the verifier on the merged dist, immediately
  after the marketing merge and before header generation; injected as a `verify` dep
  alongside the existing `merge` dep.
- `scripts/build-web-bundle.test.ts` — two new tests for the wiring (plus the `verify`
  entry in the shared `makeDeps` factory).

## Tests added

`scripts/verify-web-bundle.test.ts` (14):

| Test | Behavior | Criterion |
|---|---|---|
| reports nothing for a bundle that self-hosts the runtime and ships no copies | clean bundle passes all four guards | 4 |
| reports a self-hosted runtime file the build never emitted | assertion 1 (existence) | 4 |
| reports a self-hosted runtime file whose bytes differ from the installed runtime | assertion 1 (sha256) | 4 |
| reports every ORT runtime copy emitted outside the self-hosted directory | assertion 2, naming each path | 4 |
| reports a built script that still references the bundler-emitted `/assets/ort-` asset | assertion 3 | 4 |
| reports a built script that still references the bundler-emitted `/_astro/ort-` asset | assertion 3 | 4 |
| ignores source maps, which legitimately name the bundler-emitted asset | assertion 3 scope (no false positive on `.map`) | 4 |
| reports a file over the Cloudflare Pages per-file size cap | assertion 4 (bytes), naming path | 4 |
| resolves the runtime from the installed package when no assets are supplied | default resolution reuses `resolveOrtAssets()` | 4 |
| `checkPagesLimits` reports nothing when the bundle is within both caps | assertion 4 negative | 4 |
| `checkPagesLimits` reports the total when the bundle exceeds the file-count cap | assertion 4 (count), synthetic 20,001-entry list — no I/O | 4 |
| `verifyWebBundle` resolves for a compliant bundle | throwing wrapper, green path | 4 |
| `verifyWebBundle` throws naming every violation it found | failure message names all offenders | 4 |
| `verifyWebBundle` hashes the real self-hosted runtime bytes rather than trusting the file name | sha256 is over content, not names | 4 |

`scripts/build-web-bundle.test.ts` (2 new):

| Test | Behavior | Criterion |
|---|---|---|
| verifies the merged web dist after merging | one call site, `{ distributionDir: <root>/apps/web/dist }` | 5 |
| does not generate headers when verification fails | a violation aborts the build | 5 |

## Self-gate

| Command | Result |
|---|---|
| `npx vitest run verify-web-bundle build-web-bundle` (from `scripts/`) | pass — 29 tests |
| `pnpm --filter @hushbox/scripts test` | fail — 1822 passed / 1 failed, 3 files failed; **all three failures ambient, none in my files** (see Concerns) |
| coverage, owned source files (`verify-web-bundle.ts`, `build-web-bundle.ts`, `lib/ort-assets-plugin.ts`) | 100% statements (95/95), branches (45/45), functions (31/31), lines (86/86) |
| `npx turbo typecheck lint --filter=@hushbox/scripts --filter=@hushbox/web --filter=@hushbox/marketing --force` | 5/6 tasks pass; `@hushbox/web#lint` fails on **one untracked file I never touched** (see Concerns) |
| `npx eslint` on all owned files, run from each package dir after the final edit | exit 0 (`apps/web/vite.config.ts` is eslint-ignored by config) |
| `npx jscpd --threshold 2` on owned files | 0 clones |

Failure excerpts are in Concerns; nothing else is quoted because it passed.

## Acceptance criteria

**(1) Condition string exported once and imported by both configs — met.**
`scripts/lib/ort-assets-plugin.ts` exports `ORT_EXTERN_WASM_CONDITION =
'onnxruntime-web-use-extern-wasm'`. Imported by `apps/web/vite.config.ts`
(`import { ORT_EXTERN_WASM_CONDITION, ortAssetsPlugin } from
'../../scripts/lib/ort-assets-plugin'`) and `apps/marketing/astro.config.mjs`
(same import, `.ts` specifier). The literal appears in no config.

**(2) `defaultClientConditions` spread in both — met.** Both configs read
`conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions]`, importing
`defaultClientConditions` from the installed `vite` (7.3.1; verified the export exists
and is `['module', 'browser', 'development|production']`). Empirical proof the spread
works: both app builds succeed and the merged dist's file count moves by exactly the
two removed wasm files (1013 → 1011) — no other module resolved differently.

**(3) Durable comment — met.** The constant carries a block comment naming
microsoft/onnxruntime PR #24014, the self-host contract, the fail-safe property, and
the `resolve.conditions`-replaces-defaults trap. Each config's `resolve` block carries
a short comment pointing back at it.

**(4) Verifier with the four assertions — met.** `collectWebBundleViolations` runs, in
order: self-hosted-runtime existence + sha256 against `resolveOrtAssets()` (reused, not
re-implemented); stray `ort-wasm*.{wasm,mjs}` outside `dist/ort/`; `/assets/ort-` or
`/_astro/ort-` inside any built `.js`; Pages caps (26,214,400 B per file, 20,000 files),
each violation naming the offending path. `verifyWebBundle` throws with every violation
listed.

**(5) Wired into `buildWebBundle()` after the merge — met.** Single call site at
`scripts/build-web-bundle.ts`, between `deps.merge(...)` and header generation, so
prod (`--target=prod`), e2e (`--target=e2e`, used by `playwright.config.ts` and CI's
`e2e-build`), and the preview build all pass through it. Verified `buildWebBundle` is
the only build entry point: `package.json`'s `build:web` and `build:e2e` both invoke it.

**(6) Assertions 2 and 3 RED before the config change — met.** Built the tree at its
pre-change state (`turbo build` → `merge-marketing-into-web`) and ran the finished
verifier against the real merged `apps/web/dist`:

```
Web bundle verification failed (apps/web/dist):
  - redundant ORT runtime copy outside ort/: _astro/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm (21596019 B)
  - redundant ORT runtime copy outside ort/: assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm (21596019 B)
  - built script references the bundler-emitted ORT asset "/_astro/ort-…": _astro/tts.worker-mMXxELK7.js — the ORT runtime must load from ort/ only
  - built script references the bundler-emitted ORT asset "/assets/ort-…": assets/tts.worker-CD-CPWVt.js — the ORT runtime must load from ort/ only
```

Assertions 1 and 4 were green pre-change, as expected — they are forward guards, not
the current defect. The unit tests were also RED first in the ordinary TDD sense
(`Cannot find module './verify-web-bundle.js'`, then 2 failing wiring tests in
`build-web-bundle.test.ts` before the `verify` dep existed).

**(7) After the change: `dist/ort/` bytes unchanged, both worker chunks still
reference `/ort/` — met.**

| | Before | After |
|---|---|---|
| merged `apps/web/dist` bytes | 166,637,384 | 123,362,053 (**−43,275,331, −25.97%**) |
| merged `apps/web/dist` files | 1,013 | 1,011 (exactly the two wasm copies) |
| `dist/ort/…jsep.wasm` sha256 | `c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39` | identical |
| `dist/ort/…jsep.mjs` sha256 | `08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9` | identical |
| stray `ort-wasm*` files | 2 (`assets/`, `_astro/`) | 0 |
| largest file | 21,596,019 B (`dist/ort/…wasm`) | unchanged |

Both built worker chunks still pin the self-hosted path — `wasmPaths=\`/ort/\`` appears
in `assets/tts.worker-W3Nk68f_.js` and `_astro/tts.worker-CCWM9J1e.js`, and each
contains **zero** `/assets/ort-` or `/_astro/ort-` occurrences. The verifier reports
`PASS — no violations` against the post-change merged dist.

The 43,275,331 B delta decomposes as 43,192,038 B (the two wasm copies) + 83,293 B
across the two worker chunks — the inlined Emscripten glue the extern-wasm variant
drops. That matches the research doc's ~43 KB-per-chunk estimate and is further
evidence nothing else in resolution shifted.

## Known-hazard resolution: Rolldown and the worker sub-build

**Confirmed empirically, no longer Inferred.** Rolldown honors `resolve.conditions` in
the dedicated-worker sub-build. Pre-change, the *only* two built files carrying the
`new URL(...ort-wasm...)` reference were the worker chunks
(`assets/tts.worker-*.js`, `_astro/tts.worker-*.js`) — the reference exists nowhere
else in the graph. Post-change those same worker chunks contain zero such references
and no wasm asset is emitted, which is only possible if the condition reached the
worker sub-build's resolver. Verified on three independent `turbo build --force` runs
(web + marketing). No plugin-based asset deletion was needed, so the rejected
option B never came into play.

## Deviations

1. **`distDir` → `distributionDir`.** The verifier's option field and local names use
   `distributionDir`; `unicorn/prevent-abbreviations` rejects `distDir` (the existing
   `ortDistributionDir` in the plugin already uses the long form). Naming only.
2. **`ORT_DIR` is now exported from `ort-assets-plugin.ts`.** Not called for in the
   brief, but the verifier must agree with the plugin on the self-host directory, and
   re-deriving it from `TTS_ORT_WASM_PATH` in a second place is exactly the mirrored
   derivation CODE-RULES bans. One implementation, imported.
3. **Verifier injected as a `verify` dep rather than called directly.** Matches the
   existing `generateEnv` / `exec` / `merge` dependency-injection shape in
   `buildWebBundle`, keeping its unit test hermetic. The real `verifyWebBundle` is
   wired at the CLI entry point beside `mergeMarketingIntoWeb`.
4. **Assertion 3 scans `.js` only, and the scope is pinned by a test.** Source maps
   legitimately name the bundler-emitted asset in their `sources` array; scanning them
   would be a guaranteed false positive. The brief specifies `.js`; the test
   ("ignores source maps…") makes the boundary deliberate rather than accidental.

## Concerns and limitations

1. **Ambient failures, attributed out (not mine).**
   - `apps/web` lint fails on `apps/web/src/components/settings/notifications-card.test.tsx`
     — a prettier error in a file that is **untracked** (`??` in `git status`), i.e.
     created by a concurrent workstream after my snapshot. I never opened it.
   - `scripts/generate-env.test.ts` fails on the VAPID secret-key drift the brief
     pre-declared.
   - `scripts/refresh-catalog-run.test.ts` and `scripts/seed-run.test.ts` fail with
     `ERR_MODULE_NOT_FOUND` for a stale vitest ssr dep-optimizer artifact
     (`scripts/node_modules/.vite/.../deps_ssr/@hushbox_db.js`). `packages/db` is
     modified in the working tree by another workstream and the cache dir predates my
     session (mtime Jul 24 22:40). Reproduces in isolation; touches no file of mine.
2. **One transient build failure, not reproducible.** The first
   `turbo build --force` after the config edit failed inside `apps/web`'s
   `serviceWorkerBuildPlugin` `closeBundle` (a Vite `.vite-temp/vite.config.ts.timestamp-*.mjs`
   frame), with `apps/marketing` also reporting `ELIFECYCLE`. Three subsequent
   `--force` runs — plus two standalone `vite build` runs — all exited 0 and produced
   a correct `dist/sw.js`. I could not reproduce it and have no evidence tying it to
   `resolve.conditions`; most likely a race against the config-timestamp temp file
   written while the edit landed. Flagging it rather than burying it.
3. **No E2E**, per the founder's D6 ruling. The verifier is a `scripts`-project unit
   test plus a real-dist build gate; there is no browser-level proof in this task that
   `/ort/…jsep.mjs` still loads under the enforced CSP. The pre-existing T1 CSP E2E
   covers the header side, and the runtime path is unchanged by construction (ORT
   already dynamic-imported from `/ort/` before this change — the removed copy was
   dead weight, never loaded).
4. **`packages/ui`'s `onnxruntime-web` direct dependency is untouched**, as instructed
   — that is B7, sequenced after this task. The verifier's sha256 assertion is the
   guard B7 depends on.

## Confidence

**High.** The mechanism is the vendor's own export condition; the before/after is
measured on real builds rather than reasoned about; the byte delta reconciles to within
the expected worker-chunk shrink; `dist/ort/` is proven byte-identical; the one
Inferred assumption in the research doc (Rolldown + worker sub-build) is now
empirically confirmed on three builds; and the change fails safe — if the condition
ever stops resolving, the build reverts to today's fat-but-working output and the
verifier turns that into a loud build failure instead of a silent regression.
