# P1 — document-reader pause/resume with a chunk-level checkpoint

## Objective

Give `createDocumentReader` a `paused` state with a chunk-index checkpoint: pause records the
index of the chunk currently painted, stops the engine; resume re-enters playback at that index.
No engine API change.

## Files changed

- `packages/ui/src/components/accessibility/lib/document-reader.ts` — index cursor replaces the
  chunk iterator; `paused` state; `pause()`/`resume()`; `stop()` acts from `paused` and clears
  the cursor.
- `packages/ui/src/components/accessibility/lib/document-reader.test.ts` — 5 new tests (1 primary
  reproduction + 4 companions). No existing test modified.

Nothing else was touched.

## Exported shape after the change (P2 depends on this)

```ts
export type DocumentReaderState = 'idle' | 'loading' | 'speaking' | 'paused' | 'stopped' | 'error';

export interface DocumentReader {
  start(audioCtx?: AudioContext): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): Promise<void>;
  readonly chunkCount: number;
}
```

Contract P2 must rely on:

- `'paused'` is a new member of `DocumentReaderState`. `blog-read-aloud.tsx`'s `applyReaderState`
  switch has no `default` and no `never` exhaustiveness check, so it still typechecks and lints
  untouched (verified: full `@hushbox/ui` typecheck + lint green, `blog-read-aloud.test.tsx`
  42 tests green, unmodified). Today `'paused'` falls through that switch as a no-op — P2 adds
  the branch.
- `pause()` is synchronous and acts **only** from `speaking`; from any other state it is a
  silent no-op (no `onState`, no engine `stop`).
- `resume()` acts **only** from `paused`; from any other state it is a no-op returning an
  already-resolved promise. It resolves like `start()`: when the read finishes, is stopped, is
  paused again, or fails.
- `resume()` emits **no** `'loading'` state and takes **no** `AudioContext`. The engine is a
  singleton and keeps the context adopted at `start()`, so there is nothing to load or unlock.
  Restoring a suspended/interrupted context stays the caller's job and must happen synchronously
  in the gesture that calls `resume()`, before any `await` (P2 criterion 7).
- `start()` is now a no-op while `paused` as well as while `loading`/`speaking` — a paused read is
  a read in progress. To restart from the top, `stop()` then `start()`.
- `stop()` acts from `loading`/`speaking`/`paused` and discards the resume point, so the next
  `start()` begins at chunk 0.
- After a pause, the engine has already been stopped exactly once; P2 must not call
  `reader.stop()` as part of pausing.

## How the cursor is recorded and reset

`ReaderContext` gains `cursor: number` (init `0`).

- **Recorded** in `playChunks` on the ordered-await path, on the same line that paints:
  `ctx.cursor = current.chunk.index;` immediately before `onChunk(current.chunk)`. So it always
  names the audible chunk, never a prefetched-but-not-playing one.
- **Consumed** by `fillWindow`, which now issues from `let unissued = ctx.cursor` (an index
  incremented per issue) instead of `ctx.chunks[Symbol.iterator]()`. That iterator was rebuilt
  from the head of the list on every entry to `playChunks` — the exact reason a restart replayed
  chunk 0.
- **Reset** by one helper, `endRead(ctx, 'idle' | 'stopped' | 'error')`, which zeroes the cursor
  and then sets state. It is the only exit used by the completion path, the mid-read speak-failure
  path, the load-failure path, and `stopRead`. A pause is the sole exit that does not go through
  it, so the cursor survives exactly one situation.

`pauseRead` sets state **before** calling `ctx.service?.stop()` — the same ordering `stopRead`
already used, so the speaks the engine rejects are observed by the loop as a deliberate halt.
`resumeRead` re-enters via `getTtsService()` (the same singleton `startRead` stored), sets
`'speaking'`, and awaits `playChunks`, which now starts at the cursor.

## Window-rejection path proven not to error

The ordered loop's `catch` already had `if (readState(ctx) !== 'speaking') break;`, and
`absorbRejectionNow` already claimed each speak at issue time; `'paused'` satisfies that guard the
same way `'stopped'` does, so no new code was needed and the existing stop path is unchanged.
Proven by the companion test `pauses cleanly with a full window outstanding`: with a full
`WORKER_POOL_SIZE` window in flight, `pause()` then rejecting **every** pending speak leaves last
state `'paused'`, `states` never contains `'error'`, engine `stop` called exactly once, and a
real `process.on('unhandledRejection')` listener records nothing. The fake's `speak` under
`perCallSpeakGate` is a plain function, not a `vi.fn`, so that last assertion is not vacuous
(pre-existing harness property, deliberately reused).

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `resumes at the chunk that was playing, not at the first chunk` | 6 chunks, window filled, chunk 0 resolved so chunk 1 is current; pause → last state `paused`; resume → first text spoken after resume is `Sentence number 1.` | (1)(2)(3) |
| `pauses cleanly with a full window outstanding` | full window rejected on pause: no `error`, one engine stop, zero unhandled rejections | (5)(6) |
| `starts again at the first chunk after a stop() from paused` | stop from `paused` → `stopped`; next `start()` speaks chunk 0 first | (4) |
| `ignores pause() unless a chunk is being spoken` | `pause()` from `idle` and from `loading` emits no state and never stops the engine | (2) |
| `ignores resume() unless paused` | `resume()` from `idle`, `speaking`, and `stopped` changes nothing | (2) |

