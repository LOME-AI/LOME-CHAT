# First-click reload — and the production bug found while proving it

Analyst, 2026-07-25 (written up by the orchestrator; the analyst has no write tools).

## Verdict on the reload: DEV-ONLY, proven

Vite's dep optimizer discovers `kokoro-js` on the first worker fetch, prebundles it, and broadcasts a full reload.

Dev, cold cache — server log, verbatim:
```
22:40:33 [vite] ✨ new dependencies optimized: kokoro-js
22:40:33 [vite] ✨ optimized dependencies changed. reloading
```
Real Chromium at the same moment: 4 workers created at t+0, `"Preparing the voice 0%"` at t+1s, **all four workers closed and the document replaced at t+2.5s**, control back to "Listen". Second click works (speech at ~7s). Warm cache: no reload at all.

Production build (`astro preview` on the real dist), three consecutive clicks: `loads=1` throughout, marker never lost, no navigation. **There is no dep optimizer and no HMR client in a built site, so the reload is structurally impossible in production.**

## THE HEADLINE: production TTS is completely broken (pre-existing, not from this run)

On the built site, Listen **never works**. Every click ends in "Couldn't start playback. Try again."

```
WK1 loadError  Object prototype may only be an Object or null: undefined   (x3, 3/3 clicks)
state: {"btn":"Listen","status":"Couldn't start playback. Try again."}
```

**Root cause, traced to the byte:**
1. `@huggingface/transformers@3.8.1` `src/utils/generic.js:22` — the `Callable` base class every tokenizer/processor extends does `return Object.setPrototypeOf(closure, new.target.prototype)`.
2. The built worker contains `Object.setPrototypeOf(closure, _vite_importMeta.prototype)` (web: `dist/assets/tts.worker-CcCuWCez.js`; marketing minified: `Object.setPrototypeOf(e,df.prototype)` where `var df={url:self.location.href}`). `_vite_importMeta.prototype` is `undefined` ⇒ the exact observed TypeError, on the load path, in every worker.
3. **Minimal independent repro** on the lockfile-pinned rolldown-vite 7.3.1, two-file scratch project, `minify:false`:
   - input: `Object.setPrototypeOf(closure, new.target.prototype)`
   - default (worker format `iife`): rewritten to `_vite_importMeta.prototype`
   - with `worker: { format: 'es' }`: **preserved**
   - the rewrite fires even when the worker source contains no `import.meta` at all — the trigger is `new.target` itself. Both are `MetaProperty` AST nodes; rolldown's iife-worker transform rewrites the wrong one.

Dev serves the worker as a native ES module and never applies the transform, which is why dev works and every production build is dead. **This affects both the blog Listen island and chat/accessibility read-aloud — one worker, one chunk, both apps' builds.**

**Why nothing caught it:** `tts-engine.ts:114` is the only `new Worker(...)` in the repo and unit tests inject a fake factory (`_setWorkerFactoryForTesting`), so no test ever runs the built worker. E2E does serve the built merged bundle, but no E2E clicks Listen.

## User-visible consequence
- **Production, today:** first Listen ever → ~0.5s later "Couldn't start playback. Try again.", no audio, forever, every browser, every post. Same for chat read-aloud. The 92 MB model is partially fetched each time before failing.
- **Dev, cold cache:** one wasted click per dep-cache generation; zero user impact.
- **Secondary, both environments:** a click landing before the island hydrates does nothing at all (server-rendered `client:visible` button is inert until hydration; measured 151ms–1.6s). An independent second way to experience "I had to click twice".

## Options — the production bug
- **A (recommended): `worker: { format: 'es' }` in both `apps/marketing/astro.config.mjs` and `apps/web/vite.config.ts`**, hoisted to the existing shared seam so it stays one implementation. Removes the cause for our code. The worker is already constructed `{ type: 'module' }` and is the repo's only `new Worker`, so blast radius is one chunk. Must re-verify after rebuild: ES-format workers may code-split, so confirm emitted chunks and `/ort/` assets still resolve under the generated production CSP.
- **B: patch transformers to avoid `new.target`** — masks a bundler defect inside a vendor file; the next dependency using `new.target` breaks identically. Rejected.
- **C: drop the workspace-wide `rolldown-vite` override** — removes the whole bug class but is a TECH-STACK reversal needing founder approval; disproportionate while A holds. Rejected for now; becomes the honest answer if A breaks CSP or ORT asset emission.
- **D (pairs with A, not an alternative): detection.** (1) An E2E on the built site clicking Listen and asserting the reader reaches `speaking` — note it downloads ~92 MB. (2) Cheap and deterministic: assert the emitted `tts.worker-*.js` contains no `_vite_importMeta.prototype` rewrite. Red today against both dists.

## Options — the dev reload
- **E (recommended): accept and document.** Provably impossible in production, self-clears on the second click, one lost click per dep-cache generation.
- **F: `optimizeDeps.include: ['@hushbox/ui > kokoro-js']`** — would cost every marketing dev a ~4 MB prebundle on cold start even if they never open a blog post, and Vite silently drops an include whose nested chain fails. **Correction:** the entry just deleted was `'@hushbox/ui > kokoro-js > onnxruntime-common'` — it pinned the *phantom* dep, not `kokoro-js`, so it almost certainly never suppressed this reload. F would be a different entry with a different purpose, not a revival. Efficacy Inferred, not verified.

## Reproduction as spec (production bug, red today)
1. **E2E:** open `/blog/<post>/`, wait for the island to lose its `ssr` attribute, click `button[aria-label="Listen to this post"]`, assert the control reaches `aria-label="Pause"` and the status never shows the error. Red today (3/3 clicks fail at t+0.5s).
2. **Cheap, no network:** assert `apps/*/dist/**/tts.worker-*.js` contains no `_vite_importMeta.prototype` / `df.prototype`-style rewrite of `new.target`. Red today against both existing dists.

## Raised
- **Stale comment:** `tts-engine.ts:110-113` claims `type: 'module'` is needed because "Vite's default iife format would break the static kokoro-js import". The build emits iife regardless of that flag today — and that iife path is exactly what corrupts `new.target`. If A lands, that comment must record the real constraint.
- Side effect: running the dev server warmed `apps/marketing/node_modules/.vite/deps` (now contains `kokoro-js`), so the next `pnpm dev` here will not show the reload until something invalidates it.
- Assumption: the two dist trees tested (built 13:46, after the last source edit at 13:10) represent what CI would build; grounded by the independent minimal repro, but no rebuild was done and `astro preview` does not apply the production `_headers`/CSP.

Sources: vitejs/vite#7706, vitejs/vite#21969, vitejs/vite#18585.
