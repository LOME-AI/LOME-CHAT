# Current affordability/reservation system — verified facts

Distilled from a three-agent investigation on 2026-07-23 (direct file reads; citations
were verified that session). Authoritative over local guessing for this run's briefs.
The target design is `docs/plans/affordability-principles.md` (read it in full).

## Shared estimator (one implementation, both sides)

- `packages/shared/src/estimate/` — barrel `index.ts` re-exports: `types.ts`,
  `price-request.ts`, `media-pricing.ts`, `search-reservation.ts`,
  `classifier-line-item.ts`, `run-ceiling.ts`, `reducers.ts`,
  `smart-model-affordability.ts`, `reasoning-plan.ts`, `pre-adapters.ts`, `format.ts`,
  `storage-rate.ts`.
- Manifest line items (`price-request.ts:45-88`): `text-input-tokens` (fixed, marks up),
  `input-storage` (fixed, pass-through), `text-output-tokens` (variable, marks up),
  `output-storage` (variable, pass-through); plus `web-search-reservation`
  (`search-reservation.ts`, 10 calls × $0.005 × modelCount, marks up),
  `classifier-tokens`/`classifier-storage` (`classifier-line-item.ts`),
  `media-generation`/`media-storage` (`media-pricing.ts:93-124`).
- Reducers (`reducers.ts`): `evaluateManifest` (:51-60) folds without markup;
  `reservationCeiling` (:87-101) = `applyMarkup(fixedMU + ceiling×varMU) + (fixedRaw +
  ceiling×varRaw)` × width×steps×iterations — markup applied exactly once here;
  `affordability` (:122-144) = canSend iff balance ≥ fixed + MINIMUM_OUTPUT_TOKENS ×
  effectiveRate; returns `maxOutputTokens = floor((balance−fixed)/rate)`.
- `run-ceiling.ts`: `ratesFromPricing` (:68-87), `callManifest` (:109-142),
  `estimateRunCeilingNanoUsd` (:187-203, rejects 0n holds).
- Money: `money.ts` — `MARKUP_BASIS_POINTS = 1500n` (:16), `applyMarkup` (:47-52,
  half-even, throws on negative), `roundHalfEvenDiv` (:27-41). `nano-usd.ts` —
  `NANO_USD_PER_CENT = 10_000_000n`.
- Constants (`constants.ts`): `MINIMUM_OUTPUT_TOKENS = 1000` (:164),
  `CHARS_PER_TOKEN_CONSERVATIVE = 2` (:177), `CHARS_PER_TOKEN_STANDARD = 4` (:183),
  `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS = 50` (:151), `MAX_TRIAL_MESSAGE_COST_CENTS = 1`
  (:158), `MAX_SEARCH_TOOL_CALLS = 10` (:222), `SEARCH_COST_PER_CALL = 0.005` (:229),
  `LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD = 10_000` (:170), `MAX_SELECTED_MODELS = 5`.
- Tier adapters (`pre-adapters.ts`): `charsPerTokenForTier` (:28-30, paid 4 / others 2),
  `outputCharsPerTokenForTier` (:43-51, INVERTED: paid 2 / others 4),
  `PAID_CUSHION_NANO_USD` (:57-58, = 50¢), `getCushionNano` (:68-70, paid only),
  `spendableFundsNanoUsd` (:74-79), `getEffectiveBalanceNano` (:87-104: trial/guest
  fixed 1¢ `TRIAL_FIXED_BALANCE_NANO_USD`; free = allowance only; paid = balance+cushion),
  `computePromptCapacity` (:128-134, always 4 chars/token, tier-independent).
- Storage rates (`storage-rate.ts:12,14`): `STORAGE_COST_PER_CHARACTER_NANO = 300n`,
  `MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n`. Storage is never marked up on either side.
- Display formatters (`format.ts`): `nanoPricePer1k`, `nanoPriceRangePer1k`,
  `isExpensiveModelNano`, `nanoUnitPriceUsd` — these apply markup for display today.

## Effort / reasoning

- Canonical ladder `['lite','low','medium','high','max']`
  (`packages/shared/src/reasoning-effort.ts:16`); selections add `auto`/`none`; UI
  labels map `none→'Min'` (:47-55).
- `reasoning-plan.ts`: `REASONING_BUDGET_TOKENS_BY_EFFORT` (:39-46) lite 2048 / low
  4096 / medium 12288 / high 32768 / max 65536; floor 1024 (:30); `clampBudget`
  (:182-189) = `max(min(tier, contextLength), 1024)`; `offeredLevels` (:217-242) is THE
  positional-normalization authority (`ladderFor` counts: 1→[high], 2→[low,high],
  3→[low,medium,high], 4→[low,medium,high,max]); `planReasoning` (:254-285) returns
  `maxTokens = B + answerHeadroom`; `planReasoningOff` (:295-318);
  `reasoningBudgetForWire` (:328-336); `ReasoningWire` branded union (:62-71).
  Documented invariant "G3": explicit levels never silently downgraded (:5-8).
