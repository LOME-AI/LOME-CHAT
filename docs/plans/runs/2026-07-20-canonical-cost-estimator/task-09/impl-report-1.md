# T9 — Client hooks rewired onto the shared canonical cost core

## Objective
Rewire the client billing hooks so client and server compute prices from ONE
implementation (the `packages/shared/src/estimate/` core), and complete the
apps/web typecheck (RED only on these hook files + the deferred media-display
components). No re-implementation of pricing on the client — the hooks build a
`BillableRequest`, call `priceRequest` → manifest, and reduce via `affordability`
/ `reservationCeiling`. Nano bigint until the final display conversion.

## Files changed
- `apps/web/src/hooks/billing/use-budget-calculation.ts` — rewritten to build a
  `BillableRequest` from tier + prompt chars + BASE nano rates, price via
  `priceRequest`, and solve `affordability(manifest, effectiveBalanceNano)`.
  Effective balance is read as exact nano from `useBalance()` (`purchased`/
  `allowance`), never a cents round-trip. Input shape now carries BASE nano rates
  + a `webSearch` boolean; return shape is a lean superset of what consumers read
  (maxOutputTokens, estimatedInputTokens, estimatedMinimumCost, currentUsage,
  capacityPercent, isBalanceLoading). Debounce/synchronous-flush machinery kept.
- `apps/web/src/hooks/billing/use-media-cost-estimate.ts` — rewritten to price
  media through the core. Input now takes per-model BASE nano rate arrays
  (`imageRatesNano` / `videoRatesNano` / `audioRatesNano`); builds a media
  `BillableRequest` and totals it via `reservationCeiling(outputTokenCeiling=0)`
  = `markup(provider) + storage`. Returns the same `{ estimatedCents,
  estimatedDollars }` shape.
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — rewired the pricing glue:
  `buildModelTokenPricing` now reads `pricing.inputPerToken/outputPerToken` nano;
  `buildMediaRateArrays` reads `pricing.perImage/perSecondByResolution` nano;
  web search passes `webSearch: true` (core adds the reservation) instead of a
  mirrored `worstCaseSearchCost()` number. Return shape unchanged.
- `apps/web/src/components/chat/media/modality-config-panel.tsx` — the four
  deleted-float reads (`pricePerSecondByResolution`, `pricePerImage`,
  `pricePerSecond`) now read nano `pricing.*` and feed the rewired media hook.
- `packages/shared/src/models/premium-check.ts` — `exceedsTrialBudget` rewired
  off the deleted float `calculateBudget`/`applyFees` onto the core: build a
  trial-tier `BillableRequest`, price it, and compare
  `reservationCeiling(outputTokenCeiling = 2×MINIMUM_OUTPUT_TOKENS)` against the
  trial cap in nano. Parity with the legacy float path verified numerically.
- Tests updated: `use-budget-calculation.test.ts`, `use-media-cost-estimate.test.ts`,
  `use-prompt-budget.test.ts`, `modality-config-panel.test.tsx` (mocks → nano
  wire pricing; web-search / audio assertions adjusted). `premium-check.test.ts`,
  `generation-config-sheet.test.tsx` unchanged (already nano) and pass.

## Not changed (confirmed no change needed)
- `use-resolve-billing.ts` and `billing/client-billing.ts` — the who-pays core
  (`resolveClientBilling`/`resolveFundingDecision`) and `getCushionCents` stay;
  they import no T11-deleted symbol and operate in the cents affordability
  vocabulary the brief says STAYS. `generateNotifications` still imported from
  `@hushbox/shared` (T11 relocates it; name stable).

## How each hook calls the core (BillableRequest + reducer usage)
- **use-budget-calculation:** `models → [{ pricing: { inputPerToken, outputPerToken } }]`,
  `inputTokens = estimateTokensForTier(tier, chars)`, `inputChars = chars`,
  `outputCharsPerToken = outputCharsPerTokenForTier(tier)`, `webSearch?`. Then
  `affordability(manifest, getEffectiveBalanceNano(tier, purchasedNano, freeNano))`
  → `maxOutputTokens` + `minCostNano`. This is the client counterpart of the
  server turn-level estimate; identical inputs → identical nano.
- **use-media-cost-estimate:** per modality a media `BillableRequest`
  (`rateKey` perImage/perSecond, `units`, `storageBytes` from the modality byte
  estimate), priced via `priceRequest` then
  `reservationCeiling(outputTokenCeiling=0, 1,1,1)` = customer total
  (marked-up provider + pass-through storage).
- **premium-check.exceedsTrialBudget:** trial `BillableRequest` from raw provider
  price → nano (`usdToNanoUsd`); `reservationCeiling(outputTokenCeiling = 2×MIN)`
  vs `MAX_TRIAL_MESSAGE_COST_CENTS × NANO_USD_PER_CENT`.

## Media / search / storage / premium via the core (no client re-implementation)
- Media pricing = `buildMediaLineItems` (via `priceRequest`), not the deleted
  `computeImage/Video/AudioCents`. Storage is the core's pass-through byte-rate
  item; markup only on the provider subtotal.
- Web search = the core's `webSearchLineItem`/`WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL`
  (client passes only the boolean), not the deleted `worstCaseSearchCost`.
- Storage (text) = the core's input/output-storage items inside the text manifest.
- Premium trial gate = core `reservationCeiling`, not the deleted float
  `calculateBudget`.

