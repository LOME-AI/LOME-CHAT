# Fence gate — fix pass 2

## Objective

Two validated findings against the first implementation:

1. The fence scan diverged from CommonMark in three input classes and **every
   divergence failed open** — the scan reported "no open fence", the panel fell
   through to the sandbox/mermaid branch with partial code, and the user got a
   `transpile_failed` card. Shapes: a closing fence carrying an info string; a
   fence indented ≥4 spaces inside a list; a fence inside a blockquote.
2. `document-card.tsx` seeded its re-anchor ref with the current document, so a
   card that unmounted (Virtuoso overscan) and remounted never re-published —
   the panel could stay on `sourceState: 'streaming'` after the response ended.

Governing invariant applied throughout: the gate's failure mode must be
over-gating, never rendering.

## Approach chosen for the indented / blockquote shapes

The scan no longer tries to be CommonMark. `unterminatedFenceSource` — which
rebuilt the block's *content text* by mimicking the parser's indent stripping and
then compared that string to the parsed block — is deleted. It is replaced by two
much weaker questions:

- `openFenceAnchors(markdown)` — does the source end inside an unclosed fence,
  and if so, which two source lines bound that block? Container structure is
  approximated, and **every approximation resolves to "open"**: a fence-looking
  run always opens (no ≥4-space skip), blockquote markers are stripped before
  matching, and a block whose container ends before its fence does still reads as
  open. The only rules tightened *against* closing are the three CommonMark facts
  that make a run a genuine close — no info string, same quote depth, indentation
  within three columns of the opener. Each is pinned by a test (verified: dropping
  any one of the three fails a test).
- `isOpenFenceBlock(anchors, codeText)` — is this parsed block that block? The
  open block runs to the end of the source, so its first and last code lines
  appear there with at most a quote marker in front; a suffix test on either
  anchor identifies it. A stray match only gates an extra block.

Why not the two alternatives in the brief:

