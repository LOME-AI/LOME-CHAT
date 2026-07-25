# B4 — impl report 2 (fix pass)

## Objective

Fix the one validated audit finding: `blog-read-aloud.test.tsx` "hides the download bar
once speaking begins" passed vacuously — it ran under real timers, so `dwellElapsed` was
never set, the bar was never on screen, and the `queryByRole('status')` null assertion
pinned nothing about the show→hide transition its name claims.

No production change. `blog-read-aloud.tsx` is byte-identical to its pre-fix state
(verified with `diff` against a pre-edit copy after each mutation was reverted).

## Files changed

- `packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` — one test rewritten
  to fake timers so the bar is genuinely present before the hide is asserted.

## The rewritten test

```tsx
it('hides the download bar once speaking begins', async () => {
  vi.useFakeTimers();
  render(<BlogReadAloud />);
  await startReadingWithFakeTimers();
  // The bar must genuinely be on screen first, or the assertion below would
  // hold for a bar that was never rendered at all.
  act(() => {
    vi.advanceTimersByTime(PAST_DWELL_MS);
    readerOptions().onDownloadProgress({ pct: 40 });
  });
  expect(screen.getByRole('status')).toBeInTheDocument();

  act(() => {
    readerOptions().onState('speaking');
  });

  expect(screen.queryByRole('status')).toBeNull();
  expect(stopButton()).toBeInTheDocument();
});
```

