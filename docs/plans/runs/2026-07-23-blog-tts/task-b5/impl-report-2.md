# B5 — implementation report 2 (fix pass: two validated audit items)

## Objective

Fix exactly the two orchestrator-validated items from the B5 audit: (1) the wrong durable
comment on `BandStatusSlot` in `blog-read-aloud.tsx`, which mis-stated how flex cross sizing
works; (2) the banned keep-in-sync duplication of the content-column grid literal in
`[slug].astro`. No other change. No behavioral change of any kind.

## Files changed

- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` — the `BandStatusSlot` doc
  comment now states the real (contingent) invariant instead of claiming the slot contributes
  no height. Comment only; not a line of code changed.
- `apps/marketing/src/pages/blog/[slug].astro` — the content-column grid literal is declared
  once in frontmatter and used at both rows; the band comment now explains why the two rows
  share one grid instead of instructing a human to keep two literals matching.

## Fix 1 — the corrected comment (verbatim)

```ts
/**
 * The band's reserved status slot: the download bar and the error line render
 * here, in the gap between the byline block and the reader stack, never inside
 * the stack. The slot is always present so neither arrival reflows anything.
 *
 * Where the band is a row, its height is the largest of its members' heights,
 * and `self-center` does not exempt this slot from that maximum — centring only
 * stops the slot being stretched, it still contributes its own height. So the
 * band's height is invariant across the bar's arrival only while the slot's
 * content stays shorter than the byline block: one line of bar or error is
 * ~34px against the byline+tags block's ~70px. Adding a second line here (a
 * bytes/speed/ETA row, as the accessibility widget's audio section renders)
 * would grow the band.
 *
 * Where the band is a column (mobile) an empty slot collapses instead, so the
 * reservation costs no dead space there.
 */
```

The replaced sentence claimed the slot "is vertically centred and contributes no height of
its own, so the byline block alone sets the band's height". That is wrong: `align-self:
center` only positions an item on the flex line's cross axis; the item's outer hypothetical
cross size still participates in the line's cross size. The height invariance is real but
contingent on the size margin, and the comment now says so — including the concrete failure
mode (a second status line), which is exactly the edit the old comment told a reader was
impossible. This matches §Issue 4 of `impl-report-1.md`, which had the reasoning right in
the report while the shipped comment had it wrong.

## Fix 2 — one grid declaration, two usages

Frontmatter (`[slug].astro:35-41`):

```ts
/* The one grid the page's content column is defined by. The header band and the
   article row below are both laid out on it, so the reader's right edge is
   derived from the same track sizing as the article's and the two cannot drift
   apart. Only the article row fills the second track (with the "On this page"
   aside); the band leaves it empty, which is what keeps the reader clear of the
   aside at every width. */
const CONTENT_GRID = 'lg:grid lg:grid-cols-[1fr_220px] lg:gap-10';
```

Usages:

- `:74-75` — the band row:
  ```astro
  {/* The header band, held to the article's own column width (see CONTENT_GRID). */}
  <div class={`mt-4 ${CONTENT_GRID}`}>
  ```
- `:131` — the article/aside row: `<div class={`mt-4 ${CONTENT_GRID}`}>`

`mt-4` is deliberately left at each call site: it is spacing that happens to coincide, not
part of the shared contract. The const holds exactly the thing whose drift breaks alignment.
Scope is a local frontmatter const in the one file that has both usages — the narrowest scope
covering all callers, per CODE-RULES §One Implementation, Shared. It is not exported and not
hoisted to a package.

The old comment (`:67-71`) said the band grid "must keep matching the article/table-of-contents
grid below" — the banned sync contract. It is gone; the new frontmatter comment states why one
grid governs both rows.

## Proof from the rebuilt HTML

`pnpm run build` in `apps/marketing` — Complete, 15 pages, 0 errors.

Emitted `dist/blog/what-is-opaque-authentication/index.html`:

```
$ grep -o 'class="mt-4 lg:grid lg:grid-cols-\[1fr_220px\] lg:gap-10"' <that file>
     1  class="mt-4 lg:grid lg:grid-cols-[1fr_220px] lg:gap-10"
     2  class="mt-4 lg:grid lg:grid-cols-[1fr_220px] lg:gap-10"
