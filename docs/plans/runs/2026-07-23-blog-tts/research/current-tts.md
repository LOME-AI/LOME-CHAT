# Current TTS ("read-aloud") feature — research findings

Scope: `packages/ui` accessibility widget TTS + `apps/web` chat "read chat replies
aloud" wiring. No TTS code exists in `apps/marketing` or `apps/admin` (grep for
`tts|speechSynthesis|kokoro|readAloud|read-aloud` under `apps/marketing/src` and
`apps/admin/src` returned nothing — `apps/admin/dist` and `apps/web/dist` hits are
stale build output, not source).

---

## 1. Exact file paths

### Core engine + chunking (package: `@hushbox/ui`, accessibility area)

All under `packages/ui/src/components/accessibility/`:

- `lib/tts-engine.ts` — main-thread `TtsService`: worker-pool orchestration
  (`WorkerKokoroTtsService`), `TtsVoice` type, `TTS_VOICES` list, `getTtsService()`
  singleton, AudioContext playback/scheduling, load/preload/speak/stop lifecycle.
- `lib/tts.worker.ts` — the dedicated Web Worker module; hosts one `kokoro-js`
  `KokoroTTS` instance per worker, generates audio, posts back via the protocol.
  Exports `createWorkerHandler(ctx)` for unit testing without a real worker.
- `lib/tts-worker-protocol.ts` — typed `WorkerInbound` / `WorkerOutbound` message
  union + `isWorkerOutbound()` runtime guard, shared by engine and worker.
- `lib/sentence-chunker.ts` — `SentenceChunker` class: accumulates streamed
  tokens, emits completed sentences (see §3).
- `lib/sentence-splitter.ts` — `splitSentence()` / `SPLIT_WORD_THRESHOLD` /
  `MIN_PIECE_WORDS`: subdivides long sentences at clause boundaries (see §3).
- `lib/text-normalizer.ts` — `normalizeForSpeech()`: strips markdown so the
  engine doesn't read formatting characters aloud.
- `lib/tts-stream-feeder.ts` — `createTtsStreamFeeder()`: bridges a streamed
  token source to the chunker + splitter + `TtsService.speak()`, with
  `isEnabled` / `isStreamMuted` gates and `onStreamStart`/`onStreamEnd` hooks.
  Framework-agnostic (no React/Zustand import).
- `lib/tts-download-progress.ts` — `formatBytesProgress`, `formatSpeed`,
  `formatEta`, `estimateEtaSeconds`, `DownloadRateTracker` (rolling-window
  download-rate estimator for the settings-panel progress UI).
- `sections/audio.tsx` — `AudioSection` / `ReadAloudControls`: the settings-panel
  UI (mute toggle, "Read chat replies aloud" toggle, voice picker, download
  progress bar, persistent-storage request).
- `store/store.ts`, `store/schema.ts` — `useA11yStore` (Zustand, persisted to
  localStorage) holding `ttsEnabled`, `ttsVoice`, `streamChatAloud`,
  `muteSounds`; schema/defaults re-exported from `@hushbox/shared`
  (`packages/shared/src/schemas/accessibility-preferences.ts`).
- `store/playback-store.ts` — `useTtsPlaybackStore` (separate, non-persisted
  Zustand store): `speakingStreamId`, `stoppedStreamIds`, used to drive the
  per-message Stop button and the muted-stream gate.

Package export surface (`packages/ui/package.json` `exports` map) — these are the
only paths importable from outside the package:
```
"./accessibility"                          -> accessibility/index.ts
"./accessibility/lib"                      -> accessibility/lib/index.ts
"./accessibility/lib/sentence-chunker"     -> accessibility/lib/sentence-chunker.ts
"./accessibility/lib/tts-stream-feeder"    -> accessibility/lib/tts-stream-feeder.ts
"./accessibility/lib/tts-engine"           -> accessibility/lib/tts-engine.ts
"./accessibility/store"                    -> accessibility/store/index.ts
```
`tts.worker.ts`, `tts-worker-protocol.ts`, `sentence-splitter.ts`,
`text-normalizer.ts`, `tts-download-progress.ts` are **not** individually
exported — only reachable indirectly through `tts-engine.ts` / `lib/index.ts`
or by deep relative import (which `eslint-plugin-boundaries` would flag from
outside the package).

