# Fence gate — fix pass 3

## Objective

Two confirmed fail-open classes against pass 2, both from one root cause: the gate
identified *which* rendered block was the open one by matching the parsed code text
against anchors taken from the raw message, while the markdown engine repairs the
source before parsing and rewrites the very lines that match relied on.

1. Anchor matching failed open when repair rewrote both the head and the tail code
   line — `~~~mermaid\ngraph TD` (the first frame of every tilde-fenced mermaid
   document), a tilde-fenced jsx block whose first line trips the single-tilde repair
   and whose last line trips the emphasis repair, and the same shape on plain
   backtick fences whenever an earlier stray ``` run inverts the repair pass's
   naive code-block parity.
2. Indentation was counted in characters, so a tab-indented (or non-breaking-space
   indented) closing run closed the fence in the scan while the markdown parser left
   it open — the sandbox was handed source ending in a literal `` ``` `` line.

The mandated fix removes the coupling rather than patching it: no per-block
identification exists any more.

## What changed in the design

- `openFenceAnchors` + `isOpenFenceBlock` (the anchors type, the head/tail suffix
  test, the whole text-matching step) are **deleted**. Nothing in the gate reads a
  parsed code block, compares against repaired text, or depends on the renderer's
  block splitter.
- The parser now answers one conservative boolean about the raw message:
  `endsInsideOpenFence(markdown)`. It reads the raw source only; every construct it
  does not model resolves to `true` (open).
- The gate is message-granular: while a message's source ends inside an open fence,
  every document from that message carries `sourceState` — `streaming` while the
  message streams, `incomplete` once it has ended with the fence still open. When
  the source no longer ends inside an open fence, documents render normally. The
  panel's consequences of `sourceState` (raw source, no iframe, no error card, no
  toggle in the terminal state) are unchanged from pass 1.
- Indentation is measured in CommonMark columns: a tab advances to the next
  multiple of four, and only ASCII space and tab count as indentation. Any other
  leading character (a non-breaking space) means the line is not a fence marker at
  all, which leaves the enclosing fence open — the safe direction.

### Accepted trade-off

