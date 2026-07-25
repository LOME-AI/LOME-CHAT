# Fence gate — fix pass 4

## Objective

Two confirmed fail-open defects in the surviving `endsInsideOpenFence` scan, plus
the over-gate its second comparison caused on the mirror shape. The pass-3 design
is unchanged: one conservative boolean over the raw message, message-wide gating.
Only the fence-marker logic moved.

## Files changed

- `apps/web/src/lib/document-parser.ts` — closing-run tail test, closer-column
  comparison, and line splitting (below).
- `apps/web/src/lib/document-parser.test.ts` — 13 cases added, 1 inverted.
- `apps/web/src/components/chat/message/markdown-renderer.test.tsx` — 8 pipeline
  cases added, `codeLines(count, indent)` helper extracted from the existing
  `jsxLines` constant.

### The three parser changes

1. **Closing-run tail.** `rest.slice(index + length).trim() !== ''` became
   `!/^[ \t]*$/.test(rest.slice(index + length))`. `String.trim()` strips every
   Unicode whitespace character; CommonMark admits only ASCII space and tab after
   a closing run, so an NBSP, an ideographic space, a form feed, or a vertical tab
   makes the tail an info string and the fence stays open. The old test called
   those runs closes and released the still-open block.
2. **Closer column.** `Math.abs(marker.column - open.column) <= 3` became
   `marker.column <= open.column`. CommonMark measures a closer against its
   *container's* content column, which this scan does not track; measuring against
   the opener opened a window (opener columns 1–3) in which a backticks-only line
   that is really code content passed as the close.