Tests colocated 1:1 with each file above (`*.test.ts(x)`), e.g.
`lib/tts-engine.test.ts`, `lib/tts.worker.test.ts`, `sections/sections.test.tsx`.

### Chat "read aloud" wiring (app: `apps/web`)

- `apps/web/src/lib/chat-tts-stream.ts` — `startChatTtsStream()` /
  `stopTtsForMessage()`: builds a per-chat-stream `TtsStreamFeeder`, reading
  `useA11yStore` (opt-in gates) and driving `useTtsPlaybackStore` (speaking/
  stopped state for the Stop button). Lazily imports `tts-engine` only once
  chat-aloud is actually enabled.
- `apps/web/src/lib/tts-dom-observer.ts` — `installTtsDomObserver()`: a
  MutationObserver-based **fallback** path that watches any
  `[data-tts-stream]` DOM container app-wide and feeds its text through a
  `SentenceChunker` independent of the explicit SSE wiring ("self-applying"
  chat-aloud for any future streamed-text surface).
- `apps/web/src/lib/prewarm-tts.ts` — `prewarmTtsIfEnabled()`: pre-spawns the
  worker pool and warms the model on app boot if the user previously opted in
  (hides cold-start latency on first chat send).
- `apps/web/src/hooks/chat/use-chat-stream.ts` — the actual chat-stream hook:
  calls `startChatTtsStream(...)` (lines ~449, ~579), then `ttsFeeder.feed(token)`
  per SSE token (line ~382) and `ttsFeeder?.end()` at stream completion
  (lines ~461, ~591).
- `apps/web/src/components/chat/indicators/tts-stop-button.tsx` — `TtsStopButton`:
  renders "Stop reading" next to a message while `useTtsPlaybackStore`
  reports it as the active `speakingStreamId`; calls `stopTtsForMessage`.
- `apps/web/src/components/chat/indicators/tts-stopped-notice.tsx` — inline
  notice shown on a message the user stopped mid-read, pointing to
  `/accessibility` settings.
- `apps/web/src/main.tsx:46` — calls `void prewarmTtsIfEnabled();` at boot.
- `apps/web/src/routes/__root.tsx:53` — `React.useEffect(() =>
  installTtsDomObserver(), [])` mounts the DOM-observer fallback once at root.

Colocated tests: `chat-tts-stream.test.ts`, `tts-dom-observer.test.ts`,
`prewarm-tts.test.ts`, `tts-stop-button.test.tsx`, `tts-stopped-notice.test.tsx`.

---

## 2. TTS engine / model / npm packages

**Not** browser `speechSynthesis` — a local on-device neural model, run fully
client-side in a Web Worker pool.

- **Model**: Kokoro-82M, via **`kokoro-js`** (npm `kokoro-js@^1.2.1`), which
  wraps **`@huggingface/transformers`** (transformers.js, pulled transitively —
  not a direct dependency) running on **`onnxruntime-web`** (npm
  `onnxruntime-web@^1.26.0`) with the **WASM** execution provider (`DEVICE =
  'wasm'` in `tts.worker.ts:29`; WebGPU/fp32 support was explicitly removed per
  the code comment there).
- Model id: `onnx-community/Kokoro-82M-v1.0-ONNX`, quantization `q8`
  (`tts.worker.ts:24-28`) — chosen to keep the download ~80–88 MB vs ~330 MB at
  fp32.
- Both `kokoro-js` and `onnxruntime-web` are declared dependencies of
  **`packages/ui/package.json`** (not `apps/web`) — confirmed at
  `packages/ui/package.json:50,52` and in `pnpm-lock.yaml`.
- 5 built-in voices (`TTS_VOICES` in `tts-engine.ts:33-39`): `af_heart`,
  `am_michael`, `bf_emma`, `bm_george`, `af_nicole` (American/British,
  female/male).
- Architecture: `WORKER_POOL_SIZE = 4` dedicated Web Workers
  (`tts-engine.ts:22`), each hosting its own `KokoroTTS` instance so sentences
  can infer in parallel; a `playbackChain` on the main thread serializes actual
  audio scheduling via `AudioContext` so sentences play back in original
  `speak()` order regardless of which worker finishes first (sample-accurate,
  gapless scheduling — `tts-engine.ts:194-208, 644-684`).

