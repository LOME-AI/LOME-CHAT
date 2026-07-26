# B1b — Close the export wall (removal half) — implementation report 1

## Objective

Make `docs/BILLING.md` §Where the Code Lives' "deliberately **not** exported" list true of **both**
entry points — the package root barrel and the `@hushbox/shared/affordability` subpath — using only
producers that exist today, and enumerate every consumer the closure broke.

---

## The wall, resolved from categories to symbols

`BILLING.md` states the list as eight categories. Resolving it against the module's declarations
gives **67 symbols** (39 value exports, 28 type-only). The mapping is written into
`packages/shared/src/affordability/index.test.ts` (`WALLED_EXPORTS`), grouped in the doc's own order
so a reader can check the mapping rather than trust it:

| Doc category                      | Symbols                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the minimum-answer constant       | `MINIMUM_OUTPUT_TOKENS`                                                                                                                                                                                                                                                                                                                                                        |
| tier ratios                       | `CHARS_PER_TOKEN_CONSERVATIVE`, `CHARS_PER_TOKEN_STANDARD`, `charsPerTokenForTier`, `estimateTokensForTier`, `outputCharsPerTokenForTier`                                                                                                                                                                                                                                       |
| the reasoning-budget ladder       | `REASONING_BUDGET_FLOOR_TOKENS`, `REASONING_BUDGET_TOKENS_BY_EFFORT`, `OfferedLevel`, `offeredLevels`                                                                                                                                                                                                                                                                          |
| rates                             | `ModelRatesNano`, `ratesFromPricing`, `SEARCH_COST_PER_CALL`, `WEB_SEARCH_RESERVATION_NANO_PER_MODEL`                                                                                                                                                                                                                                                                          |
| manifests                         | `BillableRequest`, `Manifest`, `NanoLineItem`, `MediaBillable`, `MediaRateKey`, `ClassifierStage`, `NodeStorage`, `NO_STORAGE`, `buildMediaLineItems`, `callManifest`, `classifierLineItems`, `classifierReserveChars`, `classifierReserveLineItems`, `priceRequest`, `webSearchLineItem`                                                                                        |
| reducers                          | `Affordability`, `affordability`, `evaluateManifest`, `ReservationCeilingInput`, `reservationCeiling`, `ClassifierAnswerParts`, `parseClassifierAnswer`, `pickClassifiedEffortPlan`, `resolveClassifiedEffort`, `resolveClassifierOutput`                                                                                                                                        |
| per-candidate ceiling solvers     | `DeclaredCeiling`, `estimateRunCeilingNanoUsd`, `PromptCapacity`, `PromptCapacityInput`, `computePromptCapacity`, `PricedSmartModelCandidate`, `PricedSmartModelPool`, `SmartModelAdmission`, `SmartModelCandidateId`, `SmartModelCappedCandidate`, `SmartModelPoolCandidate`, `SmartModelStorageContext`, `admitSmartModel`, `priceSmartModelPool`, `smartModelMinimumRequiredNanoUsd`, `ReasoningInfeasibleReason`, `ReasoningPlan`, `ReasoningPlanResult`, `planReasoning`, `planReasoningOff`, `EffortOption`, `ResolvedEffort`, `offeredEffortLabels`, `resolveEffortForModel`, `turnEffortOptions` |
| clamping                          | `ComputeMaxTokensParams`, `computeSafeMaxTokens`, `validCap`                                                                                                                                                                                                                                                                                                                   |

Two categories required a judgment on where the line falls. Both are recorded here because an
auditor should agree or disagree with the reason, not with the outcome:

- **"rates" excludes the storage rates and the fee-rate floats.** `STORAGE_COST_PER_CHARACTER_NANO`
  and `MEDIA_STORAGE_COST_PER_BYTE_NANO` stay published because §Where the Code Lives names *the
  storage-fee function* as a kept structural seam and §Storage Fees designates those two constants as
  the single source settlement adds without markup — walling them with no producer would make a
  normative clause false. The fee-rate and storage cost-model floats (`TOTAL_FEE_RATE`,
  `MONTHLY_COST_PER_GB`, …) are the marketing/legal fee-breakdown display data behind
  `FEE_CATEGORIES`, which the not-exported list does not mention. `format.ts`
  (`nanoPricePer1k`, `nanoPriceRangePer1k`, `nanoUnitPriceUsd`, `isExpensiveModelNano`) stays as the
  money-formatting seam plus model classification.
- **`MAX_SEARCH_TOOL_CALLS` stays; `SEARCH_COST_PER_CALL` goes.** The first is a provider-protocol
  call cap the inference adapter passes to the AI SDK's `stopWhen`; the second is a per-call USD
  rate. Only the second is a rate.

