# Blog read-aloud (local TTS) — SDD plan

Tier 2. Run dir: `docs/plans/runs/2026-07-23-blog-tts/`. Research artifacts in `research/` are authoritative; briefs cite them instead of restating.

## Feature summary

A "Listen" control to the right of the blog-post byline (`apps/marketing/src/pages/blog/[slug].astro`) that reads the post aloud using the existing on-device Kokoro TTS engine in `packages/ui`. Sentence-chunk highlighting of what is being read (default on, toggleable), start/stop, floating stop pill during playback, lazy model download on first click with progress + local-privacy disclosure. Model download is deduplicated with /chat automatically: same origin (`https://hushbox.ai`) + same engine config ⇒ shared browser Cache API entries (`research/origin-and-dedup.md`).

## Founder rulings (2026-07-23)

- No consent popover and no download-cancel: the first click on Listen starts download + playback directly. The disclosure text appears in the download-progress UI (passive, not a gate).
- Disclosure register: short, no em dash, must keep the download disclosure. Canonical copy (Global Constraint G6).
- Engine reused exactly as-is: 4-worker pool, no pool-size parameterization.
- No E2E for this feature: unit/integration coverage only. Recorded as a scope ruling; the CODE-RULES E2E triggers were weighed and the founder ruled them out for v1.
- Word-level highlighting is a deliberate limit for v1 (kokoro-js exposes no timestamps; `research/tts-landscape.md` §4). Re-entry condition: the timestamped Kokoro ONNX export gaining real documentation/support. Chunk-level sync is exact by construction (the reader issues each speak()).

## Global Constraints

