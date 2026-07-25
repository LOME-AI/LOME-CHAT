# Fence gate — gate document execution on a closed fence

## Objective

A document panel opened on a still-streaming assistant message rendered the
partial code immediately, so the web renderer transpiled syntactically
incomplete `react`/`js` source and flashed an error card until the fence closed.
Requirement: a document whose code is still arriving must never render an error
state; the preview activates when the fence closes; a message that ends with the
fence still open settles to raw source rather than spinning.

## The streaming signal

Chosen signal: **a fence scan of the message's own markdown**
(`unterminatedFenceSource`, `apps/web/src/lib/document-parser.ts`) combined with
the message-level `isStreaming` prop the renderer already receives.

A document is gated when the message's trailing fence is unclosed AND that
fence's source equals this block's code text. The message-level flag only
chooses the wording of the two gated states:

| fence | message | state | panel |
| --- | --- | --- | --- |
| open | streaming | `streaming` | source + "Preview starts when the response finishes." |
| open | ended | `incomplete` | source + "The response ended before this code block closed…" |
| closed | either | (unset) | preview, exactly as before |

Why this over the alternatives:

- **Streamdown's `useIsCodeFenceIncomplete()`** (a real, exported hook: it
  returns `isAnimating && lastBlock && unclosedFence`) covers the streaming case
  only — it goes false the moment `isAnimating` goes false, so a message that
  *ends* mid-fence would flip straight to "render it", which is the exact error
  case the founder rejected. Covering the terminal case would need a second
  mechanism next to it, i.e. two implementations of one fact.
