# X4 — impl report 1

## Objective

Stop the dev-server first-click reload by making the TTS worker source a dependency-scan
entry, per §X4's eight acceptance criteria.

## Tree state during measurement

`git status` taken before the first edit: three other workstreams are live in this
checkout (`apps/api`, `apps/web/src/components/document-panel`, `packages/shared`,
`packages/db`, `e2e`, `.github/workflows/ci.yml`, `knip.jsonc`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml` all carry foreign diffs). None of my four files was modified by
anyone else before or during this task. RED and GREEN readings were taken 4 minutes apart
(10:35–10:41 local) with no `pnpm install` and no rebuild in between, so the two
directions are comparable.

## Files changed

- `scripts/lib/ort-assets-plugin.ts` — adds `resolveTtsWorkerSource()` (existence-asserting,
  mirrors `collectOrtAssets`) and the `TTS_WORKER_SCAN_ENTRY` constant both app configs
  import.
- `scripts/lib/ort-assets-plugin.test.ts` — pins the resolved path, the throw-when-missing
  branch, and that the exported constant is the asserted value.
- `apps/web/vite.config.ts` — `optimizeDeps.entries: ['**/*.html', TTS_WORKER_SCAN_ENTRY]`.
- `apps/marketing/astro.config.mjs` — `optimizeDeps.entries: [TTS_WORKER_SCAN_ENTRY]`.
- `packages/ui/src/components/accessibility/lib/tts.worker.ts` — corrects the stale
  worker-format comment (criterion 8) and records the scan-entry coupling.

## Tests added

- `resolveTtsWorkerSource > returns an absolute path to an existing worker source file` —
  the constant resolves to a real file — criterion 1.
- `resolveTtsWorkerSource > throws when the worker source is not where the config expects
  it` — the regression guard fires on a moved/renamed worker — criterion 1.
- `TTS_WORKER_SCAN_ENTRY > is the resolved worker source, asserted at module load` — the
  exported constant is the asserted path, so the throw happens at config load — criterion 1.

No dev-server boot test was added; criterion 1 forbids the second mechanism.

TDD: the three tests were written first and observed failing with
`TypeError: resolveTtsWorkerSource is not a function` (3 failed / 11 passed) before any
production code existed; green immediately after (14 passed).

## Self-gate

| Command | Result |
| --- | --- |
| `turbo test typecheck lint --filter=@hushbox/scripts --force` | test RED (2 foreign files), typecheck + lint pass — see below |
| `turbo test typecheck lint --filter=@hushbox/web --force` | pass — 395 test files, 3/3 tasks |
| `turbo test typecheck lint --filter=@hushbox/ui --force` | pass — 3/3 tasks |
| `turbo typecheck lint --filter=@hushbox/marketing --force` | pass (`astro check`: 0 errors) — not a §X4 check, run because I edited its config |
| `eslint lib/ort-assets-plugin.ts lib/ort-assets-plugin.test.ts` (from `scripts/`) | exit 0, after last edit |
| `eslint vite.config.ts` (from `apps/web/`) | exit 0 (file matches the package's ignore pattern — warning only) |
| `eslint astro.config.mjs` (from `apps/marketing/`) | exit 0 |
| `eslint src/components/accessibility/lib/tts.worker.ts` (from `packages/ui/`) | exit 0 |
| `prettier --check` on all five edited files | "All matched files use Prettier code style" |
| coverage of `scripts/lib/ort-assets-plugin.ts` | 100% statements / branches / functions / lines |
| `tsx scripts/with-env.ts knip --no-progress` | exit 1, two findings, both foreign |

### `@hushbox/scripts` test gate — attribution

`Test Files 2 failed | 88 passed (90); Tests 1876 passed`. The two failures are
`refresh-catalog-run.test.ts` and `seed-run.test.ts`, the exact pair §KNOWN PRE-EXISTING
FAILURES names:

```
Caused by: Error: Cannot find module '.../scripts/node_modules/.vite/vitest/…/deps_ssr/@hushbox_db.js&v=8a56db6e'
{ code: 'ERR_MODULE_NOT_FOUND' }
```

Neither imports anything I touched. `generate-env.test.ts` and `lib/seed-documents.test.ts`,
also listed there, passed this run. My own file's tests are inside the 88 that passed.

`@hushbox/scripts#typecheck` exited 2 on the first combined run, then passed on an
immediate isolated re-run (`turbo typecheck --filter=@hushbox/scripts --force`: 1
successful) and on a direct `tsgo --noEmit` (exit 0) from `scripts/`. Transient, and the
only files it could have caught mid-edit are the concurrent workstreams'
(`packages/shared`, `apps/api`), not mine.

`knip` findings: `Unused files (1) packages/config/vitest.package.config.ts` and a
configuration hint on `wrangler / apps/sandbox / knip.jsonc`. Both files carry foreign
diffs and I edited neither. My new export `resolveTtsWorkerSource` is NOT flagged.

## Acceptance criteria

### 1. One constant, computed from `import.meta.url`, asserted to exist at config load — MET

`scripts/lib/ort-assets-plugin.ts:108` `resolveTtsWorkerSource(workerPath = path.resolve(
path.dirname(fileURLToPath(import.meta.url)), '../../packages/ui/src/components/
accessibility/lib/tts.worker.ts'))` throws `TTS worker source not found at <path>…` when
the file is missing, exactly as `collectOrtAssets` throws for a runtime-less dist.
`scripts/lib/ort-assets-plugin.ts:129` `export const TTS_WORKER_SCAN_ENTRY =
resolveTtsWorkerSource();` runs that assert at module load, i.e. when either app config is
loaded. One constant is exported; both configs import it. No boot test added.

### 2. Astro composes it and its own entries merge — MET, verified not assumed

`apps/marketing/astro.config.mjs` sets `vite.optimizeDeps.entries: [TTS_WORKER_SCAN_ENTRY]`.

Verification is comparative, on cold caches: before the change Astro's own srcDir scan
produced **48** optimized deps; after the change the cold `_metadata.json` holds **49** —
the same 48 plus `kokoro-js`. If the user array had replaced Astro's inline entry rather
than concatenating with it, the srcDir-discovered deps (`@astrojs/react/client.js`,
`react`, every `@radix-ui/*`, …) would have vanished. They did not. Astro's inline entry is
set at `astro/dist/core/create-vite.js:104-107` and merged with the user's `vite` config,
and Vite's config merge concatenates arrays — the 48→49 measurement is the direct evidence.

### 3. Web composes it WITH the restated `**/*.html` — MET

`apps/web/vite.config.ts`: `optimizeDeps: { entries: ['**/*.html', TTS_WORKER_SCAN_ENTRY] }`,
with a comment recording why the default glob must be restated. Criterion 6 is the proof it
was not dropped.

### 4. RED first, then GREEN on both apps, cold cache — MET

Procedure each time: `rm -rf apps/<app>/node_modules/.vite/deps`, cold start the dev server
(marketing on `HB_ASTRO_PORT=4399`, web on `HB_VITE_PORT=5399`, chosen off the standard
ports so a concurrent workstream's stack could not collide with the measurement), inspect
`_metadata.json`, then fetch the worker's dev URL
`/@fs/…/packages/ui/src/components/accessibility/lib/tts.worker.ts?worker_file&type=module`.

**RED — marketing** (before the change). Cold `_metadata.json`: 48 deps, `kokoro-js` absent,
cache 19 MB. After the worker fetch:

```
10:35:04 [vite] ✨ new dependencies optimized: kokoro-js
10:35:04 [vite] ✨ optimized dependencies changed. reloading
```

cache grew 19 MB → 28 MB.

**RED — web** (before the change). Cold `_metadata.json`: 65 deps, `kokoro-js` absent,
cache 101 MB. After the worker fetch:

```
10:36:05 AM [vite] (client) ✨ new dependencies optimized: kokoro-js
10:36:05 AM [vite] (client) ✨ optimized dependencies changed. reloading
```

cache grew 101 MB → 110 MB.

(The plan's phrasing is "new dependencies found"; rolldown-vite 7.3.1 words it "new
dependencies optimized". Same event — the reload line is verbatim.)

**GREEN — marketing.** Cold start, **zero HTTP requests served** at the time of reading
(`grep -c '\[200\]' = 0`): `_metadata.json` holds 49 deps including
`"kokoro-js": {"src":"…/kokoro-js@1.2.1/…/kokoro.js","file":"kokoro-js.js",
"fileHash":"d806b826"}` and `deps/kokoro-js.js` exists (4,218,286 bytes). Then the worker
fetch (200) and `/blog/` (200): **zero** `new dependencies` lines, **zero** dep-optimizer
reload lines.

**GREEN — web.** Cold start, zero requests served: `_metadata.json` holds 66 deps including
`kokoro-js`, `deps/kokoro-js.js` exists (4,218,286 bytes). Then the worker fetch (200) and
`/chat` (200): **zero** `new dependencies` lines, **zero** dep-optimizer reload lines; cache
stayed at 110 MB (no re-chunk).

One `page reload` line does appear in web's GREEN log and is **not** a dependency reload:

```
10:41:17 AM [vite] (client) page reload /workspace/…/packages/shared/src/affordability/dimensions/derive.ts
```

That is a concurrent workstream saving a file my dev server happened to be watching — the
file's mtime is exactly 10:41:17 and it carries a foreign `git status` diff. I never touched
`packages/shared`. It is a source-edit HMR reload, not `optimized dependencies changed`.

### 5. Dev module topology unchanged; ORT inlined; zero bare specifiers — MET (also X3's live confirmation)

The worker's rewritten import, read straight out of the served dev module:

- marketing: `from "/node_modules/.vite/deps/kokoro-js.js?v=f84ce426"`
- web: `/node_modules/.vite/deps/kokoro-js.js?v=7a3b3ef6`

Prebundle content, identical on both apps (`deps/kokoro-js.js`, 4,218,286 bytes on disk):

- static import/export specifiers: exactly one, `./chunk-XkmBru0b.js`; **bare specifiers: 0**
- contains `onnxruntime-common`, `InferenceSession`, `class Tensor`, `ort-wasm` — ORT is
  inlined into the single prebundle
- no second onnx chunk: `ls deps | grep -iE 'onnx|transformers|^ort'` returns nothing, and
  the one sibling chunk (`chunk-XkmBru0b.js`, 1,847 bytes) contains no `onnxruntime`
  reference at all

So X3's end state holds for the dev optimizer under the new resolution path: one ORT copy,
inlined, no split, no bare specifier reaching outside the prebundle. The 4,218,286-byte
figure also matches §X3's re-baselined measurement exactly.

### 6. Web's cold-start dep cache ≈101 MB + ~9.5 MB, not ≈11 MB — MET

Before: 101 MB cold (65 deps). After: **110 MB cold** (66 deps), measured before any request.
The order-of-magnitude collapse that a dropped `**/*.html` would cause did not happen — the
cache is the full app prebundle plus the ~9 MB kokoro-js/ORT chunk, and the dep count went
65 → 66 rather than collapsing to the worker's own subtree.

### 7. Production untouched; `verify:web-bundle` passes unchanged — MET

`optimizeDeps` is dev-only (it governs the dev prebundle in `node_modules/.vite/deps`; no
production artifact reads it), so no rebuild was needed. `npx tsx scripts/verify-web-bundle.ts`
→ `Verified /workspace/…/apps/web/dist`, exit 0. `apps/web/dist` is byte-identical to before
the change — nothing in this task writes to it.

### 8. Stale worker-format comment corrected — MET

Old text (`packages/ui/src/components/accessibility/lib/tts.worker.ts`, the tail of the
kokoro-js paragraph):

```
// via vi.mock(). Static import also lets Vite bundle the worker as a
// single IIFE chunk — dynamic imports inside a worker would require
// `worker.format: 'es'` config, which we're avoiding.
```

New text:

```
// via vi.mock(). The worker is built as an ES module, which the repo
// requires rather than avoids (WORKER_BUILD_OPTIONS in the shared build
// config): the classic-worker wrapper corrupts `new.target`, which the
// transformers dependency loaded here needs intact.
//
// This file's path is also named as a dependency-scan entry by both app
// build configs, because the dev scanner cannot see through the worker's
// `new URL` construction and would otherwise discover kokoro-js only on the
// first TTS click.
```

Grounding: `scripts/lib/ort-assets-plugin.ts:87` — `export const WORKER_BUILD_OPTIONS =
{ format: 'es' } as const;` — imported and applied as `worker:` by
`apps/web/vite.config.ts` and `apps/marketing/astro.config.mjs`; its own doc comment states
the `new.target` corruption that makes `es` load-bearing.

## Deviations

1. **A second paragraph was added to the criterion-8 comment**, recording that this file's
   path is named as a scan entry by both app configs. Criterion 8 asks only for the stale
   sentence to be corrected. The addition is a durable hidden-coupling fact created by this
   task (an external constant now anchors on this file's path); the throw in
   `resolveTtsWorkerSource` is the enforcement, the comment is the explanation.
2. **`@hushbox/marketing` was linted and typechecked** although §X4's scoped checks name
   only scripts / web / ui. I edited `astro.config.mjs`, so leaving its package ungated
   would have been a hole.
3. **Dev servers were run on non-standard ports** (4399 / 5399 instead of 4321 / 5173) so a
   concurrent workstream starting `pnpm dev` could not collide with or contaminate the
   measurement. No config change; env vars on the command only.

## Concerns and limitations

- The GREEN evidence is HTTP-level, not browser-level: I fetched the worker's dev URL
  directly rather than clicking Listen in a real browser. That exercises the exact module
  transform that provoked the RED reload (verified: the same fetch produced the reload lines
  before the change and produces none after), but it does not exercise the full click path.
- The `@hushbox/scripts` test gate remains RED for the two documented foreign files; nothing
  in this task can turn it green, and `pnpm lint:unused` is likewise RED for two foreign
  findings.
- Cold-cache sizes are environment-specific (they include every dep this checkout currently
  resolves). The load-bearing part of criterion 6 is the ratio, not the literal MB: 110 MB
  with 66 deps versus a collapsed cache with a handful.
- `apps/*/node_modules/.vite/deps` was cleared four times during this task. Any concurrent
  run that read those caches in that window may show transient failures; that is the cost
  §X4 anticipated for driving dev servers.

## Confidence

**High.** Every criterion has a direct measurement, the RED direction was observed on both
apps before any code changed, and the one anomalous log line in the GREEN evidence is
attributed to a concurrent workstream by file identity and matching mtime rather than
waved away.
