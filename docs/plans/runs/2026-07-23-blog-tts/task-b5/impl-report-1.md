# B5 — Blog layout (rev-6, founder issues 2–5) — implementation report 1

## Objective

Implement the rev-6 blog header layout: constrain the header band to the article/content
column (issue 3), move the download bar out of the reader stack into a reserved slot in the
band's gap (issue 4), bound the reader's height to the byline+tags block (issue 5), and make
the disclosure render exactly two lines on desktop and three on mobile (issue 2). Layout
only — no behavioral change to playback, the highlight toggle, or the download bar's
visibility logic.

## Files changed

- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` — the component now renders
  two band members (the reserved status slot and the reader stack) instead of one stacked
  card; the disclosure is re-split into two balanced, non-wrapping halves.
- `packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` — new `band layout`
  suite pinning the slot/stack split and the disclosure structure; the existing disclosure
  test rewritten to the new (still canonical G6) copy split.
- `apps/marketing/src/pages/blog/[slug].astro` — header band wrapped in a grid matching the
  article grid, band converted to a stretch row at `md`, island wrapper div removed so the
  component's two roots become direct band children.

## Design record — how each issue is solved

### Issue 3 — band constrained to the content column

The band is now wrapped in `<div class="mt-4 lg:grid lg:grid-cols-[1fr_220px] lg:gap-10">`,
character-for-character the same grid spec as the article/aside grid below it
(`[slug].astro:129`). The band occupies column 1 (`1fr`), so its right edge is computed from
exactly the same track sizing the article's right edge is, at every width. The second grid
column has no child — it exists only to reserve the aside's 220px + 40px gap.

**Proof the ToC aside is untouched:** the aside markup (`<aside class="hidden lg:block">`
with its `sticky top-28` inner and `TableOfContents` island) and the mobile
`<details>` "On this page" block were not edited — `git diff` on `[slug].astro` shows changes
only inside `<header>`. Below `lg` the band grid does not apply and the aside is not
rendered, so nothing can overlap there either.

Note: the `<h1>` was deliberately left spanning the full header width. Only the band was in
scope; the mock draws the title inside the content column too, but moving it is a separate
visual change the founder did not ask for.

### Issue 4 — download bar in a reserved gap slot

`BandStatusSlot` (renamed from `ReaderStatusSlot`) is now the component's **first root**, a
sibling of the reader stack rather than a child of it. In the band's flex row it sits between
the byline block and the reader:

```
band: flex md:flex-row md:items-stretch md:gap-5
  ├─ byline + tags        (astro, flex 0 1 auto)
  ├─ blog-reader-status   (react, md:flex-1 md:max-w-88 self-center)   ← the gap slot
  └─ blog-reader-stack    (react, md:w-72 md:flex-none)
