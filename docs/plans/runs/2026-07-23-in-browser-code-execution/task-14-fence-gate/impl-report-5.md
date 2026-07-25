# Fence gate — fix pass 5

## Objective

Replace the hand-rolled CommonMark fence scan behind `endsInsideOpenFence` with the
markdown engine the renderer itself parses with, and make the two remaining fail-open
shapes gate. The message-level gating design — `sourceStateFor`, the gate wiring, the
panel behavior, message-granularity gating, the accepted sibling over-gate — is
unchanged; only how the single boolean is computed changed.

## Engine API and why

`parse` / `postprocess` / `preprocess` from **`micromark`** (main entry, public
exports), driven exactly as `mdast-util-from-markdown` drives it:

```ts
postprocess(parse().document().write(preprocess()(markdown, null, true)))
```

The event stream is the right level for this question and the mdast tree is not. A
fenced block emits one `codeFencedFence` token per fence line — two when its closing
fence arrived, one when it never did — so "unterminated" is read directly off the
engine. mdast records no such thing: an unterminated block and a block closed at the
very end of the source both end at the source end, so answering from the tree would
mean re-deriving closing-fence rules from the source text, which is the class of code
being deleted. The info string is read the same way (`codeFencedFenceInfo` present on
the opener).

The rule: **the last fenced block is open when it has fewer than two fence lines and
carries an info string.**

- *Last block only* — a fenced block that never closes runs to the end of its
  container, so an earlier unterminated block means its container ended and its
  content is whole.
- *Info string required* — a block with no language is never extracted as a document
  (`shouldExtractAsDocument` returns false), so an unterminated one has nothing to
  gate. This is what keeps the pinned "list-indented opener closed by an unindented
  run" case rendering: the engine reads that as the list ending plus a fresh
  language-less fence.

## Memoization and cost

Two module-level fields hold the last source and the answer given for it. A call whose
source starts with the cached source and whose *growth carries neither a backtick nor a
tilde* returns the cached answer without running the engine — text with no fence
character can neither open nor close a fence, so the engine's answer for the prefix
still holds. This can only ever repeat an answer the engine gave for a prefix of the
same text, so it cannot report closed where the engine reports open; it fails, if at
all, toward gating. The initial empty cached source makes fence-free prose an engine-free
`false` for the same reason.

Measured on an 18.6 KB message (400 code lines) replayed token by token at ~6 chars per
token, 3 104 calls:

| | engine runs | total |
| --- | --- | --- |
| with the shortcut | **2** | **16 ms** |
| parsing every call | 3 105 | 1 421 ms |

One engine run costs 0.87 ms on that message and 0.02 ms on a short prose message. The
renderer already memoizes per `content`, so a static message pays one run on mount.

## Files changed

- `apps/web/src/lib/document-parser.ts` — bespoke scanner deleted, engine-based
  implementation plus the growth shortcut added.
- `apps/web/src/lib/document-parser.test.ts` — 7 cases added, 2 assertions corrected.
- `apps/web/src/components/chat/message/markdown-renderer.test.tsx` — 5 pipeline cases
  added, 1 assertion corrected. Tests only; no renderer source touched.
- `apps/web/package.json` — `micromark: ^4.0.2` declared (it was only a transitive
  hoist under Streamdown).
- `pnpm-lock.yaml` — the lockfile entry for that dependency. Additions only, no removals,
  no version changes.

### Deleted

`FenceMarker`, `TAB_STOP`, `CLOSING_RUN_TAIL`, `BLOCKQUOTE_PREFIX`, `QuoteStripped`,
`stripBlockquotePrefix`, `readFenceMarker`, `closesFence`, and the `split(/\r?\n/)` line
loop. A repo-wide grep for every one of those names returns nothing outside
`node_modules`.

## Tests added

| Test | Level | Behavior |
| --- | --- | --- |
| longer fence run opened after an earlier fence closed | parser + pipeline | gates |
| the same with tildes | parser + pipeline | gates |
| the same with both fences inside a list item | pipeline | gates |
| unclosed fence opened after a bare carriage return | parser + pipeline | gates |
| unclosed fence in an all-carriage-return source | parser + pipeline | gates |
| answer holds as an open message grows by fence-free text | parser | stays open |
| answer holds as a closed message grows by fence-free text | parser | stays closed |
| the markdown engine throws | parser | reports open |

Bare CR is handled by the engine natively, which was the outstanding defect: CommonMark
treats a lone CR as a line ending, and both new CR cases now gate.

### RED verification

- Parser file before the change: **4 failed | 77 passed**, every failure
  `expected false to be true` — the gate releasing partial source, which is the reported
  defect.
- Renderer file before the change: **5 failed**, every failure
  `expected undefined to be 'streaming'` — same defect at the pipeline level.
