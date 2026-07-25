# B1 — Engine: dedicated download phase, then fan out (impl report 1)

## Objective

A cold first listen must download the Kokoro model once, not `WORKER_POOL_SIZE` times.
`load()` now posts `load` to slot 0 only and fans out to slots 1–3 after slot 0 reports
`loadDone`, leaving every other engine contract untouched.

## Files changed

- `packages/ui/src/components/accessibility/lib/tts-engine.ts` — staged the load fan-out
  (slot 0 downloads; `onLoadDone(slot 0)` hands `load` to the rest) and corrected the
  progress-filter comment (Cache API, not IndexedDB; the ordering claim is now true).
- `packages/ui/src/components/accessibility/lib/tts-engine.test.ts` — new staged-fan-out
  test, two `loadCounts`/`perSlot` helpers, and four amended tests (below).

## Implementation

`load()` (was lines 256–263, a synchronous loop over all four slots):

```ts
const downloadSlot = this.workers[0];
const downloadRequestId = loadRequestIdBySlot[0];
/* v8 ignore next */
if (downloadSlot !== undefined && downloadRequestId !== undefined) {
  this.postToSlot(downloadSlot, { type: 'load', requestId: downloadRequestId });
}
```

The old loop body became `fanOutLoadAfterDownload(pending)`, which skips slot 0 and posts
each remaining slot's pre-minted `loadRequestIdBySlot` entry. It is called from
`onLoadDone` on one line, inside the existing duplicate-`loadDone` guard so a repeat
message cannot re-fan-out:

```ts
pending.loadDoneBySlot[slotIndex] = true;
if (slotIndex === 0) this.fanOutLoadAfterDownload(pending);
```

The requestIds themselves are still all minted up front in `load()`, so the stale-message
guards (`loadRequestIdBySlot[slotIndex] !== requestId`) behave exactly as before.

A durable comment in `load()` records why parallel loading cannot be fixed at the HTTP
layer (per-realm cache lookups, `cache.put` only after the full body, `no-store` 302 to a
per-request signed CDN URL) — the facts from the research doc that make the staging
load-bearing rather than a stylistic choice.

## Tests added

- `load() fans the load out to the remaining slots only after slot 0 reports loadDone` —
  after `load()` + a macrotask, slot 0 has exactly one `load` and slots 1–3 have zero;
  after acking slot 0's `loadDone`, every slot has exactly one; the load then completes
  and `isLoaded()` is true. Covers acceptance criteria 1 and 7.
- `load() rejects fail-fast when the downloading slot 0 reports loadError` — pins
  criterion 4 for the new critical slot, and asserts nothing was fanned out.

### RED first (verified)

The staged test was written and run before any source edit:

```
AssertionError: expected [ 1, 1, 1, 1 ] to deeply equal [ 1, 0, 0, 0 ]
 ❯ src/components/accessibility/lib/tts-engine.test.ts:292:26
Tests  1 failed | 61 skipped (62)
```

The failure is exactly the diagnosed defect (all four slots posted `load` synchronously),
not a typo or a missing symbol. After the source change the same test passed with no test
edit.

## Amended tests (founder-approved; rewritten, not deleted)

| Test | Was | Now |
| --- | --- | --- |
| `load() spawns WORKER_POOL_SIZE workers and posts a load message to every one` | asserted all four slots got `load` immediately — the exact assertion this fix inverts | `…and starts the download on slot 0 alone`: pool width plus `loadCounts() === [1,0,0,0]`, then completes the load |
| `load() forwards loadProgress events from slot 0 only` (`:314`/`:330`) | comment said the other slots "hit the IndexedDB cache"; the loop read slots 1–3's `load` requestIds, which no longer exist at that point | comment corrected to the Cache API and to the real ordering; slot 0's `loadDone` is acked first so slots 1–3 genuinely have in-flight loads whose progress is then proven suppressed |
| `load() rejects fail-fast on the first loadError from any worker` | errored slot 1 before slot 1 had a `load` — unreachable state under staging | split in two: slot 0 (the downloading slot) fails fast, and a fanned-out slot fails fast after slot 0's `loadDone` |
| `load() concurrent calls share the same in-flight promise (still one pool spawned)` | asserted one `load` per worker | asserts `[1,0,0,0]`: the second call attaches instead of kicking off a second download |

The two shape helpers (`loadCounts()`, `perSlot(first, rest)`) keep those assertions
readable and pool-size-agnostic.

## Preserved exactly (verified by unmodified passing tests)