---

## 3. Text chunking for the voice model

Two-stage pipeline, both framework-agnostic and package-internal
(`packages/ui/src/components/accessibility/lib/`):

1. **`SentenceChunker`** (`sentence-chunker.ts`) — `feed(chunk: string):
   string[]` accumulates streamed tokens in an internal buffer and emits
   completed sentences as soon as a boundary is found; `flush(): string | null`
   drains any trailing remainder at end-of-stream. Boundary detection
   (`isSentenceBoundary` / `findSentenceEnd`):
   - splits on `.`/`!`/`?` followed by whitespace or end-of-buffer;
   - suppresses false splits on a fixed abbreviation list (`Mr.`, `Mrs.`,
     `Ms.`, `Dr.`, `Prof.`, `St.`, `vs.`, `e.g.`, `i.e.`, `etc.`, `Sr.`, `Jr.`,
     `Inc.`, `Ltd.`, `Co.`, `Corp.`, plus multi-dot forms `U.S.`, `a.m.`,
     `p.m.`, `Ph.D.` via `SINGLE_DOT_ABBREVIATIONS`/dedicated patterns);
   - suppresses false splits on ordered-list/bullet markers (`1.`, `2)`, `-`,
     `*` at line start) via `isOrderedListMarker`;
   - strips fenced code blocks across `feed()` calls (`stripFences`/
     `fenceStep`, stateful `inCodeBlock` flag) before boundary scanning, since
     `.` inside code would trigger false boundaries;
   - runs `normalizeForSpeech()` (from `text-normalizer.ts`) on each emitted
     sentence to strip markdown (links, images, HTML tags, raw URLs → "link",
     bold/italic/strikethrough/inline-code markers, headings, blockquotes,
     lists, tables) so the model doesn't vocalize formatting syntax.

2. **`splitSentence()`** (`sentence-splitter.ts`) — for sentences over
   `SPLIT_WORD_THRESHOLD` (25 words), further splits at natural clause
   boundaries so time-to-first-audio stays low and no single TTS call is huge:
   - Tier-1 delimiters (weight 2): `;` `:` `—` `–` and whitespace-bounded
     hyphen (`\s-\s`, an em-dash typed as a plain hyphen).
   - Tier-2 delimiter (weight 1): comma + whitespace.
   - Greedy pass (`greedyPass`) picks split points closest to evenly-spaced
     target word positions, scored by tier weight minus distance-from-target,
     always keeping each piece ≥ `MIN_PIECE_WORDS` (6 words) — `pickBestCandidate`
     rejects any candidate that would leave either side under the floor.
   - Recursively subdivides any resulting piece still over threshold
     (`subdivideOverThreshold`).
   - Falls back to returning the sentence unchanged if no valid split exists.

3. **`createTtsStreamFeeder()`** (`tts-stream-feeder.ts`) composes the two:
   feeds `SentenceChunker`, then runs each completed sentence through
   `splitSentence()` before calling `TtsService.speak()` per piece. The first
   `FAST_START_SENTENCE_COUNT = 3` sentences of a stream use a **halved**
   split threshold (`Math.ceil(SPLIT_WORD_THRESHOLD / 2)` ≈ 13 words) so the
   very first audio starts sooner; later sentences use the full 25-word
   threshold since by then generation is pipelined ahead of playback.

---

## 4. Model download, caching, dedup

- **Lazy, opt-in download**: nothing downloads until the user turns on
  "Read chat replies aloud" in the accessibility panel (`sections/audio.tsx`,
  `handleToggle` → `getTtsService().load(voice, onProgress)`), or until
  `prewarmTtsIfEnabled()` runs at next boot if they'd already opted in
  (`apps/web/src/lib/prewarm-tts.ts`). No eager fetch on page load.
- **Where it's fetched from / how it's cached**: `KokoroTTS.from_pretrained()`
  (kokoro-js → `@huggingface/transformers`) does the actual fetch+cache; this
  repo's code does not implement its own cache layer. A code comment in
  `sections/audio.tsx:16-20` states the mechanism as understood by the authors:
  > "the HF transformers IndexedDB cache deduplicates by URL so the download is
  > paid once" — i.e. transformers.js's built-in model cache (IndexedDB-backed)
  is relied on, not a custom one. This is the transformers.js library's own
  cache (not written in this repo) — **not independently verified against the
  `@huggingface/transformers` source in this pass**; treat as inferred from the
  in-repo comment only.
