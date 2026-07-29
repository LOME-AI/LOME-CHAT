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

## Production worker corruption (founder-approved 2026-07-25)

**The defect:** every production build corrupts the TTS worker. `@huggingface/transformers`' `Callable` base class does `Object.setPrototypeOf(closure, new.target.prototype)`; rolldown-vite's iife-worker transform rewrites `new.target` as if it were `import.meta`, emitting `Object.setPrototypeOf(closure, _vite_importMeta.prototype)` — and `undefined.prototype` throws on the load path of every worker. Result: blog Listen and chat read-aloud both fail with "Couldn't start playback. Try again." on every built site, 3/3 clicks, every browser, every post. Dev serves the worker as a native ES module and never applies the transform, which is why all prior verification passed. **Pre-existing — not introduced by this run; chat read-aloud has shipped broken.** Full evidence: `research/first-click-reload.md`.

**Ruling:** fix it, guard it with a build-artifact assertion. **No E2E yet** (standing ruling reaffirmed) — the guard is a `scripts`-project assertion, not a browser test. The dev-only first-click reload is **accepted as-is** (provably impossible in production; costs one click per dep-cache generation).

### W1 — Build-artifact guard: fail the build if the worker's `new.target` was rewritten

- **Objective:** make this bug class impossible to ship silently. Written FIRST and watched RED against the current dists, which contain the defect.
- **Context:** `scripts/verify-web-bundle.ts` already asserts properties of the built worker chunks (it reads every `versions:{common:…}` site and compares against the declared pin). This is the same shape and belongs beside it.
- **Acceptance criteria:** (1) a new assertion in `verify-web-bundle.ts` fails when any emitted `tts.worker-*.js` contains an `import.meta`-style rewrite of `new.target` — match the *shape* (`setPrototypeOf(<x>, <ident>.prototype)` where the identifier is a bundler-synthesised import-meta stand-in, e.g. `_vite_importMeta`, and the minified `var df={url:self.location.href}` form), not one hardcoded identifier, since minification renames it; (2) it must **fail loudly rather than vacuously** — if zero worker chunks are found, that is itself a violation (same rule the ORT-version check already follows); (3) **verified RED against the existing `apps/web/dist` and `apps/marketing/dist`**, which both carry the defect today — quote the observed failure; (4) the failure message names the file, what was found, and the cause (bundler rewrote `new.target` under the iife worker format); (5) fixture-based tests covering: a clean chunk passes, a `_vite_importMeta.prototype` chunk fails, a minified `df.prototype` chunk fails, and zero chunks fails; (6) 95%+ per-file coverage; the existing `verify-web-bundle` assertions keep passing unmodified.
- **Files:** `scripts/verify-web-bundle.ts` (+ its colocated test).
- **Sensitive:** no. Auditors: 1.

### W2 — Fix: emit workers as ES modules

