# Fully-local, in-browser "read this page aloud" TTS — landscape research (as of 2026-07-23)

Research task, not an implementation plan. Every claim below is tagged **Verified** (fetched
the primary source this session) or **Inferred** (deduced from sources but not stated
outright by a primary source). No claim is left as bare "Assumed."

---

## 1. Local browser TTS engines

### 1.1 kokoro-js / Kokoro-82M (ONNX, via transformers.js)

- **Package**: `kokoro-js` on npm, current version **1.2.1**, license **Apache-2.0**,
  author hexgrad (Kokoro's creator), maintained by Xenova (transformers.js's author).
  Verified via `npm registry` (https://registry.npmjs.org/kokoro-js/latest).
- **Downloads**: ~101,633/week (2026-07-16 to 2026-07-22). Verified via
  https://api.npmjs.org/downloads/point/last-week/kokoro-js. High for a niche package —
  Inferred that this reflects real production adoption, not just CI noise, given it's a
  named dependency of multiple demo apps found in this research (kokoroweb.app etc.).
- **Dependencies**: `@huggingface/transformers` (^3.5.1) and `phonemizer` (^1.2.1).
  Verified from package.json.
- **Model size**: Kokoro-82M is an 82M-parameter model, "resilient to quantization."
  ONNX variants (Verified, https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX):
  - fp32: 326 MB
  - fp16: 163 MB
  - 8-bit (`q8`): 92.4 MB
  - q8f16 (mixed): 86 MB — smallest
  - uint8: 177 MB, uint8f16: 114 MB
  - q4: 305 MB, q4f16: 154 MB
  - 28 voices (American/British, male/female), 24 kHz output.
- **Quality reputation**: broadly described across multiple 2026 sources as **Pareto-optimal**
  among small open TTS models — best quality-per-parameter/quality-per-dollar, and reported
  as reaching #1 on the community TTS Arena leaderboard among free/open models, fastest
  CPU latency in a 12-model comparison (Inferred/aggregated from search-result summaries of
  medium.com, texttolab.com, localaimaster.com, codesota.com — these are secondary/blog
  sources, not fetched directly, so grade this **Inferred**, not Verified).
  Known limitations reported by the same secondary sources: no voice cloning (small training
  set), depends on an external grapheme-to-phoneme step (espeak-ng in Python /
  `phonemizer` npm package in JS) which is a documented failure-mode source, smaller voice
  library (~28) than commercial competitors (ElevenLabs claims 4,000+).
- **Streaming**: Verified — `kokoro-js` README (via npm search result and unpkg) documents
  a streaming API: `TextSplitterStream` + `tts.stream(splitter)`, an async-iterable that
  yields `{ text, phonemes, audio }` chunks as they're generated, intended to be fed
  incrementally into the Web Audio API for progressive/gapless playback. The official ONNX
  model card (Kokoro-82M-ONNX) itself only documents batch (whole-string) generation, so the
  streaming API lives specifically in `kokoro-js`, not in the raw model card examples.
- **WebGPU/WASM support**: Verified — official usage example:
  ```js
  const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: "fp32",   // recommended for WebGPU
    device: "webgpu", // "wasm" (web CPU) or "cpu" (node)
  });
  ```
  Common pattern in production demos (Inferred, from aggregated blog/demo descriptions):
  runtime-detect WebGPU; if present, use `device:"webgpu"` + `dtype:"fp32"`; else fall back
  to `device:"wasm"` + `dtype:"q8"`. A live WebGPU demo exists at
  https://huggingface.co/spaces/motionlabs/kokoro-webgpu (Verified it runs Kokoro via
  Transformers.js in-browser with WebGPU, titled "Kokoro Text-to-Speech (WebGPU)"; the
  README itself gives no benchmark numbers).
- **License**: Apache-2.0 for both the `kokoro-js` package and the ONNX model weights.
  Verified (npm package.json; HF model card).

### 1.2 transformers.js (the underlying runtime kokoro-js sits on)

- **Package**: `@huggingface/transformers` on npm, version **4.2.0**, license **Apache-2.0**.
  Verified via npm registry.
- **Downloads**: ~1.7M+/week class of package (large; exact figure not re-verified this
  session beyond registry metadata, but its role as the general-purpose in-browser ML
  runtime — "Run 🤗 Transformers directly in your browser, with no need for server!" — is
  Verified from its own package description).
