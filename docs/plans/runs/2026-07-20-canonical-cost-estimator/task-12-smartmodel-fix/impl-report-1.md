# Impl report — T12 smart-model over-reservation fix

## Objective
Close the free-tier default (Smart Model) turn's admission over-reservation: the admission
ceiling exceeded `DAILY_ALLOWANCE_NANO_USD` (50,000,000n) so free users could not send.
Make the Smart-turn answer-sizing consistent with the canonical admission estimator so that
"sized-to-fit" provably implies "ceiling ≤ allowance".

## The two drifts and how each was closed
The bug had two independent causes; both live in the answer-sizing path
(`answerMaxOutputTokens` → `turnMaxOutputTokens`), NOT in the estimator (which is
audited-correct):

- **(a) Storage-EXCLUDED vs storage-INCLUSIVE classifier reserve.** Answer-sizing deducted
  `picked.classifierWorstCaseNanoUsd` (provider-only, marked-up, storage EXCLUDED —
  measured live = **12,231n**). The admission estimator adds the storage-INCLUSIVE classifier
  reserve (measured contribution ≈ **3.82M nano** larger) via `classifierReserveLineItems`
  fed through `reservationCeiling`.
- **(b) PER-RATE vs SUBTOTAL markup.** `turnMaxOutputTokens` marked up per rate
  (`applyMarkup(outputPerToken)` inside `summedTurnPricing`), which at integer nano rates
  rounds the 15% away (`applyMarkup(3n) = 3n`). The estimator marks up the SUBTOTAL
  (`reservationCeiling` → `applyMarkup(fixed + tokens×rate)`, effective 3.45/token). Over
  ~38k answer tokens this alone was ≈17k nano.

**How closed (one mechanism, not two patches):** rather than re-derive the storage-inclusive
reserve and subtotal-markup formula a THIRD time in chat/domain (which would re-introduce a
drifting duplicate — the exact anti-pattern this run bans), the compiled Smart-turn definition
is now **re-fit against the ONE canonical estimator** (`createEstimateRun`). The per-rate /
storage-excluded value from `answerMaxOutputTokens` is demoted to an UPPER-BOUND guess; a
monotonic binary search over `[1, guessCap]` picks the largest answer cap whose whole-definition
admission ceiling ≤ the payer's spendable funds. Because the final cap is validated by the same
estimator admission runs, both drifts are closed at their single source and cannot recur.

## Unification decision (preferred vs minimal)
Chose the **"One Implementation, Shared"** route the plan prefers: the turn's worst-case cost is
computed exactly once, in `createEstimateRun`/`reservationCeiling`; the new code adds no cost
formula, only a search (`fitAnswerCapToCeiling`) and a pure clone (`withSmartModelAnswerCap`).
The legacy `answerMaxOutputTokens`/`turnMaxOutputTokens` guess is retained ONLY as the search's
upper bound (it is provably ≥ the true fitted cap, since it under-counts cost), keeping the
existing legacy-semantics unit tests valid. **Deferred:** full deletion of the guess formula —
it still serves as a cheap bound and is covered by its own tests; the numeric AUTHORITY is now
solely the estimator, so no drift can leak through. This deferral is safe because every
persisting Smart turn's cap is estimator-validated by construction.

## Recomputed free-tier ceiling (hand-shown, measured live against the real estimator)
Seeded catalog: one text model, `inputPerToken=2n`, `outputPerToken=3n`, `contextLength=128000`;
free tier, `promptCharacterCount=400` → `promptInputTokens=200`, `outputCharsPerToken=4`,
input storage `400×300=120,000n`, allowance 50,000,000n.

- Guess cap (unfixed) = **41,452** → estimator ceiling = **53,823,000n > 50,000,000n** (the bug).
- Reconciled cap = **38,275** → estimator ceiling = **49,999,640n ≤ 50,000,000n**
  (margin **360n** — thin, as flagged, but strictly under).

Candidate answer leg at N is `applyMarkup(200×2 + N×3) + N×(4×300)`; total =
`inputStorage + classifierReserve(storage-incl) + answerLeg(N)`. The estimator is monotonic in N,
so the search lands the largest fitting N. (Independent hand calc with the implied reserve
3,821,648n gives max N = 38,271 / total 49,999,343n — same order; the live figure 38,275 /
49,999,640n is authoritative because it uses the real `classifierReserveChars`/line-item values.)

