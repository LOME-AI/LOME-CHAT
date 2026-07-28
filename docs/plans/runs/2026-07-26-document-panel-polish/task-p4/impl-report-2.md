# impl-report-2 — trial-eligibility numbers after the preamble correction

## Objective

Make `apps/api/src/slices/models/domain/trial-eligibility.test.ts` green again. The
preamble correction in `packages/shared/src/prompt/base-preamble.ts` lengthened the
composed system prompt; this file pinned the prompt's token count and a price
boundary derived from it, so two tests went red and were committed red in
`53daba72`.

## What I found before editing

`git status` at task start showed `apps/api/src/slices/models/domain/trial-eligibility.test.ts`
already modified in the working tree, mtime `2026-07-26 23:54:46` — six minutes before
this task began, and seventeen minutes after the concurrent-workstream edit to
`trial-eligibility.ts` (mtime `23:37:39`) that impl-report-1 flagged. The working-tree
version was already green (33/33).

I did not author that edit and cannot attribute it. It is either a killed prior attempt
at this task or a concurrent workstream. **Raised to the orchestrator.** Rather than
revert work I did not make (AGENT-RULES), I verified it independently, end to end,
against observed values — and then fixed the prompt-derived rot it left behind.

## Verification of the pre-existing working-tree fix

Reproduced the committed RED by restoring `HEAD`'s version of the file, running it, and
restoring the working-tree version byte-for-byte (md5 `339686b457b7c00ddfcbc9c291ae1458`
before and after; `git show` is read-only, no git write command was run):

```
× fails as shipped once input is ~32.5× output — a pre-existing gap, not a new one
  AssertionError: expected 3370800 to be greater than 3581780
× measures the escape for a far-inverted shape by amount
  AssertionError: expected 3380000n to be 3120000n
```

Both failures resolve to one quantity — the system prompt's trial input tokens:

- Second failure is closed-form: the pin computes `805n * 4000n − 1000n * 100n =
  3,120,000`; the observed value `3,380,000` gives `(3,380,000 + 100,000) / 4000 = **870**`.
- First failure is consistent with the same 870: floor `3,581,780 = 1070 × 3254 + 100,000`
  (1070 = `ceil((1739 + 400) / 2)`), gate `3,370,800 = 200 × 3254 + 200,000 + 2,520,000`.
  Their difference is `2,620,000 − 870 × input`, which turns negative at input
  `2,620,000 / 870 = 3011.49` — boundary **3011 inside / 3012 outside**, down from
  3254/3255.

Independently measured from the shipped modules (not hand arithmetic) via a throwaway
`tsx` evaluation of `buildTurnSystemPrompt` + `estimateTokensForTier`:

```json
{"chars":1739,"sysTokens":870,"storage":"2520000","boundary":"3011","ratio":30.11,"noStorageBoundary":"114"}
```

Every figure the brief warned might be stale is in fact current: 870 tokens, 3011/3012,
30.11×, 1739 chars.

**The working-tree fix is correct and not vacuously green.** It replaces the two
literals with values derived at runtime from the same shipped constants, and the
boundary test is a two-sided crossover pin: `inside = boundary` must exceed the floor
and `outside = boundary + 1` must fall under it. A derived boundary that was off by one
in either direction would fail one of the two assertions. The derivation is a closed
form (`(1000 × output + storage) / unpricedInputTokens`) and is independent of
`callBillableNanoUsd`, the code under test, so it is a prediction the implementation must
meet — not a restatement of it.

## Files changed

- `apps/api/src/slices/models/domain/trial-eligibility.test.ts` — two comment-only edits
  removing prompt-derived numbers that were still stale after the working-tree fix. No
  assertion, literal, or test name changed by me.

## Constants: observed old → new

Restating every prompt-derived constant in the file, whether it was moved by the
pre-existing working-tree edit or by me.

