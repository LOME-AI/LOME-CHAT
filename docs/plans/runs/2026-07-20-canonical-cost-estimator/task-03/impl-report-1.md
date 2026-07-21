# T3 — Core: media + web-search + classifier line items

## Objective

Extend the canonical nano-USD estimator core (`packages/shared/src/estimate/`) with
deterministic image/video pricing, worst-case audio, the web-search worst-case reservation,
and the Smart-Model classifier pre-reserve — all as nano-USD `bigint` line items on the SAME
`Manifest` T2 built, so T2's `reservationCeiling`/`affordability` reducers fold them in
unchanged with markup applied once per marked-up subtotal.

## New exported seam (added to `packages/shared/src/estimate/*` and the shared barrel)

```ts
// media-pricing.ts
buildMediaLineItems(request: BillableRequest): EstimateResult<readonly NanoLineItem[]>

// search-reservation.ts
WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL: bigint          // = MAX_SEARCH_TOOL_CALLS × usdToNanoUsd(SEARCH_COST_PER_CALL) = 50_000_000n
webSearchLineItem(modelCount: number): NanoLineItem

// classifier-line-item.ts
classifierReserveChars(catalog: readonly { id: string; description?: string }[]): number
classifierLineItems(stage: ClassifierStage, outputCharsPerToken: number): EstimateResult<readonly NanoLineItem[]>

// storage-rate.ts
MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n
assertMediaStorageByteRateMatchesSharedFloat(byteRate: number): void

// types.ts (extensions)
ModelRatesNano.perSecond?: bigint                            // flat audio (legacy flat-video) per-second rate
type MediaRateKey = 'perImage' | 'perSecond' | 'perSecondByResolution'
interface MediaBillable { rateKey; dimensionKey?; units; storageBytes }
interface ClassifierStage { pricing: ModelRatesNano; inputTokens: bigint; inputChars: number }
BillableRequest.{ modality?: Modality; media?: MediaBillable; webSearch?: boolean; classifierStage?: ClassifierStage }

// price-request.ts — priceRequest now dispatches on modality and folds search/classifier items.
```

`priceRequest` is the single entry: `modality` absent/`text` → text/token path; `image`/`video`/`audio`
→ media path; `embedding` → fail-closed `invalid-request`. `webSearch`/`classifierStage` append their
items on top of the modality base.

## Files changed

- `packages/shared/src/estimate/types.ts` — added `ModelRatesNano.perSecond`, `MediaRateKey`,
  `MediaBillable`, `ClassifierStage`, and the `modality`/`media`/`webSearch`/`classifierStage` fields on
  `BillableRequest`. Reuses the canonical shared `Modality` (import type from `../modality.js`) rather than
  defining a second modality enum.
- `packages/shared/src/estimate/storage-rate.ts` — added `MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n` +
  `assertMediaStorageByteRateMatchesSharedFloat`, run at module init against the shared float
  `MEDIA_STORAGE_COST_PER_BYTE` (same pattern as `STORAGE_COST_PER_CHARACTER_NANO`).
- `packages/shared/src/estimate/media-pricing.ts` (new) — `buildMediaLineItems`; flat/matrix rate resolvers.
- `packages/shared/src/estimate/search-reservation.ts` (new) — web-search reservation constant + line item.
- `packages/shared/src/estimate/classifier-line-item.ts` (new) — `classifierReserveChars` + `classifierLineItems`.
- `packages/shared/src/estimate/price-request.ts` — extracted `buildTextLineItems`; `priceRequest` dispatches
  on modality and folds web-search + classifier items.
- `packages/shared/src/estimate/index.ts` — `export *` for the three new modules.
- `packages/shared/src/index.ts` — extended the NAMED estimate export block (values + types); no line removed.
- Test files: `media-pricing.test.ts`, `search-reservation.test.ts`, `classifier-line-item.test.ts` (new);
  extended `storage-rate.test.ts`, `price-request.test.ts`.

## Legacy parity — how each formula reproduces legacy

All legacy formulas priced **fee-inclusive** provider cost then added raw storage, `×100` for cents. The
canonical core carries BASE (pre-markup) provider amounts on `marksUp:true` items and raw storage on
`marksUp:false` items; the reducer applies the markup ONCE to the summed marked-up subtotal (T2's canonical
markup-once semantics, differing from legacy per-item only by sub-nano half-even rounding).

