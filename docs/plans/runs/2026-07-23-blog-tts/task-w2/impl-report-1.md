# W2 — Fix: emit workers as ES modules

## Objective

Stop feeding rolldown an iife worker so `new.target` survives the build, restoring blog
Listen and chat read-aloud on every built site. One shared constant, both apps.

## Files changed

- `scripts/lib/ort-assets-plugin.ts` — new exported `WORKER_BUILD_OPTIONS = { format: 'es' } as const`,
  with the durable explanation of why the format is load-bearing. This module is the build-config
  seam both app configs already import from.
- `apps/web/vite.config.ts` — imports `WORKER_BUILD_OPTIONS`, sets `worker: WORKER_BUILD_OPTIONS`.
- `apps/marketing/astro.config.mjs` — same, under `vite:`.
- `packages/ui/src/components/accessibility/lib/tts-engine.ts` — comment only; the stale claim that
  `type: 'module'` prevents an iife build is replaced with the real constraint.

Both import sites reference the one constant; the string `'es'` appears exactly once in the repo's
build config.

## Tests added

None. This is a build-output fix; its test is the guard that already exists in
`scripts/verify-web-bundle.ts` (`checkWorkerMetaProperty`), which was written for this defect and was
RED against the shipping dists before the change. No new production code path was introduced, so
there is no new unit to cover; `WORKER_BUILD_OPTIONS` is a module-level const executed on import by
every existing consumer of the seam module.

## Self-gate

- `turbo typecheck lint --filter=@hushbox/web --filter=@hushbox/marketing --filter=@hushbox/scripts --filter=@hushbox/ui --force --continue`
  — **pass**, 8/8 tasks successful. (Run after the last source edit, per-package.)
- `vitest run verify-web-bundle` (from `scripts/`) — **pass**, 1 file / 26 tests.
- `turbo test --filter=@hushbox/scripts --force` — **fail (3 files, 1 test)**, all three ambient and
  attributed out (none touch anything this task changed):
  - `generate-env.test.ts > generates for loop with all backend secret keys` — VAPID key drift
    (`VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY NOTIFICATION_TAG_SECRET` present in the generated workflow,
    absent from the expected string). Known ambient red.
  - `refresh-catalog-run.test.ts` (0 tests) and `seed-run.test.ts` (0 tests) — collection errors,
    `Cannot find module scripts/node_modules/.vite/vitest/…/deps_ssr/@hushbox_db.js&v=ce1e6bc1`.
    Stale `.vite` artifacts. Known ambient red.
  - Totals: 87 passed / 3 failed files; 1851 passed / 1 failed tests.
- `knip --no-progress` — only the ambient entries (`packages/config/vitest.package.config.ts` unused
  file; `wrangler`/`apps/sandbox` ignoreDependencies hint). No new unused-export red for
  `WORKER_BUILD_OPTIONS`, i.e. knip sees both config import sites.
- `vitest run tts-engine` (from `packages/ui/`) — **pass**, 63 tests (comment-only change, run for safety).

## Acceptance criteria

### (1) `worker: { format: 'es' }` for both apps, from ONE shared constant

Met. `scripts/lib/ort-assets-plugin.ts` exports:

```ts
export const WORKER_BUILD_OPTIONS = { format: 'es' } as const;
```

Import sites: `apps/web/vite.config.ts` (`worker: WORKER_BUILD_OPTIONS,` beside `resolve:`) and
`apps/marketing/astro.config.mjs` (same, inside the `vite:` block). No literal `'es'` at either site.

### (2) Rebuilt workers contain `new.target.prototype` and no import-meta rewrite

Met. Rebuilt both apps with `turbo build --filter=@hushbox/web --filter=@hushbox/marketing --force`,
then `merge-marketing-into-web.ts`.

Before (shipping dists, both chunks, minified):

```
var df={url:self.location.href}
setPrototypeOf(e,df.prototype)
new.target occurrences: 0
```

After:

