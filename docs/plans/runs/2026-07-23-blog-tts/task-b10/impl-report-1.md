# B10 — Fail-fast guard for the phantom `onnxruntime-common` dependency

## Objective

Stop Vite's dep optimizer from silently externalizing `onnxruntime-common` and caching the
broken result; make an unresolvable state surface loudly instead of as a poisoned prebundle.

## Files changed

- `scripts/lib/ort-assets-plugin.ts` — adds the single exported `KOKORO_ORT_COMMON_INCLUDE`
  constant beside `ORT_EXTERN_WASM_CONDITION`, with the durable-mechanism doc comment.
- `apps/web/vite.config.ts` — imports the constant; adds `optimizeDeps.include` beside the
  existing `resolve:` block.
- `apps/marketing/astro.config.mjs` — same two edits inside its `vite: {}` block.

No other file was edited. `apps/admin/vite.config.ts` was deliberately left alone (criterion 7).

## Deviation from the planned literal — the plan's value does not work

**The plan pinned `['kokoro-js > onnxruntime-common']`. Verified: that entry resolves nowhere
in this repo and is silently dropped.** Vite resolves an include chain segment by segment, the
first segment from the app itself. Under pnpm's isolated layout neither app can resolve
`kokoro-js` — it belongs to `packages/ui`:

```
apps/marketing kokoro-js -> FAIL MODULE_NOT_FOUND
apps/web       kokoro-js -> FAIL MODULE_NOT_FOUND
apps/marketing @hushbox/ui -> /…/packages/ui/src/index.ts
```

Observed with the planned literal in place (marketing, first run of this task):

```
12:34:59 [WARN] [vite] Failed to resolve dependency: kokoro-js > onnxruntime-common,
                       present in client 'optimizeDeps.include'
```

No `___onnxruntime-common` prebundle was emitted — the entry was a permanent false-positive
warning on every dev start with zero effect, which is worse than nothing (it trains readers
to ignore the exact warning that is supposed to be the guard).

