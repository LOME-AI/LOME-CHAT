# T3 — chunk highlighter (packages/ui) — impl report 1

## Objective

Build `createChunkHighlighter` in `packages/ui` per §Interfaces and §Task T3: map a
chunk's normalized-text span (T2's offset contract) onto the block's live raw text nodes
to build a DOM Range, paint it with the CSS Custom Highlight API (whole-block class
fallback), auto-scroll off-viewport targets (instant under reduced motion, G3), theme-token
styling (G9), degrade to a whole-block highlight on any match failure, never throw.

## Files changed

- `packages/ui/src/components/accessibility/lib/chunk-highlighter.ts` (new) — the module.
- `packages/ui/src/components/accessibility/lib/chunk-highlighter.test.ts` (new) — tests.
- `packages/ui/src/components/accessibility/styles/reading-highlight.css` (new) —
  `::highlight(tts-reading)` rule + `.tts-reading-block` fallback rule, both painted with
  `var(--brand-red-subtle)` (light+dark token, no border/box → G9).
- `packages/ui/src/components/accessibility/styles/index.css` — one `@import` line adding
  `reading-highlight.css` into `layer(accessibility)`. This bundle is already loaded on
  every blog page via `@hushbox/ui/accessibility/styles` (marketing `global.css`), so the
  rule ships wherever the reader runs; no new package.json subpath needed.
- `packages/ui/src/components/accessibility/lib/index.ts` — barrel export of
  `createChunkHighlighter`, `ChunkHighlighter`, `ChunkHighlightTarget`.

`package.json` was NOT touched (not in T3's Files list; T4 consumes via the existing
`@hushbox/ui/accessibility/lib` subpath). The `tts.worker.*` modifications visible in
`git status` are T1's concurrent work — untouched by me.

## Matcher strategy (report evidence item)

The reader emits `{ blockEl, startOffset, endOffset }` where offsets index
`normalizeForSpeech(blockEl.textContent)`. I recompute that identical normalized string
from the same DOM + the same shared `normalizeForSpeech` (imported from `./text-normalizer`,
not reimplemented — G4), then map the span onto raw text nodes by **significant-character
alignment**:

1. Recompute `normalized = normalizeForSpeech(blockEl.textContent)`. Bounds-guard the
   offsets (`startOffset < 0 || endOffset > normalized.length || startOffset >= endOffset`
   → whole-block).
2. `targetSig` = the span's non-whitespace characters; `sigBefore` = count of non-whitespace
   characters in `normalized.slice(0, startOffset)`.
3. `significantChars(blockEl)` walks the block's text nodes (`TreeWalker`, `SHOW_TEXT`) and
   records every non-whitespace character tagged with its `(Text node, offset)` — this is
   what lets a Range span the several text nodes that inline elements (`<a>`/`<code>`/
   `<strong>`) split a block into.
4. Compare `significantChars.slice(sigBefore, sigBefore + targetSig.length)` against
   `targetSig`. On equality, the first and last matched characters' raw `(node, offset)`
   become `range.setStart`/`range.setEnd`. On any divergence → `null` → whole-block.

Why significant-character alignment rather than reconstructing the normalizer's offset
arithmetic: on rendered blog HTML, normalization is effectively whitespace-collapse plus
URL→"link" plus markdown-marker stripping (markers are already absent from rendered
`textContent`). Normalization is **significant-character non-increasing** — it only deletes
or shrink-replaces significant characters, never adds them. So a span that fits inside the
normalized text always completes inside the raw text, and matching on the significant
subsequence tolerates the whitespace differences exactly. The one genuine failure mode
(URL→"link" changes the significant characters) diverges at the comparison and cleanly
degrades to a whole-block highlight. This is why T2's contract is **sufficient** to build an
exact Range — no NEEDS_CONTEXT escalation was warranted.

## Both render paths tested (report evidence item)

- **CSS Custom Highlight API path** — happy-dom ships no `CSS.highlights`/`Highlight`, so I
  inject them with `vi.stubGlobal('CSS', { highlights: new Map() })` +
  `vi.stubGlobal('Highlight', FakeHighlight)` (verified: stubGlobal is seen by the module's
  free `CSS`/`Highlight` references at call time; direct assignment to `CSS.highlights` does
  NOT stick in happy-dom, stubGlobal does). Test "builds a Range covering exactly the chunk
  span across inline elements" asserts `registeredRange.toString() === 'world and foo'` for
  `<p>Hello <a>world</a> and <code>foo</code> bar.</p>` — the Range crosses three text nodes.
  A second test proves whitespace-collapse tolerance (source HTML with newlines/indentation
  between inline elements).