- Server validation: `answerHeadroomTokens`
  (`apps/api/src/slices/chat/domain/turn-definition.ts:312-327`) — requires
  `basis.effective ≥ fixed + (B + MINIMUM_OUTPUT_TOKENS) × rate`; `turnCostBasis`
  (:261-279); `turnMaxOutputTokens` (:281-296) via shared `computeSafeMaxTokens`
  (`packages/shared/src/budget.ts:265-273`: budget cap vs context, returns undefined
  when context binds).
- Pinned-model auto: STATIC order `AUTO_REASONING_EFFORT_ORDER = ['medium','high','low']`
  (`apps/api/src/slices/chat/domain/turn-reasoning.ts:44-48`); Smart Model auto uses
  `['high','medium','low']` (`smart-model-turn.ts:409-458`); falls back reasoning-free.
- Smart Model DOES classify effort: `CLASSIFIER_EFFORT_LEVELS = ['low','medium','high']`
  (`packages/shared/src/smart-model/effort-dimension.ts:18`);
  `pickClassifiedEffortPlan` (:83-105) maps positionally, `maxTokens =
  completionCapTokens`. Execution: `apps/api/src/slices/workflows/nodes/
  smart-model-execution.ts`. Classifier sizing: `CLASSIFIER_OUTPUT_TOKEN_CAP = 2048`,
  `MAX_CLASSIFIER_CONTEXT_CHARS = 4000` (`smart-model/eligible-models.ts:13`,
  `smart-model/truncate.ts`).
- Client effort menu (`apps/web/src/components/chat/input/reasoning-effort-menu.tsx`):
  `classifyLevel` (:57-75) → states `enabled | output-limit | balance`; greyed with
  tooltip, never hidden — EXCEPT trial/unauthenticated where infeasible options are
  filtered out (:314-316). `'auto'` is never disabled (:88 comment). Selection clamp:
  `effectiveReasoningSelection` (`use-reasoning-effort.ts:66-78`).

## Reservation / admission (server)

- Chain: `createAdmissionHook` (`apps/api/src/slices/chat/domain/runtime.ts:571-596`)
  → `admitRun` (`apps/api/src/slices/billing/domain/admission.ts`) with
  `request.estimate` from `createEstimateRun`
  (`apps/api/src/slices/models/domain/estimate-run.ts:612-661`), which walks the
  workflow definition: `modelCall` → `modelCeiling` (:326-382) + web-search
  reservation; `smartModel` → classifier reserve + MAX over candidates (:535-593);
  `subWorkflow` → refused; others 0n; + one-time input storage (:654-657).
- Ceilings (:390-408): `inputTokenCeiling = min(contextLength, promptInputTokens)`
  (full contextLength if unstamped); `declaredOutputCeiling = min(contextLength,
  params.maxOutputTokens)` (full contextLength if undeclared). **There is NO
  max-output-tokens catalog field — `descriptor.limits` holds only `contextLength`**
  (`packages/shared/src/model-descriptor.ts:100`; populated at
  `apps/api/src/slices/models/domain/normalize.ts:177`, empty for image/video
  :294,538).
- Admission Lua (`billing/domain/admission-scripts.ts:38-82`): atomic — concurrent-cap
  count (:63-64), `effectiveSpendable − heldSum ≥ estimate` (:65), per-scope budget
  hashes (:66-70), then writes hold. `effectiveSpendable` computed in TS via shared
  `spendableFundsNanoUsd` (`admission.ts:101-110`). Redis down ⇒ fail closed (:81-83).
- Hold TTL = deadline + 60s (text 300s / media 900s ⇒ 360/960s), ceiling
  `MAX_HOLD_TTL_SECONDS = 960` (`billing/domain/keys.ts:49`). Snapshot TTL 30s.
  `PER_WALLET_CONCURRENT_RUN_CAP = 5` (`chat/domain/constants.ts`). Cost circuit
  `estimate × 5n` (`admission.ts:239`), no-bill on trip, one Sentry event.
