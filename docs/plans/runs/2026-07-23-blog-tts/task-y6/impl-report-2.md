# Y6 — fix cycle 1 — implementation report 2

## Objective

Finish the rename cycle 0 stopped short of, plus two batched items:

1. Rename the exported symbols and the runtime failure message that still said "Web".
2. Replace `scripts/lib/build-seam.ts`'s stale module docblock, applying this run's
   deletion rule rather than writing a fresh enumeration.
3. Follow the symbol rename in `scripts/verify-bundle.test.ts`'s `describe` names.

Behaviour-free throughout. No logic edits, no signature changes beyond the rename, no test
deleted.

## The renames

| Old | New |
| --- | --- |
| `verifyWebBundle` | `verifyBundle` |
| `VerifyWebBundleOptions` | `VerifyBundleOptions` |
| `collectWebBundleViolations` | `collectBundleViolations` |
| `"Web bundle verification failed (…)"` | `"Bundle verification failed (…)"` |

The pre-existing `VerifyBundle` type (the injection seam `build-web-bundle.ts` consumes) is
untouched and does not collide: TypeScript identifiers are case-sensitive, so `verifyBundle`
(the function) and `VerifyBundle` (the seam type it satisfies) coexist — and the pairing is
now the idiomatic one, since the function is exactly what the type describes.

### Every call site, old → new

| File:line | Old | New |
| --- | --- | --- |
| `scripts/verify-bundle.ts:70` | `): VerifyWebBundleOptions {` | `): VerifyBundleOptions {` |
| `scripts/verify-bundle.ts:147` | `export interface VerifyWebBundleOptions` | `export interface VerifyBundleOptions` |
| `scripts/verify-bundle.ts:164` | `type VerifyBundle = (options: VerifyWebBundleOptions)` | `type VerifyBundle = (options: VerifyBundleOptions)` |
| `scripts/verify-bundle.ts:455` | `export async function collectWebBundleViolations(` | `export async function collectBundleViolations(` |
| `scripts/verify-bundle.ts:456` | `options: VerifyWebBundleOptions` | folded onto :455 (prettier — see Deviations) |
| `scripts/verify-bundle.ts:477` | `export async function verifyWebBundle(options: VerifyWebBundleOptions)` | `export async function verifyBundle(options: VerifyBundleOptions)` |
| `scripts/verify-bundle.ts:478` | `await collectWebBundleViolations(options)` | `await collectBundleViolations(options)` |
| `scripts/verify-bundle.ts:481` | `` `Web bundle verification failed (…)` `` | `` `Bundle verification failed (…)` `` |
| `scripts/verify-bundle.ts:493` | `await verifyWebBundle(options)` (CLI entry) | `await verifyBundle(options)` |
| `scripts/build-web-bundle.ts:27` | `import { appBundleOptions, verifyWebBundle }` | `import { appBundleOptions, verifyBundle }` |
| `scripts/build-web-bundle.ts:106` | `verify: verifyWebBundle,` | `verify: verifyBundle,` |
| `apps/admin/vite.config.ts:9` | `import { appBundleOptions, verifyWebBundle }` | `import { appBundleOptions, verifyBundle }` |
| `apps/admin/vite.config.ts:34` | `await verifyWebBundle(appBundleOptions(rootDir, 'apps/admin'))` | `await verifyBundle(…)` |
| `apps/sandbox/src/build.ts:5` | `import { appBundleOptions, verifyWebBundle }` | `import { appBundleOptions, verifyBundle }` |
| `apps/sandbox/src/build.ts:46` | `await verifyWebBundle(appBundleOptions(…, 'apps/sandbox'))` | `await verifyBundle(…)` |
| `scripts/verify-bundle.test.ts` | 2 imports, 3 `describe` names, 30 call sites | all renamed |

`describe` names now read `collectBundleViolations`, `collectBundleViolations for a dist that
must not ship TTS`, and `verifyBundle` (item 3).

### Zero survivors

```
$ git grep -n -E "verifyWebBundle|VerifyWebBundleOptions|collectWebBundleViolations|Web bundle verification failed" -- . ':!docs/plans/runs/**'
GIT_GREP_EXIT=1   # 1 = zero hits
```

A second sweep over the working tree (untracked files included, only `node_modules`, `.git`,
built `dist/` output and `docs/plans/runs/` excluded) also returns zero. Run records are
excluded because CODE-RULES says they are never updated.

### The workflows needed no edit — confirmed, not assumed