| Constant | Old | New | What it encodes | Why the new value is right, not merely green |
| --- | --- | --- | --- | --- |
| unpriced system-prompt tokens (`805n * 4000n`, line ~388) | `805n` literal | derived: `estimateTokensForTier('trial', SYSTEM_PROMPT_CHARS + PROMPT.length) − estimateTokensForTier('trial', PROMPT.length)` = **870** | The input leg the compiled turn prices and the per-message gate does not — a mechanical consequence of prompt length (`ceil(1739/2)`), no product content. | Read off the failure (`3,380,000 = 870 × 4000 − 100,000`) and confirmed against a live measurement of the shipped preamble. Now derived, so the next preamble edit moves it instead of reddening a copy. |
| crossover input rate (`pricing(3254n, 100n)` / `3255n`) | `3254n` / `3255n` | derived: `(1000n * output + storage) / unpricedInputTokens` = **3011** / **3012** | Where the gate's finite surplus (1,000 extra output tokens + pass-through storage = 2,620,000 nano at output 100) is exhausted by the unpriced input leg. Mechanical: `2,620,000 / 870`. | The surplus term (2,620,000) is unchanged — it does not involve the system prompt. Only the divisor moved, 805 → 870. Verified as a two-sided crossover by the green run. |
| docstring prompt size (line ~289) | `1,609 characters, 805 trial input tokens` | removed; the comment now points at the live `SYSTEM_PROMPT_CHARS` | Reader orientation only; nothing depends on it. | It was wrong (actual 1,739 / 870) and no test guards a comment, so it rots silently — the exact failure mode this task exists to clean up. Deleting the literal is rot-proof; the value stays visible one line down where it is measured. |
| storage-free boundary prose (line ~374) | `from ~32× output to ~1.25×` | `from the ~30× output measured above to ~1.15×` | The magnitude gap between the shipped gate and the storage-stripped gate — the reason §Trial Usage's strip is not applied here. | Both figures are prompt-length consequences: `3011/100 = 30.1×` and `114/100 = 1.14×` (storage-free boundary `1000 × 100 / 870 = 114`), both measured live. The qualitative claim (order-of-magnitude gap) is unchanged. |

## Tests added