Same treatment as its two siblings ("unmounts the download bar at 100%…", "replaces the
download bar with the error line…"): fake timers, advance past the dwell, a real progress
event at `pct: 40`, assert presence, then drive the transition and assert absence. It
reuses the file's existing `startReadingWithFakeTimers` / `PAST_DWELL_MS` helpers — no new
harness.

## Mutation proof

Finding the right mutation took three attempts, and the first two are themselves
load-bearing evidence about what the test does and does not pin.

**Mutation 1 — drop the `status === 'loading'` conjunct** (the mutation the audit
suggested): `showDownloadBar = dwellElapsed && percent < 100`.

Result: **36 passed** — the rewritten test still passes.

This is not a weakness in the test; it is a fact about the component. Hide-on-`speaking`
has *two* independent mechanisms, and mutation 1 removes only one:

1. the `status === 'loading'` conjunct in `showDownloadBar`, and
2. the dwell effect, whose body starts `setDwellElapsed(false)` and therefore drops the
   flag on **every** status change, `speaking` included.

With either one intact the bar still disappears at `speaking`, so the observable behavior
is preserved and a behavior-level test correctly stays green. Recorded because a future
reader will otherwise try the same mutation and misread the green as vacuity.

**Mutation 2 — `(status === 'loading' || status === 'speaking') && percent < 100`.**

Result: the rewritten test **fails** as intended —

```
FAIL  src/components/blog-reader/blog-read-aloud.test.tsx > BlogReadAloud — reader lifecycle > hides the download bar once speaking begins
AssertionError: expected <div role="status" …(2)>…(2)</div> to be null
- Expected: null
+ Received: <div aria-label="Preparing the voice" class="flex w-full flex-col gap-1" role="status"> … 40 % …
```

But this mutation also drops the `dwellElapsed` conjunct, so `percent` (0) < 100 makes the
bar appear during `loading` under **real** timers too — and the **old** test body fails
under it as well (`Tests 2 failed | 34 passed`). So mutation 2 proves the new test is
sensitive but does **not** discriminate it from the old one.

**Mutation 3 — the clean discriminator.** Keep the dwell gate, remove only
hide-on-`speaking`, defeating both mechanisms at once:

```ts
// gate
const showDownloadBar =
  (status === 'loading' || status === 'speaking') && dwellElapsed && percent < 100;
// dwell effect — no longer resets the flag when entering `speaking`
if (status === 'idle' || status === 'error') setDwellElapsed(false);
```

| test body under mutation 3 | result |
| --- | --- |
| **old** (real timers) | **36 passed** — the regression sails through: vacuity proven |
| **new** (fake timers) | **1 failed** — `AssertionError: expected <div role="status" …(2)>…(2)</div> to be null`, received the full `role="status"` bar at 40% |

That is the exact property the audit asked for: a real hide-on-`speaking` regression the
old assertion could not see and the new one catches.

All three mutations were reverted; `diff` against the pre-edit copy confirms
`blog-read-aloud.tsx` is unchanged, and the file suite is back to 36 passed.

## Sweep for other vacuous bar-absence assertions

Six `queryByRole('status')).toBeNull()` assertions exist in the file (lines 143, 344, 441,
469, 486, 504). I checked each for the same defect — an absence assertion where the bar
could never have appeared — and mutation-tested the ones that were not already proven.

A single mutation, `showDownloadBar = status !== 'error' && (status !== 'loading' || dwellElapsed)`
(bar renders in idle, during speaking, and at 100%), killed four of them:

```
× renders the Listen control and no active-state chrome
× hides the download bar once speaking begins
× never shows the download bar for a cached load that completes before the dwell
× unmounts the download bar at 100% without waiting for speaking
Tests  4 failed | 32 passed (36)
```

| line | test | verdict |
| --- | --- | --- |
| 143 | renders the Listen control and no active-state chrome | **sensitive** (killed above). Not a transition claim — it pins idle chrome, and its meaning is unchanged by B4: the bar never rendered in `idle` before the change either |
| 344 | hides the download bar once speaking begins | **fixed** this pass; sensitive under mutations 2 and 3 |
| 441 | does not show the download bar immediately on first click | **sensitive** — killed by mutation 2 above (`× does not show the download bar immediately on first click`). Absence is the behavior under test, not an accident of the harness: it already runs under fake timers and deliberately does not advance |
| 469 | never shows the download bar for a cached load | **sensitive** (killed above) |
| 486 | unmounts the download bar at 100% | **sensitive**; also asserts presence before absence |
| 504 | replaces the download bar with the error line | **sensitive**; asserts presence before absence, and was mutation-validated in impl-report-1 |

No second vacuous test found. Lines 441 and 469 are the only other absence-only
assertions, and both are absence-*is*-the-behavior tests running under fake timers with the
gate deliberately unmet — the opposite of the defect.

## Self-gate

| command (from `packages/ui`) | result |
| --- | --- |
| `pnpm exec vitest run src/components/blog-reader/blog-read-aloud.test.tsx` | pass — 36 passed |
| `pnpm exec vitest run --coverage --coverage.reportsDirectory=<scratchpad>/cov` | pass — thresholds met, no shortfall |
| `pnpm exec vitest run` (whole package) | pass — 94 files, 1868 passed |
| `npx turbo typecheck lint --filter=@hushbox/ui` | pass — 2 successful, 2 total (cache miss, really executed) |
| `npx jscpd` on both owned files | pass — 0 clones, 0% duplicated |

The coverage run completed on the first attempt this pass; the known upstream Vitest
ENOENT crash did not reproduce.

Per-file coverage for `blog-read-aloud.tsx`, computed from `coverage-final.json`:
**statements 100.00 / branches 100.00 / functions 100.00** — unchanged from impl-report-1.
Package totals also unchanged: 99.85 stmts / 99.25 branches / 100 funcs / 99.91 lines.

## Acceptance criteria (this pass)

1. **The vacuous test now pins the show→hide transition** — met. Bar asserted present at
   `pct: 40` past the dwell, then absent after `onState('speaking')`.
2. **Mutation-sensitive** — met. Fails under mutations 2 and 3; mutation 3 is the clean
   discriminator (old body passes, new body fails).
3. **No other test in the file became vacuous the same way** — met. All six absence
   assertions checked; four killed by a shared mutation, the remaining two killed by
   mutation 2 and by impl-report-1's error-path mutation respectively.
4. **File left clean for B5** — met. Production file byte-identical; lint and typecheck
   green from the package directory after the last edit.

## Deviations

None. Bounds held: only the test file was edited; `document-reader.ts` (B3) and
`package.json`/`knip.jsonc` (B7) were not opened.

## Concerns and limitations

- The two-mechanism redundancy behind hide-on-`speaking` (the status conjunct **and** the
  dwell reset) is undocumented in the component. It is not a defect — the redundancy is
  incidental to what each mechanism is for — but it means single-conjunct mutation testing
  of `showDownloadBar` gives falsely reassuring greens. Recorded here rather than added as
  a code comment, since B5 edits this file next and the fact is about the test strategy,
  not the code's correctness.
- Everything remains pinned at component level only; no browser verification, per the run's
  no-new-E2E ruling.

## Confidence

**High.** The fix is one test rewritten to the pattern its own siblings already use, the
vacuity claim and its elimination are both demonstrated by a mutation that separates the
old body from the new one, and the whole-file sweep is mutation-backed rather than
asserted.
