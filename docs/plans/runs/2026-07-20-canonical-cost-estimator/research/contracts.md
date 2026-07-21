# Canonical cost-estimator — exact current contracts

READ-ONLY research capture (2026-07-20). Every signature/type below is quoted verbatim
from current source with `file:line`. Repo root paths are relative to
`/workspace/popper-mobile/.superset/projects/HushBox`.

---

## 1. Bigint markup + nano-USD helpers

### `apps/api/src/slices/billing/domain/money.ts`

Integer nano-USD `bigint` end to end, banker's (half-even) rounding applied once.

```ts
// money.ts:15
const BASIS = 10_000n;

// money.ts:22  — 15% markup in basis points
export const MARKUP_BASIS_POINTS = 1500n;

// money.ts:25  — module-init drift guard vs shared TOTAL_FEE_RATE
export function assertMarkupMatchesSharedRate(totalFeeRate: number): void {
  if (BigInt(Math.round(totalFeeRate * 10_000)) !== MARKUP_BASIS_POINTS) {
    throw new Error(
      'billing: MARKUP_BASIS_POINTS no longer matches the shared TOTAL_FEE_RATE — update both together'
    );
  }
}
assertMarkupMatchesSharedRate(TOTAL_FEE_RATE);            // money.ts:33

// money.ts:36
const NANO_PER_USD = 1e9;

// money.ts:46-47  — storage rates as exact bigint nano, NEVER marked up (pass-through)
export const STORAGE_COST_PER_CHARACTER_NANO = 300n;     // $0.0000003/char
export const MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n;     // $0.000000018/byte

// money.ts:50  — module-init drift guard vs shared floats
export function assertStorageRatesMatchSharedFloats(charRate: number, byteRate: number): void { … }
assertStorageRatesMatchSharedFloats(STORAGE_COST_PER_CHARACTER, MEDIA_STORAGE_COST_PER_BYTE); // :63
```

Rounding + markup + conversion:

```ts
// money.ts:69  — half-even integer division; denominator MUST be positive (RangeError otherwise)
export function roundHalfEvenDiv(numerator: bigint, denominator: bigint): bigint

// money.ts:89  — the ONE place markup lands; rejects negative base (RangeError);
//               rounds half-even exactly once. Callers must never re-round.
export function applyMarkup(baseCostNanoUsd: bigint): bigint {
  if (baseCostNanoUsd < 0n) throw new RangeError(…);
  return roundHalfEvenDiv(baseCostNanoUsd * (BASIS + MARKUP_BASIS_POINTS), BASIS);
}
// i.e. baseCost * 11500 / 10000  → +15%, half-even, divides by BASIS = 10_000n

// money.ts:106  — gateway float-USD → nano-USD via toFixed decimal rendering (no float mult)
export function usdToNanoUsd(usd: number): bigint   // rejects non-finite / negative (RangeError)
// NANO_FRACTION_DIGITS = 9 (money.ts:96), RENDER_DIGITS = 12 (money.ts:99); sub-nano residue half-even
```

There is NO `roundHalfEven` (only `roundHalfEvenDiv`). The drift assertion divides by
`BASIS = 10_000n`; markup multiplies by `BASIS + MARKUP_BASIS_POINTS = 11_500n`.

### `packages/shared/src/nano-usd.ts`

