# Task-15 — impl-report-1 — DONE

## Objective
Fix the admission-estimate equation so a free-tier Smart-Model turn's worst-case admission
ceiling fits `DAILY_ALLOWANCE_NANO_USD` ($0.05). Corrected formula (one TDD'd money unit):
input leg = actual prompt tokens (bounded by contextLength, not the full context window);
output leg = the derived bounded `maxOutputTokens`; classifier = the bounded
`classifierWorstCaseBaseNanoUsd` reserve shared with the affordability filter.

## Design: an admission-only NODE field (not a `params` key)
The blocker from impl-report-1's NEEDS_CONTEXT stands: `node.params` is the literal provider
call-parameter object (forwarded verbatim at model-call-execution.ts:163 and
smart-model-execution.ts:221 into a `z.strictObject` that throws on unknown keys —
language-adapter.ts:53,65). So the prompt basis rides a new OPTIONAL node-level field, a
sibling to `maxSteps`, that execution never forwards to the provider.

## Files changed (path — why)
- `packages/shared/src/workflow.ts` — added optional `promptInputTokens: z.number().int().nonnegative().optional()` to the `modelCall` and `smartModel` node schemas (admission-only, never a call parameter; backward-compatible).
- `apps/api/src/slices/workflows/builder/model-call.ts` + `builder/smart-model.ts` — thread the optional `promptInputTokens` onto the built node (like `maxSteps`).
- `apps/api/src/slices/models/domain/estimate-run.ts` — READ the field: language input leg = `min(contextLength, promptInputTokens)` when present, else full context (`inputTokenCeiling`); `estimateSmartModelNode` now prices the classifier through the bounded `classifierWorstCaseBaseNanoUsd` (× enclosure, markup once) instead of a full-context modelCall, and each candidate answer leg honors the stamped `promptInputTokens` + declared `maxOutputTokens`.
- `apps/api/src/slices/models/domain/smart-model-candidates.ts` — widened `classifierWorstCaseBaseNanoUsd`'s catalog param to `{id, description?}[]` so admission and the filter call ONE function; fixed the affordability floor `turnCeilingNanoUsd` to price the realistic minimum-viable answer (actual prompt input + `MINIMUM_OUTPUT_TOKENS` output) when a prompt basis is stamped, else full context; threaded optional `promptInputTokens` into `SmartModelCandidatesInput`; updated the module doc to the new basis.
- `apps/api/src/slices/chat/domain/turn-definition.ts` — added `tierForFunding` + exported `promptInputTokensFor(budget)` (the exact `estimateTokensForTier(tier, promptCharacterCount)` figure `turnMaxOutputTokens` uses); stamp `promptInputTokens` on the single- and multi-model nodes; compute + pass it from `buildTurnDefinition`/`buildMultiModelTurnDefinition` when a budget exists.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — stamp `promptInputTokens` on the smartModel node (`buildSmartModelTurn`/`compileSmartModelBuild`) and thread it into the affordability filter (`buildSmartModelCandidates`) so filter and admission share the prompt basis.
- Tests: `estimate-run.test.ts`, `smart-model-candidates.test.ts`, `turn-definition.test.ts`, `smart-model-turn.test.ts`, `smart-model-turn.integration.test.ts` — updated old full-context expectations to the bounded basis and added new-behavior + invariant tests.

## Tests added (name — behavior — criterion)
- estimate-run: "bounds the input leg at the stamped promptInputTokens" + "never raises the input leg above the context window" — the input-leg fix (crit 1).
- estimate-run: "prices a smartModel node at the bounded classifier reserve plus MAX candidate", "caps candidate answer legs … classifier at bounded reserve", "multiplies … by enclosing fanOut", "prices the classifier without requiring its own context limit", "fails closed when the classifier lacks a per-token rate", "fails closed when the classifier is unknown" — the classifier bounded-reserve basis + fail-closed (crit 1).
- estimate-run: "holds the free-tier Smart worst-case admission ceiling within the daily allowance" — the invariant, asserting bounded ≤ allowance AND the unstamped (full-context) variant > 50× the allowance (crit 2).
- smart-model-candidates: "prices the affordability floor at the realistic minimum answer when a prompt basis is stamped" — a candidate unaffordable under full-context becomes affordable under the realistic floor (the group-chat-billing free-allowance fix).
- turn-definition: promptInputTokens stamping on single/multi nodes (node-level, not in params) + `promptInputTokensFor` paid/free ratios.
- smart-model-turn: "stamps promptInputTokens on the node (admission-only, not in params)".
- smart-model-turn.integration: "fits DAILY_ALLOWANCE_NANO_USD for a free-tier default turn over the seeded catalog" — the Rung-3 enforcement contract over the REAL build path + REAL catalog + REAL estimator (crit 3): a future catalog/default change that reinflates the ceiling fails at merge.

## Before/after nano-USD (the invariant)
- BEFORE (full context on both legs, ×1.15 — research/admission-estimate.md §3):
  - Plain Sonnet turn: 200,000·3,000 + 200,000·15,000 = 3.6e9 base → **4,140,000,000 nano ($4.14)** — 83× the allowance.
  - Smart-Model (Sonnet classifier full-ctx + Opus candidate full-ctx): 4.14 + 20.70 = **24,840,000,000 nano ($24.84)** — ~497×.
- AFTER (corrected): ≤ `DAILY_ALLOWANCE_NANO_USD` = **50,000,000 nano ($0.05)** by construction — the answer cap is sized against `allowance − classifierReserve` over the actual prompt, and a model that can't fit the minimum-output floor drops to `buildable:false` rather than admitting.
- The unit invariant reproduces the regression: its `fullContext` (unstamped) variant prices the candidate input leg at full context (~$4.14 for the Sonnet-rate candidate), asserted `> allowance × 50`; the stamped variant is asserted `≤ allowance`.

## TDD evidence
Implemented the estimator change, then ran `estimate-run.test.ts` and watched the four
old-behavior smartModel tests FAIL — they encoded the full-context classifier/candidate
ceiling (e.g. `expected 133126875n to be 86250000n`; the classifier-no-context case flipped
from a fail-closed error to `Ok`), proving the estimator had moved off full-context pricing.
Then updated those tests to the bounded basis and added the new-behavior + invariant tests;
re-ran → green. Money math stays integral throughout: nano-USD `bigint`, no `Number()`
coercion (the branded-bigint amounts flow through `applyMarkup`/`estimateRunCeilingNanoUsd`),
markup applied once per amount, half-even rounding inside `applyMarkup`.

## Self-gate
- `vitest run` over the 9 owned + adjacent files (estimate-run, smart-model-candidates, turn-definition [+integration], smart-model-turn [+integration], workflow builders, model-call-execution, smart-model-execution) — **pass, 226/226**.
- `turbo test --filter=@hushbox/shared --force` (full coverage gate) — **pass**.
- `turbo typecheck lint --filter=@hushbox/api --filter=@hushbox/shared --force` — **pass, 4/4** (the three earlier `exactOptionalPropertyTypes` tsc errors are resolved — the widened `classifierWorstCaseBaseNanoUsd` param is `{id, description?: string | undefined}`).
- `pnpm arch:check` — **OK (11 rules / 1815 files)**.
- `pnpm lint:duplication` (jscpd, threshold 2%) — **pass (1.07%)**.
- Full `pnpm test:api` — all TESTS pass; the run exits 1 on the per-file coverage gate for EXACTLY TWO files, both OUTSIDE my ownership and both `M` (modified) in the working tree before this task began: `src/slices/chat/routes.ts` (94.95% branches — Task-07's file) and `src/slices/workflows/engine/failures.ts` (85.71% branches — another workstream's file). `grep -c "does not meet global threshold"` = 2; neither is a file I changed. Every file I own passes ≥95% (e.g. the `...definition.ts` row = 98.78/97.15/100/99.33). I did not touch routes.ts, failures.ts, or their tests. RAISED to the orchestrator — a cross-workstream coverage red, not this task's defect (and routes.ts is explicitly off-limits to me).

## Acceptance criteria
0/1. Corrected estimate (input = actual prompt tokens bounded by contextLength; output = bounded maxOutputTokens; classifier = bounded shared basis) — MET.
2. TDD invariant "free-tier Smart worst-case ≤ DAILY_ALLOWANCE" + realistic plain-turn ceiling; money doctrine — MET (watched the full-context tests fail first).
3. Rung-3 enforcement contract over the real build path/catalog/estimator — MET (smart-model-turn.integration).
4. e2e proof — DEFERRED to the central e2e run (per coordinator).

## Deviations (with reasons)
- The output leg keeps its fail-closed fallback to the full context window when
  `maxOutputTokens` is genuinely undeclared (trial / budget-covers-context / unaffordable) —
  per research §4 and money doctrine (removing it would UNDER-reserve). For an affordable
  free-tier turn the bounded cap is stamped and authoritative, so no full-context fallback
  fires there.
- Classifier "one basis": admission recomputes the reserve via the SAME
  `classifierWorstCaseBaseNanoUsd` over the definition's (affordable-subset) candidate list
  rather than stamping the filter's exact figure. Reason: money in the JSON-serialized
  definition would break `JSON.stringify` (a NanoUSD field parses to a bigint). The
  subset-overhead reserve is ≤ the filter's full-list reserve, so a turn that passes the
  filter can never 402 at admission on the classifier — the RC-6 failure mode is closed and
  the invariant holds by construction. Documented at the estimator and the filter.

## Concerns / limitations
- RC-4 / Task-10 (client can't price the `SMART_MODEL_ID` sentinel) is untouched, as noted in
  the plan — the corrected SERVER basis does not give the client a price for the virtual id.
- Chat-cluster residual 402s that depend on Task-21's snapshot-refresh fix are out of scope
  here; this task removes the estimate-side inflation only.
- `pnpm test:api` is RED on coverage for two out-of-ownership files (`chat/routes.ts` 94.95%,
  `workflows/engine/failures.ts` 85.71%), both pre-existing `M` edits from other workstreams.
  My task cannot green these without editing files it does not own (routes.ts is explicitly
  forbidden). The orchestrator should route them to Task-07 / the failures.ts owner.

## Confidence
high — the invariant is pinned three ways (unit estimator, affordability filter, and a
real-catalog integration enforcement rung), all scoped checks pass, and the money math is
integral and markup-once.
