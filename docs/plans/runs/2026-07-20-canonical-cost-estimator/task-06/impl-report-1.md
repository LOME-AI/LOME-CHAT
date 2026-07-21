# T6 — Migrate ALL float-pricing-field consumers (restore compile)

## Objective
Own the full blast radius of T5's float-field deletion (`pricePer*`/`minPricePer*`/`maxPricePer*`)
so `packages/shared` + `apps/marketing` COMPILE and `apps/web` DISPLAY files compile — web left RED
only on the T9-owned billing hooks. Add shared nano→display formatters (markup-applying), migrate
display/sort consumers + marketing `calculate-cost.ts`, delete `eligible-models.ts` float functions
(preserving `CLASSIFIER_OUTPUT_TOKEN_CAP`), and fix `capabilities/model-capabilities.test.ts` fixtures.

## Reconciliation of the prior (crashed) attempt
`git status` + diffs showed the prior attempt had completed the SHARED side and the web/marketing
SOURCE files, then died before the web fixture TEST files:
- DONE & correct (verified, kept): `estimate/format.ts` + `format.test.ts` (new), estimate barrel
  `index.ts` + root `index.ts` named export block, `smart-model/eligible-models.ts` deletion,
  `capabilities/model-capabilities.test.ts`, `model-info-panel.tsx` + test, `model-selector-helpers.ts`,
  `hooks/models/models.ts`, marketing `calculate-cost.ts` + test, `extract-providers.test.ts`.
- NOT done (finished here): ~21 web fixture test files still carried the deleted float fields; the
  prior `eligible-models.ts` migration left 4 ESLint errors in `model-selector-helpers.ts`;
  `format.ts` mirrored the expensive-model threshold as a hardcoded nano literal (banned by the new
  "One Implementation, Shared" rule).
I verified the kept work against criteria rather than trusting it; two defects surfaced and were fixed
(threshold mirror; helpers lint), plus the fixture migration was completed.

## Formatter signatures (all apply the 15% customer markup to BASE nano before rendering)
In `packages/shared/src/estimate/format.ts` (exported via the estimate barrel + root `index.ts`):
- `nanoPricePer1k(baseNanoPerToken: bigint): string` → `strippedDollars(applyMarkup(base × 1000n))` (e.g. `$0.00115`).
- `nanoPriceRangePer1k(minBase, maxBase: bigint): string` → `"$lo – $hi / 1k"` (both bounds marked up).
- `isExpensiveModelNano(baseInput, baseOutput: bigint): boolean` → `applyMarkup((in+out) × 1000n) >= threshold`.
- `nanoUnitPriceUsd(baseNano: bigint, fractionDigits): string` → `fixedDollars(applyMarkup(base), n)` (per-image / per-second).
All money math is integer `bigint`; the dollar STRING is produced only at the very end via
`nanoUsdToFullDollarString` / `roundHalfEvenDiv`. Wire is BASE/pre-markup, so markup is applied here (once).

Threshold now DERIVED, not mirrored (rule compliance):
`EXPENSIVE_MODEL_THRESHOLD_PER_1K_NANO = usdToNanoUsd(EXPENSIVE_MODEL_THRESHOLD_PER_1K)` — same
derive-don't-mirror pattern already used by `search-reservation.ts` (`usdToNanoUsd(SEARCH_COST_PER_CALL)`).
Removed the hardcoded `100_000_000n` mirror.

## Files migrated
Value convention: `nano = round(floatUsd × 1e9)`; zero fields dropped; `min/maxPricePer*` →
`min/maxPricing: WireModelPricing`; flat `pricePerSecond` (audio) has no wire home → dropped (audio
carries no wire pricing). Display assertions updated to the marked-up figure.

- Marketing (prior): `calculate-cost.ts` (+test), `extract-providers.test.ts`.
- Web sources (prior): `model-info-panel.tsx`, `model-selector-helpers.ts`, `hooks/models/models.ts`.
- Web SOURCE lint fix (here): `model-selector-helpers.ts` — `minNano` rewritten loop-based (no
  `reduce`/`Math.min`-on-bigint/non-null-assertion); `.map((v)=>BigInt(v))` → `.map(BigInt)`.
- Web fixture test files migrated (here, 21): `hooks/models/{models,use-model-validation,
  use-model-validation.loop,use-resolve-default-model,use-premium-model-click,
  use-selected-model-capabilities}.test.ts(x)`; `components/chat/model-selector/{model-selector-modal,
  model-selector-helpers,model-selector-button,model-list-item,model-list-body,use-filtered-models}.test.*`;
  `components/chat/{layout/{comparison-bar,chat-header},media/{generation-config-sheet,
  generation-summary-chip},message/message-item,input/prompt-input,page/chat-welcome}.test.*`;
  `routes/_app/chat.index.test.tsx`; `demo/seed-model-selection.test.ts`.
- Shared display-assert test updated (here): `model-selector-helpers.test.ts`,
  `model-selector-modal.test.tsx` (switched to `nanoPricePer1k`; per-image `$0.040→$0.046`, per-second
  `$0.20→$0.23`, per-1k markup; audio rows show provider only).

### Migration mechanics + a real tooling bug caught
Bulk fixture migration done with a ts-morph codemod (scratchpad), spread-bearing factory objects
migrated by hand (pricing placed before `...overrides` so callers still override). **ts-morph
`getLiteralValue()` MISPARSES separator'd decimals** (`0.000_000_1` → `1`, off by 1e7) — the first
codemod run produced wrong nano money values (e.g. gpt-5-nano `'1000000000'` instead of `'100'`),
which flipped a pin-derivation test. Caught via the failing test, root-caused, and fixed by parsing
the raw source text (`Number(node.getText().replace(/_/g,''))`). All fixtures reset and re-migrated
with the corrected parser; spot-checked `0.000_000_1 → '100'`.

