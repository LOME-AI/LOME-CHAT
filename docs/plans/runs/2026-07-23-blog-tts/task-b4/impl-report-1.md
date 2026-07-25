# B4 — impl report 1

## Objective

Fix founder-reported issues 6 and 7 in `blog-read-aloud.tsx`: (A) toggling the highlight OFF
then ON does not re-highlight until the next sentence; (B) the download bar flashes on a
cached model.

## Files changed

- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` — retains the spoken chunk so
  the highlight toggle can repaint symmetrically (A); gates the download bar behind a dwell
  timer + an incompleteness check (B).
- `packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` — 7 new tests, 3 amended.

No other file touched. `document-reader.ts` (B3) and the build configs (B6) were not opened
for edit.

## Fix A — highlight repaint

- New `lastChunkRef` (`DocumentReaderChunk | null`), assigned in `wireReader`'s `onChunk`
  handler inside the existing `live()` run guard, so a stale run cannot write it.
- The toggle effect became symmetric: with a retained chunk it delegates to the existing
  `paintChunk`, which already picks highlight-vs-clear from `highlightOnRef` (assigned on the
  line above); with no retained chunk it clears.
- `paintChunk`'s first parameter was narrowed from the full `RunContext` to a new
  `HighlightHandles` interface (`highlightOnRef` + `highlighterRef`), which `RunContext` now
  extends. This is what lets the effect call it without fabricating a `voice`/`audioCtx`.
  Structural typing means the existing `paintChunk(ctx, chunk)` call site is unchanged.
- **The nulling** (load-bearing per the research doc): `lastChunkRef.current = null` in
  `handleStop` and in `applyReaderState`'s `error` and `idle`/`stopped` branches.

No nulling was added to `handleStart`: every path back to a state where the Listen button
renders already passes through one of those four sites, so a run can never begin with a stale
chunk. (Verified by enumerating the `status` transitions: `idle` is only reached from
`handleStop` or the idle/stopped branch; `error` nulls in its own branch.)

## Fix B — cached-model flash

Constant, with the comment the criteria require:

```ts
/**
 * How long the load must run before the download bar is worth showing.
 * A heuristic is unavoidable: transformers.js exposes no cache-hit signal, and
 * a cached read replays byte-identical progress events, so nothing in the data
 * distinguishes "downloading 90 MB" from "reading it back out of the cache".
 * Elapsed time is the only discriminator. The failure mode is deliberately
 * one-sided: a real download's bar appears this late (harmless), while a cached
 * load, which completes well inside the window, never flashes one.
 */