```

**Why the band's height cannot change when the bar appears.** The slot carries
`self-center`, which opts it out of the band's `items-stretch`, and it has no min-height. A
flex line's cross size is the max of its items' hypothetical cross sizes; the slot's is 0
when empty and ~34px when it holds the bar, both well under the byline+tags block's ~70px,
so the byline block alone determines the line's cross size in both states. The slot is
rendered unconditionally (present-but-empty when idle), so the bar's arrival adds no box and
moves no sibling.

The **error line** moved into the same slot. That is a small judgment call beyond the literal
brief (which named only the download bar): the existing element held bar-or-error, and
leaving the error inside the now-height-bounded reader stack would have made it collide with
the clip in issue 5. Both are transient status, both now ride the reserved slot, and the
band height stays constant for the error state too.

**Mobile.** Where the band is a column the slot would contribute a second `gap-6` of dead
space while empty, so it carries `max-md:empty:hidden` — CSS-only, no conditional rendering,
the desktop reservation is untouched. On mobile the bar's appearance does move the reader
down; that is inherent to a stacked band and is what the mock shows (its caption: "the height
bound applies only where the band is a row").

### Issue 5 — reader height bounded by the byline block

The reader stack is a `relative` shell whose contents are lifted out of flow at `md`
(`md:absolute md:inset-0` on the inner column). With nothing in flow, the shell's
hypothetical cross size is 0, so it can never grow the band's flex line — it can only be
stretched *to* it by `items-stretch`. `inset-0` then binds the inner column to exactly that
stretched height and `overflow-hidden` clips anything that would not fit. This is a hard
bound, not a "content happens to be shorter" bound: no content the stack can hold will
increase the band's height.

Below `md` the inner column stays in flow (`absolute` is `md:`-only) and the stack sizes to
its content at full width, as the mock's mobile state does.

### Issue 2 — two disclosure lines on desktop, three on mobile

The canonical G6 sentence is split into two authored halves, each in its own `<span>`:

- `Local text to speech. First listen downloads`
- `the voice model (about 90 MB, one time).`

Each span is `block whitespace-nowrap max-md:inline max-md:whitespace-normal`. Above the
`md` breakpoint each half is a block that cannot wrap, so the disclosure is exactly two lines
at every desktop width — the break is authored, not a function of the column width. Below
`md` both spans become inline with normal wrapping and rejoin through the literal `{' '}`
between them, so the browser wraps the one sentence naturally (three lines at typical phone
widths, the founder's explicit exception).

The split point moved from the sentence boundary to the balance point. It had to: the old
line 2 was 63 characters and could not be held on one line inside the reader column, which
is precisely what produced the three-line desktop rendering the founder reported. Combined
text is unchanged and still exactly the G6 string, asserted verbatim by test.

**Fit margin.** Line 1 is 43 characters at `text-[0.7rem]` (11.2px, the mock's size) in a
column of `md:w-72` (288px) — roughly 245px of text, ~43px of slack. The reader was widened
from the old `sm:w-60` (240px) and the mock's 17rem (272px) to buy that slack at the app's
real font, since `whitespace-nowrap` clips rather than wraps if it ever overruns.

### Astro island structure (hidden coupling, commented in both files)

The component returns two roots. They become direct flex children of the band because Astro
emits `<style>astro-island,astro-slot,astro-static-slot{display:contents}</style>` alongside
every client directive — verified in
`node_modules/.../astro/dist/runtime/server/astro-island-styles.js` and its use in
`runtime/server/scripts.js`. The old wrapper `<div>` around the island was removed; it would
have re-introduced a box between the band and the two members. Both files carry a durable
comment recording the dependency.

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `renders the status slot as a sibling of the reader stack, not inside it` | slot and stack are siblings, neither contains the other | 2 |
| `keeps the status slot present and empty while idle` | slot is rendered and `:empty` when idle (the reservation) | 2 |
| `renders the download bar in the status slot rather than the reader stack` | `role="status"` lands in the slot, not the stack | 2 |
| `renders the error line in the status slot rather than the reader stack` | `role="alert"` lands in the slot, not the stack | 2 |
| `breaks the disclosure into exactly two elements so the desktop break is fixed` | exactly two line elements, with the two halves' text | 4 |
| `pins each disclosure line against wrapping on desktop and frees it on mobile` | each line carries `whitespace-nowrap` + the `max-md:` releases | 4 |
| `renders the canonical local-privacy disclosure verbatim` (rewritten) | combined text is still exactly the G6 sentence | 4 / G6 |

All seven were watched RED first (7 failed / 35 passed) — the six new ones on the missing
`data-slot` hooks, the rewritten one on the old copy split — then GREEN with no other test
touched.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm exec vitest run src/components/blog-reader/blog-read-aloud.test.tsx` (packages/ui) | pass — 42/42 |
| `pnpm exec vitest run --coverage` (packages/ui, full suite) | pass — 94 files, 1874 tests; all-files 99.85% stmt / 99.25% branch / 100% func |
| `pnpm exec vitest run src/components/blog-reader --coverage` (post-final-edit) | pass — 42/42; `blog-read-aloud.tsx` **100% stmts (124/124), 100% branch (46/46), 100% funcs (33/33), 100% lines (117/117)** |
| `pnpm exec vitest run src/components/blog-reader src/components/accessibility` (post-lint-fix) | pass — 36 files, 851 tests |
| `pnpm exec eslint <both owned ui files>` from `packages/ui`, after the last edit | pass — exit 0, 0 problems |
| `turbo typecheck lint --filter=@hushbox/ui --filter=@hushbox/marketing --force` | pass — 4/4 tasks, 0 errors (2 pre-existing `ts(6196)` hints in `PillarCard.astro` / `TrustCard.astro`, untouched files) |
| `jscpd --threshold 2` on the three owned files | pass — 0 clones, 0% duplicated |

The first eslint pass reported 4 Prettier errors (Tailwind class order, JSX wrapping);
`eslint --fix` resolved them and the re-run after the final edit is clean at exit 0. Tests
were re-run after that formatting change.

## Acceptance criteria

1. **Band constrained to the content column, never over/above "On this page"** — met. Band
   wrapped in the same `lg:grid lg:grid-cols-[1fr_220px] lg:gap-10` as the article grid; the
   aside and the mobile `details` are byte-identical to before. Structural evidence only —
   pixel alignment needs the browser check below.
2. **Download bar in a reserved slot between byline and reader; band height identical with
   the bar present vs absent** — met structurally: pinned by three tests that the slot is a
   sibling of the stack, is present-and-empty when idle, and receives the bar. The height
   invariance follows from `self-center` (no stretch participation) plus a hypothetical cross
   size strictly below the byline block's; it is not assertable in happy-dom, which computes
   no layout. Needs the browser check.
