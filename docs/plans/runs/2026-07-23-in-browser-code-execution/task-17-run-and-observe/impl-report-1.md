# Run and observe — replacing the fence gate

## Objective

Stop predicting whether a streaming code block is complete and start observing
whether it actually ran. The markdown-fence prediction is deleted outright; a
document is now handed to the sandbox while its message streams, and the frame's
own `error` message decides what the reader sees.

## The rule that replaced the gate

One sentence, implemented in one place (`displayStatus` in `document-sandbox.tsx`):

> A verdict from the frame reaches the reader only once an attempt against the
> code they can see has reported. Until then the panel shows either the last
> good render or the source — never a spinner, never a failure.

Two things make a verdict unusable, and both must be in the condition:

- **The message is still arriving** — the failure describes half-written code.
- **The code has moved on** — a re-init is queued in the debounce or in flight,
  so the verdict is about text nobody is looking at any more.

The second outlives the first. A message that ends right after its closing fence
delivers its last chunk and stops streaming in the same commit, leaving a queued
attempt behind it; keying only on streaming paints that stale failure over the
document for as long as the debounce runs. `initializedCode` — the code the
frame was last given — therefore lives in reducer state, not a ref, because the
difference between it and the current code decides what is rendered.

Everything else falls out of it:

- **Nothing rendered yet** → the source, plus a calm status. The frame stays
  mounted (collapsed to `h-0`) so it keeps receiving attempts.
- **Something rendered** → that render stays on screen through every later
  attempt, whether the attempt is still loading or has failed.
- **Message settled** → the sandbox state is shown verbatim, so the last
  attempt's failure surfaces immediately as the usual error card.

The reducer stays truthful throughout: it records exactly what the frame said
(`error` sets `status: 'error'` and the code). Suppression is a display
decision, not a lie in the state — which is why "the error appears the moment
streaming stops" needs no extra machinery.

`hasRendered` is the second half of the rule and lives in the reducer, since it
is a fact about the frame's history: `statusWhileWorking` keeps a painted render
on screen while a newer attempt is in flight. That applies after settling too —
a re-attempt never blanks a good preview back to a spinner.

## Files changed

| File | Why |
| --- | --- |
| `apps/web/src/lib/document-parser.ts` | `endsInsideOpenFence`, its micromark parse, its memo cache and `DocumentSourceState` deleted; `Document.sourceState` became `Document.isStreaming: boolean`. |
| `apps/web/src/components/chat/message/markdown-renderer.tsx` | `SourceFenceContext`/`SourceContext`/`sourceStateFor` and the `endsOpen` memo deleted; a `MessageStreamingContext` carrying the chat-state flag replaces them. |
| `apps/web/src/components/chat/media/document-card.tsx` | Re-publish comparison keys on `isStreaming` instead of `sourceState`; a remounted card re-claims the panel when its content strictly extends the open document's. |
| `apps/web/src/components/document-panel/document-panel.tsx` | `SOURCE_STATE_TEXT`, `IncompleteSourceView` and the gating branch deleted; `PendingSourceView` added and handed to the sandbox; mermaid waits for its message; content keyed by selection, not document id. |
| `apps/web/src/components/document-panel/document-sandbox.tsx` | `isStreaming`/`pendingView` props, `hasRendered`, `initializedCode`, `displayStatus`, debounced re-init, `statusText` split to a static map (complexity). |
| `apps/web/src/components/document-panel/document-render-status.tsx` | `'incomplete'` dropped from the status union; `PENDING_PREVIEW_TEXT` added as the one place that wording lives. |
| `apps/web/package.json` + `pnpm-lock.yaml` | `micromark` and `micromark-extension-gfm` removed as direct dependencies. |

Test files: `document-parser.test.ts`, `markdown-renderer.test.tsx`,
`document-panel.test.tsx`, `document-sandbox.test.tsx`, `document-card.test.tsx`,
`stores/document.test.ts`, and the new
`document-panel/document-panel.streaming-preview.test.tsx`.

