# Task 04 — Port billable conversion + consumer deletion sweep — impl report 1

## Objective

Inline `usage.cost` converts to billable exactly once at the ModelProvider port
boundary (half-even); every remaining fee application outside the two seams
(catalog ingestion, port conversion) deleted. Includes A6 (transitional
web-search base export + api WORST_CASE wrapper deleted) and A7
(`toPoolCandidate` spreads `limits.maxOutputTokens`).

## Port helper (the one conversion)

`providerUsdToBillableNanoUsd(usd: number): bigint` in
`apps/api/src/slices/billing/domain/money.ts`, exported through the billing
domain barrel and `apps/api/src/slices/billing/index.ts`. Composition is
exactly `applyMarkup(usdToNanoUsd(usd))` — the identical two half-even
roundings, in the identical order, the retired charge-side path performed —
so bit-identity holds **by construction**, and is pinned (below). It is
injected into the node executions as `ModelCallStreamDeps.usdToBillableNanoUsd`
(node purity: no slice-barrel value imports in nodes), wired at
`live-execution-registry.ts` for both `modelCall` and `smartModel`.

- `decideCost` now receives/produces billable: the inline path converts via
  the injected helper; the sanity multiple (`PROVIDER_COST_SANITY_MULTIPLE`)
  now compares billable-inline against the billable catalog estimate
  (fee-free ratio, both sides carry the same baked fee).
- Missing/absurd-cost fallback and the image path bill the billable catalog
  estimate DIRECTLY (`binding.price`/`priceMedia` fold billable catalog rates;
  `chargeWithinTx` applies nothing further).
- The aborted-partial settle path converts through the same helper.

## Files changed (path — why)

Production:

- `apps/api/src/slices/billing/domain/money.ts` — the port conversion helper (the only new fee-bearing code).
- `apps/api/src/slices/billing/domain/index.ts`, `billing/index.ts` — export helper; `applyMarkup` removed from the billing public barrel (no production consumer remains; the helper imports it from shared directly).
- `apps/api/src/slices/billing/domain/charge.ts` — `applyMarkup` deleted; `ChargeInput.baseCostNanoUsd` → `billableCostNanoUsd`; charge = billable + storage.
- `apps/api/src/slices/chat/domain/settlement.ts` — display-mirror markup (old :477) deleted; mirror = `billableCost + storageFee`, still the identical value `chargeWithinTx` debits.
- `apps/api/src/slices/workflows/nodes/model-call-execution.ts` — dep renamed `usdToBillableNanoUsd`; `validInlineBase` → `validInlineBillable`; docs rewritten billable.
- `apps/api/src/slices/workflows/engine/live-execution-registry.ts` — injects the helper (both node kinds).
- `apps/api/src/slices/workflows/engine/execution-registry.ts`, `interpreter.ts`, `nodes/smart-model-execution.ts`, `engine/settlement.ts`, `packages/shared/src/flow-executor.ts` — `baseCostNanoUsd` → `billableCostNanoUsd` through the whole charge-facts chain (`NodeGenerationCharge`, `SettlementCharge`, `chargeInputFor`), comments updated (wrong names are wrong comments).
- `apps/api/src/slices/chat/domain/trial.ts` — folds `billableCostNanoUsd` into the trial daily counter; comment updated: raw provider cost is not retained past the port, so the billable figure is the only spend record (~15% overstatement of platform spend tightens the abuse cap — the ruled, accepted direction).
- `apps/api/src/slices/chat/domain/turn-definition.ts` — the two per-rate `applyMarkup` sums deleted (rates arrive billable); docs updated.
- `apps/api/src/slices/models/domain/estimate.ts` — `WORST_CASE_SEARCH_RESERVATION_NANO_USD` + `applyMarkup` import deleted; `estimateCallNanoUsd` (post-change identical to the pure fold, zero production consumers) deleted; `callBaseNanoUsd`/`priceMediaBaseNanoUsd`/`priceUsageBaseNanoUsd` renamed `…Billable…` (they now return billable; the old names were lies).
- `apps/api/src/slices/models/domain/estimate-run.ts` — web-search worst case now the shared `WEB_SEARCH_RESERVATION_NANO_PER_MODEL` directly (numerically identical: 57,500,000n exactly).
- `apps/api/src/slices/models/domain/smart-model-candidates.ts` — the double-markup wrapper deleted; `classifierWorstCaseBaseNanoUsd` renamed `classifierWorstCaseNanoUsd` (billable); `pickEffortClassifier` reserve = the billable figure; **A7**: `toPoolCandidate` spreads `limits['maxOutputTokens']`; `combinedBasePrice` → `combinedRate`.
- `apps/api/src/slices/models/domain/trial-smart-model-candidates.ts` — result field renamed `classifierWorstCaseNanoUsd`; comments billable.
- `apps/api/src/slices/models/domain/trial-eligibility.ts` — no fee application existed here (already all-in over billable rates); renames only: `trialMessageBaseNanoUsd` → `trialMessageBillableNanoUsd`, `combinedBasePrice` → `combinedRate`, `callBillableNanoUsd` import, docs. The ~15% trial-basis tightening landed at T02 (billable rates); accepted per ruling.
- `apps/api/src/slices/models/domain/index.ts`, `models/index.ts`, `chat/domain/index.ts`, `chat/routes.ts`, `workflows/engine/model-resolver.ts` — mechanical rename ripples.
- `apps/api/src/platform/dev/seed-billing-history.ts` — `applyMarkup` deleted; `UsageSpec.billableCostNanoUsd`; charged = billable + storage (mirrors chargeWithinTx).
- `scripts/seed.ts` — passes `billableCostNanoUsd` (fixture values unchanged; `scripts/lib/seed-fixtures.ts` keeps its `baseCostNanoUsd` field name — there it means "baseline the picker varies around", not provider-vs-billable, and it feeds the spec's plain `costNanoUsd`).
- `apps/web/src/hooks/billing/use-budget-calculation.ts` — `applyMarkup` deleted; effective per-output-token rate = the all-in manifest delta (billable + storage), a pure derivation.
- `apps/marketing/src/lib/calculate-cost.ts` — `applyMarkup` deleted; wire rates are billable; docs updated.
- `packages/shared/src/estimate/search-reservation.ts` + `packages/shared/src/index.ts` — **A6**: transitional `WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL` export deleted; the billable constant is defined directly over the search constants (value unchanged).

## Per-deletion-site disposition (all sites)

| # | Site | Old fee application | Disposition |
|---|------|--------------------|-------------|
| 1 | billing/domain/charge.ts:76 | `applyMarkup(base) + storage` | deleted — charge = billable + storage |
| 2 | chat/domain/settlement.ts:477 (display mirror) | `applyMarkup(base) + storage` | deleted — mirror = billable + storage |
| 3 | chat/domain/turn-definition.ts:185-186 | per-rate `applyMarkup` in summed sizing rates | deleted — rates billable |
| 4 | models/domain/estimate.ts:40 (WORST_CASE) | `applyMarkup(BASE)` | deleted with the shared BASE export (A6); consumer uses shared billable constant |
| 5 | models/domain/estimate.ts:238 (estimateCallNanoUsd) | `.map(applyMarkup)` over billable fold | function deleted (identical to `callBillableNanoUsd`, zero production consumers) |
| 6 | models/domain/smart-model-candidates.ts:146 | `applyMarkup(billable reserve)` (interim double markup) | wrapper deleted — reserve is the billable figure |
| 7 | models/domain/trial-eligibility.ts | none existed (all-in fold already billable) | renames/docs only; tests were already green at billable values |
| 8 | platform/dev/seed-billing-history.ts:112 | `applyMarkup(base) + storage` | deleted — billable + storage |
| 9 | web use-budget-calculation.ts:129 | `applyMarkup(providerVariable) + rawVariable` | deleted — all-in variable delta |
| 10 | marketing calculate-cost.ts:61 | `applyMarkup(tokenBase) + storage` | deleted — billable sum + storage |

Post-sweep grep: production `applyMarkup` call sites are exactly the two seams —
`normalize.ts` (`applyMarkupCeil`, ingestion), `billing/domain/money.ts` (the
port helper) — plus the definition-time bakes (`search-reservation.ts`
`applyMarkupCeil`, `scripts/lib/e2e-seeded-image-model.ts` `applyMarkupCeil`,
both baking billable constants/fixtures, both pre-existing T03/T02 decisions
for T05's seam rule to adjudicate). Tests use `applyMarkup` from
`@hushbox/shared` only to construct billable fixtures/expectations.

## A3 sweep — changed contracts, repo-wide

Contracts changed: `SettlementCharge.billableCostNanoUsd` (shared
flow-executor), `ChargeInput.billableCostNanoUsd`, node dep
`usdToBillableNanoUsd`, renamed estimate/candidate exports, deleted
`WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL` / `WORST_CASE_…` /
`estimateCallNanoUsd` / billing-barrel `applyMarkup`.

Greps (`baseCostNanoUsd`, `WORST_CASE_SEARCH`, `WEB_SEARCH_RESERVATION_BASE`,
`estimateCallNanoUsd`, `callBaseNanoUsd`, `priceMediaBaseNanoUsd`,
`priceUsageBaseNanoUsd`, `classifierWorstCaseBaseNanoUsd`,
`trialMessageBaseNanoUsd`, `usdToNanoUsd` in workflows) across `apps/`,
`packages/`, `scripts/`, `e2e/`: zero stale references. `e2e/` and
`apps/admin` had none to begin with (verified). Producers updated:
interpreter, smart-model-execution, engine settlement, chat settlement, trial,
seed-billing-history, `scripts/seed.ts`. `scripts/lib/seed-fixtures.ts`
retained (different semantics — documented above). Repo-wide `pnpm typecheck`:
13/15 tasks pass; the single failure is outside this task (see Concerns).

## Tests added / re-pinned (test — behavior — criterion)

- `billing/domain/money.test.ts` › `providerUsdToBillableNanoUsd` (new, watched red):
  **bit-identity pin** — for 10 recorded-scale provider inline costs the helper
  equals `applyMarkup(usdToNanoUsd(usd))` bit-exactly; half-even midpoint pins
  incl. divergence-vs-ceil cases (30 nano → 34 not 35; 2 nano → 2 not 3);
  zero; negative/non-finite rejection. → port-helper + half-even criteria.
- `billing/domain/charge.integration.test.ts` (red first — field/behavior):
  charges the billable amount as given (no further markup); **image charge
  value pin** — an image charge equals its deterministic billable catalog
  estimate EXACTLY (the interim ~+32% double markup is dead); all previous
  charged-total expectations kept literally unchanged with inputs relocated to
  `applyMarkup(x)` — same numbers, markup moved. → chargeWithinTx criterion.
- `workflows/nodes/model-call-execution.test.ts` (red first): all cost
  expectations re-pinned to `providerUsdToBillableNanoUsd(usd)`; image path
  still bills the media estimate directly with `isEstimated: true`, no alert.
- `models/domain/smart-model-candidates.test.ts` (red first): **A7 cap pin** —
  a rich-wallet candidate with `limits.maxOutputTokens: 1500` (context 8000)
  gets cap exactly 1500 (without the key: full remaining context);
  `pickEffortClassifier` reserve re-pinned to the billable figure (no markup).
- `workflows/engine/smart-model.integration.test.ts`: the fee-rate
  reconstruction (basis-point mirror — a sync contract) REWRITTEN against the
  port helper: the answer charge must equal
  `providerUsdToBillableNanoUsd(<terminal finish event's providerCostUsd>)`
  bit-exactly (the run's emitted events are now captured); classifier charge
  asserted billed-positive (it streams emit-free, so its raw cost is
  unobservable here — the port unit pins cover the conversion).
- `chat/domain/settlement.integration.test.ts`, `settlement.fuzz…`,
  `trial-settlement…`, engine `settlement.test.ts`,
  `seed-billing-history.integration.test.ts`: field renamed; every expected
  charged total kept literally unchanged (inputs wrapped `applyMarkup(x)`) —
  the settlement-level bit-identity evidence.
- `chat/domain/turn-definition.test.ts` / `.integration.test.ts` /
  `smart-model-turn.test.ts`: ceiling pins recomputed against billable rates
  with full derivations in comments (e.g. paid 49_557 → 56_573; free 3_891 →
  4_417; multi 16_784 → 19_207; integration 49_585 → 56_602; smart 2_023 →
  2_315, 1_609 → 1_843) — ceilings grow ≈15% because the sizing guess no
  longer double-marks already-billable rates; admission still prices the same
  billable estimator, so reserve ≥ charge is unchanged.
- `models/domain/estimate.test.ts`: rewritten to the renamed surface;
  `estimateCallNanoUsd`'s validation coverage moved to `callBillableNanoUsd`;
  WORST_CASE tests dropped with the constant.
- `shared estimate/search-reservation.test.ts`: base-export tests folded into
  the billable-constant pin (57,500,000n exact, ceil-at-definition).
- `web use-budget-calculation.test.ts` (red first): surcharge rate = billable
  output rate + storage (no client-side fee math).
- `marketing calculate-cost.test.ts` (red first): monthly cost = pure billable
  sum + storage, exact-value pin.

Cassette note: no charged real calls were needed; the bit-identity evidence is
(a) the helper-composition pin over recorded-scale cost fixtures and (b) the
settlement suites' unchanged expected totals — per the brief's sanctioned
fallback. `smart-model.integration.test.ts` runs its deterministic local
provider (same finish contract as the cassette path).

## Self-gate

- `pnpm test:shared` (turbo, --force): 104 files / 2340 tests pass, coverage gate green.
- `pnpm test:api` (turbo, --force, run 3): 447 passed / **2 failed files, both attributed, not mine**:
  - `notifications/domain/templates/template-html.test.ts` (7) — pre-existing snapshot failure listed in Amendment A1; file untouched.
  - `models/adapters/language-adapter.test.ts` (1, "pins the canonical request shape … cassette baseline" descriptor-hash pin) — **concurrent lane**: passed in my run 2, failed in run 3 with `packages/shared/src/prompt/*` modified in the working tree by another lane (git status evidence); I touched neither the adapter nor any prompt file.
  - Run 1 additionally showed ~229 failures with `relation "users" does not exist` (42P01) across dozens of unrelated files; every sampled file passes in isolation and run 2/3 cleared them — transient environmental (schema briefly absent mid-run, likely a concurrent reset); not chased per A1 doctrine.
- `pnpm test:web` (turbo, --force): 368 files / 6073 tests pass.
- marketing test (turbo, --force): 50 files / 452 tests pass.
- Repo-wide `pnpm typecheck` (A3): 13/15 pass; sole failure `@hushbox/web` — `use-prompt-budget.ts(8,3) TS6133 'payerSizingTier' unused` — a concurrent lane's in-flight edit to a file explicitly outside my Files list (A7 bars it from this task); file untouched by me.
- eslint: `eslint --fix` then a plain `eslint` verification, run from each
  package dir (apps/api owned slice dirs + platform/dev; apps/web,
  apps/marketing, packages/shared owned files) AFTER the final edit — exit 0
  everywhere. Key unit clusters re-run green post-format (282/282).
- `pnpm arch:check`: 1 violation, **not mine** — `[single-writer-per-table]
  table 'notificationPreferences' has no owning slice` from a concurrent
  lane's untracked `packages/db/src/schema/notification-preferences.ts` (+
  modified db schema files); no db schema file is in this task's set.

## Deviations (with reasons)

1. **Out-of-Files-list mechanical edits**, sanctioned by A3's contract-sweep
   rule (T03 precedent): `live-execution-registry.ts`, `execution-registry.ts`,
   `interpreter.ts`, `smart-model-execution.ts`, `engine/settlement.ts`,
   `engine/model-resolver.ts` (+ test), `packages/shared/src/flow-executor.ts`,
   `packages/shared/src/index.ts`, `estimate-run.ts`,
   `trial-smart-model-candidates.ts` (+ test), `chat/routes.ts`,
   `chat/domain/index.ts`, `chat/domain/trial.ts` (+ test), models barrels,
   `scripts/seed.ts`, `search-reservation.ts` (A6 explicitly orders this
   deletion), and downstream test files listed above. Zero behavior added at
   any of them beyond the renames/deletions the contract change forces.
2. **`estimateCallNanoUsd` deleted** rather than kept as an alias — after the
   markup drop it was byte-equivalent to `callBillableNanoUsd` and had no
   production consumer; keeping it would be a second name for one function.
3. **Billing barrel no longer exports `applyMarkup`** — no production consumer
   remains; tests now import it from `@hushbox/shared`. T05's seam rule gets a
   cleaner surface.
4. **`trial.ts` daily counter now folds billable** (was "Σ base — what WE
   spent"). Forced: raw provider cost is not retained anywhere post-port
   (BILLING §Fee Structure) and un-marking is banned. Effect: the trial abuse
   cap tightens ~15% (counter overstates platform spend) — same accepted
   direction as the ruled trial tightening. Flagged for the auditor.
5. **Sanity-multiple boundary shifted ~15%**: previously base-inline vs
   billable-estimate (effective threshold 1000×1.15); now billable vs billable
   (exact 1000×). Strictly a tightening of a deliberately-generous corrupt-cost
   guard (legit worst case ~4.4×); behavior change is unobservable outside
   pathological inputs.

## Concerns and limitations

- The web typecheck failure and the language-adapter hash-pin failure are
  concurrent-lane working-tree state; if that lane's work is reverted rather
  than finished, both clear on their own. Neither is fixable from my file set
  without touching another task's files.
- Seeded dev billing history charges change ~−13% in displayed totals (seed
  fixture values are now charged as-is instead of marked up) — dev-only
  cosmetic data.
- `contentItems.costNanoUsd` display mirror and `usage_records.costNanoUsd`
  remain equal by construction (same summands) — pinned by the existing
  Σ-content == Σ-usage tests, all green.

## Confidence

High — every fee-application site is deleted with a red-first or
literally-unchanged-total pin; the port helper is bit-identical by
construction and by test; full shared/web/marketing suites green; api green
except two attributed failures.