```

Exactly two occurrences, byte-identical, one per row — the template interpolation emits the
same class string the two literals did. Tailwind still emits the rule (the candidate text is
unchanged in the source, only relocated): `grid-template-columns:1fr 220px` is present in
`dist/_astro/_slug_.BKK5a7zG.css`.

Band structure unchanged in the emitted header — the grid wrapper, then
`flex flex-col gap-6 md:flex-row md:items-stretch md:gap-5`, then the byline block
(avatar / author / time · reading time / tags), then the island. The `{/* */}` comments emit
nothing, so the comment rewrite has zero effect on output.

## B4 / T6 / tests untouched

No test file was edited (neither fix needed an assertion: fix 1 is a comment, fix 2 is a
refactor whose output is proven byte-identical above). The full `packages/ui` suite passes
unmodified.

B4 and T6 markers confirmed present in `blog-read-aloud.tsx` after the edit:
`DOWNLOAD_BAR_DWELL_MS = 900` (`:39`), the three-conjunct gate
`status === 'loading' && dwellElapsed && percent < 100` (`:322`), the status-keyed dwell
effect (`:303-314`), `lastChunkRef` with its toggle effect (`:274`, `:296`) and all four
nulling sites (`:335`, `:342`, `:352`, plus `:94` set), `HighlightHandles` (`:51`, `:57`,
`:69`), and `primeAudioContext` called before the dynamic import (`:380`). The single Edit to
this file was an exact-string replacement of the doc comment block; nothing else in the file
was addressed.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm run build` (apps/marketing) | pass — 15 pages, 0 errors |
| `pnpm exec vitest run --coverage` (packages/ui, scratchpad reports dir) | pass — 94 files, 1874 tests, 0 failures |
| per-file coverage `blog-read-aloud.tsx` | 100% stmts (124/124), 100% branch (46/46), 100% funcs (33/33) |
| all-files coverage (packages/ui) | 99.85 stmt / 99.25 branch / 100 func / 99.91 line |
| `pnpm exec eslint src/components/blog-reader/blog-read-aloud.tsx` from `packages/ui`, after final edit | pass — exit 0 |
| `pnpm exec eslint 'src/pages/blog/[slug].astro'` from `apps/marketing`, after final edit | pass — exit 0 |
| `npx turbo typecheck lint --filter=@hushbox/ui --filter=@hushbox/marketing --force` | pass — 4/4 tasks, 0 errors (2 pre-existing `ts(6196)` hints in `PillarCard.astro` / `TrustCard.astro`, files not touched by this task) |
| `npx jscpd --threshold 2` on both owned files | pass — 0 clones, 0% duplicated |

No check failure to attribute. The two `ts(6196)` hints are hints, not errors, and are in
files this task has never edited; the typecheck task exits 0 with them.

## Acceptance criteria (the two fix items)

1. **Comment states the actual invariant** — met. Verbatim above: `self-center` described as
   positioning-only, the invariance stated as contingent on the ~34px vs ~70px margin, and the
   second-status-line case named as the thing that would break it. Durable, no task IDs, no
   process narration.
2. **No keep-in-sync duplication** — met. One `CONTENT_GRID` declaration, two usages, the sync
   instruction removed and replaced by the reason both rows share the grid. Proven by the
   rebuilt HTML to be output-identical; jscpd clean.

## Deviations

None.

## Concerns and limitations

- The size margin in the new comment (~34px vs ~70px) is a measurement carried over from
  `impl-report-1.md` §Issue 4, not something re-measured in a browser this pass; no test in
  this stack computes layout. It is stated as approximate and the invariant it supports is
  qualitative (slot content must stay shorter than the byline block), so the number's
  precision is not load-bearing.
- Tailwind's scanner finds `lg:grid-cols-[1fr_220px]` because the literal text still exists in
  the file. If a future edit built the class by concatenation instead of keeping a whole
  literal, the rule would silently stop being emitted. The emitted CSS was checked this pass;
  no test guards it.

## Confidence

**High.** Both fixes are narrow and fully verified: the comment change cannot affect behavior,
and the refactor's output is proven byte-identical in the built HTML. Every scoped check is
green, per-file coverage is unchanged at 100%, and no test was touched.