- **Reuse the renderer's parser.** Streamdown's own incompleteness signal
  (`useIsCodeFenceIncomplete`, per-block context) is computed by an internal
  helper whose regex is `^[ \t]{0,3}(\`{3,}|~{3,})` with no info-string
  rejection — i.e. it carries **the same three divergences**, so adopting it
  would not have fixed the finding. Its underlying block splitter
  (`parseMarkdownIntoBlocks`, marked's `Lexer`) is exported, but it answers
  "where are the block boundaries", not "did the fence close", so the closure
  scan would still have to be written. A true mdast parse would mean declaring
  `remark-parse`/`mdast-util-from-markdown` as a new dependency of `apps/web`
  (they are present only as transitive packages), which needs approval and buys
  nothing the conservative scan does not already give.
- **Position only ("gate the last block while streaming").** It cannot decide the
  terminal case — a message that has *ended* with its document as the last block
  still has to choose between "render" and "incomplete" — so a closure check is
  needed regardless, and gating purely on position would hold the preview back
  for every document a model puts last, contradicting `DOCUMENTS.md`
  ("the preview activates when the fence closes").

Position is still what makes the design safe, but it is *derived*: an unclosed
fence necessarily extends to the end of the source, so the anchors are properties
of the message, not of a block index.

### Why two anchors rather than one

Writing the tilde test surfaced a fourth divergence the finding did not name:
Streamdown repairs incomplete markdown before rendering, and for an unclosed
`~~~` fence that repair appends characters **to the last code line**
(`const line14 = 14;` renders as `const line14 = 14;~~`). A tail-only match
therefore fails open on tilde fences. A head-only match, conversely, fails open
whenever the scan picks the wrong opening line (a fence-looking run inside an
indented code block, for instance). Matching on either anchor survives both, and
the extra match can only over-gate.

## Files changed

- `apps/web/src/lib/document-parser.ts` — `unterminatedFenceSource` replaced by
  `openFenceAnchors` + `isOpenFenceBlock` + the `OpenFenceAnchors` type; the
  marker reader now records quote depth and whether the run carries an info
  string, and closure is decided by `closesFence`.
- `apps/web/src/components/chat/message/markdown-renderer.tsx` — the source
  context carries the anchors instead of a reconstructed source string, and
  `sourceStateFor` delegates block identification to `isOpenFenceBlock`.
- `apps/web/src/components/chat/media/document-card.tsx` — the re-anchor ref
  starts empty, so a remount counts as "nothing published yet" and publishes when
  the store still names this document.

## Tests added

| Test | Behavior | Finding |
| --- | --- | --- |
| renderer: closing candidate carries an info string | gated `streaming` | 1a |
| renderer: unclosed fence indented in a list item | gated `streaming` | 1b |
| renderer: unclosed fence in a blockquote | gated `streaming` | 1c |
| renderer: unclosed `~~~` fence | gated `streaming` | tilde divergence |
| renderer: `````jsx` closed by a shorter ```` ``` ```` run | gated `streaming` | longer-run rule |
| renderer: properly closed fence inside a list item | **not** gated | no over-gating regression |
| parser: 18 `openFenceAnchors` cases | open/closed for info string, list indent, blockquote depth, tilde, longer run, 4-space run, empty tail | scan |
| parser: 4 `isOpenFenceBlock` cases | head match, tail match, neither, empty block | block identification |
| card: re-publishes settled source state after remount | panel leaves `streaming` | 2 |

The three brief shapes plus the tilde case were verified RED against the previous
implementation before any change (4 failed / 6 passed in the `unclosed fences`
group). The card test was verified RED
(`expected 'streaming' to be undefined`). Each of the three closure guards was
mutation-checked: replacing any one with `true` fails exactly one parser test.

The panel-level consequences of `sourceState: 'streaming'` — raw source shown, no
iframe mounted, no `alert` role, status element announces `streaming` — remain
pinned by the existing `document-panel.test.tsx` cases from the first pass; the
new tests establish that these shapes now reach that state.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run` on parser + renderer + card + panel + sandbox + store | pass — 185 tests (panel/sandbox run through `scripts/with-env.ts`; without it they fail on env bootstrap) |
| mutation check: each of the three closure guards replaced by `true` | each fails exactly one parser test |
| `pnpm test:web` | aborted twice on the shared-coverage-directory race (see below), never on a test |
| `vitest run --coverage` over the whole package, private `coverage.reportsDirectory` | pass — **381 test files / 6247 tests**, exit 0 with the per-file 95% gate enabled |
| per-file coverage, changed files | `document-card.tsx` 26/26 stmts, 22/22 branch, 5/5 funcs · `markdown-renderer.tsx` 33/34 stmts (97.1%), 22/22 branch, 10/10 funcs · `document-parser.ts` 99/99 stmts, 74/76 branch (97.4%), 20/20 funcs |
| `turbo typecheck lint --filter=@hushbox/web --force` | fails — all failures outside this task (see below) |
| `npx eslint` over the owned files, from `apps/web`, after the last edit | pass — exit 0 |
| `jscpd --threshold 2` over `src/lib`, `src/components/chat`, `src/components/document-panel`, `src/stores` | pass — 0.34% duplication, no clone involves a file this task touched |

### Failures outside this task

`turbo typecheck lint` fails on files this task never opened, all of them carrying
concurrent edits (`git status`: `M`/`??`):

- `apps/api/src/slices/conversations/routes.ts` — three errors around a
  `ConversationEventNotification` export that does not exist.
- `apps/web/src/lib/notification-channel/web-adapter.ts` (untracked) — a
  `Uint8Array`/`BufferSource` assignment error, plus a prettier error.
- `apps/web/src/components/chat/input/reasoning-effort-menu.test.tsx`,
  `apps/web/src/hooks/notifications/use-enable-prompt.test.ts` (untracked) —
  prettier errors.

The one lint error that was mine (a prettier disagreement in
`document-parser.ts`) is fixed; `eslint` over the owned files exits 0 after the
last edit.

## Acceptance criteria

- A closing fence carrying an info string is not treated as a close — met
  (parser case + renderer case).
- A fence indented ≥4 spaces inside a list item reads as open — met.
- A fence inside a blockquote reads as open — met.
- All three gate: raw source, no iframe, no error card — met, via the
  `sourceState: 'streaming'` stamp the panel tests already bind to those effects.
- A document with a genuinely closed fence still renders — met (the closed-fence
  cases: top level, inside a list item, tilde, and the pre-existing "leaves an
  earlier closed block unset while a later fence is still open").
- A message that ends mid-fence still settles to raw rather than spinning — met
  (unchanged `incomplete` path; the anchors are computed the same way whether or
  not the message is streaming).
- A remounted card re-publishes its source state — met.

## Deviations

- The scan now treats a fence-looking run indented four or more spaces as an
  opener, reversing an explicit rule (and its test) from the first pass. At the
  top level that construct is an indented code block, not a fence; reading it as
  a fence can only hold a document in raw source longer, which the invariant
  prefers over the alternative of skipping a real fence inside a container.
- `unterminatedFenceSource` is deleted rather than fixed. Its contract — return
  the block's *content text* — is what forced the CommonMark reimplementation, so
  keeping the signature would have kept the failure mode.

## Concerns and limitations

- The gate can over-gate: a document in a multi-document message whose first or
  last code line is a suffix of one of the anchors is gated alongside the block
  that is actually open. It clears the moment the fence closes; if the message
  truly ended mid-fence, that block shows raw source with the "response ended"
  explanation. This is the sanctioned direction.
- A card that unmounts, has its content grow while unmounted (so its content-hash
  id shifts), and then remounts still cannot re-anchor — the store holds an id
  the card no longer has. Unchanged from before this pass, and its failure mode
  is a stale panel, not a rendered partial. Fixing it needs a stable selection
  anchor in the store, which is a larger change than the finding asked for.
- Streamdown rewrites the tail of an unclosed `~~~` fence before rendering. The
  head anchor covers it, but it is a reminder that the parsed code text is not
  always a substring of the message; nothing in the gate assumes it is.
- `apps/web/coverage/` is a shared path: a second web-scoped coverage run in the
  repo deletes it under the first. Both `pnpm test:web` attempts aborted that way
  (the second at 361 of ~373 files, with no test failure reported), which is why
  the recorded full run uses a private `coverage.reportsDirectory`. That run is
  `vitest run --coverage` directly, so it carries the per-file coverage gate but
  not the wrapper's pole check; the files touched here are small and fast, so no
  pole is plausible from them.

## Confidence

High. The three reported shapes were watched failing against the old code and now
pass against the real markdown engine, not a mock; a fourth divergence
(Streamdown's tilde-fence repair) surfaced and was fixed in the same pass; each
closure guard is mutation-checked; and the design's remaining inaccuracies were
chosen so that they gate rather than render. The full package suite passes with
the coverage gate on.

Lower confidence on one thing, stated plainly: the scan is still not CommonMark,
so a further divergence is possible. What changed is its direction — an
unmodelled construct now reads as an open fence, so the next divergence costs a
document some seconds of raw source instead of handing a renderer half a program.