- **Image** — `pricing.ts:computeImageExactCents` → `computeMediaWorstCaseCents({prices, multiplier:1, storageBytesPerModel:ESTIMATED_IMAGE_BYTES})`:
  `media-generation.fixedNano = Σ_models(perImage × units=1)`; `media-storage.fixedNano = storageBytes × 18n × modelCount`.
- **Video** — `computeVideoExactCents` (multiplier = durationSeconds, matrix rate by resolution):
  `Σ_models(perSecondByResolution[dim] × duration)` + `storageBytes × 18n × modelCount`.
- **Audio** — `computeAudioWorstCaseCents(pricesPerSecond, maxDurationSeconds)`: flat `perSecond` rate ×
  maxDuration + storage. Reproduced via the flat `perSecond` rate key.
- Legacy `storageBytesPerModel` (`ESTIMATED_IMAGE_BYTES` / `duration × ESTIMATED_VIDEO_BYTES_PER_SECOND` /
  `maxDuration × ESTIMATED_AUDIO_BYTES_PER_SECOND`) is supplied by the caller as `media.storageBytes` — the
  core stays input-driven (`× MEDIA_STORAGE_COST_PER_BYTE_NANO × modelCount`, matching `mediaStorageCost(bytes) × prices.length`).
- **Web search** — `pricing.ts:worstCaseSearchCost()` = `applyFees(MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL)`,
  `× modelCount` at the run level. Reproduced as a `marksUp:true` fixed item =
  `MAX_SEARCH_TOOL_CALLS × usdToNanoUsd(SEARCH_COST_PER_CALL) × modelCount` (50_000_000n/model base). Single-sourced
  from `MAX_SEARCH_TOOL_CALLS`/`SEARCH_COST_PER_CALL`.
- **Classifier** — `smart-model/eligible-models.ts:computeClassifierWorstCaseCents` (the legacy formula the brief
  names). Provider legs (`inputTokens × inputRate + CAP × outputRate`) → `classifier-tokens` (`marksUp:true`);
  storage legs (`inputChars × charRate + CAP × outputCharsPerToken × charRate`) → `classifier-storage`
  (`marksUp:false`). `CLASSIFIER_OUTPUT_TOKEN_CAP` imported from its single home (`smart-model/eligible-models.ts`);
  `classifierReserveChars` single-sources the char basis via `MAX_CLASSIFIER_CONTEXT_CHARS` +
  `computeClassifierPromptOverhead`. The char→token conversion stays in the tier pre-adapter (caller stamps
  `stage.inputTokens`), honoring the "core is input-driven" constraint.

## How the reducer folds the new items (markup-once preserved)

The new items are ordinary `NanoLineItem`s; no reducer change. `foldManifest` sums all `marksUp:true` fixed
amounts (text/media/search/classifier provider) into `fixedMarkedUp` and all `marksUp:false` (all storage) into
`fixedRaw`; `reservationCeiling`/`affordability` apply `applyMarkup` once to the marked-up subtotal and add raw
storage untouched. Verified by the existing reducers suite plus new integration tests folding search/classifier
into a text manifest. No parallel markup path was added — T2's reducer already supported `marksUp` line items.

## Shared media-storage nano constant + drift guard

`MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n` in `estimate/storage-rate.ts`, pinned at module init by
`assertMediaStorageByteRateMatchesSharedFloat(MEDIA_STORAGE_COST_PER_BYTE)` — throws fail-fast if the shared
float `MEDIA_STORAGE_COST_PER_BYTE` (`0.000000018`) ever drifts from `18n`. Mirrors T2's
`STORAGE_COST_PER_CHARACTER_NANO=300n` guard. `apps/api/src/slices/billing/domain/money.ts` (its own 18n +
guard) left untouched per brief.

## TDD evidence

Wrote failing tests first per behavior (image deterministic, video by resolution×duration, audio worst-case
maxDuration, search per-model markup + × modelCount, classifier bounded worst case with tier-inverted output
storage, media storage not marked up, media/classifier fail-closed, prototype-pollution matrix guard). Confirmed
RED: the three new module test files failed to import (modules absent) and the priceRequest dispatch tests failed
because modality/webSearch/classifierStage were ignored (`4 failed files | 5 failed tests`). Implemented sources,
re-ran GREEN. Cross-checked exact nano numbers against the legacy formulas (e.g. search base 50_000_000n =
applyFees inner term; classifier provider 100×5 + 2048×15).

## Self-gate (from `packages/shared`)