```
.github/workflows/ci.yml:316            run: pnpm verify:bundle
.github/workflows/ci.yml:369            run: pnpm verify:bundle dist-ios dist-android dist-android-direct
.github/workflows/build-android.yml:102 run: pnpm verify:bundle
.github/workflows/release.yml:154       run: pnpm verify:bundle
package.json:74                         "verify:bundle": "tsx scripts/verify-bundle.ts",
```

All four workflow steps reach the guard through the pnpm script, which resolves to the file
path — no workflow names any renamed symbol. `.github/workflows/ci.yml`'s foreign diff (and
`release.yml`'s / `build-android.yml`'s) is untouched by this cycle; I opened no workflow file
with an edit tool.

## Item 2 — the `build-seam.ts` module docblock

**Old (`:1-15`), deleted in full:**

```
/**
 * Self-host onnxruntime-web's WASM runtime same-origin.
 *
 * The on-device Kokoro TTS engine (@huggingface/transformers, via kokoro-js)
 * loads onnxruntime-web's `.wasm`/`.mjs` runtime. Left to library defaults it
 * fetches those from a third-party CDN (jsdelivr), which the production CSP
 * blocks. `tts.worker.ts` instead pins `env.backends.onnx.wasm.wasmPaths` to
 * the shared same-origin `TTS_ORT_WASM_PATH`; this plugin emits the matching
 * runtime files there so the path resolves, in dev (middleware) and in the
 * built dist (Rollup asset). The files are read from the installed package, so
 * the self-hosted copies always match the installed transformers version.
 *
 * Wired from `apps/web/vite.config.ts` and `apps/marketing/astro.config.mjs`
 * (one implementation, both surfaces).
 */
```

**New (`:1-6`):**

```
/**
 * The build-config seam: values whose correctness depends on being identical
 * across build surfaces, written once here and imported rather than restated
 * per app. Each export carries the reason it is load-bearing.
 */
```

### Why every deleted clause went, clause by clause

I applied the deletion rule rather than rewriting the enumeration, and checked each clause
before dropping it. Nothing durable was lost — every surviving fact is stated at a place that
cannot drift from the thing it describes:

| Deleted clause | Disposition | Grounding |
| --- | --- | --- |
| "Self-host onnxruntime-web's WASM runtime same-origin" | Superseded — describes one export, not the module | `ortAssetsPlugin`'s own docblock, `scripts/lib/build-seam.ts:170-174` |
| TTS engine loads ORT's `.wasm`/`.mjs` via kokoro-js → transformers | Kept elsewhere | `ortDistributionDir` resolves exactly that chain, `build-seam.ts:136-140` |
| "library defaults … fetch from a third-party CDN (jsdelivr), which the production CSP blocks" | Kept elsewhere, more grounded | `packages/ui/src/components/accessibility/lib/tts.worker.ts:31-34` states it at the pin site; `packages/shared/src/tts-hosts.ts:24-25` states it at the CSP site; **pinned by two tests** — `packages/shared/src/tts-hosts.test.ts:18-20` and `scripts/generate-headers.test.ts:619-623` both assert `jsdelivr` never enters `connect-src` |
| "`tts.worker.ts` instead pins `env.backends.onnx.wasm.wasmPaths`" | **Deleted as false** — see below | `tts.worker.ts:41` sets `env.wasmPaths`; `:37` says outright "there is no `env.backends` tree to reach through" |
| "this plugin emits the matching runtime files there … dev (middleware) and built dist (Rollup asset)" | Kept elsewhere | `ortAssetsPlugin`'s docblock, `build-seam.ts:170-174`, over a body whose two halves are the `configureServer` middleware and the emit |
| "files are read from the installed package, so the self-hosted copies always match the installed transformers version" | Duplicate | Stated verbatim in intent at `resolveOrtAssets`, `build-seam.ts:158-161` |
| "Wired from `apps/web/vite.config.ts` and `apps/marketing/astro.config.mjs`" | **Deleted as an importer enumeration that had already gone stale** | `scripts/verify-bundle.ts:33` imports `ORT_DIR`/`resolveOrtAssets`/`OrtAsset` from this file, so admin and sandbox are importers too — exactly the claim the brief flagged |

**A wrong comment found and removed, not just a stale one.** The clause naming
`env.backends.onnx.wasm.wasmPaths` describes a property path that does not exist: kokoro-js
re-exports the transformers `env` as a thin wrapper exposing only a `wasmPaths` setter, which
`tts.worker.ts:37-41` documents and `tts.worker.test.ts:11-15` pins with a mock of that exact
shape ("a regression to `env.backends.onnx.wasm.wasmPaths` throws here"). A reader following
the deleted comment would have reached for a tree that isn't there.

