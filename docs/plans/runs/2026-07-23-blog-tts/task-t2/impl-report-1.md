# T2 — document-reader module — impl report 1

## Objective

Build the framework-agnostic `document-reader` lib module in `packages/ui` per the plan's
§Interfaces contract and T2 acceptance criteria: extract readable blocks from a container,
chunk them through the existing sentence pipeline, and play them sequentially through
`getTtsService()`, emitting the reader interface. Test-first, engine mocked at the
`getTtsService` seam only.

## Files changed

- `packages/ui/src/components/accessibility/lib/document-reader.ts` (new) — the module.
- `packages/ui/src/components/accessibility/lib/document-reader.test.ts` (new) — colocated tests (26).
- `packages/ui/src/components/accessibility/lib/index.ts` — barrel re-export of `createDocumentReader` + its types.
- `packages/ui/package.json` — new subpath export `./accessibility/lib/document-reader` (follows the existing per-file accessibility-lib export pattern).

Nothing else touched. The chunker/splitter/normalizer/engine are reused unmodified (G1/G4).
`sentence-splitter` did **not** need a public export: both T2 and T3/T4 consumers live inside
`packages/ui` and import it relatively, so I did not add that (permitted-but-not-required) export.

## Shipped signature

```ts
createDocumentReader(options: {
  container: HTMLElement;
  voice: TtsVoice;                 // see deviation below
  onChunk: (e: {
    index: number; blockEl: HTMLElement; text: string;
    startOffset: number; endOffset: number;
  }) => void;
  onState: (s: 'idle' | 'loading' | 'speaking' | 'stopped' | 'error') => void;
  onDownloadProgress: (p: { pct: number }) => void;
}): { start(): Promise<void>; stop(): void; readonly chunkCount: number }
```

Exported types: `DocumentReader`, `DocumentReaderState`, `DocumentReaderChunk`,
`CreateDocumentReaderOptions`.

## Offset coordinate system (load-bearing for T3)

**Offsets are character offsets into `normalizeForSpeech(blockEl.textContent)` — the block's
"normalized-source text".** Per chunk:

- `text` is the exact speak-piece (a `splitSentence` piece of a chunker-emitted normalized
  sentence). It is what is passed to `speak()`.
- `startOffset`/`endOffset` are found by a document-order cursor search
  (`normalized.indexOf(piece, cursor)`), so `text === normalizeForSpeech(blockEl.textContent)
  .slice(startOffset, endOffset)` on every real input (verified by a test that reconstructs the
  slice, including a case where a raw URL is normalized to `"link"` — the span still resolves
  against the normalized-source text, not the raw text nodes).

**Exact coordinate system for T3:** these offsets index the **normalized** text, not the raw
DOM text nodes. T3 must recompute the identical string via the same
`normalizeForSpeech(blockEl.textContent)` (same pure function, same DOM input ⇒ byte-identical),
then tolerantly map the normalized-offset span onto the raw DOM text nodes to build a Range —
because normalized text differs from raw `textContent` by whitespace collapse, markdown
stripping, and URL→"link", so a 1:1 offset into raw text nodes would be wrong. This is the
"tolerant text-to-Range matching" T3 owns.

**Fallback (found === -1):** the module carries a block-level fallback (span = `[0,
normalized.length)`) so T3 degrades to a whole-block highlight on a miss. It is marked
`/* v8 ignore */` because it is **unreachable with the current pipeline**: a piece is a trimmed
slice of a normalized sentence, a normalized sentence is a substring of the whole block's
normalized text (same `normalizeForSpeech`; the chunker only trims at sentence boundaries it
finds in the same text), and occurrences are in document order, so the cursor search never
misses. I could not construct a real DOM miss (documented reasoning below in Concerns). This
matches the codebase convention (`tts-engine.ts`, `sentence-chunker.ts`, `sentence-splitter.ts`
all `/* v8 ignore */` their equivalent defensive branches). The fallback is still present and
correct as a fail-soft guard.

## Extraction

- Selector `p, h1, h2, h3, h4, h5, h6, li, blockquote`, in document order (querySelectorAll).
- **Outermost-match rule:** a matched block nested inside another matched block is skipped
  (e.g. `blockquote > p` reads the blockquote once; the inner `p` is not double-counted).
- **`pre` skipped two ways:** `pre`/`code` are not in the selector (so ordinary code blocks are
  never matched), and any matched block whose `closest('pre')` is non-null is dropped (guards a
  block element buried inside a `pre` — covered with a genuine `append()`-built DOM so the
  nesting survives parser reparenting).
- Whitespace-only / empty blocks (normalized length 0) are skipped.

## Engine seam mocked in tests