```
apps/web/dist/assets/tts.worker-BkxknLwy.js       new.target occurrences: 1
  setPrototypeOf(e,new.target.prototype)
  import.meta stand-in declarations: (none)
apps/marketing/dist/_astro/tts.worker-JIMVfSq8.js new.target occurrences: 1
  setPrototypeOf(e,new.target.prototype)
  import.meta stand-in declarations: (none)
```

The `{url:self.location.href}` stand-in is gone from both chunks entirely.

### (3) The guard flips RED → GREEN

Met. Same invocation (`collectWebBundleViolations`) against the same two dist roots.

**Before** (the dists as they stood at task start — the bytes CI would have deployed):

```
=== apps/web/dist: 2 violation(s)
  - built TTS worker reads `df.prototype` off the bundler's import.meta stand-in: _astro/tts.worker-Cnlg9VbG.js — the iife worker transform rewrote `new.target` as `import.meta`, so every worker throws "Object prototype may only be an Object or null: undefined" on load
  - built TTS worker reads `df.prototype` off the bundler's import.meta stand-in: assets/tts.worker-C2pJhHz0.js — the iife worker transform rewrote `new.target` as `import.meta`, so every worker throws "Object prototype may only be an Object or null: undefined" on load
=== apps/marketing/dist: 1 violation(s)
  - built TTS worker reads `df.prototype` off the bundler's import.meta stand-in: _astro/tts.worker-Cnlg9VbG.js — the iife worker transform rewrote `new.target` as `import.meta`, so every worker throws "Object prototype may only be an Object or null: undefined" on load
```

**After** (rebuilt + merged):

```
=== apps/web/dist: 0 violation(s)
=== apps/marketing/dist: 0 violation(s)
```

No new violation class appeared: the same run also covers the self-hosted-runtime sha256 check, the
stray-copy check, the bundled-reference check, the ORT-version check, and the Pages limits — all
silent.

### (4) The built site actually works — manual browser verification

Met. Served the merged shipping bundle: `vite preview --port 4399` on `apps/web/dist`, with
`_headers` regenerated first (`merge-marketing-into-web.ts` then `generate-headers.ts`), so the
`headersPlugin` enforced the real generated production CSP. Verified on the wire:

```
$ curl -sI http://localhost:4399/blog/youre-probably-overpaying-for-ai/
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://secure.myhelcim.com 'sha256-…' …; connect-src 'self' http://localhost:8788 … https://huggingface.co https://*.hf.co …
```

Opened a real blog post (`/blog/youre-probably-overpaying-for-ai/`) in Chromium and clicked
`button[aria-label="Listen to this post"]`.

**Observed, cold (Cache API `transformers-cache` + `kokoro-voices` deleted, page reloaded):**

- 4 workers created, each `new Worker("http://localhost:4399/_astro/tts.worker-JIMVfSq8.js", {"type":"module"})`.
- The model was really fetched over the network under the enforced CSP — `huggingface.co` 307 →
  `huggingface.co/api/resolve-cache/…` 200 for `config.json` / `tokenizer.json` /
  `tokenizer_config.json`; `huggingface.co/…/onnx/model_quantized.onnx` 302 →
  `us.aws.cdn.hf.co/xet-bridge-us/…` **200**; `voices/af_heart.bin` 302 → `us.aws.cdn.hf.co` **200**.
  No CSP violation on any of them.
- Worker protocol, captured by wrapping `window.Worker` before the click:
  `created ×4` → `loadDone ×4` → `warmupDone` → `workerReady`. **Zero `loadError`, zero worker
  `error` events.**
- The control reached `aria-label="Pause"` / text `Pause` (rendered with the Lucide pause icon), and
  `CSS.highlights` carried the live `tts-reading` registration — i.e. it was reading, not merely
  loaded.