## eligible-models.ts deletion + cap preservation
Deleted (superseded by the T2/T3 core): `combinedPrice`, `filterAndSortCandidates`,
`buildEligibleModels`, `computeMaxClassifierOverhead`, `computeClassifierWorstCaseCents` + their tests.
`CLASSIFIER_OUTPUT_TOKEN_CAP = 2048` PRESERVED at its current path
`packages/shared/src/smart-model/eligible-models.ts:13` — NOT moved; `estimate/classifier-line-item.ts`
(T3) and the api importers still resolve it there. Verified: `grep` shows the cap only at that path
(+ read-only references).

## Barrel integrity
`git diff -- packages/shared/src/index.ts` shows **0 removed existing lines** (only added formatter +
estimate exports). No TS2308.

## Self-gate results
- `turbo typecheck lint --filter=@hushbox/shared` — PASS (2 tasks).
- `turbo typecheck lint --filter=@hushbox/marketing` — PASS (2 tasks, 0 errors).
- `pnpm test:shared` — PASS: 96 files / 2306 tests, coverage gate green (format.test.ts 11/11).
- `turbo typecheck --filter=@hushbox/web` — residual errors grouped by file:
  - `src/hooks/billing/use-prompt-budget.ts` (1) — **T9-owned**, expected RED.
  - `src/components/chat/media/modality-config-panel.tsx` (4) — **T9-coupled** (see Deviations).
  - `../api/src/middleware/pipeline-bindings.ts` (1) — pre-existing, out-of-scope (apps/api, `ExecutionContext`).
  (Only `use-prompt-budget` of the 4 T9 hooks errors at typecheck; the other three compile against
  the still-present float `pricing.ts` helpers T11 deletes.)
- ESLint on all changed web files — clean (exit 0) after the LAST edit (run from `apps/web`).
- `jscpd --threshold 2` on changed files — 1 clone / 0.64% duplicated lines, under threshold.
- `test:web` — NOT green; see Deviations (pre-existing env breakage + T9 coupling). Every migrated
  file that loads passes: `model-selector-modal` (175 with helpers), `models.test.ts`,
  `use-model-validation(.loop)`, `use-resolve-default-model`, `use-premium-model-click`,
  `use-selected-model-capabilities`, `model-list-item/body`, `model-selector-button`,
  `use-filtered-models`, `comparison-bar`, `generation-summary-chip` — all PASS.

## Acceptance criteria
- (a) Shared nano→display formatters applying markup — MET (`format.ts`, exported; threshold derived).
- (b) apps/web display/sort consumers + marketing `calculate-cost.ts` migrated off deleted fields — MET
  (no deleted-field code references remain outside T9 hooks + modality-config-panel; test-title strings
  like "sorts image models by pricePerImage" left as behavior descriptions, not field refs).
- (c) `eligible-models.ts` float functions deleted, `CLASSIFIER_OUTPUT_TOKEN_CAP` preserved in place,
  `model-capabilities.test.ts` fixtures on nano `WireModelPricing` — MET.
- packages/shared + apps/marketing typecheck/lint GREEN — MET. apps/web display files green — MET
  (residual = T9 hooks + T9-coupled modality-config-panel + pre-existing api error).

## Deviations / auditor scrutiny points
1. **modality-config-panel.tsx (+ its test) is a 5th+ RED file beyond the 4 T9 hooks — attributed to
   T9.** Its `useImageCost/useVideoCost/useAudioCost` closures read the deleted fields to feed
   `useMediaCostEstimate` (T9), whose interface is float `readonly number[]` "fee-inclusive USD" and
   whose body uses deleted float helpers. Migrating it in T6 would require either `Number()`-coercing
   nano (banned by money-doctrine) or changing the T9 hook's interface/semantics (out of bounds).
   These callers must move WITH T9's `useMediaCostEstimate` nano rewire. Left unmigrated; raised.
   Consequence: `generation-config-sheet.test.tsx` **video** tests crash at runtime
   (`modality-config-panel.tsx:400` reads `pricePerSecondByResolution[res]` on `undefined`) — also T9.
2. **Pre-existing env/setup breakage makes `test:web` red independent of this task.** Many untouched
   files (`lib/retry.test.ts`, `lib/auth.test.ts`, `lib/ws-client.test.ts`, sidebar/billing/route
   tests) fail at module load with a platform-enum `ZodError` (`expected one of web|ios|android`) — a
   test-env config issue, not pricing. Six migrated files (`seed-model-selection`, `chat.index`,
   `prompt-input`, `chat-header`, `message-item`, `chat-welcome`) are blocked by this same env error at
   import (their fixture data was migrated correctly but can't be exercised). Out of T6 scope.
3. **Pre-existing `apps/api/src/middleware/pipeline-bindings.ts` typecheck error** (`ExecutionContext`)
   surfaces in the web typecheck (web references api types). Not a T6 file; from another workstream.

## Confidence
High for the shared formatters, the deletion/cap-preservation, and the fixture migration correctness
(the ts-morph separator bug was caught and fixed; loadable migrated files all pass; barrel intact).
Medium only on the modality-config-panel handoff boundary — a genuine plan under-scoping I resolved by
attributing to T9 per money-doctrine; the orchestrator should fold modality-config-panel(.tsx/.test) +
generation-config-sheet video into T9's brief.