- `pnpm test:shared` — PASS. 96 files, 2313 tests. `src/estimate` per-file coverage 100% (media-pricing,
  search-reservation, classifier-line-item, price-request, storage-rate, types all 100%). Coverage gate met.
- `npx eslint src/estimate/ src/index.ts` — CLEAN (0 problems) after the LAST edit. Refactored `resolveMediaRate`
  into `resolveFlatRate`/`resolveMatrixRate` to clear a cyclomatic/cognitive-complexity lint error (real, fixed —
  not silenced).
- `turbo typecheck --filter=@hushbox/shared` — the ONLY errors are the known T6-owned float-field errors
  (`pricePerInputToken`/`pricePerOutputToken`) in `smart-model/eligible-models.ts`, `smart-model/eligible-models.test.ts`,
  and `capabilities/model-capabilities.test.ts` — the T5 wire-schema-migration blast radius. `npx tsc --noEmit`
  grep for `estimate/` → ZERO errors originate in my files.
- `jscpd --threshold 2` on the 6 changed source files — 0 clones (0% duplication).
- Barrel diff: `git diff packages/shared/src/index.ts` = insertions only, 0 existing lines removed; `pre-inference`
  and every other barrel line intact.
- `turbo typecheck --filter=@hushbox/web` — errors are all pre-existing T5/T6/T9 wire-migration fallout
  (`model-info-panel.tsx`, `model-selector-helpers.ts`, `use-prompt-budget.ts`) plus an unrelated api
  `ExecutionContext` error. Verified NONE reference my new symbols and I edited no web/api file — my additive
  barrel edit introduced no NEW error.

## Acceptance criteria

- Media pricing (deterministic image/video, worst-case audio; provider marks up, storage does not; legacy
  component formulas reproduced × modelCount) — MET. Evidence: media-pricing.test.ts.
- Web-search reservation = `applyMarkup(MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL)` per model, marks up,
  single-sourced — MET. Evidence: search-reservation.test.ts + price-request integration test.
- Classifier bounded worst case (truncated context + prompt overhead + `CLASSIFIER_OUTPUT_TOKEN_CAP` output at
  classifier nano rates + storage, marks up), constant imported from its single home — MET. Evidence:
  classifier-line-item.test.ts.
- Items fold into T2's reducers unchanged; markup applied once per marked-up subtotal — MET (no reducer change;
  integration tests).
- Shared nano media-storage constant single-sourced + drift-guarded — MET. Evidence: storage-rate.test.ts.
- Media SIZE gate (T7) NOT implemented — correctly out of scope.
- nano bigint only, fail-closed Result, boundaries (shared, no infra), explicit return types, T2 style/error
  channel — MET. No text-path regression (existing price-request/reducers suites green).

## Deviations

- **Added `ModelRatesNano.perSecond?: bigint`** (types edit, "if strictly needed"): audio worst-case needs a flat
  per-second rate and the reserved fields only cover image (flat) and video (matrix). Additive; no existing
  reserved field reshaped; no current consumer reads it.
- **`BillableRequest.modality` is optional (default text)** rather than a required discriminant as sketched in the
  plan's Interfaces block — required to avoid regressing T2's audited text path/tests. Reuses the canonical shared
  `Modality` (not a second enum), so `embedding` is a member and is explicitly fail-closed.
- The text-only fields (`inputTokens`/`inputChars`/`outputCharsPerToken`) remain required and are unused/ignored
  on the media path (callers pass harmless placeholders). Kept required to avoid rippling into the text path.

## Concerns / auditor scrutiny points

- Markup-once vs legacy per-item markup differs by sub-nano half-even rounding — intentional per T2/plan, not a
  parity defect. Worth confirming the auditor accepts this as the canonical semantics.
- `MediaBillable.units`/`storageBytes` and classifier `inputTokens`/`inputChars` are caller-supplied — the core
  never derives the byte estimate or the char→token conversion (input-driven constraint). T7/T9 own building
  those from `ESTIMATED_*` byte constants and the tier pre-adapters.
- The api-side `classifierWorstCaseBaseNanoUsd` omits storage; the shared core reproduces the LEGACY
  `computeClassifierWorstCaseCents` (with storage) the brief named as the target. T8 unification should confirm
  which basis the admission path adopts.

## Confidence

High — every legacy formula cross-checked to exact nano values, all scoped gates green, estimate coverage 100%,
zero errors originate in owned files, no text-path regression.