```ts
// nano-usd.ts:15  — Zod: canonical decimal string → branded bigint (wire is string-only)
export const NanoUSD = z.string().regex(CANONICAL_DECIMAL_PATTERN, …).transform(BigInt).brand<'NanoUSD'>();
export type NanoUSD = z.infer<typeof NanoUSD>;           // nano-usd.ts:22

export function nanoUSD(value: bigint): NanoUSD          // nano-usd.ts:25  brands raw bigint
export function serializeNanoUSD(value: NanoUSD): string // nano-usd.ts:30
export function parseNanoUSD(value: string): NanoUSD     // nano-usd.ts:35

export const NANO_USD_PER_CENT = 10_000_000n;            // nano-usd.ts:40
export const NANO_USD_PER_DOLLAR = 1_000_000_000n;       // nano-usd.ts:43

// Converters (all integer bigint math, no float on money):
export function nanoUsdToFullDollarString(wire: string): string  // :53 full 9-digit precision
export function dollarsToCents(dollars: string): number          // :69
export function centsToNanoUsd(cents: number): string            // :77
export function dollarsToNanoUsd(dollars: string): string        // :86
export function nanoUsdToCents(wire: string): number             // :98 truncates toward zero, Number() on divided cents
export function nanoUsdToDollarString(wire: string): string       // :107 X.XX, truncates sub-cent
```

There is **no** `usdToNanoUsd` and **no** float→nano converter in `nano-usd.ts` — the only
float→nano converter is `money.ts:106 usdToNanoUsd` (billing slice). `nano-usd.ts` is
integer-only (cents/dollar-string bridges).

---

## 2. Catalog pricing shapes — client vs server

### CLIENT shape `Model` — `packages/shared/src/schemas/api/models.ts`

The wire contract. **Fee contract (models.ts:155-159): every `pricePer*`/`minPricePer*`/
`maxPricePer*` field is FEE-INCLUSIVE float USD** (raw provider price × `1 + TOTAL_FEE_RATE`),
applied once at projection; downstream must NOT re-apply fees. Price fields (all `z.number`,
float USD — never NanoUSD):

```ts
// modelSchema — models.ts:161
id: z.string().min(1)                                    // :164
name: z.string().min(1)                                  // :167
provider: z.string().min(1)                              // :169
modality: modelModalitySchema.default('text')            // :173  enum ['text','image','audio','video']
contextLength: z.number().int().nonnegative()            // :176
pricePerInputToken: z.number().nonnegative()             // :179  fee-inclusive USD, 0 for non-text
pricePerOutputToken: z.number().nonnegative()            // :182  fee-inclusive USD, 0 for non-text
pricePerImage: z.number().nonnegative().default(0)       // :185  fee-inclusive USD
pricePerSecondByResolution: z.record(z.string(), z.number().nonnegative()).default({}) // :193 video
pricePerSecond: z.number().nonnegative().default(0)      // :200  audio flat/sec
capabilities: z.array(modelCapabilitySchema)             // :203  enum ['internet-search'] only
description: z.string().min(1)                            // :206
supportedParameters: z.array(z.string()).default([])     // :213
created: z.number().optional()                           // :216
isSmartModel: z.boolean().optional()                     // :219
minPricePerInputToken / minPricePerOutputToken           // :222 / :225  fee-inclusive, Smart Model range
maxPricePerInputToken / maxPricePerOutputToken           // :228 / :231  fee-inclusive, Smart Model range
supportedAspectRatios?: string[]                         // :240
supportedVideoResolutions?: string[]                     // :249
supportedVideoDurationsSeconds?: number[]                // :256
popularityRank?: z.number().int().nonnegative()          // :262
// + refine: text models need contextLength>0 (:264); superRefine(refineModalityPricing) (:268)

export type Model = z.infer<typeof modelSchema>;         // :270
export const modelsListResponseSchema = z.object({ models: z.array(modelSchema), premiumModelIds: z.array(z.string()) }); // :276
export type ModelsListResponse = …                       // :281
```

### SERVER shape `Pricing`/`ModelDescriptor` — `packages/shared/src/model-descriptor.ts`