## Paid multi-candidate path (brief item 5)
`compileSmartModelBuild` is shared by paid-solo, group, and free persisting turns — all now
route through `reconcileAnswerCeiling` → `fitAnswerCapToCeiling`, so the identical drift on the
paid path (same storage-excluded reserve deduction) is fixed by the same mechanism. Where the
balance is large the guess already fits (search returns it unchanged, zero behavior change);
where the storage-inclusive reserve bites, the cap is shrunk to fit. Reconciliation is gated on
`stamped.storage !== undefined`, so the **trial** path (quota-gated, unstamped — NOT
balance/ceiling-gated) and the **budget-less** defensive build are untouched: zero blast radius
there. Confirmed: `turn-definition.test.ts` (63) and the balance-invariance / cap-stamped unit
suites (which bypass `compileSmartModelBuild`) stay green.

## Estimator NOT changed
No numbers in `estimate-run.ts` or `reducers.ts` (or `estimate.ts`,
`smart-model-candidates.ts`) were changed — the fix made answer-sizing consistent with THEM.
Files touched: only `smart-model-turn.ts`, `turn-definition.ts`, `smart-model-turn.test.ts`.

## Files changed
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — added `withSmartModelAnswerCap`
  (pure cap-clone), `fitAnswerCapToCeiling` (estimator-driven monotonic re-fit, exported),
  `reconcileAnswerCeiling` (persisting-only gate); `compileSmartModelBuild` now renames the
  guess and routes the stamped definition through reconciliation. `answerMaxOutputTokens`
  unchanged.
- `apps/api/src/slices/chat/domain/turn-definition.ts` — added exported `payerSpendableNanoUsd`
  (single-sources tier→spendable) and routed `turnMaxOutputTokens`' `effective` through it.
- `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` — new describe block pinning the
  reconciled ceiling (over-reserve characterization + fit ≤ allowance + cap shrinks).

## Tests added
- `the storage-excluded per-rate guess over-reserves past the daily allowance` — documents the
  bug (guess ceiling > 50M).
- `fits the reconciled admission ceiling within the daily allowance` — the money invariant
  (createEstimateRun(fitted) ≤ 50M). Covers the acceptance criterion.
- `shrinks the answer cap below the over-reserving guess` — proves the fit reduces the cap.

## TDD RED → GREEN
Stubbed `fitAnswerCapToCeiling` to a no-op → the two fix tests FAILED for the right reason
(ceiling stayed 53,823,000n > 50M; cap unchanged). Restored the real binary search → 22/22 green.
Integration suite (infra available) 3/3 green including the KEPT free-tier ceiling assertion.

## Self-gate
- `pnpm test:watch smart-model-turn.test.ts` — pass (22).
- `pnpm test:watch turn-definition.test.ts` — pass (63).
- `pnpm test:watch smart-model-turn.integration.test.ts` — pass (3), incl. free-tier ceiling.
- `turbo typecheck --filter=@hushbox/api --force` — pass.
- `turbo lint --filter=@hushbox/api --force` — pass (exit 0); direct `eslint` on the 3 owned
  files exit 0 after the LAST edit (from the api dir).
- `pnpm arch:check` — OK (11 rules / 1834 files).
- `jscpd --threshold 2` on the two changed sources — 2.03%: the single flagged clone is the
  PRE-EXISTING `buildWorkflow(...).map().mapErr()` chain in `buildSmartModelTurn` (unchanged by
  this task), not a cost formula and not newly introduced. No new duplicated cost math — a
  duplicate was REMOVED (the drift), not added.

## Deviations
- Full deletion of the `answerMaxOutputTokens` guess formula deferred (kept as the search's
  upper bound + its legacy-semantics tests); the estimator is now the sole numeric authority.

## Concerns / limitations
- Reconciled free-tier margin is 360n (≈$3.6e-7) — correct and strictly under, but genuinely
  thin; any future catalog/default change that reinflates the ceiling is caught by the KEPT
  integration assertion (that is its purpose).
- `fitAnswerCapToCeiling` runs ~log₂(cap) estimator evaluations per persisting Smart build
  (~17, pure/in-memory) — negligible; no provider or DB calls.

## Confidence
High — the money invariant is validated live by the canonical estimator (reconciled ceiling
49,999,640n ≤ 50,000,000n), RED→GREEN observed, all scoped gates green, estimator numbers
untouched, blast radius limited to the persisting Smart path.
