# T4 — Blog "Listen" read-aloud UI + marketing wiring — impl report 1

## Objective

Build the blog `BlogReadAloud` control (borderless right-aligned stack: download bar,
Listen/Stop + highlight toggle, two-line disclosure) in `packages/ui`, mount it in the
blog post header band, test-first for the component logic, with the heavy reader/engine
loaded only by the first-click dynamic import (G2).

## Files changed

- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` (new) — the `BlogReadAloud`
  island: status slot + Listen/Stop + highlight toggle + disclosure; first-click dynamic
  import of the reader/highlighter; run-token guard; Esc/stop/unmount handling.
- `packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` (new) — 26 component
  tests (reader/highlighter mocked at the module seam; real a11y store).
- `packages/ui/src/components/blog-reader/index.ts` (new) — barrel export.
- `packages/ui/package.json` — added export entry `"./blog-reader"`.
- `apps/marketing/src/pages/blog/[slug].astro` — wrapped byline + tags into a left column
  and added `<BlogReadAloud client:visible />` as a right sibling in a stretch-aligned band.
- `packages/shared/src/schemas/accessibility-preferences.ts` (+ `.test.ts`) — added the
  persisted `readingHighlight: z.boolean().default(true)` preference. **This is the true
  home of the a11y store schema that plan T4 names as `store/schema.ts`** (which is a pure
  re-export of `@hushbox/shared`). See Deviations.

`store/schema.ts` and `store.ts` were **not** changed: the new field auto-flows through
`reconcileAccessibilityPreferences` and `ACCESSIBILITY_PREFERENCES_DEFAULTS`, so the store,
its `update`, and its `merge`/persist path pick it up with no edit.

## Component structure

`BlogReadAloud` (light island) renders three centered rows in a borderless, no-background
container (G9): a fixed-height `ReaderStatusSlot` (download bar while `loading`, error line
while `error`, else empty — reserved `min-h-8` so the stack footprint is constant across
idle/loading/speaking/error, criterion 3), a controls row (`ListenButton` + `HighlightToggle`),
and the two-line disclosure. Reader orchestration lives in module-scope helpers
(`wireReader`, `paintChunk`) to keep nesting/complexity within lint limits.

State machine: UI status `idle | loading | speaking | error` derived from the reader's
`onState` (reader `idle`/`stopped` → UI `idle`). A monotonic `runIdRef` + a `live()` guard
drops every effect of a superseded run (stop during import, or late callbacks after stop) —
its false branch is exercised by the "ignores stale reader callbacks after a stop" test.

## First-click dynamic import + G2 proof

On the first Listen click the component `await Promise.all([import('../accessibility/lib/document-reader'),
import('../accessibility/lib/chunk-highlighter')])` — relative dynamic imports, so no new
package subpath was needed. `document-reader` statically pulls `tts-engine` → `tts.worker`,
so the entire engine sits behind that first-click import.

Built `apps/marketing` (`pnpm --filter @hushbox/marketing build`, exit 0) and inspected the
client chunks:

- Island chunk `blog-reader.*.js` (7.5 KB, contains "Preparing the voice"): `kokoro`,
  `onnxruntime`, `KokoroTTS`, `tts.worker` markers = **0**. It holds only the dynamic
  `import()` references to `document-reader.*.js` / `chunk-highlighter.*.js` /
  `tts-engine.*.js`.
- Engine code lives in separate chunks: `tts-engine.*.js`, `tts.worker-*.js`,
  `document-reader.*.js`, `chunk-highlighter.*.js`.
- Built blog page HTML (`dist/blog/*/index.html`) references **only** `blog-reader.*.js`;
  no engine/reader chunk is scripted or `modulepreload`ed; `kokoro|onnxruntime` string count
  in the HTML = 0.

So the marketing blog page's initial JS contains no engine/kokoro code (G2, criterion 2).

## Persisted-pref schema addition + widget unchanged

`readingHighlight` added to the shared `accessibilityPreferencesSchema` (default `true`).
Persist `version` stays `literal(1)` — no migration: `reconcile` fills the missing field
with the default. The accessibility widget renders a fixed set of fields and does not read
`readingHighlight`, so its behavior is unchanged (full ui suite green, 1844 tests). The
blog toggle reads/writes it via `useA11yStore` (criterion 5, persisted).

## Marketing band alignment + non-overlap

`[slug].astro` header: `<div class="mt-4 flex flex-col gap-6 sm:flex-row sm:items-stretch">`
with a left column (`flex min-w-0 flex-1 flex-col`) holding the byline row then the tags row,
and a right column (`flex w-full items-center justify-center sm:w-60 sm:flex-none`) holding
`<BlogReadAloud client:visible />`. `items-stretch` makes the right column span the band's
height and center the stack, so its top aligns with the avatar top and its bottom with the
tags-row bottom. The band is the header column (right edge = content column right edge);
`sm:w-60` = 15rem, right sibling = right-justified. "On this page" (`details`, and the
desktop aside grid) sit **below** the header band, so no overlap. Below `sm` the band is
`flex-col` and the stack drops under the tags at `w-full` (criterion 1).

## Exact copy

- Disclosure, two centered `block` lines: `Local text to speech.` /
  `First listen downloads the voice model (about 90 MB, one time).` (G6, criterion 4).
- Download bar label: `Preparing the voice`.
- Error line: `Couldn't start playback. Try again.` (no em dash).
- Highlight tooltip: `Highlight while reading: on` / `Highlight while reading: off`.

## Tests added (26; criterion covered)

- idle render / no active chrome; two-line disclosure verbatim; toggle default pressed (4).
- toggle flips aria-pressed + persists to store; on/off tooltip copy on hover / when off (5).
- first click shows download bar (`role=status`, "Preparing the voice") + Stop immediately (3).
- constructs reader with container + store `ttsVoice` + highlighter; `start()` once (voice G5).
- article absent → error, reader not constructed; constructing throws → error line.
- reader `loading` keeps bar; `onDownloadProgress` → percent; `speaking` hides bar (3).
- highlight on → `highlighter.highlight(span)`; off → `clear`; toggle off mid-read clears (5).
- complete → idle + clear; `stopped` → idle; `error` → alert + clear.
- Stop button → `reader.stop` + idle; Esc while active → stop; Esc while idle ignored;
  stale callbacks after stop ignored; second Listen replays; unmount stops (6).
- custom `articleSelector` reads the named container.

Reduced-motion (criterion 7): download-bar animation is owned by the shared `TtsDownloadBar`
(T5, already tested) and auto-scroll by the highlighter (T3); the component delegates both.
a11y (criterion 8): Listen/Stop and toggle carry `aria-label`; toggle carries `aria-pressed`;
icons `aria-hidden`; keyboard path is native buttons + Esc.

## Self-gate

- `pnpm test:ui` — **pass** (94 files, 1844 tests; per-file 95% coverage gate satisfied; exit 0).
- blog-read-aloud.tsx coverage — **100%** lines/branches/functions/statements.
- `turbo typecheck --filter @hushbox/ui --filter @hushbox/marketing --filter @hushbox/shared`
  — **pass** (3/3).
- `turbo lint --filter @hushbox/ui --filter @hushbox/marketing` — **pass** (2/2). My shared
  files (`accessibility-preferences.ts` + test) lint clean (exit 0, verified from package dir).
- `pnpm --filter @hushbox/shared test` — **pass** (105 files, 2349 tests; schema coverage 100%).
- `jscpd --threshold 2` on `packages/ui/src/components/blog-reader` — **0 clones**.
- `pnpm --filter @hushbox/marketing build` — **pass** (exit 0; used for the G2 proof).

### Not attributable to me (concurrent work)

`turbo lint --filter @hushbox/shared` fails, but only on `packages/shared/src/documents/`
(`bridge.ts` / `bridge.test.ts` — `DocumentErrorCode`/`ConsoleStream`/`FrameToParentMessage`
sandbox messaging), an **untracked** directory (`??`) not present in my start-of-task
`git status` snapshot and unrelated to this task. My shared files lint clean.

## Acceptance criteria

1. Header-band placement / top-avatar & bottom-tags alignment / right edge on column / no
   "On this page" overlap / drops below narrow — **met** (see Marketing band; visual review
   pending in-browser but structure matches rev-5 mock).
2. Initial marketing JS has no engine/kokoro — **met** (G2 build proof above).
3. idle→loading→speaking, shared download bar above controls, no popover/floating/resize,
   no border/background — **met** (fixed-height slot; borderless container; states tested).
4. Buttons centered; disclosure two exact centered lines — **met**.
5. Highlight default on, always-visible toggle with shared Tooltip, persisted — **met**.
6. Stop via button + Esc, both idempotent — **met**.
7. Reduced-motion respected — **met** (delegated to `TtsDownloadBar` + highlighter).
8. a11y labels / keyboard / focus — **met**.
9. Component tests, 95% per-file coverage, seams mocked — **met** (100%).
10. Marketing page renders island interactive without loading reader — **met** (G2 proof).

## Deviations

- **Edited `packages/shared/src/schemas/accessibility-preferences.ts` (+ test), not the
  literal T4 Files `store/schema.ts`/`store.ts`.** `store/schema.ts` is a pure re-export of
  `@hushbox/shared`; the persisted a11y pref must live in the shared schema (single source of
  truth). The plan's NEEDS_CONTEXT trigger was scoped to "cannot take the pref without a
  migration / widget-behavior change" — neither applies (additive optional field, default
  `true`, `version` unchanged, widget unaffected), so I added it. store/schema.ts + store.ts
  needed no change. This touches a shared package with server LWW-sync surface (the field now
  round-trips through the a11y preferences sync). Raised for the auditor.
- **iOS audio-unlock timing:** `unlockAudio()` runs inside the reader's `start()`, which is
  called after the first-click `await import(...)`. On iOS the gesture context can be lost
  across that await. This is inherent to the plan-mandated lazy-import design (G2) and is not
  resolved here; noted as a limitation.

## Concerns and limitations

- The band's right edge aligns with the header/content column right edge (max-w-5xl), which
  on `lg` is wider than the `1fr` article-text column (the desktop ToC aside is a separate
  row below). This matches the rev-5 mock (mock has no aside; card is flush to content
  right). If "article text column's right edge" was meant literally on `lg`, that needs the
  header folded into the article grid — flagged for visual review.
- No in-browser visual/interaction verification was run (no E2E per founder ruling; stack not
  launched). Layout correctness rests on the structure matching the rev-5 mock.
- Tooltip open-on-interaction is asserted via `user.hover` (radix works in happy-dom); the
  off-state test sets the pref via the store then hovers to avoid click-then-hover pointer
  state confusion.

## Confidence

High — all scoped checks green, component at 100% coverage, G2 proven from the built bundle;
the one open item is in-browser visual confirmation of the band layout and the shared-schema
file-ownership deviation, both surfaced for the auditor.