An earlier, already-complete document in the same message is gated while a later
fence is open; it renders as soon as the message settles. Over-gating is the
sanctioned direction — per-block precision is exactly what kept failing open. The
previously passing test asserting the opposite ("leaves an earlier closed block
unset while a later fence is still open") is inverted to pin the new behavior.

## Files changed

- `apps/web/src/lib/document-parser.ts` — `openFenceAnchors`, `isOpenFenceBlock`,
  `OpenFenceAnchors` and the `nonBlankLines` helper removed; `endsInsideOpenFence`
  added; `FenceMarker.indent` (characters) becomes `column` (CommonMark columns),
  read by a space/tab-only scan.
- `apps/web/src/components/chat/message/markdown-renderer.tsx` — the source context
  carries one boolean instead of anchors; `sourceStateFor` takes no code text.
- `apps/web/src/lib/document-parser.test.ts` — the two deleted functions' suites
  replaced by one `endsInsideOpenFence` suite, plus tab, non-breaking-space, CRLF
  and three-space-closer cases.
- `apps/web/src/components/chat/message/markdown-renderer.test.tsx` — the six new
  pipeline cases below, the inverted sibling-gating case, and the no-over-gating set.

## Tests added

| Test (through the real MarkdownRenderer pipeline) | Behavior |
| --- | --- |
| first frame of a tilde-fenced mermaid document | `~~~mermaid\ngraph TD` gates `streaming` |
| the same after the message ends | gates `incomplete` |
| tilde-fenced jsx whose first and last lines both shift under repair | gates `streaming` |
| backtick-fenced jsx after an earlier ``` run inverts repair parity | gates `streaming` |
| tab-indented closing run | fence stays open, gates `streaming` |
| non-breaking-space-indented closing run | fence stays open, gates `streaming` |
| earlier closed block while a later fence is open | gated too (accepted over-gating) |
| closed fence: top level, list item, blockquote, `~~~`, CRLF, two closed fences, finished message | **not** gated — the document renders |
| parser: 22 `endsInsideOpenFence` cases | info string, list indent, quote depth, tilde, longer run, tab, NBSP, CRLF, three-space closer, four-space run, bare opener |

The previously pinned shapes (closing fence with info string, fence indented inside
a list, fence in a blockquote, `~~~` fences, four backticks closed by three) are
kept and still pass.

### RED verification

All six new gating cases plus the inverted sibling case were watched failing against
the pass-2 code: `7 failed | 40 passed`, each failure `expected undefined to be
'streaming'` (or `'incomplete'`) — i.e. the gate was releasing partial source, which
is the reported defect, not a test artifact. The no-over-gating cases passed before
and after, so they guard against the fix over-correcting.

The backtick-parity reproduction was found empirically: a probe through the real
pipeline showed that odd parity alone still gated (head anchor survived) and that the
failure needs odd parity **plus** a head-rewriting repair; the recorded input
(`Use ``` to fence.` … `const r = "20~25";` … `// **note`) renders with first line
`const r = "20\~25";` and last line `// **note**`, so neither anchor matched and pass-2
code returned no gate.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:web --force` (turbo `--force`, no cache hit) | **382 test files / 6282 tests passed**, zero test failures; the run exits 1 solely on per-file coverage for three untracked files from concurrent work (`src/lib/notification-activity/app-attention.ts`, `src/stores/notification-activity.ts`, `src/hooks/notifications/use-notification-preferences.ts` — all `??` in `git status`, none opened by this task) |
| `vitest run --coverage` over parser + renderer + card + panel + sandbox + store, private `coverage.reportsDirectory` | pass — 6 files / 252 tests |
| per-file coverage, changed files | `document-parser.ts` 100 stmts / 100 branch / 100 funcs · `markdown-renderer.tsx` 96.9 stmts / 100 branch / 100 funcs / 96.6 lines (the one uncovered line is the pre-existing `extractTextFromHast` tail) |
| `turbo typecheck lint --filter=@hushbox/web --force` | typecheck clean; lint reported 3 errors in this task's test file (fixed) and 2 in `src/components/settings/notifications-card.test.tsx` (untracked, concurrent) |
| `npx eslint` over the owned files, from `apps/web`, after the last edit | pass — exit 0 |
| `jscpd --threshold 2` over `src/lib`, `src/components/chat/message`, `src/components/document-panel` | pass — 0.05% duplication, 1 clone, both sides pre-existing files this task never touched |

## Acceptance criteria

- The per-block text-matching step is gone — met: `openFenceAnchors`,
  `isOpenFenceBlock` and `OpenFenceAnchors` no longer exist anywhere in the repo, and
  `sourceStateFor` no longer receives code text.
- `~~~mermaid\ngraph TD` gates, streaming and ended — met (two pipeline tests, both
  RED before).
- The odd-parity plain-backtick case gates — met (pipeline test, RED before).
- Tab- and NBSP-indented closing runs leave the fence open — met (pipeline tests plus
  parser cases), by counting columns and rejecting non-space/tab indentation.
- Every document of a message that ends mid-fence is gated — met.
- Properly closed documents still render — met: top level, list item, blockquote,
  `~~~`, CRLF, two closed fences, finished message.
- Partial code never reaches a transpiler or renderer, and no error card appears for
  unfinished code — met: the panel returns the source view before the mermaid and
  sandbox branches, pinned by the pass-1 panel tests that bind `sourceState` to those
  effects.

## Deviations

- "Toggle withheld" is implemented as pass 1 had it: withheld in the terminal
  `incomplete` state (there is no preview to switch to), still offered while
  `streaming`. The gate is evaluated before `showRaw`, so the toggle cannot bypass it;
  withholding it during streaming would break the pinned criterion that an explicit
  Raw choice made while a document streams survives activation.
- The sibling-gating test from pass 1 is inverted rather than deleted, so the accepted
  over-gating is pinned rather than merely tolerated.

## Concerns and limitations

- Over-gating is now message-wide by design: a finished document waits for its
  message to settle. It is visible to the user as raw source with "Preview starts when
  the response finishes."
- The scan is still not CommonMark, but it no longer has to agree with anything: it
  reads the raw source alone, and every unmodelled construct resolves to "open". A
  future divergence costs a document seconds of raw source; it cannot release partial
  code.
- Blockquote depth is approximated by counting `>` in the line's prefix, and a fence
  whose container ends before it closes still reads as open. Both bias to gating.
- E2E and Maestro are out of bounds here; no assertion changes are needed
  (`document-render-status` still reaches `rendered` only through the bridge), but a
  Playwright scenario that opens a document while its message is still streaming sees
  the source view first.

## Confidence

High. The two Critical inputs were reproduced through the real pipeline, watched
failing, and now gate; the mechanism they exploited no longer exists rather than being
patched; the closed-document set proves the fix did not over-correct into gating
everything; and the changed parser file measures 100% statements, branches and
functions.