Out of bounds, forced by the type change: `apps/web/src/lib/auth.test.ts` — two
`Document` literals gained `isStreaming: false` (see Deviations).

### The panel key

`DocumentContent` was keyed by `activeDocumentId`, a content hash that changes
every token. That was harmless while the gate kept the sandbox unmounted during
streaming; without the gate it would remount the iframe once per token. It is
now keyed by `activeSelectionId`, which increments only on an explicit open — so
switching documents still tears the frame down (and kills anything running in
it) while a growing document keeps the frame it is already driving.

### Debounce

`REINIT_DEBOUNCE_MS = 300`. The effect re-drives the live frame when `code`
differs from what was last sent, after 300 ms of stability; each change resets
the timer, so a burst of tokens costs one attempt. The frame is never remounted
for an attempt — a fresh one is blank, which would discard the render being
held.

## Tests

### New pipeline file — `document-panel.streaming-preview.test.tsx`

Renders the real `<MarkdownRenderer>` and the real `<DocumentPanel>` over the
real store, clicks the real card, and speaks the real bridge to the real
sandbox frame. No parser is called directly anywhere in it.

| Test | Behavior | RED |
| --- | --- | --- |
| hides a failed attempt while the message is still streaming | partial React mid-stream → frame live, no `alert`, source shown, status `streaming` | yes — no iframe existed at all |
| announces the wait as a status, never as a failure | `role="status"` carries the calm wording; no failure copy | yes — same |
| shows the compile error once the message has stopped streaming | unterminated fence + settled → the normal error card | yes — the old copy said the block never closed and offered no preview |
| keeps the last good render while a newer attempt fails | rendered → grown → re-init → error ⇒ still `rendered`, no `alert` | yes — no re-init existed |
| re-drives the same frame rather than mounting a new one per token | the iframe node is identical across attempts | yes — same |
| holds a mermaid diagram as source while its message streams | no "could not render" copy | no — guard |
| renders a mermaid diagram once its message has settled | diagram appears | yes — an unterminated mermaid fence was gated forever |
| paints no error when the message settles with an attempt still queued | last chunk + end of stream in one commit ⇒ no `alert`, status `streaming` | added in fix pass — mutation-checked |
| hides a failed attempt for a raw-HTML code block that is still streaming | `<pre><code class="language-jsx">` in raw HTML | **yes — the hole the fence gate could not reach** |
| shows the error for a raw-HTML code block once streaming has stopped | error card appears | no — guard |

RED run before implementation: **7 failed | 2 passed**, each failure for its
stated reason (`Unable to find an element with the title: Widget` for the three
gated cases, `expected 2 times, got 1` for the two re-init cases, the mermaid
diagram never appearing, and — for raw HTML — an actual error card found in the
document while streaming).

The raw-HTML case is worth stating plainly: that content never contains a fence,
so the deleted gate answered "closed" for it by construction and released the
error card mid-stream. The new rule covers it without knowing it exists, because
it never reads the message text.

### Converted vs deleted

- **`document-parser.test.ts`** — the entire `endsInsideOpenFence` corpus (~40
  cases: fence runs, tildes, blockquotes, list indentation, tab stops, NBSP/
  ideographic-space tails, CRLF, bare CR, GFM footnotes, the memo shortcut, the
  engine-throws case) deleted; 46 cases remain, none of them touched. It only ever asserted fence detection, which no
  longer exists. Nothing else in the file changed.
- **`markdown-renderer.test.tsx`** — the ~42-case `unclosed fences` describe
  deleted, replaced by a 5-case `streaming state` describe. The inputs that
  still express real behavior were kept: a document from a streaming message, a
  document whose fence never closed, a mermaid diagram mid-stream, a settled
  message, and a message with no streaming state at all (the share route). What
  they assert is now `document.isStreaming`, the flag the panel acts on.
- **`document-panel.test.tsx`** — `incomplete source` became `streaming
  documents`: the two-state text map and the "no preview toggle" case are gone
  (there is no `incomplete` state); the source-while-streaming, no-error,
  mermaid-held-back, plain-code-no-status, raw-choice-survival and
  open-another-document cases were kept and re-expressed on `isStreaming`, and
  three were added — the sandbox now being handed a streaming document, the
  frame surviving growth, and the frame being remounted on a document switch.