const DOWNLOAD_BAR_DWELL_MS = 900;
```

Gate: `showDownloadBar = status === 'loading' && dwellElapsed && percent < 100`, passed into
`ReaderStatusSlot` as a new prop (the slot's `status === 'error'` branch is unchanged, so the
error line still wins the slot when the bar is gated off).

`dwellElapsed` is a `useState` driven by a `useEffect` keyed on `status`: the effect resets the
flag to `false` on **every** status change and only arms a `setTimeout` while `status ===
'loading'`, returning a cleanup that clears it.

**Error-path behavior (no hang).** The brief's warning is that the error path emits neither
100% nor `loadDone`. The gate does not wait for either: it is a conjunction whose first term is
`status === 'loading'`. When the reader reports `error`, `applyReaderState` sets `status` to
`'error'`, which (i) makes the first term false, (ii) re-runs the effect, which resets
`dwellElapsed` to `false` and clears any pending timer, and (iii) renders the error line in the
slot. Nothing is left waiting on a completion that stopped coming. Pinned by the test
"replaces the download bar with the error line when the load fails short of 100%", and that
test was mutation-validated (below) rather than trusted as a green-today assertion.

`percent < 100` (rather than `<= 99` or a rate check) is the right incompleteness gate given
B2's verified contract: in-flight progress tops out near 99.4% and only the single pre-`loadDone`
message carries 100, so the bar unmounts exactly once the download is genuinely finished, and a
fully cached load still delivers that message.

## Tests added

| test | behavior | criterion |
| --- | --- | --- |
| repaints the current chunk when highlighting is toggled back on mid-read | toggle ON repaints the spoken chunk's exact coordinates | (1), repro 1 |
| does not repaint a finished read when highlighting is toggled back on | the retained chunk is nulled at end-of-read | (2), repro 2 |
| does not show the download bar immediately on first click | no bar before the dwell | (3) |
| shows the download bar once the load outlasts the cache-hit dwell | a real download still gets its bar | (3), (5) |
| never shows the download bar for a cached load that completes before the dwell | cached load shows no bar at all | (4) |
| unmounts the download bar at 100% without waiting for speaking | unmount at 100 while still `loading` | (3) |
| replaces the download bar with the error line when the load fails short of 100% | error path does not hang the gate | (3) |

### RED-first evidence

- **"repaints the current chunk…"** — run before any production edit:
  `AssertionError: expected "vi.fn()" to be called with arguments: [...] Number of calls: 0`.
  Exactly the diagnosed cause (no ON path, so nothing can paint).
- **"does not repaint a finished read…"** — this one **cannot be RED first**, and the brief
  anticipates that: today nothing ever repaints, so it passes vacuously; it is the guard
  against the regression the fix itself could introduce. Validated by mutation instead —
  with `lastChunkRef.current = null` removed from the `idle`/`stopped` branch it fails with
  `Number of calls: 1`; restored, it passes.
- **"does not show the download bar immediately on first click"**, **"never shows … for a
  cached load"**, **"unmounts … at 100%"** — all three RED before the production edit
  (`Tests 3 failed | 2 passed`); the 100% one showed the received DOM still containing the
  full `role="status"` bar.
- The two B tests that were green today were mutation-validated, not rubber-stamped:
  - inflating `DOWNLOAD_BAR_DWELL_MS` to `60_000` fails "shows the download bar once the load
    outlasts the cache-hit dwell" (plus 3 others) — proving it really depends on the dwell;
  - dropping `status === 'loading'` from the gate **and** the `setDwellElapsed(false)` reset
    fails "replaces the download bar with the error line…" — proving that test really pins the
    no-hang property.
  Both mutations were reverted and the suite re-verified green.

## Amended tests

1. **`blog-read-aloud.test.tsx` "shows the download bar and Stop control immediately on first
   click"** — split as the brief directs: renamed to "shows the Stop control immediately on
   first click", keeping the `stopButton()` assertion and dropping only the
   `getByRole('status')` bar assertion. The test still runs the full click path; nothing was
   gutted, weakened, or deleted.
2. **"keeps the download bar visible when the reader reports loading"** and **"forwards
   download progress to the bar"** — these were not in the brief's amendment list, but both
   assert the bar is on screen, which is exactly the display condition B changed. Each was
   converted to fake timers and advanced past the dwell; both still assert the same thing
   (bar present / "42%" rendered). See Deviations.

## Self-gate

| command | result |
| --- | --- |
| `pnpm exec vitest run src/components/blog-reader/blog-read-aloud.test.tsx` (from `packages/ui`) | pass — 36 passed |
| `pnpm exec vitest run --coverage --coverage.reportsDirectory=<scratchpad>` (from `packages/ui`) | pass — 1868 passed, coverage thresholds met |
| `npx turbo typecheck lint --filter=@hushbox/ui --force` | pass — 2 successful |
| `pnpm exec eslint <both owned files>` after the final edit, from `packages/ui` | pass — exit 0 |
| `npx jscpd --threshold 2 <both owned files>` | pass — 0 clones, 0% duplicated |

Per-file coverage for `blog-read-aloud.tsx`, computed from `coverage-final.json`:
**statements 100.00 / branches 100.00 / functions 100.00** (the file does not appear in the
uncovered-lines table). Package totals: 99.85 stmts / 99.25 branches / 100 funcs / 99.91 lines.

Two notes on the gate runs:

- The first coverage run died with
  `ENOENT: ... /cov/.tmp/coverage-11.json` before printing any results. This is the known
  upstream Vitest coverage crash already recorded for this repo (the heap-flag investigation
  concluded it is an unconfirmed upstream bug with no fix); it is unrelated to this change —
  the identical command succeeded on retry with the same working tree.
- Lint initially failed on my own new names: `unicorn/prevent-abbreviations` rejected
  `HighlightRefs` / `refs`. Renamed to `HighlightHandles` / `handles`, re-ran the file suite
  (36 passed) and the package typecheck+lint (both clean). No rule was disabled.

## Acceptance criteria

1. **Toggling ON mid-read immediately repaints the current chunk** — met. Test "repaints the
   current chunk when highlighting is toggled back on mid-read", RED first at 0 calls.
2. **Retained chunk nulled on stop/idle/error** — met. Nulled at all four sites
   (`handleStop`, `error`, `idle`, `stopped`); test "does not repaint a finished read…",
   mutation-validated.
3. **Bar shown only after ≥T ms in `loading` AND aggregate percent < 100; T a named constant
   with a comment stating why the heuristic is unavoidable; unmounts at 100 rather than
   waiting for `speaking`** — met. `DOWNLOAD_BAR_DWELL_MS = 900` (inside the 800–1000 band)
   with the comment quoted above; three tests cover the delay, the 100% unmount (asserting the
   Stop control is still present, i.e. still `loading`, so the unmount is not `speaking`
   doing the work), and the error path.
4. **A cached load shows no bar at all** — met. Test "never shows the download bar for a
   cached load that completes before the dwell": progress reaches 100 at 200 ms, then time is
   advanced past the dwell and the bar never appears.
5. **A real download still shows its bar** — met. Test "shows the download bar once the load
   outlasts the cache-hit dwell", mutation-validated against an inflated dwell.
6. **`blog-read-aloud.test.tsx:226-234` split** — met, as described under Amended tests.
7. **Both repro specs from the research doc, RED first** — met for repro 1; repro 2 is the
   companion guard that cannot be RED first (see RED-first evidence) and was mutation-validated
   instead.

## Deviations

- **Two extra test amendments beyond the one the brief named.** "keeps the download bar visible
  when the reader reports loading" and "forwards download progress to the bar" both assert bar
  presence and necessarily broke when the display condition changed. I adapted them (fake
  timers + advance past the dwell) rather than deleting or weakening them; each still pins the
  same behavior it always pinned. Flagging because the founder's amendment approval named a
  specific set.
- **`paintChunk`'s parameter type narrowed** from `RunContext` to the new `HighlightHandles`
  supertype. Not strictly required by the criteria, but the toggle effect has no `voice` or
  `audioCtx` to supply; the alternative was constructing a fake `RunContext` in the effect. No
  call site changed.
- **Fake-timer harness.** Testing Library's `waitFor` polls on timers, so the existing
  `startReading` helper cannot run under fake timers. Added a sibling
  `startReadingWithFakeTimers` that clicks via `fireEvent` and drains the click's dynamic
  import with `await act(async () => { await vi.advanceTimersByTimeAsync(0) })`. `vi.useRealTimers()`
  was added to the file's existing `afterEach` so a failing fake-timer test cannot leak into
  the next one. The brief's `vi.fn` unhandled-rejection trap does not apply — no test in this
  file asserts on a promise's rejection settling.

## Concerns and limitations

- `DOWNLOAD_BAR_DWELL_MS = 900` is a heuristic by construction (the research doc's B1 rejected
  every non-heuristic alternative). On a very slow device a *cached* load could exceed 900 ms
  of `loading` and briefly show a bar — but it would show a real, moving bar, not a flash, so
  the failure mode stays the benign one.
- The dwell is measured over the whole `loading` phase, which includes ORT/WASM init and worker
  spawn, not just the network fetch. That is intentional (it is the only signal available) but
  it means the 900 ms is not purely download time.
- Not verified in a real browser — the stack was not exercised for this task; both fixes are
  pinned only at the component/unit level, per the run's no-new-E2E ruling.
- B5 edits this file next for layout; the file is lint-clean and typecheck-clean as left.

## Confidence

**High** for fix A: the root cause was verified in the research doc, the repro was RED for
exactly the diagnosed reason, and the load-bearing nulling is mutation-proven.

**Medium-high** for fix B: the logic and its no-hang property are proven by tests and
mutation, but the *value* 900 ms is a judgment call inside the sanctioned band, and the
cached-vs-real discrimination it rests on can only be validated on a real browser with a real
cache.