- The three tests that cannot be driven red by the old implementation (the two
  growth-shortcut cases and the engine-throws case) were mutation-checked instead: with
  the shortcut's answer inverted and the catch returning `false`, exactly those three
  fail and nothing else does. They have teeth.

### Ground truth

Every expectation in the corpus, old and new, was run through the micromark event stream
before being asserted — 60 inputs covering the whole existing corpus plus the new shapes.
Three disagreed with the pinned expectations; all three are addressed below.

## Assertions corrected

1. **Three-space closer** (`document-parser.test.ts`) — `'```md\ntext\n   ```'` now
   asserts **closed**. The pass-4 rule `marker.column <= open.column` was stricter than
   CommonMark and was the cause of the longer-run defect; with the engine as the source
   of truth the closer sits within the three columns a closing run may carry, so the
   document is complete and previews immediately. Re-inverted as instructed.
2. **Its pipeline twin** (`markdown-renderer.test.tsx`, closer two columns in) — same
   correction, `sourceState` now expected unset. This assertion was not named in the
   brief; it is the same trade-off pinned at the pipeline level and could not survive
   the re-inversion.
3. **Fence-looking line indented four spaces** — `'    ```js\n    const x = 1;'` now
   asserts **closed**. Four columns of indentation makes an indented code block, not a
   fence; such a block declares no language, so no document is ever extracted from it and
   there is nothing to gate. Verified that Streamdown's repair pass (`remend@1.3.0`)
   leaves that input byte-identical, so the renderer sees the same indented code block.
   Not named in the brief — see Deviations.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:web --force` | **393 files / 6407 tests passed**, coverage gate green, task exit 0 |
| per-file coverage, `document-parser.ts` | **100** statements / 100 branch / 100 functions |
| per-file coverage, `markdown-renderer.tsx` | 96.88 / 100 / 100 — unchanged, source not edited |
| `turbo typecheck lint --filter=@hushbox/web --force` | 2 successful, 2 total |
| `jscpd --threshold 2` over `apps/web/src/lib` + `apps/web/src/components/chat/message` | pass — 0.06%, 1 clone, both sides in `chat-run.ts` / `trial-refusals.ts`, untouched |
| `eslint` over the three changed files, from `apps/web`, after the last edit | exit 0 |

The full suite was run with `--coverage.reportsDirectory` pointed at a private scratchpad
path; the shared `apps/web/coverage/.tmp` races with concurrent agents.

Lint caught two errors in the first draft of the new code (a prettier wrap and
`unicorn/prefer-switch`); both are fixed in the shipped version, which is why the loop is
a `switch`.

## Acceptance criteria

- **Engine, not a hand-rolled scan** — met. The only fence logic left is reading token
  types off micromark's event stream.
- **Bespoke scanner deleted** — met, verified by repo-wide grep.
- **Defect (a) gates** — met. Backtick, tilde and list-item variants all gate through the
  real pipeline; all were RED first.
- **Defect (b) gates** — met. Both the mixed bare-CR and all-CR inputs gate through the
  real pipeline; both were RED first, and the engine handles CR natively.
- **Existing corpus passes** — met, with the three corrections above: closing fence with
  an info string, fence indented in a list, fence in a blockquote, `~~~`, 4-backticks-
  closed-by-3, CRLF, NBSP / U+3000 / FF / VT tails, the o=1..3 × c=4..6 matrix, the
  mermaid variants, duplicated code bodies, the sibling over-gate, and the whole
  no-over-gating set.
- **Fails toward over-gating** — met. The engine call is wrapped; a throw reports open,
  pinned by a test. The growth shortcut can only repeat a prefix's answer.
- **Performance** — met, measured above.

## Deviations

- The brief said to keep every existing case and named one assertion to re-invert. Three
  were corrected, not one: the named three-space closer, its unnamed pipeline twin, and
  the four-space indented-code case. The third is a real engine-vs-test conflict, not a
  convenience: the engine reports no fence there at all. It is called out in the return
  message.
- `pnpm-lock.yaml` changed. It is outside the named bounds and is the unavoidable
  artifact of the approved dependency addition.

## Concerns and limitations

**A narrow fail-open this change opens, verified.** The gate parses core CommonMark;
Streamdown parses with `remark-gfm`. Across all 60 corpus inputs the two agree exactly.
They disagree on one construct: a GFM **footnote definition** is a container core does
not have, so a fence indented under one reads as an indented code block to the gate and
as an open fenced block to the renderer.

```
[^1]: note

    ```js
    const partial = (
```

