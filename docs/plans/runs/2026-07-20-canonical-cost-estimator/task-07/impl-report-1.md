# T7 impl-report-1 — STATUS: NEEDS_CONTEXT (prior blocker RESOLVED; two narrow media/trial money-basis decisions remain)

## Objective (restated)
Rebuild the models-slice estimators (`estimate.ts`, `estimate-run.ts`,
`smart-model-candidates.ts`, `trial-eligibility.ts`, `trial-smart-model-candidates.ts`,
`model-resolver.ts` + barrels/tests) on `@hushbox/shared/estimate`; delete the duplicated
per-call/media/search/classifier math; add an optional turn-level `storageContext` to
`createEstimateRun`; recompute every changed test number by hand to the canonical figure.

## The prior report's blocker is RESOLVED by this brief
impl-report-1 (prior attempt) blocked because a per-node text-storage ceiling needed
`prompt chars + tier` that the `Node` schema does not carry and no task was scoped to add.
**This brief's amended STORAGE design (Option A — injected `storageContext = {inputChars, tier}`
on `createEstimateRun`, T8 fills it) removes that blocker entirely:** storage inputs arrive as a
turn-level parameter, not node-schema fields. That path is buildable within T7 bounds. Confirmed
against the core: `createEstimateRun` (`estimate-run.ts:450`) is the single seam to widen;
`outputCharsPerTokenForTier` + `STORAGE_COST_PER_CHARACTER_NANO` are exported from the core
(`pre-adapters.ts:49`, `storage-rate.ts:17`).

## The clean implementation I have fully derived (ready to execute)
All Verified against source this session.

**Core seam facts.** The core exports `priceRequest`, `reservationCeiling`, `affordability`, the
media/search/classifier line-item builders, pre-adapters, `format.*`, the storage-rate constants,
`WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL`, and the public `Manifest`/`NanoLineItem`/
`BillableRequest`/`ModelRatesNano` types. It exposes **no** provider-base primitive and does **not**
export `buildTextLineItems` or a manifest fold; `priceRequest` always emits input+output storage
items (`price-request.ts:65-88`), `reservationCeiling` reduces
`(applyMarkup(fixedMarkedUp + ceil·varMarkedUp) + rawSubtotal)·mult` (`reducers.ts:76-81`).

1. **`WORST_CASE_SEARCH_RESERVATION_NANO_USD`** → `applyMarkup(WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL)`.
   One line; imports the base constant; deletes the duplicated `MAX_SEARCH×perCall` formula. Number UNCHANGED.
2. **Settlement/base pricers** (`callBaseNanoUsd`, `priceUsageBaseNanoUsd`, `priceMediaBaseNanoUsd`)
   → build a `BillableRequest`, call `priceRequest`, and fold **only the `marksUp` line items**
   (`Σ fixed + outputTokens·Σ var`) to recover provider-base (no storage, no markup) — the exact
   contract `model-resolver.ts` / settlement still need. Requires a small `Pricing → ModelRatesNano`
   adapter (reads the named keys). The cost formula stays in the core; the fold is a projection over
   public `NanoLineItem`s (jscpd/grep-clean). Numbers UNCHANGED.