- `load()` still resolves only when **all four** slots report `loadDone` **and**
  `warmupDone` — `load() resolves only after every worker reports both loadDone and
  warmupDone` passes untouched. Option B (resolve on slot 0) was not adopted.
- `dispatchPending`, `speak`, `isLoaded`, `preloadVoice`, `stop`, `unlockAudio`,
  `scheduleAudio` and the `onLoadError` fail-fast teardown: zero source lines changed
  (see `git diff`), and all their tests pass unmodified.
- `WORKER_POOL_SIZE` stays 4.

## Self-gate

| Command | Result |
| --- | --- |
| `npx vitest run …/tts-engine.test.ts` | pass — 63/63 |
| `pnpm test:ui` | 1857 passed, **3 failed** — all three in `document-reader.test.ts` (`concurrent synthesis`), owned by concurrently-running B3. Not attributable here: that file `vi.mock`s `./tts-engine` wholesale (only the real `WORKER_POOL_SIZE` constant is imported, and it is unchanged), so no engine code executes in it. Its `document-reader.ts` is untracked and mid-edit. |
| per-file coverage, `tts-engine.ts` | 99.33% stmts · 100% branch · 100% funcs · 99.26% lines (gate 95). Uncovered 405–406 is a pre-existing `scheduleAudio` catch in `speak()`, untouched. |
| `npx eslint tts-engine.ts tts-engine.test.ts` (from `packages/ui`, after final edit) | exit 0 |
| `turbo typecheck --filter=@hushbox/ui --force` | pass |
| `turbo lint --filter=@hushbox/ui --force` | 8 errors, **none in owned files** — `document-reader.ts`/`.test.ts` (4+2, B3), `tts.worker.test.ts` (1, B2), `zz-scratch.test.ts` (5, a scratch file not mine). |
| `jscpd --threshold 2` on owned files | 0 clones |
| `apps/web` chat TTS: `chat-tts-stream`, `tts-dom-observer`, `prewarm-tts` | pass — 3 files, 41 tests, all unmodified |

An earlier `pnpm test:ui` invocation aborted with the known Vitest
`coverage/.tmp/coverage-N.json` ENOENT crash; re-running after clearing `coverage/.tmp`
produced the result above. Unrelated to this change (recorded previously as an unconfirmed
upstream Vitest bug).

## Acceptance criteria

1. **`load()` posts `load` to slot 0 only; slots 1–3 only after slot 0's `loadDone`** —
   met. Source diff above; pinned by the new staged test.
2. **`load()` still resolves only on all four `loadDone` + `warmupDone`** — met. No change
   to `onWarmupSettled`/`resolveLoad`; its test passes unmodified.
3. **`dispatchPending`/`speak`/`isLoaded` semantics unchanged** — met. No source lines
   touched; the full speak/dispatch/stop suite passes unmodified.
4. **Slot 0 load failure still fails the whole `load()`** — met. `onLoadError` is
   unchanged; new test pins slot 0, amended test pins a fanned-out slot. Worker `error` /
   `messageerror` teardown tests pass unmodified.
5. **Comment at 568–570 corrected** — met. Now names the Cache API and states the ordering
   the staged fan-out establishes.
6. **Amended tests** — met, see table (four tests, all rewritten to pin correct behavior).
7. **New test, RED first** — met, failure output above.

## Deviations

- The brief named three tests to amend; a fourth (`load() concurrent calls share the same
  in-flight promise`) also asserted one `load` per worker and had to be rewritten, and the
  fail-fast test was split into two so the slot-0 case is pinned directly. Both are the
  same class of change the founder approved — rewritten to pin correct behavior, nothing
  weakened or deleted.

## Concerns and limitations

- **Warm-path serialization** (already recorded in the research doc as option A's cost):
  when the model is already cached, slots 1–3 now start their cache reads only after slot
  0 finishes, roughly doubling the warm load wall time (seconds, not minutes). Not
  observable in tests; acceptable per the founder's ruling.
- **Resident memory is unchanged** — four workers still hold four model instances after
  load. Only the transient 4× download/buffer spike is removed. The resident half remains
  option C's territory (pool size stays 4 per founder ruling).
- `document-reader.test.ts` failures and the eight package lint errors belong to
  concurrent tasks; I did not touch those files.

## Confidence

**High** — the change is six lines of dispatch reordering behind a pre-existing
duplicate-`loadDone` guard, the new behavior was proven RED then GREEN, and every other
engine contract is pinned by tests that passed unmodified.
