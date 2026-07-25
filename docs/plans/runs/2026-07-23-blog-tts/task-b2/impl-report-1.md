# B2 — Worker: aggregate download progress across files (impl report 1)

## Objective

Make first-listen download progress count 0→100 across the whole hub download instead of
per file, so it never starts at 100% and then drops to ~0%. Aggregation lands in the TTS
worker — the only layer that still has file identity — so the worker protocol, engine,
reader, widget, and blog component are all untouched.

## Files changed

- `packages/shared/src/tts-model-download.ts` — adds `TTS_MODEL_DOWNLOAD_BYTES` (92_887_010),
  the exact byte figure the file's header comment already derived, as the denominator floor.
- `packages/shared/src/tts-model-download.test.ts` — pins the new constant's value and that it
  and the friendly MB figure describe one download.
- `packages/ui/src/components/accessibility/lib/tts.worker.ts` — sums `{loaded,total}` per file
  inside `handleLoad`, emits the download-wide pair, and emits a completed pair before `loadDone`.
- `packages/ui/src/components/accessibility/lib/tts.worker.test.ts` — amended the per-file
  forwarding test into an aggregation test; adds the research doc's repro plus completion,
  unnamed-file, and non-numeric cases; adds a `runLoad` helper that fires progress *while*
  `from_pretrained` is pending, as the real hub does.

## The emitted contract (load-bearing for B4)

`loadProgress` messages are unchanged in shape (`{type,requestId,loaded,total}`); only the
numbers change. For one `load` request:

- **During download** — one message per numeric progress event, where
  `loaded = Σ loaded_i` over every file seen so far and
  `total = max(Σ total_i, TTS_MODEL_DOWNLOAD_BYTES)`.
  A file is keyed by `event.file`; a later event for the same file **replaces** its entry
  (never accumulates). Events lacking `file` share one entry (`undefined` is a legal Map key,
  so no fallback branch exists).
- **On success, immediately before `loadDone`** — exactly one message with
  `loaded === total === max(Σ total_i, TTS_MODEL_DOWNLOAD_BYTES)`, i.e. exactly 100%.
  This is emitted while `pendingLoad` is still live and the slot-0 requestId still matches,
  so `tts-engine.ts`'s `onLoadProgress` forwards it (Verified by reading `tts-engine.ts:562-576`;
  it filters on `pendingLoad !== null` and the slot-0 requestId, both still true at that point).
- **On failure** — no completion message; `loadError` as before.
- **Monotonic:** `total` is pinned at the floor for the real download (Σ of the real files is
  92,362,316 + the voice = 92,887,010 = the constant), and each file's `loaded` only grows, so
  the emitted percentage is non-decreasing. If the hub ever ships more bytes than the constant,
  `total` grows and the percentage can dip fractionally — cosmetic, never 100→0.

**B4 can rely on:** the percentage is < 100 for the entire real download and reaches exactly
100 once, at the end of the download and before warmup, so "aggregate percent < 100" is a
meaningful incompleteness gate and the bar can unmount at 100 rather than waiting for `speaking`.

## Tests added / amended

| Test | Behavior | Criterion |
| --- | --- | --- |
| `sums progress across files into one download-wide loaded/total pair` (**amended** from `forwards kokoro progress events as loadProgress messages`) | config.json 1200/1200 then weights 65536/92361116 emit `{1200, BYTES}` then `{66736, BYTES}` | AC1, AC6 |
| `never reports a near-complete download while the weights are still arriving` (**new, RED first**) | the research doc's three-event repro: first emitted percentage < 5 and the sequence is monotonic non-decreasing | AC4, AC7 |
| `reports a complete download before loadDone so no consumer is left below 100%` (**new, RED first**) | the last `loadProgress` before `loadDone` has `loaded === total` | AC3 |
| `counts unnamed progress events as one file rather than accumulating them` (new) | progress without a `file` name replaces one entry instead of summing | AC1 (keying) |
| `ignores progress events without numeric loaded/total fields` (amended mechanically) | same behavior, rephrased onto the `runLoad` helper because completion now emits a message the old assertion would have counted | AC1 |

**Amended-test intent, before → after:** the old test asserted `loaded === 25 && total === 100`
after feeding a single `{loaded:25,total:100}` event — i.e. it pinned verbatim per-file
forwarding, which *is* the bug (a 1.2 KB config.json arrives as `1200/1200` and reads 100%).
The rewrite feeds two files and asserts the summed pair with the floored denominator, so the
same code path is still covered and the assertion now pins correct behavior. Nothing was
deleted: the surviving non-numeric-event test keeps its original intent.

## Proof of RED

Shared constant (before implementing it):

```
FAIL src/tts-model-download.test.ts > exposes the exact byte total ...
  expected undefined to be 92887010
FAIL ... > keeps the byte total and the friendly MB figure describing one download
  AssertionError: expected NaN to be less than 5
```

Worker (before the aggregation, 3 failed / 28 passed):

```
FAIL > sums progress across files into one download-wide loaded/total pair
  - Expected: [{loaded:1200,total:92887010},{loaded:66736,total:92887010}]
  + Received: [{loaded:1200,total:1200},   {loaded:65536,total:92361116}]
FAIL > never reports a near-complete download while the weights are still arriving
  AssertionError: expected 100 to be less than 5     <-- the reported symptom, reproduced
FAIL > reports a complete download before loadDone so no consumer is left below 100%
  AssertionError: expected 65536 to be 92887010
```

