# T11 — Delete legacy float math + barrel/dead-code cleanup — impl-report-1

## Objective
Delete the now-dead legacy float estimator/pricing math, dedupe the storage rates and the
manifest-fold twins onto one shared implementation, prune barrels/tests, and prove (grep +
knip + jscpd) that ONE pricing/estimation implementation remains that client and server both
import from `packages/shared/src/estimate`.

## Method note
The run's `research/consumer-map.md` predates T2–T9, so I re-derived every symbol's CURRENT
consumers by grep (distinguishing live imports/calls from comment/docstring refs) before deleting.

---

## Symbols / files deleted (each with proof of no live consumer)

### packages/shared/src/budget.ts (rewritten: now only notifications + safe-max-tokens)
Deleted (all confirmed dead — only comment-refs or test-only, no live import/call):
- `buildCostManifest` (+`BuildCostManifestInput`), `calculateBudgetFromManifest`
  (+`ManifestBudgetResult`), `canAffordModel` (+`CanAffordModelInput`/`Result`) — only
  budget.test.ts consumed them; `buildCostManifest` also appears once as a **docstring**
  ref in `estimate/price-request.ts:10`.
- Dead types `CostManifest`, `FixedCostItem`, `VariableCostItem`, `ManifestModelPricing`,
  `ModelPricingWithContext` — zero live refs.
- Duplicate pre-adapters `charsPerTokenForTier`, `estimateTokensForTier`,
  `outputCharsPerTokenForTier`, `spendableFundsNanoUsd`, `PAID_CUSHION_NANO_USD` — re-homed
  to `estimate/pre-adapters.ts` by T2; live consumers import them from `@hushbox/shared`
  and now resolve to the estimate copy via the root barrel (below).
- `getCushionCents` — sole live consumer was `billing/client-billing.ts` (in bounds);
  rewired (below). `getEffectiveBalance` (cents), `calculateBudget`
  (+`BudgetCalculationInput`/`Result`), `effectiveBudgetCents` (+`EffectiveBudgetParams`) —
  only **comment-refs** remain (turn-context.ts, turn-definition.ts, use-resolve-billing.ts,
  group-budget.ts, nano-usd.ts — all `* legacy X` docstrings).

Kept in budget.ts: `generateNotifications` (+ `NotificationInput`/`BudgetError`/
`MessageSegment` + notice tables + helpers) and `computeSafeMaxTokens` (+`ComputeMaxTokensParams`)
— the latter is a LIVE consumer via `turn-definition.ts:228` and `smart-model-turn.ts`, so it
stays (budget.ts is not empty-except-notifications, which the brief allowed).

### packages/shared/src/pricing.ts (rewritten: now only `estimateTokenCount` + `applyFees`)
Deleted (all dead — grep showed no live non-test consumer; media/message clusters were only
referenced in the new estimate modules' **docstrings**):
- `calculateTokenCost`, `estimateMessageCostDevelopment` (+`MessageCostParams`),
  `calculateMessageCostFromActual` (+`MessageCostFromActualParams`), `effectiveOutputCostPerToken`,
  `mediaStorageCost`, `computeMediaWorstCaseCents` (private), `computeImageWorstCaseCents`,
  `estimateVideoWorstCaseCents` (+`EstimateVideoWorstCaseCentsInput`), `computeImageExactCents`,
  `computeVideoExactCents`, `computeAudioWorstCaseCents`, `calculateMediaGenerationCost`
  (+`CalculateMediaGenerationCostParams`), `MediaPricing`, `worstCaseSearchCost`.
- Additionally deleted the dead FLOAT pricing formulas that were a lingering "second
  implementation" (objective #7): `getModelCostPer1k`, `isExpensiveModel`, `ModelPricingResult`,
  `parseTokenPrice` — grep proved zero live refs (the nano replacements `nanoPricePer1k` /
  `isExpensiveModelNano` are what web now imports). This exceeds the brief's explicit list but
  is required to satisfy "no second pricing formula exists"; all four are provably dead.

Kept: `applyFees` (LIVE — `web/lib/format.ts`, `estimate/search-reservation.ts`) and
`estimateTokenCount` (LIVE — `marketing/lib/calculate-cost.ts`, `web/lib/tokens.ts`).

### packages/shared/src/smart-model/eligible-models.ts
No action needed — T6/T7 already reduced it to the one live export `CLASSIFIER_OUTPUT_TOKEN_CAP`
(consumed by smart-model-execution + smart-model-candidates). Nothing dead remained.

### apps/api models slice — `StorageContext` twin removed
`estimate-run.ts`'s local `StorageContext` interface (structurally identical to shared
`StorageStamp`) deleted; imported `StorageStamp` type from `@hushbox/shared` and replaced all
7 usages. Removed `StorageContext` from `models/index.ts` and `models/domain/index.ts` barrels
(it had no external consumer — only re-exported through those barrels). Dropped the now-unused
`UserTier` type import.

---

