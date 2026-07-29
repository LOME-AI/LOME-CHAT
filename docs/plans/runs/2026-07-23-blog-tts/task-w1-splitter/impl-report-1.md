# W1 (2026-07-29 W-series) — one splitting path across all three consumers — impl report 1

> **Path deviation, raised to the orchestrator.** The brief named
> `task-w1/impl-report-1.md` and said to create the directory. That directory already exists
> and already holds a committed `impl-report-1.md` for the *earlier* W-series W1 ("Build-artifact
> guard: fail the build if the worker's `new.target` was rewritten", plan §2283). The two
> W-series reuse the same task IDs. Writing the given filename would have destroyed that run
> record, so this report went to `task-w1-splitter/impl-report-1.md` instead. Rename at will.

## Objective

Exactly one implementation of the sentence-ordinal → threshold → pieces policy, used by all
three consumers (chat stream feeder, blog document reader, DOM-observer fallback). Share the
policy, not the chunker/flush composition.

## Files changed

- `packages/ui/src/components/accessibility/lib/fast-start-splitter.ts` — new. Owns
  `FAST_START_SENTENCE_COUNT`, the ordinal counter, the halving arithmetic, and the delegation
  to `splitSentence`. Header comment records why the chunker is deliberately NOT shared
  (per-block code-fence flag) and that the counter spans one stream/document.
- `packages/ui/src/components/accessibility/lib/fast-start-splitter.test.ts` — new. Four
  behaviours of the shared unit.
- `packages/ui/src/components/accessibility/lib/tts-stream-feeder.ts` — dropped its private
  constant, `sourceSentenceCount`, and threshold arithmetic; constructs one splitter per
  feeder in `createTtsStreamFeeder`.
- `packages/ui/src/components/accessibility/lib/document-reader.ts` — `buildChunks`
  constructs ONE splitter for the whole document and threads it into `piecesForBlock`;
  `piecesForBlock` still builds its own per-block `SentenceChunker`.
- `packages/ui/src/components/accessibility/lib/document-reader.test.ts` — added the
  fast-start describe (criteria 6 and 7).
- `apps/web/src/lib/tts-dom-observer.ts` — `TrackedContainer` gains a `splitter`, created in
  `trackContainer`; emitted sentences now go through it before `speak()`.
- `apps/web/src/lib/tts-dom-observer.test.ts` — two added tests plus two fixture helpers.
- `packages/ui/package.json` — one new exports entry
  `./accessibility/lib/fast-start-splitter`, so `apps/web` can import the shared unit.

## Tests added

| Test | Behaviour | Criterion |
| --- | --- | --- |
| `createFastStartSplitter > splits the opening sentences at the halved threshold` | first sentences split at ceil(25/2) | 1 |
| `createFastStartSplitter > falls back to the full threshold once the fast-start budget is spent` | 4th sentence uses 25 | 1 |
| `createFastStartSplitter > counts sentences per splitter, so a second splitter starts fresh` | counter is instance state, not module state | 1 |
| `createFastStartSplitter > leaves a sentence under the halved threshold whole` | short sentence untouched | 1 |
| `createDocumentReader — fast-start splitting > spends the fast-start budget across the document, not per block` | 4 splittable blocks yield 7 chunks | 3, 6 |
| `createDocumentReader — fast-start splitting > keeps the offsets invariant for the pieces of a fast-start split block` | `normalizeForSpeech(block.textContent).slice(start,end) === text` for all 7 chunks | 7 |
| `installTtsDomObserver > splits an opening sentence that is over the fast-start threshold` | observer now splits long opening sentences | 4 |
| `installTtsDomObserver > gives each tracked container its own fast-start budget` | one splitter per tracked container | 4 |

## RED evidence

### Criterion 6 — watched fail at 4 before implementing

`cd packages/ui && pnpm test:watch --run src/components/accessibility/lib/document-reader.test.ts -t "fast-start"`

```
AssertionError: expected 4 to be 7 // Object.is equality

- Expected
+ Received

- 7
+ 4

 ❯ src/components/accessibility/lib/document-reader.test.ts:400:31
    400|     expect(reader.chunkCount).toBe(7);

 FAIL  ... > keeps the offsets invariant for the pieces of a fast-start split block
AssertionError: expected [ { blockEl: <p></p>, …(3) }, …(3) ] to have a length of 7 but got 4

 Test Files  1 failed (1)
      Tests  2 failed | 36 skipped (38)
```

4 is today's behaviour: nothing splits, because all four 20-word sentences sit under the full
threshold of 25. The test therefore discriminates all three outcomes (4 = no policy,
7 = document-level, 8 = block-level).

### Shared unit — watched fail before the module existed

```
Error: Failed to resolve import "./fast-start-splitter" from
"src/components/accessibility/lib/fast-start-splitter.test.ts". Does the file exist?
 Test Files  1 failed (1)
```

### DOM observer — watched fail before the observer used the splitter

```
 9th vi.fn() call:
-   "eL0 eL1 eL2 eL3 eL4 eL5 eL6 eL7 eL8 eL9,",
+   "eL0 ... eL9, eR0 ... eR9.",
 Test Files  1 failed (1)
      Tests  2 failed | 17 skipped (19)
```

Sentences were spoken whole; the expected halves never appeared.

## GREEN evidence

- `packages/ui` document-reader file after the change: **38 passed (38)** — the new 7-chunk
  test passes, and the bounded-window test
  (`never keeps more than the worker pool size of chunks in flight`) is among the 38.
- `apps/web` tts-dom-observer file after the change: **19 passed (19)**.

## Proof the counter is document-level, not block-level

- The splitter is constructed in `buildChunks`, once, before the
  `for (const blockEl of extractBlocks(container))` loop, and passed by reference into
  `piecesForBlock(raw, splitter)`. `piecesForBlock` constructs the `SentenceChunker` (per
  block, deliberately) but never a splitter.
- The 7-chunk test is the behavioural proof: the fixture is four `<p>` blocks, each a single
  20-word sentence with a comma at word 10 (both halves = 10 words, clearing the 6-word
  floor). Document-level → blocks 1–3 split in two and block 4 stays whole = 7. Block-level
  would restart the budget at each block, splitting all four = 8. No policy at all = 4.

## Chat regression check

`packages/ui/src/components/accessibility/lib/tts-stream-feeder.test.ts` was **not modified**
(`git diff --stat` on that path is empty).

```
> tsx ../../scripts/with-env.ts vitest --run src/components/accessibility/lib/tts-stream-feeder.test.ts
 Test Files  1 passed (1)
      Tests  25 passed (25)
```

The feeder's arithmetic moved verbatim into `createFastStartSplitter`: same constant, same
`sentenceCount < FAST_START_SENTENCE_COUNT ? Math.ceil(SPLIT_WORD_THRESHOLD / 2) :
SPLIT_WORD_THRESHOLD`, same increment-after-read ordering, one splitter per feeder instance.

## Offsets invariant (criterion 7)

Second added test in the same change asserts, for every one of the 7 chunks including the
shorter fast-start pieces, `normalizeForSpeech(chunk.blockEl.textContent).slice(startOffset,
endOffset) === chunk.text`. Green.

## Bounded window (criterion 8)

`createDocumentReader — concurrent synthesis > never keeps more than the worker pool size of
chunks in flight` and the surrounding pause/resume window tests are untouched and green
(inside the 38). Nothing about speak-issuing moved into the shared unit; the shared unit
returns strings and never touches the TTS service.

## Header comment (criterion 9)

`document-reader.ts`'s header claims "the same engine, chunker, splitter, and normalizer that
chat read-aloud uses. Nothing here is forked from those." That is now **true** — the reader
and the chat feeder run the identical policy object. No correction made.

## Self-gate

| Command | Result |
| --- | --- |
| `packages/ui` — `pnpm typecheck` | pass |
| `apps/web` — `pnpm typecheck` | pass |
| `packages/ui` — `npx eslint` over owned files (after last edit, from the package dir) | pass, exit 0 |
| `apps/web` — `npx eslint` over owned files (after last edit, from the package dir) | pass, exit 0 |
| `packages/ui` — `pnpm test` (full, coverage gate) | pass — 95 files, 1905 tests; Stmts 99.78 / Branch 99.17 / Funcs 100 / Lines 99.83 |
| `apps/web` — `pnpm test` (full, coverage gate) | pass — 396 files, 6463 tests; Stmts 99.22 / Branch 98.33 / Funcs 99.36 / Lines 99.48 |
| `pnpm arch:check` | pass — OK, 13 rules over 2186 files |
| `pnpm lint:duplication` | pass — 0.96% duplicated lines, threshold 2; no clone pair involves any file I touched (checked `reports/jscpd/jscpd-report.json`) |
| `pnpm lint:unused` (knip) | **fail, not mine** — see below |

### knip failure attribution

```
Unused files (1)
packages/config/vitest.package.config.ts
Configuration hints (1)
wrangler  apps/sandbox  knip.jsonc  Remove from ignoreDependencies
```

Neither item is mine: both paths are committed and unmodified in this working tree
(`git status --porcelain packages/config apps/sandbox knip.jsonc` is empty), and my change
adds no unused file. Knip did not flag the new module, the new exports entry, or
`FAST_START_SENTENCE_COUNT`. Pre-existing or owned by a concurrent workstream.

## Deviations

- **Report path** — see the note at the top of this file.
- **`FAST_START_SENTENCE_COUNT` is exported** from the shared module (the feeder kept it
  private). It is used by the shared unit's own test to express the budget boundary without
  hardcoding 3, matching the `SPLIT_WORD_THRESHOLD` precedent in the same directory. No
  production consumer imports it.
- **DOM observer splits after the async load gate**, not before it. `processContainer`
  already returns synchronously when the store gate is off, so a disabled stream never
  consumes budget; only the post-await "toggled mid-load" re-check can now discard sentences
  without spending the budget. The feeder, by contrast, splits first and gates per piece.
  This is composition (when the caller decides not to speak), not policy, and nothing
  observable differs — but it is the one place the three consumers are not literally
  identical.

## Concerns and limitations

- The blog reader's audible behaviour changes: the first three sentences of an article are
  now split at 13 words. That is the founder's ruling, and it is why criterion 6 exists.
- The DOM observer begins splitting long sentences where it previously spoke them whole.
  There are zero live `[data-tts-stream]` containers (verified: the only repo reference
  outside the observer and its test is a comment in `apps/web/src/routes/__root.tsx:51`), so
  the observable blast radius is the observer's own tests.
- `apps/web/src/lib/tts-dom-observer.test.ts` leaks an installed observer into later tests
  when a test fails before its `cleanup()` — a pre-existing property of the file's style,
  visible in my RED run (10 speak calls instead of 5). My added assertions use
  `toHaveBeenCalledWith`, not call counts, so they are insensitive to it. Not fixed: out of
  scope.
- The three test files each define their own `manyWords` / `makeSplittableSentence` fixture
  helpers. These are independent fixtures, not a sync contract (drift changes nothing about
  correctness — each test asserts against its own fixture), and jscpd does not flag them.

## Confidence

**High.** The discriminating test was watched red at 4 and is green at 7; chat's 25 tests pass
with the test file byte-unchanged; both full package suites pass their coverage gates; the
only failing repo gate is attributable to files I never touched.