### TDD evidence

Primary test watched RED before any source edit, and RED **twice over** as the research doc
predicted:

1. As written: `TypeError: reader.pause is not a function` at `document-reader.test.ts:826`.
2. Transiently rewritten to the closest expressible behavior (`stop()` then `start()`): first
   `AssertionError: expected 'stopped' to be 'paused'`, then with that assertion relaxed,
   `AssertionError: expected 'Sentence number 0.' to be 'Sentence number 1.'` — the iterator
   rebuild replaying chunk 0. The test was restored to `pause`/`resume` before implementing.

The four companions were written after the source change (one coherent mechanism), so each was
validated by mutation instead — every mutant reverted, source restored from a byte-for-byte
backup and verified `grep -c MUTANT = 0`:

| Mutation | Result |
| --- | --- |
| drop `if (readState(ctx) !== 'speaking') break;` from the loop's `catch` | `pauses cleanly…` FAILS: `expected 'error' to be 'paused'` |
| `stopRead` uses `setState('stopped')` instead of `endRead` (cursor kept) | `starts again at the first chunk…` FAILS: `expected 'Sentence number 1.' to be 'Sentence number 0.'` |
| drop the `!== 'speaking'` guard in `pauseRead` | `ignores pause()…` FAILS on the state array |
| drop the `!== 'paused'` guard in `resumeRead` | `ignores resume()…` FAILS (hangs to the 30 s timeout — resume from `idle` starts a read that never settles) |

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm exec vitest run --coverage` (from `packages/ui`) | pass — 94 files, 1879 tests, 0 failures; no per-file coverage shortfall |
| `npx turbo typecheck lint --filter=@hushbox/ui --force` | pass (2/2 tasks) after a prettier fix; re-run green |
| `pnpm exec eslint <both owned files>` after the final edit | exit 0 |
| `npx jscpd --threshold 2` on owned files | 0 clones, 0% duplicated |
| `pnpm exec vitest run document-reader.test.ts src/components/blog-reader` | pass — 78 tests (P2's current component suite unaffected) |

Coverage for `document-reader.ts`: statements 118/118, branches 32/32, functions 24/24, lines
100% — no uncovered lines (read out of `coverage-final.json`, not just the summary table).

First lint run reported two `prettier/prettier` errors on my multi-line union and Set literal;
fixed by collapsing both to one line, then eslint exit 0 on the owned files and turbo lint green.

## Preserved

Document-order playback, the bounded prefetch window and its derivation from `WORKER_POOL_SIZE`,
`onChunk` firing only on the ordered-await path, the existing state machine and error path,
`onDownloadProgress` forwarding, and the engine's public API — `tts-engine.ts` was not opened for
edit; `pause`/`resume` use only the existing `speak`/`stop` surface, and the full `tts-engine`
suite is green unmodified.

## Deviations

None from the acceptance criteria. Two judgment calls, both stated above rather than hidden:

- `start()` now no-ops while `paused` (`ACTIVE_STATES` gained `'paused'`). The criteria only name
  `stopRead`; leaving `start()` ungated would have made it a second, load-emitting resume path.
- `resume()` takes no `AudioContext`. The engine already holds the adopted context
  (`this.audioCtx ??=`), so an argument would be dead surface; the gesture-side restore is P2's.

## Concerns and limitations

- Resume restarts the paused sentence from its beginning (the founder-ruled granularity), and
  re-synthesizes up to `WORKER_POOL_SIZE` chunks. On-device CPU only, no network, no cost.
- `resume()` reaching `getTtsService()` assumes the singleton is the same instance `start()` used.
  It is, by construction of the module; the alternative (reading `ctx.service`) would have added
  an unreachable null branch.
- The reader has no idle timeout, so a long pause holds the loaded model in memory. Unchanged
  from before this task.

## Confidence

High — the primary behavior was watched RED for both predicted reasons, every companion is
mutation-proven, the whole `@hushbox/ui` suite and both gates are green, and per-file coverage on
the changed file is 100% across all four metrics.
