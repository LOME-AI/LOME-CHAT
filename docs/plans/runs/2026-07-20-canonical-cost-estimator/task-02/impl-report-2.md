# T2 — cycle 2 fix: restore dropped `pre-inference` re-export

## Objective (this cycle)
Fix the orchestrator-validated Critical finding: when cycle 1 added the canonical-estimator
export block to `packages/shared/src/index.ts`, it also deleted the pre-existing
`export * from './pre-inference/index.js';` line, a net-new cross-package compile break for the
five apps/web files that import the Smart-Model stage-event symbols from `@hushbox/shared`.
Scope: `packages/shared/src/index.ts` ONLY.

## The fix (exact one-line restoration)
Restored, immediately after `export * from './smart-model/index.js';` (its original HEAD position,
`git show HEAD:packages/shared/src/index.ts` → line 36) and above the intact estimate named block:

```ts
export * from './pre-inference/index.js';
```

The `./pre-inference/` barrel still exists and re-exports `events.js` / `labels.js` / `types.js`,
supplying: `StageId`, `StageStartPayload`, `StageDonePayload`, `StageErrorPayload`,
`StageDoneEnvelope`, `STAGE_LABELS`, `stageLabel`, `InferenceTransformation`, `PreInferenceBilling`,
`PreInferenceOutcome`. It is re-exported nowhere else. The estimate block from cycle 1 is untouched.

## No new TS2308 ambiguity
Confirmed. The pre-inference surface (all `Stage*` / `PreInference*` / `Inference*` names) is a
disjoint namespace from `budget.js` and the estimate seam (`NanoLineItem`, `Manifest`,
`BillableRequest`, `priceRequest`, `reservationCeiling`, `affordability`, pre-adapters). The line
coexisted with `budget.js` at HEAD without collision, and the shared typecheck below shows zero
TS2308 and zero pre-inference-symbol errors.

## Before/after — the specific apps/web pre-inference import errors
- **Before (cycle 1, the finding):** `api.ts`, `trial-chat.ts`, `thinking-indicator.tsx`,
  `message-item.tsx`, `use-optimistic-messages.ts` each failed to resolve `StageId` /
  `StageDonePayload` / `stageLabel` / `STAGE_LABELS` / `InferenceTransformation` /
  `PreInferenceBilling` / `PreInferenceOutcome` from `@hushbox/shared`.
- **After (this cycle):** GONE. Grep over the full `@hushbox/web` typecheck output for every
  pre-inference symbol AND the string `pre-inference` → `NONE FOUND`; grep for the five named files
  → `NONE FOUND`. The pre-inference import break is fully resolved.

## Residual out-of-scope errors — attributed to T6 (float-pricing deletion blast radius)
Both suites still emit errors that are NOT mine and are the plan's documented interim RED between
T5-clean and T6-clean (plan §T6 Note): consumers still read the deleted float wire fields
`pricePerInputToken`/`pricePerOutputToken`/`minPricePer*`/`maxPricePer*`. My change is purely
additive (one re-export line) and cannot introduce a pricing-shape type error.

- **@hushbox/shared typecheck:** all errors in `smart-model/eligible-models.ts` (TS2339 on
  `pricePerInputToken`/`pricePerOutputToken`), `smart-model/eligible-models.test.ts`, and
  `capabilities/model-capabilities.test.ts` (TS2353 unknown `pricePerInputToken`). Exactly the
  T6-owned set called out in my brief. Zero errors reference `src/index.ts` or pre-inference.
- **@hushbox/web typecheck:** 69 error lines, all in float-pricing consumers —
  `model-selector-modal.test.tsx`, `models.ts`/`models.test.ts`, `use-model-validation*.test.ts`,
  `use-premium-model-click.test.ts`, `use-resolve-default-model.test.ts`,
  `use-selected-model-capabilities.test.ts`, `seed-model-selection.test.ts`, and the shared
  `smart-model/eligible-models.ts` (via project references). 68 are `pricePer*` TS2353/TS2339; the
  single non-`pricePer*` error is `use-prompt-budget.ts(308,64)` TS2345 — a `TokenPricingCatalogEntry[]`
  argument mismatch, a downstream consequence of the nano-pricing shape change (T6/T9-owned), not a
  pre-inference or index.ts error.

## Self-gate commands + results
- `npx turbo typecheck lint --filter=@hushbox/shared --force` — FAIL, cause entirely out of scope:
  only the T6-owned float-field errors (eligible-models.ts + the two tests). No pre-inference errors,
  no TS2308, nothing in `src/index.ts`.
- `npx turbo typecheck --filter=@hushbox/web --force` — FAIL, cause entirely out of scope: 69 errors,
  all float-pricing (T6/T9) consumers. The five pre-inference importer files and all seven
  pre-inference symbols: absent (grep → NONE FOUND). The break the finding named is resolved.
- `pnpm test:shared` — **PASS**, exit 0 (1 successful, 1 total; per-file coverage gate met).

## Deviations
None. Single additive line, exactly as the brief specified.

## Confidence
High. The dropped line is restored to its original position, disjoint from all other barrel names
(no TS2308), the shared test suite is green, and the pre-inference cross-package break is proven gone
by grep over both typecheck outputs. The remaining typecheck REDs are the plan's documented,
T6-owned interim state and are unrelated to this one-line fix.