## Nano → display markup boundary
Wire rates are BASE (pre-markup). Markup is applied exactly once, inside the core
reducers (`applyMarkup` on the marked-up subtotal). The hooks convert the
resulting nano bigint to a display number only at the return boundary:
`Number(nano) / NANO_USD_PER_DOLLAR` (dollars) / `NANO_USD_PER_CENT` (cents). No
float money arithmetic mid-path; balances are read as exact nano.

## modality-config-panel migration
`videoResolutionsFor` reads `pricing.perSecondByResolution` keys; `useImageCost`/
`useVideoCost` resolve BASE nano rates (`BigInt(pricing.* ?? '0')`, missing model
→ 0n = storage-only). `useAudioCost` passes 0n rates (see Deviations). The
`generation-config-sheet` video tests were already nano and pass unchanged.

## Residual web typecheck — ONLY the pre-existing non-pricing set
`turbo typecheck --filter=@hushbox/web` residual (grep of `error TS`):
`../api/src/middleware/pipeline-bindings.ts(59,29): TS2304: Cannot find name
'ExecutionContext'` — an API file (modified before this task), Phase-4 attribution.
Zero pricing/hook typecheck errors remain. `@hushbox/shared` typecheck: clean.

## TDD evidence
- Media hook: rewrote the test to the nano interface first (RED against old
  hook), then implemented → 14 passing (markup+storage totals, per-model scaling,
  zero-rate/ghost storage, empty/zero-duration → 0).
- Budget hook: rewrote the test to BASE nano rates + `webSearch` boolean; expected
  values computed from `applyMarkup` + storage; watched fail then pass → 19.
- premium-check: parity of `exceedsTrialBudget` verified against the legacy float
  formula for all four scenarios (identical $ figures); 11 passing.
- Panel: added a test for the new `?? {}` (undefined per-resolution pricing)
  branch.

## Self-gate
- `vitest use-media-cost-estimate.test.ts` — pass (14).
- `vitest use-budget-calculation.test.ts` — pass (19).
- `vitest use-prompt-budget.test.ts` — pass (36).
- `vitest modality-config-panel + generation-config-sheet` — pass (62).
- `vitest premium-check.test.ts` — pass (11).
- `vitest src/hooks/billing src/components/chat/media` — 381 pass; 1 pre-existing
  Failed Suite (`media-content-item.size-guard` — platform-enum ZodError at
  `capacitor/platform.ts` import; non-pricing, documented pre-existing).
- `vitest --root packages/shared` — 2298 pass; 1 Failed Suite
  (`test-polyfills.test.ts` — `vitest-setup.ts` module-resolution artifact of
  raw-vitest invocation, unrelated to premium-check; passes via `pnpm test:shared`).
- Coverage (changed files, per-file ≥95%): use-budget-calculation 100/95.2+,
  use-media-cost-estimate 100, use-prompt-budget 100, modality-config-panel
  95.16% branch, premium-check 100/100 (with one justified `v8 ignore` on an
  unreachable defensive branch). EXIT 0.
- `turbo typecheck --filter=@hushbox/web --filter=@hushbox/shared` — shared clean;
  web residual = pipeline-bindings only (pre-existing).
- eslint (changed files, from package dirs) — exit 0 (web + shared).
- `jscpd --threshold 2` (changed source files) — 0 clones (0%). No mirrored
  pricing implementation.

## Deviations (with reasons)
- **Hook INPUT shapes changed** (return shapes preserved). `useBudgetCalculation`
  and `useMediaCostEstimate` now take BASE nano rates instead of fee-inclusive
  float arrays — forced by the T5 nano wire; both callers are in-scope (owned).
- **Audio media pricing is storage-only.** The nano `WireModelPricing` exposes no
  audio provider rate (audio inference is deferred; the schema/projection carry
  none — `refineAudioPricing` documents this). The old float `pricePerSecond`
  field is gone, so the client cannot price audio provider cost; `useAudioCost`
  and the prompt-budget audio path pass 0n rates → storage-only estimate. The
  two audio-cost tests were migrated to that reality (small positive / renders).
  This is consistent with the post-T5 catalog (audio rows carry no wire price).
- **`worstCaseSearchCost` (number) → `webSearch` (boolean).** The client no longer
  computes a search cost; the core owns the reservation. Web-search tests assert
  the flag, not a dollar amount.
- Two `v8 ignore` comments on genuinely unreachable defensive `!manifest.ok`
  branches (budget hook + premium-check) — valid inputs make the text-path
  `priceRequest` always succeed; the guard is type-narrowing only.

## Concerns / auditor scrutiny points
- **Audio storage-only cost** is the biggest judgment call — flagged above. If the
  intent is that audio should show no cost line at all (rather than storage-only),
  that is a one-line change, but it would require reworking the panel audio-cost
  test that expects a dollar amount. Raised for orchestrator visibility.
- **Effective-balance nano source:** the budget hook reads `useBalance()` directly
  for exact nano (money-clean) while `useUserTierInfo` supplies the tier. Both hit
  the same TanStack Query cache (deduped). Verify this is acceptable vs. threading
  nano through `useUserTierInfo`.
- Parity is by construction (one core, same inputs) — no golden cross-check test
  (T10 dropped). The T4 legacy-semantics parity suite is green.

## Confidence
High — all scoped gates green; residual web typecheck/test failures independently
confirmed to be the pre-existing platform-enum / setup-path breakages named in the
brief; premium-check parity verified numerically against the legacy formula.
