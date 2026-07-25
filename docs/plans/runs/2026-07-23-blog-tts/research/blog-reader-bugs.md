# Blog reader bugs A/B/C — diagnosis

Analyst, 2026-07-24 (written up by the orchestrator; the analyst has no write tools).

## BUG A — toggling highlight back ON doesn't re-highlight the current sentence

**Root cause (Verified).** The toggle effect is asymmetric and no current chunk is retained.
- `blog-read-aloud.tsx:49-59` — `paintChunk(ctx, chunk)` is the only `highlighter.highlight(...)` call site and requires a chunk.
- `:72-76` — its only caller is the reader's `onChunk` callback. Nothing else can paint.
- `:235-239` — the effect has an OFF path (`clear()`) and **no ON path**; there is no `lastChunkRef`, so it has no coordinates to re-apply even if it wanted to.
- `document-reader.ts:243-259` — `DocumentReader` exposes no current-chunk accessor, so the component cannot pull it back.

Highlight can therefore only reappear when `playChunks` reaches the next chunk (`document-reader.ts:193-195`). Blast radius: blog-only (Verified by repo-wide grep; chat runs through `chat-tts-stream.ts` + `tts-dom-observer.ts`, sharing only `tts-engine`).

**Fix A1 (recommended, high confidence):** retain `lastChunkRef`, set in `onChunk`, **nulled** in `handleStop` (`:267-275`) and in `applyReaderState`'s idle/stopped/error branches (`:253-263`); the effect becomes: ON + retained chunk ⇒ repaint via `paintChunk`, else `clear()`. The nulling is load-bearing — without it, toggling ON after a finished read repaints a stale sentence.
Rejected: A2 (expose `currentChunk` on the reader — widens a published API to return a value the component already has, second source of truth); A3 (drive from React state — defensible, structurally immune, but larger diff and re-subscribes callbacks the file deliberately keeps on refs).

**Repro (RED today):** in `blog-read-aloud.test.tsx`, after `onChunk({index:0,…})`, click toggle OFF, `mockClear()`, click ON ⇒ expect `highlight` called with the same coordinates. Today it is called 0 times. Companion test: after `onState('idle')`, toggle off→on must NOT repaint.

## BUG B — download bar flashes on a cached model

**Root cause (Verified, two layers).**
1. `loading` is entered unconditionally before anything is known: `blog-read-aloud.tsx:291-292` (synchronously in the click) and `document-reader.ts:211`. `ReaderStatusSlot` (`:120-122`) renders the bar for all of `status === 'loading'`, which also covers ORT/WASM init, 4-worker spawn, and the warmup `generate()` (`tts-engine.ts:578-592`, `tts.worker.ts:114-135`).
2. **A cache hit still emits progress events.** In `@huggingface/transformers@3.8.1` `src/utils/hub.js`, the `download` event fires unconditionally after the cache lookup (`:569-575`) and the cached body is still streamed through `readResponse`, firing per-chunk progress (`:580-616`, `:726-767`); the only special case is a Firefox synthetic single `progress:100` (`:592-606`).

**Load-bearing:** transformers exposes **no** cache-hit signal — the payload is byte-identical cached vs networked. Every fix is therefore a heuristic; choose by failure mode.