3. **Line splitting.** `markdown.split('\n')` became `markdown.split(/\r?\n/)`.
   Change 1 made this necessary and the existing CRLF regression caught it: a
   trailing `\r` left on a `` ``` `` line reads as info-string content under the
   tightened tail test. A carriage return is a line terminator, not content.

## Ground truth

Every input below was run through `mdast-util-from-markdown@2.0.3` (the micromark
engine Streamdown parses with) before being asserted. The five fail-open inputs
each parse to **one** code block whose last line is the truncated source
(`const partial = (` / `B --> C[Par`) — the fence really was open and partial code
really was reaching the card.

## Tests added

Pipeline cases drive `<MarkdownRenderer>` and read the `Document` handed to the
store, the way the fail-open was found.

| Test | Level | Behavior |
| --- | --- | --- |
| run trailed by a non-breaking space | pipeline + parser | gates (`streaming`) |
| run trailed by an ideographic space | pipeline + parser | gates |
| run trailed by a form feed | parser | leaves fence open |
| run further out than its opener (opener col 3, run col 6) | pipeline | gates |
| run further out than a list-indented opener (opener col 4, run col 7) | pipeline | gates |
| run further out than a mermaid opener (opener col 3, run col 6) | pipeline | gates |
| fail-open matrix points o=1/c=4, o=2/c=5, o=3/c=4, o=3/c=6 | parser | leaves fence open |
| closer indented **less** than opener (list opener col 4, closer col 0) | pipeline + parser | renders (`sourceState` undefined) |
| closer indented **more** than opener, within CommonMark's allowance | pipeline + parser | gates — the recorded trade-off below |
| closing run with trailing spaces / spaces + tabs | pipeline + parser | renders |

Inverted: the parser case `closes a fence whose closing run carries the allowed
three spaces` now asserts the fence reads open, and names the reason.

### RED verification

- Parser file before the fix: `9 failed | 68 passed`. The four matrix cases and
  the three tail cases failed `expected false to be true`; the closer-less-indented
  case and the inverted three-space case failed the other way. The trailing-spaces
  regression guard passed before and after, as intended.
- Renderer file before the fix: `7 failed | 48 passed`. The five fail-open cases
  each failed `expected undefined to be 'streaming'` — the gate releasing partial
  source, which is the reported defect and not a test artifact. The
  closer-less-indented case failed `expected 'streaming' to be undefined`.
- After change 1 and before change 3, the pre-existing CRLF case failed; change 3
  is the fix for that red, not a speculative addition.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:web --force` | **392 files / 6378 tests passed**, exit 0 |
| `turbo typecheck lint --filter=@hushbox/web --force` | 2 successful, 2 total — clean |
| `npx eslint` over the three changed files, from `apps/web`, after the last edit | exit 0 |
| `jscpd --threshold 2` over `apps/web/src/lib` + `apps/web/src/components/chat/message` | pass — 0.09% typescript, 1 clone, both sides in `trial-refusals.ts` (untouched) |
| per-file coverage, `document-parser.ts` | 100 statements / 100 branch / 100 functions |
| per-file coverage, `markdown-renderer.tsx` | 96.88 statements / 100 branch / 100 functions — unchanged, file not edited this pass |

A first `pnpm test:web --force` run passed with zero test failures. A later replay
died on `Something removed the coverage directory "apps/web/coverage/.tmp"` — the
known shared-directory race with concurrent agents, not a test failure. The
numbers above come from a re-run with
`--coverage.reportsDirectory=<private scratchpad path>`, which exits 0.

## Acceptance criteria

- **Fix 1 gates** — met. NBSP and U+3000 variants both reach `sourceState:
  'streaming'` through the real pipeline; form feed pinned at parser level. All
  three were RED first.
- **Fix 2 gates** — met. All three confirmed inputs (top-level indented opener,
  list-indented opener, mermaid) gate, plus four representative points of the
  verified o×c fail-open matrix at parser level. All RED first.
- **Fix 3 renders** — met. The list-indented opener closed by an unindented run
  now yields `sourceState` undefined.
- **No over-gating regression** — met. Every case in the existing set still
  renders: closed fence at top level, in a list item, in a blockquote, `~~~`,
  CRLF, two closed fences, finished message, mermaid closed, still-streaming
  message whose fence already closed. Trailing-spaces closer added to that set.
- **Invariant held** — met. Every change moves the scan toward reporting open;
  the one direction that reports closed where CommonMark does not is argued safe
  below and cannot release code.

## Deviations

- The brief bounds name `document-parser.ts` and its test file; the required
  RED-verification through the real pipeline lives in
  `markdown-renderer.test.tsx`. Only tests were added there — no renderer source
  was touched.
- Change 3 (`split(/\r?\n/)`) is a third parser edit the brief did not list. It is
  forced by change 1 and pinned by a pre-existing test.

## Concerns and limitations

**The trade-off, stated plainly.** `marker.column <= open.column` is stricter than
CommonMark in the opposite direction. A closer indented *more* than its opener but
still within CommonMark's three-column allowance — opener at column 0, closer at
column 2, say — no longer reads as closing. That document is complete under
CommonMark and will now wait for the message to settle before it previews. This is
the sanctioned direction under the invariant, and it is a deliberate choice, not
an accident: pinned by
`gates a closing run indented further than its opener within the allowance`
(pipeline) and `does not let a run indented further than its opener close the
fence` (parser), both carrying the reason in a comment. The previously passing
three-space-closer assertion was inverted rather than deleted so the change is
visible in the diff.

**A second divergence, verified safe.** For the Fix 3 shape, micromark does not
read the unindented `` ``` `` as a close: it ends the list item (implicitly closing
the fenced block, whose content is whole) and opens a *new* fence that never
closes — two code blocks, the second empty with `lang: null`. So that message does
technically end inside an open fence, and this scan says it does not. It cannot
release partial code: a run with an info string is already excluded from closing,
so any block such a run really opens carries no language, and a block without a
language is never extracted as a document. That reasoning is recorded in the
code at the comparison.

**Unchanged from pass 3.** The scan is still not a CommonMark implementation;
blockquote depth is still approximated by counting `>`; gating is still
message-wide, so an already-complete earlier document waits for its message to
settle.

## Confidence

High. Every input was checked against the micromark parser before being asserted,
watched failing through the real render pipeline for the reported reason, and now
gates; the full no-over-gating set still renders; the changed file measures 100%
statements, branches and functions; the whole web suite is green.