```ts
// model-descriptor.ts:12  — Pricing rates in integer NanoUSD (strings on wire), estimates/display ONLY
export const PricingSchema = z.record(z.string(), z.union([NanoUSD, z.record(z.string(), NanoUSD)]));
export type Pricing = z.infer<typeof PricingSchema>;     // :17
// Named keys used in code: 'inputPerToken', 'outputPerToken' (flat NanoUSD);
//   'perImage' (flat NanoUSD); 'perSecondByResolution' (nested record<resolution, NanoUSD>).

// model-descriptor.ts:72
export const ModelDescriptor = z.object({
  id, provider, version: z.string().min(1),
  inputs: z.array(Modality), outputs: z.array(Modality),
  parameters: z.record(z.string(), ParameterSpec),
  behaviors: z.array(z.string()),                        // 'streaming'|'tools'|'reasoning'|'web-search'…
  limits: z.record(z.string(), z.number()),              // key 'contextLength' used by estimators
  pricing: PricingSchema,
  zdrReachable: z.boolean(),
  name?: string, description?: string,
  releasedAt: z.number(), fetchedAt: z.number(),
  popularityRank?: z.number().int().nonnegative(),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;   // :104
// callShapeFamilyFor(outputs) :40 → 'language'|'image'|'video'|'embedding'|undefined
// isRunnableModelShape(shape) :56
```

### Projection: what the client actually gets over the wire

Projection lives in **`apps/api/src/slices/models/domain/list-models.ts`** (NOT the
`packages/shared/src/models/process-models.ts` path the doc-comments cite — that file does
**not exist**; the `processModels` name survives only in comments). The pipeline is
`listDescriptors → wireCandidate(descriptor, family) → modelSchema.safeParse` (list-models.ts:262);
a projection that fails the schema is dropped (hidden).

```ts
const NANO_PER_USD = 1_000_000_000;                                   // list-models.ts:21
function displayUsd(nanoUsd: bigint): number { return Number(nanoUsd) / NANO_PER_USD; }  // :22
function feeInclusiveUsd(nanoUsd: bigint | undefined): number {       // :27
  return nanoUsd === undefined ? 0 : applyFees(displayUsd(nanoUsd));  // applyFees = ×(1+0.15)
}
function flatRate(pricing: Pricing, key: string): bigint | undefined  // :32  bigint or undefined
function modalityPricing(descriptor, family): typeof ZERO_PRICING {   // :87
  language → { pricePerInputToken: feeInclusiveUsd(flatRate(pricing,'inputPerToken')),
               pricePerOutputToken: feeInclusiveUsd(flatRate(pricing,'outputPerToken')) }   // :91-92
  image    → { pricePerImage: feeInclusiveUsd(flatRate(pricing,'perImage')) }               // :98
  video    → { pricePerSecondByResolution: {res: feeInclusiveUsd(rate)…} }                  // :101-110
}
```

**Answer:** the client receives ONLY fee-inclusive **float USD** `pricePer*` fields. It
never receives NanoUSD pricing. NanoUSD `Pricing`/`ModelDescriptor` is server-internal;
`displayUsd` + `applyFees` collapse it to float USD at the models route boundary. Any new
core that wants exact bigint pricing on the client would have to widen the wire contract —
today the client only has lossy float USD to compute with (which is why the client hooks in
§4 do cents-scale float math).

---

## 3. Smart Model server pricing — `apps/api/src/slices/models/domain/smart-model-candidates.ts`

