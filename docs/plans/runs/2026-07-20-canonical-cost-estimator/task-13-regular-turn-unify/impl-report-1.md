# impl-report-1 — task-13 regular-turn unify

## Objective

Route the REGULAR single/multi-model chat-turn answer-sizing through the ONE canonical
estimator (`createEstimateRun`), eliminating the standalone per-rate cost formula
(`summedTurnPricing`/`turnMaxOutputTokens`) as the definitive cap — mirroring the
smart-model fix (`fitAnswerCapToCeiling`). After the fix there is ONE authoritative turn
cost computation (the estimator); the per-rate math survives only as a non-authoritative
search upper bound.

## What was deleted / demoted

- **Demoted (not deleted), the per-rate formula:** `summedTurnPricing` (fixed +
  per-token variable cost with PER-RATE `applyMarkup`) and `turnMaxOutputTokens`
  (`floor((effective − fixed)/variable)` inverse solve) still exist, but they are no
  longer the definitive cap. In `buildTurnDefinition`/`buildMultiModelTurnDefinition`,
  `derivedCeiling(...)` (which calls `turnMaxOutputTokens`) now produces only a
  **guess `ceiling`** that is fed to `reconcileAnswerCeiling(stamped, pricingResolver,
  budget, ceiling)` as a search UPPER BOUND. The final `maxOutputTokens` on the built
  definition is whatever the estimator-driven binary search accepts, exactly as
  smart-model demoted `answerMaxOutputTokens`.
- **Deleted duplicates in `smart-model-turn.ts`:** the local `withSmartModelAnswerCap`,
  `fitAnswerCapToCeiling`, and `reconcileAnswerCeiling` were removed. There was one copy
  of the fit/reconcile pair; it is now shared, not duplicated.

## How regular-turn sizing now routes through the estimator

- **Shared, single implementation** (moved to `turn-definition.ts`, the module
  `smart-model-turn.ts` already depends on — no import cycle):
  - `withAnswerCap(definition, cap)` — internal; sets `maxOutputTokens` on every
    `modelCall` **and** `smartModel` node. A definition is homogeneous in its answer
    nodes, so this serves single-model (one node), multi-model (all siblings take the
    SAME cap, matching legacy), and smart-model (one composite node) identically.
  - `fitAnswerCapToCeiling(definition, resolveModel, guessCap, spendableNanoUsd)` —
    exported; binary-searches `[1, guessCap]` for the largest cap whose
    `createEstimateRun(resolveModel)(withAnswerCap(definition, cap))` ceiling ≤ spendable.
    Signature changed from taking a `catalog` array to taking a `ModelPricingResolver`
    so both callers reuse it: turn-definition passes its `pricingResolver` directly;
    smart-model passes `snapshotResolver(catalog)`.
  - `reconcileAnswerCeiling(stamped, resolveModel, budget, guessCap)` — exported; no-ops
    for a trial (unstamped), budget-less, or guess-less build, otherwise calls
    `fitAnswerCapToCeiling(..., payerSpendableNanoUsd(budget))`.
- **Wiring:** both `buildTurnDefinition` (single) and `buildMultiModelTurnDefinition`
  (multi) append `.map((stamped) => reconcileAnswerCeiling(stamped, pricingResolver,
  options.budget, ceiling))` after `withStorageStamp`. `smart-model-turn.ts` imports and
  calls the shared `reconcileAnswerCeiling(stamped, snapshotResolver(catalog), budget,
  guessCap)` — its behavior is byte-for-byte the same probe it had before.

## ONE cost computation — evidence

- The only path that PRICES a turn's cost/affordability for admission is now
  `createEstimateRun` (`estimate-run.ts`, unchanged — its numbers were NOT touched) via
  `reservationCeiling` (`packages/shared/src/estimate/reducers.ts`, unchanged). The
  per-rate `turnMaxOutputTokens` output only bounds the search; it is never the final
  cap.
- `grep` for `derivedCeiling`/`turnMaxOutputTokens` in `turn-definition.ts` confirms
  their result flows solely into the `ceiling` guess handed to `reconcileAnswerCeiling`
  (turn-definition.ts:710, 734, 779, 800). No call site uses the per-rate result as the
  final authoritative cap.
