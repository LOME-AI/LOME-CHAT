# T5 — Wire pricing → named nano `WireModelPricing`, delete float fields — impl report 1

## Objective
Replace the wire `Model`'s fee-inclusive float pricing (`pricePer*` / `minPricePer*` /
`maxPricePer*`) with a NAMED, TYPED `WireModelPricing` carrying BASE (pre-markup) nano-USD
string rates; project it from the descriptor's nano `Pricing` in `list-models.ts` (no
`feeInclusiveUsd` float collapse); express the Smart-Model min/max range in nano; keep the
typed-client `AppType` intact.

## Wire nano is BASE (pre-markup) — rationale
The wire carries the descriptor's **raw provider rate**, verbatim — no fee, no markup.
- Global Constraint: markup (`base × 11500/10000`, half-even) is applied **exactly once** per
  marked-up subtotal, and design-analysis §"Core API shape" states the canonical estimator's
  reducers apply markup themselves (`marksUp` per line item). If the wire were fee-inclusive,
  the estimator would double-apply, or would have to reverse an unrecoverable float.
- Shipping BASE keeps the 15% markup a single downstream seam (the estimator), satisfying
  "one implementation, no cost math in two places".
- Consequence for T6 (display): price displays must apply markup via the shared nano formatter
  before showing a user-facing price — the wire rate is NOT the charged rate.

## Final types (exact)

`packages/shared/src/schemas/api/models.ts`:
```ts
export const wireModelPricingSchema = z.object({
  inputPerToken: z.string().optional(),
  outputPerToken: z.string().optional(),
  perImage: z.string().optional(),
  perSecondByResolution: z.record(z.string(), z.string()).optional(),
});
export type WireModelPricing = z.infer<typeof wireModelPricingSchema>;
```
Wire fields are `z.string()` (canonical nano decimal), NOT the branded `NanoUSD`
(`z.string().transform(BigInt)`): the route serializes via `c.json(...)` and a branded bigint
is not JSON-serializable. This matches the established wire-NanoUSD precedent
(`getBalanceResponseSchema.purchased.balanceNanoUsd: z.string()`). Consumers (estimator/T6)
parse the string to a branded `NanoUSD` via `parseNanoUSD`.

Updated `modelSchema` pricing surface (replacing the 9 deleted float fields):
```ts
pricing: wireModelPricingSchema.default({}),   // BASE nano rates for this model's modality
minPricing: wireModelPricingSchema.optional(), // Smart-Model cheapest-pool range floor
maxPricing: wireModelPricingSchema.optional(), // Smart-Model most-expensive-pool range ceiling
```
Modality refinement (`refineText/Image/Video/AudioPricing`) was **preserved** but rewritten
onto the nested `pricing` object — each modality still owns exactly one rate dimension; issue
paths are now `['pricing', <rate>]`. This keeps the data-integrity guard AND the safe
`safeParse`-drop behavior `list-models` relies on for merged multi-output descriptors. Audio
lost its positive-rate requirement (the `pricePerSecond` field is deleted — audio carries no
wire rate dimension now, matching the descriptor which has no audio pricing key; audio is
deferred and never projects anyway).

## Files changed
- `packages/shared/src/schemas/api/models.ts` — added `wireModelPricingSchema`/`WireModelPricing`;
  deleted `pricePerInputToken`, `pricePerOutputToken`, `pricePerImage`,
  `pricePerSecondByResolution`, `pricePerSecond`, `minPricePer{Input,Output}Token`,
  `maxPricePer{Input,Output}Token`; added `pricing`/`minPricing`/`maxPricing`; rewrote the
  modality refinement onto `pricing`; updated doc comments (BASE nano, markup downstream).
