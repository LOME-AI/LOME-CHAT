# B3 — Reader: concurrent synthesis — impl report 2 (fix round)

## Objective

One validated finding: the bounded prefetch window left orphan audio on the error path.
A genuine (non-stop) speak failure set state `error` while up to `WORKER_POOL_SIZE - 1`
already-issued speaks stayed outstanding, and their audio kept playing. Before the window
existed, `error` implicitly meant silence. Restore that contract: the error path stops
in-flight audio. Everything else built in round 1 stays.

## Files changed

- `packages/ui/src/components/accessibility/lib/document-reader.ts` — the ordered loop's
  `catch` now calls `tts.stop()` before transitioning to `error`.
- `packages/ui/src/components/accessibility/lib/document-reader.test.ts` — one new test
  pinning the silenced window on a mid-read synthesis failure.

Nothing else touched. `tts-engine.ts` (B1) and `tts.worker.ts` (B2) untouched; the
read-only `WORKER_POOL_SIZE` import is unchanged.

## The implementation, and how a genuine failure is told apart from a stop

```ts
    try {
      await current.speaking;
    } catch {
      // A stop() rejects the in-flight speak(); anything else is a real failure.
      // Only that case reaches the stop below, so the engine is stopped once:
      // stopRead() has already stopped it on the stop path.
      if (readState(ctx) !== 'speaking') break;
      // 'error' means silence. The engine rejects only the speaks bound to the
      // slot that failed, so the rest of the window survives and its audio
      // would play on after the read ended.
      tts.stop();
      setState(ctx, 'error');
      return;
    }
```

**Discrimination.** `stopRead()` sets state to `stopped` (and calls `service.stop()`,
`document-reader.ts:294`) *before* the engine's rejections land, so every stop-induced
rejection is absorbed by the pre-existing `readState(ctx) !== 'speaking'` guard and
`break`s out. Only a rejection that arrives while the reader is still `speaking` — a real
synthesis failure — falls through to the new `tts.stop()`. No new discriminator was
introduced; the existing guard already carried exactly this meaning, which is why the fix
is one line rather than a restructure.

**No double stop.** The two paths are mutually exclusive by that guard: the stop path
never reaches line 252, and the error path never runs `stopRead()`. After `error` the
reader is outside `ACTIVE_STATES`, so a later user `stop()` is a no-op and cannot add a
second engine stop.

**Mutation proof that the guard placement is load-bearing:** moving `tts.stop()` *above*
the guard fails two tests with `expected 2 to be 1` on `stopCalls` — the stop path
(`document-reader.test.ts:800`) and the new error test (`:844`). Restored after the probe;
the file was byte-restored from a pre-mutation copy and the suite re-verified green.

## Test added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `silences the outstanding window when a chunk fails to synthesize mid-read` | 6 chunks, full window issued, chunk 0's speak rejects with a real error while state is `speaking` ⇒ engine `stop` called exactly once, state ends `error`, no further chunk is painted or issued, no unhandled rejection | amendment criterion |

Assertions: `states.at(-1) === 'error'`, `fake.stopCalls === 1`, `painted === [0]`,
`fake.spoken.length === WORKER_POOL_SIZE` (no further synthesis requested), `unhandled === []`.

The test settles the surviving window both ways after the failure — one deferred resolves
(a survivor whose audio completed) and the rest reject as cancelled — so the "no playback
follows" assertion covers a resolution and the "no unhandled rejection" assertion covers
rejections that land after the ordered loop already returned.

**`vi.fn` avoided, per round 1's harness finding.** The test runs under
`perCallSpeakGate`, whose `speak` is a plain function precisely because vitest attaches
its own settled-result handler to every promise a mock returns, which marks rejections
handled and makes an unhandled-rejection assertion vacuous. That harness is unchanged and
this test reuses it; nothing in this round introduced a `vi.fn`-returned promise whose
rejection behavior is asserted.

### RED verification

Ran before touching `document-reader.ts`:

```
AssertionError: expected +0 to be 1 // Object.is equality
 ❯ document-reader.test.ts:844  expect(fake.stopCalls).toBe(1);
```

It failed for exactly the right reason: the state assertion on the line above already
passed (`error` was reached), and the failure is precisely "the engine was never stopped".
GREEN after the one-line fix: 31/31 in the file.

## Prior behaviors confirmed intact

All five verified by named passing tests in the same file (verbose run):

1. **Window bound derived from `WORKER_POOL_SIZE`** — `never keeps more than the worker
   pool size of chunks in flight`.
2. **Catch-at-issue-time** — `stops cleanly with a full window outstanding` (zero
   unhandled rejections with 4 outstanding), plus the new test's `unhandled === []`.