- **Fallback-class path** — the default happy-dom environment (no Highlight API) exercises
  it: `highlight()` adds `.tts-reading-block` to the block; `clear()` removes it; a second
  highlight moves the class off the previous block.

## Other required evidence

- **Match-failure → whole-block degradation** — five tests: URL/`link` sig-mismatch,
  inverted offsets, negative start, end-offset overflow, whitespace-only span. Each asserts
  the registered Range covers the whole block and (URL case) that `highlight` does not throw.
- **Never-throw** — `highlight()` wraps clear→paint→scroll in one try/catch that degrades to
  the block class. Test stubs `CSS.highlights.set` to throw and asserts no throw + block
  class applied.
- **`clear()` removes all state** — deletes the registry entry (API path) and removes the
  fallback class from every `.tts-reading-block` under the container. Tested in both paths.
- **Auto-scroll / reduced-motion (G3)** — `scrollBlockIntoView` scrolls only when the block
  is off-viewport (`rect.bottom <= 0 || rect.top >= window.innerHeight`); `behavior` is
  `'smooth'` normally and `'instant'` under `shouldReduceMotion()` (reused from
  `hooks/use-reduced-motion`, the single shared reduced-motion signal — covers both OS
  `prefers-reduced-motion` and the widget's `stopAnimations`). Four tests: below-viewport
  (smooth), above-viewport, in-viewport (no scroll), stop-animations (instant).
- **Stylesheet contract** — two tests read the CSS files and pin that `index.css` imports
  `reading-highlight.css` into `layer(accessibility)` and that the sheet uses
  `::highlight(tts-reading)` + `.tts-reading-block` + `var(--brand-red-subtle)` with no
  `border`. This converts the JS-constant ↔ CSS-name coupling into a checked contract.

## Self-gate

- `eslint <owned files>` (from `packages/ui`, after final edit) — pass (exit 0).
- `tsgo --noEmit` (packages/ui) — pass (exit 0).
- `pnpm test:ui` (full package + per-file 95% gate) — pass: 92 files, 1809 tests; task
  successful (coverage gate green).
- Per-file coverage of `chunk-highlighter.ts` — 100% statements / 100% branches / 100%
  functions / 100% lines.
- `jscpd --threshold 2` on owned files — 0 clones (0%).

## Acceptance criteria

1. Exact Interfaces signature — **met** (`createChunkHighlighter(container): { highlight(e), clear() }`).
2. Highlight-API path builds a Range covering exactly the span, verified across inline
   elements — **met** (precise-span + whitespace-collapse tests).
3. Fallback-class path exercised when `CSS.highlights` absent — **met** (default happy-dom).
4. Match failure degrades to block highlight without throwing — **met** (5 degradation tests
   + never-throw test).
5. `clear()` removes all highlight state — **met** (both paths).
6. Scroll behavior per G3, tested — **met** (4 scroll tests, reduced-motion via shared signal).
7. TDD, 95% per-file coverage, both paths — **met** (100%/100%; RED verified before impl).

## Deviations with reasons

- Feature detection is `'highlights' in CSS` (not `typeof CSS !== 'undefined' && …`). The
  module is client-only (dynamic-imported on click), so `CSS` is always present; dropping the
  `typeof` guard removes an in-practice-unreachable branch and keeps coverage honest at 100%.
  The public `clear()` therefore assumes a client context (as does the whole module, which
  uses `document`/`window` freely); real failures during paint are still swallowed by
  `highlight()`'s try/catch.
- Two `/* v8 ignore */` markers on genuinely-unreachable type-checker guards (a
  `noUncheckedIndexedAccess`-required `window.at(0/-1) === undefined` check that the preceding
  non-empty match makes impossible). This mirrors the accepted precedent in the sibling
  `document-reader.ts` (T2) in the same directory. Not a lint/type suppression; branch
  coverage is 100% (23/23).

## Concerns and limitations

- Whole-package coverage: `store/schema.ts` reports 0% in the `test:ui` table, but the
  overall task succeeded (it is a types/barrel-style file outside the gate); pre-existing,
  unrelated to this task.
- The highlight registry name (`tts-reading`) is a single global per document — correct under
  the one-reader-per-page invariant; not container-scoped.

## Confidence

High — the tolerant matcher's soundness rests on a proven invariant (normalization never
adds significant characters), all four required evidence paths are covered by real tests
that were watched fail first, and every scoped gate is green.
