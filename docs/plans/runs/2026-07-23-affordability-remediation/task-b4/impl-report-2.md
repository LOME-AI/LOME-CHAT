# B4 — impl report 2 (resolution 3)

## Objective

Report 1's three items (heterogeneous pin, cross-verification against `createEstimateRun` on a
compiled definition, deletion of the summed-rate guess) plus the eight criteria the trial-cap
ruling added: fit unstamped turns, storage-free trial cap by construction, delete the remaining
`apps/api` rate arithmetic and move the trial gate to compile-then-price, per-sibling wire caps,
return the definition the fit priced, extend the sweep to the unstamped arm, rewrite the route pin
with a money-binding companion, and show the trial cost circuit deflated.

Everything below is delivered and green. Two things need your ruling but neither blocks: a floor
change that moved six B-re-derivation pins, and two fixtures whose rates I raised so the money term
binds. Both are in §Deviations.

---

## Files changed since report 1

- `apps/api/src/slices/chat/domain/turn-definition.ts` — `modelAnswerRoom` (one model's
  `min(providerCap, contextHeadroom)`), `physicalAnswerCeiling` now the **widest** sibling's room,
  new `sharedAnswerCeiling` for the tightest; `withAnswerCap` clamps each `modelCall` by its own
  room via `nodeAnswerCap`; `fitAnswerCapToCeiling` returns `AnswerCapFit` (the definition it
  priced, the settled `answerTokens`, `withinFunds`) and floors on a minimum viable answer;
  `reconcileAnswerCeiling` no longer conditions on the storage stamp; `turnAnswerSizing`'s reasoning
  arm derives its bound physically; `trialCostBasis`-era code gone — `turnCostBasis`,
  `summedTurnPricing`, `SummedTurnPricing` and `answerHeadroomTokens` deleted; `trialReasoningSelection`
  is compile-then-price through `trialLevelFits`.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — `candidateAnswerCeiling` reads
  `sharedAnswerCeiling`; `compileAutoEffortTurn` builds then fits then decides, with `someLevelFits`
  replacing the `answerHeadroomTokens` walk and the classifier-reserve-deducted-from-the-balance hack
  gone (the estimator already prices that reserve inside the node); `compileSmartModelBuild` exported
  as the Smart Model sizing seam.
- `apps/api/src/slices/chat/domain/turn-ceiling.property.test.ts` — grid gains the persistence axis;
  four new pins (both arms swept, every tier capped, trial priced below its stamped twin, floors
  reached).
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — `sharedAnswerCeiling` block; the
  heterogeneous per-sibling cap pin by amount; `answerHeadroomTokens`' block deleted; floor
  expectations follow the new floor; the trial gate fixture gets binding rates.
- `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` — the trial Smart Model arm's four wire-cap
  pins and the cost-circuit deflation pin.
- `apps/api/src/slices/chat/routes.integration.test.ts` — the route pin split into a
  physical-bound case and a money-binding companion; the two trial reasoning pins get binding rates.

Report 1's files (the value-store hoist, `computeSafeMaxTokens`' deletion, `turn-core.test.ts`'s
shared pins) are unchanged and still green.

`apps/api/src/slices/chat/domain/media-turn.integration.test.ts` shows a diff that is **A2's**
(`createCatalogSightingRecorder`), not mine.

---

## The two ungated doors, both closed and pinned separately

`reconcileAnswerCeiling` dropped `stamped.storage === undefined`, which closes both arms in one edit —
but each arm is pinned on its own, because the Smart Model arm had no wire-cap pin at all and a
single-arm fix would have left it open and green.

**Door 1 — single-model trial.** `chat/routes.integration.test.ts`, two pins (see criterion 7).

**Door 2 — trial Smart Model.** `smart-model-turn.test.ts` › *the trial Smart Model arm carries a
money-bounded wire cap*, driving the production `compileSmartModelBuild` with trial hooks and
candidates that carry no per-candidate caps (the shape that routes this arm through one shared cap).
Four pins: the definition stays unstamped; it prices within the 1¢ ceiling; the cap is strictly below
the physical room (999,800 tokens); and the cap is **maximal** — one token more exceeds the ceiling,
an oracle derived from the estimator rather than copied from the code's output.

**Measured, by restoring the old condition:** door 2 priced at **1,499,900,000 nano against a
10,000,000-nano ceiling — 150×** — and three of its four pins go red. That is the second door's
magnitude, which report 1 did not have.

---

