# T7 impl-report-3 — FIX: classifier-reserve enclosure guard

## Objective (restated)
Fix the one validated finding: `classifierReserveNanoUsd` (estimate-run.ts) called the core
`reservationCeiling` DIRECTLY with the enclosure multipliers, bypassing the safe-integer
validation the sibling modelCall path applies via `ceilingInput` (estimate.ts:366).
`reservationCeiling` THROWS `RangeError` on a non-safe-integer multiplier, so an over-range
enclosure made the classifier-reserve path throw an uncaught defect (→ 500 + Sentry) instead
of returning the graceful `Result` `validationError` refusal the modelCall path returns for the
identical input. Fix: route the classifier enclosure multipliers through the same safe-integer
guard before calling `reservationCeiling`. Preserve all existing numbers.

## Files changed
- `apps/api/src/slices/models/domain/estimate-run.ts` — added `enclosureMultiplierError(...)`
  and called it in `classifierReserveNanoUsd` before `reservationCeiling`; on a non-safe
  multiplier it returns `err(validationError('Estimate ceiling <label> must be a positive
  integer'))` — the exact rule and message estimate.ts's `ceilingInput` uses.
- `apps/api/src/slices/models/domain/estimate-run.test.ts` — added the graceful-refusal test.

## The guard (mirrors the modelCall path exactly)
`ceilingInput` (estimate.ts:366-386) validates the ReservationCeilingInput multipliers with
`!Number.isSafeInteger(value) || value < 1` over `['maxFanOutWidth','maxSteps','maxIterations']`,
returning `validationError('Estimate ceiling <label> must be a positive integer')`. The new
`enclosureMultiplierError` applies the identical rule, labels, and message to the exact three
multipliers the classifier feeds `reservationCeiling`: `fanOutWidth = enclosure.fanOut`,
`maxSteps = 1` (structural — the classifier runs once per enclosing invocation), and
`maxIterations = enclosure.loop`. A durable-fact comment records the hidden coupling: the two
guards must stay in sync because both refuse identically for the identical input, and it names
the schema gap (workflow.ts bounds `maxWidth`/`maxIterations` at `.int().min(1)`, no upper bound).

## Correction to the finding's literal repro (RAISED)
The finding's literal example — `loop{maxIterations: 2**53}` as a SINGLE schema-valid node —
is NOT schema-valid under this repo's Zod v4: `z.number().int()` rejects unsafe integers
(verified: `z.number().int().min(1).safeParse(2**53).success === false`; workflow.ts:71,93 use
`z.number().int().min(1)`). The bug itself is real and reproducible: `enclosureFor`
(estimate-run.ts) accumulates the enclosure product in JS-NUMBER space, so NESTED same-axis
containers — each bound individually schema-valid — produce a product past
`Number.MAX_SAFE_INTEGER` (e.g. two nested `loop{maxIterations: 1e8}` → `enclosure.loop = 1e16`).
That product is what the classifier feeds `reservationCeiling`, and it is what the modelCall path
already guards. So the diagnosis and fix stand unchanged; only the specific single-node example
was inaccurate. The test uses the accurate nested-enclosure repro.

## Test (RED → GREEN)
Added `estimateRun > refuses gracefully when a nested enclosure multiplier exceeds the
safe-integer range (classifier reserve)`: nested `loop('outer'→'inner', 1e8)` /
`loop('inner'→'s1', 1e8)` over a `smartModel` node ⇒ `enclosure.loop = 1e16`.
- RED (before fix): threw `RangeError: reservationCeiling: maxIterations must be a positive
  integer` from `classifierReserveNanoUsd` (estimate-run.ts:491) → test errored. Verified.
- GREEN (after fix): `result._unsafeUnwrapErr().code === 'validation'`. Verified.

## Existing numbers unchanged
No cost formula touched. The guard is a pure pre-check that returns `undefined` for every
safe-integer multiplier (all existing tests), so `reservationCeiling` is called with the exact
same inputs and returns the exact same amounts. Full estimate-run suite: 63/63 pass, every
pre-existing money assertion unchanged.

## Self-gate
- `vitest` estimate-run.test.ts — **pass** (63/63).
- `vitest` estimate-run + smart-model-candidates + smart-model-turn, coverage on estimate-run.ts
  — **pass** (96/96); estimate-run.ts **100% stmts / 97.59% branch / 100% funcs / 100% lines**
  (uncovered branches 85, 576 are pre-existing, not from this change; new function fully covered).
- `turbo typecheck lint --filter=@hushbox/api --force` — result recorded in return message.
- `jscpd --threshold 2` on the two changed files — **pass** (0 clones, 0%).

## Deviations
1. Repro uses nested enclosures (product overflow) rather than the finding's literal single
   `2**53` node, because Zod v4 rejects unsafe-integer `.int()` values — see the correction
   above. The bug, diagnosis, and fix are otherwise exactly as stated.

## Confidence
High — RED reproduced the exact diagnosed throw, GREEN returns the graceful validationError,
the guard mirrors `ceilingInput`'s rule/labels/message verbatim, every pre-existing number is
untouched (63/63 + 96/96 green), coverage ≥95, jscpd clean. Only open item: the finding's
literal repro example is corrected (bug unaffected).
