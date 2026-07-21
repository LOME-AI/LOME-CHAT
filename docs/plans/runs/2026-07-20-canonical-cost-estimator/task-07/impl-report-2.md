# T7 impl-report-2 — STATUS: DONE (full rebuild executed; both money decisions applied)

## Objective (restated)
Rebuild the models-slice estimators on `@hushbox/shared/estimate`: delete the duplicated
per-call/media/search/classifier/ceiling math, route every price through the core, map the
core's `EstimateResult` → api `Result` at the boundary, add an optional turn-level
`storageContext` to `createEstimateRun`, and recompute every changed test number by hand to the
canonical (with-storage) figure. Decisions A (media storage included) and B (classifier +
whole trial gate include storage) executed.

## Files changed — deleted-vs-rewired

- **`estimate.ts`** — DELETED the bespoke cost math (`tokenBase` input/output rate sum,
  `mediaBase`/`mediaRate` generic matrix resolution, `ceilingMultiplier` + `applyMarkup(base×mult)`,
  the `MAX_SEARCH×perCall` search formula). REWIRED:
  - `WORST_CASE_SEARCH_RESERVATION_NANO_USD = applyMarkup(WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL)`
    (core base; value UNCHANGED 57,500,000).
  - `callBaseNanoUsd` → `callManifest` (core `priceRequest` text / `buildMediaLineItems`) then
    `providerBaseFromManifest` (folds the marked-up line items' `Σ fixed + outputTokens·Σ var`).
  - `estimateRunCeilingNanoUsd` → `callManifest` + core `reservationCeiling`; gained an optional
    `NodeStorage` param (output-storage for token nodes, media-storage bytes for media nodes).
  - Kept api-side (not cost math): `mediaCallUsageFor` param parsing + `UNSUPPORTED_RESOLUTION/DURATION`
    wire codes, `countToBigInt`/`ceilingInput` validation, the zero-ceiling reject.
  - Exported `ratesFromPricing` (`Pricing → ModelRatesNano`) — single-sourced across the slice.
- **`estimate-run.ts`** — DAG walker, enclosure memo, media size gate
  (`estimateMinMediaOutputBytes` vs `VALUE_STORE_BYTE_BUDGET_BYTES`), and subWorkflow fail-closed
  refuse all PRESERVED VERBATIM. Rewired node pricing: `modelCeiling`/`estimateModelNode`/
  `estimateSmartModelNode` thread `storageContext`; classifier reserve now priced via core
  `classifierReserveLineItems` + `reservationCeiling` (replacing the local `applyMarkup(base×mult)`);
  web-search reservation kept SEPARATE (still scaled by fanOut×loop only, never maxSteps).
- **`smart-model-candidates.ts`** — `classifierWorstCaseBaseNanoUsd` rewired to the core
  `classifierLineItems` (returns the provider `classifier-tokens` item's `fixedNano`; number
  UNCHANGED). New exported `classifierReserveLineItems` returns the core's `[classifier-tokens
  (marksUp), classifier-storage (raw)]`. Deleted the local `classifierRates` (reuse `ratesFromPricing`).
- **`trial-eligibility.ts`** — `trialMessageBaseNanoUsd` now provider + storage via core
  `priceRequest` (trial tier) + `rawManifestCostNano` (raw sum of ALL items — storage never marks up).
  `exceedsMinimalAffordability` kept provider-only (documented: token heuristic, no char count).
- **`trial-smart-model-candidates.ts`** — classifier reserve now `Σ fixedNano` over
  `classifierReserveLineItems` (provider + storage, raw) — Decision B.
- **`model-resolver.ts`** — UNCHANGED. It already calls `priceUsageBaseNanoUsd`/`priceMediaBaseNanoUsd`,
  which now resolve through the core, so settlement's actual-cost pricing shares ONE price source with
  admission by construction.
- **barrels** `models/domain/index.ts` + `models/index.ts` — export the `StorageContext` type for T8.

## How each node type is priced via the core (estimate-run)
- **text `modelCall`**: `estimateRunCeilingNanoUsd(pricing, {tokens}, ceiling, storage?)`. `storage`
  present ⇒ `NodeStorage{outputCharsPerToken: outputCharsPerTokenForTier(tier), mediaStorageBytes:0}`;
  the core manifest carries provider items + a raw output-storage rate item; `reservationCeiling`
  folds `applyMarkup(inputTok·inRate + outCeil·outRate) + outCeil·outputCharsPerToken·charRate`,
  ×(fanOut·steps·loop). `storage` absent ⇒ `marksUpOnly` (provider only) — number identical to before.
- **media (`image`/`video`)**: `estimateRunCeilingNanoUsd(pricing, {media}, ceiling, mediaStorage?)`;
  storage bytes = `ESTIMATED_IMAGE_BYTES` (image) or `durationSeconds × ESTIMATED_VIDEO_BYTES_PER_SECOND`
  (video), ×modelCount by the core. Manifest = `[media-generation (marksUp), media-storage (raw)]`;
  `reservationCeiling` = `applyMarkup(rate·units) + storageBytes·byteRate`, ×multiplier. Size gate runs
  first, unchanged.
- **`smartModel`**: classifier reserve = `reservationCeiling({classifier-tokens (marksUp) [+ classifier-storage
  (raw) iff storageContext]}, {outputTokenCeiling:0, fanOut, maxSteps:1, loop})`; plus MAX over candidate
  `modelCeiling`s (each a full text node with its own output storage). Storage gated on `storageContext`.
- **subWorkflow** → validation error (refuse), **transform/fanIn/branch/loop/fanOut** → `0n`. Unchanged.

## storageContext implementation
`createEstimateRun(resolveModel, storageContext?: {inputChars, tier})` (backward-compatible; T8 fills it
for chat, passes none for non-chat). Absent ⇒ zero storage everywhere (existing suites pin this).
Present ⇒ **input-storage ONCE at the definition level** (`inputChars × STORAGE_COST_PER_CHARACTER_NANO`,
added to the final sum, never per node, never marked up), **output-storage per answer-producing
modelCall/smartModel node** (rides `reservationCeiling` as a raw output-rate item), classifier storage
(Decision B), media storage (Decision A). Classifier output-storage uses `storageContext.tier` (admission)
/ `'trial'` (trial builder) — both non-paid ⇒ ratio 4.

**Worked nano example** (matches turn-definition's fixed/variable cost shape): text node, contextLength
1000, pricing {2500,10000}, `storageContext {inputChars:100, tier:'free'}`:
provider `applyMarkup(1000·2500 + 1000·10000)=applyMarkup(12,500,000)=14,375,000`;
output-storage `1000·outputCharsPerTokenForTier('free')(4)·300 = 1,200,000`;
input-storage `100·300 = 30,000`; total **15,605,000** (verified by test).

## EstimateResult → Result mapping
`fromEstimate<T>(r) = r.ok ? ok(r.value) : err(validationError(r.error.detail))`. Media wire codes
(`UNSUPPORTED_RESOLUTION`/`UNSUPPORTED_DURATION`) still originate in `mediaCallUsageFor` (api-side param
parsing), so they survive unchanged; core pricing errors map to plain `validation`.

## Every changed test — old → new nano (hand recomputation)
All computed from: `STORAGE_COST_PER_CHARACTER_NANO=300`, `MEDIA_STORAGE_COST_PER_BYTE_NANO=18`,
`outputCharsPerTokenForTier(free/trial)=4, paid=2`, `estimateTokensForTier('trial',c)=ceil(c/2)`,
`AFFORDABILITY_OUTPUT_TOKENS=2000`, `CLASSIFIER_OUTPUT_TOKEN_CAP=2048`, `MAX_CLASSIFIER_CONTEXT_CHARS=4000`,
`ESTIMATED_IMAGE_BYTES=8,000,000`, `ESTIMATED_VIDEO_BYTES_PER_SECOND=5,000,000`.

**trial-eligibility.test.ts** (`trialMessageBaseNanoUsd`, now provider + storage):
- prompt 10 chars, pricing 1000/1000: provider `5·1000 + 2000·1000 = 2,005,000`; storage
  `10·300 + 2000·4·300 = 2,403,000`; **2,005,000 → 4,408,000**.
- history 4+6 + prompt 10 (20 chars): provider `10·1000 + 2,000,000 = 2,010,000`; storage
  `20·300 + 2,400,000 = 2,406,000`; **2,010,000 → 4,416,000**.
- "derives input tokens…": assertion rewritten to `provider + (totalChars·300 + 2000·4·300)`.
- Added: "missing per-token rate → validation error" (covers the new priceRequest error path).
- `≤/> cap` assertions (short 'hello', 24000-char, long-history) unchanged — still hold with storage.

**trial-smart-model-candidates.test.ts**:
- `classifierReserveBase` helper now `provider + (reserveChars·300 + 2048·4·300)`. Exposed
  `classifierWorstCaseBaseNanoUsd` field for CHEAP over [CHEAP,MID]: **6,357 → 3,820,257** (reserveChars
  4521 ⇒ storage 4521·300 + 2,457,600 = 3,813,900; +6,357 provider). Verified against runtime.
- Two exact-boundary tests rebuilt: measure `base0 = messageBase('')` and `perInputToken =
  messageBase('xx') − base0` from the real pricer, `maxTokens = (cap − reserve − base0)/perInputToken`
  (bigint floor); kept at `maxTokens`, dropped at `maxTokens+1`. Exact boundary preserved without
  magic numbers (storage makes the old closed-form construction invalid).

**estimate-run.test.ts** — 6 NEW `storageContext` canonical tests (all totals hand-derived + asserted):
text output-storage 1,200,000 (free) / 600,000 (paid) + input-storage 30,000; image media-storage
`8,000,000·18 = 144,000,000`; video media-storage `4·5,000,000·18 = 360,000,000`; smartModel delta =
classifierStorage + candidateOutputStorage + inputStorage; and "no storageContext ⇒ provider only".
The 56 pre-existing estimate-run tests are UNCHANGED (no storageContext ⇒ zero storage; markup-order
change is a no-op for all their values — see scrutiny).

**estimate.test.ts** — 3 synthetic media-matrix tests moved from `perImage`-as-matrix to
`perSecondByResolution` (see Deviations). Same assertions/structure. All other 48 estimate tests
unchanged.

**smart-model-candidates.test.ts** — added an equal-combined-price tie test (covers the
`ascendingByPrice` tie branch). All 13 pre-existing tests unchanged (provider base identical).

## Preserved behavior (confirmed)
Media size gate, DAG enclosure walker, subWorkflow fail-closed refuse, web-search-separate scaling,
fail-closed on unknown model / unpriceable node / missing rate — all verbatim; pinned green by the
pre-existing suites.

## Grep / jscpd proof (no duplicated formula)
`jscpd --threshold 2` over the 5 api files + `packages/shared/src/estimate/` → **0 clones (0%)**.
Grep for residual per-token/media/search formulas in the api files → only a doc-comment mention of
`MAX_SEARCH_TOOL_CALLS`, no code. All 4 non-test files import the core pricers.

## Self-gate
- `vitest` (owned 5 files + consumers model-resolver/smart-model-turn) — **pass** (191 tests).
- `tsgo --noEmit` (api) — **pass** (exit 0).
- `eslint` (all owned files, after LAST edit, from api dir) — **pass** (exit 0).
- `jscpd --threshold 2` (5 files + shared core) — **pass** (0 clones).
- coverage (per-file 95% branch): estimate 100, estimate-run 97.4 br, smart-model-candidates 97.05 br,
  trial-eligibility 96.77 br, trial-smart-model-candidates 100 — **all ≥95** (measured across the model
  unit suite; some branches accumulate via chat/workflow tests not in the narrowest subset).
- `arch:check` — **pass** (OK, 11 rules over 1834 files).
- Integration (DB/Redis) tests NOT run — infra-gated; not loaded this session.

## Deviations (with reasons)
1. **estimate.test.ts media-matrix tests** now use `perSecondByResolution` instead of `perImage`-as-a-matrix.
   The api's old generic media-rate resolver (arbitrary `rateKey` + inline matrix) is deleted; the core
   supports `perImage`/`perSecond` (flat) and `perSecondByResolution` (matrix), which is exactly what
   `mediaCallUsageFor` (the only production media caller) emits. No production capability lost; the
   "matrix media pricing" coverage is preserved with the real key. Not a weakening.
2. **`exceedsMinimalAffordability`** (trial premium-classification leg) kept provider-only, not storage-inclusive:
   it is a token-count heuristic over a fixed synthetic exchange with no character count to size storage.
   The plan's trial-storage mandate targets the char-based per-send budget (`trialMessageBaseNanoUsd`),
   which now includes storage. Documented in-file.
3. Two `/* v8 ignore */` on unreachable defensive branches (classifier always priceable for an eligible
   pick; `fixedNano ?? 0n` guarding the optional field), matching this file's existing ignore pattern.

## Concerns / auditor scrutiny points
- **Markup-order change is provably a no-op for existing values.** New per-node pricing is
  `reservationCeiling`'s markup-then-multiply; old was `applyMarkup(base × mult)`. They differ only under
  markup rounding — but every existing test base is a multiple of 100, so `×1.15` is exact and the two
  orders are equal. Hence all 56 pre-existing estimate-run numbers and the estimate.ts ceiling numbers
  are UNCHANGED (verified green).
- **Decision B tightens the trial.** The trial classifier reserve is now storage-dominated (~3.8M of the
  10M cap for cheap models); a trial send's max prompt shrinks to ~12k chars. This matches legacy
  `calculateTrialBudget` (which included storage) and is not feature-breaking (reserve < cap verified),
  but it is a real trial-spend behavior change.
- **Storage multiplier scaling.** Per-node output-storage and media-storage ride the full
  `reservationCeiling` multiplier (fanOut × steps × iterations) as line items; input-storage is added once
  and never scaled; classifier reserve storage scales fanOut × loop (steps=1). This is a deliberate
  admission over-reserve, consistent with treating storage as a per-execution line item.

## Confidence
High — every price now flows through the single shared core (jscpd 0 clones, grep clean), all money
numbers are hand-derived and pinned, fail-closed paths preserved, and all scoped gates pass. Integration
suites are infra-gated (not run); the unit + structural + coverage evidence is complete.