- Supports WebGPU and WASM (onnxruntime-web) backends; ships `onnxruntime-node` for Node
  and `onnxruntime-web` for browser. Verified from package.json dependencies.

### 1.3 piper-tts-web (`@mintplex-labs/piper-tts-web`, fork of `@diffusion-studio/vits-web`)

- **Package**: `@mintplex-labs/piper-tts-web`, version **1.0.4**, license **MIT**.
  Verified via npm registry and GitHub README
  (https://raw.githubusercontent.com/Mintplex-Labs/piper-tts-web/master/README.md).
- Wraps Rhasspy's **Piper** voices (MIT-licensed) compiled to WASM via ONNX Runtime.
  Voice models found in community write-ups at roughly **60 MB** for a
  `en_US-hfc_female-medium` voice (Inferred from a secondary blog source describing a
  production write-up, not independently re-verified against the model file itself).
- **Caching mechanism — distinct from transformers.js**: Verified from the official README —
  it uses the **Origin Private File System (OPFS)**, not the Cache API:
  > "initial run [of] predict function you download [a] model [which] will then [be]
  > stored in Origin private file system"
  It exposes explicit management APIs: `tts.download(voiceId, onProgress)`,
  `tts.stored()` (list cached voices), `tts.remove(voiceId)`, `tts.flush()` (clear all).
  This is a meaningfully different caching model from kokoro-js/transformers.js's
  Cache-API approach — OPFS gives the app direct, queryable control over what's cached
  and its size, at the cost of being a separate storage quota bucket from the HTTP Cache.
- **WASM only** (no WebGPU) per the README/usage examples reviewed. Quality: praised in a
  secondary blog write-up as "decent, much better [than] built-in speechSynthesis," with
  noted rough edges around Web Worker module paths, ES imports, and CSP/blob-URL config
  (Inferred — single blog source, not independently corroborated).
- **npm package health**: single small maintainer team (Mintplex Labs / AnythingLLM),
  fork lineage from `@diffusion-studio/vits-web`; not independently downloads-checked this
  session.

### 1.4 sherpa-onnx (k2-fsa) — WASM build

- **Package**: `sherpa-onnx` on npm, version **1.13.4**, license **Apache-2.0**.
  Verified via npm registry (https://registry.npmjs.org/sherpa-onnx/latest).
- **Downloads**: ~42,578/week. Verified via npm downloads API.
- Broader scope than kokoro-js/piper-tts-web: one C++/ONNX runtime ("Next-gen Kaldi")
  covering STT, TTS, speaker diarization, and speech enhancement, with a dedicated WASM
  build path documented at https://k2-fsa.github.io/sherpa/onnx/tts/wasm/index.html
  (Verified — page confirms a WASM TTS build path and links live Hugging Face Space demos
  for English/German TTS, but the page itself does not state model sizes, license, or
  streaming details — those live in linked sub-pages not independently re-fetched here).
- Its TTS side supports multiple model families through one runtime: VITS/Piper voices
  (e.g. `vits-piper-en_US-libritts_r-medium`, ~75 MB, 904 speakers; smaller Piper voices in
  the 61–75 MB range) and, per community discussion threads, **Kokoro models** as well
  (Inferred — from a GitHub discussion title referencing "Kokoro + Piper + VITS" combined
  in one sherpa-onnx-based app; not confirmed against sherpa-onnx's own docs this session).
  This makes sherpa-onnx notable as a single runtime that can host Kokoro-class models
  without transformers.js, if that ever matters for the project.
- No streaming/callback API details or quality benchmarks were found in the pages fetched
  this session — flagged as a **gap**, see below.

### 1.5 Browser-native `speechSynthesis` (Web Speech API) — the zero-download baseline

- Universally available (all major browsers), zero download, zero model management.
  Verified from MDN's Web Speech API docs summary and multiple cross-browser-support
  aggregator pages.
- **Critical caveat for a "runs locally" claim**: not all `speechSynthesis` voices are
  local. Chrome (and Chromium-based Edge) offer both OS-local voices and
  Google-cloud-backed "remote" voices (e.g., "Google US English"); the remote voices
  **send the utterance text to Google's servers** and require network access. Verified
  (aggregated across a Chromium design-doc discussion and multiple technical blogs): each
  `SpeechSynthesisVoice` object exposes a `localService` boolean; filtering on
  `voice.localService === true` is the documented way to guarantee on-device-only
  synthesis. This directly matters for any "nothing sent to servers" claim built on top of
  the native API — such a claim is **false** unless the code explicitly restricts voice
  selection to `localService === true`.
- Other documented quirks (Inferred, aggregated from multiple secondary sources, not a
  single authoritative doc): voices load asynchronously and `getVoices()` can return `[]`
  on first call (must listen for `voiceschanged`); Chrome silently truncates/cancels very
  long utterances (~15s) requiring chunking into shorter queued utterances; Chrome/Safari
  throttle background-tab speech.
- Quality: OS-dependent and generally rated well below Kokoro/Piper-class neural models for
  naturalness — this is the universal fallback tier, not the target quality bar.

### Comparison summary

| Engine | Size | License | Streaming | WebGPU | Cache mechanism | npm health |
|---|---|---|---|---|---|---|
| kokoro-js (Kokoro-82M) | 86 MB–326 MB (quant-dependent) | Apache-2.0 | Yes (`tts.stream`) | Yes (`device:"webgpu"`) | Cache API (via transformers.js) | ~101k dl/wk, active |
| piper-tts-web | ~60 MB/voice (typical) | MIT | Not confirmed | No (WASM only) | OPFS (explicit APIs) | small team, active |
| sherpa-onnx (wasm) | model-dependent (61–904 MB range across voices) | Apache-2.0 | Not confirmed this session | Not confirmed (WASM-first) | Not confirmed this session | ~42k dl/wk, active |
| speechSynthesis | 0 (built-in) | N/A (browser API) | N/A | N/A | N/A (OS-provided) | N/A |

---

## 2. Model download & caching — same-origin vs cross-origin (load-bearing section)

### 2.1 How transformers.js / kokoro-js cache weights

Verified from Hugging Face's own transformers.js caching reference
(https://github.com/huggingface/skills/blob/main/skills/transformers-js/references/CACHE.md):

- In the **browser**, transformers.js uses the **Cache API** (`caches` / `CacheStorage`,
  the same mechanism Service Workers use) to store downloaded model files — **not**
  IndexedDB. The doc explicitly frames it as "uses Cache API to store models," linking to
  MDN's Cache API reference.
- Flow: model files download from the Hugging Face Hub → stored in Cache Storage → later
  loads are served from cache with no network request → cache persists across reloads and
  browser sessions.
- Controlled by `env.useBrowserCache` (default `true`; setting it to `false` is explicitly
  flagged "not recommended," useful only for dev/debug — re-downloads every load).
- A custom-cache escape hatch exists (`env.useCustomCache` + `env.customCache` implementing
  a `{match, put}` interface, e.g. to back onto S3) but that's server/Node-oriented, not
  relevant to a pure client-side blog+app case.
- Storage quotas (Verified from the same doc): Chrome ~60% of available disk (subject to
  eviction), Firefox ~50%, **Safari ~1 GB per origin** (with a prompt for more) — Safari's
  1 GB ceiling is the tightest constraint and is per-origin, reinforcing the origin-scoping
  fact below.

`piper-tts-web` instead uses **OPFS** (Origin Private File System) with its own explicit
`download`/`stored`/`remove`/`flush` API (Verified from its README, §1.3 above) — a
different storage bucket from the Cache API, but **equally origin-scoped** (OPFS is
part of the same-origin storage model).

### 2.2 Same-origin sharing: automatic

Two different pages on the exact same origin (same scheme + host + port — e.g. two routes
of the same SPA, or a static blog served from the identical origin as the app) **do**
transparently share the Cache Storage / OPFS bucket. A second page load that calls
`KokoroTTS.from_pretrained(...)` with the same model id and dtype hits the existing cache
entry and skips the network download. This is a direct consequence of the Cache API/OPFS
same-origin storage model — Verified as a general web-platform fact (Cache API and OPFS
are both scoped to "origin" in the same-origin-policy sense; this is documented behavior
of the underlying browser storage APIs, not something transformers.js adds on top).

### 2.3 Cross-origin / cross-subdomain sharing: **not possible today**

This is the load-bearing fact for "share one downloaded model between a chat app and a
blog on a different host or subdomain":

- **Verified**, from Hugging Face's own "Cross-Origin Storage" announcement post
  (https://huggingface.co/blog/cross-origin-storage): today, browser HTTP/Cache storage is
  **partitioned by origin** specifically to prevent cross-site timing/history-leak attacks.
  Two different origins requesting the byte-identical model file from the same CDN URL each
  independently download and store their own copy — **there is no sharing mechanism between
  origins in shipped browsers today.** The post's own demo shows this costing a duplicate
  177 MB Whisper download plus a ~4.7 MB ONNX Runtime WASM re-fetch for every new
  origin that uses the same model.
- `app.hushbox.ai` and a blog on a different subdomain (or different registrable domain)
  **are different origins** under the same-origin policy (origin = scheme + host + port);
  a differing subdomain alone is sufficient to make them separate origins, so — regardless
  of whether they're "the same brand" or same eTLD+1 — the Cache API/OPFS storage for one
  is invisible to the other. **Inferred** (this is a direct, well-established consequence
  of the same-origin policy referenced in the source above, not a special transformers.js
  behavior — no source needed to independently re-derive it, but it is not itself
  explicitly spelled out for the exact subdomain case in the fetched blog post, hence
  Inferred rather than Verified word-for-word).
- **The fix in progress is NOT shipped**: the **Cross-Origin Storage (COS) API** is an
  early-stage W3C/Chrome proposal (Verified, same source) that would let sites store/fetch
  large files keyed by **SHA-256 content hash** rather than origin+URL, with browser-side
  hash verification and a privacy "availability gating" mechanism (the browser may deny
  knowledge of a rarely-seen file to prevent it being used as a cross-site tracking
  signal). Status, Verified from the same post:
  - "The Cross-Origin Storage API [is an] early-stage proposal [that] isn't final."
  - **No browser ships it natively today.** Chrome is only *considering* implementation
    (tracked on Chrome Status); a Chrome-extension polyfill exists for experimentation.
  - transformers.js has **experimental, opt-in** support: `env.experimental_useCrossOriginStorage = true` (added via PR #1549), which resolves each model file's SHA-256 (from its Hub
    Xet-tracked pointer metadata) and uses that as the COS key; without COS present in the
    browser, it silently falls back to the normal Cache API — so enabling the flag today is
    safe but doesn't currently buy anything in a browser without COS support.
  - WebLLM and wllama are cited as other projects experimenting with COS.

**Bottom line for the user's stated goal** ("one downloaded model shared between a chat app
and a blog"): **if app and blog are on the same exact origin, sharing is automatic and free.
If they are on different subdomains or different domains, there is currently no way to share
the cached model bytes across them** — each origin will independently download and cache its
own copy of the same model, until/unless the Cross-Origin Storage API ships in browsers (not
yet, as of mid-2026, per the source above) and both sites explicitly adopt it. A practical
same-origin-forcing workaround (e.g., serving the blog from a path/subdomain configuration
that shares the app's origin, or hosting both behind one origin with routing) is an
architecture decision outside the scope of this research task.

---

## 3. UX patterns from leading read-aloud implementations

### 3.1 Speechify (browser extension / app)

Per Speechify's own marketing copy and third-party comparison writeups (Inferred —
extension listing pages, not deeply fetched for exact microcopy this session):
- **Synchronized highlighting** of the currently-spoken section as a core differentiator,
  explicitly framed as a comprehension/retention and accessibility aid.
- Playback speed range **0.25x–3x**, sleep timers, bookmarks/notes/clips, cross-device
  position sync.
- Chrome Web Store rating ~4.5/5 (Verified as a numeric fact appearing in aggregated
  search results, not independently re-fetched from the store page itself — grade
  Inferred).

### 3.2 ElevenReader (ElevenLabs)

- Positioned around voice **naturalness** as the primary differentiator (marketing claims
  of "89.6% naturalness" style scoring appear in third-party comparison content — Inferred,
  not independently verified against ElevenLabs' own benchmark page this session).
  Highlighting exists but is framed as more of an accessibility feature in the mobile app
  than a headline UX differentiator, per the aggregated comparison source.
- Chrome Web Store rating ~4.6/5 (same grading caveat as above — Inferred).

### 3.3 Microsoft Edge "Read Aloud"

Verified pattern (aggregated across several how-to guides, consistent details across
sources so treated as reliable, though no single official page was deep-fetched):
- **Playback controls toolbar** appears beneath the address bar: play/pause, skip
  forward/back one paragraph.
- **Keyboard shortcuts** while focused: Space toggles play/pause, Esc stops and closes the
  toolbar.
- **Voice + speed controls** live in a "Voice options" menu; speed changes apply
  instantly without restarting playback; Edge caps the top speed at "Fast" — a frequently
  requested-but-missing "faster" tier is called out as a known limitation.
- **Highlighting + auto-scroll**: the currently-read text is highlighted and the page
  auto-scrolls to keep the highlighted region in view.
- Works on web pages, PDFs, and (desktop) eBooks; available online or offline (uses local
  OS voices when offline); on mobile, PDF support is absent.
- Firefox's Reader View "Listen" feature and Safari's Reader follow a broadly similar
  content-extraction-then-`speechSynthesis`-narration pattern (Inferred/aggregated,
  consistent across several secondary sources but no official Mozilla/Apple doc was
  fetched this session) — a shared limitation across all native browser reader-mode TTS
  features: they only activate on pages the browser's readability heuristics recognize as
  "article content"; app-like pages, dashboards, and social feeds are excluded.

### 3.4 First-use model-download disclosure (local-model apps specifically)

Two concrete, fetched examples of how local-model TTS web apps present the one-time
download to users:

- **kokoroweb.app** (Verified, fetched page content):
  - Size disclosure: *"Storage: first model load (~150MB) cached locally via browser
    cache."*
  - Progress guidance: *"If first load [is] slow, keep tab active until progress bar
    completes."*
  - Reassurance about the one-time cost: *"Subsequent sessions [are] dramatically faster
    thanks [to] cache hits."*
  - Offline framing: *"After first load, inference runs fully offline"* / *"After initial
    download, you can disconnect from network [and] continue generating audio."*
- **VocoLoco** (Verified, fetched page content):
  - Explicit numeric transparency about first-run network exposure — notably candid about
    a privacy nuance most competitors don't mention: *"model weights (~2.5 GB) come [from]
    Hugging Face [and] jsDelivr[; t]hese downloads expose your IP address, browser
    user-agent, [and] referrer [to those] services."*
  - Progress-UI changelog specifics: *"Accurate download progress[,] size[, and] time
    remaining, first-run setup screen"* (v1.2.0); earlier versions made first-run
    downloads *"sequential [with] clear per-file progress"* while parallelizing loads once
    models are already cached (v1.1.3).
  - A visible *"Loading models..."* state during startup, and Settings-page transparency
    that clearing cache means the (in this app's case, larger — ~3 GB total) model set
    must be re-downloaded.

Pattern synthesized across both (Inferred, from the two Verified examples above): leading
local-TTS-in-browser apps (a) disclose an approximate download size up front, (b) show a
real (not fake/simulated) progress bar keyed to actual bytes transferred, (c) explicitly
tell the user the tab must stay active/foregrounded during the first download, and (d)
reassure the user that the cost is one-time and that subsequent visits are instant/offline.

### 3.5 Sentence/word highlighting sync — how the timing is actually obtained

This is the mechanism question underlying all of the above highlighting UX, and it
generalizes across implementations (Verified/Inferred breakdown below): none of the
fetched sources describe a production browser read-aloud feature that highlights at true
per-word precision using a locally-run neural TTS model's own native alignment output,
in-browser. The options in practice (Verified from the Kokoro-specific deep-dive in §4)
are approximation-based, and this is consistent with how `speechSynthesis`-based readers
(Edge/Firefox/Safari) work too — Edge's own highlighting is described only as
paragraph/sentence-granularity + auto-scroll, not claimed as tight word-level sync in the
sources reviewed, which is consistent with `speechSynthesis`'s own `boundary` event
(word/sentence boundary events fired by the OS synthesizer, timing entirely owned by the
underlying engine, not independently computed by the page) being the only native timing
signal browser-native TTS exposes at all.

---

## 4. Sentence/word-level timestamp support in local engines — does kokoro-js expose it?

**Verified, from a hands-on technical blog that built exactly this**
(https://ryanwelch.co.uk/blog/kokoro-word-timestamps/):

- **Python (`kokoro` package): yes, natively.** The Python pipeline
  (`KPipeline(lang_code=...)`) exposes token-level timing objects during synthesis — each
  token carries `text`, `start_ts`, `end_ts`, and whitespace info — sufficient to
  reconstruct word-level spans directly from the model's own output, with no forced
  aligner or STT round-trip needed. The author's own words: this is "enough to rebuild
  word spans [from] the model output itself."
- **JavaScript (`kokoro-js` / the ONNX export): no, not natively.** Per the same author:
  "because [the] ONNX model itself [does] not expose [the] required outputs, not just
  because [of the] JS library" — i.e. this is a limitation of what the ONNX export
  surfaces, not merely a `kokoro-js` API gap. (Note: the HF model repo
  `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` exists and its name implies
  timestamp support, but the model card fetched this session contains **no documentation
  or code examples** for extracting word/sentence timestamps despite the name — flagged
  as a gap below.)
- **The practical workaround used in the JS/browser case (Verified, same source):
  chunk-duration approximation, not forced alignment and not an STT round-trip.**
  `kokoro-js`'s `tts.stream(...)` yields chunks with `chunk.text` and `chunk.audio`; the
  author computes each chunk's duration from `audio.length / sampleRate`, then evenly
  distributes that duration across the chunk's characters, and merges character-level
  spans into word spans by splitting on whitespace — producing approximate `startMs`/
  `endMs` per word with **no ML alignment step at all**.
- Why this approximation is judged acceptable in practice (Verified, same source):
  `kokoro-js` streams **sentence-by-sentence by default**, which bounds how far the
  linear-interpolation error can drift within any one highlighted span; the author notes
  that at sentence/phrase-level highlighting granularity, "the Python vs. JS difference
  [is] hard [to] notice," even though the Python token-level approach is objectively more
  accurate.
- For higher-fidelity alignment, the same author points to a follow-up approach using a
  forced aligner (mentioned: Qwen3-TTS-based) run as a post-process — i.e., the
  STT-roundtrip/forced-alignment pattern that a separate Medium article
  (https://bar-offner.medium.com/syncing-speech-with-text-adding-timestamps-to-text-to-speech-using-python-13fe433b30a0,
  surfaced in search but not independently fetched this session — **Inferred** only) also
  describes as the general-purpose fallback whenever a TTS engine doesn't expose native
  alignment: run the generated audio back through an STT model like Whisper
  (`whisper-timestamped`) to recover word timings after the fact.
- **sherpa-onnx / piper-tts-web**: no timestamp/alignment capability was found in any
  source fetched this session for either engine — flagged as a **gap**, not a confirmed
  absence.

**Distilled answer to "does kokoro-js expose timings for highlight sync": no — not
natively, not even via the ONNX model export. Any word-level highlight sync built on
kokoro-js in the browser today has to be approximated (even split of chunk duration
across characters/words), not model-derived. Sentence-level (not word-level) sync is
comfortably achievable natively, since `kokoro-js` already segments and streams
sentence-by-sentence and each chunk carries its own audio duration.**

---

## 5. Privacy-disclaimer wording examples ("runs locally, nothing sent to servers")

Verbatim examples collected from fetched pages (all Verified — quoted from the actual
page content retrieved this session):

- VocoLoco, main claim: **"All speech synthesis runs locally in [the] browser. No audio,
  text, or voice data [is] uploaded [to] any server."**
- VocoLoco, settings section: **"All data is stored locally in [the] browser using
  IndexedDB. Nothing [is] sent [to] any server."**
- VocoLoco, footer tagline: **"Synthesis runs locally in [the] browser."**
- VocoLoco, header stat badge: **"0 Uploads"**, labeled **"Privacy [by] default."**
- VocoLoco's more nuanced, harder-to-find-elsewhere caveat about the *download* step
  itself (worth reusing precisely because it's honest about a real gap most competitors
  don't disclose): **"These downloads expose your IP address, browser user-agent, [and]
  referrer [to those] services"** (referring to Hugging Face/jsDelivr as the CDN serving
  model weights on first load), followed by **"Once cached, no further network requests
  [are] made during synthesis."**
- kokoroweb.app, intro claim: **"you can generate natural voiceovers without sending
  text or audio [to] any server."**
- kokoroweb.app, offline-capability claim: **"After first load, inference runs fully
  offline."**

**Pattern to reuse** (Inferred synthesis of the above): the strongest, most defensible
disclaimers separate two distinct claims instead of collapsing them into one blanket
statement: (1) *synthesis/inference* happens 100% locally, and (2) the *one-time model
download* is a normal cross-origin HTTP fetch to a third-party CDN (Hugging Face/jsDelivr
in these examples) that necessarily exposes standard request metadata (IP, user-agent,
referrer) to that CDN, the same as loading any external image or font would. Conflating
these two into a single unqualified "nothing is ever sent anywhere" claim would be
inaccurate for any app that fetches model weights from a public CDN rather than
self-hosting them same-origin.

---

## Gaps / not independently confirmed this session

- Exact quality benchmarks/scores for Kokoro (TTS Arena ranking, "#1 among free models,"
  Elo figures) come only from secondary blog/SEO-style sources aggregated via search
  snippets — none of those specific claim pages were fetched and read directly, so treat
  as **Inferred**, not Verified, despite consistency across several independent write-ups.
- `sherpa-onnx`'s WASM TTS build: streaming/callback API existence, exact license terms
  per-model (Piper voices are MIT per Rhasspy; sherpa-onnx's own wrapper is Apache-2.0, but
  not every bundled model's own license was checked), and direct quality comparison vs.
  kokoro-js were not confirmed — the two GitHub raw README paths attempted for the wasm/tts
  subdirectory both 404'd, and the k2-fsa docs pages fetched didn't carry this detail.
- `piper-tts-web`'s streaming support was not found documented either way (README examples
  shown were all single-shot `tts.predict(...)` calls, not proof of the API's absence).
- The `Kokoro-82M-v1.0-ONNX-timestamped` HF repo's actual timestamp mechanism is unclear —
  its model card, as fetched, does not explain what "timestamped" means or how to use it,
  despite the name. Worth a direct follow-up if word-level sync becomes a hard requirement.
- Exact current (mid-2026) native-browser support matrix for the Cross-Origin Storage API
  (beyond "Chrome is considering it, nothing ships it") was not independently checked
  against caniuse.com or the Chrome Platform Status tracker this session.
- No official ElevenLabs or Speechify page was fetched directly — all ElevenReader/Speechify
  UX claims above rest on search-result summaries of third-party comparison articles, not
  the vendors' own docs.

---

## Sources (fetched this session unless noted)

- https://www.npmjs.com/package/kokoro-js (metadata via `registry.npmjs.org` + downloads API)
- https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
- https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped
- https://huggingface.co/onnx-community/Kokoro-82M-ONNX/blob/main/README.md
- https://huggingface.co/spaces/motionlabs/kokoro-webgpu/blob/main/README.md
- https://github.com/huggingface/skills/blob/main/skills/transformers-js/references/CACHE.md
- https://huggingface.co/blog/cross-origin-storage
- https://raw.githubusercontent.com/Mintplex-Labs/piper-tts-web/master/README.md (via npm registry too: `@mintplex-labs/piper-tts-web`)
- https://registry.npmjs.org/sherpa-onnx/latest + https://k2-fsa.github.io/sherpa/onnx/tts/wasm/index.html
- https://registry.npmjs.org/@huggingface/transformers/latest
- https://ryanwelch.co.uk/blog/kokoro-word-timestamps/
- https://kokoroweb.app/en/blog/kokoro-tts-in-browser-2025-guide
- https://magkino.github.io/vocoloco_tts/
- Search-result aggregations (not individually fetched; used only for Inferred-grade
  claims, cited inline above): medium.com (Kokoro-82M overview), texttolab.com,
  localaimaster.com, codesota.com (2026 TTS model comparisons), speechify.com /
  fahimai.com (Speechify vs ElevenLabs comparison), Microsoft Edge Read Aloud how-to
  aggregator pages (makeuseof.com, ninjaone.com, technobezz.com, microsoft.com/edge
  learning center), MDN Web Speech API docs, Chromium speech-synthesis design discussion
  (groups.google.com/a/chromium.org).
