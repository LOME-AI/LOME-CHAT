# P1 — fix pass 2: pin `start()` no-ops while paused

## Objective

Close the one validated audit finding: the `start()`-is-a-no-op-while-`paused` behavior
(`document-reader.ts:28` — `'paused'` in `ACTIVE_STATES`; consumed at `:323`) was unprotected.
Set membership is not a coverage branch, so the file reported 100% with the behavior free to be
deleted silently. Add a test assertion that fails when it is.

## Files changed

- `packages/ui/src/components/accessibility/lib/document-reader.test.ts` — three assertions added
  inside the existing `starts again at the first chunk after a stop() from paused` test.

No production file was changed. `document-reader.ts` was mutated temporarily to prove the pin has
teeth and restored from a byte-for-byte backup (md5 `f09bcb00f3d1905f14f01ea985e29ac1` before and
after; verified against the backup copy). No other test file was touched.

## The added assertion

Placed while still paused, before the existing `stop()`:

```ts
    // A paused read is still a read in progress, so start() must do nothing:
    // were it to act, it would be a second resume path that re-unlocks audio and
    // re-emits 'loading' before landing on the preserved cursor.
    const spokenWhilePaused = fake.spoken.length;
    const unlocksWhilePaused = fake.unlockCalls;
    void reader.start();
    await flush();
    expect(fake.spoken).toHaveLength(spokenWhilePaused);
    expect(fake.unlockCalls).toBe(unlocksWhilePaused);
    expect(states.at(-1)).toBe('paused');
```

The three assertions cover the three observable effects a live `start()` would have: it issues
speaks from the preserved cursor, it calls `unlockAudio()` again, and it emits `'loading'` (which
`states.at(-1) === 'paused'` rejects, since `'loading'` would be the newer entry). `void` rather
than `await` deliberately: under the mutant the returned promise never settles until the read is
released, so awaiting it would surface as a 30 s timeout instead of a readable assertion failure.

The existing `stop()` → `start()` flow below it is unchanged and still asserts the restart lands on
chunk 0.

## Mutation proof (red before green)

Order was mutate → assert → observe RED → revert → observe GREEN, so the assertion was watched
failing before it was trusted.

Mutation: `document-reader.ts:28`, `'paused'` removed from `ACTIVE_STATES`
(`new Set(['loading', 'speaking'])`).

Observed failure, `pnpm exec vitest run src/components/accessibility/lib/document-reader.test.ts
-t 'starts again at the first chunk'`:

```
 FAIL  |ui| src/components/accessibility/lib/document-reader.test.ts > createDocumentReader — concurrent synthesis > starts again at the first chunk after a stop() from paused
AssertionError: expected [ { …(2) }, { …(2) }, { …(2) }, …(6) ] to have a length of 5 but got 9

- Expected
+ Received

- 5
+ 9

 ❯ src/components/accessibility/lib/document-reader.test.ts:904:25
    902|     void reader.start();
    903|     await flush();
    904|     expect(fake.spoken).toHaveLength(spokenWhilePaused);
       |                         ^
```

5 → 9 is exactly the predicted damage: a full `WORKER_POOL_SIZE` window re-issued from the
preserved cursor by a second, load-emitting resume path.

After restoring the file: 36/36 pass in that file.

(Note: `vitest -t` treats the pattern as a regex, so `stop()` in the test name must not be pasted
literally into the filter — `()` matches an empty group and selects nothing.)

## Self-gate

| Command (from `packages/ui`) | Result |
| --- | --- |
| `pnpm exec vitest run --coverage --coverage.reportsDirectory=<scratchpad>` | pass — 94 files, 1892 tests, 0 failures, no per-file shortfall |
| `pnpm exec vitest run src/components/accessibility/lib/document-reader.test.ts` | pass — 36 tests |
| `pnpm exec eslint src/components/accessibility/lib/document-reader.test.ts` (after the last edit) | exit 0 |

Per-file coverage for `document-reader.ts`, read out of `coverage-final.json` rather than the
summary table: statements 118/118, branches 32/32, functions 24/24, lines 100% — unchanged from
pass 1, as expected (the fix protects a behavior coverage cannot see).

Test count moved 1879 → 1892 across the package. My change adds no test (assertions only, +0);
the delta is the concurrent `blog-reader` work.

## Acceptance criteria

- **Finding closed** — met. The behavior now has a test that fails when `'paused'` leaves
  `ACTIVE_STATES`, with the failure observed and recorded above.
- **No production change** — met. md5 identical pre/post; `git status` shows `document-reader.ts`
  still untracked-unmodified relative to my pass-1 content.
- **No other test changed** — met. Only the one file, only the one test body.

## Deviations

None. The assertion shape is the audit's suggested shape, placed where the audit specified.

## Concerns and limitations

- The host test now asserts two related things (start() inert while paused; restart from chunk 0
  after stop()). This is the audit's prescribed shape and the two share one setup — the paused read
  with a live cursor — but it is a mild stretch of one-behavior-per-test. Splitting it would
  duplicate ~15 lines of pause setup; I followed the brief rather than making that call myself.
- The mutation was applied to the real file rather than a copy because the module under test is
  imported by path; the backup + md5 check is the safety net, and it verified clean.

## Cross-task observation (not mine)

The coverage table shows `blog-reader/blog-read-aloud.tsx` at 97.91% statements / 95.55% branches
with lines 408–409 uncovered. That file is owned by the concurrent P2 task; it is above the 95
per-file floor so the run is green, but flagging it since it is the only sub-100 file in the
blog-TTS surface.

## Confidence

High — the pin was watched RED for the exact predicted reason, the production file is provably
byte-identical, the whole `@hushbox/ui` suite is green, and lint on the one edited file is exit 0
after the final edit.