- The status never showed `Couldn't start playback. Try again.`
- Console contained no `Object prototype may only be an Object or null` error. The only console
  errors were two pre-existing and unrelated ones: `ERR_CONNECTION_REFUSED` on
  `localhost:8788/announcements/banner` (API not running locally) and a CSP block on
  `localhost:7200/api/crawl` (the crawler-view dev probe; not allowlisted, expected). The only
  warnings were four ORT `Unable to determine content-length from response headers` notices from the
  worker itself — benign, one per worker.

A warm run (model already in Cache API) was done first and behaved identically: `loadDone ×4`,
`warmupDone`, `workerReady`, control at `Pause`, worker chunk and `/ort/` assets all 200.

The old bytes produced `WK1 loadError  Object prototype may only be an Object or null: undefined`
3/3 clicks. This build produced it 0/2 clicks, warm and cold.

### (5) Code-splitting / chunk resolution / `/ort/` assets

Met, and ES format did **not** split the worker.

- Chunks emitted: exactly one worker chunk per app build — `apps/web/dist/assets/tts.worker-BkxknLwy.js`
  (2,276,340 B) and `apps/marketing/dist/_astro/tts.worker-JIMVfSq8.js` (2,276,673 B); the merge copies
  marketing's into `apps/web/dist/_astro/`. Same count and same shape as the iife build (2 chunks in
  the merged web dist, 1 in marketing).
- The worker chunk has **no static imports at all** (it opens directly with the bundle preamble
  `var e=Object.create,t=Object.defineProperty,…`), so there are no sibling chunks to resolve. Its
  only dynamic import is the pre-existing `import(e)` that loads the self-hosted ORT runtime.
- All resolve at runtime: `/_astro/tts.worker-JIMVfSq8.js` 200 (×4, one per worker),
  `/ort/ort-wasm-simd-threaded.jsep.mjs` 200 (×4), `/ort/ort-wasm-simd-threaded.jsep.wasm` 200 (×4).
- `dist/ort/` sha256 unchanged in **both** dists:
  `c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39` (wasm) /
  `08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9` (mjs).