## Acceptance criteria — the eight added by the ruling

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | No turn of any tier carries a wire cap with no money term; both trial arms closed, pinned separately | **met** | §The two ungated doors; sweep pin *gives every compiled turn of every tier a wire cap* |
| 2 | The trial cap is `trialTurnCost`-derived (storage-free) by construction, not by a second formula | **met** | sweep pin *prices an unstamped turn strictly below its stamped twin*: the unstamped definition carries no storage stamp, so `createEstimateRun` adds no storage term — nothing subtracts one |
| 3 | `turnCostBasis`, `summedTurnPricing`, `answerHeadroomTokens` deleted; trial gate is compile-then-price; nothing reintroduces the bound | **met** | greps below; `trialLevelFits` compiles at the level, prices it unstamped, and asks the fit whether `B + MINIMUM_OUTPUT_TOKENS` is within the ceiling |
| 4 | Each sibling's wire cap is its own; holds only move down | **met** | `turn-definition.test.ts` › *gives a heterogeneous pair each sibling its own cap* — `[127_900, 3900]` by amount |
| 5 | The fit returns the definition it priced | **met** | `AnswerCapFit.definition` is `withAnswerCap(definition, answerTokens, …)` on every return path; no branch returns the input |
| 6 | The property sweep covers the unstamped arm | **met** | 704 grid points / 448 compiled / 256 typed refusals, both persistence arms; the regression reproduces as **78 violations** under the old condition |
| 7 | The route pin is rewritten with a realistic-rate companion | **met** | two pins, both oracles derived from §Model bounds; the companion's money term is asserted to be the binding one |
| 8 | The trial cost circuit is verified to have deflated | **met** | `smart-model-turn.test.ts` › *deflates the trial cost circuit with the cap* |

### Criterion 3 — grep evidence, and the same-named survivor

```
$ grep -rn "turnMaxOutputTokens\|answerMaxOutputTokens\|computeSafeMaxTokens\
\|answerHeadroomTokens\|turnCostBasis\|summedTurnPricing" --include="*.ts" apps | grep -v /dist/
(no matches)
```

`apps/` is clean, which is the Global Constraint 4 statement: no rate arithmetic left in the api
tree's answer sizing. Two survivors elsewhere, both deliberate:

- **`answerHeadroomTokens` as a FIELD** on `ReasoningPlan`
  (`packages/shared/src/affordability/estimate/reasoning-plan.ts`) — the shared plan's H, which it
  takes as an **input**. It is not a derivation of the bound and the file is byte-unchanged versus
  `ada0341c` (`git diff HEAD --stat` on it is empty). I did not rename it: it is a shared type's
  field, B6's area, and renaming it is a contract change no criterion asks for.
- **Storage rate arithmetic in `settlement.ts` and `estimate-run.ts`** — the charge side and the
  estimator itself, not a second answer-sizing formula.

### Criterion 4 — the per-sibling caps, by amount

Rich purchased payer so only the physical bounds decide; 400 chars at 4 chars/token = 100 input
tokens:

| sibling | context | provider cap | own room | stamped cap |
| --- | --- | --- | --- | --- |
| `wide-a` | 128,000 | — | 127,900 | **127,900** |
| `tight-a` | 4,000 | 4,000 | 3,900 | **3,900** |

The search's upper bound is the **widest** room (127,900, asserted), and each node clamps itself. One
shared tightest-sibling cap would have stamped 3,900 on both and truncated the wide sibling by
124,000 tokens. The fitted definition still prices within the payer's spendable, so the change only
lowers holds.

### Criterion 6 — the sweep now sees the arm the defect lived in

704 grid points: 4 single-model sets × 2 persistence arms + 3 multi-model sets (paid-only), each over
4 prompt sizes × 4 balances × 2 tiers × 2 effort selections. 448 compile; 256 are typed 400s (a
non-reasoning model at an explicit level refuses rather than substituting).

Restoring `stamped.storage === undefined` puts **78 of 448** turns in violation, so the guard that
failed now catches its own regression. The earlier mutation still holds too: stubbing the reconcile
out entirely was **105 violations** in report 1's grid.

### Criterion 7 — two route pins, neither number copied

- *caps a trial single-model answer at its context headroom when the money does not bind* — the
  existing 1M-window fixture. At 3 nano per output token the 1¢ ceiling buys ~3.3M tokens, so the
  **prompt** binds and the cap is `1_000_000 − inputTokens`. The comment records why this case cannot
  prove the fix: the spec-conformant cap here equals what an unbounded cap also produces.