```ts
export interface SmartModelCandidatesInput {           // :58
  readonly descriptors: readonly ModelDescriptor[];    // exposed catalog (already-filtered)
  readonly balanceNanoUsd: bigint;                     // payer effective turn funding
  readonly promptInputTokens?: number;                 // shapes gate threshold only, not the menu
}
export interface SmartModelCandidateEntry { readonly id: string; readonly description?: string; }  // :76
export interface SmartModelCandidates {                // :81
  readonly classifierModelId: string;                  // cheapest text candidate = classifier + fallback
  readonly candidates: readonly SmartModelCandidateEntry[];   // affordable, ascending by combined base price
  readonly classifierWorstCaseNanoUsd: bigint;         // the reserve every candidate checked against
}

// :146  — classifier worst-case BASE (pre-markup) cost. Reads only {id, description} from textCatalog,
//          so it accepts the estimator's stamped candidate list AND full descriptors.
export function classifierWorstCaseBaseNanoUsd(
  classifier: ModelDescriptor,
  textCatalog: readonly { readonly id: string; readonly description?: string | undefined }[]
): bigint | undefined
// body: overheadChars = computeClassifierPromptOverhead(textCatalog.map(id+description));
//   inputTokens = estimateTokensForTier('trial', MAX_CLASSIFIER_CONTEXT_CHARS + overheadChars);  // 2 chars/token
//   base = callBaseNanoUsd(classifier.pricing, {kind:'tokens', inputTokens, outputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP});
//   returns base.value | undefined  (BASE, NOT marked up — trial 1¢ cap compares base; paid marks up)

// :196  — the builder
export function buildSmartModelCandidates(input: SmartModelCandidatesInput): SmartModelCandidates | null
//   sortedText = descriptors.filter(isEngineTextModel).toSorted(ascendingByPrice)  (:181 combinedBasePrice = input+output per-token)
//   classifier = sortedText[0]; reserve = applyMarkup(classifierWorstCaseBaseNanoUsd(classifier, sortedText))  (:173 classifierWorstCaseNanoUsd, paid = marked up)
//   menu = sortedText priced via turnCeilingNanoUsd(descriptor, promptInputTokens) (:117, flatMap drops unpriceable)
//   affordable = menu.some(item => balanceNanoUsd >= reserve + item.ceiling)  (binary gate; null if none)
```

Helpers it reads:
- `combinedBasePrice(descriptor)` (:103) → `pricing['inputPerToken'] + pricing['outputPerToken']` (bigint, 0n fallbacks).
- `turnCeilingNanoUsd(descriptor, promptInputTokens?)` (:117) → uses `limits['contextLength']`;
  input = `min(ctx, promptInputTokens)` else ctx; output = `min(ctx, MINIMUM_OUTPUT_TOKENS)` else ctx;
  calls `estimateRunCeilingNanoUsd(pricing, {kind:'tokens',…}, {maxFanOutWidth:1,maxSteps:1,maxIterations:1})`.
- `isEngineTextModel = isTextModel = isRunnableModelShape` (:98).
- Re-exports `CLASSIFIER_CHARS_PER_TOKEN = CHARS_PER_TOKEN_CONSERVATIVE` (=2) (:56).

The `SmartModelNode` the estimator reads (`estimate-run.ts:45` `Extract<Node,{type:'smartModel'}>`)
carries: `classifierModelId`, `candidates` (`{id, description?}[]`), `params`, `promptInputTokens?`.
`estimateSmartModelNode` (estimate-run.ts:393) = `applyMarkup(classifierBase × fanOut×loop)` +
MAX over candidate `modelCeiling`s (exactly one candidate answers).

---

## 4. Client hook return shapes (defines what `affordability()` must supply)

### `apps/web/src/hooks/billing/use-budget-calculation.ts`

```ts
export interface UseBudgetCalculationInput {           // :16
  promptCharacterCount: number;
  models: ModelPricingWithContext[];                   // {modelInputPricePerToken, modelOutputPricePerToken, contextLength} — float USD
  isAuthenticated: boolean;
  webSearchCost?: number;                              // float USD, fee-inclusive
}
// returns BudgetCalculationResult & { isBalanceLoading: boolean }   (:40)
```
`BudgetCalculationResult` (`packages/shared/src/budget.ts:62`), all float dollars / token counts:
`maxOutputTokens`, `estimatedInputTokens`, `estimatedInputCost`, `estimatedMinimumCost`,
`effectiveBalance`, `outputCostPerToken`, `currentUsage`, `capacityPercent`, `preReservedCents`.
Computed by shared `calculateBudget(input)` (budget.ts:652) → `buildCostManifest` +
`calculateBudgetFromManifest`. Tier/balance come from `useUserTierInfo` (cents-scale).

### `apps/web/src/hooks/billing/use-media-cost-estimate.ts`