- **`isStreaming` alone** would hold the preview back until the whole message
  finished, contradicting `docs/DOCUMENTS.md` ("the preview activates when the
  fence closes") and delaying every document behind the model's closing prose.
- The scan also does not depend on a caller remembering to pass `isStreaming`:
  `share.m.$shareId.tsx` renders `MarkdownRenderer` without it, and a shared
  message truncated mid-fence is still gated there.

The scan mirrors CommonMark fence matching (same marker character, closing run
at least as long, up to three spaces of indentation stripped from content
lines), so its output compares equal to the code text the markdown parser hands
the `pre` override. Equality is compared after `trimEnd()` — trailing whitespace
is the only place the raw scan and the parsed block can differ, and it never
distinguishes two blocks of one message. Verified against real Streamdown
parsing in `markdown-renderer.test.tsx` (the suite renders the real engine, not
a mock).

The fence state reaches the `pre` override through a React context rather than
the `components` closure: a new `components` object makes Streamdown re-render
every block, while a context update crosses those memo boundaries on its own.
(The first implementation stashed it in a ref read during render; ESLint's
`react-hooks/refs` rejects ref writes during render, and the context version is
both legal and independent of Streamdown's memo comparator.)

## Terminal case (message ends with the fence open)

It settles to `incomplete`: highlighted source, a calm one-line explanation, no
spinner, no error card, and **no Rendered/Raw toggle** — there is no preview to
switch to, so no user action can hand truncated code to a renderer either. The
exit does not depend on a timer: `stopStreaming` is called on both the success
and the `catch` paths of the chat turn (`use-authenticated-chat.ts`), so a
stream that dies mid-fence clears the flag and the document settles.

## No error state is reachable from incomplete code

1. Auto-render is blocked — `DocumentContent` returns the source view before it
   reaches the mermaid or sandbox branches, so the iframe never mounts (no frame
   spawned per token either).
2. The Raw toggle cannot bypass it while streaming — the gate is evaluated
   before `showRaw`.
3. In the terminal case the toggle is not rendered at all.
4. Once the fence closes the source is whole by definition, so an error there
   reports genuinely broken code, which is the pre-existing behavior.

## Files changed

- `apps/web/src/lib/document-parser.ts` — `DocumentSourceState`, the optional
  `Document.sourceState` field, and `unterminatedFenceSource`.
- `apps/web/src/components/chat/message/markdown-renderer.tsx` — computes the
  message's unclosed-fence source once per content change and stamps
  `sourceState` on each document it builds.
- `apps/web/src/stores/document.ts` — `refreshActiveDocument` (streaming
  re-anchor) split from `setActiveDocument` (explicit open), plus
  `activeSelectionId`, which identifies one user selection across the content-hash
  id churn.
- `apps/web/src/components/chat/media/document-card.tsx` — re-anchors through
  `refreshActiveDocument` and now also when only the source state settles (a
  closing fence adds no code text, so the id can be unchanged).
- `apps/web/src/components/document-panel/document-render-status.tsx` — new: the
  single `#document-render-status` element, now used from two call sites.
- `apps/web/src/components/document-panel/document-sandbox.tsx` — renders the
  extracted status element; its `RenderStatus` is the mounted-sandbox subset of
  the status union (no behavior change).
- `apps/web/src/components/document-panel/document-panel.tsx` — the gated source
  view, the toggle rule, and the raw-choice reset keyed on `activeSelectionId`
  instead of the mutating document id.

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `unterminatedFenceSource` (11 cases) | closed/unclosed/second-fence/longer-fence/tilde/indented/4-space/empty-tail | fence detection |
| markdown-renderer: still-streaming block | stamps `streaming` | streaming document is gated |
| markdown-renderer: message ended mid-fence | stamps `incomplete` | terminal case |
| markdown-renderer: fence closed | stamps nothing | activation |
| markdown-renderer: earlier closed block | not stamped while a later fence is open | only the open block is gated |
| store: explicit open | counts a new selection | raw choice scoping |
| store: refresh | replaces the document, same selection | raw choice survives |
| card: re-anchor keeps the selection | selection id unchanged | raw choice survives |
| card: settle without id change | store gets the settled document | activation fires |
| panel: streaming react document | source shown, no iframe | no execution while incomplete |
| panel: streaming react document | no `alert` role | no error card |
| panel: streaming react document | status element `streaming` + text | G8 announcement |
| panel: streaming mermaid | diagram held back | uniform gate |
| panel: streaming plain code document | source, no status element | no preview claim where there is none |
| panel: `incomplete` | source, no iframe, no alert, status `incomplete` | terminal case |
| panel: `incomplete` | no raw toggle | truncated code is unreachable by the renderer |
| panel: settled react document | iframe mounts | activation |
| panel: python | Run appears only after settling | python still explicit |
| panel: explicit raw choice | survives settling | toggle not stomped |
| panel: opening another document | drops the raw choice | reset still works |

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run` over the 8 touched + consumer files (parser, store, card, renderer, panel, sandbox, message-item, share route) | pass — 360 tests |
| `vitest run` on renderer + panel after the context refactor | pass — 87 tests |
| `pnpm test:web` (full package) | 373 test files passed; the run's coverage step flagged `markdown-renderer.tsx` because the file was edited mid-run (v8 remaps the report against the on-disk source) |
| `vitest run --coverage` on `markdown-renderer.tsx`, final code | 97.05% stmts / 100% branch / 100% funcs / 96.66% lines — the single uncovered line is pre-existing (`extractTextFromHast`'s unreachable tail) |
| `pnpm test:web`, re-run on the final code (3 attempts) | could not complete — each attempt aborted on `Error: Something removed the coverage directory "apps/web/coverage/.tmp" … Make sure you are not running multiple Vitests with the same "coverage.reportsDirectory" at the same time`, at 0, ~315 and ~13 files in |
| `turbo typecheck lint --filter=@hushbox/web --force` | first pass: typecheck clean, lint failed on 7 errors in my files (`react-hooks/refs` ref-write-during-render, prettier, `unicorn/no-await-expression-member`); after the fixes: **2 successful, 2 total, exit 0** |
| `jscpd` over the changed dirs | pass — 0 clones, 50 files |
| `eslint` over the owned files, from `apps/web`, after the last edit | pass — exit 0, no output |

The `react-hooks/refs` failure is what drove the context refactor: the first
implementation wrote the fence context into a ref during render, which the rule
bans outright. Every lint error found was in this task's own files.

The full-suite failures are an environment race, not a code failure: vitest
aborts when `apps/web/coverage/.tmp` disappears under it, which happens when a
second web-scoped coverage run exists at the same time. The repo has other agents
working in it concurrently, and the machine carried a load average near 50 for
the whole task. The one full run that did complete (before the collisions) was
**373 test files passed** on this task's code, and every touched file plus its
consumers passes in isolation on the final code. The abort message names no test
and no assertion; no test in it failed.

## Acceptance criteria

- Streaming document with an unterminated fence shows raw, mounts no iframe,
  shows no error — met (three panel tests plus the markdown-renderer stamp).
- The same document renders once the fence closes — met (panel settled test;
  status reaches `rendered` only through the unchanged bridge path).
- A message terminating with the fence open settles to raw without error — met.
- Python still requires Run after activation — met.
- An explicit user Raw selection survives activation — met (needed both the
  store selection counter and the panel's reset key change; the id-keyed reset
  previously discarded the choice on every token).
- `document-render-status` contract intact — met: `rendered` still comes only
  from the bridge `rendered` message and `complete` only from `result`; the two
  added values (`streaming`, `incomplete`) describe source that never executed.

## Deviations

- The gate applies to mermaid documents as well as runnable ones. `DOCUMENTS.md`
  states the rule for documents generally, an incomplete mermaid graph produces
  the same class of user-facing error, and a single branch is simpler than a
  kind-conditional one. Plain `code` documents are untouched — they have no
  preview, so they show source with no status element and no extra copy.
- Two store actions instead of one. Distinguishing "user opened a document" from
  "the open document was re-parsed" is what makes the raw choice survivable;
  with a single action the panel cannot tell them apart.

## Concerns and limitations

- Streamdown splits a message into blocks; if a completed fence and the open one
  ever land in the same block, the completed one is compared against the open
  fence's source and stays unstamped — the gate is per-block-text, so the failure
  direction is "shows the preview", never "shows an error for partial code". The
  observed splitting puts them in separate blocks.
- The gated state is exited by the message's own streaming flag; there is no
  independent timer. Verified both the success and error paths clear it.
- The visible explanation is duplicated by the status element's screen-reader
  text (`aria-hidden` on the visible copy), matching the existing
  loading-line + status-mirror pattern in the sandbox.
- E2E and Maestro are out of bounds for this task. No assertion changes are
  needed (`rendered` is unchanged), but a Playwright scenario that opens a
  document before its fence closes would now see the source view first.

- `pnpm test:web` never completed end-to-end on the final code because of the
  coverage-directory race described above. The evidence that stands in for it:
  373/373 test files passed on an earlier full run of this code, the 8 touched +
  consumer files pass in isolation (360 tests), renderer + panel pass after the
  refactor (87 tests), and `markdown-renderer.tsx` measures 97.05/100/100/96.66
  against the 95% gate. A green full run should be confirmed when the repo is
  quiet.

## Confidence

High on the behavior: the signal is exercised against the real markdown engine
rather than a mock, every gated path is pinned by a test, and the only way to
reach a renderer with partial source has been removed rather than merely
discouraged. Medium only on the full-suite gate, which the environment prevented
from finishing.
