# B3 — Reader: concurrent synthesis (legacy mechanism, bounded) — impl report 1

## Objective

Restore multi-worker throughput for blog read-aloud: stop awaiting playback before issuing
the next `speak()`, with the number of in-flight speaks bounded to the worker pool size.
Playback order, state machine, error path, `onDownloadProgress` forwarding and the `stop()`
contract unchanged.

## Files changed

- `packages/ui/src/components/accessibility/lib/document-reader.ts` — `playChunks()` now
  pipelines synthesis ahead of playback through a bounded window; new
  `absorbRejectionNow()` helper; two now-inaccurate doc comments corrected.
- `packages/ui/src/components/accessibility/lib/document-reader.test.ts` — per-call deferred
  variant of the fake engine, four new concurrency tests, one existing test amended.

Nothing else was touched. `tts-engine.ts` is read-only here: only its exported
`WORKER_POOL_SIZE` is imported.

## The windowing implementation, and where the bound comes from

`playChunks()` keeps a FIFO `pending` array of `{chunk, speaking}` pairs plus an iterator
over the (immutable, known-up-front) chunk list:

```ts
const fillWindow = (): void => {
  while (pending.length < WORKER_POOL_SIZE) {
    const next = unissued.next();
    if (next.done === true) return;
    const speaking = tts.speak(next.value.text, voice);
    absorbRejectionNow(speaking);
    pending.push({ chunk: next.value, speaking });
  }
};

fillWindow();
let current = pending.shift();
while (current !== undefined) {
  if (readState(ctx) !== 'speaking') break;
  onChunk(current.chunk);
  try {
    await current.speaking;
  } catch { /* unchanged: stop ⇒ break, anything else ⇒ error */ }
  fillWindow();
  current = pending.shift();
}
```

The bound is `WORKER_POOL_SIZE`, imported from `tts-engine.ts` (`:22`) — the same constant
the engine sizes its pool with, not an independent number. If the pool changes, the window
changes with it and no second edit is needed. In-flight count is exactly
`pending.length + 1` (the `current` whose audio is playing) = `WORKER_POOL_SIZE` in steady
state, because `fillWindow()` runs after the head's audio ends and before the next head is
shifted. The tail case (fewer chunks left than the pool) is handled by the iterator being
exhausted, not by a second bound.

Why an iterator + FIFO rather than indexing `ctx.chunks[i]`: `@typescript-eslint/no-non-null-assertion`
is an error in this package's source, and `chunks[i]!` / `issued[i]!` cannot be written.
The FIFO shape also removes the need for an unreachable `undefined` fallback — `while
(current !== undefined)` is a real, fully covered loop condition.

## Both hazards, confirmed

**Hazard 1 — no-op handler attached at issue time.** `absorbRejectionNow(speaking)` is
called synchronously on the same line the speak is issued, before the promise is stored.
It uses the `void (async () => { try { await p } catch { … } })()` idiom already used in
`tts-stream-feeder.ts` (a bare `.catch()` trips `promise/prefer-await-to-then`). Verified
load-bearing by mutation: deleting the call makes the stop test fail with exactly three
(`WORKER_POOL_SIZE - 1`) unhandled `TTS speak was cancelled` rejections — the count the
research doc predicted.

**Hazard 2 — `onChunk` stays on the ordered-await path.** It fires only for the shifted
head, immediately before that head is awaited, i.e. when the previous chunk's audio ended.
It is never called from `fillWindow()`. Verified load-bearing by mutation: moving
`onChunk` into the issue path makes the paint test fail with `[0,1,2,3]` instead of `[0]`.

## Tests added

All in `describe('createDocumentReader — concurrent synthesis')`, plus a harness change.

| Test | Behavior | Criterion |
| --- | --- | --- |
| `issues synthesis for later chunks before the current chunk finishes playing` | with no speak resolved, `WORKER_POOL_SIZE` speaks have been issued | (1) |
| `paints only the chunk that is currently playing` | `onChunk` fires for 0 only; after chunk 0's audio ends, for 1 only | (2) |
| `never keeps more than the worker pool size of chunks in flight` | 10 chunks, resolved one at a time: in-flight is `min(POOL, remaining)` at every step — both `<= POOL` and window-kept-full | (1) |
| `stops cleanly with a full window outstanding` | `stop()` with 4 outstanding ⇒ state `stopped`, no `error`, one engine `stop`, zero unhandled rejections | (3), (4) |

Harness: `FakeOptions.perCallSpeakGate` gives every `speak()` its own deferred, settled
individually via `FakeTts.speakDeferreds` (the pre-existing shared `speakGate` settles all
outstanding speaks at once and cannot express a held-open window).

**The per-call `speak` is deliberately NOT a `vi.fn`.** Discovered while verifying hazard 1:
vitest attaches its own settled-result handler to every promise a mock returns, which marks
rejections handled. With `speak` as a `vi.fn`, the "no unhandled rejection" assertion passed
even with the guard deleted — i.e. it was vacuous. Proven with an isolated probe: three
rejected promises returned from a plain function surface as 3 unhandled; the identical
promises returned through `vi.fn` surface as 0. The fake now uses a plain function under
`perCallSpeakGate` (comment in the file records why), and the pin is genuinely red without
the guard.

### RED verification

- Test 1 — **RED** before implementation: `expected 1 to have a length of 4`.
- Test 3 — **RED**: `expected 1 to be 4` (in-flight was 1).
- Test 4 — **RED** on the window precondition; and separately RED on the unhandled-rejection
  assertion once the harness stopped masking it (3 unhandled).