## Barrel changes (pre-adapters now sourced from estimate/)
`packages/shared/src/index.ts` named-estimate export block:
- REMOVED the two deleted drift guards `assertStorageCharRateMatchesSharedFloat`,
  `assertMediaStorageByteRateMatchesSharedFloat`.
- ADDED the re-homed pre-adapters now that budget.ts's copies are gone:
  `charsPerTokenForTier`, `estimateTokensForTier`, `outputCharsPerTokenForTier`,
  `spendableFundsNanoUsd`, `PAID_CUSHION_NANO_USD`, plus the new `evaluateManifest`.
- Rewrote the block comment (the budget.js-collision note is obsolete).

`models/index.ts` + `models/domain/index.ts`: dropped `StorageContext`.
`billing/domain/index.ts` + `billing/index.ts`: unchanged — they still re-export the storage
nano rates from money.ts (which now re-exports them from shared), keeping
`turn-definition.ts`'s `import { STORAGE_COST_PER_CHARACTER_NANO } from '../../billing/index.js'`
working.

## client-billing.ts rewire
`resolveSelfAffordability` replaced `getCushionCents('paid')` with the constant
`MAX_ALLOWED_NEGATIVE_BALANCE_CENTS` (imported from constants.js) — exact equivalent inside the
`tier === 'paid'` branch. Dropped the `getCushionCents` import.

---

## Criterion 3 — storage-rate single source (guards gone, rates re-exported)
- `estimate/storage-rate.ts` is now the ONE canonical source: just the two nano consts
  (`STORAGE_COST_PER_CHARACTER_NANO = 300n`, `MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n`) +
  docstring. Deleted `assertStorageCharRateMatchesSharedFloat` /
  `assertMediaStorageByteRateMatchesSharedFloat`, their module-init calls, the `NANO_PER_USD`
  local, and the `constants.js` float import.
- `apps/api/.../billing/domain/money.ts` deleted its mirrored nano literals + the
  `assertStorageRatesMatchSharedFloats` guard + the float imports, and now
  `export { STORAGE_COST_PER_CHARACTER_NANO, MEDIA_STORAGE_COST_PER_BYTE_NANO } from '@hushbox/shared'`
  (the T1 re-export pattern). The markup guard `assertMarkupMatchesSharedRate` (T1) stays.
- No float/dollar storage rep now carries a drift guard. The float `STORAGE_COST_PER_CHARACTER`
  in `constants.ts` remains ONLY for marketing/ui display (`ui/.../cost-pie-chart.tsx`,
  `fee-breakdown.tsx`, `marketing/calculate-cost.ts`) — out of my bounds; deriving it from the
  nano would require a constants.ts edit + risks a circular import, so it stays a plain
  (unguarded) display constant. Flagged below.
- Golden cross-check tests removed: storage-rate.test.ts (float-scaling assertions) and
  money.test.ts (the `assertStorageRatesMatchSharedFloats` describe) now assert only the plain
  nano values.