- **Objective:** stop feeding rolldown an iife worker, so `new.target` survives the build.
- **Context:** the analyst's minimal repro on the lockfile-pinned rolldown-vite 7.3.1 shows the rewrite under the default `iife` worker format and its **absence** under `worker: { format: 'es' }`. The worker is already constructed with `{ type: 'module' }` (`tts-engine.ts:114`) and is the repo's only `new Worker`, so blast radius is one chunk.
- **Acceptance criteria:** (1) `worker: { format: 'es' }` set for both `apps/web` and `apps/marketing`, sourced from ONE shared seam rather than two literals (the ORT plugin module is already the shared home both configs import from); (2) after a real rebuild of BOTH apps, the emitted `tts.worker-*.js` contains `new.target.prototype` and **no** `_vite_importMeta.prototype`/`df.prototype` rewrite; (3) **W1's guard goes GREEN** on the rebuilt dists — that transition is the proof; (4) **the built site actually works**: serve the built marketing dist, open a real blog post, click Listen, and confirm the control reaches "Pause" with the model fetch running and no `loadError` in the worker protocol. This is manual verification by the implementer, not a suite test; report exactly what was observed; (5) ES-format workers may code-split — confirm what chunks are emitted, that they all resolve, and that `/ort/` assets are unaffected (`dist/ort/` sha256 must remain `c46655e8…` / `08fb86ec…`) with `verify-web-bundle`'s other assertions still passing; (6) confirm the emitted worker still loads under the generated production CSP (`scripts/generate-headers.ts`) — if ES workers change how the chunk is fetched, that is the one place it could break; (7) **correct the stale comment** at `tts-engine.ts:110-113`, which claims `type: 'module'` prevents iife breaking the kokoro import — the build emits iife regardless of that flag, so the comment gave false assurance; record the real constraint; (8) chat read-aloud must be equally fixed (same chunk) — say so explicitly with evidence.
- **Files:** the shared seam module, `apps/web/vite.config.ts`, `apps/marketing/astro.config.mjs`, `packages/ui/src/components/accessibility/lib/tts-engine.ts` (comment only).
- **Depends on:** W1 (its guard is the regression proof).
- **Sensitive:** yes — changes build output for the shared worker both apps and chat depend on. **Auditors: 2** — one correctness lens (the built worker is genuinely fixed and the site works), one regression lens (chunking, `/ort/` assets, CSP, and chat's path all intact).

### Accepted, no task
- **The dev-only first-click reload.** Vite's optimizer discovers `kokoro-js` on first fetch and broadcasts a reload, killing the four workers; the second click works. Structurally impossible in production (no dep optimizer or HMR client in a built site). Costs one click per dep-cache generation. Recorded here rather than fixed; `optimizeDeps.include` was considered and rejected — it would cost every marketing developer a ~4 MB cold-start prebundle even if they never open a blog post, and Vite silently drops an include whose nested chain fails.

### H1 — Public-hoist the phantom `onnxruntime-common` (founder-approved 2026-07-25)

- **Objective:** remove the *sticky-forever* property of the poisoned dev cache by making `onnxruntime-common` resolvable from the app root, not only from inside `.pnpm/**`.
- **Context (authoritative: `research/phantom-dep-hoist.md`, verified against pnpm source + an empirical resolution probe):** `publicHoistedModulesDir` IS the workspace root `node_modules`, which IS on the resolution walk from `apps/<app>/node_modules/.vite/deps/` — the exact basedir that fails today. The hoist pattern only chooses the destination directory; traversal order and the winning node are byte-identical, so `packages/ui`'s depth-0 exact pin still wins and 1.21.0 still loses. `publicHoistPattern` is NOT among the settings that invalidate the lockfile, so CI's `--frozen-lockfile` stays valid.
- **Acceptance criteria:** (1) `publicHoistPattern: ['onnxruntime-common']` added to `pnpm-workspace.yaml` beside `overrides:` — **exactly that one package**, not `onnxruntime-*` (which would pointlessly hoist the native binaries), with a comment stating the durable fact: transformers imports it as an undeclared bare specifier and the dev optimizer's output directory cannot see the private hoist dir; (2) `pnpm install --frozen-lockfile` — the safe form, which fails rather than writes if out of sync; (3) **`git diff pnpm-lock.yaml` shows ZERO new lines** beyond the pre-existing foreign drift recorded before the change — if the lockfile gains anything, stop and report; (4) `node_modules/onnxruntime-common` exists as a symlink to `.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/…`, and `.pnpm/node_modules/onnxruntime-common` is gone (moved, not copied — correct, not a regression); (5) a resolution probe from `apps/marketing/node_modules/.vite/deps/` now RESOLVES `onnxruntime-common` (it is `MODULE_NOT_FOUND` today) — record both before and after; (6) **the one genuinely unverified risk:** after `rm -rf apps/*/node_modules/.vite/deps` and a dev-server run driving the TTS worker, the emitted `kokoro-js` prebundle must still be ~4,218,418 bytes with `onnxruntime-common` **inlined** and zero bare specifiers — i.e. it must NOT split into a second ORT chunk, which would break `instanceof Tensor` across the boundary. If it splits, STOP and report; that outcome reverses the recommendation; (7) prod build + `verify:web-bundle` still green, `dist/ort/*` sha256 unchanged, and the shipped ORT version still `1.22.0-dev.20250409-89f8206ba4`.
- **Files:** `pnpm-workspace.yaml` only (plus whatever `pnpm install` legitimately relinks in `node_modules`, which is not repo content).
- **Sensitive:** yes — a workspace-wide resolution change touching every package. **Auditors: 2** — one correctness lens (does it resolve, is the pin intact, is the prebundle still inlined), one regression lens (lockfile untouched, CI `--frozen-lockfile` still valid, no other package's resolution moved).

---

## AMENDMENT — 2026-07-26: X-series (admin dead weight, barrel shape, dependency declaration, dev reload)

Founder approved X1–X3 and reopened the dev first-click reload as X4. Founder ruling,
verbatim in effect: *"I have never allowed the dev first click reload, lets fix that."*
This **overrides** the acceptance recorded at plan.md §W1/W2 — the reload is a defect to
fix, not an accepted cost. Founder also ruled working-tree/lockfile churn acceptable
("I am fine with any change, dont worry about in progress changes"), which is what moves
`packageExtensions` from deferred into scope. Founder fact, load-bearing for X2: the
accessibility widget is mounted on **every** marketing blog and landing page and must keep
working.

Design record: `research/admin-tts-exposure.md` findings are carried inline below (the
analysts had no write tools); the decisive mechanism is restated here because both the
implementer and the auditor need it.

**The mechanism (do not re-derive, do not "improve" around it):** the heavy dependencies
are NOT in `tts-engine.ts` — that module imports only its worker protocol. `kokoro-js`
is imported by `lib/tts.worker.ts:20`, reached through
`new Worker(new URL('tts.worker.ts', import.meta.url), { type: 'module' })` at
`tts-engine.ts:116`. Vite/rolldown resolves and emits that worker as an asset at
**transform time, before tree-shaking**, and emitted assets are never garbage-collected.
Proof from the current artifact: `grep -rl "TTS speak was cancelled" apps/admin/dist`
returns zero (the engine's own code was fully tree-shaken) while
`apps/admin/dist/assets/tts.worker-DGv4QGFc.js` ships anyway. Therefore the ONLY way to
stop the emission is to remove `tts-engine.ts` from the app's module graph entirely. A
dynamic `import()` does not do it — rolldown follows dynamic edges at build time.

**Deliberate no, recorded so it is not re-proposed:** converting `sections/audio.tsx:14`'s
static `getTtsService` import to a dynamic one. Measured, the megabytes are already lazy
everywhere (no Worker is constructed at mount; `getTtsService()` runs only from a click
handler at `audio.tsx:89`). It would defer 2.74 kB gzip on marketing, cost the extraction
of `TTS_VOICES` out of the engine (rendered synchronously in the voice `<Select>` at
`audio.tsx:167`), add a click-time chunk-fetch failure mode, and fix nothing about admin.

**Enforcement doctrine for this amendment:** the artifact guard is the single mechanism.
No ESLint `no-restricted-imports` scoped to an app — `packages/config/eslint.config.js:30-33`
documents that flat config REPLACES a rule key rather than merging, so an admin-scoped
block would silently drop the animation-library bans for every admin file. No source-level
closure test either: it would be a second mechanism guarding the same failure, which
CODE-RULES forbids.

### X1 — Declare which apps ship TTS; extend the bundle verifier to TTS-free dists

- **Objective:** make "this app ships TTS" a declared fact the build checks, instead of an
  emergent bundler outcome nobody chose.
- **Design context:** `scripts/verify-web-bundle.ts` already implements exactly this class
  of guard and is wired ONLY to `apps/web/dist` via `scripts/build-web-bundle.ts:89,109`.
  `scripts/build-admin-bundle.ts` verifies nothing at all. The capability exists; the
  coverage does not. Confirmed: `apps/admin/dist/assets/tts.worker-DGv4QGFc.js` contains 2
  occurrences of `/assets/ort-`, so the EXISTING `checkBundledRuntimeReferences` and
  `checkStrayRuntimeCopies` would already fail admin today if pointed at it. Do not write
  new checks that duplicate those; add the missing expectation and the wiring.
- **Acceptance criteria:**
  1. `VerifyWebBundleOptions` gains a TTS-shipping expectation (a boolean such as
     `shipsTts`, or the declared app list — implementer's choice of shape, but the set of
     TTS-shipping apps must be declared in exactly ONE place and imported, never repeated
     per call site).
  2. When TTS is expected (today: the merged web bundle), behaviour is **byte-for-byte
     unchanged** — all six existing checks run exactly as now. Pin this: the existing
     `verifyWebBundle` tests must pass unmodified except for any added required argument.
  3. When TTS is NOT expected: `checkSelfHostedRuntime` must be skipped (it REQUIRES a
     `dist/ort/**` tree to exist and would false-fail a legitimately TTS-free dist), and
     the dist must instead be asserted to contain **zero** `ORT_RUNTIME_FILE` matches and
     **zero** `tts.worker-*.js` chunks. Note `checkWorkerMetaProperty` currently fails on
     zero worker chunks by design (it must not pass vacuously) — a TTS-free dist must not
     trip that failure path.
  4. RED FIRST and watched: `collectWebBundleViolations` over a fixture dist containing
     `assets/tts.worker-abc.js` and `assets/ort-wasm-simd-threaded.jsep-xyz.wasm` with TTS
     not expected returns exactly the two expected violations. This test must be observed
     failing before the implementation exists.
  5. `buildAdminBundle` (`scripts/build-admin-bundle.ts:38-49`) calls the verifier against
     `apps/admin/dist` with TTS not expected.
  6. `apps/crawler-view` is enumerated in the declared list as TTS-free even though it has
     no build script or dist today, so it is guarded the day it gets one.
  7. The file walk must not wander into `apps/web/android/app/src/main/assets/public/`,
     which holds a checked-in built copy of the web app carrying its own worker chunks.
- **Expected end state of this task:** the admin build FAILS. That is correct and
  intentional — X2 makes it pass. Do not weaken the check to make the build green.
- **Files:** `scripts/verify-web-bundle.ts`, `scripts/verify-web-bundle.test.ts`,
  `scripts/build-admin-bundle.ts`, `scripts/build-admin-bundle.test.ts`.
- **Scoped checks:** `turbo test typecheck lint --filter=@hushbox/scripts`;
  `jscpd --threshold 2` over the four files.
- **Sensitive:** no. **Auditors: 1.**

### X2 — Split the accessibility barrel by weight (depends on X1)

- **Objective:** make the light accessibility surface's TTS-freedom a property of the
  module graph, so an app importing the providers cannot inherit 23.9 MB by writing the
  obvious import.
- **Design context:** `packages/ui/src/components/accessibility/index.ts` exports five
  symbols; two are light (`A11yProvider`, `MotionProvider`, plus internal-only
  `SvgColorblindDefs`) and two are heavy (`AccessibilityWidget`, `AccessibilityPanel` →
  `sections/index.ts` → `sections/audio.tsx:14` → the engine → the worker). `A11yProvider`
  itself is already TTS-free: it imports `sections/aids/magnifier` and
  `sections/aids/reading-guide` by narrow path, never the sections barrel
  (`a11y-provider.tsx:10-11`). The barrel is the sole leak.
- **Full importer census (authoritative — do not re-grep and reach a different set):**
  `AccessibilityWidget` → `apps/marketing/src/layouts/BlogLayout.astro:3`,
  `apps/marketing/src/layouts/LandingLayout.astro:3` (both `client:load`).
  `AccessibilityPanel` → `apps/web/src/routes/_app/accessibility.tsx:4`.
  Light-only importers needing NO change → `apps/web/src/routes/__root.tsx:5`,
  `apps/admin/src/routes/__root.tsx:3`, `apps/web/src/test-utils/render.tsx:5`.
  Also touching the barrel → `apps/web/src/routes/__root.test.tsx:62-63` (a `vi.mock`
  factory that lists both heavy symbols and must be updated to match the new shape).
  `packages/ui/src/index.ts` does NOT re-export accessibility — the subpath is the only door.
- **Acceptance criteria:**
  1. `@hushbox/ui/accessibility` exports only light symbols; its transitive static-import
     closure contains no `new Worker` and does not reach `lib/tts-engine.ts`.
  2. `AccessibilityWidget` and `AccessibilityPanel` are exported from a new
     `./accessibility/panel` subpath (both together — the widget is a Sheet wrapper around
     the panel, `accessibility-widget.tsx:7`). The path name deliberately does NOT encode
     "heavy" or "tts"; that would become a wrong name the day TTS moves. The durable fact
     (this subpath pulls the TTS engine and its worker chunk) goes in the module's
     doc-comment.
  3. The four importers above are updated. The accessibility widget still renders and
     functions on marketing blog AND landing pages — verify, do not assume; a wrong import
     here removes the widget site-wide.
  4. The `./accessibility/lib` subpath export is removed along with the engine re-export at
     `lib/index.ts:17-24`. It has zero importers today (verified) and is an identical
     dormant copy of the same trap. This is a public-surface removal on `packages/ui`,
     approved by the founder as part of this task.
  5. **Rebuild `apps/admin` and prove the bytes are gone by measurement, not inference:**
     `apps/admin/dist` contains no `tts.worker-*.js` and no `ort-*.wasm`; total dist size
     drops from 25,611,280 B to roughly 1.7 MB. X1's guard goes green.
  6. `apps/web` and `apps/marketing` still ship TTS and still pass X1's guard unchanged.
     Expected secondary win to confirm on web: `apps/web/dist/index.html` no longer
     `modulepreload`s the panel chunk (~24,977 B) and engine chunk (~8,647 B), because
     `__root.tsx` no longer drags the whole barrel.
  7. `scripts/generate-headers.ts:643-645` — its comment justifying the absence of
     `wasm-unsafe-eval` asserts "admin bundles no crypto/WASM", which the current artifact
     falsifies (21.6 MB of ORT wasm ships). After this task it is true again; correct the
     comment only if it still misstates the post-change reality.
- **Files:** `packages/ui/src/components/accessibility/index.ts`, the new panel subpath
  module, `packages/ui/src/components/accessibility/lib/index.ts`,
  `packages/ui/package.json`, `apps/marketing/src/layouts/BlogLayout.astro`,
  `apps/marketing/src/layouts/LandingLayout.astro`,
  `apps/web/src/routes/_app/accessibility.tsx`, `apps/web/src/routes/__root.test.tsx`,
  `scripts/generate-headers.ts`.
- **Scoped checks:** `turbo test typecheck lint --filter=@hushbox/ui`,
  `--filter=@hushbox/web`, `--filter=@hushbox/admin`, `--filter=@hushbox/scripts`;
  marketing build.
- **Sensitive:** no. **Auditors: 1.**

### X3 — Declare the phantom dependency with `packageExtensions` (depends on X1)

- **Objective:** replace four containment mechanisms for one upstream defect with two, and
  make the shipped ORT version a declared edge rather than a pnpm hoist-order outcome.
- **Design context:** `@huggingface/transformers@3.8.1` imports `onnxruntime-common` as an
  undeclared bare specifier (`dist/transformers.web.js:1`). **Option F as previously
  written up in `research/phantom-dep-hoist.md:43,75` is WRONG and must not be attempted:**
  a pnpm patch to a package's `package.json` `dependencies` has zero effect on resolution —
  the graph is built from the resolver's manifest (`pnpm.mjs:176155-176160`) and patches are
  applied to files at link time (`pnpm.mjs:181231-181234`); pnpm's own docs forbid this use.
  `packageExtensions` is the designed remedy: it merges into the manifest via the
  `readPackageHook` at `pnpm.mjs:176159`, creating a real edge and a real symlink.
- **Acceptance criteria:**
  1. `packageExtensions` entry added to `pnpm-workspace.yaml` with the **exact** selector
     `@huggingface/transformers@3.8.1` declaring
     `onnxruntime-common: "1.22.0-dev.20250409-89f8206ba4"` — the exact version string, never
     a range. A range would keep applying a stale version beside a future newer
     `onnxruntime-web` and install a genuine second copy, reintroducing the `instanceof
     Tensor` split. The exact selector fails safe: on a transformers bump the extension
     silently stops applying and behaviour falls back to today's, which the build guard
     catches. Record this reasoning in a comment on the entry.
  2. `pnpm install`, then `git diff --stat pnpm-lock.yaml` shows ONLY the
     `packageExtensionsChecksum` line plus the new `onnxruntime-common` edge under
     `@huggingface/transformers@3.8.1`. **Any other version movement from the forced full
     re-resolution is a STOP-AND-REPORT, not a merge.**
  3. `node_modules/.pnpm/@huggingface+transformers@3.8.1/node_modules/onnxruntime-common`
     exists as a new symlink into `.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/…`,
     and `ls node_modules/.pnpm/ | grep -c '^onnxruntime-common@'` is still **2**, never 3.
     This premise is Inferred, not Verified — if it does not hold, STOP AND REPORT; the
     whole task rests on it.
  4. The `onnxruntime-common` pin in `packages/ui/package.json` and its `knip.jsonc:91`
     ignore are removed.
  5. `declaredOrtCommonVersion()` (`verify-web-bundle.ts:53-68`) is re-pointed to read the
     version from the `packageExtensions` entry instead of `packages/ui/package.json`,
     keeping its `EXACT_VERSION` assertion. Its failure path must stay tested (a doctored
     value must throw). `checkOrtCommonVersion` itself STAYS — it is the only guard on which
     ORT version actually ships and the only check that fails on zero sites.
  6. **Falsification gate for retiring `publicHoistPattern`:** delete it, reinstall,
     `rm -rf apps/*/node_modules/.vite/deps`, start both dev servers and drive the TTS
     worker. The emitted `kokoro-js` prebundle must still be **4,218,418 bytes with zero
     bare specifiers** (ORT inlined, not split into a second chunk). If a bare
     `onnxruntime-common` survives, `publicHoistPattern` STAYS and this task lands a
     three-piece end state — report that outcome, do not force it.
  7. Production build + `verify:web-bundle` green: `dist/ort/*` hashes unchanged and
     `checkOrtCommonVersion` still reports `1.22.0-dev.20250409-89f8206ba4`.
- **Note for the record:** this relocates the exact-version literal rather than eliminating
  it — the other implementation is upstream's manifest and cannot be shared, so
  `checkOrtCommonVersion` remains a legitimate cross-check rather than the banned
  mirrored-constant pattern. State that in the entry's comment so a future agent does not
  "clean up" the guard.
- **Files:** `pnpm-workspace.yaml`, `packages/ui/package.json`, `knip.jsonc`,
  `scripts/verify-web-bundle.ts`, `scripts/verify-web-bundle.test.ts`, `pnpm-lock.yaml`.
- **Scoped checks:** `turbo test typecheck lint --filter=@hushbox/scripts`; `pnpm lint:unused`.
- **Sensitive:** no, but high blast radius (dependency resolution + the shipped ORT
  version). **Auditors: 2, independent.**

### X4 — Fix the dev-server first-click reload — PENDING ANALYSIS

- **Objective:** clicking Listen for the first time in `pnpm dev` must not reload the page.
- **Founder ruling:** this is a defect to fix. The prior "accepted as-is" disposition at
  plan.md §W1/W2 is **withdrawn**.
- **Known mechanism:** Vite's dep optimizer discovers `kokoro-js` on the first worker fetch,
  prebundles it, and broadcasts a full reload — killing all four workers mid-load. Server
  log, verbatim: `[vite] ✨ new dependencies optimized: kokoro-js` /
  `[vite] ✨ optimized dependencies changed. reloading`. Second click works. Warm cache:
  no reload. Structurally impossible in production (no dep optimizer, no HMR client).
- **Known trap:** the `optimizeDeps.include` entry deleted earlier in this run was
  `'@hushbox/ui > kokoro-js > onnxruntime-common'` — it pinned the PHANTOM dep, not
  `kokoro-js`, so it almost certainly never suppressed this reload. Any fix of that shape is
  a different entry with a different purpose, not a revival, and its efficacy was never
  verified. Vite also silently drops an include whose nested chain fails, so an unverified
  include is indistinguishable from no fix.
- **Open question routed to an analyst:** the option set and which option actually
  suppresses the reload, verified rather than inferred, including interaction with X3 (a
  declared `onnxruntime-common` edge changes what the optimizer resolves) and the cost to a
  marketing developer who never opens a blog post.
- Acceptance criteria to be written into this section once the analysis returns.

### X1 — CORRECTIONS TO THIS TASK'S OWN SPEC (orchestrator, 2026-07-26, post-implementation)

Two defects in §X1 as originally written. Both are mine. The corrected text below is
authoritative for the audit; the auditor judges against THIS, not the original wording.

**Correction 1 — file ownership was incomplete.** §X1's Files list omitted
`scripts/build-web-bundle.ts` and `scripts/build-web-bundle.test.ts`. Criterion 1 requires
the TTS-shipping expectation to be declared in exactly one place; making it a required
option necessarily breaks the existing assignment of `verifyWebBundle` to
`BuildWebBundleDeps['verify']`, so the web build's call site must be threaded too. An
optional-with-default parameter would have satisfied the type but violated criterion 1 by
creating a second implicit declaration of which apps ship TTS. Those two files are IN
BOUNDS for X1. Edits to them are in scope and are not a deviation.

**Correction 2 — criterion 3 named an incomplete set of checks.** It named only
`checkSelfHostedRuntime` and `checkWorkerMetaProperty` as problematic on a TTS-free dist.
In fact `checkOrtCommonVersion`'s zero-sites vacuity guard and `checkStrayRuntimeCopies`
also fire there, so §X1 as literally written was unsatisfiable against criterion 4's
"exactly the two expected violations". **Corrected criterion 3:** on a dist not expected to
ship TTS, the verifier must assert zero `ORT_RUNTIME_FILE` matches and zero
`tts.worker-*.js` chunks, and must not run checks that presuppose the presence of TTS
artifacts. Which specific checks are skipped is an implementation choice, but it must be
justified in the implementation report, and it must not drop a check a TTS-free dist can
still meaningfully fail — Cloudflare per-file-size and file-count limits apply to every
dist regardless of TTS and must still run.

**Audit note on Correction 2 (a question to answer, not a finding to accept):** whether
skipping `checkBundledRuntimeReferences` on TTS-free dists loses real coverage — i.e.
whether a chunk can reference `/assets/ort-` or `/_astro/ort-` while no ORT file is present,
and if so whether the zero-artifact assertion catches that case or misses it.

### KNOWN PRE-EXISTING FAILURES — `@hushbox/scripts` package test gate (2026-07-26)

The `turbo test --filter=@hushbox/scripts` gate is RED for reasons outside the X-series.
Agents must attribute around these and must NOT fix them — they belong to other
workstreams or to this checkout's transient state:

- `generate-env.test.ts` — secret list missing `VAPID_*` / `NOTIFICATION_TAG_SECRET`
  (another workstream's env registry change).
- `refresh-catalog-run.test.ts`, `seed-run.test.ts` — `ERR_MODULE_NOT_FOUND` on
  `@hushbox/db` from a stale `node_modules/.vite` `deps_ssr` cache. **Likely caused by this
  run itself**: a concurrent analyst is clearing and regenerating `apps/*/node_modules/.vite`
  directories to investigate the dev-server reload. Treat as environmental, not as a code
  defect, and do not "fix" it by editing source.
- `lib/seed-documents.test.ts` — observed flapping red→green mid-session as another
  workstream edited it.

A task is judged on the tests covering the files it owns, plus eslint/tsgo, not on this
package-wide gate being green.

### NAMING DEBT — recorded, deliberately not acted on

`scripts/verify-web-bundle.ts` and its "Web bundle verification failed" message now cover
the admin bundle too. Not renamed, because §X1's criteria name `VerifyWebBundleOptions`
explicitly and a mid-run rename would churn every call site and test. The error message
includes the dist path so it remains unambiguous. Flagged to the founder as debt; a rename
is a follow-up decision, not an X-series task.

### X1 AUDIT — validated finding + a larger gap the orchestrator confirmed

**Auditor verdict: FAIL**, one Important finding, validated and accepted:
`scripts/build-admin-bundle.ts:52-54` asserts "Every admin build — CI, preview, local —
comes through here, so this is the single gate." That is false. `buildAdminBundle` is
reached only via `pnpm build:e2e:admin` (`package.json:16`, `ci.yml:415`). CODE-RULES
treats a wrong comment as worse than none, and this one asserts a safety property about the
deployed artifact that does not hold.

**Orchestrator verification extended the finding (do not treat as auditor speculation —
this was confirmed directly):** `scripts/build-web-bundle.ts` is the ONLY caller of
`verifyWebBundle`, and it appears **nowhere in any workflow**. Both `ci.yml:285-321` and
`release.yml:138-140` reimplement its sequence inline — `pnpm build` (turbo → each app's own
`vite build`/`astro build`) → `merge-marketing-into-web.ts` → `generate-headers.ts` → upload
`web-dist` and `admin-dist` — and skip the verification step. Consequences:

- **No deployed artifact has ever been verified.** Not `web-dist`, not `admin-dist`.
- The `new.target` worker guard added earlier in this run (§W1) runs in CI only against the
  **e2e** bundles (`pnpm build:e2e`, `ci.yml:396`; `pnpm build:e2e:admin`, `ci.yml:415`), never
  against what deploys. Earlier reporting in this run that described it as guarding
  production overstated its reach.
- Admin's verified artifact is additionally built `--mode development`
  (`build-admin-bundle.ts:47`), so even that check runs against a different build mode than
  production ships.
- Root cause is a duplicated build sequence: the ordered steps live in
  `build-web-bundle.ts` AND are re-spelled in two workflow files. That is the
  "One Implementation, Shared" violation the guard gap is a symptom of.

**Disposition:** the false comment is fixed inside X1 (below). Closing the production
coverage gap requires editing CI/CD, which AGENT-RULES puts behind explicit founder
approval — routed to the founder as X5, not folded in silently.

### X1 FIX CYCLE 1 — validated findings to fix

1. `scripts/build-admin-bundle.ts:52-54` — the comment is factually wrong. Replace it with
   what actually routes through this path (the E2E/preview admin build, per the file's own
   header at `:3-5` and `ci.yml:411-413`, which states outright that the production
   `admin-dist` is a different build). The comment must not claim or imply that the
   deployed admin artifact is gated by this call. Do not wire any new build path — that is
   X5's scope and needs founder approval.

### X5 — Gate the DEPLOYED artifacts, not just the e2e ones — AWAITING FOUNDER APPROVAL

Blocked: modifying CI/CD requires explicit approval. Options to put to the founder:
(a) CI and release call `pnpm build:web` instead of re-spelling its three steps, so the
sequence and its verification exist once; (b) add an explicit verify step after
`generate-headers` in both workflows (fixes coverage, leaves the duplicated sequence);
(c) move verification into each app's own build via a `closeBundle` plugin — works for admin,
which already uses that pattern for `generateAdminHeaders`, but cannot verify the merged web
bundle because the merge and headers steps run after and outside vite; (d) accept e2e-only
verification and correct every claim made about the guard's reach.

### X1 — CLEAN (2026-07-26, re-audit after fix cycle 1)

Re-audit PASS, no findings. Every clause of the replacement comment independently verified
against the repo; the mandated admin failure is still real and still comes from
`checkNoTtsArtifacts` (the two violations against the real dist); the six original checks
are byte-identical on the TTS-expecting path; 100% per-file coverage on all three changed
sources. The auditor also independently confirmed the open question from Correction 2:
skipping `checkBundledRuntimeReferences` on TTS-free dists loses no real coverage, because
the asset-URL string in a chunk is produced by the same bundler event that emits the file,
so the zero-artifact assertion catches every case carrying actual bloat.

**Routed to X5, not charged against X1 —** two sibling claims of the same false-reach class
survive in the tree and must be corrected by whichever X5 option lands:
- `scripts/build-web-bundle.ts:87-89` — "Every caller — prod, e2e, preview — comes through
  here, so this is the single gate." Pre-existing at HEAD, and **no workflow calls
  `buildWebBundle` at all**.
- `scripts/verify-web-bundle.ts:2-3` — "so prod, e2e, and the preview build all pay them"
  reads correctly as the script's own `BuildTarget` values plus the playwright preview;
  true as written, but re-check it if X5 changes the wiring.

### X3 — CRITERION 6 RE-BASELINED (orchestrator, 2026-07-26)

The original criterion 6 hardcoded `4,218,418 bytes` for the emitted `kokoro-js` prebundle.
**That literal is already stale** — the current tree emits `4,218,286 bytes` (measured twice,
on both apps, during X4's investigation). A magic byte count in an acceptance criterion
fails for the wrong reason the moment any dependency moves.

**Corrected criterion 6:** record the prebundle's size and content BEFORE the change, then
after. The assertion is comparative, not absolute: the emitted `kokoro-js` prebundle must be
**the same size before and after** (a few bytes of sourcemap-name drift is acceptable and
must be explained if it appears), must still have `onnxruntime-common` **inlined**, and must
contain **zero bare specifiers** — i.e. ORT must NOT split into a second chunk, which would
break `instanceof Tensor` across the boundary. If it splits, `publicHoistPattern` STAYS and
the task lands a three-piece end state — report that outcome, do not force it.

### X4 — Stop the dev-server first-click reload (criteria, post-analysis)

**Root cause (Verified, with a minimal scratch reproduction):** Vite's dependency scanner
never crosses a `new Worker(new URL(…, import.meta.url))` edge. `workerImportMetaUrlPlugin`
— the plugin that understands that pattern — is registered only in the main pipeline
(`resolvePlugins`), not in the scanner's reduced plugin set (`rolldownScanPlugin`). Dynamic
imports ARE followed; worker entry points are NOT. So `kokoro-js`, imported inside
`lib/tts.worker.ts`, is invisible at startup and gets discovered on first worker fetch.
The reload that follows is not tunable: late discovery re-chunks the whole prebundle
(measured — 40 of 48 already-optimized deps got new file hashes), and any hash change sets
`needsReload`.

**Both apps are affected.** `apps/marketing` (blog Listen) and `apps/web` (chat read-aloud)
each lose their first click on a cold dep cache, with identical log lines.

**Chosen option: `optimizeDeps.entries` naming the worker source.** It fixes the cause rather
than one symptom package, names no dependency (so nothing can drift against
`packages/ui/package.json`), covers every future worker-only dependency, and costs ~0 ms of
cold start — measured across three cold starts per app, the delta was inside the noise. Its
real cost is ~9.5 MB of dev-cache disk per app.

**Rejected, with the evidence that disqualifies each:**
- `optimizeDeps.include: ['@hushbox/ui > kokoro-js']` — works, but encodes a package name
  `packages/ui` owns (swap the TTS library and the reload silently returns), covers only that
  one package, and renames the dev prebundle to `@hushbox_ui___kokoro-js.js`, which X3's
  criterion inspects.
- `optimizeDeps.include: ['kokoro-js']` (bare) — does not resolve from either app root under
  pnpm; warns and the reload persists.
- `optimizeDeps.include: ['@hushbox/ui > kokoro-js > onnxruntime-common']` — **the entry
  deleted earlier in this run.** Verified to leave the reload fully intact: it pinned the
  phantom dep only. Vite's `nestedResolveBasedir` falls back to the previous basedir on any
  failed hop, so a wrong chain silently resolves something else and warns about nothing.
- `optimizeDeps.exclude: ['kokoro-js']` — zero cost and Verified to stop the reload, but the
  only option that changes what dev actually executes, and it manufactures a dual-ORT
  `instanceof Tensor` hazard the moment anything else pulls transformers into the optimizer.
- `server.warmup.clientFiles` — same cost as the chosen option plus an extra startup optimize
  round that can broadcast the same reload to a connected tab.

- **Acceptance criteria:**
  1. The worker's absolute source path is exported as ONE constant from
     `scripts/lib/ort-assets-plugin.ts` (the seam both app configs already import), computed
     from `import.meta.url`, and **asserted to exist at config load** — throw with a clear
     message if missing, matching the existing `collectOrtAssets` pattern in that file. This
     assert IS the regression guard; do not also add a dev-server boot test (one mechanism
     per task).
  2. `apps/marketing/astro.config.mjs` composes it as `optimizeDeps: { entries: [<const>] }`.
     Astro's own entries merge with it — verify that, do not assume.
  3. `apps/web/vite.config.ts` composes it as `optimizeDeps: { entries: ['**/*.html', <const>] }`.
     **The `**/*.html` pattern MUST be restated:** setting `entries` on web REPLACES Vite's
     default glob. Omitting it silently collapses the cold-start dep cache from ~101 MB to
     ~11 MB with no error — everything still works, just slower.
  4. Verified GREEN on BOTH apps, cold cache (`rm -rf apps/*/node_modules/.vite/deps` first —
     a warm cache hides the bug entirely): after cold start and BEFORE any page request,
     `_metadata.json`'s `optimized` map contains `kokoro-js` and `deps/kokoro-js.js` exists.
     Then fetch the worker's dev URL and observe **zero** `new dependencies found` and **zero**
     `reloading` lines in the server log. The RED direction must be observed first on at least
     one app.
  5. Dev module topology unchanged: the worker's rewritten import is still
     `/node_modules/.vite/deps/kokoro-js.js?v=…`, ORT still inlined, zero bare specifiers.
  6. Web's cold-start dep cache is ≈101 MB + ~9.5 MB — **not** ≈11 MB (that shrinkage is the
     criterion-3 trap having fired).
  7. Production is untouched: `optimizeDeps` is dev-only, so no rebuild is needed to prove it,
     but `verify:web-bundle` must still pass unchanged.
  8. Correct the stale comment at
     `packages/ui/src/components/accessibility/lib/tts.worker.ts:13-19`, which still says
     dynamic imports inside a worker "would require `worker.format: 'es'` config, which we're
     avoiding." The repo now REQUIRES that format (`WORKER_BUILD_OPTIONS`); the comment
     contradicts a load-bearing build constraint.
- **Files:** `scripts/lib/ort-assets-plugin.ts` (+ test), `apps/web/vite.config.ts`,
  `apps/marketing/astro.config.mjs`,
  `packages/ui/src/components/accessibility/lib/tts.worker.ts`.
- **Scoped checks:** `turbo test typecheck lint --filter=@hushbox/scripts`,
  `--filter=@hushbox/web`, `--filter=@hushbox/ui`.
- **Sensitive:** no. **Auditors: 1.**
- **Ordering:** LAST. X3 runs `pnpm install` and X4 drives dev servers; running either
  alongside a build or a test suite already caused one round of cache-related foreign test
  failures in this run.

**Naming debt (recorded, deliberately not acted on):** `scripts/lib/ort-assets-plugin.ts` is
documented as the ORT self-hosting module but already carries `WORKER_BUILD_OPTIONS` and will
now carry a TTS-worker scan entry. The constants fit the seam; the filename is stretching.
Grouped with the `verify-web-bundle` naming debt as one founder-visible follow-up.

### X5 — Gate the DEPLOYED artifacts (APPROVED 2026-07-26)

Founder approved X4 and X5. **Assumption stated for correction:** X5b is scoped as the
explicit-verify-step variant I recommended, NOT the "CI calls `pnpm build:web`" restructure.
The deploy pipeline is the wrong place to take restructuring risk for elegance, and the
workflows inject env per-step inside generator-written `# BEGIN GENERATED:` blocks that a
restructure would disturb.

**The gap being closed:** `verifyWebBundle` has never run on an artifact that deploys.
`build-web-bundle.ts` does build → merge → headers → **verify**; `ci.yml:285-321` and
`release.yml:126-141` each re-spell build → merge → headers → upload, without the verify.

Split into two independent halves because admin needs no workflow change at all.

#### X5a — Admin: gate every admin build from the app's own config

- **Objective:** every admin build — production `vite build`, CI, e2e, preview, local —
  passes the bundle guard, without a workflow edit.
- **Design context:** `apps/admin/vite.config.ts` already runs `generateAdminHeaders` from a
  build-only `closeBundle` hook (`adminHeadersPlugin`). Verification belongs in that same
  hook. This is strictly stronger than a CI step: it cannot be bypassed by invoking a
  different build entry point.
- **Acceptance criteria:**
  1. Verification runs from admin's build-only plugin, sequenced **after**
     `generateAdminHeaders` — `checkPagesLimits` counts emitted files, and `_headers` is one
     of them.
  2. It calls the SAME seam X1 established (`appBundleOptions` + `verifyWebBundle`). No
     second declaration of which apps ship TTS, no reimplemented checks, no copied literals.
  3. **The explicit call in `scripts/build-admin-bundle.ts` is REMOVED**, along with the
     scope comment X1's fix cycle wrote. Keeping both would be two mechanisms for one
     guarantee — CODE-RULES forbids the backup mechanism. `pnpm build:e2e:admin` still gets
     verified, now via the vite build it invokes; prove that, do not assume it.
  4. Proven non-vacuous: a production-mode `vite build` of admin (NOT `--mode development`)
     runs the verification and passes against the post-X2 dist, AND the check demonstrably
     fails if TTS artifacts are present. Show the failing direction by evidence, not by
     assertion.
- **Files:** `apps/admin/vite.config.ts`, `scripts/build-admin-bundle.ts` (+ its test).
- **Depends on:** X2 (the admin dist must be clean or this build fails).
- **Scoped checks:** `turbo test typecheck lint --filter=@hushbox/admin`,
  `--filter=@hushbox/scripts`.
- **Sensitive:** no. **Auditors: 1.**

#### X5b — Web: verify the merged bundle before it is uploaded

- **Objective:** the `web-dist` artifact that deploys is verified.
- **Design context:** the merged web bundle CANNOT be verified from vite's `closeBundle` —
  `merge-marketing-into-web.ts` and `generate-headers.ts` run after vite finishes and outside
  it. So this half genuinely needs a workflow step.
- **Acceptance criteria:**
  1. A verification step is added to BOTH `.github/workflows/ci.yml` (after
     `Generate _headers`, before `Upload web build artifact`) and
     `.github/workflows/release.yml` (after its own `Generate _headers`).
  2. The step invokes the same seam via a root pnpm script — never a reimplementation and
     never an inline `tsx -e`. If a new script is added, `pnpm lint:unused` (knip) must stay
     green.
  3. `scripts/build-web-bundle.ts:87-89` — "Every caller — prod, e2e, preview — comes through
     here, so this is the single gate" — is false and must be corrected: no workflow calls
     `buildWebBundle` at all.
  4. **Honest verification boundary:** agents cannot run GitHub Actions. Verify by running
     the new script locally against the real merged `apps/web/dist` (expect pass), by
     confirming the failing direction is reachable, and by checking the workflow YAML parses
     and the step is positioned between headers and upload. State plainly in the report that
     CI execution itself is unverified.
  5. The step must need no secrets or generated env beyond what is already present at that
     point in the job.
- **Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `package.json`,
  `scripts/build-web-bundle.ts`.
- **Scoped checks:** `turbo test typecheck lint --filter=@hushbox/scripts`;
  `pnpm lint:unused`.
- **Sensitive:** no, but it edits the deploy path. **Auditors: 2, independent.**

### REVISED ORDER (all remaining work, strictly serial)

X2 (in flight) → X5a → X5b → X3 → X4.

Rationale: X5a immediately proves X2's byte removal on the PRODUCTION admin build path
rather than the e2e one. X3 runs `pnpm install` and X4 drives dev servers with cache
clearing — the two most disruptive tasks go last, after everything that needs stable builds.
Running an analyst alongside an implementer earlier in this run already produced a round of
cache-related foreign test failures; that is not repeated.

### STILL OPEN — not approved, not declined, NOT scoped in

The hydration race: the Listen control is an Astro island (`client:visible`), inert between
server-render and hydration (measured 151 ms–1.6 s). A click in that window does nothing —
no reload, no error, no audio — and this exists in PRODUCTION, where the dep-optimizer reload
provably cannot happen. It is an independent second cause of "I had to click twice" and X4
does not address it. Offered to the founder with two shapes (hydrate the island eagerly, or
render the control visibly disabled until live); no ruling received. Do not fold it into any
X-task without one.

### X2 — CENSUS CORRECTION + deviations for the audit (orchestrator, 2026-07-26)

**Correction 1 — my §X2 importer census was incomplete.** It listed
`apps/web/src/routes/__root.test.tsx:62-63` as a barrel-touching test mock but MISSED
`apps/web/src/routes/_app/accessibility.test.tsx:10-11`, which mocks the same barrel and
also had to be repointed. Same category, second instance, my omission. The implementer
proceeded rather than stopping as my brief instructed, judging it an incompleteness about
test mocks rather than a moved module graph. **That judgment is accepted** — the distinction
is real and every substantive (non-test) census claim checked out exactly. The auditor must
still independently establish the FULL importer set and report any third instance.

**Deviation 1 — `lib/index.ts` deleted outright** rather than trimming its engine re-export
at lines 17-24. Removing the `./accessibility/lib` subpath export leaves the file with zero
importers, which knip reports as an unused file; deleting it is the only state where knip is
green. Auditor: confirm it was genuinely reachable by nothing else.

**Deviation 2 — the new subpath is `panel/index.ts`, not `panel.ts`.** `packages/ui`'s
per-file coverage config excludes `**/index.ts`; a flat `panel.ts` re-export would need
coverage, and covering it would drag the heavy TTS tree into the `@hushbox/ui` test run.
Auditor: judge whether this is legitimate use of an existing barrel exemption or an
end-run around the coverage gate. Say which, with reasoning.

**Criterion 7 correctly resulted in NO edit.** `scripts/generate-headers.ts`'s "admin bundles
no crypto/WASM" comment is true again post-change (zero `*.wasm` in the rebuilt admin dist),
and the criterion said to correct it only if it still misstated reality. Not editing is
compliance, not an omission.

### CONCURRENCY CORRECTION — other workstreams ARE active (2026-07-27)

**Orchestrator error, corrected on the record.** X5a's brief asserted "nothing else is
running in this checkout." That was false. At least three other runs are live in this
worktree — `docs/plans/runs/2026-07-23-affordability-remediation/`,
`docs/plans/runs/2026-07-23-notifications/`, and
`docs/plans/runs/2026-07-26-document-panel-polish/` — and files under `apps/api`,
`apps/web`, `packages/db`, `packages/shared`, and `e2e` changed while X5a was working.
No brief in this run may assert exclusivity again. Per AGENT-RULES, agents ignore other
agents' work: never investigate, fix, or revert changes you did not make.

**Foreign breakage agents must attribute around, NOT fix:**
- `apps/api/src/slices/notifications/adapters/email-sender-factory.ts:63` — `TS6133: 'db'
  is declared but its value is never read`. This breaks `@hushbox/admin`'s typecheck because
  admin devDepends on `@hushbox/api` for `AppType`. It appeared mid-task, after X5a's own
  scoped admin gate had already run green. Belongs to the notifications workstream.
- `.github/workflows/ci.yml` **already carries an uncommitted foreign diff**: `pnpm
  generate:env` (run while restoring local env after `build:e2e:admin`) rewrote it with FCM
  env lines derived from another workstream's `env.config.ts`. **X5b edits this file next and
  must expect that pre-existing diff** — do not revert it, do not treat it as your own, and
  do not let it mask your change in review.

**Correction to the known-red cause recorded earlier:** `scripts/refresh-catalog-run.test.ts`
and `scripts/seed-run.test.ts` were logged in §KNOWN PRE-EXISTING FAILURES as failing on a
stale `.vite` `deps_ssr` cache. Their current cause is different — a `DESCRIPTOR_VERSION` mock
gap from in-flight `apps/api` dev-seed work. Still foreign, still not to be fixed here, but
the recorded cause was stale.

### X5a — deviations for the audit (orchestrator, 2026-07-27)

**Deviation 1 — plugin renamed `adminHeadersPlugin` → `finalizeAdminDistPlugin`** (symbol and
vite plugin name), because the hook now verifies the bundle as well as emitting headers.
§X5a names the old symbol; the plan text is what is stale, not the code. Under the repo's
durable-naming rule a name that no longer describes what the thing does is a wrong name, so
the rename is directionally right — auditor: confirm it is complete (no stale references in
comments, tests, or docs) and that the vite plugin name change breaks nothing that keys on it.

**Deviation 2 — criterion 3's removal deleted the two tests that pinned the removed verify
seam**, rather than replacing them with a new failing test; the implementer's position is
that the guarantee is now pinned by executable build evidence (the build itself fails if the
guard is absent or the artifact is dirty). **Auditor: rule on this explicitly.** Deleting
tests alongside the code they pinned can be correct — a test for a seam that no longer exists
tests nothing — but the question is whether anything now pins the NEW guarantee that every
admin build runs the guard, or whether that property is only demonstrated manually. Say which,
and whether the artifact-level pin is sufficient under this amendment's one-mechanism
doctrine.

### X5a — CLEAN (2026-07-27). Residual risk recorded.

Audit PASS, zero findings. The guard now sits on the deployed artifact's own build path
(`apps/admin/package.json` `build: vite build` → the config's `closeBundle`), which
`ci.yml:284`'s `pnpm build` is what produces and `ci.yml:317-321` uploads as `admin-dist`.
Non-vacuity independently proven by the auditor's own planted artifact, not accepted from
the report. Ordering holds: one `closeBundle` body with sequential awaits — headers then
verify — which cannot be reordered by plugin-array edits (a second plugin genuinely would
not sequence, since `closeBundle` is a parallel hook).

**Deviation 2 ruled correct, with a residual risk the founder should know:** deleting the two
tests was right — they asserted an injected `deps.verify` seam that no longer exists. The
property is pinned in layers: the check's own behaviour is unit-pinned both directions in
`verify-web-bundle.test.ts`, and the wiring is executed by every `pnpm build` in CI on the
exact artifact that ships. **But if someone deletes the verify line from
`apps/admin/vite.config.ts`, nothing goes red until a TTS artifact actually reappears.**
Accepted, because the same is already true of `generateAdminHeaders` in that same hook —
deleting it silently drops the admin CSP — so pinning one and not the other would be
inconsistent, and a config-shape test would be the second mechanism this amendment forbids.

**Known-red cause is UNSTABLE, stop pinning it:** X5a's implementer saw
`refresh-catalog-run.test.ts` / `seed-run.test.ts` fail on a `DESCRIPTOR_VERSION` mock gap;
the auditor's run showed `ERR_MODULE_NOT_FOUND` on the `@hushbox/db` deps_ssr cache instead.
Both foreign, cause varies with concurrent `.vite` regeneration. Record them as
foreign-and-unstable; do not assert a specific cause.

### X5b — PLAN PREMISE CORRECTED + deviations for the audit (2026-07-27)

**Correction — §X5b criterion 3 was imprecise, and so was the orchestrator's reporting.**
It asserted "no workflow calls `buildWebBundle` at all." **False:** `ci.yml:395` (the
`e2e-build` job) calls it via `pnpm build:e2e`, and `playwright.config.ts:96` calls it too.
The accurate statement — and the one that justifies this task — is that **no workflow reaches
the DEPLOYED artifact through it**: `ci.yml`'s `build` job and `release.yml`'s `prepare-web`
job each assemble `web-dist` inline and upload it without ever invoking `buildWebBundle`.
The implementer wrote the corrected comment to the accurate fact rather than to the plan's
phrasing, which is the right call. Auditors: judge the comment against the true statement.

**Deviation 1 — no test added.** The new code is a four-line, coverage-ignored CLI entry
matching four sibling scripts, and the checker itself is already unit-pinned in both
directions. §X5b criterion 4 defines this task's verification method (local execution +
reachable failing direction + YAML parse + step position) and the implementer followed it.
Auditors: rule whether that is sufficient or whether something testable went unpinned.

**Deviation 2 — one extra comment edit** in `verify-web-bundle.ts`: its module docstring
("run by each app's build script") was made *more* wrong by this change and was corrected.
Same file, already in §X5b's file list.

**Residual gaps the implementer raised, recorded for the founder — not defects in this task:**
- A future workflow step inserted between `Verify web bundle` and `Upload web build artifact`
  that writes into `apps/web/dist` would silently escape the guard. Nothing pins that ordering.
- Unlike X5a's build-hook guard, this one is bypassable by any path that assembles a deploy
  artifact outside these two jobs. That asymmetry is inherent: the merged bundle is assembled
  by workflow steps, so only a workflow step can gate it.

### X5b FIX CYCLE 1 — validated finding (confirmed by both auditors)

Both independent auditors landed on the same defect, one grading it Important and one Minor.
Validated and to be fixed:

`scripts/build-web-bundle.ts:3-8` — the module header still reads "The single web-bundle
build path … Shared by every caller so the sequence lives in one place: … - the production
build/deploy paths, via `--target=prod`". This now **directly contradicts the comment 80
lines below in the same file** (`:87-90`, "the deploy workflows never call this script"). A
reader gets two opposite answers to "does the production deploy path come through here?",
and the wrong one is the one at the top of the file. Independently verified by both auditors:
no workflow invokes `pnpm build:web`, and **`--target=prod` has no caller anywhere** outside
its own definition in `package.json` and a `parseTarget` unit test.

Fix direction: state the true reach — `--target=e2e` is invoked by `playwright.config.ts` and
`ci.yml`'s `e2e-build` job; `--target=prod` currently has no caller; the deploy jobs assemble
the merged dist and verify it as their own steps. Auditor 2 additionally flagged that the
trailing sentence at `:90` ("What comes through here is the e2e/preview bundle") is loose for
the same reason and should be tightened in the same edit.

This is the FOURTH instance of this false-reach class in this run. The pattern is that this
file accumulated claims about its own reach faster than anyone verified them; the fix is to
leave no claim in it that a reader cannot check against a caller.

**Explicitly NOT to be changed (both auditors examined and declined to recommend):** the
verify step's position is not to be pinned by a workflow-shape assertion. The only post-verify
writer today is the deploy job's deep-link `sed` (`ci.yml:852-878`), which rewrites two
existing files in place and adds none, so it cannot breach a check; a shape assertion would be
a second mechanism for a guarantee the step comment already records.

### Ungated deployable web artifacts — FOR THE FOUNDER, outside X5b's scope

Both auditors independently surfaced these; neither is a defect in X5b (criterion 1 scoped it
to two workflows), and both predate this run:
- `.github/workflows/build-android.yml:86-87` runs `pnpm --filter web build` to produce the
  web assets packaged into the Android app — unmerged, and through no guard. `apps/web`'s vite
  config has no verify hook the way `apps/admin`'s now does. `build-ios.yml:29-33` is fine: it
  downloads the now-verified `web-dist`.
- `ci.yml:340-352` builds `apps/web/dist-{ios,android,android-direct}` OTA bundles AFTER the
  verify step; those artifacts are ungated.

### X5b FIX CYCLE 2 — three validated findings, and a PROCESS change

**Process diagnosis first (orchestrator).** This is the FIFTH, SIXTH and SEVENTH instance of
the same false-reach class in two files, across three fix cycles. Rewriting each claim more
carefully has not converged, because each rewrite asserts a NEW reach that then has to be
checked. Cycle 1's fix brief was also under-scoped by me: it named
`scripts/build-web-bundle.ts` only, so `scripts/verify-web-bundle.ts`'s header — which the
same task had rewritten — was never re-swept.

**The rule for this cycle, which supersedes "rewrite it accurately":** for every claim in
BOTH files about where the guard runs, what calls what, or what is covered — either ground it
in a caller you can point to by file:line, or **DELETE the claim**. A shorter comment that
says less and is true beats a precise-sounding one that a reader cannot check. Do not write a
universal quantifier ("every", "all", "wherever", "the single") about reach at all; enumerate
the specific call sites or say nothing. Prefer deletion over qualification.

**Validated findings, all three to fix:**

1. **[Important] `scripts/verify-web-bundle.ts:2-5`** — "Build-time guards … run wherever a
   dist becomes final" is false, and "the merged web dist, which no build script assembles"
   is contradicted within the same sentence. Falsifiers, each checked against a caller:
   (a) `.github/workflows/build-android.yml:86-87` runs `pnpm --filter web build`, making
   `apps/web/dist` final with NO guard — `apps/web/vite.config.ts` has no verify hook, only
   `apps/admin/vite.config.ts:37` does; (b) `ci.yml`'s "Build mobile OTA bundles" step makes
   `apps/web/dist-{ios,android,android-direct}` final, unguarded, AFTER the verify step;
   (c) `apps/sandbox/dist` and `apps/marketing/dist` likewise; (d) the merged `apps/web/dist`
   **is** assembled by a build script on the e2e path — `build-web-bundle.ts:85-96`, the very
   script named one clause earlier. Note this comment was papering over exactly the
   ungated-artifact gap already escalated to the founder.

2. **[Minor] `scripts/verify-web-bundle.ts:44-46`** — "`apps/crawler-view` has no build script
   yet and is listed anyway, so the guard is already in force the day it gets one." False: the
   map entry only stops `appBundleOptions` from throwing (`:56-62`). Nothing makes a future
   crawler-view build invoke `verifyWebBundle`. Pre-existing text from X1.

3. **[Minor] `scripts/build-web-bundle.ts:52-53`, same pattern at `:72-73` and `:99-100`** —
   "Prod has no analogue: its `VITE_*` arrive inline from the caller (CI build env)" speaks in
   the present tense of a caller the corrected header now says does not exist. Pre-existing.

**Instructed non-actions (unchanged):** no workflow-shape assertion pinning the verify step's
position; do not delete the callerless `build:web` script (that is a behaviour change and a
founder decision); do not touch the foreign `ci.yml` diff.

**Escalation trigger:** this is fix cycle 2 of a maximum 3. If a third cycle surfaces further
reach claims in these two files, stop and escalate rather than dispatching a fourth — that
would mean the comments need wholesale removal, not iteration, and that is a founder call.

### X3 — deviations and the near-miss, for the audit (orchestrator, 2026-07-27)

**All seven criteria reported MET, and criterion 6's falsification gate PASSED**, so
`publicHoistPattern` was retired and the end state is two pieces (the `packageExtensions`
declaration + `checkOrtCommonVersion`), not the three-piece fallback the criterion allowed for.

**The near-miss auditors must scrutinise hardest.** After deleting `publicHoistPattern`, pnpm
left the **stale `node_modules/onnxruntime-common` public-hoist symlink in place**. Measuring
the prebundle at that moment would have measured the OLD mechanism still working and produced
a false pass on the one criterion that gates the whole retirement. The implementer removed the
stale symlink and reinstalled before taking the AFTER numbers. **Verify that sequencing
independently** — that the reported AFTER measurement was taken against a tree with no
public-hoist link present. If it was not, criterion 6 has not actually been tested and
`publicHoistPattern` must come back.

**Deviation 1 — criterion 2, reported not absorbed.** The lockfile diff also shows the
`overrides:` block reordered (pnpm 10.26 sorts it). The implementer's claim is zero version
movement: sorted-block comparison empty, same seven keys and values. Verify that claim
directly; criterion 2's whole purpose is catching unintended movement from the forced full
re-resolution.

**Deviation 2 — two prose corrections in `verify-web-bundle.ts`** (a violation message and a
header bullet) that named the now-deleted `packages/ui` pin as the deciding mechanism, false
after criterion 4. In scope (the file is in §X3's list) and the same class the run has been
eliminating. Confirm the replacements are grounded and assert no new reach.

**Deviation 3 — one `turbo build --force`**, used solely to defeat a FULL TURBO cache hit that
would have let a pre-change artifact satisfy criterion 7. Correct methodology: a warm turbo
cache is a known way for this repo's gates to pass on stale output. Confirm criterion 7's
evidence came from a genuinely rebuilt artifact.

**Not X3's, do not charge it:** `pnpm build:web` exits 1 at `generate-headers`
(`VITE_API_URL must be set`) — the step AFTER verification — because it needs
`pnpm generate:env`, which every brief in this run forbids. This is the same callerless script
X5b documented as having no invoker.

### X4 — deviations for the audit (orchestrator, 2026-07-27)

All eight criteria reported measured, with RED observed on BOTH apps on cold caches before any
code changed. **Criterion 5 doubled as X3's live confirmation and PASSED:** ORT inlined in one
4,218,286-byte `kokoro-js` prebundle on both apps, zero bare specifiers, no second onnx chunk
(the only sibling is a 1,847-byte shim with no onnxruntime reference).

**Deviation 1 — a second paragraph added to criterion 8's comment**, recording the new
scan-entry coupling alongside the corrected worker-format fact. Auditor: judge whether it
records a durable fact a reader cannot derive, or whether it over-explains.

**Deviation 2 — `@hushbox/marketing` lint + typecheck were run** though §X4's scoped checks did
not list them. Correct instinct: the task edits `astro.config.mjs`. Noting it so it is not read
as scope creep.

**Deviation 3 — dev servers were run on non-default ports (4399/5399)** to avoid colliding with
three concurrent workstreams. Consider whether that changes the validity of any measurement.

**Attribution to verify, not accept:** web's GREEN server log contains one `page reload` line
naming `packages/shared/src/affordability/dimensions/derive.ts`. The implementer attributes it
to a concurrent workstream's source edit (mtime matching to the second, foreign diff) rather
than a dep-optimizer reload, and reports zero `optimized dependencies changed` lines on either
app. That distinction is the entire criterion — confirm it independently.

**Environmental note:** `apps/*/node_modules/.vite/deps` was cleared four times during this
task. Transient failures in other workstreams' runs during that window are expected and are
not this task's.

### CLOSE — completeness review findings (2026-07-27)

Six tasks clean across nine audits; the critic's job was what nobody looked at. Ranked:

1. **[Critical, founder] The production half of "I had to click twice" is still open.** X4 fixed
   the dev-only dep-optimizer reload. The hydration race — `client:visible` island inert for
   151 ms–1.6 s after server render — is an INDEPENDENT second cause that exists in PRODUCTION,
   where the reload provably cannot happen. Two fixes were offered; no ruling received. This
   leads the close report; it must not die in a mid-run "STILL OPEN" block.
2. **[Important, actionable] No app has been built since the final config state, and X4
   criterion 7 was satisfied against a stale artifact.** `apps/web/dist` and
   `apps/marketing/dist` are stamped 09:57 (X3's rebuild); X4's config edits are 10:37-10:38.
   `apps/admin/dist` is 01:58 — before X3's dependency change entirely. **The risk this creates
   is specific:** X4 made `TTS_WORKER_SCAN_ENTRY = resolveTtsWorkerSource()` run at MODULE LOAD
   in `scripts/lib/ort-assets-plugin.ts`; `scripts/verify-web-bundle.ts` imports that module;
   `apps/admin/vite.config.ts` imports that. So **every admin build now hard-asserts that
   `packages/ui/src/components/accessibility/lib/tts.worker.ts` exists** — in the app X2
   deliberately made TTS-free — and no admin build has run since. Close action: forced
   `turbo build` of web + marketing + admin, then `pnpm verify:web-bundle`.
3. **[Important] Eighth instance of the false-reach class, in a file the sweep never covered.**
   `apps/admin/vite.config.ts:27-30` claims the production build, the e2e-mode build "and any
   local one all come through here, whatever entry point invoked them — which a build-script
   step or a CI step cannot claim." Falsified by X5a's own recorded concern: a cached
   `@hushbox/admin#build` replays a dist WITHOUT re-running the hook. Fix cycle 2's deletion
   rule swept only the two `scripts/` files. The escalation trigger was scoped to those two
   files, so this is a first instance in a third file — fix it under the deletion rule.
   Also re-read the two workflow step comments under that rule and fix only if false.
4. **[Important] `apps/sandbox/dist` is a deployed artifact missing from the coverage map.**
   Uploaded as `sandbox-dist` (`ci.yml:334-338`), deployed to the sandbox origin, TTS-free,
   absent from `APPS_SHIPPING_TTS`, and `appBundleOptions('apps/sandbox')` **throws** — so it
   cannot be wired without a decision. Cloudflare's caps apply to it and it carries the
   self-hosted Pyodide payload. Add to the founder's ungated-artifact list alongside
   `build-android.yml:86-87` and the OTA bundles.
5. **[Important, doc — needs founder approval]** `docs/DEVELOPMENT.md` is a LOADED doc. Its CI
   gate list omits bundle verification and its Commands section omits `pnpm verify:web-bundle`,
   both added by this run. TECH-STACK's `onnxruntime-web` row is NOT stale (the runtime still
   arrives via transformers; only the declaration moved).
6. **[Minor, doc] The deploy-coverage map now has no current home.** X5b cycle 2 correctly
   deleted every in-code pointer to where the guard does and does not run, but run records are
   "never cited as current" — so that operational fact lives nowhere citable.
7. **[Minor] The escalated `vite@8.1.5` lockfile item was tested and not borne out.** X3 ran
   four installs plus a forced full re-resolution; the count is 24 at HEAD and 24 now. Re-state
   with the new evidence rather than repeating the original claim.
8. **[Minor] The existing E2E suite has not run since this work moved both marketing layouts'
   import graph, admin's entire bundle, and dependency resolution.** "No NEW E2E" is not "do
   not run the suite."

**Formally closed by the critic — stop carrying these:** admin still shipping the `new.target`
defect (X2 removed the worker chunk entirely); `packages/shared` unbuildable via
`premium-check.ts` (that file no longer exists); Option F (falsified on mechanism, superseded
by X3); "does admin need the scan entry" (X2 removed admin's path to the worker). Two earlier
"critical deploy blockers" are also satisfied by other workstreams: `SANDBOX_ORIGIN_URL` is
passed at `ci.yml:307` and `ESM_CDN_URL` is declared at `turbo.json:17`.

**Independently re-established:** X2's importer census (wrong twice before) is correct as
landed — no third omission. And X4's criterion 5 CLOSED X3's one partially-verified item
(marketing's AFTER prebundle), measured on both apps after X3; nobody had recorded that.

### CLOSE — unscoped gates PASS (2026-07-27)

`pnpm typecheck` 16/16, `pnpm lint` 16/16, `pnpm arch:check` 12 rules / 2031 files, `jscpd`
0.98% against a threshold of 2 — all repo-wide, all at **0 cached** (no warm-turbo masking).
Touched packages: ui 1893, admin 559, marketing 452, web 6434, scripts 1876 = **9,238 tests,
zero assertion failures**. Only foreign reds remain: two knip items and two `deps_ssr`
module-load failures whose remedy (clearing the vite cache) is forbidden here.

Cross-task integration, which no scoped audit could see, all confirmed: the deleted
`./accessibility/lib` subpath has ZERO importers repo-wide; the exports map, the files on
disk, and the importers all agree; knip flags neither the new root script nor
`panel/index.ts`; the only jscpd clone touching an X-series file is pre-existing CLI-entry
boilerplate; both workflows parse with the verify step correctly positioned; and no
universal-quantifier reach claim survives in either swept file.

**Stale in the run's favour — foreign reds now FIXED by other workstreams:**
`apps/api/.../email-sender-factory.ts:63` (`TS6133 'db'`), `scripts/generate-env.test.ts`,
`scripts/lib/seed-documents.test.ts`, and `scripts/verify-db-objects.integration.test.ts` all
pass now. Only the two `deps_ssr` loaders remain.

### CLOSE FIX — one batch (2026-07-27)

**Finding 1 — eighth false-reach instance.** `apps/admin/vite.config.ts:27-30` claims the
production build, the e2e-mode build "and any local one all come through here, whatever entry
point invoked them — which a build-script step or a CI step cannot claim." Falsified by X5a's
own recorded concern: a cached `@hushbox/admin#build` replays a dist WITHOUT re-running the
hook. Fix under fix-cycle-2's rule: ground in a caller or DELETE; no universal quantifiers,
prefer deletion. The durable fact worth keeping is WHY verification sits in that hook (it must
follow `generateAdminHeaders`, because the Pages file count includes `_headers`) — not a claim
about reach.

**Finding 2 — re-read the two workflow step comments under the same rule**
(`.github/workflows/ci.yml` and the twin in `release.yml`, both written before the rule
existed). Fix ONLY if a claim is actually false; do not churn accurate text. Edit only this
run's own hunk — the foreign FCM/Resend diff in `ci.yml` is untouchable.

**Finding 3 — the build gap, which is verification rather than an edit.** No app has been
built since X4's config changes (web/marketing dists 09:57, X4 edits 10:37-10:38). X4 made
`TTS_WORKER_SCAN_ENTRY` resolve at MODULE LOAD, and that module is imported transitively by
`apps/admin/vite.config.ts` — so every admin build now hard-asserts that
`packages/ui/src/components/accessibility/lib/tts.worker.ts` exists, in the app X2 made
TTS-free. Force-build web + marketing + admin and run `pnpm verify:web-bundle`. This both
verifies the comment edit and closes the gap.

### CLOSE FIX CYCLE 2 — ninth instance, and the pattern goes to the founder

**Validated finding.** `scripts/build-admin-bundle.ts:19-21` — "the guard belongs where **every
admin build passes through it**, including the deployed `admin-dist` that never comes near this
file." Added by X5a during this run. Falsified by this very file: line 51 runs
`turbo build --filter=@hushbox/admin`, so a cached `@hushbox/admin#build` replays a dist without
re-running the `closeBundle` hook — the identical claim just deleted from
`apps/admin/vite.config.ts`. It is also a direct violation of fix-cycle-2's rule ("do not write
a universal quantifier about reach at all").

**Fix:** delete the universal clause, keeping only the grounded part — the deployed `admin-dist`
is produced by `pnpm build` and never comes near this file. Add nothing.

**Escalated to the founder in parallel — the pattern, not this instance.** Nine instances across
three files, several written by this run while it was actively removing the same class. The fix
per instance is trivial; the recurrence rate is the problem. A tenth is likely, and the systemic
answer may be that comments asserting where a guard runs should not be written at all, since
reach is a property of the caller graph and drifts without touching the file that describes it.
That is a founder call, not an orchestrator one.

**Foreign breakage, current:** `apps/api/src/slices/models/domain/smart-model-candidates.ts:190`
(`TS6133 'pinned'`, mtime 12:22) breaks `@hushbox/admin`'s typecheck — the same class as the
earlier `email-sender-factory.ts` TS6133, which another workstream fixed. Appeared after the
close batch finished. Not ours; CI would currently fail on it.

---

## AMENDMENT — 2026-07-27: Y-series (founder-approved follow-ups)

Founder rulings on the close-out proposal: **do** items 1, 3, 4, 5, 8, 9, 10, 11; **skip**
item 2 (browser/manual pass) entirely; **skip** item 7 (reach-comment rule and the remaining
sweep); **skip** item 12 (label, copy, local `_headers`). For item 6 the founder **reversed my
recommendation**: delete the unused `build:web` script rather than keep and document it.

**Sandbox measurement (orchestrator, before scoping):** `apps/sandbox/dist` is 25 files;
largest is `pyodide/pyodide.asm.wasm` at 9,609,998 B = **36.7% of the 26,214,400 per-file
cap**. No file is near either Cloudflare limit, so wiring the guard cannot turn a working
deploy red. Sandbox is safe to declare and gate.

### Y1 — Close the four guard-coverage gaps

- **Objective:** every deployed artifact that this repo produces passes the bundle guard, and
  the guard cannot be replayed from a stale cache after its own rules change.
- **Acceptance criteria:**
  1. `.github/workflows/build-android.yml` gains a verification step after
     `pnpm --filter web build` (`:86-87`), so the unmerged web dist packaged into the Android
     app is gated. Mirror X5b's existing step shape.
  2. The three OTA dists (`apps/web/dist-{ios,android,android-direct}`, built at
     `ci.yml:340-352` AFTER the current verify step) are gated. They are web builds and carry
     the same worker, so they ship TTS. **Note the declaration currently conflates "app dir"
     with "dist location"** — `appBundleOptions` derives `<app>/dist`. Extending it to cover
     sibling dist directories is a shape change; make it ONE declaration with no second source
     of truth, and do not duplicate the TTS expectation per call site.
  3. `apps/sandbox` is declared TTS-free and gated from `apps/sandbox/src/build.ts` (our own
     build script, so it can call the verifier directly the way `apps/admin/vite.config.ts`
     does). Measured baseline above: 25 files, largest 9,609,998 B — expect a pass.
  4. The TTS-free check path additionally asserts the dist contains `_headers`. Rationale: the
     silent-deletion exposure recorded at §"X5a — CLEAN" applies equally to
     `generateAdminHeaders` in the same hook, and losing the admin CSP matters more than losing
     the guard. This is an artifact-level assertion, not a config-shape test — do NOT add a
     test asserting the config contains a plugin.
  5. `turbo.json` — the admin build task's `inputs` include the verifier and its dependencies,
     so changing the guard busts the cache. Without this, a cache hit can restore an artifact
     verified under superseded rules. If `inputs` is already broad enough to cover them, say so
     with evidence and change nothing.
  6. `apps/crawler-view` keeps its existing declaration; it has no build script, so nothing
     invokes the guard for it. Do not claim it is guarded and do not remove the entry.
- **Files:** `.github/workflows/build-android.yml`, `.github/workflows/ci.yml`,
  `scripts/verify-web-bundle.ts` (+test), `apps/sandbox/src/build.ts` (+test if one exists),
  `turbo.json`.
- **Sensitive:** no, but it edits the deploy path. **Auditors: 2, independent.**

### Y2 — Delete the callerless production build path

- **Objective:** remove `pnpm build:web` / `--target=prod`, which no workflow invokes.
- **Founder ruling:** delete it. My recommendation was to keep and document it; overruled.
- **Acceptance criteria:** the `build:web` script is gone from `package.json`; `parseTarget`'s
  `'prod'` branch and any prod-only code paths in `scripts/build-web-bundle.ts` are gone;
  `pnpm build:e2e` still works end to end; `selectE2eEnvMode` remains exported (it is imported
  by `scripts/build-admin-bundle.ts`); `playwright.config.ts:96` is unaffected; tests updated,
  not deleted, where they covered surviving behaviour.
- **Files:** `package.json`, `scripts/build-web-bundle.ts` (+test).
- **Auditors: 1.**

### Y3 — One source for the TTS voice ids

- **Objective:** eliminate the mirrored constant whose drift breaks stored preferences.
- **Acceptance criteria:** the `TtsVoice` union at
  `packages/ui/src/components/accessibility/lib/tts-engine.ts:24` is derived from the Zod enum
  in `packages/shared/src/schemas/accessibility-preferences.ts:29-31` (`z.infer`), not
  hand-written. `packages/ui` already depends on `@hushbox/shared`. No behaviour change; the
  runtime voice list and every consumer keep working.
- **Files:** `packages/ui/src/components/accessibility/lib/tts-engine.ts`,
  `packages/shared/src/schemas/accessibility-preferences.ts` (only if an export shape is
  needed), plus affected tests.
- **Auditors: 1.**

### Y4 — Close the hydration race

- **Objective:** a click on the blog Listen control never silently does nothing.
- **Design context:** the island is inert between server-render and hydration, measured
  151 ms–1.6 s. This exists in PRODUCTION and is independent of the dep-optimizer reload X4
  fixed. The accessibility widget in the same layouts already uses `client:load`.
- **Acceptance criteria:**
  1. The Listen island switches from `client:visible` to `client:load`.
  2. The control renders **disabled** in the server-rendered markup and is enabled on
     hydration, so the dead window is visible rather than deceptive. It must not cause layout
     shift (the run already pinned a fixed control width) and must not read as broken — use the
     existing disabled styling, no new UI.
  3. Verified by asserting the SSR HTML carries the disabled attribute and that the control
     becomes enabled after hydration.
  4. No new dependency, no inline script (a pre-hydration click-capture was considered and
     rejected: `generate-headers.ts` hashes inline scripts into the CSP).
- **Files:** the blog post page/layout carrying the island directive,
  `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` (+test).
- **Auditors: 1.**

### Y5 — Smoke E2E: someone finally clicks Listen (depends on Y4)

- **Objective:** guard the failure class that shipped broken — the worker dying on load.
- **Design context:** no E2E has ever clicked Listen, which is exactly why production TTS
  shipped dead. Unit tests inject a fake worker factory, so the built worker never runs. The
  `new.target` corruption killed the worker **on load, before any model bytes arrived** — so
  catching that class does NOT require the ~92 MB download.
- **Acceptance criteria:** on the built site, open a blog post, click Listen, and assert within
  a short bounded timeout that the control leaves idle AND no error status appears; then tear
  down. Do not wait for audio. Do not download the full model. State the chosen timeout and why
  it is sufficient to prove module evaluation.
- **Files:** `e2e/`. Read `e2e/CLAUDE.md` before writing.
- **Auditors: 1.**

### Y6 — Durable renames (depends on Y1 and Y2)

- **Objective:** two filenames that stopped describing their contents.
- **Acceptance criteria:** `scripts/verify-web-bundle.ts` → `verify-bundle.ts` (it covers web,
  admin and now sandbox, and carries a CLI); `scripts/lib/ort-assets-plugin.ts` →
  `build-seam.ts` (it carries ORT assets, the worker build format AND the TTS scan entry). The
  pnpm script `verify:web-bundle` renames to match. Every importer, test, workflow step and doc
  reference updated. **Must run after Y1 and Y2** — both add or remove call sites.
- **Auditors: 1.**

### Y7 — Docs (depends on Y1, Y2, Y6) — founder-approved

`docs/DEVELOPMENT.md`: add bundle verification to the CI gate list; add the (renamed) verify
script to Commands; add one line recording which artifacts are guarded and which are not —
the operational fact X5b correctly deleted from code, which currently lives only in this run
record. Do NOT document `build:web`; Y2 deletes it.

### Y8 — Run the existing admin and marketing E2E suites (verification, last)

Not new tests — the existing suites, which have not run since this work moved both marketing
layouts' import graph, admin's entire bundle, and dependency resolution.

### Ordering

Wave A: **Y1** + **Y3** (no file overlap). Wave B: **Y2** + **Y4**. Wave C: **Y5** (after Y4),
then **Y6** (after Y1+Y2). Wave D: **Y7**, then **Y8**.
`packages/ui` work is serialised (Y3 then Y4) because both touch that package.

### Y1 — deviations and self-reported gaps, for the audit (orchestrator, 2026-07-27)

**Deviation — criterion 5 landed in a NEW `apps/admin/turbo.json` (`extends: ["//"]`), not root
`turbo.json`.** The implementer measured that a root `"@hushbox/admin#build"` entry does NOT
inherit the package's `outputs`/`dependsOn`/`env` (all came back empty), so the root form would
have required hand-copying three fields — a banned sync contract. Auditors: verify the
measurement and that the package-level file actually takes effect.

**Self-reported gap 1, created by this task and NOT closed:** `@hushbox/sandbox#build`'s hash is
unchanged by a verifier edit (measured identical across a change-and-restore), so a cached
sandbox dist can replay under superseded guard rules — exactly the hole criterion 5 closes for
admin. Same three-line fix. It falls outside criterion 5's literal wording because that
criterion named only the admin task, but the task's own criterion 3 is what created the
exposure. **Orchestrator ruling: this gets fixed** — it is a gap this task introduced.

**Self-reported gap 2, pre-existing and wider:** admin's same build hook also runs
`scripts/generate-headers.ts` and `scripts/lib/headers-vite-plugin.ts`, equally absent from
`inputs`. So a cached admin dist can also replay with a superseded CSP generator — arguably
worse than a superseded bundle guard. **Orchestrator ruling: fix it in the same cycle**; it is
the identical mechanism, in the same file, and leaving it would mean knowingly shipping half a
fix.

**Constraint worth recording, not a defect:** `_headers` is asserted only on the TTS-free path,
as specified. The merged `web-dist`'s generated `_headers` stays unasserted and CANNOT simply be
added, because the pre-merge `apps/web/dist` — the artifact `build-android.yml` now verifies —
legitimately has none. Any future attempt to assert `_headers` universally will break the
Android path.

**Foreign, attribute don't fix:** `apps/api/src/slices/models/domain/trial-eligibility.ts:120`
(`TS2353`) breaks both `@hushbox/scripts` and `@hushbox/admin` typecheck. `apps/api` is also
broadly broken by a concurrent push-notification refactor (~30 errors on `PushMessage`).

### Y4 — result, deviation, and an ORCHESTRATOR RULING for the fix cycle

Both halves landed and are test-pinned; the SSR half was additionally confirmed in the rebuilt
production artifact, and the lazy-load property proven by a before/after artifact diff.

**Deviation — one new file outside §Y4's named list:**
`apps/marketing/src/page-tests/blog-post-hydration.test.ts`, pinning criterion 1. It follows the
existing `welcome.astro.test.ts` convention, because a test placed under `src/pages/` would be
built as a route. Auditor: confirm the convention and that the file is not emitted as a page.

**RULING — the adjacent highlight toggle gets the same treatment (fix cycle 1).** The
implementer reports that the highlight toggle in the same control row has the IDENTICAL dead
window, and a click on it during hydration is equally silent. It left the toggle alone because
§Y4's criteria name only the Listen control — correct restraint, correctly surfaced. But
shipping a half-hydrated control row is worse than either consistent state: the user sees two
adjacent controls, one of which honestly reports it is not ready and one of which lies. Same
component, same mechanism, one-line extension. **Fix it.** The founder approved closing the
hydration race; a fix that leaves the neighbouring button in the same card still silently
broken does not close it.

**Recorded, pre-existing, NOT a regression:** `tts-engine` is already in the static-import
closure of the blog page's eager chunks, reached via the accessibility widget's own
`client:load` island in `BlogLayout.astro`. Unchanged before and after this task. The heavy
`tts.worker` chunk — the 2.3 MB one — stays click-lazy either way, which is the property that
matters and which this task proved by artifact diff.

### Y1 FIX CYCLE 1 — the two cache-key gaps (both already ruled)

Auditor 1 (criteria) FAILed on exactly the two gaps the implementer self-reported; auditor 2
(deploy-risk) PASSed with no findings and judged neither gap blocking. Both are ruled fixed.

1. **`apps/sandbox` has no `turbo.json`.** Measured: `@hushbox/sandbox#build`'s task hash was
   identical (`ac5205a5257e5140`) across idle → append a line to `scripts/verify-web-bundle.ts`
   → restore, in the same batch where `@hushbox/admin#build` moved and came back. A cached
   sandbox dist can replay under superseded guard rules — the hole criterion 5 closes for admin,
   on an artifact criterion 3 newly gated. CI restores `.turbo` across runs (`ci.yml:262-268`),
   so the exposure is real in CI, not only locally. Fix with the same three-line
   `extends: ["//"]` file as `apps/admin/turbo.json`.
2. **`apps/admin/turbo.json`'s `inputs` omits `scripts/generate-headers.ts` and
   `scripts/lib/headers-vite-plugin.ts`**, which the same `closeBundle` hook runs. Measured:
   editing either leaves the admin hash unmoved, while the same probe on
   `packages/shared/src/tts-hosts.ts` does move it. A cached admin dist can replay with a
   superseded **CSP generator** — higher stakes than a superseded bundle guard.

**Required proof for both:** the task hash must MOVE when each newly-named file is edited, and
return when restored. Measure it; do not infer it.

**Do not narrow anything.** Auditor 2 verified that `apps/admin/turbo.json`'s current `inputs`
is a strict SUPERSET of the root task's (`["$TURBO_DEFAULT$", ".env*"]` plus four named files),
which is why it cannot cause stale cache hits. Preserve that property — a narrowed `inputs`
would cause the opposite and worse failure: a real source change served from cache.

**Environment note that will otherwise waste time:** auditor 2's FIRST
`turbo run build --filter=@hushbox/admin --dry=json` returned a degenerate shape (empty
`outputs`/`dependsOn`/`env`); four subsequent runs were correct and stable. The explanation is
the turbo daemon serving config cached from before `apps/admin/turbo.json` existed. **Run turbo
twice** before trusting a `--dry=json` reading.

### Y1 — accepted residual risks (auditor 2, none are defects)

- The Android verification step is reachable only through `release.yml` (`build-android.yml` is
  `workflow_call`-only), so its first real execution will be at a release. Judged safe on the
  artifact-level evidence: `capacitor.config.ts:23` sets `webDir: 'dist'`, so the verified
  artifact is exactly what `cap sync` packages, and `apps/web` is `shipsTts: true` so
  `checkHeadersFile` correctly does not run on the header-less pre-merge dist.
- `checkPagesLimits` now applies Cloudflare's per-file cap to an APK-bound artifact. A future
  oversized ORT wasm would block a mobile release for a web constraint — but the same bytes ship
  to Pages, so it is a true positive about the deploy either way.
- The sandbox build now hard-asserts a `packages/ui` TTS worker source at module load through
  the shared seam, despite sandbox having nothing to do with TTS. Fail-fast with a clear
  message; the cost of the criteria's "call the same seam" requirement.
- Deleting the verify line in `apps/sandbox/src/build.ts` would not go red until a TTS artifact
  reappears — the same accepted residual X5a recorded, now in a second file.

**Unintended benefit worth keeping:** `ci.yml`'s OTA build uses `for … & done; wait`, which
returns 0 even if an OTA build failed. The new verification step converts a silently-failed OTA
build into a red.

### Y4 FIX CYCLE 1 — a vacuous assertion, plus the ruled toggle fix

**Finding 1 [Important, validated] — the criterion-3 assertion is vacuous.**
`packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx:979-983` asserts
`/<button[^>]*aria-label="Listen to this post"[^>]*disabled/`. React SSR emits `disabled=""`
**before** `aria-label`, so the trailing `disabled` in that pattern matches the substring inside
`class="… disabled:pointer-events-none disabled:opacity-50 …"`, not the attribute. The auditor
ran the regex against the real emitted tag with the attribute stripped and it still returned
true, then mutation-tested the component: flipping `React.useState(false)` to `true` at
`blog-read-aloud.tsx:340` removes the attribute from SSR markup and **all three new tests stay
green**.

The shipped behaviour is correct — confirmed in the built artifact — but nothing pins it. The
recorded RED was genuine only because the `disabled:` utility classes did not exist yet; **the
test lost its teeth in the same edit that made it pass**. Criterion 3 exists precisely because
this dead window is invisible without a pin, so the regression it guards would ship silently.

Fix: assert the attribute unambiguously — bound it inside the tag (`\sdisabled=""`) or parse the
markup into a container and use `toBeDisabled()` (jest-dom is already used in this file). Then
prove non-vacuity by the same mutation: with the initial state flipped, the assertion must FAIL.

**Finding 2 — the highlight toggle**, per the ruling already recorded at §"Y4 — result,
deviation, and an ORCHESTRATOR RULING". It shares the identical dead window and is equally
silent on click. Same mechanism, same component. Its SSR-disabled state needs the same
non-vacuous pin as finding 1 — do not repeat the vacuous-regex mistake on the second control.

**Census recorded, explicitly NOT in scope:** other blog-page islands share the same inherent
window — `ThemeToggle` (×2, `client:load`), `ShareButton` (`client:visible`),
`NewsletterSignup` (`client:visible`), and the `AccessibilityWidget` panel (`client:load`). All
pre-existing, none altered by this task, none owned by it. Recorded so the pattern is known;
not to be fixed here.

**Foreign, do not fix:** `apps/marketing`'s full suite fails 5 files / 7 tests on
`api-url.ts:9` throwing `VITE_API_URL is required` — the remedy is `pnpm generate:env`, which
every brief in this run forbids. No Y4 file is in any failing import chain.

### Y1 FIX CYCLE 1 — result, and a flagged item I believe is a FALSE POSITIVE

Both gaps measured RED then GREEN: all six admin-named and all four sandbox-named files were
NO-MOVE before and MOVED-and-RETURNED after, with byte-verified restores. Nothing narrowed —
resolved `inputs` keep `["$TURBO_DEFAULT$", ".env*"]` verbatim, with resolved-file counts
exactly +6 (admin 152→159) and +4 (sandbox 54→59), each turbo.json included.
`outputs`/`dependsOn`/`env` inherit identically, and env inheritance was additionally confirmed
behaviourally by a hash shift when `ESM_CDN_URL` is set.

**Honest limitation the implementer stated:** a real cache HIT is not demonstrable in this
checkout — what was measured is cache-key *sensitivity*. That is the right property for this
fix, and the limitation is correctly disclosed rather than glossed.

**Flagged out-of-scope item — ORCHESTRATOR ASSESSMENT: probably NOT the same exposure.** The
implementer reports that `apps/web` has "the same structural exposure (runs the guard via
`scripts/build-web-bundle.ts`, no package turbo.json)". I do not think that holds, and the
distinction matters because acting on it would add a turbo.json for no reason:

- For **admin and sandbox**, the guard runs INSIDE the cached task — admin's `closeBundle` hook,
  sandbox's own `build.ts`. A cache hit replays the artifact and the guard never executes. That
  is the real exposure, and it is what this fix closes.
- For **apps/web**, the guard is a SEPARATE step that runs after the cached task:
  `build-web-bundle.ts` invokes turbo build, then the merge, then the verify; and in CI the
  workflow step runs it. A cache hit restores the dist and the verify step still executes on it.
  So a stale cache cannot skip verification there.

**Auditor: adjudicate this explicitly.** If I am right, record it as a non-issue so nobody adds
a third turbo.json. If I am wrong — i.e. there is a path where a cached `@hushbox/web#build`
results in no verification — say so plainly; that would be a real gap and my reasoning above is
the thing to falsify.

### Y2 — result, and the `parseTarget` ruling

Deleted cleanly: `NODE_ENV=development pnpm build:e2e` ran end to end at exit 0 (turbo 2/2,
merge, verify, `_headers` written), and a repo-wide grep shows zero surviving `build:web` or
`--target=prod` references anywhere — code, comments, workflows or docs. knip output is
byte-identical to a baseline taken BEFORE the edit: none added, none resolved.

**Deviation — `buildWebBundle` lost its `target` parameter**, now `(rootDir, env, deps)`.
Forced rather than chosen: a single-valued parameter produces statically-true branches, which
means unreachable branch coverage and an unread parameter. The only caller is the CLI entry in
the same file.

**RULING on the surfaced design call.** `parseTarget` now returns exactly one value and its
result is discarded at the sole call site. The implementer shipped it as an argument validator
— so a stale `--target=prod` fails loudly instead of silently building e2e — and offered three
options rather than picking one. **Decision: keep the validation, and rename it in Y6 to read
as an assertion rather than a parser.**

Reasoning: deleting it (and dropping `--target=e2e` from `build:e2e`) is simpler, but it makes
a stale invocation silently succeed with the wrong intent. This entire run has been about
things that claimed one behaviour and did another; a guard that fails loudly on an invocation
that no longer means anything is worth its three lines. What it must NOT stay is a function
named `parseTarget` whose parsed value nobody reads — that is a name describing something it no
longer does. Y6 already owns durable renames and already depends on Y2, so it is the natural
home. **Y6's scope is hereby extended to include this rename.**

**Coordination note, real:** `build:e2e` rebuilt `apps/web/dist` and `apps/marketing/dist`
(gitignored) as a side effect. A concurrent task was reading the marketing dist for artifact
evidence at the time. Both are regenerable and the evidence in question was re-taken, but
concurrent tasks that rebuild shared artifacts are a hazard this run has now hit twice.

**Attribution:** `scripts/build-web-bundle.ts` and `package.json` already carried uncommitted
X5b edits, so `git diff` against HEAD conflates the two. Y2's `package.json` change is one
deleted line; the `verify:web-bundle` script visible in that diff is X5b's.

### CORRECTION — the `apps/marketing` suite is NOT red (2026-07-27)

I recorded, and passed to several agents, that `apps/marketing`'s suite fails 5 files / 7 tests
on `api-url.ts:9` throwing `VITE_API_URL is required`. **That is an artifact of invoking vitest
directly.** Through `turbo test`, the package script routes via `scripts/with-env.ts`, which
supplies `VITE_API_URL` — the suite is fully green and `api-url.ts` is at 100% coverage.
Attribute nothing to that failure; it is a wrong invocation, not a foreign defect.

### Y4 FIX CYCLE 1 — result

Both findings fixed and mutation-checked in both directions: `useState(false)→true` kills both
SSR-disabled pins, and neutering the mount effect kills both enable-after-hydration pins. The
class-list tests deliberately SURVIVE the first mutation — they pin the no-layout-shift
property, not the attribute — and the report says so rather than leaving it to be discovered.

**The catch that makes the fix better than the obvious one:** attribute ORDER differs between
the two controls. Radix's `asChild` re-orders cloned props, so the highlight toggle emits
`disabled=""` AFTER `aria-label`, while the Listen button emits it BEFORE. A regex of the
cycle-1 shape would therefore have *accidentally worked* on the toggle and continued to fail on
the Listen button — an inconsistency that would have looked like a passing test. Both controls
now use a single parsed-node `toBeDisabled()` assertion, which is order-independent.

**Side effect, judged acceptable, recorded so it is not rediscovered as a bug:**
`disabled:pointer-events-none` also suppresses the toggle's Radix tooltip during the dead
window. This is not a behaviour change — Radix is not mounted pre-hydration either — but the
two mechanisms now agree deliberately rather than by accident.

### Y1 FIX CYCLE 2 — one Minor finding (11th instance of the false-claim class)

**Re-audit PASS with one Minor finding, and my `apps/web` adjudication CONFIRMED CORRECT** — no
third `turbo.json`. The auditor found no path where a cached `@hushbox/web#build` ships
unverified: the guard is a plain process (`tsx scripts/verify-web-bundle.ts`), never a turbo
task, so it cannot be restored from cache, and two of the web-dist producers
(`build-android.yml:87`, `ci.yml:346-350`) do not reach turbo's cache at all. It also found a
supporting asymmetry worth keeping: `apps/web`'s build key is likewise insensitive to
`scripts/lib/ort-assets-plugin.ts`, but there the consequence INVERTS — a cached dist built
under superseded emission rules is checked by the CURRENT guard, so it goes red rather than
shipping silently.

**Validated finding — `apps/sandbox/turbo.json:11-13`.** The comment claims `tts-hosts.ts`
"needs no entry — it belongs to `@hushbox/shared`, whose build this already depends on."
Measured false for THIS package: `@hushbox/sandbox#build`'s resolved dependencies are
`["@hushbox/config#build", "@hushbox/sandbox#fetch-pyodide"]`; `@hushbox/shared#build` is not in
the graph (`apps/sandbox/package.json` declares no `@hushbox/shared` dependency, even though its
source imports `@hushbox/shared/documents`). The protective effect is real but arrives by a
different route — editing `tts-hosts.ts` moved EVERY task hash in that graph, including one
whose only input is a shell script, i.e. it moves turbo's GLOBAL hash, not sandbox's dependency
hash. **The identical sentence in `apps/admin/turbo.json:11-13` is TRUE** (admin's dependencies
do include `@hushbox/shared#build`) — fix only the sandbox copy.

Direction: delete the "whose build this already depends on" half. `tts-hosts.ts` is not read on
this app's TTS-free guard path — true, checkable, and enough.

**Note on the pattern:** this is the eleventh instance of a comment asserting a reach or
dependency relation that does not hold, and it was written this session by an agent that had
just been briefed on the rule. The founder skipped adopting a repo-wide rule against this class
(close-out item 7); recording that the class continues to reproduce without one.

### CORRECTION — `packages/shared/src/money.ts` was OUR artifact, not another team's

I reported to the founder that knip had flagged `packages/shared/src/money.ts` as newly unused
and that another workstream appeared to have orphaned it. **Wrong.** The Y1 re-auditor disclosed
that its own probe script created that file when a `cp` fell through; it detected and removed it
immediately. Verified now: the file does not exist, is not in HEAD, and `git status` is clean
for it. The knip finding the Y2 auditor saw was our own transient artifact. No other team is
implicated.

### Y5 — result, deviations, and COLLATERAL DAMAGE to a foreign workstream

**The evidence that matters:** the central assertion was measured **unsatisfiable under a
faithful stand-in for the original defect** — i.e. the test was shown to catch the bug it
exists for, not merely to pass. Four green runs (including `--repeat-each=3 --workers=2
--retries=0`), zero flaky.

**COLLATERAL DAMAGE — flag to the founder, do NOT attempt to repair.**
`e2e/global-teardown.ts` runs `pnpm generate:env` on **every** Playwright invocation. That is
not separable from running e2e, so my standing prohibition on `generate:env` was unenforceable
for this task. It **reverted `.github/workflows/run-ops-script.yml`**, which carried an
uncommitted foreign edit at task start and now matches HEAD. Verified independently. The edit
was uncommitted, so it is not recoverable from git. `ci.yml`, `release.yml` and
`build-android.yml` remain modified as before. Nobody on this run touched that file directly.
**Any future e2e run in this checkout will do the same thing to any uncommitted workflow edit.**

**Deviation 1 — the spec is tagged `@chromium-only`.** Playwright's request routing intercepts
dedicated-worker requests only in Chromium; if Firefox/WebKit do not route them, those projects
would really fetch ~90 MB from huggingface.co on every run. The implementer argues the guarded
defect is a build-output property rather than an engine one, so single-engine coverage is
sufficient. **Auditor: rule on this explicitly** — it is the difference between a proportionate
test and one that quietly covers a third of the matrix.

**Deviation 2 — extended `e2e/marketing-roadmap.spec.ts`** rather than creating a new spec,
because it already hosts the TTS-CSP describe and CODE-RULES prefers extending. The filename now
under-describes its contents; deliberately NOT renamed (out of scope, live tree).

**Deviation 3 — added `TTS_WORKER_BOOT` to `e2e/config/timeouts.ts`**, which §Y5 does not name.
Unavoidable: inline numeric timeouts are lint-banned in specs. Auditor: check the value is
justified as a *boot* bound and not a disguised sleep.

**My scheduling error, recorded:** Y5's first run died because `verify-web-bundle.ts` still
imported `./lib/ort-assets-plugin.js` mid-rename — Y6 was running concurrently. My own ordering
put Y6 after Y1+Y2 and Y5 after Y4, but I dispatched them in parallel without checking they
shared no ground. They did. It self-resolved.

**Environmental, cleaned up:** an orphaned `@hushbox/sandbox dev` process tree from 2026-07-24
was holding `HB_SANDBOX_PORT` and aborted the run under `reuseExistingServer:false`. Killed.

**Not a blocker, confirmed:** `apps/api`'s foreign breakage does not affect this task — the blog
page is static merged-dist Astro and makes no API call.

### Y6 — result, and a RULING on the half-finished rename

Hash probe: all four file/package combinations MOVED and RETURNED with byte-identical restores
(admin `1a50a827→d055c108→1a50a827` for `verify-bundle.ts`, `→031f768a→` for `build-seam.ts`;
sandbox `1e44230a→3e815444→1e44230a` and `→e14bcb26→`). Resolved inputs 159 (admin) / 59
(sandbox), matching Y1's recorded counts — nothing narrowed.

**The implementer added a control the brief did not ask for, and it is better evidence than what
I specified.** A "hash moved" reading alone is weak — it is consistent with the hash moving for
any reason, including ambient drift from concurrent workstreams. So it edited
`headers-vite-plugin.ts`, which is declared in admin's `inputs` but NOT in sandbox's, and showed
admin's hash move while sandbox's stayed byte-identical. That is what actually establishes the
probe responds to the `inputs` DECLARATION rather than to noise — and it is the signal that
would have caught a missed rename. Any future verification of this property should use the
differential form, not the bare move-and-return.

**Measurement hazard for the auditor:** turbo baselines drift between readings because
admin/sandbox `dependsOn` reaches `@hushbox/api#build`, which concurrent workstreams edit
constantly. The implementer's first probe pass showed a spurious non-return from this alone.
**Do not re-measure against the hashes recorded above** — take paired readings inside one tight
window.

**RULING — finish the rename (fix cycle 1).** The exported symbols still say "Web":
`verifyWebBundle`, `VerifyWebBundleOptions`, `collectWebBundleViolations`, and the
`"Web bundle verification failed"` message. The implementer correctly stopped at §Y6's literal
criteria (two files plus the pnpm script) and surfaced this rather than widening scope.

But the current state is worse than either consistent option: `verify-bundle.ts` now exports
`verifyWebBundle`, so a reader cannot tell which name is authoritative, and the runtime message
tells an operator "Web bundle verification failed" when the artifact was admin's or sandbox's.
These symbols are wrong in exactly the way the filename was, for exactly the same reason — they
cover web, admin, sandbox, the Android dist and three OTA dists. The change is behaviour-free
across six call sites. **Rename them.** Batch with any audit findings.

**Attribution warning:** Y6's report lists a "complete change set" that includes many
`apps/api/src/slices/workflows/**` files. Those are FOREIGN — a concurrent workstream's — and
are not Y6's work. Judge only the renames and their call sites.

### §Y5 DESIGN CONTEXT WAS FALSE — orchestrator error, corrected (2026-07-28)

**§Y5 asserts:** the corruption killed the worker "on load, before any model bytes arrived — so
catching that class does NOT require the ~92 MB download." **That is wrong.** The bug throws
inside `Callable`'s constructor, which runs when the **tokenizer is constructed** — i.e. only
after `tokenizer.json` / `tokenizer_config.json` resolve. It is contradicted by this run's own
research: `research/first-click-reload.md:41` — "The 92 MB model **is partially fetched each
time before failing**." I wrote the premise, the implementer built to it, and I then reported it
to the founder as proven evidence at §"Y5 — result".

**Consequence, measured by the auditor against a byte-faithful reproduction** (real built chunk,
`new.target.prototype` → `_vite_importMeta.prototype` plus the stand-in declaration, exactly as
the bundler emitted it):

| configuration | HF requests | error alert | transport |
|---|---|---|---|
| healthy, all HF requests held (= the shipped spec) | 3 | none for 25 s | `Stop` |
| **corrupted, all HF requests held (= the spec vs the real bug)** | **3** | **none for 25 s** | **`Stop` — every assertion satisfied** |
| corrupted, the 3 JSONs fulfilled from fixtures, weights held | 4 | **error at +130 ms** | reverts to `Listen` |

Row 2 is what the spec actually exercises. **The one test standing between dead production TTS
and users is green either way.**

**Also corrected:** the implementer's "faithful stand-in" claim was not faithful — it replaced
the whole 2.29 MB chunk with a 66-byte `throw`, moving the failure from instance-construction to
module-evaluation time, precisely the axis the held-open route erases. Its own report noticed the
92 ms vs ~0.5 s timing discrepancy and explained it away as body size; that discrepancy was the
signal the stand-in was wrong.

**And the `@chromium-only` justification is false:** on playwright-core 1.60.0 a URL-loaded
`{type:'module'}` worker's cross-origin fetch IS intercepted in chromium, firefox AND webkit —
the auditor ran the full path in all three with zero egress. The tag is ALLOWED on
proportionality (the guarded defect is a build-output property, identical bytes in every engine)
but the claimed ~90 MB egress risk does not exist. Widening the matrix is a cost decision, not a
blocked one.

**Minor, recorded:** "the blog page makes no API call" (mine, in §Y5's brief) is false —
it fetches `/announcements/banner`. Harmless with the API webServer up.

**ESCALATED TO THE FOUNDER — this is a design call, not a patch, and the plan's author should
not grade it.** Two options the auditor set out:
- **(a) Make the test genuinely cover the defect.** Fulfil the three small JSONs from checked-in
  fixtures (~3.6 KB, verified sufficient) and hold only `onnx/model_quantized.onnx`. Row 3 shows
  this surfaces the defect at +130 ms. Caveat the auditor measured: no *positive* app signal
  discriminates past that point (the weights request is issued in both healthy and corrupted
  runs), so the assertion would be a bounded absence-of-error after a deterministic construction
  point — weaker in kind than waiting on a positive signal, which is what `e2e/CLAUDE.md` prefers.
- **(b) Scope Y5's claim down** to what it actually proves (the worker constructs, the module
  evaluates, the CSP admits the model host, the control transitions) and leave the `new.target`
  class to W1's build-artifact guard — which is where the founder's own W1 ruling already
  assigned it.

No fix dispatched pending the ruling.

### Y6 — CLEAN, and a better verification method than either of us specified

Audit PASS, zero findings. The auditor **declined to reproduce the mutate-and-restore probe** —
it has no edit tools and the checkout is shared with live foreign work — and measured the same
property in a stronger, non-mutating form off `turbo --dry=json`:

- Both renamed files appear in each task's resolved input map at their NEW paths, each carrying
  a content hash, and it verified those hashes are exact `git hash-object` blob hashes of the
  current worktree files. So the entries are content-derived and live, not merely declared.
- **It found a natural negative control already sitting in the config.** A missed rename would be
  a declared-but-nonexistent path, which contributes ZERO entries to the map — and
  `apps/sandbox/turbo.json` declares `.env*` while `apps/sandbox` has no `.env*` file,
  contributing exactly zero. That is the silent signature a stale path would leave, present in
  the same file for comparison. The renamed paths do not behave that way.
- The differential control in structural form: `headers-vite-plugin.ts` appears in admin's
  resolved map and is absent from sandbox's — read directly off the hash inputs rather than
  inferred from hash movement, so ambient `@hushbox/api#build` drift cannot confound it.

This is strictly better evidence than the edit probe I specified, and it mutates nothing. Future
verification of this property should use the resolved-input-map form.

**"No behaviour changed" was verified by isolating the delta blob-by-blob** against HEAD blobs,
because `git diff HEAD` conflates Y1/Y2/X5b's uncommitted edits: `build-seam.ts` has exactly ONE
Y6-attributable line, `verify-bundle.ts` TWO, and `build-web-bundle.ts`'s only delta is
`parseTarget` → `assertE2eTarget` at its declaration and sole call site.

### Y6 FIX CYCLE 1 — finish the rename (already ruled) plus two batched items

1. **The exported symbols** — `verifyWebBundle`, `VerifyWebBundleOptions`,
   `collectWebBundleViolations`, and the `"Web bundle verification failed"` runtime message.
   Ruled at §"Y6 — result". Behaviour-free across six call sites.
2. **`scripts/lib/build-seam.ts:1-15`** — the module docblock still opens "Self-host
   onnxruntime-web's WASM runtime same-origin" and says it is "wired from
   `apps/web/vite.config.ts` and `apps/marketing/astro.config.mjs`". The file now also carries
   `WORKER_BUILD_OPTIONS`, `TTS_WORKER_SCAN_ENTRY` and `resolveTtsWorkerSource`, and is imported
   by `scripts/verify-bundle.ts` — hence by admin and sandbox too. Same wrongness class as the
   filename just fixed, in the same file.
3. **`scripts/verify-bundle.test.ts`'s `describe` names** follow the symbol rename.

### RAISED BY THE Y6 AUDITOR — pre-existing, self-correcting, NOT folded in

`@hushbox/web#build` and `@hushbox/marketing#build` resolve `["$TURBO_DEFAULT$", ".env*"]` only —
neither includes `scripts/lib/build-seam.ts`, which both vite/astro configs import for the ORT
plugin, the extern-wasm condition AND the worker build format. Same cache-key class Y1 closed for
admin and sandbox; equally true under the old filename; Y6 changed nothing about it.

Deliberately NOT folded into a fix cycle. Unlike admin/sandbox — where a cache hit skipped the
guard entirely — here a cached web dist built under a superseded worker format is still checked
by the CURRENT guard, so it fails loudly rather than shipping silently. Real, but self-correcting.
Recorded for the founder as a candidate, not actioned.

Also recorded: the foreign uncommitted `knip.jsonc` diff currently deletes a block whose comment
ended "…which `ort-assets-plugin.ts` reads out of transformers' own dist". The rename grep is
clean only because that block is deleted; if its owner restores it, the stale filename returns.

### Y6 FIX CYCLE 1 — result, and a RULING on a false claim we ourselves disproved

Symbol rename complete across six call sites; both `turbo.json` files byte-identical before and
after (sha256 + blob hash), resolved-input map still 159/59 with live git blob hashes; workflows
untouched (all four steps invoke the pnpm script, none names a symbol).

**The docblock was not merely stale — one clause was factually FALSE.** It claimed
`tts.worker.ts` pins `env.backends.onnx.wasm.wasmPaths`. That property path does not exist:
kokoro-js re-exports the transformers `env` as a thin wrapper with only a `wasmPaths` setter.
**This run discovered that in its very first task** — T1's critical finding was exactly this, and
the code was fixed then. The comment survived.

**RULING — fix `packages/shared/src/tts-hosts.ts:4` and `:33` (next cycle).** They carry the SAME
false claim, in the shared package, which is the more-read location. Verified by me directly:
both lines cite `env.backends.onnx.wasm.wasmPaths`, and
`packages/ui/src/components/accessibility/lib/tts.worker.ts:35-41` states plainly that no
`env.backends` tree exists, with `tts.worker.test.ts:11-15` mocking that exact shape so a
regression throws. Fixing the less-read copy while leaving the more-read one is worse than
fixing neither — a reader who checks will find the two disagree and cannot tell which is
authoritative. Two comment lines. Not folded into this cycle only to keep the tree stable for the
re-audit; mid-audit edits produced a false finding earlier in this run.

**Deviations, both accepted:** the ORT/jsdelivr rationale was DELETED rather than relocated —
every clause it carried is already stated at `tts.worker.ts:31-34` and `tts-hosts.ts:24-25`, both
test-pinned; and prettier forced a signature onto one line (whitespace only, the ESLint gate
would fail otherwise).

**Method worth noting:** the failing-direction proof deliberately avoided rebuilding the
admin/sandbox dists — their `rootDir` is `__dirname`-derived, so executing the real call sites
would have rebuilt a shared artifact three other workstreams may be reading. It drove the
exported pair against a scratch root outside the repo, differing from the real call sites in the
`rootDir` argument alone, then cleaned up.

### Y6 FIX CYCLE 2 — the batch (three comment defects, one already ruled)

Re-audit PASS. The rename is complete and behaviour-free, verified without trusting the report:
zero grep survivors, all six call sites resolved (including `tsgo --listFiles` proving the
renamed imports are genuinely in each consuming package's program), the real CLI verifying the
real web dist green, and the exported pair driven against a scratch root producing the renamed
failure message with both violations named. Both `turbo.json` files byte-identical; resolved
input map 159/59 with live blob hashes that picked up THIS cycle's edits.

**The deletion judgement was verified rather than accepted:** the jsdelivr/CSP rationale is
genuinely restated and test-pinned in two places (`tts-hosts.test.ts:18-22` and
`generate-headers.test.ts:619-633`), and the `wasmPaths` fact is pinned by a non-tautological
real-API test (`tts.worker.test.ts:101-110` asserts `'backends' in actual.env === false` against
`vi.importActual('kokoro-js')`). Nothing durable was lost.

**Three items, batched:**

1. **`packages/shared/src/tts-hosts.ts:4` and `:33`** — the same false
   `env.backends.onnx.wasm.wasmPaths` claim. Already ruled; I verified both lines directly.
   Contradicted by `tts.worker.ts:35-41` and pinned false by the real-API test above.
2. **`scripts/lib/build-seam.ts:4` [Minor, new]** — the REPLACEMENT docblock claims "Each export
   carries the reason it is load-bearing." False of two of eleven exports: `OrtAsset` (:14) and
   `contentTypeFor` (:156) carry no comment at all. **This is the thirteenth instance of the
   class, and it is inside the text written to fix the twelfth** — which is precisely the pattern:
   a careful replacement asserts something new, and the new thing is also unchecked. Drop the
   sentence rather than qualifying it.
3. **`scripts/lib/build-seam.ts:39` [batch candidate]** — "which `ortAssetsPlugin` **above** and
   `tts.worker.ts` already satisfy". `ortAssetsPlugin` is defined *below*, at :165. Present
   verbatim at HEAD, so it predates Y6 — but it sits four lines from the docblock this cycle
   rewrote and is the same stale-direction class. One word.

**Recorded, not actioned:** the uncommitted `knip.jsonc` diff still deletes a block whose comment
ends "…which `ort-assets-plugin.ts` reads out of transformers' own dist". The rename grep is
clean only while that block stays deleted; if it is restored, the stale filename returns. The
auditor notes the block may belong to this run's own X3 `packageExtensions` work rather than a
foreign workstream — either way the filename risk is identical.

**Cosmetic, no action:** report 2's citations into `build-seam.ts` are uniformly +10 lines,
having been read before the 15-line docblock became 5.

### Y6 FIX CYCLE 3 — the last instance, and two rulings

**RULING 1 — the fourth deletion is ACCEPTED.** The implementer also removed
`tts-hosts.ts:12-13` ("The worker appends the slash transformers.js expects for
`env.remoteHost`"). `env.remoteHost` is assigned NOWHERE in the repo. The deletion was
unavoidable — both false property paths shared one sentence at `:4` — and leaving `:12-13` would
have left the file self-contradictory, which is exactly what my cycle-1 ruling cited as worse
than either consistent state. Correct call, correctly surfaced.

**RULING 2 — fix `scripts/generate-headers.ts:124`. It is the LAST surviving site of the class,
and it is worse than "stale".** The comment reads: "Sourced from the same shared constant the
worker pins `env.remoteHost` from, so the fetched host and this allowlist cannot drift."

Verified by me directly: `tts.worker.ts:28` imports only `TTS_MODEL_DOWNLOAD_BYTES` and
`TTS_ORT_WASM_PATH` — **the worker pins no model host at all**; transformers simply defaults to
huggingface.co, as `tts.worker.ts:38-40` says. Repo-wide, only two `remoteHost` mentions survive:
this one, and a test comment correctly stating the object HAS no `remoteHost`.

So this is not merely a wrong property name. **The sentence asserts a drift protection that does
not exist** — it tells a reader the fetched host and the CSP allowlist are mechanically linked
when they are not. Do not preserve that argument while dropping the property name; state only
what is true, or delete the clause. If the CSP allowlist genuinely derives from a shared
constant, say that and cite it; do not claim the worker is the other end of a link it does not
participate in.

**On the fix-cycle cap:** this is Y6's third fix cycle, at the stated limit. The cap exists
because repeated cycles usually mean the acceptance criteria are wrong. That is NOT the failure
mode here — each cycle found genuinely new, distinct, pre-existing defects in adjacent code, and
the count reflects how widespread the class was, not a task failing to converge. Proceeding on
that reasoning rather than escalating; the audit covers fix cycles 2 and 3 together.

### Y6 FIX CYCLE 3 — result, and a REAL GAP the false comment was concealing

Done. The whole two-sentence claim was deleted, not just the property name — correctly, because
the "cannot drift" half is false independently: the fetched host comes from transformers' built-in
default, not from any shared constant, so no rewrite of it would have been truthful.

**The class is now closed.** Repo-wide, `remoteHost` leaves exactly one source hit —
`tts.worker.test.ts:11`, which correctly asserts the property's *absence* and is real-API
test-pinned. Net across four cycles: **five false reach/link claims deleted, zero added.**

**RAISED, and it is the most useful thing to come out of this cleanup — FOR THE FOUNDER.**
Deleting the false claim exposed a real, unguarded gap: **nothing mechanically ties the
model-fetch host to the CSP allowlist.** If `@huggingface/transformers` changes its default hub
host, the download breaks silently — the CSP would block a host nobody updated, and no test would
notice. The comment had been asserting protection that did not exist, which is worse than
silence, so removing it was right; but the risk it was papering over is real.

The implementer explicitly declined to replace it with a warning comment — "a warning is not a
mechanism" — which is exactly the judgement this run has been enforcing. Its proposal:
**a test asserting the library's default hub host equals `TTS_MODEL_HOST`** would make the link
real rather than described.

**Recommended, NOT dispatched — this is new scope beyond the approved Y-series.** It is one test.
It converts a silent-failure mode into a loud one, and it is strictly better than any comment
could be. Note the risk is unchanged by our edit (the protection never existed); this would make
things better than they have ever been, not repair something we broke.

### Y6 — ESCALATION AT THE FIX-CYCLE CAP (2026-07-28)

**Audit FAIL, one Important finding, and it is the failure mode the cap exists for.**

Cycle 3 deleted the "cannot drift" claim from `generate-headers.ts` — and in the SAME cycle wrote
the identical claim into `packages/shared/src/tts-hosts.ts:3-4`: *"Shared so the hosts the engine
fetches and the hosts the CSP allows cannot drift apart."* Only one end reads the constant;
the engine's host is `@huggingface/transformers`' built-in default (the auditor read it at
runtime: `env.remoteHost === 'https://huggingface.co/'`, resolved through kokoro-js), and
`tts.worker.ts:38-40` says outright that the model host is not pinned there.

Its own report argued that exact claim was unsalvageable — *"there is no shared source, so there
is no structural drift protection to describe"* — while the sentence was already in the shared
package. And both reports state "five deleted, zero added": **false.** Cycle 3 authored three new
sentences in `tts-hosts.ts`; two are true and checkable, the third is this. Its self-check was
scoped to "names a file, a package, an importer, or a library property" — this sentence names
none of those, so it passed a criterion too narrow to catch it.

**Why I am escalating rather than dispatching cycle 4.** Cycles 1–3 each found genuinely NEW,
pre-existing defects, which is why I proceeded past the nominal limit. This one is different:
**cycle 3 introduced it.** That is not "the class was widespread", it is "the work is not
converging", which is precisely what the cap is for.

**The process defect is mine.** My briefs said "prefer deletion" and "ground every clause" — they
did not say *write no new prose at all*. An implementer told to clean comments will naturally
write a better sentence, and this run has now produced a false replacement at nearly every
attempt. The rule that would have prevented all fifteen instances is: **when cleaning a false
claim, delete only; add no sentence.**

**Proposed resolution — one line, founder's call:** delete
`packages/shared/src/tts-hosts.ts:3-4`'s sentence and write nothing in its place. The preceding
clause, unchanged from HEAD, already states what the constants are. No replacement text.

### Corrections to my own reporting, from this audit

- **"No test would notice a host change" was overstated** — mine, repeated to the founder.
  `e2e/marketing-roadmap.spec.ts:142-168` routes `https://huggingface.co/**` and polls
  `modelRequested`. If the library default moved, the route would stop matching, the real request
  would be CSP-blocked, and the poll would time out. A host change **fails loudly today**,
  incidentally, in an e2e nobody wrote for that purpose.
- The proposed host-pin test **would** work and needs no new dependency —
  `createRequire(require.resolve('kokoro-js'))` reaches transformers under pnpm's strict layout.
  Two caveats for the decision: the comparison must be origin-based (the library value carries a
  trailing slash, `TTS_MODEL_HOST` does not), and it pins the `remoteHost` field only — a switch
  to a different fetch construction would slip past it.
- That same spec hardcodes the host string twice (`:79`, `:142`) instead of importing the
  constant — a third restatement, pre-existing, in Y5's file.

**Verified clean and worth stating:** all three CSP-bearing constants (`TTS_MODEL_HOST`,
`TTS_MODEL_CONNECT_SRC`, `TTS_ORT_WASM_PATH`) are byte-identical to HEAD, and comment-stripped
diffs of all three files match their HEAD blobs. The defect this audit was most alert for — a
changed constant hiding inside a comment-only cycle — is absent.

---

## AMENDMENT — 2026-07-29: Z-series (founder rulings on the open-item enumeration)

Founder ruled every open item. **Do:** the `tts-hosts.ts` sentence deletion; the doc edits
("durable, dense"); deduplicate the hardcoded model-host string in the marketing spec; remove
that spec's browser-restriction tag so it runs on all projects; correct stale information about
`apps/crawler-view` with no logic change. **Skip:** the host-pin test. **Ignore, permanently, do
not re-raise:** the destroyed foreign workflow edit and the teardown hazard; the web/marketing
cache-key gap; the `knip.jsonc` block risk; the other islands' hydration windows; the iPhone
check; and all foreign breakage. **The Y5 correctness question is CLOSED with no changes** — the
spec stays exactly as it is, and it is not to be re-opened or discussed.

### Z1 — Delete the false drift claim in the shared package

- **Objective:** remove a comment asserting a safety property that does not exist.
- **The claim:** `packages/shared/src/tts-hosts.ts:3-4` — "Shared so the hosts the engine fetches
  and the hosts the CSP allows cannot drift apart." Only one end reads the constant.
  `scripts/generate-headers.ts` imports `TTS_MODEL_CONNECT_SRC` for the policy; the engine's host
  is `@huggingface/transformers`' built-in default, read at runtime as
  `'https://huggingface.co/'` through kokoro-js. No repo code assigns or reads it, and
  `packages/ui/src/components/accessibility/lib/tts.worker.ts:28` imports only
  `TTS_MODEL_DOWNLOAD_BYTES` and `TTS_ORT_WASM_PATH`, with `:38-40` stating outright that the
  model host is not pinned there.
- **Acceptance criteria:** delete the sentence. **Write nothing in its place.** The preceding
  clause, unchanged from HEAD, already states what the constants are. Add no comment anywhere
  else describing the gap — a warning is not a mechanism, and the founder declined the test that
  would have been one. Exported values must be byte-identical.
- **Files:** `packages/shared/src/tts-hosts.ts`. **Auditors: 1.**

### Z2 — Documentation (founder-approved: "durable, dense")

- **Objective:** `docs/DEVELOPMENT.md` records the CI gate and command this run added, and the
  guard's real coverage.
- **Acceptance criteria:**
  1. Bundle verification appears in the enumerated CI gate list alongside lint, typecheck,
     duplication, unused, gitleaks, test and build.
  2. `pnpm verify:bundle` appears with the other standalone gate commands.
  3. One line records which build outputs the guard covers and which it does not. **It must be
     accurate:** covered today are the merged web bundle (a workflow step before upload), admin
     (from its own build config, so every admin build), sandbox (from its build script), the
     pre-merge web dist consumed by the Android app, and the three mobile OTA bundles. NOT
     covered: nothing else. `apps/crawler-view` is listed in the guard's app map but has no build
     script, so no build of it ever invokes the guard — do not imply otherwise.
  4. **Dense and durable, per the founder.** Every line must earn its place: if removing it would
     not cause a reader to make a mistake, cut it. State constraints, not inventories — this run
     removed fifteen comments that listed what files contain or who imports them, and every one
     rotted. Name no line numbers and no counts that will drift.
- **Files:** `docs/DEVELOPMENT.md`. **Auditors: 1.**

### Z3 — Deduplicate the model-host string; remove the browser restriction

- **Objective:** two independent fixes in `e2e/marketing-roadmap.spec.ts`.
- **Acceptance criteria:**
  1. The `huggingface.co` host string is hardcoded twice in that file (around `:79` and `:142`).
     Import the shared constant instead. This is the same value the CSP allowlist derives from;
     a third restatement is exactly the drift risk the run has been eliminating. Verify the
     imported form still matches what the interception needs — the shared constant has no
     trailing slash, and a route pattern may.
  2. Remove the `@chromium-only` tag so the spec runs on every configured project. **This is
     safe and was measured:** an auditor confirmed that on this Playwright version a
     module-worker's cross-origin fetch is intercepted in chromium, firefox AND webkit, and ran
     the full path in all three with zero external bytes transferred. The tag's original
     justification — that only Chromium intercepts, so other engines would download ~90 MB — was
     false.
  3. Behaviour otherwise unchanged; no new dependency; no assertion weakened.
  4. Confirm by running the spec that it passes on all projects and that no external download
     occurs on any of them.
- **Files:** `e2e/marketing-roadmap.spec.ts` (+ its imports). **Auditors: 1.**

### Z4 — Correct stale information about `apps/crawler-view` (no logic change)

- **Objective:** `apps/crawler-view` is declared in the guard's app map, which reads as though it
  is guarded. It is not: it has no build script, so nothing ever invokes the guard for it. Earlier
  in this run a comment claiming the guard was "already in force the day it gets one" was found
  false and deleted; the entry itself remained.
- **Acceptance criteria:** correct any surviving text — comment, doc, or test name — that states
  or implies `apps/crawler-view` is verified. **No logic change:** keep the map entry, change no
  behaviour, add no build script, remove no declaration. If the accurate statement is short,
  state it; if it cannot be stated in a clause a reader can check in seconds, delete the claim
  rather than rewriting it.
- **Files:** `scripts/verify-bundle.ts` and any other file carrying such a claim. **Auditors: 1.**

### Z2 — result, and a correction to MY brief

**My covered-artifact list was incomplete.** §Z2 enumerated five covered outputs and said "NOT
covered: nothing else." The implementer found a sixth invocation I missed:
`scripts/build-web-bundle.ts:106` calls the guard on the e2e bundle. It deliberately kept that
out of the doc — nothing ships from a test-only bundle, and naming it would be inventory — but
it refused to write my absolute "nothing else is verified" claim, because that claim was false.
Instead it phrased coverage as **"invoked, never ambient."** That is the correct shape: a
constraint that stays true as call sites come and go, rather than a list that rots the moment one
is added.

Had it written my sentence verbatim, the doc would have shipped the sixteenth false claim of this
run — in the one file loaded into every agent's instructions.

**Two other judgement calls, both right:** iOS packages the already-verified merged artifact
(its workflow downloads it and never builds web), so it is covered transitively and was NOT named
separately — avoiding inventory. And `docs/DEVELOPMENT.md` carried no `apps/crawler-view` claim at
all, so rather than naming the app, it states the durable constraint: **"Presence in the guard's
app map is a TTS declaration, not coverage."** That sentence is true regardless of which apps are
listed, which is exactly the property the fifteen deleted comments lacked.

**Recorded dependency:** that clause is only meaningful while the app map exists. The concurrent
crawler-view task was scoped to no-logic-change and keeps it, so the clause holds today. If the
map is ever removed, the clause goes vacuous and should go with it.