3. **`onChunk` on the ordered path** — `paints only the chunk that is currently playing`.
4. **Document-order playback** — `speaks chunks sequentially`, `assigns monotonic index`,
   and the offset tests, all unmodified and passing.
5. **100% per-file coverage, no new v8-ignores** — below; the only `/* v8 ignore */` in
   the file remains the pre-existing `offsetsForPieces` guard at `:139-144`.

## Self-gate

| Command | Result |
| --- | --- |
| `npx vitest run …/document-reader.test.ts` (from `packages/ui`) | pass — 31/31 |
| `npx vitest run --coverage --coverage.reportsDirectory=<scratchpad>` (full ui) | **exit 0** — 94 files, 1868 tests, per-file 95% thresholds enforced by `vitest.config.ts` and met |
| `npx turbo typecheck lint --filter=@hushbox/ui --force` | pass — 2/2 tasks |
| `npx eslint <both owned files>` (from `packages/ui`, after the last edit) | exit 0 — 0 problems |
| `npx jscpd --threshold 2 <owned source file>` | pass — 0 clones (0%) |

`jscpd` reports on the source file only: `.jscpd.json` ignores `**/*.test.ts` repo-wide,
so the test file is out of that gate by project config, not by omission.

Per-file coverage of `document-reader.ts` (v8, scoped run): **statements 103/103, branches
28/28, functions 19/19, lines 90/90 — 100% on all four.** Up one statement and one line
from round 1 (the new `tts.stop()`), branches unchanged: the new code adds no branch, it
rides the existing guard.

The pole gate was not run: the brief directed a raw scoped `vitest` invocation instead of
`pnpm test:ui` to avoid the shared-coverage collision, and the pole detector lives in
`scripts/run-package-tests.ts` behind the `test` script. This round adds one 4 ms test to
an existing file, so pole risk is unchanged from round 1, where `pnpm test:ui` passed.

### One failure, attributed to concurrent work — not mine

Two intermediate full-suite runs showed failures in
`packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` (5 failures, then 1).
That file belongs to B4/B5, not B3. Attribution evidence:

- `blog-read-aloud.tsx`'s mtime was **5 seconds old** at the moment I checked, i.e. it was
  being written while my suite ran.
- The ui test count moved 1861 → 1863 → 1868 across three runs of a tree I did not change
  between them.
- Direct A/B: with my `tts.stop()` **removed**, `blog-read-aloud.test.tsx` passed 36/36;
  with it **restored**, it passed 36/36 three consecutive times with the consumer files'
  md5 pinned identical across each run. The failures track the concurrent file's
  mid-write state, not my change.
- The final full-suite run (fresh coverage dir) is **exit 0** with that file green.

One other intermediate run died with
`Something removed the coverage directory "…/cov/.tmp"` — a reused `reportsDirectory`
across back-to-back invocations, resolved by using a fresh directory per run. Not a
product issue.

## Acceptance criteria

- **Amendment: a synthesis failure mid-read leaves NO further audio playing — MET.** The
  error path calls `tts.stop()`; pinned by the new test (engine stop exactly once, nothing
  further painted or issued, state `error`), RED first for that exact reason.
- **Genuine failure distinguished from stop-induced rejection; no double-stop — MET.**
  Existing state guard does the discrimination; mutation probe proves the ordering is
  load-bearing (`stopCalls === 2` when the stop is hoisted above the guard).
- **No unhandled rejection escapes — MET.** Asserted with a plain-function `speak`, not a
  `vi.fn`.
- **Round-1 behaviors preserved — MET.** Five named tests above; per-file coverage still
  100% with no new ignores.

## Deviations

None. The change is the one line the ruling specified plus its comment.

## Concerns and limitations

- The new test settles the surviving window with a mixed resolve/reject to exercise both
  the playback and the unhandled-rejection channels in one behavior, matching the brief's
  combined assertion list. Splitting it would duplicate the whole setup for one extra
  assertion.
- `WORKER_POOL_SIZE` is still imported from `tts-engine.ts`, which B1 owns and which
  changed under me during this round (its own tests moved). Typecheck and the full ui
  suite are green against B1's current working state; the import is read-only and B1's
  criteria do not change the constant.

## Confidence

**High.** The fix is one line on a path whose discriminator already existed; RED was
observed for the exact assertion the ruling names; the no-double-stop property is proven
by mutation rather than asserted; per-file coverage is 100% with no new ignores; and the
only suite noise was reproducibly attributed to a concurrent task's file by A/B with the
consumer's hash pinned.