- *caps a trial single-model answer at what the 1¢ ceiling buys when the money binds* — a 5M-window
  companion at the same rates, where `budgetBuys` is tightest. Oracle:
  `floor((10_000_000 − inputTokens × 2) / 3)`, which is §Model bounds' `budgetBuys` on a turn that
  never persists, so §Trial Usage gives it no storage term. The test asserts that value is **below**
  the context headroom, so the money term is provably the binding one.

Rates were kept at the fixture's 2/3 and the **window** widened instead of raising rates, because the
suite's premium quartile is set by 1e9-nano decoys and a re-rated model risks changing its trial
eligibility — a different behaviour from the one under test.

### Criterion 8 — the circuit followed the cap down

`smart-model-turn.test.ts` › *deflates the trial cost circuit with the cap, because the circuit is
estimate x 5*: the limit is `estimate × COST_CIRCUIT_MULTIPLIER`, so the pin asserts it is now within
`5 × the per-message ceiling`, and the control prices the same definition at the physical room — the
cap this arm carried while the fit skipped unstamped turns — and asserts that limit was **more than
100× higher**. Shown, not assumed.

---

## Report 1's three original items — still met, re-verified

- **Heterogeneous pair, by amount** (shared): `vendor/plain` on its own provider cap 8,000 while
  `vendor/tight` takes its own context headroom 3,750, with `T` = 192,153 above both; priced basis
  31,350,000n against the forbidden `fixedCosts + T × Σrates` = 999,995,600n. Verified red under a
  shared-clamp mutation.
- **Cross-verification on compiled definitions**: now 448 of them, through
  `compileSingleTurn` / `compileMultiModelTurn`, priced by `createEstimateRun`.
- **The guess is deleted, grep-clean, and the fit survives** — and now returns what it priced.

---

## Self-gate

| command | result |
| --- | --- |
| `npx turbo typecheck --force --continue` | **pass** — 16 successful / 16, 0 cached |
| `eslint` (the six files I own in `apps/api`, run from `apps/api` after the last edit) | **pass** — exit 0 |
| `eslint` (`packages/shared`: `src/affordability/`, `src/constants.ts`) | **pass** — exit 0 |
| `pnpm test:shared` | **pass** — 124 files, 2,962 tests, coverage gate green |
| `pnpm test:api` | **7 failed / 6,409 passed / 2 skipped** (466 of 468 files pass, 1 skipped) — all 7 are §Known Breakage |

**The 7 remaining `pnpm test:api` failures are all `notifications/domain/templates/template-html.test.ts`**
(welcome, password-changed, two-factor-enabled/disabled, account-locked, account-deleted,
chargeback-lock) — the concurrent push/notifications workstream's, listed verbatim in §Known
Breakage. `git diff HEAD --stat` on `apps/api/src/slices/notifications` is empty, so the file is
untouched by me. No coverage or pole gate failure appeared.

Scoped file runs, all green: `turn-definition.test.ts` 91 · `smart-model-turn.test.ts` 43 ·
`turn-ceiling.property.test.ts` 9 · `routes.integration.test.ts` 188 ·
`turn-definition.integration.test.ts` 13 · `estimate-run.test.ts` 73 · `value-store.test.ts` 22.

Both of report 1's api failures are resolved. The trial cap pin is rewritten under criterion 7. The
rich-payer pin — *omits the ceiling for a rich payer whose budget covers the context window* — is now
*caps a rich payer at the context headroom, the tightest bound left once money is loose*, and it is
the second of the two expectations the ruling named as expected to move. **Its new amount is derived,
not copied:** §Model bounds' ceiling on that fixture is
`min(providerCap ⌀, contextHeadroom, budgetBuys) = 128_000 − ceil(11/4) = 127_997`, and the test
writes it as `128_000 - Math.ceil('hello world'.length / 4)` so the arithmetic is on the page rather
than the result. I initially reported this pin as already resolved before it was — caught by the
first full `pnpm test:api`, fixed, and re-run.

---

## Deviations, with reasons

