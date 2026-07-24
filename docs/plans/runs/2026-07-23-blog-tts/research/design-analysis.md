# Blog "read this post aloud" — design analysis (decision material)

Analyst output, 2026-07-23. Advisory only; the orchestrator/human decides.
Evidence grades: **V** = Verified (read this session, cited), **I** = Inferred, **A** = Assumed.

Inputs: `research/current-tts.md`, `research/blog-architecture.md`, `research/tts-landscape.md`,
`research/origin-and-dedup.md`, plus direct reads of
`packages/ui/src/components/accessibility/lib/tts-engine.ts`,
`lib/tts.worker.ts` (head), `lib/sentence-chunker.ts` (head),
`packages/shared/src/schemas/accessibility-preferences.ts`,
`scripts/generate-headers.ts`, `docs/DESIGN.md`, `docs/PRODUCT.md`.

## Ground facts the design rests on (all V unless noted)

- Engine API is exactly: `load(voice, onProgress)`, `isLoaded()`, `preloadVoice(voice)`,
  `speak(text, voice): Promise<void>` (resolves when that sentence's audio *finishes*),
  `stop()`, `unlockAudio()` (must be called inside a user gesture on iOS) —
  `packages/ui/src/components/accessibility/lib/tts-engine.ts:41-65`.
  **There is no pause, no resume, no rate control, no load-cancel** on the public
  `TtsService` interface (`terminate()` exists only on the class, not the interface).
- `speak()` resolving per piece means the *caller* always knows which chunk is audible
  → chunk-level progress/highlighting needs zero engine changes.
- Chunking pipeline (`SentenceChunker` → `splitSentence` → `normalizeForSpeech`) lives in
  `packages/ui/.../lib/`; `sentence-splitter.ts` and `text-normalizer.ts` are **not**
  public subpath exports (current-tts.md §1) — any consumer needing them must live inside
  `packages/ui` or go through a new export.
- Blog article container: `article.prose-blog[data-reading]`, one per page, static MDX-rendered
  HTML with stable heading ids (blog-architecture.md §2). Byline row is a two-cell flex at
  `apps/marketing/src/pages/blog/[slug].astro:65-79`; a right-side control means an
  `ml-auto` third sibling.
- Marketing already hydrates React islands and already depends on `@hushbox/ui`, including
  loading `A11yProvider`/`AccessibilityWidget` `client:load` on `BlogLayout.astro`
  (blog-architecture.md §3) — the persisted `useA11yStore` (with `ttsVoice`, default
  `af_heart`) is therefore already live on every blog page
  (`packages/shared/src/schemas/accessibility-preferences.ts:25-30`).
- Same production origin (`https://hushbox.ai`) for app and blog ⇒ the transformers.js
  Cache-API model cache is shared **iff both surfaces initialize kokoro-js identically**,
  i.e. both go through the one engine/worker (`origin-and-dedup.md`). Model config
  (`MODEL_ID`, `DTYPE='q8'`, `DEVICE='wasm'`) lives only in `tts.worker.ts:24-30` —
  reusing `getTtsService()` makes forking it impossible.
- kokoro-js exposes **no word timestamps** (not even in the ONNX export); sentence-level
  sync is native, word-level would be duration-approximation (tts-landscape.md §4).
- Model is ~92 MB (q8) per the HF card (tts-landscape.md §1.1); the in-repo comment says
  ~80–88 MB. Disclose "~90 MB" (I — round number spanning both).

## BLOCKER-CLASS FINDING (raise before any task runs)

**The generated CSP has no Hugging Face host in `connect-src`.**
`scripts/generate-headers.ts:108-116` enumerates `'self'`, the API origin, R2 wildcards,
Helcim, and `wss` — nothing else. The model download is a cross-origin fetch to the HF
Hub/CDN from inside the worker (worker script is same-origin, so it inherits/receives the
same policy). **Inferred consequence: the first-ever model download is CSP-blocked in any
deployed build that ships these headers — for the existing chat read-aloud too, not just
the blog.** I could not find any huggingface/jsdelivr allowance anywhere in the repo
(grep: only the comment in `tts.worker.ts:2`). Since the rewrite is not yet deployed, this
is plausibly a latent, never-observed defect. Also unverified: whether
transformers.js/onnxruntime-web fetches its `.wasm` binary from a CDN (jsDelivr) or from
the bundle — if CDN, that host needs allowing as well (A). **This needs its own
verification/fix task and possibly extends the disclaimer wording (which CDN hosts we
actually contact).**

---

## Axis (a) — Playback UI

### Option A1 — minimal byline chip: Listen / progress / Stop (no pause, no speed)
An `ml-auto` chip in the byline row. States: `idle` ("Listen · ~N min") → first-use
popover (axis d) → `downloading` (real % from `load()`'s `onProgress`, size shown) →
`playing` ("Stop"). Errors (`LoadTimeoutError` at 120 s, worker crash) → "Couldn't load —
Retry", nothing sticky, nothing floating.
- Serves: simplicity-first, fail-fast (engine already fails the whole pool loudly),
  no-speculative-flexibility, accessibility (one obvious button).
- Violates: usability on long posts — with auto-scroll following the reading, the byline
  (and thus the only Stop) scrolls out of view. A play control you cannot reach is an
  accessibility failure, not a simplification.

### Option A2 — full player: play/pause/seek/speed, sticky mini-player
- Serves: "best-in-class" ambition, Edge/Speechify parity (tts-landscape.md §3.3).
- Violates: the engine has **no pause/resume/rate API** (V, interface at
  `tts-engine.ts:41-65`); true pause needs `AudioContext.suspend()` plumbing and speed
  needs `source.playbackRate` at schedule time — engine surface changes inside
  `packages/ui` with its 95 %-coverage burden, all speculative for v1. Seek-by-time is
  impossible without timestamps. Violates simplicity-first and no-speculative-flexibility.

### Option A3 (recommended) — chip + chunk-indexed transport + floating stop pill
A1's chip, plus two things that cost almost nothing because **the island drives one
`speak()` per chunk and always knows the current index**:
1. **Chunk-granular pause/resume**: "Pause" = `stop()` + remember index; "Resume" =
   re-`speak()` from that chunk. Honest granularity (restarts the current sentence),
   zero engine changes.
2. **Floating stop pill** (small fixed pill, e.g. bottom corner: "Stop reading", with
   pause) shown only while playing *and* the byline chip is off-screen
   (IntersectionObserver). `Esc` stops (matches Edge convention). This is presentation of
   the same state, not a second mechanism.
State lives in the island (local React state / tiny hook) — it is per-page, ephemeral,
and dies on navigation; putting it in the shared Zustand store would be speculative.
Download UX: popover discloses size *before* any bytes move; during download the chip
shows a real % (reuse `DownloadRateTracker`/`formatBytesProgress` — note these are not
public exports; see axis c). **Cancel-during-download**: the engine cannot abort
`load()` (no such API). Two honest choices: (i) omit cancel — the popover's explicit
"Download & listen" consent happens *before* load starts, so there's no surprise to
escape from; or (ii) add `cancelLoad()` to `TtsService` (promote `terminate()`
semantics). Recommend (i) for v1; (ii) is a human call if cancel is wanted.

**Recommendation: A3** — long-term robust (pause and the pill fall out of chunk-indexed
state that highlighting needs anyway), no engine surface change, honors accessibility
(reachable stop at all times, Esc, focus-visible chip).
**Rejected:** A1 (unreachable stop under auto-scroll), A2 (requires speculative engine
API work; seek impossible without timestamps). **Confidence: high.**

## Axis (b) — Text extraction & highlighting

### Extraction
- **B1 (recommended) — runtime DOM walk** of `article.prose-blog[data-reading]` at first
  click: iterate block-level children (`p, h2-h4, li, blockquote, figcaption, td`), take
  `textContent` per block, feed each block through the existing chunker+splitter. The DOM
  is the *rendered* single source of truth — what you highlight is exactly what exists;
  no drift possible. Skips `pre` naturally (and the chunker's fence-stripping is moot on
  rendered HTML). `data-reading` is currently an unconsumed typography marker
  (blog-architecture.md §2) — adopting it as the extraction root is new behavior; the
  alternative root is `article.prose-blog`. Minor point for the human: keying off
  `data-reading` makes terms/privacy trivially readable later, but also couples a
  typography marker to an extraction contract.
- **B2 — build-time MDX extraction** (rehype plugin stamps `data-tts-chunk` spans and/or
  emits a chunk manifest). Deterministic, testable at build. **Rejected:** the manifest
  must stay byte-consistent with the rendered DOM — a classic sync contract
  (CODE-RULES "One Implementation, Shared": the sync contract is the smell); it also
  bloats every post's HTML for the majority who never press Listen, and a rehype plugin
  re-implements chunk semantics at a second callsite unless it imports the chunker into
  the Astro build (possible but heavier than B1 for zero user-visible gain).

### Chunk → DOM range mapping (the one genuinely tricky piece)
`SentenceChunker` emits *normalized* sentences (`normalizeForSpeech` applied) with **no
source offsets** (V, `sentence-chunker.ts` head + current-tts.md §3). On rendered blog
HTML, textContent is already plain prose, so normalization is a near-no-op *except* raw
URLs → "link" (I). Two mapping strategies:
- **M1 (recommended): progressive tolerant matcher** — walk the block's raw text with a
  cursor, locate each emitted sentence by prefix/fuzzy match; on any miss, **fall back to
  highlighting the whole block** for that chunk group. Fail-soft, no engine change.
- **M2: offset-emitting chunker** — extend `SentenceChunker` to optionally emit
  `{ text, start, end }`. Cleaner long-term, but touches a well-tested shared file used
  by live chat streaming; only worth it if M1's matcher proves flaky in tests.
  Present to the human as the fallback plan, not the v1 plan.

### Granularity
**Chunk-level (the `speak()` unit: sentence, or clause-piece for long sentences) —
recommended, default ON.** It is *exactly* synchronous with audio because the island
issues the `speak()` calls. **Word-level duration-approximation: rejected for v1** — no
timestamps exist even in the ONNX export (V, tts-landscape.md §4); the approximation adds
rAF machinery and visible drift for zero accessibility gain over sentence sync (Edge ships
sentence/paragraph granularity, §3.3). Re-open only if the `-timestamped` ONNX variant is
ever documented.

### Rendering the highlight
- **H1 (recommended): CSS Custom Highlight API** (`CSS.highlights` + `::highlight()`),
  Range-based — zero DOM mutation, zero layout shift, styles via the shared tokens
  (e.g. `--brand-red-subtle` background) in `global.css` with a `.dark` variant.
  Support in current evergreen browsers is good but **must be feature-detected** (A —
  not verified against caniuse this session); on missing support fall back to
  **block-level class toggle** (H2) — no span-wrapping ever.
- **H2: wrap spans at highlight time.** Rejected as primary: mutating rendered prose
  mid-read risks layout shift and fights `.prose-blog` styling; kept only as the
  detection fallback at *block* granularity (class on the block element, no wrapping).

### Auto-scroll (default ON)
Scroll the active chunk into view (`block:'center'`) **only when it is not already
visible**, with `behavior:'smooth'`; under `prefers-reduced-motion` **or** the widget's
`stopAnimations`, use instant jumps (or no smooth) via the existing motion-aware helpers
(DESIGN/PRODUCT: reduced motion honored by construction). Suspend auto-scroll after a
manual user scroll (wheel/touch) until the user presses the transport again or the active
chunk re-enters the viewport — prevents fighting the reader. Confidence: med on the exact
suspend heuristic; the simple "only if not visible" rule alone is an acceptable v1.

**Confidence overall: high (extraction/granularity), med (mapping matcher — needs a
spike test in the first task).**

## Axis (c) — Engine reuse & package placement

### Option C1 — thin island imports engine subpaths directly from marketing
`apps/marketing` island imports `@hushbox/ui/accessibility/lib/tts-engine` +
`.../sentence-chunker` and implements extract/map/highlight/drive locally.
**Rejected:** (1) `splitSentence` and the download-progress formatters are **not** public
exports (current-tts.md §1) — the island would either skip long-sentence splitting
(worse prosody/latency than chat, a behavioral fork) or the exports map grows piecemeal;
(2) the extract→chunk→map→drive logic is generic "read a document" logic that would sit
in an app, invisible to the next caller (terms/privacy pages carry the same
`data-reading` marker today; chat "read this finished message" is a plausible caller) —
the narrowest scope covering probable callers is `packages/ui`, per One-Implementation-
Shared's placement rule.

### Option C2 (recommended) — one lean `document reader` module in `packages/ui`
New module (suggested: `packages/ui/src/components/accessibility/lib/document-reader.ts`
+ one new subpath export), framework-agnostic like `tts-stream-feeder.ts`:
`createDocumentReader(rootEl, { voice, onChunkStart(range|block), onChunkEnd, onProgress,
onDone, onError })` with `start/pause/resume/stop`. Internally composes the *existing*
chunker, splitter, normalizer, and `getTtsService()` — nothing forked. The marketing
island (`apps/marketing/src/components/blog/ListenToPost.tsx`, `client:visible`) is a
thin UI shell: chip, popover, floating pill, `::highlight` registration, auto-scroll.
Guard against speculation: build **only** what the blog needs; do not add options for
hypothetical callers — the shared placement is justified by the non-exported-splitter
constraint alone, not by imagined reuse.

### Bundle weight & lazy loading
`tts-engine.ts` (main thread) does **not** import kokoro-js — the heavy deps live in the
worker chunk, loaded only when a worker spawns (V, `tts.worker.ts:13-20` comment +
engine source). Still, the island must `import()` the reader/engine **on first click**
(mirroring `apps/web/src/lib/chat-tts-stream.ts`'s lazy-import discipline,
current-tts.md §1) so blog visitors who never press Listen pay only the chip's few KB.
The React runtime is already on every blog page (`A11yProvider client:load`), so the
island's marginal hydration cost is small (I). A task should still *measure* the built
island chunk size.

### Settings interaction
- **Voice: read `useA11yStore.ttsVoice`** (store already hydrated on blog pages). One
  shared voice preference across chat and blog — one mechanism, no second store. A
  mid-read voice change in the widget applies from the next chunk (each `speak()` takes
  the voice) — acceptable; do not build per-article voice pickers (speculative).
- **`ttsEnabled` / `streamChatAloud`: do NOT gate the blog button on them.** Those are
  chat-aloud *opt-in* gates; pressing Listen *is* the consent. Gating would make the
  button dead for ~100 % of visitors (defaults are false) — a fail-closed of the wrong
  thing.
- **Must NOT be forked (hard constraints for every task):** model id/dtype/device
  (unreachable if you use `getTtsService()` — the dedup guarantee from
  `origin-and-dedup.md` depends on this), `TTS_VOICES`, chunker/splitter/normalizer,
  the worker protocol. `unlockAudio()` must be called inside the click handler (iOS).

**Confidence: high.**

## Axis (d) — Disclaimer UX

### Option D1 (recommended) — first-use consent popover + tiny persistent affordance
Before any bytes move, the first click opens a small popover anchored to the chip:
size-honest, CDN-honest (VocoLoco precedent, tts-landscape.md §3.4/§5), with
"Download & listen" / "Not now". Once the model is cached, later clicks start instantly;
a small info icon (or the popover reachable from the pill) keeps the privacy statement
one tap away. Serves: show-trust-don't-claim-it (DESIGN principles), explicit consent for
a ~90 MB mobile-data download, no byline clutter ("the content is the interface").
### Option D2 — permanent caption under the byline
Always-visible one-liner. **Rejected as the sole mechanism:** it can't carry the
download-size consent moment honestly (the size matters *before* the first click, and
permanently repeating it afterwards is noise), and it adds standing chrome to every post
for a feature most readers won't use. A caption *inside the expanded/downloading state*
is fine; a permanent one is not.

### Wording candidates (HushBox voice: precise, technical-but-human, never selling)
Both deliberately split the two claims (synthesis is local ∕ first download is a normal
CDN fetch) per the tts-landscape.md §5 synthesis — an unqualified "nothing ever leaves
your device" would be false on first run:
- **Candidate 1 (fuller, popover body):**
  "This post is read by a voice model that runs entirely in your browser — the text is
  never sent to our servers, or anyone's. The first listen downloads the model (~90 MB,
  one time) from Hugging Face's CDN; that request shows them your IP address, like any
  file download. After that, it's cached and works offline."
- **Candidate 2 (tighter):**
  "The voice runs on your device. Nothing you read is sent anywhere. First listen
  fetches the ~90 MB model from a CDN — once, cached after that."
  (Plus a "What does the CDN see?" expando carrying the IP/user-agent detail.)
Recommend Candidate 1 verbatim in the popover, Candidate 2's first sentence as the
downloading-state caption. **Caveat:** the exact CDN host claim must be re-verified after
the CSP fix (if we route/allow different hosts, the copy names the wrong party).
**Confidence: high** on shape, med on final copy (founder is the voice owner).

---

## Task decomposition sketch (advisory)

1. **CSP verification/fix** (blocker, independent): determine the exact hosts
   transformers.js + onnxruntime-web fetch (model shards, tokenizer, `.wasm`); add them
   to `connect-src` in `scripts/generate-headers.ts`; pin with a test. Benefits chat TTS
   too.
2. **`packages/ui`: document-reader module** (+ chunk→range progressive matcher with
   block-level fallback) + full unit tests using `_setWorkerFactoryForTesting`. Export
   subpath. Include the mapping spike first — if the matcher can't be made robust,
   escalate to the M2 chunker-offset decision before proceeding.
3. **`packages/ui` export surface**: expose whatever the island legitimately needs
   (likely only the new reader + existing progress formatters via the reader).
4. **`apps/marketing`: `ListenToPost` island** — chip states, popover (D1 copy),
   floating stop pill, `CSS.highlights` registration + fallback detection, auto-scroll
   with reduced-motion handling; dynamic import on click; tests.
5. **`[slug].astro` byline integration + styles**: `ml-auto` slot, `::highlight()` rules
   in `global.css` (light + `.dark`), verify against contrast tiers/inversion (widget).
6. **Measurement & docs**: built island chunk size; DESIGN.md/doc touches if any copy is
   canonicalized.
Dependency order: 1 ∥ 2 → 3 → 4 → 5 → 6.

## Risks / unknowns for the human

1. **CSP blocker above** — must be resolved first; also a latent chat-TTS defect (I).
2. **Mobile Safari memory**: `WORKER_POOL_SIZE = 4` ≈ ~320 MB resident (V comment,
   `tts-engine.ts:16-21` "mobile Safari has a tight per-tab budget"). Blog readers on
   phones are a bigger share than chat power-users; a tab jetsam mid-article is a real
   possibility. Options: accept (chat has identical exposure) or make pool size a `load()`
   parameter (engine change). Unruled.
3. **Custom Highlight API support matrix** unverified this session (A) — task 4 must
   feature-detect and ship the block-level fallback regardless.
4. **No load-cancel API** — recommendation omits cancel (consent precedes download);
   confirm that's acceptable, else a small engine addition is needed.
5. **E2E/test strategy**: vitest covers everything via the injected worker factory; a
   real-model E2E means a ~90 MB download in CI — recommend *no* live-model E2E
   (align with the cassette philosophy: no charged/heavy external calls in the hot
   path); if an E2E is wanted for the flow, it needs a stub worker knob (same pattern
   the message-queue feature needed). Unruled.
6. **Dev-mode cache split**: Vite and Astro dev servers are different origins locally ⇒
   model downloads twice in dev only (V, origin-and-dedup.md). Cosmetic; document it.
7. **`data-reading` as extraction root** — adopting an existing typography marker as a
   behavioral contract (blog-architecture.md §2 flags it as new association). Cheap
   either way; needs a one-line ruling.
8. **Word-level highlighting** rejected for v1 (no timestamps in the ONNX export) —
   record as a deliberate limit so it isn't re-litigated; re-entry condition = the
   `Kokoro-82M-v1.0-ONNX-timestamped` repo gaining real documentation.