3. **Text `modelCall` node ceiling** → `priceRequest` (inputChars=0), keep its `marksUp` provider
   items, drop its storage items, and when `storageContext` is present add a server-built
   output-storage `NanoLineItem` (`outputCharsPerTokenForTier(tier)·STORAGE_COST_PER_CHARACTER_NANO`,
   raw), then `reservationCeiling(..., {outputTokenCeiling, fanOutWidth: enclosure.fanOut, maxSteps,
   maxIterations: enclosure.loop})`. Add **input-storage once** at the definition level
   (`inputChars·STORAGE_COST_PER_CHARACTER_NANO`, raw). Zero storage when `storageContext` absent.
   Adopts `reservationCeiling`'s markup-then-multiply order — a **sanctioned per-node number change**
   (criterion #5); the current `applyMarkup(base·mult)` order (`estimate.ts:303`) differs, so every
   token-node `estimate-run.test.ts` value is recomputed and pinned with a canonical-figure comment.
4. **Classifier reserve via core `classifierLineItems`** — criterion #4's correction: the reserve now
   INCLUDES its structural storage. Applies to `estimateSmartModelNode` (`estimate-run.ts`),
   `smart-model-candidates.ts`, AND (see decision B) the trial path. Exact recomputable basis
   (`classifierReserveChars` = `MAX_CLASSIFIER_CONTEXT_CHARS` + prompt overhead; output cap ×
   `outputCharsPerToken` × rate).
5. **DAG walker, media-size gate (`estimateMinMediaOutputBytes` vs `VALUE_STORE_BYTE_BUDGET_BYTES`),
   subWorkflow fail-closed refuse** → preserved verbatim; only per-node pricing bodies change.
6. **`EstimateResult<T> → api Result`** → `{ok:true}`→`ok(value)`; `{ok:false}`→
   `err(validationError(error.detail, …))`, preserving the `UNSUPPORTED_RESOLUTION`/
   `UNSUPPORTED_DURATION` wire codes `mediaCallUsageFor` emits today.

## DECISION A (money) — media-node admission storage: what `storageBytes` basis, or keep provider-only?
Criterion #3 says "media storage stays STRUCTURAL (already in the core's … media line items — do not
double-add) … reproduces legacy's manifest." But:
- the **current** api media ceiling is provider-only, **zero storage** (`estimate.ts` `mediaBase`;
  `estimate-run.ts` media arm) — so including media storage is a NEW behavior, not a preserved one;
- the core's `buildMediaLineItems` requires a caller `storageBytes` the brief never sources. The only
  estimate is legacy's `ESTIMATED_IMAGE_BYTES` (8MB) / `durationSeconds·ESTIMATED_VIDEO_BYTES_PER_SECOND`
  (5MB/s) (`constants.ts:94,117`; the pricer that used them is T11-deleted). `estimateMinMediaOutputBytes`
  is a floor for the size GATE — wrong for storage;
- whether media storage is always-on (structural) or gated is unspecified.

The output-storage RULE in criterion #3 is token-based (`outputTokenCeiling × outputCharsPerToken ×
char-rate`) and media nodes have no output tokens, so that rule does not cover media. I must not pick a
`storageBytes` money basis by guessing — it sets the media admission hold and the recomputed
`estimate-run.test.ts` media numbers (primary audit evidence).
**Recommendation:** keep media admission ceiling provider-only for T7 (unchanged numbers; "do not
double-add" satisfied trivially; text-only storage via `storageContext`), and add media admission
storage later with an explicit byte basis if intended. **Confirm, or specify the `storageBytes`
derivation + whether it is structural/always-on.**

## DECISION B (money) — criterion #4's classifier correction ripples into the trial 1¢ cap
`classifierWorstCaseBaseNanoUsd` (`smart-model-candidates.ts:146`) is consumed by BOTH the admission
estimator (`estimate-run.ts:406`) AND the trial 1¢-cap gate (`trial-smart-model-candidates.ts:77-84`).
Criterion #4 rules its storage omission "is CORRECTED" → including storage changes the **trial cap
basis**, which `trial-eligibility.ts:14-17` documents as "BASE (pre-markup) provider cost … what the
provider charges us" (storage is our R2 cost, not a provider charge). Criterion #5's test list names
only estimate/estimate-run/smart-model-candidates — not the two `trial-*.test.ts` files, which exist
and are in T7's bounds and would shift.
**Recommendation:** apply the correction everywhere (trial cap now includes classifier storage) and
recompute the trial tests too (criterion #5's list is the primary evidence, not exhaustive).
**Confirm** — this is a founder-ruled trial-spend behavior, so I flag rather than silently pick.

## Why I did not proceed to code
Both open items are money-critical and each determines the exact "canonical with-storage" test numbers
that criterion #5 calls the most important audit evidence. A partial or guessed-basis money change is
worse than none. Everything else above is ready to implement the moment A and B are ruled; the two
rulings are one line each and unblock the full task.

## Files changed
None (investigation only; no git state touched).

## Self-gate
`turbo typecheck --filter=@hushbox/api` — PASS (baseline, pre-change). No other gates run (no edits).

## Confidence
High that the prior blocker is resolved by the `storageContext` design and the non-storage rebuild is
cleanly buildable on the core. High that A and B are real, narrow, load-bearing money decisions (each
cited to file:line and to the brief's own criteria).
