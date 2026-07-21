# T2 — Canonical core: types + text manifest + reducers — impl report 1

## Objective
Build `packages/shared/src/estimate/`: nano-USD bigint `NanoLineItem`/`Manifest`/`BillableRequest`,
`priceRequest` (text/token path), `reservationCeiling`, `affordability`, and the re-homed client
pre-adapters (tier→token, output inversion, cushion/spendable/effective-balance nano helpers). No
markup in `priceRequest`; markup once in the reducers; storage in the hold; fail-closed; pure.

## Exported seam (from `packages/shared/src/estimate/index.ts`)

```ts
// types.ts
interface NanoLineItem { label: string; fixedNano?: bigint; variableOutputRateNano?: bigint; marksUp: boolean }
interface Manifest { items: readonly NanoLineItem[] }
interface ModelRatesNano { inputPerToken?: bigint; outputPerToken?: bigint; perImage?: bigint; perSecondByResolution?: Readonly<Record<string, bigint>> }
interface BillableRequest {
  models: readonly { pricing: ModelRatesNano }[];   // ≥1
  inputTokens: bigint;                              // caller-supplied token count (not chars→tokens)
  inputChars: number;                               // for input-storage line item
  outputCharsPerToken: number;                      // tier-inverted, caller-supplied
}
type EstimateErrorCode = 'model-pricing-incomplete' | 'invalid-request';
interface EstimateError { code: EstimateErrorCode; detail: string }
type EstimateResult<T> = { ok: true; value: T } | { ok: false; error: EstimateError }
function estimateOk<T>(value: T): EstimateResult<T>
function estimateErr<T>(code: EstimateErrorCode, detail: string): EstimateResult<T>

// price-request.ts
function priceRequest(request: BillableRequest): EstimateResult<Manifest>   // text path, NO markup

// reducers.ts
interface ReservationCeilingInput { outputTokenCeiling: bigint; fanOutWidth: number; maxSteps: number; maxIterations: number }
function reservationCeiling(manifest: Manifest, input: ReservationCeilingInput): NanoUSD
interface Affordability { canSend: boolean; maxOutputTokens: bigint; minCostNano: bigint; denialReason?: string }
function affordability(manifest: Manifest, effectiveBalanceNano: bigint): Affordability

// pre-adapters.ts
function charsPerTokenForTier(tier: UserTier): number
function estimateTokensForTier(tier: UserTier, characterCount: number): number
function outputCharsPerTokenForTier(tier: UserTier): number
const PAID_CUSHION_NANO_USD: bigint
function getCushionNano(tier: UserTier): bigint
function spendableFundsNanoUsd(balanceNanoUsd: bigint, tier: UserTier): bigint
function getEffectiveBalanceNano(tier: UserTier, balanceNanoUsd: bigint, freeAllowanceNanoUsd: bigint): bigint
interface PromptCapacity { currentUsage: number; maxCapacity: number; capacityPercent: number }
interface PromptCapacityInput { promptCharacterCount: number; modelContextLength: number }
function computePromptCapacity(input: PromptCapacityInput): PromptCapacity

// storage-rate.ts
const STORAGE_COST_PER_CHARACTER_NANO = 300n
function assertStorageCharRateMatchesSharedFloat(charRate: number): void   // module-init drift guard
```

## Files changed
- `packages/shared/src/estimate/types.ts` (new) — seam types + the fail-closed `EstimateResult` channel.
- `packages/shared/src/estimate/storage-rate.ts` (new) — `STORAGE_COST_PER_CHARACTER_NANO = 300n` + drift guard against shared float `STORAGE_COST_PER_CHARACTER`.
- `packages/shared/src/estimate/price-request.ts` (new) — `priceRequest` text/token manifest builder (no markup).
- `packages/shared/src/estimate/reducers.ts` (new) — `foldManifest` (private), `reservationCeiling`, `affordability`.
- `packages/shared/src/estimate/pre-adapters.ts` (new) — re-homed client pre-adapters + nano balance/cushion helpers + `computePromptCapacity`.
- `packages/shared/src/estimate/index.ts` (new) — sub-barrel (`export *`, coverage-excluded).
- `packages/shared/src/index.ts` — added an EXPLICIT NAMED re-export of the estimate seam (see Deviations for why not `export *`).
- Colocated `*.test.ts` for pre-adapters, storage-rate, price-request, reducers.