**The grounding for what I kept.** "Values whose correctness depends on being identical" is
CODE-RULES §"One Implementation, Shared"'s own test, applied to this file — it states the
file's admission rule (what may be added here) rather than its contents, so it cannot go stale
when an export moves. "The build-config seam" is the file's own existing language: `build-seam.ts:83-85`
already calls itself "the build-config seam", which is also what the filename says. The third
sentence tells a reader where the per-value rationale lives, which is the one thing a reader of
a deliberately short module docblock would otherwise go looking for at module scope — and
re-adding at module scope is precisely the drift just removed.

## Tests

| Test | Behavior | Criterion |
| --- | --- | --- |
| `verifyBundle > names the verified dist in its failure message` (added) | The thrown message opens `Bundle verification failed (<dist>):` | Item 1 — the message rename; it was the one renamed thing no test observed |

No test deleted. The 30 renamed call sites and 3 `describe` names in
`scripts/verify-bundle.test.ts` carry the existing tests onto the new names unchanged.

### TDD — each rename driven RED first

| Step | RED observed | GREEN |
| --- | --- | --- |
| Message rename | Test written first, against the *old* symbol names so its RED could not be confused with an import error: `AssertionError: expected [Function] to throw error including 'Bundle verification failed (/tmp/…' but got 'Web bundle verification failed (/tmp/…'` — 1 failed / 40 passed | 41/41 |
| Symbol rename | Test file renamed first: `TypeError: verifyBundle is not a function` — 27 failed / 14 passed | 41/41 |

Sequencing the message rename **before** the symbol rename was deliberate: had I renamed both
at once, the message test would have failed at module resolution and its real assertion would
never have been exercised.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch scripts/verify-bundle.test.ts` | pass — 41/41 |
| `pnpm test:watch scripts/build-web-bundle.test.ts` | pass — 13/13 |
| `turbo run test --filter=@hushbox/scripts --force` | **1880/1880 tests pass**, 88/90 files; 2 files fail at module load — pre-existing, attributed below |
| coverage (enabled in that run, v8) | no threshold complaint — `grep -ci "coverage.*(threshold\|not met\|failed\|below)"` = 0 |
| `eslint verify-bundle.ts verify-bundle.test.ts build-web-bundle.ts lib/build-seam.ts` from `scripts/` | **exit 0** (after the last edit) |
| `eslint src/build.ts` from `apps/sandbox/` | exit 0 |
| `eslint vite.config.ts` from `apps/admin/` | exit 0 — warning only: file matches a pre-existing ignore pattern (same as cycle 0) |
| `tsgo --noEmit` from `scripts/` | exit 0 |
| `tsgo --noEmit` from `apps/admin/` | exit 0 |
| `tsgo --noEmit` from `apps/sandbox/` | exit 0 |
| `pnpm arch:check` | pass — OK, 12 rules over 2046 files |
| `pnpm lint:unused` (knip) | exit 1 — 2 findings, both foreign, attributed below |
| `pnpm verify:bundle` (CLI call site, real web dist) | exit 0 — `Verified …/apps/web/dist` |

**The ESLint gate earned its keep.** The first run failed one prettier error: shortening
`collectWebBundleViolations` → `collectBundleViolations` made the signature fit on one line, so
the existing three-line wrap became a formatting violation. Fixed by folding it (see
Deviations), then re-run to exit 0 after the last edit, and tests + typecheck re-run after that
fold.

### Attribution of the two failing test files

`refresh-catalog-run.test.ts` and `seed-run.test.ts` — the pair the plan records under §KNOWN
PRE-EXISTING FAILURES, verbatim cause confirmed:

```
Error: Cannot find module '…/scripts/node_modules/.vite/vitest/<hash>/deps_ssr/@hushbox_db.js&v=8a56db6e'
  code: 'ERR_MODULE_NOT_FOUND'
```

Both are stale-`deps_ssr`-cache module-load failures, not test failures — **zero tests fail**
(1880/1880). Evidence they are not mine: `grep -lE "verify-bundle|build-seam|verifyBundle|
VerifyBundleOptions|collectBundleViolations|verifyWebBundle"` over both files returns nothing.
1880 = cycle 0's recorded 1879 + my one added test.

### Attribution of the knip findings