- **Deduplication across the 4-worker pool**: each of the `WORKER_POOL_SIZE =
  4` workers independently calls `KokoroTTS.from_pretrained()` and thus
  independently constructs its own in-memory `KokoroTtsInstance`/ONNX session
  (~80 MB resident per worker, per the comment at `tts-engine.ts:16-21`), but
  the **network download** is deduplicated: `onLoadProgress` in `tts-engine.ts`
  (lines 556-570) explicitly forwards progress events **only from slot 0**,
  with the comment: "the others read the freshly cached weights from IndexedDB
  after slot 0 finishes downloading, so their progress events would
  over-report." So: one HTTP download, then 3 more IndexedDB reads to build
  the other 3 in-memory sessions.
- **Persistent storage**: on successful first load, `requestPersistentStorage()`
  (`sections/audio.tsx:23-34`) calls `navigator.storage.persist()` (best-effort,
  swallows denial) so the browser is less likely to evict the IndexedDB-cached
  weights under storage pressure.
- **No service worker** is involved anywhere in this pipeline — no
  `serviceWorker.register` or SW-based caching found in the TTS code paths.
- **Load timeout / failure handling**: `DEFAULT_LOAD_TIMEOUT_MS = 120_000`
  (`tts-engine.ts:91`) fails the whole pool load fast if any worker hangs
  (network stall, WASM compile wedge), tearing down all workers
  (`tearDownWorkers`) rather than leaving a half-loaded pool.
- **UI feedback**: `DownloadRateTracker` (`tts-download-progress.ts`) computes
  a rolling-window (3s default) bytes/sec estimate from `loaded` progress
  events; `formatBytesProgress`/`formatSpeed`/`formatEta` render the progress
  bar text in `sections/audio.tsx`.

---

## 5. Highlighting of currently-spoken text

**None exists.** No word-level or sentence-level highlight of spoken text was
found anywhere in the TTS code paths. Evidence:
- Grep for `highlight` across the entire `accessibility/` directory and all
  `apps/web` TTS files returned zero matches.
- Grep for `currentWord|activeSentence|spokenRange|onboundary|boundary event`
  repo-wide (excluding `node_modules`) returned zero matches — there's no
  `SpeechSynthesisUtterance`-style `boundary` event handling either (expected,
  since the feature doesn't use `speechSynthesis` at all — Kokoro/ONNX
  generates a full audio buffer per sentence/piece with no word-timing
  metadata surfaced to the caller).
- `TtsStopButton` and `TtsStoppedNotice` operate at **message/stream
  granularity** only (`useTtsPlaybackStore.speakingStreamId`), not at
  word/sentence granularity within a message.

This is a genuine gap relative to typical "read aloud" UX (e.g. Kokoro/ONNX
`generate()` returns only `{ audio: Float32Array, sampling_rate }` per piece —
no per-word timestamps — so word-level highlighting would need either a
different model/output or client-side heuristic timing).

---

## 6. Package boundaries / what's importable from marketing

- **All TTS engine/chunking/worker code lives in `packages/ui`**
  (`@hushbox/ui`), under `src/components/accessibility/`. This is a workspace
  package (`pnpm-workspace.yaml`), consumed via the `exports` map in
  `packages/ui/package.json` (§1 above).
- **`apps/web`** contains only the *chat-specific wiring* layer
  (`chat-tts-stream.ts`, `tts-dom-observer.ts`, `prewarm-tts.ts`, the stop
  button/notice components, and the `use-chat-stream.ts` hook integration) —
  it imports the engine/feeder/store from `@hushbox/ui/accessibility/*` via
  the package's public subpath exports, never via deep relative paths (would
  be blocked by `eslint-plugin-boundaries`).
- **`packages/shared`** owns only the Zod schema/defaults for the persisted
  preferences (`ttsEnabled`, `ttsVoice`, `streamChatAloud`, `muteSounds`) at
  `packages/shared/src/schemas/accessibility-preferences.ts`; `@hushbox/ui`'s
  `store/schema.ts` re-exports from there. No engine/audio code lives in
  `packages/shared`.