The second failure is the bug exactly as reported: the first emitted percentage is 100.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch packages/ui/.../tts.worker.test.ts` | pass — 31/31 |
| `pnpm test:shared` | pass — 107 files, 2399 tests; coverage gate green |
| `pnpm test:ui` (via `pnpm exec vitest run --coverage` from `packages/ui`, isolated coverage dir) | pass — 94 files, 1860 tests; per-file 95% gate green. `tts.worker.ts` does not appear in the shortfall table ⇒ 100% statements/branches/functions/lines |
| `turbo typecheck --filter=@hushbox/ui --filter=@hushbox/shared --force` | pass |
| `eslint` on the four owned files (run from each package dir, after the final edit) | pass — exit 0 |
| `jscpd --threshold 2` on the four owned files | pass — 0 clones |

`pnpm test:ui` through turbo aborted twice with
`Something removed the coverage directory ".../packages/ui/coverage/.tmp" ... not running
multiple Vitests with the same coverage.reportsDirectory at the same time` — a collision with
the concurrent B1/B3/B4 runs in the same package, not a test failure. Re-run with an isolated
`--coverage.reportsDirectory` (same config, same thresholds) and it is fully green.

Two lint failures outside my ownership, both attributable to concurrent work and left alone:
`packages/shared/src/notifications/index.test.ts:94` (an **untracked** file I did not create)
and `packages/ui/.../document-reader.{ts,test.ts}` (B3's file, mtime moving during my run).

## Acceptance criteria

1. **Map + Σ + floored total — met.** `tts.worker.ts:89-101,116-121`: `bytesByFile` map,
   `aggregate()` returning `{Σloaded, max(Σtotal, TTS_MODEL_DOWNLOAD_BYTES)}`.
2. **`TTS_MODEL_DOWNLOAD_BYTES` in `packages/shared/src/tts-model-download.ts` — met.**
   Exported beside `TTS_MODEL_DOWNLOAD_MB`, re-exported by the existing barrel line
   `export * from './tts-model-download.js'`. Grep for `92887010|92_887_010|92,887,010` across
   `packages apps scripts e2e` returns exactly three hits, all in that one file plus its test:
   the pre-existing derivation comment (line 13), the constant (line 26), and the test's pin.
   **No second literal of the figure exists.**
3. **`loaded = total` forced on load completion — met.** Emitted immediately before `loadDone`
   (`tts.worker.ts:123-127`), pinned by test 3.
4. **Monotonic, first emission < 5% — met.** Pinned by the repro test.
5. **Five files untouched — met.** `tts-worker-protocol.ts`, `tts-engine.ts`,
   `document-reader.ts`, `sections/audio.tsx`, `blog-read-aloud.tsx` received no edit from me;
   my only writes this task are the four files listed above. (`tts-engine.ts` and
   `document-reader.ts` do have moving mtimes — that is B1/B3 working concurrently.)
6. **Amended test — met.** See the amended-test intent above.
7. **New test RED first — met.** Transcript above.

## Chat is unaffected

- `apps/web/src/lib/prewarm-tts.ts:18` calls `getTtsService().load(voice)` with **no** progress
  callback, so chat's boot prewarm never observes these numbers (Verified by grep).
- `chat-tts-stream.ts` never subscribes to load progress.
- The engine's slot-0 filter, the protocol, and `load()`'s resolution semantics are unchanged;
  only the two numbers inside an existing message type differ.
- `tts-engine.test.ts` (63 tests) passes unmodified.

## Beyond the blog: a pre-existing accessibility-widget bug fixed for free

`sections/audio.tsx` subscribes to the same `load(voice, onProgress)` callback and divides the
same single pair, so today the widget shows the identical 100%-then-0% bar. Worse, its byte
readout (`formatBytesProgress`), its `DownloadRateTracker` and its ETA are all fed per-file
counters, so they restart every time a new file's events begin. All four now read one download.
This is a real user-visible fix on a surface outside this feature; no widget code changed.

## Deviations

- The map is keyed `string | undefined` rather than forcing a `''` fallback for events with no
  `file`. `undefined` is a valid Map key, so this preserves the exact "one entry per file"
  semantics with no defensive branch to leave uncovered. Behaviorally identical to the brief's
  `Map<file, …>`.
- The completion emission is a separate `loadProgress` message rather than mutating the last
  one, because there may have been no progress events at all. A cached-ish load with zero
  numeric events therefore emits exactly one `loadProgress` at 100% before `loadDone` — which is
  what B4's "unmount at 100" wants.
- The `ignores progress events without numeric loaded/total fields` test was rewritten onto the
  new helper (same intent, same coverage): its old assertion counted *all* `loadProgress` posts
  and would now see the completion message.

## Concerns and limitations

- `TTS_MODEL_DOWNLOAD_BYTES` is a snapshot of the hub's current file sizes. If the model repo's
  files grow, `Σ total_i` exceeds the floor, `total` grows mid-download, and the percentage can
  dip fractionally. Cosmetic and self-correcting at completion; the failure mode is never
  100→0. The constant lives next to its documented derivation so a refresh is one edit.
- The `runLoad` helper fires progress synchronously inside `from_pretrained`. Real events are
  async and interleaved across files; the aggregation is order-independent, so this is faithful
  for the properties asserted, but it does not exercise wall-clock interleaving.

## Confidence

**High** — the diagnosis reproduced exactly (RED asserted 100 where < 5 was required), the fix
is confined to one function, the emitted contract is pinned by tests, and both packages' full
suites plus the per-file coverage gate are green.