## Tests added (behavior — criterion)
- `pre-adapters.test.ts` (17) — tier ratios, `estimateTokensForTier` rounding, output inversion, cushion/spendable/effective-balance nano, capacity percent + zero-context. Covers pre-adapter re-home.
- `storage-rate.test.ts` (4) — `300n` value, equals scaled float, guard passes/throws. Covers single-sourced nano storage constant + drift guard.
- `price-request.test.ts` (12) — multi-model input+output SUM, input-storage fixed, output-storage per-model tier-inverted variable, zero prompt, NO-markup base amounts, fail-closed (empty models / missing input rate / missing output rate / negative tokens / bad chars / bad outputCharsPerToken). Covers manifest build + fail-closed.
- `reducers.test.ts` (13) — ceiling sum fixed+ceiling×variable, markup once, multiplier, markup-once-on-SUM boundary (6→7 not 3+3=6), invalid multiplier / negative ceiling throw; affordability minCost gate, at-boundary=1000 tokens, one-nano-below denies, inverse-solve floor, partial-token floor, zero/negative denial, degenerate-manifest throw. Covers reducers + edge cases.

46 tests total, all green; estimate files 100% stmt/branch/func/line coverage.

## How each T2 criterion is satisfied
- **Types finalized + exported** — `NanoLineItem`/`Manifest`/`BillableRequest` in `types.ts`, input-driven (token counts, no chars→tokens inside core).
- **priceRequest text path** — per-model `inputPerToken`/`outputPerToken` summed across models (`sumRate`); input-storage fixed line item (`inputChars × 300n`); output-storage variable line item (`outputCharsPerToken × 300n × modelCount`), tier-inversion supplied by caller. NO markup applied; every line item is a base rate. Fail-closed `EstimateResult` on empty models, missing rate, bad counts.
- **reservationCeiling** — folds manifest into marked-up/raw × fixed/variable; `applyMarkup(fixedMarkedUp + ceiling×varMarkedUp)` once, adds raw storage subtotal, × (fanOutWidth × maxSteps × maxIterations). Storage IS in the hold (founder ruling). Invalid multiplier / negative ceiling throw `RangeError` (defect, not domain condition).
- **affordability inverse-solve** — `totalFixed = applyMarkup(fixedMarkedUp) + fixedRaw`; `effectiveVariableRate = applyMarkup(varMarkedUp) + varRaw` (markup once per subtotal — the marked-up per-token rate is the nano analogue of legacy's fee-inclusive `variableCostPerToken`); `minCostNano = totalFixed + MINIMUM_OUTPUT_TOKENS × rate`; `canSend = balance ≥ minCost`; `maxOutputTokens = floor((balance − totalFixed)/rate)` (bigint division floors positive operands). Reproduces legacy `calculateBudgetFromManifest` outcomes: maxOut is 0 or ≥1000, `affordable ⟺ balance ≥ minCost` (legacy `canAffordModel.affordable = maxOut > 0`). Zero/negative balance → deny `insufficient_balance`.
- **Pre-adapters re-homed (fresh TDD)** — `estimateTokensForTier`, `charsPerTokenForTier`, `outputCharsPerTokenForTier`, `PAID_CUSHION_NANO_USD`, `getCushionNano`, `spendableFundsNanoUsd`, `getEffectiveBalanceNano` (nano analogue of legacy dollar `getEffectiveBalance`), plus `computePromptCapacity` (the "may live alongside" money-free capacity helper — the hook needs `capacityPercent` and its legacy source `budget.ts` is deleted in T11).
- **Nano storage constant single-sourced** — `STORAGE_COST_PER_CHARACTER_NANO = 300n` with module-init drift guard pinned to shared float `STORAGE_COST_PER_CHARACTER`, same pattern as `apps/api` money.ts. `apps/api` money.ts untouched.
- **Constraints** — nano bigint only, no `Number()` on money in the core; markup once; fail-closed Result on bad input; shared imports no infra; explicit return types; comments are durable facts only.

## Manifest shape for T3 extension
T3 adds media/web-search/classifier costs as MORE `NanoLineItem`s — the reducers never reshape:
- media (image/video) = a fixed item `{ fixedNano: rate×units, marksUp: true }`; `ModelRatesNano` already carries `perImage`/`perSecondByResolution`.
- web search = a fixed item `{ fixedNano: WORST_CASE_SEARCH_RESERVATION, marksUp: true }` (marks up).
- classifier stage = its own fixed line item(s).
T3 adds optional `media?`/`webSearch?`/`classifierStage?` fields to `BillableRequest` (additive → non-breaking) and dispatches on them; the text path here is unchanged. No TODOs left; the extension contract is the line-item vocabulary.

## TDD evidence (representative RED watched)
- `pre-adapters.test.ts` first run: `Error: Cannot find module './pre-adapters.js'` (17 assertions could not import) — RED for the right reason (feature absent). Implemented `pre-adapters.ts` → 17/17 green.
- `reducers.test.ts` first run: 0 tests, suite failed to load (`./reducers.js` missing) → implemented → 13/13 green.
- Each of the four behaviors followed write-test → watch-fail → minimal-impl → green.

## Self-gate (run from `packages/shared`, after last edit)
- `vitest run --coverage` (full shared suite = `pnpm test:shared`) — **PASS**, exit 0, 93 files / 2273 tests, per-file coverage gate met; estimate files 100% (82/82 stmt, 50/50 branch, 17/17 func, 79/79 line).
- `eslint src/estimate/ src/index.ts` — **PASS**, exit 0, zero warnings (prettier included; `--fix` applied then re-verified clean).
- `jscpd --threshold 2 packages/shared/src/estimate` — **PASS**, 0 clones / 0% duplication across 6 files (no copy of money.ts math; `foldManifest` shared by both reducers).
- `tsgo --noEmit` (shared typecheck) — **FAIL, cause entirely outside this task.** Zero errors in `src/estimate/*` or `src/index.ts` (verified: `tsgo … | grep 'src/estimate/|src/index.ts'` → none). All 30 errors are in `src/smart-model/eligible-models.ts` (+ its test) and `src/capabilities/model-capabilities.test.ts`, which still read the deleted float wire fields `pricePerInputToken`/`pricePerOutputToken`. Root cause: `packages/shared/src/schemas/api/models.ts` was already modified (uncommitted, another workstream — the wire nano-pricing/T5 migration) to the nano `pricing` shape without updating those consumers. This is a pre-existing green-blocker owned by the model-catalog / wire-pricing workstream, not introduced here.

## Deviations (with reason)
1. **Result channel is a local discriminated union, not neverthrow `Result<Manifest, DomainError>`.** `packages/shared` has only `zod` as a dependency (no neverthrow, no `DomainError` type), and adding an npm dependency is approval-gated. `priceRequest` returns `EstimateResult<Manifest>` with `EstimateError { code, detail }`. Boundary-clean (shared stays infra-free) and consistent with shared's existing discriminated-union style (`client-billing.ts`). The server (T7) maps it to its own neverthrow `Result`/`DomainError` at the boundary; the client (T9) reads `.ok`. RAISED — downstream tasks cite the seam.
2. **Root barrel uses an EXPLICIT NAMED re-export, not `export * from './estimate/index.js'`.** `budget.ts` still exports `estimateTokensForTier`, `charsPerTokenForTier`, `outputCharsPerTokenForTier`, `spendableFundsNanoUsd`, `PAID_CUSHION_NANO_USD` (deleted only in T11). A star export makes those names ambiguous at the barrel — verified it is a hard TS2308 error, so it would break shared typecheck. The root line therefore re-exports only the non-colliding new surface; the five colliding pre-adapters remain served by `budget.ts` (identical behavior) and are reachable at their estimate home via `./estimate/index.js`. **T11 must broaden this root re-export (to `export *` or add the five names) when it deletes `budget.ts`.** RAISED.
3. **`computePromptCapacity` included** (the "may" helper) — justified: the client `usePromptBudget` return shape needs `capacityPercent`/`capacityCurrentUsage`/`capacityMaxCapacity`, and its legacy source `budget.ts` is deleted in T11.

## Concerns / what the auditor should scrutinize
- **affordability inverse-solve & markup-once.** Confirm markup is applied exactly once per marked-up subtotal (fixed model cost, and the per-token model rate) and NOT to storage; confirm `maxOutputTokens = floor((balance − totalFixed)/effectiveVariableRate)` matches legacy and that `canSend ⟺ balance ≥ minCost` yields maxOut ∈ {0} ∪ [1000, ∞). The full legacy scenario matrix (F/P/M rows) is T4's parity job — this task pins the unit behaviors only.
- **reservationCeiling markup/multiplier ordering.** I apply `applyMarkup(markedUpSubtotal)` then × the integer multiplier (markup before multiply). The current api `estimateRunCeilingNanoUsd` does `applyMarkup(base × multiplier)` (markup after multiply) and excludes storage — so this is a deliberate, founder-ruled behavior change (storage now in the hold; canonical order set here). T7 rebuilds the server ceiling on THIS reducer; T10 cross-parity pins it. Confirm the ordering choice is acceptable as the canonical definition.
- **Degenerate-manifest guard** in `affordability` throws `RangeError` if `effectiveVariableRate ≤ 0n` (a manifest with no output-token cost). `priceRequest` always emits an output-storage variable item, so this is defensive; confirm that's the intended fail-closed posture (vs returning `canSend:false`).

## Confidence
Medium-high. The core math, fail-closed paths, and pre-adapters are fully tested at 100% coverage and all scoped gates except the out-of-scope typecheck are green. Medium (not high) because two load-bearing seam decisions (the neverthrow-free Result channel, and the named-not-star root re-export forced by the interim `budget.ts` overlap) diverge from the plan's written seam and must be ratified by the orchestrator so T7/T9/T10/T11 build to the actual shape.