- **G1 — One engine, never forked.** All speech goes through the existing `getTtsService()` engine in `packages/ui/src/components/accessibility/lib/tts-engine.ts`. Model id, dtype/quantization, device, voices, worker protocol, and transformers.js env settings are never redeclared or overridden anywhere in this feature. This is what guarantees cache-key-identical downloads between /chat and /blog.
- **G2 — Lazy weight.** No kokoro-js / onnxruntime / engine code in the marketing page's initial JS. The reader module loads via dynamic import triggered by the first click on Listen. The byline chip itself is a light island.
- **G3 — Accessibility.** Chip and pill are real buttons, keyboard operable, labelled (`aria-pressed` on the chip, visible focus). Esc stops playback. Auto-scroll and highlight transitions are instant under `prefers-reduced-motion` and the widget's stop-animations setting. Highlight colors come from theme tokens and must pass contrast in light and dark.
- **G4 — Reuse the existing chunking pipeline** (`sentence-chunker.ts`, `sentence-splitter.ts`, `text-normalizer.ts`) unmodified. The sentence chunk is the highlight unit.
- **G5 — Voice setting is shared** with the accessibility widget (`useA11yStore` ttsVoice). Blog playback does NOT gate on the widget's ttsEnabled / chat-read-aloud toggles; clicking Listen is the intent.
- **G6 — Canonical disclosure copy** (shown in the download-progress UI, and as the chip's info tooltip after first load): `Local text to speech. First listen downloads the voice model (about 90 MB, one time).` No em dashes anywhere in feature copy. (Amended 2026-07-23 per founder.)
- **G7 — packages/ui rules apply:** TDD, 95% per-file coverage, explicit return types, no new npm dependencies, kebab-case files, colocated tests, Zod where external input is parsed (none expected).
- **G8 — Surgical:** no edits to chat TTS behavior or the engine's public API. Sanctioned shared-surface touches only: T1's headers change, T4's store-schema addition, and T5's extraction of the accessibility widget's download-progress bar into a shared component (behavior-preserving refactor of `sections/audio.tsx`).
- **G9 — No borders, no card box.** The reader area has no border stroke AND no background fill: the download bar, controls, and disclosure are placed directly on the page as a right-aligned centered stack (founder: "we don't do borders" / "remove the background, just place the elements on the screen"). Buttons keep their own tinted fills; the container is invisible.

## Interfaces

- **document-reader (produced by T2, consumed by T3/T4):**
  ```ts
  createDocumentReader(opts: {
    container: HTMLElement;            // article.prose-blog[data-reading]
    voice: TtsVoiceId;                 // from useA11yStore
    onChunk: (e: { index: number; blockEl: HTMLElement; text: string; startOffset: number; endOffset: number }) => void;
    onState: (s: 'idle'|'loading'|'speaking'|'stopped'|'error') => void;
    onDownloadProgress: (p: { pct: number }) => void;
  }): { start(): Promise<void>; stop(): void; readonly chunkCount: number }
  ```
  Extraction: readable block elements in document order (`p, h1..h6, li, blockquote`), skipping `pre` (code blocks are not read). **Offset contract (T2-confirmed, load-bearing for T3):** `voice` is the real exported union `TtsVoice` (the plan's earlier `TtsVoiceId` name does not exist — use `TtsVoice`). `startOffset`/`endOffset` index `normalizeForSpeech(blockEl.textContent)` — the block's *normalized* text, NOT raw DOM text nodes — such that `text === normalizeForSpeech(blockEl.textContent).slice(startOffset, endOffset)`. T3 must recompute that same normalized string and tolerantly map the span back onto the block's raw text nodes to build the DOM Range, keeping its own block-level fallback on match failure.
- **highlighter (produced by T3, consumed by T4):**
  ```ts
  createChunkHighlighter(container: HTMLElement): {
    highlight(e: { blockEl: HTMLElement; startOffset: number; endOffset: number }): void;
    clear(): void;
  }
  ```
  CSS Custom Highlight API when available; whole-block class fallback otherwise. Auto-scroll only when the target is outside the viewport; instant under reduced motion. Tolerant text-to-Range matching; on match failure fall back to block-level highlight, never throw.
- **Blog island (T4):** `BlogReadAloud` React component exported from `packages/ui`, mounted in `[slug].astro` byline row.

## Tasks

### T1 — CSP + model-source: make the on-device TTS model download work under the enforced CSP, and prove it

- **Objective:** the deployed SPA CSP blocks every host the Kokoro engine needs; make the model download load under the enforced policy by allowlisting the Hugging Face model hosts and self-hosting onnxruntime's WASM (so no third-party CDN enters the policy), sourced from one shared constant, and guard it with a unit derivation test plus one browser CSP test.
- **Design context (authoritative: `research/legacy-csp.md`, `research/e2e-csp-feasibility.md`):** Verified — the deployed origin/main `buildSpaHeaders` `connect-src` has ZERO Hugging Face hosts and is byte-identical to the current repo; and the Kokoro engine **is** in deployed origin/main (`packages/ui/.../tts-engine.ts`, `tts.worker.ts`), so this is a real latent/live production gap in existing chat TTS, not rewrite-only. The engine fetches config/tokenizer from `https://huggingface.co` (transformers.js `env.remoteHost` default) and weight/voice files that 302-redirect to HF's Xet CDN on `https://*.hf.co` (the classic `cdn-lfs.huggingface.co` is NOT used for model `onnx-community/Kokoro-82M-v1.0-ONNX`; wildcard needed because the Xet subdomain is region-variable). onnxruntime-web's `.wasm` is currently CDN-fetched from `https://cdn.jsdelivr.net` at runtime via transformers.js `env.backends.onnx.wasm.wasmPaths`. **Founder decisions (2026-07-24):** model from HF CDN (allowlist `huggingface.co` + `*.hf.co`); onnxruntime WASM **self-hosted** same-origin (do NOT add jsdelivr to CSP); test with both a unit derivation test and one small browser CSP test appended to an existing E2E spec. CSP is enforced in E2E via `scripts/lib/headers-vite-plugin.ts` on the `vite preview` server (Verified); jsdom/happy-dom do not enforce CSP.
- **One-Implementation-Shared:** the HF `connect-src` host set is ONE shared constant at the narrowest scope both callers share (candidate: `packages/shared`), imported by both `tts.worker.ts` (which sets `env.remoteHost` from it) and `scripts/generate-headers.ts` (which adds the hosts to `connect-src`). No mirrored/hardcoded list plus a sync-check test — that is the exact drift this fix removes.
- **Acceptance criteria:** (1) `buildSpaHeaders` `connect-src` gains `https://huggingface.co` and `https://*.hf.co` (and ONLY those — no jsdelivr, no broader wildcard than `*.hf.co`), sourced from the shared constant; (2) `tts.worker.ts` sets `env.backends.onnx.wasm.wasmPaths` to a same-origin path, and the onnxruntime-web `.wasm`/`.mjs` assets matching the installed version are emitted into BOTH the web build and the marketing build so that path resolves same-origin at runtime with no jsdelivr fetch — report shows the served path and that each built `dist` contains the files; (3) [AMENDED 2026-07-24 — library reality] the model host is NOT pinned via the worker: kokoro-js@1.2.1's exported `env` is a wrapper exposing only `wasmPaths` (orchestrator-verified: `Object.keys(env)===['wasmPaths']`, no `.backends`/`.remoteHost`). transformers' default `remoteHost` is `https://huggingface.co`, which equals the shared constant's primary host; the shared `tts-hosts.ts` constant remains the single source for the CSP `connect-src`, and the scripts derivation test guards the CSP side. Do NOT add `@huggingface/transformers` as a direct dep to force `remoteHost` (needs approval, violates simplicity). Self-host the WASM via the wrapper setter `env.wasmPaths = TTS_ORT_WASM_PATH`; (4) unit derivation test in the `scripts` vitest project asserts the generated `connect-src` is a superset of the shared TTS host constant (fails if the constant grows without a CSP update); (5) exactly one new `test()` block appended to `e2e/marketing-roadmap.spec.ts` (no new spec file), importing `test`/`expect` from the fixtures module per `e2e/CLAUDE.md`, that: attaches a `securitypolicyviolation` listener via `addInitScript` before navigating to `/welcome`, wraps the deliberate violation in `expectConsoleErrors([/Refused to connect|Content Security Policy/i])` (scoped to this test only), asserts a fetch to a deliberately-disallowed host records a violation with matching `blockedURI`, and asserts a fetch to `https://huggingface.co` records NO violation for that origin (assert on `blockedURI`, never on fetch network success — no model download); (6) existing `generate-headers.test.ts` still passes (extend, don't break); coverage maintained per the scripts project's 95% gate; (7) no over-broadening of any other directive.
- **Files:** `scripts/generate-headers.ts` (+ `generate-headers.test.ts`), the new shared host constant (implementer picks the orthodox shared location and notes it), `packages/ui/src/components/accessibility/lib/tts.worker.ts`, the web + marketing build config / `public` assets needed to self-host the WASM, `e2e/marketing-roadmap.spec.ts`. Nothing else. Does NOT touch the `packages/ui` export barrel or `document-reader`/`audio.tsx` (owned by T2/T5) — no file overlap with any concurrent task.
- **Scoped checks:** `pnpm --filter @hushbox/scripts test` · `pnpm test:ui` (worker changed) · `turbo typecheck lint --filter=@hushbox/scripts --filter=@hushbox/ui --filter=@hushbox/shared --filter=@hushbox/web --filter=@hushbox/marketing` · `jscpd --threshold 2` on owned files. Run the new E2E block via the e2e harness if the stack permits; if not, note it for close-phase verification.
- **NEEDS_CONTEXT** if self-hosting the WASM into the marketing (Astro) build proves disproportionately complex vs. the web build — return rather than allowlisting jsdelivr unilaterally (that reverses a founder decision).
- **Sensitive:** security-relevant (CSP is a security control). Auditors: 2 — one correctness lens (does the model actually load same-origin WASM + allowlisted model host end-to-end; do the tests prove enforcement), one security lens (no over-broadening; `*.hf.co` scope; self-hosted WASM is genuinely same-origin; the disallowed-host test truly fails closed).

### T2 — document-reader module (packages/ui)

- **Objective:** a `document-reader` lib module that extracts readable blocks from a container, chunks them through the existing pipeline, and plays them sequentially through `getTtsService()`, emitting the Interfaces contract above.
- **Design context:** `research/design-analysis.md` axis (c), option C2. Composes existing `sentence-chunker`/`sentence-splitter`/`text-normalizer`/engine; nothing reimplemented (G1/G4). `sentence-splitter` may need a public export from the accessibility lib barrel; adding an export is in scope, changing its code is not. Start/stop only; no pause/seek (founder scope).
- **Acceptance criteria:** (1) exact Interfaces signature; (2) extraction covers `p/h1..h6/li/blockquote`, skips `pre`, document order, with offsets that identify each chunk's span in its block; (3) chunks flow through the existing chunker+splitter+normalizer; (4) sequential playback via `getTtsService().speak` with the passed voice, `onChunk` fired at each chunk start, `onState` transitions correct incl. `error` on engine load failure, `onDownloadProgress` forwarded from the engine's progress callback; (5) `stop()` halts audio promptly and is idempotent; (6) new subpath export from `packages/ui` (follow the existing accessibility-lib export pattern); (7) TDD with 95% per-file coverage, engine mocked at the `getTtsService` seam only.
- **Files:** `packages/ui/src/components/accessibility/lib/document-reader.ts` (+ colocated test), the lib barrel/`package.json` exports entry, nothing else.
- **Scoped checks:** `pnpm test:ui` · `turbo typecheck lint --filter=@hushbox/ui` · `jscpd --threshold 2` on owned files.
- **Sensitive:** no. Auditors: 1.

### T3 — chunk highlighter (packages/ui)

- **Objective:** the `createChunkHighlighter` module per Interfaces: chunk-to-Range matching, CSS Custom Highlight API with block-class fallback, auto-scroll.
- **Design context:** `research/design-analysis.md` axis (b), option B1 with the tolerant matcher (M1). The matcher maps `{blockEl, startOffset, endOffset}` (offsets into normalized text) back onto the block's live text nodes; tolerance strategy is the implementer's design, but failure degrades to block-level highlight, never a throw (analyst flagged the matcher as the medium-confidence piece; escalate via BLOCKED if offsets prove insufficient rather than silently changing T2's contract). Feature-detect `CSS.highlights`; fallback applies a class to `blockEl`. Auto-scroll: only when off-viewport; `behavior:'instant'` under reduced-motion/stop-animations (G3). Highlight styling via theme tokens in the ui package's stylesheet (`::highlight()` rule + fallback class), visible in light and dark.
- **Acceptance criteria:** (1) exact Interfaces signature; (2) Highlight-API path builds a Range covering exactly the chunk span when offsets match, verified across blocks containing inline elements (links, `code`, `strong`); (3) fallback class path exercised when `CSS.highlights` is absent; (4) match failure degrades to block highlight without throwing; (5) `clear()` removes all highlight state; (6) scroll behavior per G3, tested; (7) TDD, 95% per-file coverage (happy-dom: Highlight API mocked/feature-detected as needed, both paths tested).
- **Files:** `packages/ui/src/components/accessibility/lib/chunk-highlighter.ts` (+ test), one stylesheet touch for the `::highlight()`/fallback rules, barrel export.
- **Depends on:** T2 (consumes its offset contract).
- **Scoped checks:** `pnpm test:ui` · `turbo typecheck lint --filter=@hushbox/ui` · `jscpd --threshold 2` on owned files.
- **Sensitive:** no. Auditors: 1.

### T4 — Blog Listen UI + marketing wiring

- **Objective:** the user-facing feature: `BlogReadAloud` card component in `packages/ui` and its mount in the blog post header.
- **Design context:** founder-directed rev 4 (2026-07-24), visual reference `research/ui-proposal.html` (authoritative for layout) — **no popups, no floating elements, no appearing/disappearing chrome, no borders (G9).** The card sits **to the right of the author block in the same header band, not a new row**: in `[slug].astro` the byline (`.mt-4 flex items-center gap-3`) and the tags row are wrapped in a left column, with the card as a right sibling in a stretch-aligned flex band, so the card's top edge aligns with the avatar's top and its bottom edge with the bottom of the tags row. The card is width-restricted (~15rem), right-justified against the article text column's right edge, and never overlaps the "On this page" `details` (which stays below the header at full width). Below a narrow breakpoint the card drops under the tags at full width. Card contents, vertically stacked and **centered**: (a) the shared TTS download-bar component (from T5) in reserved space above the controls, animating only while the model downloads ("Preparing the voice" + percent; animation off under reduced motion); (b) the centered controls row: Listen/Stop button + highlight icon toggle (Lucide highlighter icon, `aria-pressed`, default on, persisted via the existing accessibility store schema `store/schema.ts` + `store.ts`) with a tooltip on hover/focus via the shared `Tooltip`/`TooltipTrigger`/`TooltipContent` primitives (`packages/ui/src/components/tooltip.tsx`), same pattern as /chat's `ToggleButtonWithTooltip` (`apps/web/src/components/chat/input/prompt-input.tsx`), tooltip copy `Highlight while reading: on` / `: off` — the tooltip is the one sanctioned hover-transient; (c) the G6 disclosure as **two centered lines**: line 1 `Local text to speech.` line 2 `First listen downloads the voice model (about 90 MB, one time).` The only in-place changes allowed: button label/state Listen⇄Stop, download-bar fill, an added inline error line ("Couldn't start playback. Try again.", no em dash), and the article highlight. The card is NOT sticky (rev 2's sticky bar is superseded by this in-header placement); Stop stays reachable via Esc from anywhere, plus the card itself when in view. The card is a light island; the heavy reader (T2/T3 modules, which pull the engine) loads via dynamic import on first click (G2). Voice from `useA11yStore` ttsVoice (G5).
- **Acceptance criteria:** (1) the card renders to the right of the byline+tags block inside the header band, top-aligned with the avatar and bottom-aligned with the tags row, right edge on the article column's right edge, no overlap with the "On this page" section, and drops below at narrow widths; (2) initial marketing JS contains no engine/kokoro code (dynamic import verified by test or bundle inspection evidence in the report); (3) first click → idle→loading→speaking with the T5 shared download bar animating above the controls during download, no popover/dialog/floating element/layout resize at any point (the stack's footprint does not change size across states), no border strokes and no container background (G9); (4) buttons centered in the card; disclosure rendered as the two exact G6 lines, centered; (5) highlighting active by default, toggleable via the always-visible icon toggle (shared Tooltip primitive on hover/focus), persisted; (6) stop via the card button and Esc, both idempotent; (7) reduced-motion respected (download-bar animation, scroll); (8) a11y: buttons labelled, keyboard path complete, focus visible; (9) component tests in packages/ui with 95% per-file coverage (reader/highlighter/download-bar mocked or used at their module seams); (10) marketing page renders the island interactive without loading the reader.
- **Files:** `packages/ui/src/components/blog-reader/` (component + test + index), `packages/ui/src/components/accessibility/store/{schema.ts,store.ts}` (new persisted pref only), `packages/ui/package.json` export entry, `apps/marketing/src/pages/blog/[slug].astro` (byline row + island import).
- **Depends on:** T2, T3, T5.
- **Scoped checks:** `pnpm test:ui` · `turbo typecheck lint --filter=@hushbox/ui` · `turbo typecheck lint --filter=@hushbox/marketing` · `jscpd --threshold 2` on owned files.
- **Sensitive:** no (public page, no user data). Auditors: 1.

### T5 — shared TTS download-bar component (packages/ui)

- **Objective:** one download-progress bar component used by both the accessibility widget's audio section and the blog reader card (One Implementation, Shared).
- **Design context:** the accessibility widget already renders TTS model-download progress in `packages/ui/src/components/accessibility/sections/audio.tsx`, with rate/ETA helpers in `lib/tts-download-progress.ts`. Extract the progress-bar rendering into a standalone component (thin track + animated fill + label/percent; animation disabled under reduced motion; borderless per G9) and refactor `audio.tsx` to use it, behavior-preserving. T4 consumes the same component with the "Preparing the voice" label. The helpers in `lib/tts-download-progress.ts` stay where they are; only the presentational bar is extracted. Do not change what the widget displays.
- **Acceptance criteria:** (1) a single component renders the download bar for both callers (label, percent, animated fill, `role="status"`); (2) `audio.tsx` uses it with no visual or behavioral change (existing audio-section tests still pass unmodified, or with mechanical-only updates justified in the report); (3) animation disabled under reduced motion; (4) no borders (G9); (5) TDD for the new component, 95% per-file coverage, existing coverage maintained.
- **Files:** new component + test under `packages/ui/src/components/accessibility/` (implementer picks the orthodox spot beside its consumers), `sections/audio.tsx`, barrel exports as needed.
- **Depends on:** nothing (parallel with T1/T2; must land before T4).
- **Scoped checks:** `pnpm test:ui` · `turbo typecheck lint --filter=@hushbox/ui` · `jscpd --threshold 2` on owned files.
- **Sensitive:** no. Auditors: 1.

## Dependency graph

```
T1 (independent)
T2 → T3 ─┐
T5 ──────┴→ T4
```

T1 runs in parallel with everything. T5 runs in parallel with T2/T3 (different files). T4 waits for T2, T3, and T5. The shared `packages/ui` barrel/export files are only ever touched by one in-flight task at a time: T5's export lands before T4 starts, and T2/T3 are serial.

## Related E2E

None (founder ruling above). Close phase runs the unscoped gates plus, stack permitting, a `design-review` pass on a rendered blog post with the feature.

## Amendments

- 2026-07-23 (pre-approval): G6 disclosure copy changed by founder to `Local text to speech. First listen downloads the voice model (about 90 MB, one time).`
- 2026-07-23: UI mock added at `research/ui-proposal.html` (static reference for T4; plan.md criteria remain authoritative).
- 2026-07-23 (rev 2, pre-approval): founder rejected popover/floating-pill UI. T4 redesigned: one permanent sticky reader bar below the byline; all controls + disclosure always visible; no popups/floating/appearing chrome; bar never resizes. Mock updated in place.
- 2026-07-23 (rev 3, pre-approval): highlight toggle is an icon toggle button with the shared `@hushbox/ui` Tooltip on hover/focus (same pattern as /chat's ToggleButtonWithTooltip). Tooltip is the one sanctioned hover-transient.
- 2026-07-24 (rev 5, pre-approval): container background removed as well — G9 is now no border AND no background; the elements sit directly on the page as a right-aligned centered stack. Mock updated.
- 2026-07-24 (rev 4, pre-approval): founder layout directive — card to the RIGHT of the author block (no new row), spanning avatar-top to tags-bottom, width-restricted, right-justified to the article column (never over "On this page"), centered buttons, disclosure on two lines, borderless (new G9). Download progress becomes the shared animated TTS download bar (new task T5: extract from the accessibility widget's audio section, one component for both). Sticky bar from rev 2 superseded; Esc is the always-available stop. T2/T3 unchanged. Mock rewritten (rev 4).

## Close-phase follow-ups (founder-approved 2026-07-24)
- Docs: TECH-STACK.md Frontend table +kokoro-js +onnxruntime-web rows — APPLIED by orchestrator (approved).
- T7 (copy unification): verify real q8 Kokoro download size -> shared constant -> use in widget (audio.tsx) + blog disclosure (blog-read-aloud.tsx) + fix stale "80 MB" comment (tts-download-progress.ts). Independent; overlaps blog-read-aloud.tsx with future T6 (serialize).
- T6 (iOS unlock): founder chose FIX. BUT feasibility disputed (standalone helper vs engine-seam/G1-G8 reversal) -> ANALYST first, then decide approach (escalate if engine change needed). T6 dispatched AFTER analyst + AFTER T7 (shared blog-read-aloud.tsx).

### T6 — iOS first-listen audio unlock (founder-approved G1/G8 reversal, 2026-07-24)

- **Objective:** make iOS Safari first-listen audio unlock reliably for the blog reader, by creating the playing `AudioContext` synchronously inside the click gesture and injecting it into the shared engine.
- **Design context (authoritative: `research/ios-audio-unlock.md`, Option B):** on iOS, unlock is per-AudioContext-instance and an `await` drops WebKit's user-activation token. Today `handleStart` awaits the dynamic import BEFORE `unlockAudio()` creates the engine's context, so the context is born outside the gesture and starts suspended. A standalone throwaway unlock (Option A) does NOT work — it unlocks a different instance. The only G2-safe fix injects an in-gesture context into the engine. `AudioContext` is a browser global, so creating it in the light island imports no engine code and G2 holds.
- **Founder ruling:** this reverses **G1/G8** (shared-engine public-API freeze) knowingly. The change must be **additive and backward-compatible** — chat's existing `unlockAudio()` call site is untouched and its behavior unchanged.
- **Acceptance criteria:** (1) the engine exposes an additive, optional way to adopt an externally created context (e.g. `unlockAudio(existing?: AudioContext)` or `adoptAudioContext(ctx)`); calling it with no argument behaves exactly as today; (2) `scheduleAudio`'s `this.audioCtx ??=` reuse means the adopted context is the one that actually plays — verified by test; (3) the blog island creates the `AudioContext` + plays the silent buffer **synchronously in the click handler, before any `await`**, then passes it through to the engine; (4) a unit test pins the ordering: the context creation/unlock happens within the click task BEFORE the dynamic-import promise resolves (spy ordering, not real audio — iOS gesture semantics are not reproducible in happy-dom); (5) chat read-aloud is unaffected — existing engine + chat tests pass unmodified; (6) no engine code enters the marketing initial bundle (G2 still proven); (7) per-file coverage gates hold.
- **Files:** `packages/ui/src/components/accessibility/lib/tts-engine.ts` (+ test), `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` (+ test), and `document-reader.ts` (+ test) only if the context must thread through its `start()`. Nothing else.
- **Depends on:** T7 clean (shares `blog-read-aloud.tsx`).
- **Scoped checks:** `pnpm test:ui` · `turbo typecheck lint --filter=@hushbox/ui --filter=@hushbox/marketing` · `jscpd --threshold 2` on owned files.
- **Sensitive:** no, but it touches shared chat-TTS code. Auditors: 2 — one correctness lens (does the ordering actually hold; is the adopted context the one that plays), one regression lens (chat read-aloud provably unaffected; G2 still proven from the built bundle).

- T6 amendment (2026-07-24): T6 also fixes the stale `~80 MB` comment at `tts.worker.ts:38` (comment-only, to ~90 MB, keeping the fp32 ~330 MB contrast) — a valid Minor from the T7 audit, folded here because T6 is the only writer in that area. `tts.worker.ts` is therefore added to T6 Files for a comment-only edit.

---

# Phase 2 — post-ship fixes (founder-reported 2026-07-24)

Research (authoritative, briefs cite not restate): `research/tts-throughput.md`, `research/blog-reader-bugs.md`, `research/model-download-multiplication.md`, `research/ort-debloat.md`. Visual reference: `research/ui-proposal.html` **rev 6**.

## Founder rulings (2026-07-24, second round)
- Issue 1b: a **dedicated download phase** — one worker downloads, the other three start only after it is cached.
- Issue 1a: restore **concurrent synthesis as legacy had it** (see Ambiguity A1 below).
- D2 worker pool: **leave at 4**, no mobile reduction.
- D3: **no blog prewarm.**
- D5: **no copy changes** — leave both surfaces as-is; do not add "about" to the widget.
- D6: **no new E2E.** (The build verifier in B6 is a `scripts` vitest unit test, not E2E.)
- Amending the four tests that pin buggy behavior: **approved** (each rewritten to pin correct behavior; auditors verify the rewrite, not rubber-stamp it).
- `onnxruntime-web` direct dep: **investigate and remove if truly unused.**

## Ambiguity A1 (named, not silently resolved)
"Revert the multiple workers working at once behavior back to exactly how legacy had it" — legacy has **no blog reader**; the legacy behavior is chat's `tts-stream-feeder`, which fires `speak()` without awaiting playback. In chat, token arrival throttles it to a few chunks in flight. A blog article is fully known up front, so the identical mechanism is **unbounded**: it would synthesize an entire article ahead of playback (hundreds of audio buffers resident; all compute wasted on early Stop) — a regime legacy never exercised.
**Resolution taken:** adopt legacy's *mechanism* (never await playback before issuing the next `speak`) with the in-flight count bounded to the worker-pool size. This is byte-for-byte legacy behavior in every regime legacy actually ran, while refusing a new failure mode legacy never faced. If the founder wants literally unbounded, that is a one-line change to the bound and should be an explicit ruling.

## Tasks

### B1 — Engine: dedicated download phase, then fan out
- **Objective:** a cold first listen downloads the model **once**, not four times.
- **Context:** `research/model-download-multiplication.md`. `tts-engine.ts:256-263` posts `load` to all four workers in one synchronous loop; all four miss the Cache API and all four fetch (~370 MB). Coalescing is impossible — HF returns `302 no-store` to a per-request **signed** CDN URL. Pre-existing in `origin/main`; chat's boot prewarm pays it silently today.
- **Acceptance criteria:** (1) `load()` posts `load` to slot 0 only; slots 1–3 receive `load` only after slot 0 reports `loadDone`; (2) `load()` still resolves only when all four slots report `loadDone` **and** `warmupDone` (unchanged contract — the founder did not opt into resolve-on-slot-0); (3) `dispatchPending`/`speak`/`isLoaded` semantics unchanged; (4) failure of slot 0's load still fails the whole `load()` fail-fast as today; (5) the comment at `tts-engine.ts:568-570` corrected — it is the **Cache API** (`transformers-cache`), not IndexedDB, and the ordering claim becomes true only once this lands; (6) amended tests: `tts-engine.test.ts:262` ("posts a load message to every one") rewritten to pin staged fan-out, and `:314`/`:330`'s IndexedDB wording corrected; (7) new test, RED first: after `load()`, slot 0 has exactly one `load` and slots 1–3 have **zero**; after acking slot 0's `loadDone`, each remaining slot has exactly one.
- **Files:** `packages/ui/src/components/accessibility/lib/tts-engine.ts` (+ test). Nothing else.
- **Sensitive:** touches the shared engine chat depends on. **Auditors: 2** — correctness, and chat-regression (prewarm + widget + chat stream unaffected).

### B2 — Worker: aggregate download progress across files
- **Objective:** progress counts 0→100 across the whole download, never starting at 100.
- **Context:** `research/blog-reader-bugs.md` Bug C. Progress is per file; `config.json` (1.2 KB) completes in one chunk ⇒ 100%, then the 92 MB model starts ⇒ 0.07%. The worker is the only layer that still has file identity, so aggregating there needs no protocol change and fixes the accessibility widget's identical pre-existing bug (its bar, byte readout, speed **and** ETA are all fed per-file counters today).
- **Acceptance criteria:** (1) the worker keeps `Map<file,{loaded,total}>` during load and posts `loaded = Σloaded_i`, `total = max(Σtotal_i, TTS_MODEL_DOWNLOAD_BYTES)`; (2) `TTS_MODEL_DOWNLOAD_BYTES` (92,887,010) exported from `packages/shared/src/tts-model-download.ts` beside the existing MB constant — one source, no second figure; (3) `loaded = total` forced on `loadDone`; (4) emitted percentage is monotonic non-decreasing and the first emission is < 5%; (5) no change to `tts-worker-protocol.ts`, `tts-engine.ts`, `document-reader.ts`, `sections/audio.tsx`, or `blog-read-aloud.tsx`; (6) amended test: `tts.worker.test.ts:114-132` (verbatim per-file forwarding) rewritten as an aggregation test; (7) new test RED first per the research doc's spec.
- **Files:** `packages/ui/.../lib/tts.worker.ts` (+ test), `packages/shared/src/tts-model-download.ts` (+ test).
- **Sensitive:** shared engine load path. **Auditors: 2** — correctness, and widget/chat regression.

### B3 — Reader: concurrent synthesis (legacy mechanism, bounded)
- **Objective:** restore multi-worker throughput; eliminate the full-synthesis gap between sentences.
- **Context:** `research/tts-throughput.md`. `document-reader.ts:191-206` awaits `speak()`, which resolves at `endedPromise` — so one chunk is ever in flight and slots 1–3 never synthesize. See **Ambiguity A1** for the bound.
- **Acceptance criteria:** (1) synthesis for chunk N+1 is requested **before** chunk N finishes playing; up to worker-pool-size chunks in flight, never more; (2) `onChunk` stays on the ordered-await path so the highlight never races ahead of audio; (3) every pre-issued promise gets a no-op `.catch()` **at issue time** — `stop()` rejects all pending speaks and would otherwise raise pool-size−1 unhandled rejections; (4) `stop()` with a full window outstanding leaves state `stopped`, one engine `stop` call, no unhandled rejection; (5) playback order is unchanged (document order); (6) the four tests in the research doc's reproduction spec, the first two RED first.
- **Files:** `packages/ui/.../lib/document-reader.ts` (+ test).
- **Sensitive:** no. Auditors: 1.

### B4 — Blog component: highlight toggle + cached-model flash
- **Objective:** fix issues 6 and 7.
- **Context:** `research/blog-reader-bugs.md` Bugs A and B. **A:** the toggle effect has an OFF path and no ON path, and no chunk is retained. **B:** `loading` is entered unconditionally, and a cache hit still emits progress events (transformers exposes no cache-hit signal — every fix is a heuristic).
- **Acceptance criteria:** (1) toggling highlight ON mid-read immediately repaints the currently-spoken chunk; (2) the retained chunk is nulled on stop/idle/error so toggling ON after a finished read repaints nothing; (3) the download bar is shown only when ≥T ms have elapsed in `loading` **and** the aggregate percent is < 100 (T = 800–1000 ms, named constant with a comment stating why a heuristic is unavoidable); it unmounts at 100% rather than waiting for `speaking`; (4) a cached load shows **no** bar at all; (5) a real download still shows its bar; (6) amended test: `blog-read-aloud.test.tsx:226-234` split — keep "Stop control appears immediately", drop the bar assertion; (7) both repro specs from the research doc, RED first.
- **Files:** `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` (+ test).
- **Depends on:** B2 (the incompleteness gate is meaningless on per-file percentages).
- **Sensitive:** no. Auditors: 1.

### B5 — Blog layout (issues 2–5)
- **Objective:** the rev-6 layout.
- **Context:** `research/ui-proposal.html` **rev 6** is authoritative for layout.
- **Acceptance criteria:** (1) the header band is constrained to the article/content column so its right edge is the article's — it never overlaps or sits above the "On this page" aside at any width; (2) the download bar occupies a reserved slot **between** the byline+tags block and the reader, vertically centred, max-width capped, and the band's height is byte-identical with the bar present vs absent; (3) the reader's height is bounded by the byline+tags block (clips, never grows); (4) the disclosure renders exactly **two** lines at desktop widths and is permitted three on mobile; (5) the mobile breakpoint stacks the band with the reader full-width; (6) still borderless with no container background (G9); (7) no behavioral change to playback, toggle, or download logic — layout only.
- **Files:** `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` (+ test), `apps/marketing/src/pages/blog/[slug].astro`.
- **Depends on:** B4 (same file).
- **Sensitive:** no. Auditors: 1.

### B6 — Debloat: extern-wasm condition + build-output verifier
- **Objective:** stop emitting two redundant 21.6 MB wasm copies, and make the Cloudflare Pages per-file cap a build failure instead of a deploy failure.
- **Context:** `research/ort-debloat.md`. ORT's default browser bundle inlines `new URL(...wasm)`; the `onnxruntime-web-use-extern-wasm` export condition (upstream PR #24014) resolves to a variant with zero wasm references, and its contract — self-host the artifacts and set `wasmPaths` — is exactly what we already do. Fails safe: if the condition stops applying, resolution reverts to today's fat-but-working build.
- **Acceptance criteria:** (1) the condition string is exported **once** from `scripts/lib/ort-assets-plugin.ts` and imported by both app configs — never mirrored; (2) `resolve.conditions` in both apps spreads `defaultClientConditions` (it **replaces** Vite's defaults; omitting the spread breaks resolution app-wide); (3) a durable comment cites PR #24014 and the self-host contract, since the condition is otherwise undocumented; (4) new `scripts/verify-web-bundle.ts` (+ test, `scripts` vitest project) asserting against a real merged dist: `dist/ort/` files exist and sha256-match `resolveOrtAssets()`; **no** `ort-wasm*.{wasm,mjs}` outside `dist/ort/`; **no** built `.js` containing `/assets/ort-` or `/_astro/ort-`; every file ≤ 26,214,400 B and file count ≤ 20,000, naming any offender; (5) the verifier is wired into `buildWebBundle()` after the merge — one call site covering prod, e2e, and preview; (6) assertions 2 and 3 verified RED before the config change; (7) after the change, `dist/ort/` bytes are unchanged (sha256) and both worker chunks still reference `/ort/`.
- **Files:** `scripts/lib/ort-assets-plugin.ts`, `apps/web/vite.config.ts`, `apps/marketing/astro.config.mjs`, new `scripts/verify-web-bundle.ts` (+ test), `scripts/build-web-bundle.ts`.
- **Sensitive:** no, but it changes module resolution for both apps. Auditors: 1.

### B7 — `onnxruntime-web` direct dependency: investigate, remove if unused
- **Objective:** determine why `packages/ui/package.json` declares `onnxruntime-web ^1.26.0` when no source file imports it, and remove it if nothing needs it.
- **Context:** `research/ort-debloat.md` Raised #2. knip-suppressed at `knip.jsonc:78` with no comment, unlike every other ignore there. Transformers' types reference `onnxruntime-common`. It installs a second ~26 MB wasm and risks version skew with the 1.22.0-dev that actually ships.
- **Acceptance criteria:** (1) a determination, with evidence, of whether anything (types, peer resolution, the ORT assets plugin's resolution anchor) requires the direct dep; (2) if unused, remove it and the knip ignore; if used, keep it and add the missing justification comment to `knip.jsonc`; (3) either way, B6's verifier passes and `dist/ort/` bytes are **unchanged** — the removal must not alter which ORT version ships; (4) `pnpm lint:unused` clean for this entry.
- **Files:** `packages/ui/package.json`, `knip.jsonc`, and only if required, the plugin's resolution anchor.
- **Depends on:** B6 (its verifier is the proof the dist is unchanged).
- **Sensitive:** no. Auditors: 1.

## Dependency graph
```
B1 ∥ B2 ∥ B3 ∥ B6      (parallel, file-disjoint)
B2 → B4 → B5
B6 → B7
```

- **B3 amendment (orchestrator ruling, 2026-07-25):** the prefetch window introduced orphan audio on the error path — a real (non-stop) speak failure sets `error` while up to pool-size−1 already-issued chunks keep playing. Before B3, `error` implicitly meant silence. That observable contract must be preserved: the error path stops in-flight audio. "Error path unchanged" in the original brief meant do not restructure it, not allow its behavior to drift. Criterion added: a synthesis failure mid-read leaves NO further audio playing, pinned by a test.
- **B3 note:** criterion (6)'s "first two RED first" was wrong in the original brief — `research/tts-throughput.md` labels test 2 green-today (it is the regression pin against a naive prefetch). Mutation validation is the correct proof for it. Orchestrator error, not an implementer deviation.

### B8 — Replace the accidental `onnxruntime-web` pin with an exact-pinned `onnxruntime-common` (founder-approved 2026-07-25)

- **Objective:** stop pinning the shipped ORT `Tensor` by accident. Drop `packages/ui`'s `onnxruntime-web ^1.26.0` and declare `onnxruntime-common` directly, exact-pinned to the version `@huggingface/transformers` actually depends on.
- **Context:** `research/ort-debloat.md` §RAISED 2 and `task-b7/impl-report-1.md`. B7 proved the dep is not dead: transformers' browser build externalizes a bare `onnxruntime-common` import and re-exports its `Tensor` (the class the engine feeds into inference); that package is absent from transformers' peer dir, so it resolves through pnpm's hoist dir, and `onnxruntime-web` is what decides the version. The `^` range is unstable — it floated to 1.27.0 on a fresh install during B7, which would silently change the shipped `Tensor`.
- **BEHAVIOR CHANGE, ACCEPTED BY THE FOUNDER:** today's shipped `Tensor` is 1.26.0, a version transformers was **not** built against. This task aligns it to transformers' expected version. That is a correctness improvement, not a no-op — the verification must prove the inference path still works, not merely that the dependency graph is tidier.
- **Acceptance criteria:** (1) `packages/ui/package.json` no longer declares `onnxruntime-web` and declares `onnxruntime-common` at the EXACT version transformers depends on — read that version from the installed `@huggingface/transformers` package metadata, do not take any prior report's string on trust; no `^`/`~` range; (2) `knip.jsonc`: the `onnxruntime-web` ignore is removed, and any ignore needed for `onnxruntime-common` carries a comment stating precisely why it is required (Tensor re-export resolved via the hoist dir; exact pin prevents silent drift) — an undocumented ignore is the exact defect B7 was chartered to end; (3) `pnpm lint:unused` clean for these entries; (4) `dist/ort/` sha256 UNCHANGED after a real prod-target build (the wasm runtime comes from transformers' own dist and must not move): wasm `c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39`, mjs `08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9`; (5) the `Tensor`/ORT version embedded in the built worker chunk is reported BEFORE and AFTER, and matches the exact pin (B7 located it near byte 2165 of the worker chunk); (6) every TTS test green — `tts-engine`, `tts.worker`, `document-reader`, `blog-read-aloud`, the accessibility `sections` suite, plus the three apps/web chat-TTS files, all unmodified; (7) `turbo typecheck --filter=@hushbox/ui --filter=@hushbox/web --filter=@hushbox/marketing` clean; (8) **lockfile discipline:** `pnpm-lock.yaml` is shared and already carries other workstreams' drift — only `onnxruntime`-related lines may change intentionally; report the before/after diff of those lines and confirm the `vite: npm:rolldown-vite@7.3.1` override and the lock's overrides header are untouched.
- **STOP AND REPORT** rather than proceeding if: the exact version transformers expects cannot be determined unambiguously; the build's `dist/ort/` bytes change; or any TTS test fails. A failing inference path is not an acceptable cost for a dependency cleanup.
- **Files:** `packages/ui/package.json`, `knip.jsonc`, and unavoidably `pnpm-lock.yaml`.
- **Depends on:** B7 clean (it edits the same two files).
- **Sensitive:** yes — changes the runtime inference dependency shared by chat, the widget, and the blog. **Auditors: 2** — one correctness lens (right version, ships what we think, TTS intact), one regression lens (chat/widget unaffected, lockfile discipline, no silent drift reintroduced).

## Founder rulings 2026-07-25 (close-out)
- GAP 1 (silent stage-2 dead air after the bar unmounts at slot-0 100%): ACCEPTED AS-IS, no fix. Recorded as a known behavior, not a defect.
- GAP 5 (B6/B9 verifier does not run on the shipping artifact; CI build job hand-rolls turbo+merge+headers; Android + preview bypass too): ACCEPTED AS-IS for now. Pre-existing divergence; the 25MiB Pages guard therefore checks a dev-mode sibling build, not the deployed bytes. Re-entry: point CI build at build:web --target=prod, or add a verifier step after the merge in ci.yml.
- GAP 8 (no pause/resume): FOUNDER WANTS IT FIXED — "It should pause and resume where it left off." NEW WORK. Analyst dispatched for the design (mechanism + UI + engine-API implications) before any planning.

### B10 — Fail-fast guard for the phantom `onnxruntime-common` dependency (founder-approved 2026-07-25)

- **Objective:** stop Vite's dep optimizer from silently externalizing `onnxruntime-common` and caching the broken result. Make an unresolvable state fail loudly at dev-server start instead.
- **Context (authoritative: `research/dev-resolution-break.md`):** `@huggingface/transformers` imports `onnxruntime-common` as a bare specifier without declaring it — a phantom dependency resolvable only through pnpm's hoist dir, which is on the node-walk from inside `.pnpm/**` but NOT from the physical copy the optimizer writes to `apps/<app>/node_modules/.vite/deps/`. rolldown-vite externalizes an unresolvable bare import **silently** and then reuses that output forever (`Hash is consistent. Skipping.`). A five-minute window between the lockfile write and the hoist-link creation poisoned a cache that then survived every restart. Production is unaffected (Rollup resolves against the real importer, always inside `.pnpm`).
- **The change:** `optimizeDeps.include: ['kokoro-js > onnxruntime-common']` in both app configs, sourced from ONE exported constant. Vite's nested-dependency notation resolves the inner specifier **from kokoro-js's own location**, which reaches the hoist dir.
- **Acceptance criteria:** (1) a single exported constant (name it for what it is) lives in `scripts/lib/ort-assets-plugin.ts` beside `ORT_EXTERN_WASM_CONDITION`, and BOTH configs import it — the literal string appears exactly once repo-wide; (2) its doc comment states the durable mechanism (phantom dep, hoist-dir-only resolution, silent externalization, sticky cache) with no plan/task identifiers and no citation of any file under `docs/plans/runs/`; (3) **dev is verified working**: start BOTH dev servers, drive the TTS worker module through each, and confirm the emitted `kokoro-js` prebundle inlines/links `onnxruntime-common` with zero unresolved bare specifiers; (4) **one ORT instance in dev**: confirm the emitted `kokoro-js___onnxruntime-common` chunk re-exports from the SAME shared chunk `kokoro-js.js` imports (two copies would break `instanceof Tensor`); (5) **fail-fast proven**: temporarily point the include at a non-existent nested dep, show the server fails at start with the package named, then revert; (6) **shipped bytes unchanged** — `dist/ort/` sha256 still `c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39` (wasm) / `08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9` (mjs), and the `verify-web-bundle` assertions still pass; (7) decide and report whether `apps/admin` needs the same entry (it imports `@hushbox/ui/accessibility` but only the providers — the analyst could not confirm whether it can reach the kokoro prebundle).
- **Files:** `scripts/lib/ort-assets-plugin.ts`, `apps/web/vite.config.ts`, `apps/marketing/astro.config.mjs` (+ `apps/admin` config only if criterion 7 requires it).
- **Sensitive:** no, but it touches build config for both apps. Auditors: 1.

## Pause/resume (founder-approved 2026-07-25)

Rulings: **sentence-level checkpoint** (resume re-reads from the start of the chunk that was playing) — not mid-sentence, so no engine change and no second G1/G8 reversal. **No new buttons or UI**: the existing single control cycles Listen → Pause → Resume; the former Stop action now pauses. **No new E2E** (standing ruling reaffirmed; the load-only smoke test is also declined). Design of record: `research/pause-resume.md`.
Naming note: idle keeps the existing label "Listen" (founder wrote "start"; the existing label is retained as the minimal, no-new-UI reading — a one-word change if the founder prefers "Start").
Consequence accepted: nothing resets the read to the top except page navigation (Astro is MPA, so every post load is fresh) or unmount.

### P1 — `document-reader`: pause/resume + chunk checkpoint

- **Objective:** the reader can pause and resume, resuming at the chunk that was playing.
- **Context:** `research/pause-resume.md` §Options (B) and §Reproduction. Today `playChunks` rebuilds its iterator from `ctx.chunks` every run, so there is no cursor; `stopRead` acts only from `loading`/`speaking`.
- **Acceptance criteria:** (1) an index cursor replaces the iterator, and the index of the chunk currently painted is recorded where `onChunk` fires; (2) a `paused` state exists; `pause` acts only from `speaking`, `resume` only from `paused`; (3) resume re-enters playback at the recorded index — the first chunk spoken after resume is the one that was playing, not chunk 0; (4) `stopRead` also acts from `paused` AND resets the cursor, so a later start begins at chunk 0; (5) pausing with a full prefetch window outstanding does not transition to `error`: the engine's `stop()` rejects up to pool-size−1 pending speaks, `absorbRejectionNow` claims them, and the ordered loop's catch must observe `state !== 'speaking'` and break cleanly; (6) no unhandled rejection escapes (use a plain function, not `vi.fn`, for any promise whose rejection behavior is asserted — `vi.fn` attaches its own handler and makes such assertions vacuous); (7) the engine's public API is UNCHANGED — no `TtsService` method added; (8) 95%+ per-file coverage, all four repro-spec tests from the research doc, the first watched RED.
- **Files:** `packages/ui/src/components/accessibility/lib/document-reader.ts` (+ test).
- **Sensitive:** no (blog-only module; chat does not use it). Auditors: 1.

### P2 — blog component: paused state, label cycle, highlight retention

- **Objective:** the user-facing control cycles Listen → Pause → Resume, and the paused sentence stays highlighted.
- **Context:** `research/pause-resume.md` §3 (highlight), §4 (control shape), §5 (edge cases). No new controls: the single existing button changes label and action; the highlight icon toggle is unchanged.
- **Acceptance criteria:** (1) button label/action by state — idle: "Listen"; speaking: "Pause"; paused: "Resume"; the accessible name tracks the label; (2) **pause must NOT bump `runIdRef` and must NOT null `readerRef`/`highlighterRef`** — bumping the run token silently drops every callback from the resumed read (the highest-risk bug in this change); (3) `applyReaderState` gains a `paused` branch that does NOT clear `lastChunkRef` and does NOT call `highlighter.clear()`, so the paused sentence stays painted; toggling the highlight off/on while paused clears and repaints that same chunk; (4) Esc pauses while speaking (the former stop-on-Esc now pauses), consistent with the button; (5) the unmount teardown still fully stops from `paused`; (6) pause is offered only while speaking — during the model download the control stays as it is today (`load()` has no cancel); (7) **fold in the adjacent fix**: `primeAudioContext` must call `ctx.resume()` when `ctx.state !== 'running'`, synchronously in the click before any await — the engine's only recovery matches `'suspended'` (never WebKit's `'interrupted'`) and runs outside the gesture, so a Listen after backgrounding the tab can be silently mute on iOS today; (8) the layout is untouched — no new element, no size change (the band height is already at its margin); (9) 95%+ per-file coverage; tests for the label cycle, highlight retention across pause and across a highlight toggle while paused, Esc-pauses, and the in-gesture resume ordering.
- **Files:** `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` (+ test).
- **Depends on:** P1.
- **Sensitive:** no. Auditors: 1.