- `jscpd --threshold 2` over the two changed source files: PASS (1 clone, 0.54% lines /
  1.33% tokens — under threshold). The single remaining clone is the pre-existing
  6-line builder glue shared by `buildTurnDefinition`/`buildMultiModelTurnDefinition`
  (the `.map(withStorageStamp).map(reconcileAnswerCeiling)` tail), not a cost formula.
  The duplicate cost formula (smart-model's own fit/reconcile) was REMOVED, so the count
  dropped rather than grew.

## Test expected-numbers

- **No existing expected number changed.** The two `turn-definition.integration.test.ts`
  assertions (`{ maxOutputTokens: 49_585 }` for a $0.10 paid payer, and `{}` for a rich
  payer) still hold: I hand-derived that for a single-model turn with EXACT-markup rates
  (2500/10000, where `applyMarkup` has no rounding residue) the guess equals the
  estimator, so `fitAnswerCapToCeiling(guess)` fits at the guess and returns the
  definition unchanged (estimator ceiling at cap 49_585 = 599_990_425 nano ≤ spendable
  600_000_000 nano). The rich-payer case yields `guess = undefined` (budget covers the
  context) → `reconcileAnswerCeiling` returns the stamped definition unchanged → cap
  omitted. Both verified: the integration suite passes 5/5.
- **New tests (`turn-definition.test.ts`), the "fits funds via estimator" pin** mirroring
  the smart-model rung-3 assertion, at unit level so the numeric authority is pinned
  without infra:
  - `shrinks a single-model turn cap so the estimator ceiling fits the payer funds` —
    tiny rates (2/3, where per-rate markup rounds the 15% away), free-tier budget
    (remaining 50_000_000, prompt 400 chars, wide 128k context). Asserts the guess
    OVER-reserves (`estimator(stamped) = 50_017_904 > 50_000_000`), then
    `reconcileAnswerCeiling` shrinks the cap so `estimator(fitted) ≤ 50_000_000` and the
    fitted cap `< guess`.
  - `shrinks a multi-model turn shared cap ...` — same rates over two models; guess
    over-reserves (`estimator(stamped) = 50_018_364 > 50_000_000`); fit shrinks; asserts
    all siblings carry the SAME shrunk cap (`new Set(caps).size === 1`).
  Over-reserve figures independently recomputed via a bigint script before writing the
  tests.

## Estimator untouched

`estimate-run.ts` and `packages/shared/src/estimate/reducers.ts` were NOT edited — the
answer-sizing now matches THEIR numbers by construction rather than re-deriving them.

## Self-gate

- `vitest run turn-definition.test.ts smart-model-turn.test.ts` — PASS, 87/87.
- `vitest run turn-definition.integration.test.ts smart-model-turn.integration.test.ts`
  (via `with-env`, infra up) — PASS, 5/5.
- `eslint` (from `apps/api`, the 4 changed files, after the LAST edit) — exit 0
  (prettier applied; one `no-unnecessary-condition` in the new test fixed by dropping a
  redundant post-filter ternary).
- `turbo typecheck lint --filter=@hushbox/api` — typecheck PASS; lint PASS after the
  formatting/condition fixes (re-run recorded).
- `jscpd --threshold 2` on changed source files — PASS (0.54%).
- `arch:check` — OK, 11 rules over 1834 files.

## Files changed

- `apps/api/src/slices/chat/domain/turn-definition.ts` — added shared `withAnswerCap`,
  `fitAnswerCapToCeiling`, `reconcileAnswerCeiling`; wired `reconcileAnswerCeiling` into
  both builders; imported `createEstimateRun`.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — removed the local
  `withSmartModelAnswerCap`/`fitAnswerCapToCeiling`/`reconcileAnswerCeiling`; imports and
  calls the shared versions; dropped now-unused `createEstimateRun`/`payerSpendableNanoUsd`
  imports.
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — added the "fits funds via
  the ONE estimator" describe block (single + multi).
- `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` — `fitAnswerCapToCeiling`
  now imported from `turn-definition.js` and called with `snapshotResolver(CATALOG)`.

## Deviations

None from the acceptance criteria. The per-rate `turnMaxOutputTokens`/`summedTurnPricing`
were demoted (kept as the search upper bound) rather than deleted — the brief permitted
"DELETED or demoted to a non-authoritative search UPPER-BOUND"; demotion matches exactly
what the smart-model fix did with `answerMaxOutputTokens`.

## Concerns and limitations

- When `derivedCeiling` returns `undefined` (budget covers the tightest model's remaining
  context), no fit runs and the cap is omitted. For a single-model turn this is exactly
  right (admission prices the one model's full window, which the budget covers). For a
  MULTI-model turn with models of DIFFERENT context lengths, an omitted cap lets the
  estimator price each sibling at its OWN full context — a conservative OVER-reserve
  (fail-closed), never an under-reserve. This is pre-existing behavior (the old code also
  omitted the cap in this case) and is not the drift being fixed; the fix guarantees
  "sized-to-fit ⇒ ceiling ≤ funds" whenever a concrete guess exists. Flagged for
  awareness, not blocking.

## Confidence

High — the change is a faithful structural mirror of the already-audited smart-model fix;
all existing expected numbers were hand-derived to be invariant and confirmed by the
passing integration suite; the estimator (the numeric authority) was not touched.