- `apps/api/src/slices/models/domain/list-models.ts` — removed `displayUsd`/`feeInclusiveUsd`/
  `NANO_PER_USD`/`applyFees` import/`ZERO_PRICING`; `modalityPricing` now returns
  `WireModelPricing` with BASE nano strings (`serializeNanoUSD(nanoUSD(rate))`), absent rate
  omitted (fail-closed drop); `wireCandidate` nests `pricing:`; `smartModelCandidate` emits
  `pricing`/`minPricing`/`maxPricing` nano via new `nanoString`/`minBigint`/`maxBigint`
  helpers (bigint min/max by comparison — `Math.min` would coerce to double and lose nano
  precision).
- `packages/shared/src/schemas/api/models.test.ts` — rewritten to the nano shape (+ a
  `wireModelPricingSchema` describe; modality-refine paths updated to `['pricing', …]`).
- `apps/api/src/slices/models/domain/list-models.test.ts` — projection assertions now check
  BASE nano strings (e.g. `pricing.inputPerToken === '3000'`), image/video/Smart-Model ranges
  in nano; dropped the `applyFees`/`NANO_PER_USD` float helpers.
- `apps/api/src/slices/models/routes.integration.test.ts` — one assertion migrated from
  `model?.pricePerInputToken > 0` to `model?.pricing.inputPerToken === '100'` (models-slice
  route's own contract test).

## What `list-models` now projects
`descriptor.pricing` (integer NanoUSD bigints) → `WireModelPricing` string rates, per modality:
language → `{inputPerToken, outputPerToken}`; image → `{perImage}`; video →
`{perSecondByResolution}`. An absent required rate is omitted, so `modelSchema.safeParse` drops
the row (unpriceable = hidden, fail-closed). Smart Model: headline `pricing` = cheapest pool
(min input/output); `minPricing`/`maxPricing` = pool extrema — all BASE nano, no fee.

## Deleted float fields — consumer break map (downstream handoff)
Deleting the float fields breaks every reader of `Model.pricePer*`. In-gate breakage:

**In-bounds, fixed here:** `list-models.ts`, the two rewritten test files, and the models-slice
route integration test.

**T6 (web/marketing, out of my bounds — EXPECTED, per brief):** `model-info-panel.tsx`,
`model-selector-helpers.ts`, `formatPriceRange` callers, `apps/marketing/src/lib/calculate-cost.ts`.
Not verified this task (owned by T6).

**Out-of-bounds SHARED/API breakage — RAISED (see below):**
- `packages/shared/src/smart-model/eligible-models.ts` — reads `model.pricePerInputToken/
  OutputToken` (lines 81, 95-96). Legacy float smart-model path; **dead runtime** (no live
  importer — only the `smart-model` barrel + its test reference it). Slated for T11 delete /
  T7 rebuild. Cannot compile without migration or deletion.
- `packages/shared/src/smart-model/eligible-models.test.ts` — builds `Model` fixtures with
  float pricing.
- `packages/shared/src/capabilities/model-capabilities.test.ts` — builds `Model` fixtures with
  float pricing (the SUT reads capabilities, not pricing — pure fixture update).

All three are **typecheck-only** breakage: at runtime vitest strips types, the excess literal
properties are ignored, and every one of these files PASSES its tests and per-file coverage
(`pnpm test:shared` EXIT 0). Only `turbo typecheck` is red, and 100% of its errors are in these
three files — my two source files have zero errors.

## Acceptance criteria
1. Named typed `WireModelPricing` with optional nano fields matching descriptor keys — **met**
   (`wireModelPricingSchema`; NOT a loose `z.record` — it is a named `z.object`).
2. Delete float `pricePer*`/`minPricePer*`/`maxPricePer*`; Smart-Model range in nano — **met**
   (all 9 removed; range = `minPricing`/`maxPricing` WireModelPricing).
3. `list-models` projects nano (BASE), no `feeInclusiveUsd` collapse — **met** (float helpers
   removed; verbatim descriptor nano via `serializeNanoUSD`).
4. Typed-client `AppType` intact — **met** (manifest return type untouched/inferred;
   `list-models.ts` imports `WireModelPricing` from `@hushbox/shared` and typechecks clean,
   proving the `export *` barrel chain surfaces the new type).
5. api tests green — **met for the models slice** (662 passed; 4 DB-integration skipped locally
   — no infra; the migrated route assertion runs in CI).

## TDD evidence
- models schema: rewrote `models.test.ts` first → ran RED (24 failed: shape mismatch /
  `['pricing', …]` paths) → implemented schema → GREEN (39 passed).
- projection: rewrote `list-models.test.ts` to nano assertions → ran RED (6 failed: old float
  projection now rejected by the new schema → rows dropped) → implemented projection → GREEN
  (21 passed).
- Added one test to cover the audio per-resolution rejection branch (line was uncovered at
  97%); now models.ts fully exercised.

## Self-gate (commands + results)
- `pnpm test:watch packages/shared/src/schemas/api/models.test.ts` — **pass** (39).
- `pnpm test:watch apps/api/src/slices/models/domain/list-models.test.ts` — **pass** (21).
- `pnpm test:shared` — **pass** EXIT 0 (93 files / 2273 tests; `models.ts` 100% after the added
  test; `eligible-models.ts` 98%/95% — runtime-fine).
- `pnpm test:watch apps/api/src/slices/models/` — **pass** (662; 4 integration skipped, no DB).
- `eslint` on all changed files (from package dir) — **pass**, exit 0, zero warnings.
- `turbo typecheck --filter=@hushbox/shared --filter=@hushbox/api` — **FAIL**, cause 100%
  outside my ownership: errors only in `smart-model/eligible-models.ts`,
  `smart-model/eligible-models.test.ts`, `capabilities/model-capabilities.test.ts` (api error is
  a cascade from the shared build). My files: zero errors.
- `jscpd --threshold 2` on the two changed source files — **pass** (0 clones, 0%).

## Deviations
- `WireModelPricing` fields are plain `z.string()`, not branded `NanoUSD` — forced by
  `c.json` serialization (branded = bigint, not JSON-safe). Matches existing wire-NanoUSD
  precedent. Format validation happens on the consumer's `parseNanoUSD`.
- Kept + rewrote the modality-pricing refinement rather than deleting it (criteria are silent
  on it). It is load-bearing: `list-models` depends on the `safeParse`-drop for merged
  multi-output descriptors, and removing it would silently weaken money-path validation.
- Audio lost its positive-rate requirement (its wire field `pricePerSecond` is deleted; the
  descriptor exposes no audio rate key — audio is deferred and never projects).

## Concerns / auditor scrutiny points
- **RAISED cross-task blocker:** the mandated float-field deletion breaks three out-of-bounds
  in-gate shared files (`eligible-models.ts` + its test + `capabilities` test). `turbo
  typecheck` for shared & api is RED solely because of them. `eligible-models.ts` is dead
  runtime (legacy float smart-model path) and belongs to T7 (rebuild) / T11 (delete); I did
  NOT touch it (would collide with those tasks). The orchestrator must sequence its
  migration/deletion (recommend pulling the T11 dead-code deletion of `eligible-models.ts` +
  its test forward, and a fixture update for the capabilities test) before the tree can
  typecheck-green.
- **Concurrent T2 note:** `packages/shared/src/estimate/` was being written by T2 during this
  run (files appeared mid-session; a transient `reducers.js` import error was visible at one
  point). It is green now and unrelated to my changes — flagging only so a stale snapshot
  isn't misattributed to T5.
- Full `pnpm test:api` (all integration DB tests) not run locally (no infra up); the models
  slice ran fully green and no other api non-test file references the deleted fields (grep
  verified), so runtime blast radius is confined to the models slice.

## Confidence
Medium-high — the deliverable is complete, correct, and its owned gates are green; confidence
is capped only by the out-of-bounds typecheck red (a plan-scoping gap I cannot close within
bounds) and the 4 locally-skipped DB-integration tests.