3. **Reader height bounded by the byline+tags block (clips, never grows)** — met by
   construction (`md:absolute md:inset-0` inner + `overflow-hidden`); not assertable in
   happy-dom. Needs the browser check.
4. **Disclosure exactly two lines on desktop, three permitted on mobile** — met: two
   authored line elements with `whitespace-nowrap`, released to inline/normal below `md`;
   pinned by two tests. The rendered line *count* needs the browser check.
5. **Mobile stacks, reader full width, still borderless with no container background (G9)**
   — met: the band is `flex-col` below `md`, the stack is `w-full`, and no `border-*`,
   `bg-*` on any container survives (buttons keep their own tinted fills, per G9).

## Deviations, with reasons

- **Error line moved into the gap slot too** (brief named only the download bar). Reason:
  the moved element held bar-or-error, and an error left inside the reader stack would be
  clipped by issue 5's height bound. See §Issue 4.
- **Stack breakpoint moved `sm` → `md`.** The reader column grew from 240px to 288px to hold
  the two-line disclosure; at a 640px viewport that leaves under 50px for the gap slot, which
  cannot render the bar's label + percent. `md` (768px) leaves ~180px. Between 640px and
  768px the band now stacks, which the mock's mobile state already sanctions.
- **Reader column 18rem, not the mock's 17rem; disclosure `text-[0.7rem]`.** The mock's
  numbers are placeholders against a generic system font; 18rem at 0.7rem gives ~43px of
  slack on the longer line, which matters because `whitespace-nowrap` clips instead of
  wrapping if it ever overruns.
- **`<h1>` left full-width** rather than moved into the content column as the mock draws it.
  Out of the stated scope (the brief constrains "the band").

Nothing else changed. B4's download-bar gate
(`status === 'loading' && dwellElapsed && percent < 100`), the 900 ms `DOWNLOAD_BAR_DWELL_MS`
constant and its comment, the effect that unconditionally resets `dwellElapsed` on status
change, `lastChunkRef` with its symmetric toggle effect and all its nulling sites, and
`paintChunk`'s `HighlightHandles` parameter type are all untouched — every B4 test passes
unmodified.

## What only the founder's browser pass can confirm

These are the criteria happy-dom cannot decide. In order of risk:

1. **Disclosure line count on desktop.** Open a post at ≥1024px: the disclosure must be
   exactly two lines and neither must be visibly clipped at its right edge. If line 1 clips,
   the fix is a wider reader column, not a different split.
2. **Band height invariance across the download.** Hard-reload with a cold cache and watch
   the moment "Preparing the voice" appears in the gap: nothing above or below the band may
   shift by a pixel.
3. **Right-edge alignment.** The Stop/Listen pill's column right edge must land on the
   article text's right edge, and the reader must sit clear of "On this page" at every width
   from 1024px up.
4. **Reader clipping.** Confirm the reader's contents are vertically centred against the
   byline+tags block and nothing is cut off — if the disclosure's second line is missing, the
   byline block is shorter than expected and the type/geometry needs a nudge.
5. **Mobile (≤640px).** Band stacks, reader full width, disclosure wraps to three lines, and
   no dead gap between the tags and the Listen button while idle.
6. **The Astro island collapse.** If the band renders as two stacked rows instead of one row,
   `astro-island` is not `display: contents` in this build — verified in Astro 5.18.2's source
   but not by a real page render (see below).

## Concerns and limitations

- I did **not** run a marketing build to inspect the generated blog HTML. B8 is concurrently
  editing `packages/ui/package.json` and `pnpm-lock.yaml`, and B6/B7 own the bundle pipeline;
  a build now could fail for reasons outside this task and would be unattributable. The
  `astro-island { display: contents }` claim rests on reading Astro 5.18.2's
  `ISLAND_STYLES` and its emission path, not on a rendered page. It is cheap to confirm in
  the founder's pass (item 6 above).
- Every Tailwind class used that is not already common in the repo
  (`[&>astro-island]`-free, but `max-md:empty:hidden`, `md:max-w-88`, `md:w-72`,
  `text-[0.7rem]`, `flex-initial`) was verified to compile by running Tailwind 4.3.0's
  `compile()` against the repo's stylesheet and inspecting the emitted rules.
- The disclosure's two-line guarantee is font-metric dependent. It has ~15% slack at the
  measured geometry, but a future font change or a copy edit that lengthens either half
  would clip rather than wrap. The nowrap classes are pinned by test, so the mechanism cannot
  be removed silently, but no test can catch an overrun.

## Confidence

**Medium-high.** The DOM structure, the copy, and every behavior are pinned by tests that
were watched fail first, and the full `packages/ui` suite plus both packages' typecheck and
lint are green with 100% per-file coverage. The reduction is that four of the five acceptance
criteria are statements about computed layout, which no test in this stack can evaluate; they
rest on flexbox reasoning and on the mock, and the founder's visual pass is the real gate.
