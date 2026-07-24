# Multi-model turn billing/estimation — verified facts (explorer, 2026-07-23)

Reported inline by a read-only explorer; filed by the orchestrator verbatim in
substance. All citations verified that session.

## 1. Definition shape

- `buildMultiModelTurn` (`apps/api/src/slices/chat/domain/turn-definition.ts:626-659`)
  builds N independent top-level `modelCall` sibling nodes (`answer0..N-1`,
  `multiModelNodeId` :607-609), NOT an engine `fanOut` (doc comment :614-616: fanOut's
  single static-model body cannot express N different models). Each sibling:
  `optional: true`, `onError: 'skip'` (:637-638), same prompt input port, shared
  web-search tooling when set.
- Siblings have no enclosing container → `enclosureFor` default `{fanOut:1, loop:1}`
  (`estimate-run.ts:127-196`) — `DeclaredCeiling.maxFanOutWidth = 1` per sibling.
- `MAX_SELECTED_MODELS = 5` (`constants.ts:232`; route schema `routes.ts:100-101,156`).
- Media turns mirror the N-sibling shape (`buildMediaTurn`, :753-790).

## 2. Two formulas — only one authoritative

- **Authoritative admission ceiling** (`createEstimateRun`, `estimate-run.ts:612-662`):
  one `modelCeiling` per sibling against that model's OWN pricing + contextLength
  (single-model `priceRequest` call inside `callManifest`, `run-ceiling.ts:109-142`),
  summed (`perNode.reduce`, :658-659) + input storage once (:652-657). No
  double-counting: width=1, N expressed as N priced nodes.
- **Guess formula** (`priceRequest` with all N models — `sumRate`,
  `price-request.ts:29-42`; output-storage × modelCount :83-85): sums rates, caps by
  `min(contextLength)`. Used by client preview (`use-budget-calculation.ts:147`) and
  the server's answer-cap sizing (`summedTurnPricing`, `turn-definition.ts:171-181`),
  then reconciled by binary search `fitAnswerCapToCeiling` (:414-435) against the
  authoritative estimator. Drift-risk documented at `turn-definition.ts:391-405`.

## 3. Per-model maxTokens / reasoning

- ONE shared answer cap H for every sibling (`withAnswerCap`, :360-382;
  `MultiModelTurnParams.maxOutputTokens` doc :593-598). `computeSafeMaxTokens` called
  with `basis.minContextLength` (minimum across models, :174,266).
- Reasoning per model: `TurnReasoningByModel` map (`turn-reasoning.ts:28`); sibling
  wire cap = its own Bᵢ + shared H; H sized against max B across models (:880-882).
- Pinned effort: `levelEntries` (`turn-reasoning.ts:170-184`) requires EVERY model to
  offer the level or whole-build 400. `auto` resolves per model via static
  `AUTO_REASONING_EFFORT_ORDER` (:44-48,155-167); `none` per model (`offEntries`,
  :101-120), refusing only mandatory-reasoning models.

## 4. Settlement

- One `runId`; one `SettlementCharge`/`usage_record` per generation keyed by node id
  (`flow-executor.ts:101-133`); idempotency `${runId}:${charge.key}`
  (`workflows/engine/settlement.ts:178`).
- Partial failure: skipped sibling → no content → no charge
  (`workflows/engine/settlement.ts:124-125`). All-fail → `AllBranchesFailedError`,
  transaction rolls back, nothing persists/bills (`chat/domain/settlement.ts:235-242`).
- Storage: per-charge response/media storage (`withStorageFees`,
  `chat/domain/settlement.ts:1112-1125`); prompt input-storage attributed only to the
  FIRST charge (:1105-1108), mirroring the estimate side.
- N siblings persist as N assistant messages, one parent/batch, last = fork tip
  (`groupByOriginatingNode` :412-426, `writeGraftedTurn` :496-548). Display cost
  mirrored to debit via `aggregateDisplayCostByKey` (:469-485).

## 5. Client preview

- `buildModelTokenPricing` (`use-prompt-budget.ts:285-297`; missing models → 0n rates).
- `useBudgetCalculation` feeds ALL models into `priceRequest` (guess formula);
  `min(context)` drives only capacity display (:425); `affordability()` solves one
  shared maxOutputTokens against the summed manifest.
- `estimatedCostCents` (`resolveEstimatedCostCents` :332-349) is consumed ONLY by
  funding/denial logic + tests — no production component renders it.

## 6. Group budgets

- `admitRun` takes ONE `estimateNanoUsd` (the summed ceiling) checked against wallet
  AND every scope with the same single figure (`admission.ts:182-206,218-257`).

## 7. Concurrency

- `LEVEL_STREAM_CONCURRENCY = DEFAULT_COMPILE_LIMITS.maxFanOutWidth = 6`
  (`interpreter.ts:146`, `compile/context.ts:45-52`); siblings share one DAG level →
  `mapWithConcurrency` (:471-474); 5 ≤ 6 so all run concurrently. Stream ids
  `${nodeId}#${streamSequence}` (:970) — same keying as charges. Engine `fanOut`
  uses compile-time width check + `Promise.all` (:777-779; `compile-definition.ts:189`).
- Cost-circuit exposure bound doc: `interpreter.ts:420-430`.

## Gaps
- Lua script body not re-read line-by-line; trial multi-model not re-verified
  (doc comment says paid-only); `use-media-cost-estimate.ts` internals not swept.