```ts
export interface UseMediaCostEstimateInput {           // :28
  modality: ChatModality;
  imagePricing?: { pricesPerImage: readonly number[] };                          // :9
  videoPricing?: { pricesPerSecond: readonly number[]; durationSeconds: number };// :14
  audioPricing?: { pricesPerSecond: readonly number[]; durationSeconds: number };// :21
}
export interface MediaCostEstimate { estimatedCents: number; estimatedDollars: number; }  // :35
```
Body (:55) dispatches to shared `computeImageExactCents(pricesPerImage)` (pricing.ts:340),
`computeVideoExactCents(pricesPerSecond, durationSeconds)` (:354),
`computeAudioWorstCaseCents(pricesPerSecond, durationSeconds)` (:376). Returns 0 for text.
All operate on **fee-inclusive float USD** price arrays → cents.

### `apps/web/src/hooks/billing/use-prompt-budget.ts`

```ts
export interface PromptBudgetResult {                  // :34
  fundingSource: FundingSource | 'denied';
  notifications: BudgetError[];
  capacityPercent: number;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
  estimatedCostCents: number;
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  hasContent: boolean;
}
```
`usePromptBudget(input)` (:296) orchestrates: `buildModelTokenPricing` + `useBudgetCalculation`
(text) OR `buildMediaPriceArrays` + `useMediaCostEstimate` (media) → `estimatedCostCents`
(text = `budgetResult.estimatedMinimumCost * 100`, media = `mediaCost.estimatedCents`, :362) →
`useResolveBilling` → `generateNotifications`. `webSearchCost = webSearchActive ? worstCaseSearchCost() : 0` (:312).

**Consumers:**
- `prompt-input.tsx` reads: `fundingSource`, `notifications`, `hasBlockingError`,
  `isOverCapacity`, `estimatedCostCents`, `capacityPercent`, `capacityCurrentUsage`,
  `capacityMaxCapacity`, `hasContent` (the full `PromptBudgetResult`; verify exact subset at
  design time — file not opened this pass).
- `modality-config-panel.tsx` consumes the media cost path (via `useMediaCostEstimate`
  inputs `pricesPerImage`/`pricesPerSecond`/`durationSeconds`); not opened this pass.

The new `affordability()` output must at minimum supply: a funding decision
(`FundingSource | 'denied'` + reason), a cents (or nano) estimate, capacity
(`percent`/`currentUsage`/`maxCapacity`), `maxOutputTokens`, and blocking/over-capacity flags —
the union of `BudgetCalculationResult`, `MediaCostEstimate`, and `PromptBudgetResult`.

---

## 5. Server admission input & how the estimate reaches it

### `AdmissionRequest` — `apps/api/src/slices/billing/domain/admission.ts:42`

```ts
export interface BudgetScope {                         // :31
  readonly scopeId: string;                            // Redis holds-hash key, cumulative (no period suffix)
  readonly remainingNanoUsd: bigint;                   // owner cap − cumulative spent (caller-computed from PG)
}
export interface AdmissionRequest {                    // :42
  readonly walletId: string;
  readonly holdId: string;                             // = run id, one hold per run
  readonly estimateNanoUsd: bigint;                    // priced at declared ceiling (width×steps×iterations)
  readonly deadlineSeconds: number;
  readonly concurrentRunCap: number;
  readonly budgets: readonly BudgetScope[];
  readonly now: Date;
}
// admitRun(deps, request): ResultAsync<AdmissionDecision, DomainError>  (:218)
//   assertAdmissible: estimateNanoUsd > 0n and deadlineSeconds > 0 (else RangeError) (:209)
//   AdmissionDecision = {admitted:true, hold: HoldReadout} | {admitted:false, reason} (:71)
//   HoldReadout (:61): holdId, walletId, scopeIds, estimateNanoUsd, costCircuitMultiplier,
//                      costCircuitLimitNanoUsd (= estimate × K), expiresAtMs
```

### Path from `createEstimateRun` → admission