- Smart Model admission: `admitSmartModel`
  (`packages/shared/src/estimate/smart-model-affordability.ts:214-282`) — fixedReserve
  = classifier worst case + input storage; per-candidate binary-searched cap
  (`candidateCapTokens` :453-464); keep iff cap ≥ 1000; hold = MAX over eligible;
  `smartModelMinimumRequiredNanoUsd` (:343-367) is the shared balance-independent
  threshold (client/server parity pinned in `smart-model-affordability.test.ts` §
  'client verdict tracks server admission'). Server callers:
  `models/domain/smart-model-candidates.ts:223-245`,
  `trial-smart-model-candidates.ts`.

## Settlement / billing truth

- `chargeWithinTx` (`apps/api/src/slices/billing/domain/charge.ts`): charge =
  `applyMarkup(baseCostNanoUsd) + storageFeeNanoUsd`. Base = OpenRouter inline
  `usage.cost` (text: `providerMetadata.openrouter.usage.cost`; video: `.cost`) with
  `isEstimated=false`; image = deterministic catalog estimate (`isEstimated=true`,
  by design); fallback to catalog estimate + Sentry when inline missing/insane
  (`apps/api/src/slices/workflows/nodes/model-call-execution.ts:471-503`,
  `PROVIDER_COST_SANITY_MULTIPLE`).
- Reasoning tokens and cached-input tokens are recorded
  (`llm_completions.reasoningTokens/cachedInputTokens`,
  `packages/db/src/schema/llm-completions.ts:7-24`) but folded into output/input
  pricing — deliberate conservative over-estimate. `usage_records` has one opaque
  `costNanoUsd` + `isEstimated` (`packages/db/src/schema/usage-records.ts:14-63`).
- Admission is the ONLY balance gate; settlement unguarded; negative balances legal
  (`admission.ts:14-16`). Monthly auditor reconciles OpenRouter account usage vs
  Σ usage_records per modality (ARCHITECTURE.md).

## Client (web)

- `usePromptBudget` (`apps/web/src/hooks/billing/use-prompt-budget.ts:406-525`):
  inputs = `useBalance()` (CORRECTION 2026-07-23: global Query defaults are
  staleTime 5min + refetchOnWindowFocus:false — `query-provider.tsx:61-67`;
  freshness rests on explicit invalidations post-turn + WS `run-finished`, which
  already invalidates balance+budgets for all room members),
  `useConversationBudgets()` (**staleTime: Infinity**, refetch only on budget-edit
  mutations — `use-conversation-budgets.ts:47,66-69,87-90`), `useUserTierInfo`,
  `useModels()`; promptChars = client-measured
  (`systemPrompt.length + historyCharacters + value.length`, :431). Core:
  `useBudgetCalculation` → shared `estimateTokensForTier` + `priceRequest` +
  `getEffectiveBalanceNano` + `affordability`.
- Redis holds and the concurrent-run cap are INVISIBLE client-side; the client
  re-derives spendable from the fetched balance.
- Funding: `resolveClientBilling` (`packages/shared/src/billing/client-billing.ts:
  144-168`) wraps shared `resolveFundingDecision` core + client-only
  `resolveSelfAffordability` (`use-user-tier-info.ts:111-135`); paid negative-balance
  hard block (:151-155).
- Model picker: NO affordability greying — premium lock only
  (`model-list-item.tsx:369-442`, `isPremiumGated` in `model-selector-modal.tsx:
  147-151`). Send blocked at composer via `hasBlockingError`
  (`prompt-input.tsx:799-800`); notifications from `generateNotifications`
  (`packages/shared/src/budget.ts`).
- Smart Model client preflight: `smartModelMinimumRequiredNanoUsd`
  (`use-prompt-budget.ts:359-374`).

## Catalog

- `model_catalog` table: one opaque `descriptor` jsonb + `popularityRank`
  (`packages/db/src/schema/model-catalog.ts:11-31`). `ModelDescriptor`
  (`packages/shared/src/model-descriptor.ts:92-127`): `pricing` =
  `Record<string, NanoUSD | Record<string, NanoUSD>>` (keys from normalize:
  `inputPerToken`, `outputPerToken`, `cachedInputPerToken`, `perImage`,
  `perSecondByResolution`); `limits` = `Record<string, number>` (only
  `contextLength`); `reasoning?: ModelReasoning` (:74-84, verbatim from OpenRouter:
  `mandatory?, supportedEfforts?: string[]|null, defaultEffort?, defaultEnabled?`);
  `parameters` includes a `maxOutputTokens` ParamSpec as a CAPABILITY FLAG (no numeric
  ceiling) when the gateway lists `max_output_tokens` (`normalize.ts:64-76`).
  Hourly cron refresh, skip-unchanged by content hash; `popularityRank` kept outside
  the hash. Catalog rates are PRE-FEE (base provider cost) today.
