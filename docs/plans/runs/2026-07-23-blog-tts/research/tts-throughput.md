# Blog read-aloud throughput — diagnosis

Analyst, 2026-07-24 (written up by the orchestrator; the analyst has no write tools). Symptom: "TTS seems very slow, almost like there is only a single worker."

## Cause 1 (dominant) — synthesis is serialized behind playback; only worker slot 0 ever runs. Verified, high confidence.

`document-reader.ts:191-206`:

```ts
for (const chunk of ctx.chunks) {
  if (readState(ctx) !== 'speaking') break;
  onChunk(chunk);
  await tts.speak(chunk.text, voice);   // resolves when audio ENDS, not when synthesis completes
}
```

`speak()` resolves after `await scheduleResult.endedPromise` (`tts-engine.ts:385`). So `pendingQueue` never holds more than one item, and `dispatchPending()`'s `findIndex(s => s.inflight === 0)` (`tts-engine.ts:507`) returns slot 0 every time.

Consequences (Verified):
- Slots 1–3 never synthesize a blog sentence. They load the model, warm up once, then idle holding ~80 MB of q8 weights each (~240 MB resident, zero throughput). "Almost like there is only a single worker" is literally true on this path.
- Every inter-sentence gap equals the full synthesis latency of the next chunk. The gapless scheduler (`startTime = Math.max(this.nextStartTime, ctx.currentTime)`, `tts-engine.ts:676`) is structurally defeated: chunk N's `ended` has already fired before N+1 is submitted, so `currentTime > nextStartTime` every time and playback degenerates to speak-pause-speak-pause.
- Compounding: the blog uses the default `SPLIT_WORD_THRESHOLD = 25` (`sentence-splitter.ts:2`) with no fast-start halving, so chunks are long and each gap is long.

## Cause 2 (real, first-listen only) — time-to-first-audio waits for all 4 workers to download, compile, and run a warmup generation, inside the click. Verified control flow; magnitude Inferred.

- `load()` posts to all 4 slots (`tts-engine.ts:256-263`) and resolves only when `loadDoneBySlot.every(Boolean) && warmupSettledBySlot.every(Boolean)` (`:624`). Warmup is a real `generate()` per worker (`tts.worker.ts:125`). Time-to-first-sound = max over 4 contended workers, not min.
- `runRead` awaits all of that before the first `speak()` (`document-reader.ts:213-223`).
- `prewarmTtsIfEnabled()` is wired only into `apps/web/src/main.tsx:46`. The blog is Astro, so blog visitors pay the entire cold path inside the click while chat users are pre-warmed.
- Four concurrent cold `from_pretrained` calls probably produce four parallel ~90 MB fetches (no cross-worker in-flight dedup in transformers.js), and the progress bar reports slot 0 only (`tts-engine.ts:571`), so it under-reports. **Inferred** — worth a devtools check.

## Cause 3 — REFUTED: the pool was not removed or regressed.
`WORKER_POOL_SIZE = 4` unchanged; `git diff origin/main -- tts-engine.ts` contains only `unlockAudio(existing?)` plus coverage comments. Engine tests already pin fan-out (`tts-engine.test.ts:568,583`). Do not spend time here.

## Cause 4 — per-chunk fixed overhead (phonemization + ORT session run). Real but second-order.

Falsifier separating 1 from 2: on a **second** listen in the same tab the start is fast but the inter-sentence gaps remain — that isolates Cause 1 as the steady-state problem.

## Plan defect (origin of the bug)
`plan.md:67` and acceptance criterion (4) at `:69` say "plays them **sequentially**". That was meant as *playback order*; it was implemented as *synthesis serialization*. The implementer followed the brief exactly. Amended wording should be "in document order, with synthesis pipelined ahead of playback".

## Options
- **A (recommended) — sliding-window prefetch inside `document-reader.ts`**: issue up to `WORKER_POOL_SIZE` speaks ahead, keep the ordered `await` for state/highlight. Engine untouched, chat untouched, G1+G8 intact, ~15 lines. Bounded: stop-early wastes at most pool-size chunks; the depth derives from the pool size rather than a new magic number. Also *improves* highlight accuracy — today `onChunk(N+1)` paints during the silent gap before audio exists; under A it paints when N's audio ends, exactly when N+1 starts.
- **B — fire-and-forget every chunk** (mirror `tts-stream-feeder.ts:98-107`): rejected. Chat is naturally throttled by token arrival; a blog article is fully known up front, so this synthesizes and schedules the entire article ahead of playback — hundreds of buffers resident, all compute wasted if the user stops early.
- **C — reuse `createTtsStreamFeeder`**: wrong shape. No per-chunk playback callback, cannot express offset-carrying chunks; adopting it forces the shared-surface changes G8 forbids.
- **D — add a playback-start signal / `speakBatch` to the engine**: rejected, G1/G8 reversal for a fidelity problem A fixes incidentally.
- **E — prewarm on the blog page, and/or resolve `load()` after the first worker is ready**: addresses Cause 2 only, complementary to A, not a substitute. The "first worker ready" half is an engine change; the prewarm half spends a visitor's bandwidth uninvited. Needs its own founder ruling.

## Implementation hazards the brief must carry
1. Pre-issued promises need a no-op `.catch()` attached **at issue time** — `stop()` rejects every pending speak (`tts-engine.ts:398-424`), otherwise `WORKER_POOL_SIZE - 1` unhandled rejections.
2. `onChunk` must stay on the ordered-await path, not move to the issue path, or the highlight races ahead of the audio.

## Reproduction spec (tests to write first)
The existing `makeFakeTts` harness (`document-reader.test.ts:39-80`) has a single shared `speakGate`; it needs a per-call deferred variant.

1. `issues synthesis for later chunks before the current chunk finishes playing` — ≥5 chunks, per-call deferred that never auto-resolves, `void reader.start()`, flush microtasks, assert `spoken.length > 1` (target `min(chunkCount, WORKER_POOL_SIZE)`). **RED today: exactly 1.**
2. `paints only the chunk that is currently playing` — assert `onChunk` fired once after start; resolve deferred 0; assert it has now fired for chunk 1 and no further. Green today, must stay green (pins A against naive prefetch).
3. `never keeps more than the pool size of chunks in flight` — 10 chunks, resolve one at a time, assert `spoken.length - resolved <= WORKER_POOL_SIZE`. Red under B, green under A.
4. `stops cleanly with a full prefetch window outstanding` — issue window, `stop()`, assert state `stopped`, `stopCalls === 1`, no unhandled rejection.

## Assumptions
- Kokoro q8-on-WASM per-chunk latency is perceptible (~0.3–1.5 s for 25 words) — **Assumed**, no measurement exists in the repo. The structural argument holds regardless; the *magnitude* of A's win is unmeasured.
- No cross-worker fetch dedup — Inferred; affects Cause 2's severity only.