1. **The fit's floor moved from one token to `MINIMUM_OUTPUT_TOKENS`.** Criterion 3's gate is "refuse
   if `B + MINIMUM_OUTPUT_TOKENS` exceeds the ceiling", so that quantity has to be the fit's own floor
   — otherwise the gate refuses at one number while the build stamps another, which is the drift this
   task exists to remove. It is also what §Affordability 6 says ("the minimum-viable-answer floor IS
   THE minimum"), so a 1-token answer was never a cheaper option the fit was entitled to take. When
   the physical bound is smaller than a minimum answer the floor is that bound, so no cap ever
   exceeds a model's own room.
   **Consequence: six B-re-derivation pins moved from `B + 1` to `B + MINIMUM_OUTPUT_TOKENS`.** They
   pin how B is re-derived from a wire, not a hold, and they are only reachable in the floored case —
   where the definition is priced above the payer's funds and admission refuses, so no hold is ever
   placed at the larger figure. Named individually so you can reverse the call: *floors the answer
   headroom at a minimum viable answer above B* · *re-derives B from a budget-native max_tokens wire*
   · *re-derives B as 0 from the hard-off wire* · *re-derives B positionally from a native
   non-canonical effort wire* · *treats an unresolvable model as B=0* · *treats an effort wire on a
   non-reasoning descriptor as B=0*, plus the reasoning-free *floors the cap at a minimum viable
   answer and stays over funds*.
2. **Two fixtures' rates raised to 1,000/1,500 nano so the money term binds** — the unit trial gate
   (`trialReasoningSelection`) and the two trial reasoning route pins. At 2/3 nano and storage-free
   pricing, **every** level fits a 1¢ ceiling, so those refusals would have pinned nothing. This is
   the same trap criterion 7 names, in three more places. The refusal/acceptance split is
   arithmetically derived in the fixture comment (`medium` 19.9M vs `low` 7.6M against 10M).
3. **`compileSmartModelBuild` exported**, for the same reason the other two compile seams were: door
   2's cap has to be pinned on the definition a request compiles.
4. **`compileAutoEffortTurn` restructured to build → fit → decide.** Its `answerHeadroomTokens` walk
   was the other consumer of the deleted derivation. The strongest-affordable-level walk survives as
   `someLevelFits` over the model's own offered budgets against the fitted cap, and the
   classifier-reserve deduction is gone because the estimator prices that reserve inside the node —
   strictly more accurate than deducting it from the balance first. All eleven of its existing pins
   pass unchanged, including *walks the model's own offered budgets, not a fixed level list* and
   *falls back when no reasoning level leaves answer headroom under the budget*.

---

## Concerns and limitations

1. **The trial cap now buys much more, and that is a product change to surface, not a bug.** Storage
   was ~99.8% of the old trial cost. §Trial Usage says a trial turn never pays it, so the 1¢ ceiling
   legitimately buys far more provider tokens than before. Ruling 5 already requires B5 to report the
   same effect for trial *eligibility*; this is the same effect on the *answer length*, and the two
   should be reported to the founder together.
2. **§Trial Usage's overshoot-bound sentence is now true again but at a different number.** The
   $50/day cap's overshoot bound is the per-message cap, which holds once more — but the per-message
   cap buys a different answer length than the doc's reader would have inferred. I did not edit
   `BILLING.md` (read-only to subagents); if the doc quantifies it anywhere, it needs your pass.
3. **`getTurnOptions` still has zero production consumers** (B8 owns wiring it), so the api tree's
   ceiling and the shared producer's ceiling remain two implementations of §Model bounds that agree
   by construction only in the sense that both now defer their money term to one estimator. The
   physical halves are still separate code.
4. **The reasoning arm's bound is physical, the trial gate's is priced.** Both go through the fit, so
   the authoritative cap is the estimator's in every case; but `turnAnswerSizing` and `trialLevelFits`
   reach it by different routes, and a future reader could mistake one for the other. Both docblocks
   say which is which.
5. **Coverage:** I added tests only; no production branch is left untested that was tested before.
   The `pnpm test:api` coverage gate is part of the run recorded in §Self-gate.
6. **The smartModel node is the one node `withAnswerCap` cannot clamp per model**, because its single
   cap rides whichever candidate the classifier picks. Its bound therefore arrives already tightened
   to the narrowest candidate (`sharedAnswerCeiling`), which is correct but is the one place where a
   wide candidate is bounded by a narrow sibling. That is inherent to a single composite node holding
   one cap, not a regression — the paid Smart Model path avoids it entirely with per-candidate caps,
   and only the trial arm (no per-candidate caps) takes the shared one.

## Confidence

**High.** Every criterion is pinned by amount or by a mutation that reproduces the defect it guards,
the two doors are measured separately (150× on the one that had no pin), and the paid path's figures
are unchanged where money binds. The two deviations are both judgement calls I have named rather than
absorbed.
