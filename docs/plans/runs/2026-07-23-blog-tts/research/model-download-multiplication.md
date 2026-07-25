# Cold first listen downloads the model 4× (~370 MB)

Analyst, 2026-07-24 (written up by the orchestrator; the analyst has no write tools). **VERDICT: 4×. Confidence: high — Verified from code + live HTTP evidence.**

## 1. The engine fans out `load` to all four workers in one synchronous loop
`tts-engine.ts:256-263` posts `load` to every worker in a single loop — no stagger, no gate, no await. All four were spawned two statements earlier (`:222-226`). Each independently calls `KokoroTTS.from_pretrained(...)` (`tts.worker.ts:79-104`). Four Workers = four JS realms; nothing mediates their fetches.

**Pre-existing, not from this run.** `origin/main` has the identical fan-out (line 246) and identical slot-0 filter (543-545); `git diff origin/main` shows only `unlockAudio(existing?)` and coverage comments. It ships in the deployed monolith today.

## 2. The comment at `tts-engine.ts:568-570` is wrong on two counts
It claims the other slots "read the freshly cached weights from IndexedDB after slot 0 finishes downloading."
- **Wrong cache:** it is the **Cache API** (`hub.js:452` — `caches.open('transformers-cache')`), not IndexedDB. `CacheStorage` is exposed on `WorkerGlobalScope`. The engine's own test repeats the error (`tts-engine.test.ts:330`).
- **Wrong ordering:** nothing sequences slot 0 ahead of the others.

**No single-flight guard exists in the library.** `getModelFile` (`hub.js:404-678`) is a plain async function; grep for `inflight|pendingRequests` in `hub.js` returns nothing. `cache.put` happens only **after** the entire 92 MB body is read (`:618-648`), so the entry does not exist until one worker's download fully completes — minutes in. Four `cache.match` calls fired milliseconds apart all miss.

## 3. The browser cannot coalesce it — Verified against the live endpoint
Transformers fetches with plain `fetch(urlOrPath)`, no `cache:` option (`hub.js:248`). Observed this session via curl against the real model URL:
1. The repo URL returns **`HTTP/2 302` with `cache-control: no-store`** — the redirect is never cached, so each worker resolves independently.
2. The `location` is a **per-request signed CDN URL that varies** — two distinct `Signature=` values observed across requests, with differing query-parameter order. Different final URL ⇒ different HTTP-cache key ⇒ **coalescing is structurally impossible, in any browser.**
3. The CDN response carries no `cache-control` and no `last-modified` (206, `content-range: bytes 0-100/92361116`), so no heuristic freshness either.

Even under perfect HTTP-layer coalescing, each worker would still materialize its own 92 MB `Uint8Array` and issue its own `cache.put` — the ~370 MB *memory* spike survives regardless.

## 4. Why this matches "brutally slow" — three compounding effects, one fix
1. **Bandwidth split 4 ways** ⇒ ~4× wall time.
2. **Progress watches slot 0 only** (`:571`), itself running at ~¼ line rate ⇒ displayed MB/s is ~¼ of real throughput and ETA ~4× too long. Cheap corroborating signal: if the observed rate was far below known line speed, that alone is near-proof.
3. **`load()` resolves only when all four report `loadDone` AND `warmupDone`** (`:624`), each warmup a full ORT generation ⇒ after slot 0's bar hits 100%, the user waits through three more downloads plus four WASM inits and four warmups. This is the "stuck at 100%" symptom.

## 5. Is the disclosure accurate?
- **"one time" — accurate.** The Cache API entry persists; later listens are free (this is what makes the blog↔chat dedup claim true).
- **Storage footprint — accurate.** `cache.put` re-checks `cache.match` first and same-key puts overwrite, so ~90 MB lands on disk, not 370 MB.
- **First-listen network transfer — materially untrue.** It is ~370 MB. On a metered mobile connection that is the number that matters, and it is what the sentence reads as. **Fix the code, not the copy.**

## Options
- **A (recommended)** — stage the fan-out: post `load` to slot 0 only; fan out to slots 1-3 inside `onLoadDone(slotIndex === 0)`. One edit in the shared engine fixes chat + widget + document-reader + blog at once. Cost: the **warm** path serializes (~T → ~2T, a few seconds). `speak()` already rejects unless `loaded`, and `load()` still resolves only when all four are done, so `dispatchPending` needs no change.
- **B** — A plus resolve `load()` as soon as slot 0 is ready, warming 1-3 in the background. Strictly better latency, but requires per-slot readiness in `dispatchPending` (`:505-523`), changes what `isLoaded()` means, and interacts with `preloadVoice` and the `onLoadError` teardown. Real surface area — a separate decision, not bundled.
- **C** — reduce `WORKER_POOL_SIZE`. Scales the defect rather than removing it (2 workers still ≈185 MB) and costs the inference parallelism that keeps reading ahead of playback.
- **D** — single-flight outside the pool (seed the cache, SharedWorker coordinator, `useCustomCache`). Requires hardcoding transformers' cache name and remote URL — a banned sync contract with library internals; `useCustomCache` is unreachable through kokoro-js's wrapper anyway.
- **E** — accept and correct the copy to ~370 MB. Kills first-listen conversion; listed for completeness.

## Reproduction
**Device check (~5 min, confirmatory):** DevTools → Application → Cache Storage → delete `transformers-cache`; Network filtered to `model_quantized`; click Listen. 4× ⇒ four ~92 MB transfers to `us.aws.cdn.hf.co/xet-bridge-us/…` plus four 302s.

**Failing unit test first** (`tts-engine.test.ts`, fake worker factory): call `load('af_heart')`, flush a macrotask, assert slot 0 has exactly one `load` and slots 1-3 have **zero**; then ack slot 0's `loadDone`, flush, assert each remaining slot now has exactly one. **RED today** — all four are posted synchronously.

Two existing tests encode the false claim and must be updated in the same change: `tts-engine.test.ts:262` ("posts a load message to every one") and `:314`/`:330` (the IndexedDB comment). The source comment at `:568-570` gets corrected too.

## Raised
- **Deployed-monolith defect, not a blog-run regression.** Record as pre-existing.
- **Chat pays this silently today** via `prewarm-tts.ts:18` at app boot for every `ttsEnabled` user — ~370 MB of background transfer with no UI at all. Arguably worse than the blog case, which at least shows a bar and a disclosure.
- **Memory, not just bandwidth:** four concurrent 92 MB buffers plus four ORT sessions (~80 MB resident each) is a plausible mobile-Safari OOM on cold load. Option A fixes the transient half; the resident half is option C's territory and needs its own ruling.
- `plan.md:7`'s dedup claim is true for the warm cross-surface case but reads as a general guarantee — worth a one-line qualification.