- No `ort-wasm*` copy anywhere outside `dist/ort/`. Shipped ORT version site still
  `` versions:{common:`1.22.0-dev.20250409-89f8206ba4` ``.
- Pages limits fine: 1012 files in the merged dist; largest file is the ORT wasm at 21,596,019 B
  (cap 26,214,400).

### (6) Loads under the generated production CSP

Met, and verified live rather than by reading the policy (see criterion 4 — the CSP header above was
served and enforced by `headersPlugin` on every response).

Mechanically, nothing about the fetch changed. `generate-headers.ts` emits no `worker-src` and no
`child-src`, so worker creation falls back to `default-src 'self'`. The referencing chunk still
builds a plain same-origin URL:

```js
function l(){return new Worker(new URL(`/_astro/tts.worker-JIMVfSq8.js`,``+import.meta.url),{type:`module`})}
```

No `blob:` worker, no cross-origin fetch, and — because the chunk has no static imports — no
additional module fetches from inside the worker that `script-src` would have to admit. The one
thing an ES worker could have broken (sibling-chunk fetches) does not arise here.

### (7) Stale comment corrected

Met. `tts-engine.ts` previously read: "`type: 'module'` matches the worker's ES module source —
Vite's default `iife` format would break the static kokoro-js import at the top of tts.worker.ts."
That gave false assurance: the build emitted iife regardless of the flag, and the static import was
fine — it was `new.target` that was corrupted. It now records that `type: 'module'` governs how the
browser loads the chunk and not the format it is built in, that the format comes from the apps'
`worker.format` and must stay `es`, and points at the shared constant for the mechanism. No plan or
task identifiers, no run-directory citation, in either the comment or the constant's doc block.

### (8) Chat read-aloud equally fixed — with evidence

Met.

- The `apps/web` build emits the same worker source as its own chunk,
  `apps/web/dist/assets/tts.worker-BkxknLwy.js`. That chunk contains `setPrototypeOf(e,new.target.prototype)`
  and no import-meta stand-in (criterion 2), and the guard passes on `apps/web/dist` (criterion 3).
- Runtime proof, not assertion: on a web-SPA route of the same preview server (`/login`, so the same
  enforced CSP), instantiated that exact chunk the way the engine does and drove the real protocol:

  ```js
  const w = new Worker('/assets/tts.worker-BkxknLwy.js', { type: 'module' });
  w.postMessage({ type: 'load', requestId: 'probe-1' });
  // → [{ ev: 'msg', type: 'loadDone' }]   (no loadError, no worker error event)
  ```

  `loadDone` is precisely the message the corrupted build could never reach: the TypeError fired on
  the load path, inside `load`, before any `loadDone`.
- Chat's engine is the same `getTtsService()` / `defaultWorkerFactory()` in `tts-engine.ts` and the
  same `tts.worker.ts` source, so the chunk being loadable is the whole of the fix for chat.

Limitation, stated plainly: I could not click read-aloud inside a real chat because this locally
built SPA cannot boot (`%VITE_SANDBOX_ORIGIN_URL%` is unsubstituted and the platform env fails Zod —
a `--target=prod` build without the inline production `VITE_*`, plus no API running). That is an
environment limitation of the local build, unrelated to this change; the worker-level proof above is
what stands in for it.

## Deviations

None from the acceptance criteria.

One choice worth naming: the shared constant is the whole worker-options object
(`WORKER_BUILD_OPTIONS`) rather than the bare format string, so the two configs cannot drift by one
app growing a second worker option the other lacks.

## Concerns and limitations

- **A pre-existing working-tree change appears inside my diff and is not mine.** `git diff` on
  `apps/web/vite.config.ts`, `apps/marketing/astro.config.mjs`, and `scripts/lib/ort-assets-plugin.ts`
  also shows the removal of `KOKORO_ORT_COMMON_INCLUDE` and both `optimizeDeps.include` blocks. That
  removal was already in the working tree before my first edit. Checkable proof rather than
  testimony: my edits to the two configs matched the **single-line** import
  `import { ORT_EXTERN_WASM_CONDITION, ortAssetsPlugin } from …`. Had `KOKORO_ORT_COMMON_INCLUDE`
  still been imported, that string would not have existed (the import was the 4-line form) and the
  edits would have failed rather than applied. My edit to the seam module anchored on the
  `ORT_EXTERN_WASM_CONDITION` line and only appended after it, so it could not have deleted anything.
  Both configs were already listed as modified by `git status --porcelain` before I touched them.
- **The verifier still does not run on the artifact CI deploys.** This is the previously accepted
  divergence, unchanged by this task, but it is what decides whether the guard actually protects the
  next deploy: the fix is in the config, so any build gets it, but the guard only fires where
  `buildWebBundle` runs.
- **No negative control on the browser probe.** I could not re-run the probe against a corrupted
  chunk, because the rebuild overwrote the old dists. The RED evidence is the guard output quoted
  above plus the previously recorded 3/3 failures; the probe's discriminating power rests on
  `loadDone` being unreachable past the TypeError, which is reasoning, not a re-observed failure.
- **Bundle size.** The ES worker chunk is ~2.28 MB; I have no byte-for-byte "before" figure (the old
  chunks were overwritten by the rebuild), so I cannot report the delta. Pages limits are clear with
  large margin either way.
- **Everything I started is stopped.** The `vite preview` on port 4399 was killed and confirmed down;
  the browser page was closed. Port 5399 was never touched. Both dists are now rebuilt on disk —
  that is a change to untracked build output, not repo content.

## Confidence

**High.** The failure mode was reproduced as a build-artifact assertion, the assertion flipped
RED → GREEN across the change on both dists, the corrected bytes were read directly, and the built
site was driven end to end in a real browser under the enforced production CSP with a genuine cold
model download and no `loadError`. The only piece not directly exercised is chat's UI, and its worker
chunk was proven loadable at the exact step that used to throw.