core → closed · gfm → open. The old scanner gated this input (it treated any
fence-looking run as an opener), so this is a narrow regression, not a pre-existing gap.
The fix is one line — `parse({ extensions: [gfm()] })` — and I confirmed it changes no
other corpus answer, but it needs a second dependency
(`micromark-extension-gfm`), which the bounds cap at one. Raised for sequencing.

**Unchanged from earlier passes.** Gating is message-wide, so an already-complete earlier
document waits for its message to settle; the panel shows raw source with "Preview starts
when the response finishes."

**Module-level cache.** `endsInsideOpenFence` is no longer a pure function of its
argument in the strict sense — it keeps two fields of state. It is still deterministic in
its answers (proved by the argument in the code comment and by the mutation check), and
the state is bounded at one string reference.

## Confidence

High. The implementation is now the same parser the renderer uses rather than a second
reading of the spec; every expectation in the corpus was checked against that parser
before being asserted; both reported defects were watched failing through the real render
pipeline and now gate; the changed file measures 100% on statements, branches and
functions; the whole web suite is green. The GFM footnote divergence recorded above was
subsequently closed — see the addendum.

---

# Addendum — GFM dialect

The footnote fail-open raised above is now fixed: the gate parses in the renderer's
dialect.

## Change

- `apps/web/src/lib/document-parser.ts` — `parse()` became
  `parse({ extensions: [gfm()] })`.
- `apps/web/package.json` — `micromark-extension-gfm: ^3.0.0` declared alongside
  `micromark`. Lockfile updated; additions only.
- `apps/web/src/lib/document-parser.test.ts` — 2 cases added.
- `apps/web/src/components/chat/message/markdown-renderer.test.tsx` — 1 pipeline case
  added.

## The shape, and what it took to reach it

The first version of the pipeline test used a bare footnote definition and failed with
*no document card at all*. Probing the real renderer showed why: `remark-rehype` drops a
footnote definition that nothing references, so that message renders empty. With a
reference present the definition renders, and the fence inside it becomes a document
card. The reachable shape is therefore:

```
See note[^1].

[^1]: A note.

    ```js
    …15 lines…
    const partial = (
```

Both tests use that form. Had the probe shown no card under any form, the divergence
would have been unreachable and worth reporting rather than fixing.

### RED verification

- Parser: `expected false to be true` — the gate reporting a live open fence closed.
- Pipeline: `expected undefined to be 'streaming'` — a real document card rendered and
  released ungated. This is the fail-open itself, observed through `<MarkdownRenderer>`,
  not an argument about it.

Both pass with the extension in place.

## Corpus re-confirmed, not assumed

The 60-input ground-truth corpus was re-run comparing the core parse against the GFM
parse: **zero differences**. The suites agree — no existing assertion needed changing,
and the two files now hold 147 passing tests.

## Other dialect differences

The renderer's dialect is `remark-parse` + `remark-gfm` + the math plugin
(`remark-math`); the app passes no `remarkPlugins` of its own. Checked, and what remains:

- **GFM** — now modeled. It was the only difference that could report an open fence
  closed.
- **Math (`$$`)** — not modeled, and checked rather than assumed. The only divergence
  found is `$$` followed by an unclosed fence: the renderer reads the fence as math
  content (no code block, so no document card), while the gate reads an open fence and
  gates. That is the over-gating direction, and it is one-way — a math construct can only
  hide fences from the renderer, never create one, so it cannot produce a card the gate
  called closed.
- **`remend` (Streamdown's streaming repair)** — the gate reads raw source by design.
  Verified that the repair leaves fenced and indented code blocks byte-identical; it
  completes inline formatting only.
- **rehype plugins** (`rehype-raw`, sanitize, harden) — render-time HTML handling, not
  markdown tokenization; they cannot change whether a fence is open. Worth noting
  separately that raw HTML `<pre><code class="language-…">` in a message reaches the same
  interception path without ever being a fence — a different question from this gate's,
  and outside it.

## Self-gate (re-run after the change)

| Command | Result |
| --- | --- |
| `pnpm test:web --force` (private `--coverage.reportsDirectory`) | **393 files / 6410 tests passed**, coverage gate green, exit 0 |
| per-file coverage, `document-parser.ts` | **100** statements / 100 branch / 100 functions |
| per-file coverage, `markdown-renderer.tsx` | 96.88 / 100 / 100 — unchanged, source not edited |
| `turbo typecheck lint --filter=@hushbox/web --force` | 2 successful, 2 total |
| `jscpd --threshold 2` over `apps/web/src/lib` + `apps/web/src/components/chat/message` | pass — 0.06%, 1 clone, both sides untouched files |
| `eslint` over the three changed files, from `apps/web`, after the last edit | exit 0 |

An investigative probe file was written under
`apps/web/src/components/chat/message/` to dump the rendered HTML, and deleted; the
working tree holds no leftovers from it.