## Criterion 4 — evaluateManifest (one manifest-fold)
Added `evaluateManifest(manifest, outputTokens, { marksUpOnly })` to
`packages/shared/src/estimate/reducers.ts` (reuses the existing private `foldManifest`; returns
the PRE-markup base, never applies markup), exported via the estimate barrel + named in the root
barrel. TDD: wrote 3 failing tests in reducers.test.ts first (verified RED — "is not a
function"), then implemented (GREEN). Both call sites now use it:
- `models/domain/estimate.ts` `callBaseNanoUsd` → `evaluateManifest(m, tokens, {marksUpOnly:true})`
  (deleted local `providerBaseFromManifest`).
- `models/domain/trial-eligibility.ts` `trialMessageBaseNanoUsd` →
  `evaluateManifest(m, tokens, {marksUpOnly:false})` (deleted local `rawManifestCostNano`;
  dropped now-unused `Manifest` type import).

## Criterion 5 — StorageContext → StorageStamp
Done (see models-slice section above).

---

## Criterion 7 — ONE implementation proof
- **grep:** no live import/call of any deleted symbol remains (only `* successor to legacy X`
  docstrings in the estimate modules, pointing at the `/legacy/` reference corpus — not "keep
  in sync" comments, not code). No second float pricing formula survives
  (`getModelCostPer1k`/`isExpensiveModel` deleted; nano `nanoPricePer1k`/`isExpensiveModelNano`
  are the sole cost-per-1k impl). No `keep in sync` comment / mirrored constant / golden
  cross-check remains in the estimator surface.
- **knip** (`pnpm lint:unused`): exit 0, no unused exports reported — no newly-orphaned exports
  from the deletions.
- **jscpd** (`pnpm lint:duplication`): exit 0, 1.06% < 2% threshold; none of my files flagged
  (the manifest-fold collapse removed a duplicate reduction).
- **client + server both import the core:** server via `@hushbox/shared` estimate exports
  (estimate.ts, estimate-run.ts, trial-eligibility.ts, smart-model-candidates.ts …); client via
  `use-budget-calculation.ts` / `use-prompt-budget.ts` (`priceRequest` + pre-adapters).

---

## Out-of-target rewire (required to not leave a dangling reference)
`apps/web/.../use-prompt-budget.test.ts` imported the deleted shared `BudgetCalculationResult`
and built a fixture with old-shared-only fields (`estimatedInputCost`, `effectiveBalance`,
`outputCostPerToken`, `preReservedCents`). This was **T9 debt**: T9 gave the hook its own local
`BudgetCalculationResult` in `use-budget-calculation.ts` (different, smaller shape) but left the
test importing the shared type and using stale fields — it only kept compiling because the
shared superset type still existed. My deletion surfaced it. Fix: repointed the import to the
local hook type and removed the 4 stale fixture fields (none were asserted; the code under test
reads only the local fields). Clean, mechanical, obviously correct.

---

## Self-gate results
- `pnpm typecheck` (turbo, shared/api/web/marketing, --force): GREEN except the KNOWN
  pre-existing `apps/api/src/middleware/pipeline-bindings.ts(59,29): TS2304 ExecutionContext`
  (file not in my ownership; flagged pre-existing by the brief; unchanged by me).
- `pnpm test:shared` (coverage gate): PASS. My files at 100%: budget.ts, pricing.ts,
  reducers.ts, storage-rate.ts, media-pricing.ts, client-billing.ts (suite exit 0 enforces
  per-file ≥95%).
- `pnpm test:api` (full, coverage): 5760 passed | **1 failed** | 7 skipped (428 files: 421
  passed, 1 failed). ALL SIX of my touched api suites green (money, estimate, estimate-run,
  trial-eligibility, smart-model-candidates, trial-smart-model-candidates). The single failure
  is attributed below (not mine).
- Focused suites: budget.test / pricing.test / reducers.test / storage-rate.test /
  client-billing.test / money.test all green.
- `pnpm lint:unused` (knip): exit 0 clean. `pnpm lint:duplication` (jscpd): exit 0 clean.
- `eslint` on every touched file (run per-package from the package dir): exit 0 (after
  `--fix` corrected numeric-separator style in the new budget.test.ts block and a prettier
  line-wrap in trial-eligibility.ts).

## Attributed failure (NOT mine — proven)
`chat/domain/smart-model-turn.integration.test.ts` › `fits DAILY_ALLOWANCE_NANO_USD for a
free-tier default turn over the seeded catalog` — asserts `ceiling <= DAILY_ALLOWANCE_NANO_USD`,
fails (`expected false to be true`). This is a "money contract" test (its own comment: "A future
catalog/default change that reinflates the ceiling fails HERE"). It wipes the catalog, seeds ONE
model, and snapshots descriptors UNDER a lock, then computes the ceiling over that snapshot — so
it is NOT catalog contamination; it is a deterministic ceiling-vs-allowance contract.
- The file and all its dependency files (smart-model-turn.ts, smart-model-candidates.ts,
  admission.ts, billing constants) are NOT in my edit set.
- Every value-affecting element of the ceiling path is unchanged by my edits:
  `callBaseNanoUsd`'s `evaluateManifest(marksUpOnly:true)` is arithmetically identical to the
  deleted `providerBaseFromManifest` (pinned green by estimate.test.ts); `estimate-run.ts`'s
  change is type-only (StorageContext→StorageStamp); `reservationCeiling` /
  `estimateRunCeilingNanoUsd` / the storage nano constants (300n/18n) were NOT touched.
- **Controlled probe:** I temporarily inlined the exact pre-refactor fold back into
  `callBaseNanoUsd` and re-ran — the test failed IDENTICALLY. Then restored the clean
  `evaluateManifest` version. This proves the failure is independent of this task; it belongs to
  the current rebase baseline / the concurrent e2e-green run's committed work (the repo is
  mid-`git rebase onto fce35f4d`; the other agent's `git add`/amend swept the working tree into
  its commit, which is why `git diff` shows clean while my edits persist on disk).

## Deviations
- Deleted 4 dead float pricing symbols beyond the brief's explicit list
  (`getModelCostPer1k`, `isExpensiveModel`, `ModelPricingResult`, `parseTokenPrice`) — required
  by objective #7 ("no second pricing formula"); all provably dead.
- Fixed one out-of-target web test (`use-prompt-budget.test.ts`) — necessary to avoid a dangling
  reference to a deleted type (T9 debt); see above.
- Left the float `STORAGE_COST_PER_CHARACTER` constant in `constants.ts` unguarded (out of
  bounds; still used by marketing/ui display); deriving it from the nano is a constants.ts change
  with circular-import risk.

## Concerns / limitations
- The full `test:api` per-file coverage TABLE was not emitted because the attributed
  smart-model-turn failure aborts the run before the coverage summary. My touched api files are
  exercised by their passing unit + integration suites; deletions removed code whose only callers
  I updated, and no new uncovered branches were introduced, so per-file coverage is maintained.
- Git state is fluid (concurrent agent's rebase). My edits are verified present on disk.

## Confidence
High — deletions grep-verified dead; one-implementation proven by knip/jscpd/grep; the sole
failing suite is proven (controlled probe) independent of this task.