`packages/config/vitest.package.config.ts` reported unused, plus a `wrangler`/`apps/sandbox`
configuration hint — the two foreign findings the brief named and cycle 0 recorded. No renamed
symbol appears anywhere in knip's output; renaming an export cannot change its reachability,
and the export set is unchanged in count and shape.

## Acceptance criteria

**Item 1 — exported symbols and the runtime message — met.** All four renamed at all call
sites (table above); repo-wide grep returns zero survivors outside `docs/plans/runs/`.

**Item 2 — `build-seam.ts:1-15` docblock — met.** Replaced with a four-line statement of what
the module is; every deleted clause dispositioned in the table above, including one clause
deleted as factually false and one importer enumeration deleted as already-stale. No new
enumeration of contents or importers was written.

**Item 3 — `describe` names — met.** All three follow the symbol rename.

**Behaviour-free — met.** Evidenced three ways:

1. *Typecheck.* All three consuming packages compile at exit 0. `tsgo --listFiles` from
   `apps/admin` shows `scripts/verify-bundle.ts` and `scripts/lib/build-seam.ts` inside the
   program alongside `apps/admin/vite.config.ts` — an unresolvable import or a mismatched
   renamed type would fail here. The `verify: verifyBundle` injection in
   `build-web-bundle.ts:106` is typechecked against the untouched `VerifyBundle` seam type, so
   the renamed function still satisfies the contract its callers hold.
2. *Loader.* `scripts/lib/build-seam.js` still exports all ten symbols
   (`ORT_DIR, ORT_EXTERN_WASM_CONDITION, TTS_WORKER_SCAN_ENTRY, WORKER_BUILD_OPTIONS,
   collectOrtAssets, contentTypeFor, ortAssetsPlugin, ortDistributionDir, resolveOrtAssets,
   resolveTtsWorkerSource`) — unchanged in count and name — and
   `apps/marketing/astro.config.mjs`, its other consumer, still resolves to an object default
   export.
3. *Isolated delta.* Below.

### The guard executed from a call site, in both directions

**Passing, end-to-end through the CLI call site** (`verify-bundle.ts:493`), against the real
built web dist:

```
$ pnpm verify:bundle
Verified /…/apps/web/dist
CLI_EXIT=0
```

**Both directions through the exported pair, exactly as `apps/admin/vite.config.ts:34` and
`apps/sandbox/src/build.ts:46` call it** — `appBundleOptions(root, 'apps/admin')` piped into
`verifyBundle`, against a scratch root outside the repo so no shared artifact was mutated (this
run has twice been bitten by concurrent artifact rebuilds):

```
appBundleOptions -> {"distributionDir":"/tmp/guard-probe-root/apps/admin/dist","shipsTts":false}
violations: ["no _headers at the dist root — this origin ships without its CSP and the rest of its security headers"]
THREW: Bundle verification failed (/tmp/guard-probe-root/apps/admin/dist):
RESOLVED on a compliant dist
PROBE_EXIT=0
```

The failing direction produces the **renamed** message, from the real exported function, driven
through the real `appBundleOptions` declaration lookup. The scratch tree was removed afterwards
(verified absent).

Why not rebuild admin/sandbox for a literal in-config execution: their `rootDir` is computed
from `__dirname`, so exercising the hook itself means a full rebuild of a shared, gitignored
dist that concurrent workstreams read. The probe differs from those call sites in the `rootDir`
argument alone; resolution and type compatibility at the real sites are covered by the
typechecks above.

### Both `turbo.json` files unchanged

Snapshotted before the first edit and re-read after the last:

| File | sha256 before → after | `git hash-object` |
| --- | --- | --- |
| `apps/admin/turbo.json` | `76188039…c91257` → `76188039…c91257` | `fa1e323c…` → `fa1e323c…` |
| `apps/sandbox/turbo.json` | `7fb00cf0…865707` → `7fb00cf0…865707` | `86dc47b7…` → `86dc47b7…` |

Byte-identical, as a symbol rename should leave them.

**Resolved-input-map check re-run** (the non-mutating form the cycle-0 auditor established,
taken in one tight window):

| Package | resolved inputs | `build-seam.ts` | `verify-bundle.ts` |
| --- | --- | --- | --- |
| `@hushbox/admin#build` | 159 | `b63b040a09…` | `f74023eefe…` |
| `@hushbox/sandbox#build` | 59 | `b63b040a09…` | `f74023eefe…` |