- Test 2 — **green before and after, by design.** `research/tts-throughput.md` §Reproduction
  spec labels it "Green today, must stay green" — it is the regression pin against naive
  prefetch, not a driver. Because a test that is green in both directions can be vacuous, it
  was verified by mutation instead (see Hazard 2 above): it fails when `onChunk` moves to the
  issue path.

### Amended existing test

`createDocumentReader — stop() > stops audio and transitions to stopped when speaking`
asserted `fake.spoken.length < 3` on a 3-chunk document. That assertion pinned the bug
itself — "no synthesis was requested beyond the current chunk". Rewritten to pin the
behavior that actually matters and survives: playback stopped at the first chunk
(`painted` is `[0]`). Every other assertion in that test (state `stopped` last, one engine
`stop`) is unchanged. This is a fifth amended test beyond the four the plan's Phase 2
rulings pre-approved (those are in B1/B2/B4) — raised to the orchestrator.

## Self-gate

| Command | Result |
| --- | --- |
| `npx vitest run …/document-reader.test.ts` (packages/ui) | pass — 30/30 |
| `pnpm test:ui` (full suite + coverage + pole gate) | pass — 94 files, 1860 tests, exit 0 |
| `npx turbo typecheck lint --filter=@hushbox/ui --force` | pass — 2/2 tasks |
| `npx eslint <both owned files>` (from `packages/ui`, after the last edit) | pass — 0 problems |
| `npx jscpd --threshold 2 <owned files>` | pass — 0 clones (0%) |

Per-file coverage of `document-reader.ts` (v8 json-summary): **lines 89/89, statements
102/102, functions 19/19, branches 28/28 — 100% on all four.** No `v8 ignore` was added:
the only one in the file is the pre-existing `offsetsForPieces` guard at `:139-144`. The
window's error branch, its stop branch, the loop-top stop break, and the iterator-exhausted
path are all covered by real tests.

One aborted `pnpm test:ui` run crashed with `ENOENT … coverage/.tmp/coverage-1.json`. Cause
was my own leftover `packages/ui/coverage/` directory from a manual `--coverage` invocation;
removing it made the suite green. Not a product issue, and `coverage/` is gitignored.

## Acceptance criteria

1. **Synthesis for chunk N+1 requested before chunk N finishes playing; up to
   worker-pool-size in flight, never more — MET.** Tests 1 and 3; test 3 asserts the exact
   count `min(POOL, remaining)` at every step of a 10-chunk read, which pins both the upper
   bound and that the window is kept full.
2. **`onChunk` stays on the ordered-await path — MET.** Test 2, plus the mutation proof.
3. **No-op `.catch()` on every pre-issued promise at issue time — MET.**
   `absorbRejectionNow()` is invoked on the issue line; mutation proof gives 3 unhandled
   rejections without it.
4. **`stop()` with a full window ⇒ `stopped`, one engine `stop`, no unhandled rejection —
   MET.** Test 4.
5. **Playback order unchanged (document order) — MET.** The awaits are still strictly
   ordered over `ctx.chunks`; the pre-existing ordering tests (`assigns a monotonic index`,
   `speaks every chunk sequentially`, offset tests) pass unmodified.
6. **Four tests from the research doc's reproduction spec, first two RED first — PARTIALLY
   AS WRITTEN.** All four written. Tests 1, 3, 4 were RED first. Test 2 is green in both
   directions by the research doc's own statement, so it was validated by mutation instead
   of by a red run. See RED verification above.

## Deviations

- Criterion (6)'s "first two RED first" could not hold for test 2; the authoritative research
  doc labels that test green-today. Handled by mutation-verification rather than by weakening
  or contriving the test.
- One extra existing test amended (see above).
- Two doc comments in the owned file corrected because the change made them false: the file
  header ("plays the chunks sequentially" → "in document order, with synthesis pipelined
  ahead of playback", the wording the research doc prescribes) and `onChunk`'s doc ("just
  before its audio is requested" → "when its audio starts"). No behavior change.

## Concerns and limitations

- **Orphan audio on a mid-read engine error (raised, not fixed).** When a speak fails for a
  real reason (not a stop), the reader sets `error` and returns — but up to
  `WORKER_POOL_SIZE - 1` already-issued speaks stay outstanding and their audio will play.
  Before this change nothing else was ever in flight, so `error` implicitly meant silence.
  Preserving that would mean calling `tts.stop()` on the error path, which is an addition
  outside the acceptance criteria and contradicts the brief's explicit "error path
  unchanged", so it was not made. The engine only rejects speaks bound to the *failed slot*
  (`rejectSpeaksForSlot`, `tts-engine.ts:487`), so the others genuinely survive. Needs a
  ruling; it is a one-line follow-up either way.
- The magnitude of the throughput win is unmeasured (the research doc's per-chunk latency
  figure is Assumed). The structural claim — 4 workers busy instead of 1, no full-synthesis
  gap between sentences — is what the tests pin.
- `WORKER_POOL_SIZE` is imported from `tts-engine.ts`, which B1 is editing concurrently.
  The import is of a constant B1's criteria do not change; typecheck and the full ui suite
  were green against B1's current working state.

## Confidence

**High.** Both hazards are proven by mutation rather than asserted; the window bound is
pinned exactly (not just as an upper bound) across a 10-chunk read; per-file coverage is
100% with no new ignores; the full ui suite, typecheck, lint and jscpd are green. The one
open question (orphan audio on the error path) is identified and raised rather than guessed.