`createEstimateRun(resolveModel): EstimateRun` (estimate-run.ts:450) where
`EstimateRun = (definition: WorkflowDefinition) => Result<NanoUSD, DomainError>` (:39). It sums
each node's ceiling and returns `nanoUSD(Σ)`.

The interpreter injects it as `estimateRun` (interpreter.ts:76) and calls it BEFORE admission
(interpreter.ts:299):

```ts
const estimate = this.deps.estimateRun(this.request.definition);          // interpreter.ts:299
if (estimate.isErr()) return this.failBeforeAdmission({kind:'inputs-invalid', …});
const decision = await this.request.hooks.admission({                     // :307
  definition: this.request.definition,
  estimate: estimate.value,                                               // NanoUSD → the policy hook
});
```

The chat **admission policy hook** turns `estimate` (NanoUSD) into `AdmissionRequest.estimateNanoUsd`
and calls `admitRun`. `circuit.costCircuitLimitNanoUsd` from the grant is stored as
`this.limitNanoUsd` (interpreter.ts:329) for the mid-run cost circuit.

### Stamping `promptInputTokens` / `maxOutputTokens` — `apps/api/src/slices/chat/domain/turn-definition.ts`

```ts
// :177  — the input-token basis stamped on language nodes so admission bounds the input leg
export function promptInputTokensFor(budget: TurnBudget): number {
  return estimateTokensForTier(tierForFunding(budget.funding), budget.promptCharacterCount);
}
// tierForFunding (:167): funding.kind === 'purchased' ? 'paid'(4 chars/tok) : 'free'(2 chars/tok)

// :181  — the affordable output-token ceiling (legacy calculateBudget→computeSafeMaxTokens in nano bigint)
export function turnMaxOutputTokens(
  budget: TurnBudget,
  models: readonly TurnModelPricing[]                  // {inputPerTokenNanoUsd, outputPerTokenNanoUsd, contextLength} BASE rates
): number | undefined {
  // summedTurnPricing (:149): sumInputRate/sumOutputRate = Σ applyMarkup(perToken); minContextLength
  // fixedCost = inputTokens×sumInputRate + chars×STORAGE_COST_PER_CHARACTER_NANO
  // variableCostPerToken = sumOutputRate + outputCharsPerToken×STORAGE_COST_PER_CHARACTER_NANO×modelCount
  // effective = spendableFundsNanoUsd(funding.remainingNanoUsd, tier)   // +$0.50 cushion if paid
  // if effective < fixedCost + MINIMUM_OUTPUT_TOKENS×variableCostPerToken → undefined
  // budgetMaxTokens = Number((effective − fixedCost) / variableCostPerToken)
  // return computeSafeMaxTokens({budgetMaxTokens, modelContextLength: minContextLength, estimatedInputTokens})
}
```

`TurnBudget` (:109) = `{ promptCharacterCount: number; funding: PayerFunding }`.
`TurnModelPricing` (:115) = `{ inputPerTokenNanoUsd: bigint; outputPerTokenNanoUsd: bigint; contextLength: number }`
(BASE pre-markup rates; markup applied inside `summedTurnPricing`).
`turnModelPricings(models, resolve)` (:215) resolves them from descriptors (undefined if any lacks
a flat per-token rate or contextLength). Both are folded into the modelCall `params`
(`maxOutputTokens`) / node field (`promptInputTokens`) by `buildSingleModelTurn`/`buildMultiModelTurn`,
then read back by the estimator (`declaredOutputCeiling` estimate-run.ts:336, `inputTokenCeiling` :324).

---

## 6. Constants — exact values + location

All in **`packages/shared/src/constants.ts`** unless noted.