**Shipped value: `['@hushbox/ui > kokoro-js > onnxruntime-common']`.** Every segment resolves
(`@hushbox/ui` from the app, `kokoro-js` from the UI package, `onnxruntime-common` from
kokoro's own dir, which reaches the hoist dir). The plan's stated mechanism is unchanged and
correct — only its root anchor was wrong.

## Acceptance criteria

### (1) Single exported constant, literal exactly once — MET

`scripts/lib/ort-assets-plugin.ts:100`. Import sites: `apps/web/vite.config.ts:12` (used at
`:261`), `apps/marketing/astro.config.mjs:11` (used at `:69`). Repo-wide grep for the literal
returns one code hit; the only other hits are this run's own `plan.md` and
`research/dev-resolution-break.md`, which are run records, not code.

### (2) Doc comment states the durable mechanism — MET

Verbatim, `scripts/lib/ort-assets-plugin.ts:62-99`:

```
/**
 * `optimizeDeps.include` entries for the TTS worker's kokoro-js chain, written
 * in Vite's nested-dependency notation so the inner specifier is resolved from
 * kokoro-js's own directory rather than the app's.
 *
 * The chain starts at `@hushbox/ui` because every segment is resolved from the
 * previous one and the first from the app itself: under pnpm's isolated layout
 * neither app can resolve `kokoro-js` (it belongs to the UI package), so a
 * chain rooted there resolves nowhere and Vite drops the entry.
 *
 * `@huggingface/transformers` (reached through kokoro-js) imports
 * `onnxruntime-common` as a bare specifier without declaring it — a phantom
 * dependency, resolvable only through pnpm's hoist dir. That dir is on the
 * node-resolution walk from a file inside `.pnpm/…`, but not from the physical
 * copy the dep optimizer writes into an app's `node_modules/.vite/deps`, so an
 * optimizer anchored there cannot resolve it. It then externalizes the
 * unresolvable import silently — no error, no warning; the prebundle simply
 * keeps a bare `onnxruntime-common` specifier the browser then fails to load —
 * and reuses that output forever, because a later optimize with an unchanged
 * cache key reports a consistent hash and skips. A prebundle poisoned in the
 * window between a lockfile write and a hoist-link creation therefore survives
 * every restart, and the resulting import error names neither the cause nor the
 * cache. Listing the dependency pins it to an anchor that can resolve it and
 * gives it its own prebundle, which the kokoro-js prebundle then links against
 * instead of inlining a private copy — so both hold the same ORT module and
 * `instanceof Tensor` keeps working across the boundary. When the chain does
 * break, the Astro dev server names the failing entry at start ("Failed to
 * resolve dependency: … present in client 'optimizeDeps.include'"); the Vite
 * dev server drops it without a message, so the entry is a guard there only in
 * the structural sense.
 *
 * Dev-only: production is unaffected because Rollup resolves against the real
 * importer file, which always sits inside `.pnpm/…`.
 *
 * Applied via `optimizeDeps.include` in `apps/web/vite.config.ts` and
 * `apps/marketing/astro.config.mjs` — both import it from here rather than
 * repeating the literal.
 */
```

No plan or task identifiers; no citation of anything under `docs/plans/runs/`.

### (3) Dev verified working on BOTH servers — MET

Both `.vite/deps` dirs deleted first, so both optimizes were cold. Marketing served on 4321
(`astro dev`), web on 5173 (`vite`). Both reached ready with **zero** `Failed to resolve
dependency` lines. The TTS worker module was requested directly (the blog island is
`client:visible`, so scrolling was not relied on):

`GET /@fs/…/packages/ui/src/components/accessibility/lib/tts.worker.ts` → **200** on both.

Resulting prebundles, byte-identical across the two apps:

| app | `kokoro-js.js` | bare `onnxruntime-common` specifiers |
|---|---|---|
| marketing | 4,179,762 | **0** |
| web | 4,179,762 | **0** |

(`kokoro-js.js` served over HTTP on web: 200, 4,179,928 — the extra bytes are the appended
sourcemap comment.)

### (4) One ORT instance in dev — MET

Identical on both apps. The nested prebundle is a 260-byte re-export:

```
// @hushbox_ui___kokoro-js___onnxruntime-common.js  (complete file)
import { a as TRACE_FUNC_END, c as registerBackend, i as TRACE_FUNC_BEGIN,
         n as InferenceSession, o as Tensor, r as TRACE, s as env } from "./esm-CfaH975S.js";
export { InferenceSession, TRACE, TRACE_FUNC_BEGIN, TRACE_FUNC_END, Tensor, env, registerBackend };
```

and `kokoro-js.js` imports `from "./chunk-XkmBru0b.js"` and `from "./esm-CfaH975S.js"` — the
**same** `esm-CfaH975S.js` the nested chunk re-exports from. One ORT module object, so
`instanceof Tensor` holds across the boundary.

Note the include changes the topology for the better: without it the optimizer inlines a
private ORT copy into `kokoro-js.js` (4,218,178 bytes, only `chunk-XkmBru0b.js` imported);
with it, ORT moves to the shared `esm-` chunk (4,179,762) that both entries link against.

### (5) Fail-fast — PARTIALLY MET (Astro yes, Vite no)

Temporarily set the constant to `['@hushbox/ui > kokoro-js > onnxruntime-nonexistent']`, cold
deps, restarted each server.

**Marketing (`astro dev`) — names the failing entry at start:**

```
12:49:59 [WARN] [vite] Failed to resolve dependency: @hushbox/ui > kokoro-js > onnxruntime-nonexistent,
                       present in client 'optimizeDeps.include'
```

**Web (`vite`) — silent.** No such line anywhere in a 55 KB startup+request log (grep for
`failed to resolve` / `onnxruntime-nonexistent` / `optimizeDeps.include`: zero hits), across
the initial optimize, an `index.html` request, and a worker-module request that did trigger
`✨ new dependencies optimized: kokoro-js`. The unresolvable entry is dropped without a word,
and `kokoro-js.js` came out at 4,218,178 with ORT inlined and 0 bare specifiers.

Two further data points bounding the behavior:

- It is not "nested segments are silent": Astro warned for a bad **nested** segment, and also
  for a bad **root** segment. The split is Astro vs. plain Vite, not root vs. nested.
- The warning is a **WARN, never fatal** — both servers reached "ready" and served requests.
  The brief's expected string is exactly right; only "fails AT START" is not.

Reverted to `['@hushbox/ui > kokoro-js > onnxruntime-common']` and re-ran both servers cold —
criteria 3 and 4 re-verified in that final state (numbers above are from the final run).

### (6) Shipped bytes unchanged — MET

`npx tsx scripts/with-env.ts npx tsx scripts/build-web-bundle.ts --target=prod`, run at
**12:57 on 2026-07-25**, exit 0. Turbo reported `2 successful, 2 total / 0 cached` — a real
rebuild of both apps, not a cache replay (my config edit is a build input, so the hash moved).
The script's `verifyWebBundle` step runs between the merge and `generate-headers`; it throws
on any failed assertion, and `_headers` was written and the process exited 0, so the
assertions passed.

```
08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9  apps/web/dist/ort/ort-wasm-simd-threaded.jsep.mjs
c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39  apps/web/dist/ort/ort-wasm-simd-threaded.jsep.wasm
```

Both match the pinned values. (Pre-build hashes taken from the 02:24 dist matched too, so the
bytes are stable across the change in both directions.) Concurrency caveat: another workstream
is active; the dist timestamps read 12:57, matching my build.

### (7) `apps/admin` — decision: NO entry needed. Reported, not added.

Evidence:

- Admin's module graph **does** statically reach the engine: `apps/admin/src/routes/__root.tsx:3`
  imports from the `@hushbox/ui/accessibility` barrel, whose `index.ts` also exports
  `AccessibilityPanel` → `sections/audio.tsx` → `lib/tts-engine.ts`. Dev has no tree-shaking,
  so the browser loads all of it. Confirmed live: admin served the barrel and `tts-engine.ts`
  at 200.
- Admin **never mounts** the TTS UI: `grep AccessibilityWidget|AccessibilityPanel|getTtsService|AudioSection`
  over `apps/admin/src` returns nothing. `__root.tsx` uses only `A11yProvider` and
  `MotionProvider`.
- kokoro-js enters only through `new Worker(new URL('tts.worker.ts', …))` in `tts-engine.ts`,
  a runtime call. Nothing in admin calls it, and Vite's scan does not follow the worker entry
  eagerly (on web and marketing, kokoro was optimized only after I requested the worker
  module — never at startup).
- Live proof: admin dev server started with a cold deps dir, `index.html` + a11y barrel +
  `tts-engine.ts` all fetched → **no kokoro or onnxruntime entry in `apps/admin/node_modules/.vite/deps`**.

The exposure is latent, not present: forcing the worker module by URL *did* produce a
`kokoro-js.js` (4,286,261 bytes, 0 bare specifiers — resolution is healthy there too on a
clean cache).

Not adding it because the include alone would be a misleading half-guard: admin also lacks
`resolve.conditions: [ORT_EXTERN_WASM_CONDITION]` and `ortAssetsPlugin()`, so if admin ever
mounted the panel it would ship a bundled ~21 MB ORT copy and have no same-origin wasm to load
under its CSP. That is a deliberate feature change, not a guard line. **Re-entry condition:
add all three the moment `apps/admin` mounts `AccessibilityWidget`/`AccessibilityPanel` or
otherwise calls `getTtsService()`.**

## Self-gate

| command | result |
|---|---|
| `turbo typecheck lint --filter=@hushbox/web --filter=@hushbox/marketing --filter=@hushbox/scripts --force --continue` | **pass** — 6 successful, 6 total, 0 cached |
| `vitest run lib/ort-assets-plugin.test.ts verify-web-bundle.test.ts` (from `scripts/`) | **pass** — 2 files, 33 tests |
| `eslint lib/ort-assets-plugin.ts` (from `scripts/`, after the final edit) | **pass** — exit 0, no output |
| `build-web-bundle.ts --target=prod` (incl. `verifyWebBundle`) | **pass** — exit 0 |

Marketing's typecheck emits pre-existing warnings unrelated to this change (`'Props' declared
but never used` in `PillarCard.astro`, rolldown `jsx` input-option warning, an
`optimizeDeps.rollupOptions` deprecation notice raised by a plugin, not by this config).

## TDD note

No unit test was added. The constant is a value, not logic; its sibling
`ORT_EXTERN_WASM_CONDITION` has no test either, and a test asserting the literal would create
the second repo-wide occurrence criterion 1 forbids. The behavior this task exists for is only
observable in a running dev server, and criteria 3–5 are that test, executed by hand:
red (planned literal → unresolved, no nested chunk; deliberate bad segment → named warning),
green (final value → resolved, shared ORT chunk, zero bare specifiers), on both apps.

## Concerns and limitations

1. **The guard is one-sided.** On `apps/web` (plain rolldown-vite) a broken chain is dropped
   in total silence. The loud failure exists only on marketing (Astro) — which is, at least,
   the surface where the bug actually bit. Anyone relying on this guard for the web app is
   relying on the structural effect, not on an error message.
2. **The guard is a WARN, not a hard stop**, even on Astro. A dev server with a broken chain
   still starts and still serves; the line scrolls past among other startup warnings.
3. **The residual risk from the research doc is unchanged**: `pnpm install` while a dev server
   is up can still re-poison a cache. This change makes the poisoned state louder on marketing
   and structurally less likely (ORT is anchored at a resolvable location and shared), but the
   cure is still to delete `.vite/deps`.
4. I could not simulate the true poisoning window (missing hoist link) without mutating
   `node_modules`, which is out of bounds and would have disturbed the concurrent workstream.
   The fail-fast evidence is therefore from a synthetic unresolvable package name, per the
   brief.

## Environment notes (attributed, not fixed)

- Another workstream is active: a `vitest run --coverage --maxWorkers=24` and a long-lived
  `vite --port 5399` (50+ min uptime, still alive and untouched at the end of my work).
- `.env.development` was rewritten by that workstream mid-run; both my dev servers logged
  `.env.development changed, restarting server`. It did not affect any result — every
  measurement above was re-taken in the final clean state.
- Cache dirs: `apps/web` and `apps/marketing` `.vite/deps` were deleted and regenerated
  several times (Vite cache, rewritten by design). `apps/admin/node_modules/.vite/deps` was
  deleted at the end to remove the kokoro prebundle my criterion-7 probe forced into it; Vite
  recreates it on next start.
- All dev servers I started were stopped; ports 4321, 5173 and 7000 are free.

## Confidence

**High** on criteria 1, 2, 3, 4, 6, 7 — each rests on directly observed output (byte counts,
file contents, sha256, live HTTP responses), and the key results were reproduced on both apps.

**High** on the criterion-5 finding itself, **but the criterion is not met as written** — the
fail-fast is real only on Astro and is a warning rather than a startup failure. That is a
property of rolldown-vite, not something the config can fix; it needs an orchestrator ruling
on whether the guard is still worth its keep on `apps/web`.