**Fix B1 (recommended, medium confidence):** render the bar only when (a) ≥T ms elapsed in `loading` (T ≈ 800–1000 ms) **and** (b) last aggregate percent < 100; unmount at 100 rather than waiting for `speaking`. Failure mode is "a real bar appears T ms late" (harmless). Also cures the "bar sits at 100% during warmup" tail. **Depends on the Bug C fix** — gate (b) is meaningless on per-file percentages.
Rejected: B2 (rate-based cache detection — misclassifies a gigabit connection as cache and shows no bar for a real 90 MB download); B3 (probe Cache Storage directly — re-derives transformers' cache name and key construction, a sync contract CODE-RULES bans); B4 (accept it).

**Spec conflict:** `blog-read-aloud.test.tsx:226-234` ("shows the download bar and Stop control immediately on first click") **pins the buggy behavior** and must be split/amended.

## BUG C — progress starts at 100%, drops to 0%

**Root cause (Verified). Progress is per-file with zero aggregation anywhere in the chain.**
1. `tts.worker.ts:93-102` forwards `{loaded,total}` verbatim, discarding `event.file`/`name`/`status`; the local type (`:55-59`) doesn't even model `file`.
2. Those events are **per file** (`hub.js:597-616`, `:726-767`).
3. `tts-worker-protocol.ts:25` carries no file identity, so nothing downstream *can* aggregate.
4. `tts-engine.ts:562-576` forwards slot 0's payload unchanged.
5. Consumers each divide one file's pair: `document-reader.ts:213-215`, `sections/audio.tsx:44`.

kokoro-js passes one `progress_callback` to both model and tokenizer `from_pretrained`, so files load concurrently. First listen fetches config+tokenizer (**3,654 B**), one voice (**522,240 B**), and the weights (**92,361,116 B** = 99.4%). A few-KB JSON completes in one chunk ⇒ `loaded === total` ⇒ **100%**; the 92 MB file's first chunk ⇒ **~0.07%**. Exactly the reported symptom.

**This root cause is SHARED with the accessibility widget.** `sections/audio.tsx:90-95` subscribes to the same callback and `:44` does the same single-pair division, so the widget has the same 100%-then-0% bar, plus `formatBytesProgress` (`tts-download-progress.ts:10-14`) showing per-file bytes ("0.0 / 0 MB" → "3.2 / 88 MB"), and its `DownloadRateTracker` (`:46-79`) and ETA (`:29-37`) reset mid-download. **Pre-existing widget bug; the worker fix cures all four for free.**

**Fix C1 (recommended, high confidence):** aggregate in the worker (the only layer with file identity — no protocol change needed). Keep `Map<file,{loaded,total}>` in `handleLoad`; post `loaded = Σloaded_i`, `total = max(Σtotal_i, TTS_MODEL_DOWNLOAD_BYTES)` — a new exact-bytes export beside the existing `TTS_MODEL_DOWNLOAD_MB` in `packages/shared/src/tts-model-download.ts` (whose header already documents 92,887,010 B). Force `loaded = total` on `loadDone`. Monotonic by construction; drift failure mode is cosmetic (tops out ~97% until `loadDone` snaps it), never 100→0.
Rejected: C2 (aggregate over observed totals only — the first tiny file still yields Σloaded===Σtotal ⇒ 100%, same bug); C3 (track only the dominant file — needs a magic size floor, makes the byte readout a subtler lie); C4 (clamp monotonically at the consumer — freezes at 100% for the whole real download, worse than the bug).

**Touches:** `tts.worker.ts` (+test), `packages/shared/src/tts-model-download.ts`. No change to the protocol, engine, reader, widget, or blog component. Chat impact: none behaviorally (`prewarm-tts.ts:18` calls `load(voice)` with no progress callback; `chat-tts-stream.ts` never subscribes).

**Spec conflict:** `tts.worker.test.ts:114-132` ("forwards kokoro progress events as loadProgress messages") pins verbatim per-file forwarding and must be rewritten as an aggregation test.

**Repro (RED today):** in `tts.worker.test.ts`, feed `config.json 1200/1200` then `model 65536/92361116` then `model 46000000/92361116`; assert first emitted pct < 5 (today it is 100) and the sequence is monotonic non-decreasing.

## Landing order
**C first** (enabling — B1's gate is meaningless without aggregation), then **B**, then **A** (independent).

## Raised for separate investigation
`tts-engine.ts:222-262` posts `load` to all 4 pool workers simultaneously, yet the slot-0 progress filter (`:568-570`) is justified by a comment claiming the others "read the freshly cached weights from IndexedDB after slot 0 finishes downloading" — an ordering **the code does not establish**. If the browser does not coalesce four concurrent identical GETs, first listen fetches ~370 MB instead of ~93 MB. Not verified. (The throughput analyst independently flagged the same concern.)

## Assumptions
- Symptoms observed in a Chromium-family browser; Firefox takes a different cache-hit branch (`hub.js:592-606`) which changes B's shape and worsens C's cached-replay flash.
- B's "about a second" attributed to worker spawn + WASM init + warmup; inferred from the code path, not timed.