| Constant | Value | Location |
|---|---|---|
| `TOTAL_FEE_RATE` | `HUSHBOX_FEE_RATE(0.05)+CREDIT_CARD_FEE_RATE(0.045)+PROVIDER_FEE_RATE(0.055)` = **0.15** | constants.ts:38 (parts :22/:25/:28) |
| `STORAGE_COST_PER_CHARACTER` | `(MONTHLY_COST_PER_GB×MONTHS_PER_YEAR×STORAGE_YEARS)/(CHARACTERS_PER_KILOBYTE×KILOBYTES_PER_GIGABYTE)` = **$0.0000003** | constants.ts:66 |
| `MEDIA_STORAGE_COST_PER_BYTE` | `(MEDIA_MONTHLY_COST_PER_GB(0.03)×MONTHS_PER_YEAR×STORAGE_YEARS)/(1000×1_000_000)` = **$0.000000018** | constants.ts:86 |
| `MINIMUM_OUTPUT_TOKENS` | **1000** | constants.ts:164 |
| `CHARS_PER_TOKEN_CONSERVATIVE` | **2** (free/trial/guest) | constants.ts:177 |
| `CHARS_PER_TOKEN_STANDARD` | **4** (paid) | constants.ts:183 |
| `MAX_SEARCH_TOOL_CALLS` | **10** | constants.ts:222 |
| `SEARCH_COST_PER_CALL` | **0.005** (USD, pre-fee) | constants.ts:229 |
| `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS` | **50** (paid cushion, $0.50) | constants.ts:151 |
| `MAX_TRIAL_MESSAGE_COST_CENTS` | **1** ($0.01 trial/guest cap) | constants.ts:158 |
| `ESTIMATED_IMAGE_BYTES` | **8_000_000** | constants.ts:94 |
| `ESTIMATED_VIDEO_BYTES_PER_SECOND` | **5_000_000** | constants.ts:117 |
| `MAX_SELECTED_MODELS` | **5** | constants.ts:232 |

Derived nano analogues (single-sourced, drift-guarded against the floats above):
- `STORAGE_COST_PER_CHARACTER_NANO = 300n`, `MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n` (money.ts:46-47).
- `PAID_CUSHION_NANO_USD = BigInt(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) × NANO_USD_PER_CENT` = 500_000_000n (budget.ts:194).
- `WORST_CASE_SEARCH_RESERVATION_NANO_USD = applyMarkup(BigInt(MAX_SEARCH_TOOL_CALLS) × usdToNanoUsd(SEARCH_COST_PER_CALL))` (estimate.ts:22).

Related shared search-cost helper (float): `worstCaseSearchCost() = applyFees(MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL)` (pricing.ts:394).
`ESTIMATED_AUDIO_BYTES_PER_SECOND = 32_000` (constants.ts:141), `MAX_AUDIO_DURATION_SECONDS = 600` (:134) — audio is deferred.

---

## Key cross-cutting facts for the design

1. **Two price representations, one seam.** Server holds integer NanoUSD (`Pricing`, keys
   `inputPerToken`/`outputPerToken`/`perImage`/`perSecondByResolution`); client holds fee-inclusive
   **float USD** (`Model.pricePer*`). The collapse happens once at `list-models.ts`
   (`applyFees(displayUsd(nano))`). A canonical core must pick which side each caller lives on —
   the client literally cannot receive nano pricing today.
2. **Markup lands exactly once, two code paths.** Server: `applyMarkup` (×11500/10000, half-even).
   Client/display: `applyFees` (×1.15 float). `MARKUP_BASIS_POINTS` is drift-guarded against
   `TOTAL_FEE_RATE` at module init.
3. **Storage is never marked up** (pass-through) on both sides (`STORAGE_COST_PER_CHARACTER_NANO`
   added raw; `buildCostManifest` uses `applyFees:false` for storage items).
4. **The estimate seam is `EstimateRun`** = `(WorkflowDefinition) => Result<NanoUSD, DomainError>`;
   admission consumes only `estimateNanoUsd: bigint`. `turnMaxOutputTokens`/`promptInputTokensFor`
   pre-stamp the definition so the estimate bounds input/output legs to the real prompt.
5. **`process-models.ts` does not exist** — cited only in stale doc-comments; the live projection
   is `list-models.ts`.
</content>
</invoke>