Kept for stated reasons, though adjacent: `EstimateResult`/`EstimateError`/`EstimateErrorCode`/
`estimateOk`/`estimateErr` (the fail-closed result channel), `CallUsage`/`outputTokensOf` (provider
usage → token count at settlement), `ReasoningWire`/`REASONING_OFF_WIRE`/`reasoningBudgetForWire`
(the wire fragment `wireFor` will construct), `reasoningPlanModelFrom`/`ReasoningPlanModel`/
`ReasoningPlanDescriptorInput` (the narrow `PriceableModel` projection the doc calls load-bearing),
`EffortChoice` (turn-level vocabulary), `generateNotifications` (B7's `notices` precursor), and
`buildClassifierSystemPrompt` (the ruled named structural seam — untouched).

---

## Absence, per entry point, symbol by symbol

Two independent results, as the criteria require — not one combined pass. Both live in
`packages/shared/src/affordability/index.test.ts`.

Each entry point gets **two** assertions per symbol, because runtime and compile-time see different
halves of a barrel:

- `does not bind <name>` — `Object.hasOwn(barrel, name) === false`, over the 39 **value** exports.
  This is the runtime import the plan's G1 note describes.
- `does not publish <name>` — over **all 67**, against the export graph resolved from the barrel
  source by walking `export *` chains with the TypeScript parser. 28 of the 67 are type-only and have
  no runtime binding at all, so `Object.hasOwn` is vacuous for them; this assertion is what holds them
  to account.

Each block carries a **positive control** (`walks 'export *' chains, so absence below means absence`)
asserting the resolver finds a starred value (`getUserTier`), a starred **type**
(`FundingDecision` — proving type coverage is real), and does *not* find a name that is genuinely
absent (`truncateForClassifier`). Without it a resolver that silently walked nothing would report the
wall closed.

| Entry point                          | Result                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `@hushbox/shared/affordability`      | 67/67 absent (39 bind-assertions + 67 publish-assertions), positive control passes |
| `@hushbox/shared` (package root)     | 67/67 absent (39 bind-assertions + 67 publish-assertions), positive control passes |

Verified red first: with the barrels untouched, the two blocks produced **210 failures**
(`Tests 210 failed | 45 passed`) while both positive controls passed — the failures were the wall
symbols being present, not the harness being broken. After the barrel edits: 268 passed, 0 failed.

`validCap` was already absent from the root barrel before this task and present on the module barrel;
it failed on one entry point and passed on the other, which is exactly the "absent from one and
present in the other is a failure, not a partial pass" case the criteria call out.

### Where the closure is expressed

Closing only the outer barrels would have left the leak in place, because both of them `export *` two
internal barrels. The wall is therefore expressed at the file that declares the re-export nearest the
unit:

| File                                            | Change                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `affordability/estimate/index.ts`               | stopped being a directory barrel; publishes the result channel, funding pre-adapters, storage rates, wire fragment and formatters, and nothing else |
| `affordability/smart-model/index.ts`            | `resolve.js` line dropped; `effort-dimension.js` reduced to `CLASSIFIER_EFFORT_LEVELS` + its type              |
| `affordability/index.ts`                        | `constants.js` and `budget.js` converted from `export *` to named lists                                            |
| `packages/shared/src/index.ts`                  | same two named lists; the estimator's named blocks reduced to the published surface                                |

Expressing the estimate/smart-model half one level down avoids duplicating a 90-name list across two
outer barrels — the two outer barrels star the pruned internal barrel, so a name absent there is
absent from both entry points. Only `constants.ts` and `budget.ts` are starred directly by both, and
those two lists are short.

---

## The interim reach, and why it exists

**Deep specifiers do not resolve from outside the package** — the exports map has no wildcard.
Verified this session with a throwaway probe in `apps/api`: importing
`@hushbox/shared/affordability/constants.js` produced `error TS2307: Cannot find module` (probe
deleted). So an external consumer of a walled symbol cannot be "repointed at an internal module path"
without the exports map declaring that path.

All three permitted dispositions were therefore checked against reality first:

- **replaced by a producer that already exists** — available for **zero** of the 38 externally
  consumed symbols. `getTurnOptions`, `chooseFrom`, `wireFor`, `renderOptions` and `notices` are B3,
  C1, B6 and B7 work; that is precisely why B1b is the removal half.
- **consumer deleted** — available for **zero**. Every consumer is live product code that later lanes
  rewire (E1 deletes the second verdict engine, C2/C3 the classifier path).
- **repointed at an internal module path** — the disposition the brief names, and the only one
  reachable today.

So `packages/shared/package.json` gained **14 interim subpath entries**, one per unit that a consumer
still breaches:

```
./affordability/budget                              ./affordability/estimate/reasoning-plan
./affordability/constants                           ./affordability/estimate/reducers
./affordability/estimate/classifier-line-item       ./affordability/estimate/run-ceiling
./affordability/estimate/effort-options             ./affordability/estimate/search-reservation
./affordability/estimate/pre-adapters               ./affordability/estimate/smart-model-affordability
./affordability/estimate/price-request              ./affordability/estimate/types
./affordability/smart-model/effort-dimension        ./affordability/smart-model/resolve
```

**Per unit, not per directory, on purpose.** A `./affordability/estimate` entry would have republished
the whole estimator and put the wall back one entry point along — the same failure B1's audit caught
in B1b's original criteria. Each entry publishes one unit, and a check confirms **no non-walled symbol
rides these paths** (102 references, all 38 of them walled symbols, nothing else).

They are pinned by two tests in the same file, so the set can neither grow nor be forgotten:

- `publishes exactly the enumerated interim unit subpaths beside it` — set equality between the
  `./affordability/*` keys of the exports map and `INTERIM_UNIT_SUBPATHS`.
- `resolves <subpath> to an existing unit` — each entry points at a file that exists.

A unit still listed there is a consumer still behind the wall, which makes the list B8's own
checklist: B8 discharges an item by flipping its consumers onto the barrel and deleting the entry,
and the set-equality test fails until the two agree.

---

## The B8 inbox — complete, per consumer

Every one of these was repointed at an internal path because no producer exists. **28 files, 102
references, 14 units.** None was replaced by an existing producer and none was deleted.

| Consumer                                                             | Unit reached: symbols                                                                                                                                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/slices/chat/domain/smart-model-turn.ts`                | `estimate/effort-options`: turnEffortOptions                                                                                                                                            |
| `apps/api/src/slices/chat/domain/smart-model-turn.test.ts`           | `constants`: MINIMUM_OUTPUT_TOKENS · `estimate/reasoning-plan`: REASONING_BUDGET_TOKENS_BY_EFFORT                                                                                        |
| `apps/api/src/slices/chat/domain/turn-definition.ts`                 | `budget`: computeSafeMaxTokens · `constants`: MINIMUM_OUTPUT_TOKENS · `estimate/effort-options`: turnEffortOptions · `estimate/pre-adapters`: estimateTokensForTier, outputCharsPerTokenForTier · `estimate/smart-model-affordability`: SmartModelStorageContext |
| `apps/api/src/slices/chat/domain/turn-definition.test.ts`            | `constants`: MINIMUM_OUTPUT_TOKENS · `estimate/pre-adapters`: outputCharsPerTokenForTier · `estimate/reasoning-plan`: REASONING_BUDGET_TOKENS_BY_EFFORT                                  |
| `apps/api/src/slices/chat/domain/turn-reasoning.ts`                  | `estimate/effort-options`: resolveEffortForModel, turnEffortOptions · `estimate/reasoning-plan`: planReasoning, planReasoningOff                                                          |
| `apps/api/src/slices/chat/domain/turn-reasoning.test.ts`             | `estimate/reasoning-plan`: REASONING_BUDGET_TOKENS_BY_EFFORT                                                                                                                            |
| `apps/api/src/slices/chat/routes.integration.test.ts`                | `estimate/reasoning-plan`: REASONING_BUDGET_TOKENS_BY_EFFORT                                                                                                                            |
| `apps/api/src/slices/models/adapters/integration-setup.ts`           | `estimate/reasoning-plan`: planReasoning, planReasoningOff                                                                                                                              |
| `apps/api/src/slices/models/adapters/mock-provider.ts`               | `constants`: CHARS_PER_TOKEN_STANDARD                                                                                                                                                   |
| `apps/api/src/slices/models/domain/estimate.ts`                      | `estimate/reducers`: evaluateManifest · `estimate/run-ceiling`: NO_STORAGE, callManifest, estimateRunCeilingNanoUsd, DeclaredCeiling, NodeStorage, **ratesFromPricing (re-export)** · `estimate/types`: Manifest |
| `apps/api/src/slices/models/domain/estimate-run.ts`                  | `estimate/pre-adapters`: outputCharsPerTokenForTier · `estimate/reducers`: reservationCeiling · `estimate/search-reservation`: WEB_SEARCH_RESERVATION_NANO_PER_MODEL · `estimate/types`: NanoLineItem |
| `apps/api/src/slices/models/domain/estimate-run.test.ts`             | `estimate/classifier-line-item`: classifierReserveChars · `estimate/pre-adapters`: estimateTokensForTier, outputCharsPerTokenForTier · `estimate/search-reservation`: WEB_SEARCH_RESERVATION_NANO_PER_MODEL · `estimate/smart-model-affordability`: SmartModelPoolCandidate, smartModelMinimumRequiredNanoUsd |
| `apps/api/src/slices/models/domain/smart-model-candidates.ts`        | `constants`: **CHARS_PER_TOKEN_CONSERVATIVE (re-export as `CLASSIFIER_CHARS_PER_TOKEN`)** · `estimate/pre-adapters`: outputCharsPerTokenForTier · `estimate/smart-model-affordability`: admitSmartModel, SmartModelPoolCandidate, SmartModelStorageContext, **classifierReserveLineItems (re-export)** |
| `apps/api/src/slices/models/domain/smart-model-candidates.test.ts`   | `constants`: MINIMUM_OUTPUT_TOKENS · `estimate/pre-adapters`: estimateTokensForTier                                                                                                     |
| `apps/api/src/slices/models/domain/trial-eligibility.ts`             | `estimate/pre-adapters`: estimateTokensForTier, outputCharsPerTokenForTier · `estimate/price-request`: priceRequest · `estimate/reducers`: evaluateManifest                              |
| `apps/api/src/slices/models/domain/trial-eligibility.test.ts`        | `estimate/pre-adapters`: estimateTokensForTier, outputCharsPerTokenForTier                                                                                                              |
| `apps/api/src/slices/models/domain/trial-smart-model-candidates.ts`  | `estimate/pre-adapters`: outputCharsPerTokenForTier                                                                                                                                     |
| `apps/api/src/slices/models/domain/trial-smart-model-candidates.test.ts` | `estimate/pre-adapters`: outputCharsPerTokenForTier                                                                                                                                 |
| `apps/api/src/slices/workflows/nodes/smart-model-execution.ts`       | `estimate/reasoning-plan`: planReasoningOff · `smart-model/effort-dimension`: parseClassifierAnswer, pickClassifiedEffortPlan, resolveClassifiedEffort · `smart-model/resolve`: resolveClassifierOutput |
| `apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts`  | `estimate/reasoning-plan`: REASONING_BUDGET_TOKENS_BY_EFFORT                                                                                                                            |
| `apps/web/src/components/chat/input/reasoning-effort-menu.tsx`       | `estimate/effort-options`: turnEffortOptions, EffortOption                                                                                                                              |
| `apps/web/src/components/chat/input/reasoning-effort-menu.test.tsx`  | `estimate/effort-options`: turnEffortOptions                                                                                                                                            |
| `apps/web/src/hooks/billing/use-budget-calculation.ts`               | `estimate/pre-adapters`: estimateTokensForTier, outputCharsPerTokenForTier, computePromptCapacity · `estimate/price-request`: priceRequest · `estimate/reducers`: affordability, evaluateManifest · `estimate/types`: BillableRequest, Manifest |
| `apps/web/src/hooks/billing/use-budget-calculation.test.ts`          | `constants`: — · `estimate/pre-adapters`: estimateTokensForTier, outputCharsPerTokenForTier · `estimate/price-request`: priceRequest · `estimate/reasoning-plan`: REASONING_BUDGET_TOKENS_BY_EFFORT · `estimate/reducers`: affordability · `estimate/search-reservation`: WEB_SEARCH_RESERVATION_NANO_PER_MODEL |
| `apps/web/src/hooks/billing/use-media-cost-estimate.ts`              | `estimate/price-request`: priceRequest · `estimate/reducers`: reservationCeiling · `estimate/types`: BillableRequest                                                                     |
| `apps/web/src/hooks/billing/use-prompt-budget.ts`                    | `constants`: MINIMUM_OUTPUT_TOKENS · `estimate/effort-options`: turnEffortOptions · `estimate/pre-adapters`: outputCharsPerTokenForTier · `estimate/price-request`: priceRequest · `estimate/reasoning-plan`: planReasoning · `estimate/reducers`: evaluateManifest · `estimate/smart-model-affordability`: smartModelMinimumRequiredNanoUsd, SmartModelPoolCandidate, SmartModelStorageContext |
| `apps/web/src/hooks/billing/use-prompt-budget.test.ts`               | `constants`: MINIMUM_OUTPUT_TOKENS · `estimate/pre-adapters`: outputCharsPerTokenForTier · `estimate/price-request`: priceRequest · `estimate/reasoning-plan`: REASONING_BUDGET_TOKENS_BY_EFFORT · `estimate/reducers`: evaluateManifest · `estimate/smart-model-affordability`: smartModelMinimumRequiredNanoUsd, SmartModelPoolCandidate |
| `apps/web/src/hooks/chat/use-reasoning-effort.ts`                    | `estimate/effort-options`: **offeredEffortLabels (import + re-export)**                                                                                                                  |

**One more inbox item, intra-package:** `packages/shared/src/models/premium-check.ts` reached
`../affordability/estimate/index.js` for `estimateTokensForTier`, `outputCharsPerTokenForTier`,
`priceRequest`, `reservationCeiling` and `BillableRequest`. Because it lives inside the package it
was repointed at relative unit paths (`estimate/pre-adapters.js`, `estimate/price-request.js`,
`estimate/reducers.js`, `estimate/types.js`) rather than an exports-map subpath. It is listed here
because it is a consumer behind the wall exactly like the other 28, and because **G1 rule 1 covers
the intra-package relative reach** — B1 ruled this file stays in `models/`, so G1 has to decide what
it may reach. Before this task it reached one path into the module; now it reaches four, all into
walled units.

Four of the inbox entries are **re-export** sites rather than imports (marked above). They matter to
B8 disproportionately: each publishes a walled symbol onward to intra-slice callers under a local
name, so flipping the reach is not just an import edit.

---

## Disposition of every removed export

| Disposition                                       | Count  | Detail                                                                                                                                                                             |
| ------------------------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| repointed at an internal module path (B8's inbox) | **38** | The table above. Every reach is via one of the 14 enumerated unit subpaths (external) or a relative unit path (`premium-check.ts`).                                                  |
| replaced by a producer that already exists        |  **0** | No producer for any of them exists today; that is B8's whole subject.                                                                                                                |
| consumer deleted                                  |  **0** | Every consumer is live code a later lane rewires.                                                                                                                                    |
| no consumer outside the module — removal broke nothing | **29** | Listed below. The criteria name three dispositions "per consumer"; these have no consumer to disposition, so removing them cost nothing and needed nothing.                     |

The 29 with no external consumer: `Affordability`, `CHARS_PER_TOKEN_CONSERVATIVE` *(external only as
a re-export — counted in the 38)*, `ClassifierAnswerParts`, `ClassifierStage`,
`ComputeMaxTokensParams`, `MediaBillable`, `MediaRateKey`, `ModelRatesNano`, `OfferedLevel`,
`PricedSmartModelCandidate`, `PricedSmartModelPool`, `PromptCapacity`, `PromptCapacityInput`,
`REASONING_BUDGET_FLOOR_TOKENS`, `ReasoningInfeasibleReason`, `ReasoningPlan`, `ReasoningPlanResult`,
`ReservationCeilingInput`, `ResolvedEffort`, `SEARCH_COST_PER_CALL`, `SmartModelAdmission`,
`SmartModelCandidateId`, `SmartModelCappedCandidate`, `buildMediaLineItems`, `charsPerTokenForTier`,
`classifierLineItems`, `offeredLevels`, `priceSmartModelPool`, `ratesFromPricing` *(external only as
a re-export — counted in the 38)*, `validCap`, `webSearchLineItem`.

*(`CHARS_PER_TOKEN_CONSERVATIVE` and `ratesFromPricing` appear in both lists because a plain
`import`-only scan misses them; they are consumed only through `export … from` re-export sites. The
authoritative counts are 38 repointed / 29 untouched-by-any-consumer, from a scan that reads both
import and export declarations.)*

---

## Criterion 3 — the grep, listed

Scan over every non-`legacy` `.ts`/`.tsx` in the repo, parsing both `import … from` and
`export … from` declarations:

| Reach                                            | Count                       |
| ------------------------------------------------ | --------------------------- |
| walled symbol via the **root barrel**            | **0**                       |
| walled symbol via `@hushbox/shared/affordability` | **0**                       |
| walled symbol via an enumerated interim subpath  | 102 refs / 28 files / 14 units |
| non-walled symbol riding an interim subpath      | **0**                       |

The one further hit anywhere in the tree is
`apps/api/dist/apps/api/src/slices/models/domain/smart-model-candidates.d.ts` — a stale build
artifact, not source.

`/legacy/` is excluded deliberately: it is quarantined outside every build, test, lint and coverage
gate, and `no-legacy-imports` forbids new code depending on it. See the standing-rule note below.

---

## Files changed

### `packages/shared`

| File                                                | Why                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                                      | root entry point: `constants`/`budget` stars → named lists; the estimator's named blocks reduced to the published surface |
| `src/affordability/index.ts`                        | module entry point: same two named lists; docblock records that the machinery is absent by design             |
| `src/affordability/estimate/index.ts`               | the wall for the estimator, expressed at the file nearest the units so both outer barrels inherit it          |
| `src/affordability/smart-model/index.ts`            | same, for the classifier-answer reducers                                                                     |
| `src/affordability/index.test.ts`                   | the two absence blocks, the walled-symbol list, the interim-subpath pin, and repaired `RELOCATED_UNITS`       |
| `src/models/premium-check.ts`                       | consumer the closure broke: repointed at four relative unit paths                                            |
| `package.json`                                      | the 14 interim unit subpaths (see the deviation below)                                                        |

### Outside `packages/shared` — the complete list

**A1 and F1 must not assume any of these is untouched.** All 28 changes are **import/export specifier
rewrites only**; no statement, expression, type annotation or test assertion was altered. Three files
additionally had one comment corrected (marked †) because they cited an import path this task changed.

`apps/api` (20):
`src/slices/chat/domain/smart-model-turn.ts` · `src/slices/chat/domain/smart-model-turn.test.ts` ·
`src/slices/chat/domain/turn-definition.ts` · `src/slices/chat/domain/turn-definition.test.ts` ·
`src/slices/chat/domain/turn-reasoning.ts` · `src/slices/chat/domain/turn-reasoning.test.ts` ·
`src/slices/chat/routes.integration.test.ts` · `src/slices/models/adapters/integration-setup.ts` ·
`src/slices/models/adapters/mock-provider.ts` · `src/slices/models/domain/estimate.ts` † ·
`src/slices/models/domain/estimate-run.ts` · `src/slices/models/domain/estimate-run.test.ts` ·
`src/slices/models/domain/smart-model-candidates.ts` † ·
`src/slices/models/domain/smart-model-candidates.test.ts` ·
`src/slices/models/domain/trial-eligibility.ts` · `src/slices/models/domain/trial-eligibility.test.ts` ·
`src/slices/models/domain/trial-smart-model-candidates.ts` ·
`src/slices/models/domain/trial-smart-model-candidates.test.ts` ·
`src/slices/workflows/nodes/smart-model-execution.ts` ·
`src/slices/workflows/nodes/smart-model-execution.test.ts`

`apps/web` (8):
`src/components/chat/input/reasoning-effort-menu.tsx` ·
`src/components/chat/input/reasoning-effort-menu.test.tsx` ·
`src/hooks/billing/use-budget-calculation.ts` · `src/hooks/billing/use-budget-calculation.test.ts` ·
`src/hooks/billing/use-media-cost-estimate.ts` · `src/hooks/billing/use-prompt-budget.ts` ·
`src/hooks/billing/use-prompt-budget.test.ts` · `src/hooks/chat/use-reasoning-effort.ts` †

Note for coordination: `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` was already
uncommitted-modified at the start of this task by other work. Only its import specifiers were
touched.

The three † comment corrections, in full:

- `estimate.ts` and `smart-model-candidates.ts` cited `` `@hushbox/shared/estimate` `` — a subpath that
  has never existed in the exports map, so the citation was already wrong before this task and doubly
  wrong after it. Both now name the money layer without a path.
- `use-reasoning-effort.ts` said `offeredEffortLabels` lives "in @hushbox/shared"; it now says "inside
  the money layer".

`apps/api/src/slices/models/domain/estimate-run.ts:229`'s "MUST stay in sync" comment was left alone —
that sync contract is G2's, by citation.

---

## Tests

| Test                                                                                          | Behaviour                                                                  | Criterion              |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------- |
| `the export wall — the '@hushbox/shared/affordability' entry point > does not bind <39 names>` | no runtime binding for any walled value export on the module barrel        | absent from both barrels |
| `… > does not publish <67 names>`                                                              | no walled symbol, type-only included, in the module barrel's export graph  | absent from both barrels |
| `… > walks 'export *' chains, so absence below means absence`                                   | the resolver finds a starred value, a starred type, and misses a truly absent name | makes the two above non-vacuous |
| `the export wall — the package root entry point > does not bind <39 names>`                     | same, root barrel                                                          | absent from both barrels |
| `… > does not publish <67 names>`                                                               | same, root barrel                                                          | absent from both barrels |
| `… > walks 'export *' chains, so absence below means absence`                                   | same control, root barrel                                                  | makes the two above non-vacuous |
| `affordability subpath > publishes exactly the enumerated interim unit subpaths beside it`      | the exports map's `./affordability/*` keys equal the pinned interim set    | the interim state is enumerated, and B8-discharged |
| `affordability subpath > resolves <14 subpaths> to an existing unit`                            | each interim entry targets a real file                                     | same                   |

Modified, with reason: `RELOCATED_UNITS` in the same file lost four representatives that are now
behind the wall (`MINIMUM_OUTPUT_TOKENS`, `computeSafeMaxTokens`, `priceRequest`,
`resolveClassifiedEffort`) and gained three from the same units (`generateNotifications` for `budget`,
`outputTokensOf` for `estimate`, `buildClassifierSystemPrompt` for `smart-model`). The move-not-copy
property is preserved because it is a property of the **unit**, not of the chosen symbol; the
`constants` unit keeps two representatives (`TOTAL_FEE_RATE`, `STORAGE_COST_PER_CHARACTER`), so
dropping `MINIMUM_OUTPUT_TOKENS` does not leave it unrepresented. No other test in the repo was
modified beyond import specifiers.

---

## Self-gate

| Command                                            | Result                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npx vitest run src/affordability/index.test.ts` (red-first) | **fail as intended** — 210 failed / 45 passed, both positive controls green |
| `pnpm test:shared`                                 | **pass** — 109 files, coverage gate satisfied                                       |
| `pnpm test:api`                                    | **1 file failed / 464 passed / 1 skipped** — the failure is pre-existing, see below |
| `pnpm test:web`                                    | **393 files passed**, run fails on one pre-existing per-file coverage gate, see below |
| `pnpm test:db`                                     | **pass** — 27 + 2 files                                                             |
| `pnpm test:crypto`                                 | **pass** — 36 files                                                                 |
| `pnpm test:ui`                                     | **pass** — 94 files                                                                 |
| `pnpm test:realtime`                               | **pass** — 12 + 2 files                                                             |
| `pnpm test:config`                                 | **pass** — 29 files                                                                 |
| `pnpm test:admin`                                  | **pass** — 70 files                                                                 |
| `npx turbo typecheck --force --continue`           | **pass** — 16 successful, 16 total (repo-wide, run twice; green both times)          |
| `pnpm arch:check`                                  | **pass** — OK, 11 rules over 1990 files                                             |
| `eslint .` in `packages/shared`                     | **pass** — exit 0, after the last edit                                              |
| `eslint <20 owned files>` in `apps/api`             | **pass** — exit 0, after the last edit                                              |
| `eslint <8 owned files>` in `apps/web`              | **pass** — exit 0, after the last edit                                              |

Vite pre-bundle caches (`node_modules/.vite` at the root and in `apps/api`, `apps/web`,
`packages/shared`) were cleared before the suites, per §Known Breakage's environment note.

### The two failures, attributed

**`apps/api` — `notifications/domain/templates/template-html.test.ts`, 7 snapshot failures.** This is
§Known Breakage's named entry verbatim ("the single `apps/api` failure a scoped run will show"). The
diff on every one is the removal of a single line,
`<link href="https://fonts.googleapis.com/css2?family=Merriweather…" rel="stylesheet">`. Evidence it
is not mine: `git status` on `apps/api/src/slices/notifications/domain/templates/` is empty, so both
the template source and the `.snap` are byte-identical to HEAD; the test file contains no
affordability reference at all; and the count and cause match the recorded entry exactly.

**`apps/web` — coverage gate on `src/components/chat/message/markdown-renderer.tsx`,
`branches 75% < 95%`.** All 393 web test files pass; the run fails only on this per-file threshold.
This one is **not** on §Known Breakage and needs an owner. Evidence it is not mine:

- `git diff` on that file is empty — byte-identical to HEAD (`39a07db0`), as is its test.
- Its only shared import is `TEST_IDS`; it imports nothing walled and nothing in this task's
  footprint, and neither does its test.
- Run with only its own two test files it reports **100% branch coverage** (96.29% stmts). The 75%
  branch figure appears only in the full-suite run, i.e. the denominator differs between runs — which
  points at instrumentation, not at source. `apps/web/vite.config.ts` is uncommitted-modified by the
  concurrent workstream and its `transformStreamdownSource` plugin rewrites exactly this file's
  dependency; `markdown-renderer.tsx` is the Streamdown consumer.

A baseline run with this task's changes absent is not obtainable without a state-writing git command,
so the attribution rests on the four facts above rather than on a before/after comparison.

---

## Deviations

1. **`packages/shared/package.json` was edited, and it is not in B1b's Files list.** B1b's list names
   the two barrels, "every consumer the closure breaks", and tests. The 14 interim subpath entries are
   the mechanism that makes "repointed at an internal module path" possible at all for an external
   consumer — verified above that no such path resolves otherwise — so the alternatives were to leave
   exports open (fails criterion 1) or to invent producers (explicitly forbidden). Raised to the
   orchestrator.
2. **`docs/BILLING.md` §What is enforced says "deep imports do not resolve", and during the interim
   they do** — for 14 enumerated unit paths, and for nothing else. This is the B1b→B8 interim the plan
   describes; the clause becomes true again when B8 deletes the entries. It is stated here rather than
   left for an auditor to find, because it is a normative clause temporarily false by design.
3. **Two internal barrels were edited** (`affordability/estimate/index.ts`,
   `affordability/smart-model/index.ts`) beyond the two named in the Files list. Reason under §Where
   the closure is expressed: expressing the wall there avoids duplicating a ~90-name list across both
   outer barrels, and is what makes the closure hold for whichever entry point stars them.
4. **Five `/legacy/` files were edited and restored.** A shell filter meant to exclude `legacy/`
   failed (the grep used emitted bare relative paths, not `./`-prefixed ones), so the mechanical
   repoint touched
   `legacy/apps/api/src/legacy/{lib/pre-inference/smart-model-stage.ts, routes/chat.billing-integration.test.ts, services/ai/mock.ts, services/ai/smart-model.integration.test.ts, services/chat/max-tokens.ts}`.
   Each diff was verified to be an import rewrite and nothing else, then each file was restored by
   writing back the output of `git show HEAD:<path>`. `git status -- legacy/` is now empty. **No
   state-writing git command was run** — `git show` is read-only and the restore was a file write.
   Self-reported because the rule is that no agent *runs* such a command, and because an auditor
   should be able to confirm the tree is clean rather than take it on trust.

---

## Concerns and limitations

- **The interim mechanism is the load-bearing judgment in this task.** Per-unit entries were chosen
  over a directory-level entry precisely to avoid recreating the leak, but they are still 14 paths
  that new code could reach for. Nothing but the pinned set and code review stops that until B8
  deletes them; G1 rule 6 is static over the two barrels and would not see a new deep reach.
- **The type-only half of the wall is asserted structurally, not by import.** TypeScript offers no way
  to observe "type X is not exported" from inside a test, so 28 of 67 symbols are pinned by a
  parse-based resolver rather than by the runtime `import *`. The positive controls make the resolver's
  silence meaningful, but it is 60 lines of test machinery that G1 rule 6 will later duplicate in the
  arch harness. If G1 lands rule 6 first, the structural half here becomes removable.
- **The category→symbol mapping is a judgment an auditor should re-derive, not accept.** Two lines
  were drawn by argument (storage rates and fee floats stay as named seams / display data;
  `MAX_SEARCH_TOOL_CALLS` is a protocol cap, not a rate). A reader who draws them elsewhere gets a
  different wall, and the reasons are recorded above precisely so that disagreement is possible.
- **`estimate/index.ts` is no longer a directory barrel.** Its docblock says so, but a future author
  adding a unit to `estimate/` will not automatically publish it, which is the intended behaviour and
  also a surprise waiting for someone.
- **`premium-check.ts` now reaches four walled units by relative path.** B1 ruled the file stays in
  `models/`; G1 rule 1 governs the intra-package relative reach and must decide what this file may
  reach. It was one path before, four now.
- **`docs/BILLING.md` §Configuration Reference still cites pre-relocation paths**
  (`packages/shared/src/money.ts`, `estimate/`, `tiers.ts`, `reasoning-effort.ts`, `param-spec.ts`,
  `billing/funding-decision.ts`, `models/premium-check.ts` is still right). That is B1's reported
  path-diff, still unapplied — not this task's to edit, and noted because the doc is normative.

---

## Confidence

**High** on the wall itself: absence is asserted twice per entry point over an explicitly enumerated
symbol list, watched red for the right reason, with positive controls proving the assertions are not
vacuous; the repo typechecks green repo-wide and every package suite passes except two failures
attributed with file-level evidence.

**Medium** on the interim mechanism being what the orchestrator intended. The criteria and the brief
both direct "repoint at an internal module path", and no such path resolves from outside the package
without an exports-map entry — so the entries follow from the instruction. But they change the
package's public shape, touch a file outside the stated Files list, and put a normative
`BILLING.md` clause temporarily in the wrong state. If the orchestrator wants a different interim
carrier, the change is localized: `package.json`, the pinned list in `index.test.ts`, and the import
specifiers in 28 files.