None. This task restores two existing tests; no new behavior exists to test. TDD's RED
step was satisfied by reproducing the committed failure from `HEAD` and reading the
expected/received values out of it (transcript above) before accepting any number.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch apps/api/src/slices/models/domain/trial-eligibility.test.ts` (after last edit) | pass — 33/33 |
| `pnpm test:watch apps/api/src/slices/models/` | pass — 806 passed, 1 skipped, 42 files |
| `pnpm test:watch apps/api/src/slices/chat/routes.integration.test.ts` | pass — 188/188 |
| `npx eslint src/slices/models/domain/trial-eligibility.test.ts` from `apps/api`, after last edit | exit 0 |
| `pnpm test:api` | ran to completion — 6334 passed, 7 failed, 2 skipped (6343); 463 files passed, 4 failed, 1 skipped. **This file: passed, 33/33, 0 failed.** All 4 failing files attributed elsewhere — see below |

The full run did **not** hit the previous attempt's `coverage/.tmp` collision; it
completed in 6m27s. Per-file results read from the run's own JSON report
(`/tmp/hb-test-weights-4018869-1785125430108.json`), not from scrollback.

**All four failing files are outside this task's ownership and none can be caused by a
comment-only edit:**

| File | Failed assertions | Cause |
| --- | --- | --- |
| `src/lib/jobs/lifecycle.integration.test.ts` | 0 | `Cannot find module …/node_modules/.vite/vitest/<hash>/deps_ssr/@hushbox_db.js` — Vite dep-optimizer cache rewritten mid-run |
| `src/slices/chat/domain/turn-reasoning.test.ts` | 0 | same, `deps_ssr/@hushbox_shared.js` |
| `src/slices/admin/domain/operations/job.integration.test.ts` | 0 | same, `deps_ssr/@hushbox_crypto.js` |
| `src/slices/notifications/domain/templates/template-html.test.ts` | 7 | snapshot mismatches in a suite named *"template html is byte-stable across the builder-helper refactor"* — another workstream's in-flight email-template refactor |

The first three are not test failures at all: zero assertions ran, the file failed at
import. Between 13 and 64 concurrent `vitest` processes from other workstreams were
running in this checkout throughout the task (`ps aux | grep -c "[v]itest"`), sharing
`apps/api/node_modules/.vite`; one of them re-optimizing deps deletes the `deps_ssr`
bundle another run is mid-import of. The fourth is a snapshot suite whose own name
names the refactor that moved it. **Raised to the orchestrator** — none is mine to fix,
and the concurrency that produces the first three will keep doing so while parallel
runs share this checkout.

Scoped runs use `test:watch`, which is coverage-free and therefore immune to the
`coverage/.tmp` collision that aborted the previous attempt.

## Acceptance criteria

1. **The two committed-red tests pass** — met. 33/33, twice, the second run after the
   final edit.
2. **Every changed number re-derived from observation, not from the brief** — met. RED
   reproduced from `HEAD`; expected/received read from the failure; cross-checked against
   a live measurement of the shipped preamble. The brief's figures turned out correct,
   but nothing was taken on trust.
3. **No deliberate boundary quietly retuned** — met, with one item raised below. The
   3254/3255 pin was mechanical (`2,620,000 / 805`), not a product decision; the surplus
   term it divides is untouched.
4. **No other prompt-size pin left stale** — met. `buildTurnSystemPrompt` / `1,609` /
   `805n` / `3254n` / `3255n` grep across `apps` + `packages` returns only: this file,
   `language-adapter.*` (hash pin already updated in impl-report-1, verified passing in
   the 806-test models run), `chat/routes.*` (188/188 pass), `use-prompt-budget.*` and
   the `packages/shared/src/prompt/*` files (all derive live; verified pass in
   impl-report-1). `packages/shared/dist/**` is build output.
5. **Lint clean after the last edit, from the package directory** — met, exit 0.

## Deviations

- **I changed comments, not the numbers the brief named.** The literals the brief
  expected me to retune (`805n` → `870n`, `3254n` → `3011n`) were already gone from the
  working tree when I started, replaced by runtime derivation. Re-pinning them as
  literals would reintroduce exactly the rot that produced this task. I verified the
  derivation instead and fixed the two comments the earlier edit left stale.
- **The docstring's prompt size was deleted rather than corrected to 1,739 / 870.**
  Updating it would have been the smaller diff, but it re-arms a silent rot: no test
  guards a comment, so the next preamble edit makes it wrong again with nothing to catch
  it. The load-bearing fact (the gate does not price the system prompt while the turn
  does) is preserved; only the rot-prone figure is gone, and it is measured three lines
  below.

## Concerns and limitations

- **`expect(boundary).toBeGreaterThan(20n * output)` (line ~369) is an unexplained
  threshold I did not author and did not touch.** It arrived with the pre-existing
  working-tree edit. It is the only surviving guard on the claim the old test name made
  numerically ("~32.5×", now 30.11×): a band assertion saying the shipped gate tolerates
  a deeply inverted shape. `20` is not derived from anything — it is a floor someone
  chose. It is a legitimate loose guard, but a reviewer should rule on whether the band
  deserves a tighter or better-explained pin. Flagged rather than retuned, per the brief.
- **The storage-free test's `125n` witness is no longer the exact crossover.** With 805
  tokens the storage-free boundary was 124/125, so `125n` sat exactly one past it and was
  a boundary pin. At 870 tokens the boundary is 114/115, so `125n` is now a witness above
  the boundary rather than on it. The test still demonstrates its point (the shipped gate
  refuses the shape, the stripped gate admits it) and passes for the right reason, but it
  measures loosely where it once measured exactly. I left the literal alone — moving it
  is a test-design decision, not a rot fix, and the file is contended. Worth a follow-up
  to derive it like its sibling.
- **The whole file is contended.** `trial-eligibility.ts` was edited at 23:37 and
  `trial-eligibility.test.ts` at 23:54 by parties I cannot identify. If either moves
  again, re-verify rather than assume.
- **`packages/shared/src/affordability/**` is red from another workstream** (lint, per
  the brief). Not touched, not investigated.
- **Parallel vitest runs in one checkout corrupt each other's Vite dep cache.** Three of
  the four full-run failures are `Cannot find module …/.vite/vitest/<hash>/deps_ssr/*.js`
  with zero assertions executed. This is a run-level hazard for every task in this run,
  not a property of any test — a full-suite gate here will keep producing spurious reds
  while other workstreams run concurrently.

## Confidence

**High.** Every number was read out of an observed failure and independently confirmed
against a live measurement of the shipped preamble; the two figures agree to the unit.
The residual risk is not correctness but ownership: the behavioral fix in this file was
authored by a party I could not identify, and my contribution is its verification plus
two comment corrections.