159 and 59 are exactly the counts cycle 0 and Y1 recorded — nothing narrowed. Both entries'
hashes are exact `git hash-object` blob hashes of the current worktree files
(`build-seam.ts` = `b63b040a097aa86de95fe1aec3c139116d5aa172`, `verify-bundle.ts` =
`f74023eefefc39e1bc16b0aeeb81afe21d31c23f`), so the map is content-derived and live — and it
has picked up *this cycle's* edits to both files, which is stronger than cycle 0's reading
could be. The declared `inputs` arrays are unchanged and still open with `$TURBO_DEFAULT$`.

The natural negative control the cycle-0 auditor identified still reads correctly: sandbox
declares `.env*` and has no such file, contributing **zero** entries — the silent signature a
stale declared path would leave. The renamed paths do not behave that way. The differential
control also holds structurally: `headers-vite-plugin.ts` appears in admin's resolved map
(`5b954093…`, likewise a real blob hash) and is absent from sandbox's.

### My delta, isolated from the uncommitted work around it

`git diff` conflates X5b's, Y1's, Y2's and cycle 0's uncommitted edits with mine. To isolate
this cycle's contribution I copied each touched file, inverse-applied the four renames, and
diffed the result against the index. After the inverse rename, **not one rename-related line
remains** in `verify-bundle.ts`, `build-web-bundle.ts`, `apps/admin/vite.config.ts` or
`apps/sandbox/src/build.ts` — the old names reappear exactly where the index has them, and every
residual hunk is prior tasks' work (X5b's `_headers` check, Y1's `apps/sandbox` declaration,
Y2's `build-web-bundle.ts` docblock, cycle 0's import paths). In `build-seam.ts` the only
residual hunk not attributable to prior tasks is the module docblock. So this cycle's delta is
exactly: the four renames, the docblock, one added test, one prettier fold.

## Deviations

**One formatting change beyond the literal rename**, at `scripts/verify-bundle.ts:455`:

```
-export async function collectBundleViolations(
-  options: VerifyBundleOptions
-): Promise<string[]> {
+export async function collectBundleViolations(options: VerifyBundleOptions): Promise<string[]> {
```

Forced, not chosen: the shorter name brought the signature under the print width, so prettier
(enforced as an ESLint rule, and therefore a CI lint-gate failure) rejected the retained wrap.
Whitespace only.

## Concerns and limitations

1. **`packages/shared/src/tts-hosts.ts` carries the same false `env.backends.onnx.wasm.wasmPaths`
   claim I deleted from `build-seam.ts`** — at `:4` ("the TTS worker … pins transformers.js
   `env.remoteHost` / `env.backends.onnx.wasm.wasmPaths` from these") and at `:33` ("the worker
   points `env.backends.onnx.wasm.wasmPaths` here"). Both are contradicted by
   `tts.worker.ts:37-41` and pinned false by `tts.worker.test.ts:11-15`. Outside my file
   ownership, so **raised, not fixed** — the deleted clause and these two share one origin, so
   fixing only mine leaves the wrong comment alive at the more-read location.
2. **The `_headers`-missing violation is what my probe used to force the failing direction.**
   It is a genuine check (X5b's), not a contrivance, but it exercises the `shipsTts: false`
   branch; the TTS branch's failing direction is covered by the unit tests rather than by an
   executed end-to-end run.
3. **Cycle 0's concern 4 still stands and is unchanged by this cycle:** the uncommitted
   `knip.jsonc` foreign diff deletes a block whose comment ends "…which `ort-assets-plugin.ts`
   reads out of transformers' own dist". My grep is clean only while that block stays deleted;
   if its owner restores it, the stale *filename* returns. Not mine to fix, and not a survivor
   of the symbol rename.
4. **Real turbo cache HIT still not demonstrated**, only cache-key sensitivity — the same
   honest limitation cycle 0 and Y1 disclosed. Unchanged by a rename.

## Confidence

**High.** The rename is mechanical and every one of its call sites is either executed
(`pnpm verify:bundle`, the two-direction probe, 1880 tests) or typechecked in its consuming
package's own program, with a repo-wide grep proving zero survivors and an inverse-rename
diff proving I changed nothing else in those files. The docblock is the one judgement call:
I deleted rather than relocated the ORT rationale, on the evidence that every durable clause in
it is already stated at the two ends it binds (`tts.worker.ts`, `tts-hosts.ts`) or on the
export it describes — and that its one unique clause was false. An auditor who disagrees would
want the jsdelivr/CSP "why" restated on `ortAssetsPlugin` itself; I judged that a third copy of
a fact two files already pin with tests.
