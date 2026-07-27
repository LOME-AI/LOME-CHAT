# B4 — impl report 1

## Objective

Prove the existing shared-token solve against the admission estimator on a compiled
definition, pin the heterogeneous-sibling case, and delete the summed-rate guess.

**Status: NEEDS_CONTEXT.** Everything except one consequence of the deletion is done and
green. The deletion removed the only money bound on the **trial** answer cap, and there is no
admission balance gate behind it: the trial wire cap moved from **7,909 → 999,194 tokens** on
the route's own pin. That is a live money regression, the pin that catches it is a
pre-existing money pin, and B4's criteria forbid me from rewriting a pin to match new
behaviour. The resolution needs the orchestrator. Details in §The blocker.

---

## Files changed

### shared

- `packages/shared/src/affordability/turn-core.test.ts` — added the heterogeneous-pair pins
  (criteria 1 + 2) and the smart-slot-`MAX`-enters-`T` pins (criterion 5). Test-only.
- `packages/shared/src/affordability/budget.ts` — deleted `computeSafeMaxTokens` +
  `ComputeMaxTokensParams`, orphaned by the deletion (their only caller was the guess), and
  corrected the file docblock that advertised them.
- `packages/shared/src/affordability/budget.test.ts` — deleted their tests with them.
- `packages/shared/src/affordability/index.test.ts` — removed those two names from the
  walled-export lists; a walled name that no longer exists cannot be asserted absent.
- `packages/shared/src/constants.ts` — one home for `VALUE_STORE_BYTE_BUDGET_BYTES`.
- `packages/shared/src/affordability/turn-core.ts` — **not changed by me.** Its two-line diff
  against `ada0341c` is the pre-existing comment §RUN STATE records. I mutated it twice to
  verify pins go red and restored it byte-identically both times (`git diff` confirms).

### apps/api

- `apps/api/src/slices/chat/domain/turn-definition.ts` — deleted `turnMaxOutputTokens`; added
  `physicalAnswerCeiling` (`min(providerCap, contextHeadroom)`, no money term) as the fit's
  upper bound; rewired `derivedCeiling`; exported `compileSingleTurn` /
  `compileMultiModelTurn` as the sizing seam the sweep drives; corrected the docblocks that
  described the deleted derivation.
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — the guess's 11 amount pins
  replaced by 7 for `physicalAnswerCeiling`; the two fit tests now start from the physical
  bound.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — deleted `answerMaxOutputTokens` and
  its `tightestCompletionCap` helper; added `candidateAnswerCeiling` (the same physical bound
  over the candidates); dropped the classifier-reserve-deducted-from-the-balance hack (the
  canonical estimator already prices that reserve inside the smartModel node); renamed the
  surviving `SmartModelTurnParams.answerMaxOutputTokens` field to `answerCapTokens` so the
  deleted derivation's name does not survive as a stale reference.
- `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` — updated; the two money-specific
  cases replaced by a money-independence pin.
- `apps/api/src/slices/chat/domain/index.ts` — both deleted symbols dropped from the barrel;
  nothing outside `chat/domain` consumed them.
- `apps/api/src/slices/chat/domain/turn-ceiling.property.test.ts` — **new**, the
  cross-verification sweep.
- `apps/api/src/slices/models/domain/estimate-run.ts` — reads the hoisted constant; the local
  copy and its "MUST stay in sync" comment are gone.
- `apps/api/src/slices/models/domain/estimate-run.test.ts` — imports the constant from
  `@hushbox/shared` instead of reaching across the slice boundary into `workflows/engine`.
- `apps/api/src/slices/workflows/engine/{value-store.ts,value-store.test.ts,interpreter.ts}` —
  read the hoisted constant; the metered-ceiling rationale stays with the store that meters.

Concurrent A2 files (`models/domain/{refresh,normalize,catalog-store}.ts`, `packages/db/**`,
`scripts/refresh-catalog*`, `packages/shared/src/models/**`, migration `0060`) appear in
`git status` and are **not mine**.

