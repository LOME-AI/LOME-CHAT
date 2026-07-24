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
  Extraction: readable block elements in document order (`p, h1..h6, li, blockquote`), skipping `pre` (code blocks are not read). Offsets are character offsets into the block's normalized-source text sufficient for T3 to build a Range.
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

### T1 — CSP: allow the model download in deployed builds

- **Objective:** verify and fix the generated response headers so the Kokoro model download (Hugging Face CDN) is permitted by `connect-src`.
- **Design context:** analyst found `scripts/generate-headers.ts:108-116` lists no Hugging Face host (Inferred blocked; affects existing chat TTS in deployed builds, latent because the rewrite is not deployed). The fix precedes/parallels the feature. The implementer must determine the actual request hosts empirically or from `@huggingface/transformers` source (hub host + LFS/CDN hosts + any onnxruntime .wasm fetch host if not bundled), not guess.
- **Acceptance criteria:** (1) a test pins that generated headers for both web and marketing surfaces include every host the model fetch touches in `connect-src`; (2) the host list is written once (shared constant), not duplicated per surface; (3) evidence in the report of where each host requirement comes from (source line or observed request).
- **Files:** `scripts/generate-headers.ts` + its colocated test + any header-constant file it already uses. Nothing else.
- **Scoped checks:** run the script's own test file via the suite that covers `scripts/` (implementer identifies it; if none exists, colocated vitest run) + `pnpm typecheck` scoped as available + `pnpm lint` on edited files.
- **Sensitive:** no. Auditors: 1.

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