- **`document-sandbox.test.tsx`** — nothing deleted; two describes added (six
  streaming cases, four debounce cases).
- **`document-card.test.tsx`** — field rename, plus two cases for the remount
  re-claim (one that must claim, one that must not). **`stores/document.test.ts`**
  — field rename only. The remount re-publish case and the selection-id split are untouched, as
  required.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:web --force` (private `--coverage.reportsDirectory`) | **393 files / 6378 tests passed**, coverage gate green, exit 0 |
| `turbo typecheck lint --filter=@hushbox/web --force` | **2 successful, 2 total**, exit 0 |
| `jscpd --threshold 2` over `document-panel/`, `document-parser.ts`, `chat/message`, `chat/media` | pass — **0 clones** |
| `eslint` over every changed file, from `apps/web`, after the last edit | **exit 0** |

Per-file coverage, changed files (all four metrics):

| File | S | B | F | L |
| --- | --- | --- | --- | --- |
| `lib/document-parser.ts` | 100 | 100 | 100 | 100 |
| `components/document-panel/document-panel.tsx` | 100 | 100 | 100 | 100 |
| `components/document-panel/document-sandbox.tsx` | 99.10 | 97.67 | 100 | 99.00 |
| `components/document-panel/document-render-status.tsx` | 100 | 100 | 100 | 100 |
| `components/chat/message/markdown-renderer.tsx` | 96.29 | 100 | 100 | 96.00 |
| `components/chat/media/document-card.tsx` | 100 | 100 | 100 | 100 |
| `stores/document.ts` | 100 | 100 | 100 | 100 |

Every gate above was re-run after the fix pass; none of these numbers predate
the last edit. Getting trustworthy runs took several attempts, all for
environmental reasons worth recording:

1. **1 failure** — `src/sw/handlers.test.ts > handlePush > does not mistake a
   longer path segment for the conversation being viewed`. That file is
   untracked (`?? apps/web/src/sw/`), belongs to another workstream, imports
   nothing from the document path, and passes in isolation. It did not recur in
   either later run.
2. **11 suite-collection failures** — a concurrent `pnpm install` was rewriting
   `node_modules` mid-run (`MODULE_NOT_FOUND` on rolldown's native binding;
   `input-otp` types vanished from a `tsc` run at the same moment). Zero test
   assertions failed in that run.
3. **Clean** — 393 files / 6365 tests, which was the pre-fix-pass state.
4. **Coverage gate failed** after the fix pass: branch coverage for
   `markdown-renderer.tsx` reported **12/16 (75%)** against the 95 threshold,
   with every one of the 6378 tests passing.
5. **Clean** on an identical tree — the same file reported **16/16 (100%)**.
6. **Clean again**, after two prettier-only edits (a test name carrying an
   apostrophe, and a wrapped JSX line). This is the run the table reports:
   393 files / 6378 tests, exit 0. `turbo typecheck lint` and the `eslint` pass
   over every changed file were both re-run after those same edits, and `jscpd`
   after that.

That 4→5 flip is worth flagging: nothing changed between them. Running
`markdown-renderer.test.tsx` + `markdown-renderer-error.test.tsx` under scoped
coverage also gives 16/16, so the file genuinely has full branch coverage and
run 4's number was a merge artefact — most likely concurrent agents' vitest
processes colliding over v8's raw-coverage staging. Worth knowing before anyone
treats a single red coverage run as a real shortfall.

Deleted symbols verified gone repo-wide: a grep for `endsInsideOpenFence`,
`sourceState`, `DocumentSourceState`, `IncompleteSourceView`,
`SourceFenceContext` and `micromark` across `apps`, `packages`, `e2e` and
`mobile` returns nothing outside `node_modules` and a stale coverage artifact.
`micromark` and `micromark-extension-gfm` no longer appear under any importer in
`pnpm-lock.yaml` (they remain as transitive entries under Streamdown's remark
chain, which is correct).

## Acceptance criteria

- **Bridge `error` while streaming is not displayed** — met. Held-back render if
  one exists, otherwise the source view. Pinned at unit and pipeline level.
- **Error shown unchanged once streaming stops** — met: code-keyed
  `DOCUMENT_ERROR_TEXT`, `role="alert"`, the untrusted `error.message` never
  rendered (unchanged from before; the error card itself was not touched).
- **Last successful render survives a failing newer attempt** — met, and it also
  survives a *loading* newer attempt, so there is no spinner flicker either.
- **Debounced re-init, no iframe per attempt** — met. 300 ms; a burst of three
  edits costs one attempt; the iframe node is asserted identical across
  attempts, both in the sandbox unit test and through the real panel.
- **Source + calm non-error status while streaming with nothing rendered** —
  met. `role="status"`, wording `Preview starts when the code is ready.`, no
  `role="alert"` anywhere in that state.
- **`isStreaming` comes from chat state** — met. It arrives as a
  `MarkdownRenderer` prop, rides context to the card, the store and the panel,
  and is never derived from text. The parser no longer reads message structure
  for this at all.
- **Fence prediction and its dependencies deleted** — met, grep-verified.
- **Kept, as required** — the store's `refreshActiveDocument`/`setActiveDocument`
  /`activeSelectionId` split, the card's remount re-publish (`previousRef`
  starting null), and `document-render-status` reaching `rendered` only on
  bridge `rendered` and `complete` only on python `result`. All three still have
  their tests and none were edited beyond the field rename.
- **Raw-HTML hole closed** — met, with a test on each side of the settle.

## Deviations

1. **Mermaid does not run-and-observe; it waits.** `MermaidDiagram` renders
   in-app and reports nothing back, so there is no attempt to observe — and it
   is outside this task's bounds, so it cannot be given a channel. A mermaid
   document therefore shows source plus the same calm status until its message
   settles, then draws. This is not fence prediction (no message text is
   parsed); it is the authoritative streaming flag alone. Behaviour is no worse
   than what the gate did, and the required "no error card mid-stream" holds.
2. **Out-of-bounds edit: `apps/web/src/lib/auth.test.ts`.** Making
   `Document.isStreaming` required broke two `Document` literals in that file's
   sign-out tests. Two lines of `isStreaming: false,` were added. The
   alternative — an optional field defaulting to "settled" — is the fail-open
   shape this task exists to remove.
3. **`pnpm-lock.yaml` changed**, outside bounds, as the unavoidable artifact of
   removing two declared dependencies. Note that the working-tree lockfile
   already carried uncommitted churn from other tasks (an `apps/sandbox`
   importer, a `@cloudflare/vitest-pool-workers` devDependency);
   `pnpm install --lockfile-only` preserved all of it and removed only the two
   `apps/web` entries. It is idempotent on a second run.
4. **Python is exempt from suppression** (`displayStatus`, the `isPython` early
   return): a Run pressed on a half-written python document shows its error.
   Deliberate — the reader explicitly asked for that run, so the answer is
   theirs to see — and it is a real difference from what `DOCUMENT_ERROR_TEXT`
   consumers might infer from the streaming rule. The reasoning is in the
   function's comment.
5. **`timed_out` copy added** on the coordinator's instruction after a
   concurrent task extended `DocumentErrorCode`. Written test-first (the copy
   test was watched failing); the accompanying suppression test passed
   immediately, which is the point — the rule covers a new error code without
   knowing it exists.

## Concerns and limitations

**Re-initializing a live frame is new load on the sandbox page, and two things
there were written assuming one init per frame.** Raised for sequencing; both
are in `apps/sandbox`, outside these bounds:

- `injectImportMap` (`apps/sandbox/src/render/bootstrap.ts:149`) *appends* a
  `<script type="importmap">` on every init, never replacing the previous one.
  Multiple import maps are only honoured by newer engines (roughly Chrome 133+ /
  Safari 18.4+); on the older Android WebView this codebase deliberately targets
  elsewhere, a map added after a module has loaded is ignored. So a bare
  specifier that first appears in a later token may fail to resolve —
  `import_failed` on the final attempt, in a frame that previously would have
  been fresh. Previously masked: the panel remounted the iframe on every content
  hash change, so every attempt got a clean document.
- `renderReact` calls `createRoot(root)` on the same container on every init.
  Repeated `createRoot` on one element is a React warning and leaks the previous
  root.

Neither is reachable by a test on the web side (the frame is a real
cross-origin document); both are cheap to fix at the source — replace the
existing import-map script rather than appending, and cache the root per
container.

**`docs/DOCUMENTS.md` §Panel UX is now stale** (lines 146–147: *"While a message
is still streaming, the document shows raw source; the preview activates when
the fence closes."*). Docs are outside these bounds and agent-read-only, so it
is raised rather than edited. The replacement fact is: a document is handed to
the sandbox as it streams; the preview appears as soon as an attempt renders;
failures are held back until the message settles.

**HTML builds up visibly while streaming**, as ruled. Because HTML never fails
to parse, the first attempt renders and every later attempt replaces it, so the
reader watches the document assemble. Accepted.

**A stream killed mid-block now shows a compile error** rather than a sentence
explaining the block never closed. Accepted, and pinned by a test so the change
is deliberate rather than drift.

**The message-wide over-gate is gone**, which was the other cost of prediction:
an earlier finished document in a still-streaming message no longer waits for
its message to settle. It previews as soon as it renders.

## Fix pass — audit findings addressed

**Critical: a superseded failure surfaced the moment the message settled.**
`displayStatus` keyed on `isStreaming` alone, with no term for "an attempt
against the current code has not reported yet". When a message settles while a
re-init is still in the 300 ms debounce, the reducer's `status: 'error'` from
the superseded attempt became visible immediately — an error card for code the
frame was never given, on the most ordinary shape there is (a message ending
right after its fence). Fixed by adding the `superseded` term
(`state.initializedCode !== null && state.initializedCode !== code`) and moving
`initializedCode` from a ref into reducer state so the difference participates
in rendering. Three tests were watched failing first: two in
`document-sandbox.test.tsx` (with and without a render being held) and one
through the real pipeline. The pipeline one was additionally mutation-checked —
forcing `superseded = false` turns it red and nothing else.

**Minor: a remounted card could never re-claim the panel.** The re-publish
required `activeDocumentId === document.id`, but the id is a content hash, so a
card that unmounted mid-stream and came back after the content grew matched
neither branch and published nothing — leaving the panel suppressing failures
forever behind "Preview starts when the code is ready." Closed with
`claimsRemountedSelection`: on mount only, a card claims the open selection when
its content **strictly** extends the open document's and the types match.
Strictness matters — equal content hashes to the same id, which is already an id
match, and requiring growth is what keeps the existing "does not claim active
when a different document is active" case passing.

**Minor: seven generic renderer tests were missing.** Bold/italic, GFM tables,
GFM strikethrough, empty content, custom className, blockquotes and malformed
markdown. They sat between the fence describe and `link styling` in the file,
inside the line span this task deleted, and they went with it — my error, not
the earlier task's. Restored verbatim from `HEAD`'s copy. That restoration
exposed a second thing: `markdown-renderer.test.tsx` mocks the document store
partially, and the card's new `activeDocument` read crashed every card-rendering
test until the mock gained `activeDocument: null`. The file now holds 31 tests.

## Confidence

High. The rule is one sentence implemented in one function, and every claim
about it was watched failing through the real renderer → card → store → panel →
bridge path before it passed — including the raw-HTML case, which the deleted
gate could not have covered under any implementation because that content
contains no fence. The full web suite is green on a clean run, per-file coverage
clears 95 on every changed file with every metric, lint and typecheck are green,
and the deletions are grep-verified. The reservation is the sandbox-side import
map: it is the one behaviour this change stresses that no web-side test can
reach.