---

## Tests added

| Test | Behaviour | Criterion |
| --- | --- | --- |
| `turn-core.test.ts` › leaves the wide sibling on its own provider cap while the tight one takes its own context headroom | per-sibling physical clamps on a heterogeneous pair | 1 |
| `turn-core.test.ts` › prices the pair at Σ cost(m, ceiling(m)), not at T × Σ rates | the charge basis, by amount | 2 |
| `turn-core.test.ts` › shares the money bound when the money is what binds | one shared `T` when money is tightest | 1 |
| `turn-core.test.ts` › solves a smaller shared count for the dearer candidate than for the cheaper one | `T` is per-arrangement | 5 |
| `turn-core.test.ts` › sizes the hold on the dearest candidate, not the cheapest | the slot's `MAX` enters the solve | 5 |
| `turn-ceiling.property.test.ts` › 5 tests over a 448-point grid | `createEstimateRun(compiled definition) ≤ funding` | 3 |
| `turn-definition.test.ts` › `physicalAnswerCeiling` × 7 | the money-free upper bound | 6 |
| `smart-model-turn.test.ts` › `candidateAnswerCeiling` × 5 | ditto for the slot | 6 |

### The heterogeneous pair, by amount

Both siblings persist, paid tier, 1,000 prompt chars ⇒ 250 input tokens; funding
1,000,000,000n so only the physical bounds can bind:

| sibling | `providerCap` | `contextHeadroom` | `T` | `ceiling(m)` |
| --- | --- | --- | --- | --- |
| `vendor/plain` (ctx 100,000) | **8,000** | 99,750 | 192,153 | **8,000** ← its own cap |
| `vendor/tight` (ctx 4,000) | 4,000 | **3,750** | 192,153 | **3,750** ← its own headroom |

The tight sibling's 3,750 does not pull the wide sibling below 8,000, and the wide sibling's
8,000 does not lift the tight one above its own context. Priced basis
`Σᵢ cost(mᵢ, ceiling(mᵢ))` = **31,350,000n** (21,350,000 + 10,000,000, prompt storage on the
first sibling only). The forbidden `fixedCosts + T × Σrates` on the same turn is
**999,995,600n** — essentially the whole funding, so the two bases are not confusable at this
fixture. A third case at funding 11,000,000n puts both ceilings on the shared **1,961**,
which is what shows `T` is genuinely shared when money is the tightest bound.

Every one of those four numbers was hand-derived from §Math & Terms before the test ran and
matched first time.

### Cross-verification against `createEstimateRun`

- **448 generated turns**: 7 model sets × 4 prompt sizes (0/400/4,000/40,000 chars) × 4
  balances (1n → 5,000,000,000n) × 2 tiers × 2 effort selections. **288 compile** and are
  priced; **160** are typed 400s (a non-reasoning model at an explicit level refuses rather
  than substituting), which the sweep pins as a count so the refusal path is exercised too.
- Every one of the 288 goes through `createEstimateRun(resolver)(definition)` on the
  **compiled** definition returned by `compileSingleTurn` / `compileMultiModelTurn` — the
  production build, including `withStorageStamp` and `reconcileAnswerCeiling` — never through
  the module's own cost function. That is why the two compile seams are now exported: pricing
  a definition rebuilt in the test would have re-derived the sizing rather than tested it.
- The property: each turn either prices **≤ the payer's spendable funds**, or the sizing is
  already at its floor and admission's balance gate refuses (the reasoning-free floor is one
  token; a reasoning turn's floor is its level's budget plus one minimum viable answer,
  because the level was the explicit ask and is never silently downgraded). Both floors are
  asserted to occur, so the exception clause excuses nothing unobserved.
- **The sweep constrains the fit** (verified, not assumed): with `reconcileAnswerCeiling`
  stubbed to return the definition untouched, **105 of 288** turns violate the property.
  Restored byte-identically afterwards (`diff` against a pre-mutation copy: identical).

---

## Self-gate

