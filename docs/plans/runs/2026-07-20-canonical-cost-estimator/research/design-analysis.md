# Design analysis — canonical estimator (analyst rulings)

## Pricing representation — RECOMMENDATION: option (a), full replace (high confidence)
Add a **named typed** `WireModelPricing` (optional `NanoUSD` fields matching descriptor `Pricing`
keys: `inputPerToken?`, `outputPerToken?`, `perImage?`, `perSecondByResolution?`) to the wire `Model`;
**delete** float `pricePer*` / `minPricePer*` / `maxPricePer*`. Move `applyMarkup` / `usdToNanoUsd` /
`roundHalfEvenDiv` into `packages/shared` so one markup runs both sides. Migrate display/sort to shared
nano→display formatters (`nanoPricePer1k`, nano `isExpensiveModel`, nano range formatter).
- (b) float→nano at client boundary: REJECT — violates money-doctrine (`Number()` on money), and cannot
  be bit-identical (wire float is already `base/1e9*1.15`, base integer unrecoverable).
- (c) server estimate endpoint: REJECT as sole mechanism — RPC-per-keystroke kills DX/cost, doesn't remove the fork.
- (d) ship both float + nano: acceptable ONLY as a staging stepping-stone; wrong as end state (two representations).
- Do NOT ship descriptor's loose `PricingSchema` (`z.record`) on the wire — define the named shape or regress type-safety.
- Wire float projection lives in `apps/api/.../models/domain/list-models.ts` (`feeInclusiveUsd`); `process-models.ts` does not exist.
- Float-field consumers to migrate: model-info-panel.tsx (per-1k, isExpensiveModel, `/image`,`/s`), model-selector-helpers.ts
  (sort keys), formatPriceRange + Smart-Model min/max range, and Astro marketing `apps/marketing/src/lib/calculate-cost.ts`.

## Success criterion — REFRAME (load-bearing)
The goal is **"one estimator, input-driven: identical inputs → identical nano output"**, NOT "client display ==
server hold." Those legitimately differ: the server hold is a worst-case **ceiling** (input leg `min(ctx, promptTokens)`,
output leg `min(ctx, declaredMaxOut)` or full ctx); the client gate is a tier-skewed **expected minimum**
(`MINIMUM_OUTPUT_TOKENS`, `estimateTokensForTier`) **plus storage**. The cross-parity test asserts at the PRIMITIVE
level: one model + one `(inputTokens, outputTokens)` → same `bigint` from the client-facing pricing and the server
ceiling primitive. Red today (client float `x*1.15` vs server `roundHalfEvenDiv(base*11500,10000)`).

## Core API shape — REFINED
- `priceRequest(BillableRequest) → Manifest` builds nano line items; does NOT apply markup, does NOT do char→token.
- Manifest is **fixed-items + a separate `variableOutputTokenRateNano`** (output-token count is the free variable),
  because `affordability` is an INVERSE solve `maxOut = floor((balance − fixed)/variableRate)` — not another priceRequest.
  This is the proven `CostManifest`/`calculateBudgetFromManifest` split re-typed to nano bigint.
- `reservationCeiling(manifest, {outputTokenCeiling, fanOutWidth, maxSteps, maxIterations}) → NanoUSD` and
  `affordability(manifest, effectiveBalanceNano) → {canSend, maxOutputTokens, minCostNano, denialReason}` are **two
  reducers over one manifest**, not two priceRequest calls.
- Each `NanoLineItem` carries `marksUp: boolean`; markup applied **once per marked-up subtotal in the reducer**, never
  in priceRequest. Model cost + web-search mark up; storage does NOT.
- **Tier-skewed char→token stays OUTSIDE the core** — a shared pre-adapter (`estimateTokensForTier`, 2/4 chars/tok) the
  CLIENT calls to build the request. Server feeds real/stamped/ceiling token counts. Keeps the core input-driven & bit-identical.
- **Storage lives INSIDE the manifest** (fixed input-chars + variable output-chars/token, tier-inverted).
- **Unify, don't parallel-build:** server `estimate.ts`/`estimate-run.ts` must be REBUILT on the shared reducer, not
  clone it. The whole-DAG `createEstimateRun` (enclosure walk, smartModel max-over-candidates, subWorkflow refuse) stays
  server-side and calls the shared per-node reducer.

## ESCALATED to founder (out of scope to decide here)
**Should the admission *hold* include storage?** Today it does NOT; the client estimate does; **legacy DID** include
storage in the reservation. "Match legacy semantics" argues include it. It is a conscious behavior call, not an accident.