`getTtsService` from `./tts-engine`, mocked via `vi.mock('./tts-engine', …)` spreading the
original module and overriding only `getTtsService` to return a per-test configurable fake
`TtsService` (held in a `vi.hoisted` box). This is the single seam per criterion (7); the
chunker/splitter/normalizer run for real. The fake drives: load progress callbacks, load
rejection, and a gated/rejecting `speak()` promise for the stop/cancel paths.

## State machine (incl. error path)

- `start()` when idle/stopped/error → `loading` → (engine `load`) → `speaking` → play each chunk
  → `idle` on natural completion.
- Engine **load** failure → `error` (no chunks spoken).
- **speak** failure mid-read: if state is still `speaking` → `error`; if a `stop()` already
  flipped state to `stopped` (the real engine rejects the in-flight `speak` on stop) → break
  silently, ending in `stopped`.
- `stop()` → `stopped` + `service.stop()`; only acts from `loading`/`speaking`, otherwise no-op;
  idempotent (a second stop neither re-emits nor re-calls engine stop). A `stop()` during
  `load()` (which has no cancel) is observed after load resolves and never reaches `speaking`.
- `start()` while already `loading`/`speaking` is ignored; `start()` after a completed/stopped
  read replays from the beginning (no seek/resume — founder scope).
- `unlockAudio()` is called inside `start()` (must run in the click gesture — iOS).
- `onDownloadProgress({ pct })` forwards `load`'s `(loaded,total)` as `loaded/total*100`, guarded
  to `0` when `total === 0`.

## Self-gate

- `pnpm exec vitest run …/document-reader.test.ts` — **pass**, 26 tests.
- Per-file coverage on `document-reader.ts` — **100%** stmts / **100%** branch / **100%** funcs /
  **100%** lines (the two genuinely-defensive branches are `/* v8 ignore */`d per codebase
  convention).
- `pnpm test:ui` (full package, coverage gate) — **pass** (1 task successful; no per-file
  threshold failure — the new file passes the 95% gate in-context and no sibling test regressed).
- `turbo typecheck lint --filter=@hushbox/ui` — **pass** (2 tasks successful).
- `jscpd --threshold 2` on owned files — **pass**, 0 clones (0%).
- ESLint run on owned files from the package dir after the final edit — **exit 0**.

## Acceptance criteria

1. Exact Interfaces signature — **met** (see Shipped signature; one type-name deviation below).
2. Extraction covers `p/h1..h6/li/blockquote`, skips `pre`, document order, offsets identify each
   chunk's span — **met** (extraction + offset tests).
3. Chunks flow through existing chunker+splitter+normalizer — **met** (composes `SentenceChunker`,
   `splitSentence`, `normalizeForSpeech` unmodified).
4. Sequential `getTtsService().speak` with passed voice; `onChunk` at each chunk start; `onState`
   correct incl. `error` on engine load failure; `onDownloadProgress` forwarded — **met**.
5. `stop()` halts audio promptly and is idempotent — **met**.
6. New subpath export following the accessibility-lib pattern — **met** (package.json + barrel).
7. TDD, 95% per-file coverage, engine mocked at `getTtsService` seam only — **met** (100%).

## Deviations

- **`voice` type name:** the plan's Interfaces block wrote `voice: TtsVoiceId`. No `TtsVoiceId`
  type exists; the real exported voice-id union is `TtsVoice` (`tts-engine.ts`), which is what
  T3/T4 consume. I used `TtsVoice`. Same values, correct authority — a placeholder-name
  reconciliation, not a semantic change.

## Concerns and limitations

- **Fallback unreachability:** I attempted several DOM constructions to force a real
  `indexOf` miss (multi-line paragraphs, mid-line heading/list markers, table separators,
  duplicate sentences, URLs) — all still matched, because whole-block and per-sentence
  normalization use the same `normalizeForSpeech` with identical line boundaries, so pieces are
  always order-preserving substrings of the block's normalized text. I concluded the fallback is
  a genuine fail-soft guard, not reachable behavior with this pipeline, and marked it
  `/* v8 ignore */` (codebase convention). T3 should still implement its own tolerant matching +
  block fallback for robustness — the reader will only ever hand it valid, in-order spans.
- **No fast-start halved-threshold** (the chat feeder's first-3-sentences optimization) — I used
  the default `splitSentence` threshold. The plan mandates "flow through the existing pipeline",
  not the feeder's chat-specific fast-start heuristic; keeping it out is the simpler, in-scope
  choice.

## Confidence

**High** — exact signature and behavior implemented test-first; 100% per-file coverage; all
scoped gates green; reuse-only of the existing pipeline. The one judgment call (fallback marked
defensive) is documented with reasoning and matches established codebase practice.