| command | result |
| --- | --- |
| `npx turbo typecheck --force --continue` | **pass** — 16 successful / 16, 0 cached (17:29) |
| `eslint` (apps/api: `slices/chat/domain/`, `slices/models/domain/estimate-run*.ts`, `slices/workflows/engine/`) | **pass** — exit 0, after the final edit, from `apps/api` |
| `eslint` (packages/shared: `src/affordability/`, `src/constants.ts`) | **pass** — exit 0, after the final edit, from `packages/shared` |
| `pnpm test:shared` | **pass** — 124 files, 2,962 tests, coverage gate green |
| `pnpm test:api` | **fail** — 464 files pass / 3 fail; 6,403 tests pass / 9 fail |

### The 9 `pnpm test:api` failures, attributed

- **7 — not mine.** `notifications/domain/templates/template-html.test.ts` (welcome,
  password-changed, two-factor-enabled/disabled, account-locked, account-deleted,
  chargeback-lock). Listed verbatim in §Known Breakage as the concurrent
  push/notifications workstream's; the file is unmodified in my diff.
- **2 — mine, both are the deletion's behaviour changes.**

  1. `chat/domain/turn-definition.integration.test.ts` › *omits the ceiling for a rich payer
     whose budget covers the context window* — `expected { maxOutputTokens: 127997 } to
     deeply equal {}`. The old guess dropped the cap when the budget covered the physical
     ceiling; the physical bound is always concrete, so the wire now always carries an
     explicit cap. **The hold moves DOWN** here: `declaredOutputCeiling` bounds an uncapped
     node at `min(contextLength, catalogCap)` = 128,000 while the stamped ceiling is
     `contextLength − inputTokens` = 127,997, which is what §Affordability 7 actually
     specifies (`min(providerCap, contextHeadroom, budgetBuys)`). Safe direction, spec-aligned
     — but it is a moved hold and therefore yours to ratify.
  2. `chat/routes.integration.test.ts` › *caps a trial single-model answer at the 1¢-derived
     output ceiling* — `expected { maxOutputTokens: 999194 } to deeply equal
     { maxOutputTokens: 7909 }`. **This is the blocker.**

---

## The blocker — the trial answer cap has no gate behind the deletion

The trial send is the one live consumer of the deleted guess whose money bound nothing else
replaces:

- `POST /chat/trial` builds through `compileSingleTurn` with `TRIAL_TURN_HOOKS` and a
  1¢-derived `TurnBudget`.
- `withStorageStamp` deliberately leaves a trial definition **unstamped** (a trial turn
  persists nothing), and `reconcileAnswerCeiling` returns untouched when
  `stamped.storage === undefined`. So the fit never runs on a trial turn.
- Trial is **quota**-gated, not balance-gated: there is no admission balance gate downstream
  to refuse an over-cap trial run. The pre-send per-message cap was the only bound, and the
  deleted `turnMaxOutputTokens` was where it entered the wire.

Measured consequence: the trial wire cap goes **7,909 → 999,194 tokens**, a 126× increase in
what a free trial message may generate, with the platform absorbing the spend. Not shippable.

I did not choose between the resolutions, per my brief. The two I can see:

1. **Let the fit cover trial** — drop the `stamped.storage === undefined` condition in
   `reconcileAnswerCeiling` so a trial turn is fitted against its 1¢ spendable by the
   canonical estimator. Reuses the one estimator, needs no new money math, and the resulting
   price is provider-cost-only, which is what §Math & Terms `trialTurnCost` requires
   ("priced with no storage term at all") and the direction ruling 5 already took for the
   trial eligibility gate. **It changes a documented contract** ("only the persisting
   (storage-stamped) turn is balance-gated") **and it changes the trial cap amount** — the
   deleted guess priced storage into that cap, so the 1¢ ceiling will buy strictly more. That
   is the product effect ruling 5 says to surface, not to ship quietly.
2. **Keep a money-derived trial cap** — i.e. the guess survives for the trial arm, which
   contradicts criterion 6.

Whichever you pick, the route's `trialOutputCap` oracle in
`chat/routes.integration.test.ts:3707` is itself a copy of the deleted formula and will need
an owner; I left it untouched rather than rewrite a money pin to match new behaviour.

---

## Acceptance criteria

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | `T` solved once per turn; each sibling applies its own `providerCap`/`contextHeadroom`; heterogeneous pair pinned | **met** | §The heterogeneous pair; 8,000 vs 3,750 with both bounds visible; verified red under a shared-clamp mutation |
| 2 | Reserved amount is `Σᵢ cost(mᵢ, ceiling(mᵢ))`, never `T × Σrates`; by amount | **met** | 31,350,000n pinned against the forbidden 999,995,600n |
| 3 | Verified against the admission estimator on a compiled definition | **met** | 288 compiled definitions priced by `createEstimateRun`; 105 violations under a stubbed reconcile |
| 4 | `inputStorage` exactly once in a three-sibling hold, by amount | **met — pre-existing B3 pin, re-run green** | `turn-core.test.ts` › *prices input storage once per turn, not once per sibling* (300,000n over three siblings) |
| 5 | A smart slot's `MAX` enters the `T` solve; pinned | **met** | two new pins: the dearer candidate's row ceiling is strictly lower, and the hold tracks the dearest arrangement (control catalog differs only in that candidate's rates) |
| 6 | The summed-rate guess is deleted, grep-clean; the fit survives | **met mechanically, BLOCKED in consequence** | greps below; the trial arm loses its money bound — §The blocker |
| 7 | Value-store byte budget hoisted to one home, its sync comment removed; the other comment untouched | **met** | greps below |
| 8 | B3's money pins stay green exactly as written; no hold moves | **partially met — two pins moved, reported, not rewritten** | all shared pins green (2,962 tests); the two api pins are the rich-payer cap and the trial cap above |

### Grep evidence

```
$ grep -rn "turnMaxOutputTokens\|answerMaxOutputTokens\|computeSafeMaxTokens" \
    --include="*.ts" --include="*.tsx" apps packages scripts e2e | grep -v /dist/
(no matches — exit 1)
```

The fit survives and still calls the canonical estimator:

```
apps/api/src/slices/chat/domain/turn-definition.ts:435: export function fitAnswerCapToCeiling(
apps/api/src/slices/chat/domain/turn-definition.ts:441:   const estimate = createEstimateRun(resolveModel);
apps/api/src/slices/chat/domain/turn-definition.ts:477:   return fitAnswerCapToCeiling(stamped, resolveModel, guessCap, payerSpendableNanoUsd(budget));
```

One definition of the byte budget, and exactly one surviving sync comment — the dual-guard
one, which `git diff HEAD` shows I did not touch:

```
$ grep -rn "VALUE_STORE_BYTE_BUDGET_BYTES = " --include="*.ts" apps packages | grep -v /dist/
packages/shared/src/constants.ts:43:export const VALUE_STORE_BYTE_BUDGET_BYTES = 20 * 1024 * 1024;

$ grep -rn "MUST stay in sync" --include="*.ts" apps packages | grep -v /dist/
apps/api/src/slices/models/domain/estimate-run.ts:483: * (500 + Sentry). The two guards MUST stay in sync: both paths refuse identically

$ git diff HEAD -- apps/api/src/slices/models/domain/estimate-run.ts \
    | grep -E "^[-+].*(MUST stay in sync|two guards)"
(no lines — the surviving comment is untouched)
```

### Pins re-run for the no-moved-hold check

`pnpm test:shared` in full (2,962 tests) covers every B3 money pin: `turn-core.test.ts` (50
pre-existing + 5 new), `turn-options.test.ts`, `turn-options.{property,agreement,completeness,re-partition,purity}.test.ts`,
`turn-arithmetic.test.ts`. All green, none edited. On the api side the amount pins in
`estimate-run.test.ts` (73), `smart-model-turn.test.ts` (38) and
`turn-definition.test.ts` (96) are green, including
`turn-definition.integration.test.ts` › *builds a low-balance payer a capped modelCall* whose
**56,602-token** figure came from the deleted formula and is **unchanged** — the fit converges
on the same number where money binds, which is the strongest single piece of evidence that
the deletion is amount-preserving on the paid path.

---

## Deviations, with reasons

1. **`computeSafeMaxTokens` / `ComputeMaxTokensParams` deleted** (shared) — not named in the
   criteria. They were the guess's clamp step and had no other caller once it went; leaving
   dead code contradicts "grep-clean". Their two names left the walled-export lists with them.
2. **`compileSingleTurn` / `compileMultiModelTurn` exported.** Criterion 3 asks for the
   compiled definition; the alternative was to reassemble the build in the test, which would
   have re-implemented the sizing wiring it is meant to verify. Module-level export only, not
   the slice barrel.
3. **`SmartModelTurnParams.answerMaxOutputTokens` renamed to `answerCapTokens`.** It is the
   node's cap, not the deleted derivation, but keeping the name would have made the
   grep-clean evidence ambiguous forever.
4. **`answerHeadroomTokens` and its summed-rate `turnCostBasis` survive** — see §Concerns.

---

## Concerns and limitations

1. **A second summed-rate derivation remains in the same file and is load-bearing.**
   `answerHeadroomTokens` (and the `turnCostBasis` / `summedTurnPricing` it rests on) is the
   same class of arithmetic as the deleted guess — including rate arithmetic inside `apps/api`,
   which Global Constraint 4 confines to the affordability module. B4 names only the two
   functions I deleted, and `answerHeadroomTokens` cannot simply follow them: `trialReasoningSelection`
   uses its `undefined` as the trial per-message money gate, **before any definition exists for
   the canonical estimator to price**. Same shape as the blocker. It needs an owner (B6 owns the
   effort resolvers but not this) — reporting rather than widening scope.
2. **§Multi-Model 3 is not true of the api wire cap, and my change widens the gap.** A
   multi-model turn carries ONE shared cap (`buildMultiModelTurn`: "legacy applied one value to
   all slots") sized by the **tightest** sibling, so a tight-context sibling does constrain a
   wide one — the opposite of §Multi-Model 3, which the shared producer honours correctly and
   my new pin proves it honours. Previously the cap was absent for a payer who could afford the
   whole window, so the wide sibling ran to its own bound in that case; now every budgeted turn
   carries the tightest sibling's cap. Pre-existing when money binds, universal after this
   change, and holds only ever move down. The fix is per-node clamping inside `withAnswerCap`
   (each node clamped by its own `min(providerCap, contextHeadroom)`, with the shared searched
   value becoming the MAX over siblings and `fitAnswerCapToCeiling`'s early return stamping the
   cap instead of returning the definition as built). I did not do it: it changes the fit on a
   money path and moves more holds, which per criterion 8 is yours to sequence. The sweep pins
   the weaker property that no node ever carries a cap **above** its own bound.
3. **`fitAnswerCapToCeiling`'s early return assumes the caller built with `guessCap`.**
   `if (fits(guessCap)) return definition` prices `withAnswerCap(definition, guessCap)` but
   returns `definition`. Those coincide only because every caller passes the same number to the
   build and to the fit. Nothing enforces it, and it bit me while writing the sweep (a
   floor-check through the fit silently returned an unfitted definition). Latent, not live.
4. **The sweep's grid is deterministic, not randomised.** Deliberate — a seeded generator adds
   flake surface for no coverage here — but it means the 448 points are the ones I chose.
5. **Repo-wide typecheck was green at 17:29; A2 landed files after that.** Re-run before
   trusting it as current.

## Confidence

**Medium-high on what is delivered, low that B4 should land as-is.** The three verification
items are pinned by amount, each shown to fail under a targeted mutation, and the paid path's
amounts are provably unchanged (56,602 still holds). The deletion is mechanically complete
and grep-clean. But it removes the trial path's only money bound, and that needs a ruling
before any of this is safe to keep.