- **`apps/marketing`** (Astro) has **zero** TTS-related code and **zero**
  imports of `@hushbox/ui/accessibility/*` today (confirmed by grep — no
  hits). Whether `apps/marketing` can import `@hushbox/ui` at all: marketing
  is a separate Astro app in the same pnpm workspace; `@hushbox/ui` is a
  workspace package so it is *technically* installable/importable by
  marketing the same way `apps/web` does it, **but this was not verified**
  — marketing's own `package.json` dependency list was not inspected in this
  pass, and no architecture doc consulted here states marketing already
  depends on `@hushbox/ui`. Two things worth flagging for anyone building a
  marketing/blog "read aloud" feature:
  1. `kokoro-js` + `onnxruntime-web` are real, heavy dependencies (~88 MB
     model + WASM runtime) currently paid for only by `apps/web` at runtime
     (lazy-imported, per `chat-tts-stream.ts`'s comment about avoiding bundle
     cost for users who never opt in). Reusing `tts-engine.ts` from marketing
     would carry the same lazy-import discipline to avoid bloating the
     Astro site's shipped JS for visitors who never click "read aloud".
  2. The engine/worker/chunker files are not npm-package-scoped to "chat" in
     any way — `SentenceChunker`, `splitSentence`, `normalizeForSpeech`,
     `TtsService`/`getTtsService()`, and `createTtsStreamFeeder()` are all
     generic (markdown-in, sentences-out; text-in, audio-out) and already
     individually exported from `@hushbox/ui` (§1's export map), so they are
     reachable without depending on any `apps/web`-only code — a blog reader
     would call the same `getTtsService()` singleton, `SentenceChunker`, and
     `splitSentence` that chat uses.

---

## Distilled summary (for quick reference)

- **Engine**: Kokoro-82M ONNX (q8) via `kokoro-js` on `onnxruntime-web`
  (WASM device), NOT browser `speechSynthesis`. Both are deps of
  `packages/ui/package.json` (not `apps/web`).
- **Core files**: `packages/ui/src/components/accessibility/lib/{tts-engine.ts,
  tts.worker.ts, tts-worker-protocol.ts, sentence-chunker.ts,
  sentence-splitter.ts, text-normalizer.ts, tts-stream-feeder.ts,
  tts-download-progress.ts}` + UI in `sections/audio.tsx` + stores in
  `store/{store.ts,schema.ts,playback-store.ts}`.
- **Chat wiring** (apps/web only): `src/lib/{chat-tts-stream.ts,
  tts-dom-observer.ts, prewarm-tts.ts}`, `src/hooks/chat/use-chat-stream.ts`
  (feed/end calls), `src/components/chat/indicators/{tts-stop-button.tsx,
  tts-stopped-notice.tsx}`, mounted from `main.tsx` and `routes/__root.tsx`.
- **Chunking**: `SentenceChunker.feed/flush` (boundary + abbreviation +
  list-marker + code-fence handling) → `splitSentence()` (clause-boundary
  subdivision of long sentences, halved threshold for the first 3 sentences
  of a stream) → `normalizeForSpeech()` (markdown strip) — all in
  `packages/ui/.../lib/`.
- **Download/cache**: lazy on opt-in; relies on transformers.js's own
  IndexedDB model cache (not custom-built here); only worker slot 0's
  progress is surfaced (dedup signal — the other 3 workers reuse the cached
  weights); `navigator.storage.persist()` requested after first load; no
  service worker; 120s load timeout tears down the whole pool on failure.
- **Highlighting**: none. No word/sentence highlight of spoken text exists;
  only message-level "currently speaking" state (`speakingStreamId`) driving
  a Stop button.
- **Boundaries**: engine/chunking/store all in `packages/ui` (`@hushbox/ui`),
  reachable via public subpath exports (`./accessibility/lib/tts-engine`,
  `./accessibility/lib/sentence-chunker`, `./accessibility/lib/tts-stream-feeder`,
  `./accessibility/store`, `./accessibility/lib`, `./accessibility`); chat-only
  glue lives in `apps/web`. `apps/marketing` currently has no TTS code and no
  confirmed dependency on `@hushbox/ui`; reusing the engine there is
  plausible via the same workspace-package exports but marketing's
  `package.json` was not checked and should be verified before assuming it.
