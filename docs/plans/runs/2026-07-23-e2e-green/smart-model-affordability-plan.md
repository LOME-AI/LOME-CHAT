# Plan — Smart Model client==server affordability (one estimate, budget-capped, effort-coherent)

**Status:** approved in principle (user, 2026-07-23). Implement after the in-flight e2e run.
**Class:** money/settlement-adjacent → 2-auditor money panel + a new biconditional contract test.

---

## The invariant we are enforcing

> Every Smart Model configuration the **client** accepts, the **server** admits; every one the client denies, the server denies. One shared computation, no drift.

Formally, for all `(catalog, balance, effortSelection, prompt)`:
`clientAccepts(...) ⇔ serverAdmits(...)`, and the admission hold is always `≤ balance`, and never under-reserves the actual charge.

## Why it diverges today (three disagreeing token bases)

1. **Eligibility floor** — `floorNanoUsd` (`packages/shared/src/estimate/smart-model-affordability.ts:137`): output = `MINIMUM_OUTPUT_TOKENS`. Eligibility asks "can you afford a minimum-viable answer?"
2. **Intended affordable cap** — `answerMaxOutputTokens` (`apps/api/src/slices/chat/domain/smart-model-turn.ts:96`) → `computeSafeMaxTokens` (`packages/shared/src/budget.ts:265`): caps output to the budget when the budget is the limiting factor; returns `undefined` (no cap) when the budget covers the context. BUT it computes ONE cap against the **worst rate + tightest context**, and on the `undefined` path falls back to `max(1, minContextLength − promptTokens)` — the tightest candidate's **full remaining context**, not a budget bound.
3. **Admission reserve** — `estimateSmartModelNode`/`declaredOutputCeiling` (`apps/api/src/slices/models/domain/estimate-run.ts:402,566`): takes the **MAX over each candidate's own `modelCeiling`**; with no per-candidate cap, a candidate whose context is **wider** than the tightest gets reserved at its FULL window (the code comment at `smart-model-turn.ts:146` flags "> $200 on a $100 wallet").

The client reads base 1 (cheapest floor); the server enforces base 3 (widest full-context worst case). → client "affordable", server 402.

Effort compounds this: reasoning tokens (effort-driven) are billed output. Smart Model's **auto-effort** lets the classifier pick the effort level at runtime, so the reserve must cover the worst-case effort's reasoning — another axis the three bases don't currently reconcile.

## Target design — one per-candidate affordable completion cap, shared

Reasoning tokens are **completion (output) tokens**, not a separate leg: a reasoning call's `max_tokens = reasoningBudget (B) + answerHeadroom (H)` (`reasoning-plan.ts:82`), one shared ceiling billed at the output rate. So the whole fix reduces to computing **one number per candidate correctly and sharing it**: the budget-derived **`completionCapTokens(m)`** — the affordable output ceiling — which reasoning + answer share.

For each candidate `m`:

```
inputCost(m)          = inputTokenCeiling(prompt, ctx(m)) * inputRate(m)     # actual prompt, bounded by ctx
spendableOutput(m)    = balance − classifierReserve − inputCost(m)
affordableTokens(m)   = floor( spendableOutput(m) / outputRate(m) )         # completion tokens the budget covers
remainingCtx(m)       = ctx(m) − inputTokenCeiling(prompt, ctx(m))
completionCapTokens(m)= min( affordableTokens(m), remainingCtx(m) )         # capped; see high-budget note
```

**Rules (per candidate m):**
- **High-budget = unbound.** If `affordableTokens(m) ≥ remainingCtx(m)` → the user can afford the whole context; **no cap** — `maxOutputTokens` left at the model default, reserve = full remaining context (which is affordable). (This is `computeSafeMaxTokens`'s `undefined` case, applied per-candidate — never the old single-worst-rate fallback.)
- **Budget-constrained = capped.** Else `completionCapTokens(m) = affordableTokens(m)`; stamp `maxOutputTokens = cap` so the provider cannot exceed what was reserved.
- **Model eligible iff** `completionCapTokens(m) ≥ MINIMUM_OUTPUT_TOKENS` — you can afford at least a minimum-viable answer at zero/no effort. Otherwise the model is excluded.
- **Reserve(m)** = `classifierReserve + inputCost(m) + completionCapTokens(m) × outputRate(m)`. Reasoning is INSIDE the cap, so no extra leg. `≤ balance` by construction for every eligible model.

**Admission hold** = `MAX over the eligible models of Reserve(m)` — `≤ balance` (every member is). **Never under-reserves**: the classifier routes to one eligible model whose actual cost `≤` its reserve `≤` the MAX.

**Client verdict** = "is the eligible-model set non-empty?" from the SAME shared function. Non-empty ⇔ server admits. Biconditional holds.

**Net behavior:** low balance → smaller menu of cheaper models with a capped, shorter answer; can't-afford-min-N → Smart Model blocked honestly. High balance → unbound, full context. Never "affordable then refused."

## Effort — already coherent; do not add a cost leg

Effort feasibility is a **comparison against `completionCapTokens`**, and the machinery already exists — do not re-implement or add a reasoning cost term:
- An effort level is feasible on a model iff `reasoningBudget(effort) + 1 ≤ completionCapTokens(m)` — the reasoning budget must leave ≥1 answer token inside the affordable cap (`pickClassifiedEffortPlan`, `smart-model/effort-dimension.ts`; typed failure `'no-answer-headroom'`; `planReasoning` enforces `H ≥ 1`). Higher effort ⇒ bigger reasoning budget ⇒ needs a bigger cap. This is exactly "to use this effort you must afford a higher ceiling."
- `pickClassifiedEffortPlan(model, classified, completionCapTokens)` already returns a plan whose `maxTokens == completionCapTokens`, so a classified effort **can never spend past the reserve**. It picks a feasible level given the cap; if none fit, the answer runs reasoning-free (documented `auto` behavior).
- So there is NO `(model × effort)` cost matrix and NO separate reasoning reserve. Feed the correct per-candidate `completionCapTokens` into the EXISTING effort planner and it stays coherent: eligibility (cap ≥ MINIMUM_OUTPUT_TOKENS) is at zero effort; higher efforts light up automatically as the cap grows; high budget (unbound cap) makes every offered effort feasible.
- **Load-bearing:** the client must derive the SAME `completionCapTokens` and evaluate effort feasibility the same way, so its accept/deny (and which efforts it offers) match the server.

## One implementation, shared

All of the above — the per-(candidate, effort) cap, eligibility, and reserve — live **once** in `packages/shared/src/estimate/` (extend `smart-model-affordability.ts`, reusing `estimateRunCeilingNanoUsd`/`ratesFromPricing`/`classifierReserveLineItems` already hoisted there). Both consumers call it:
- **Server admission**: `smart-model-turn.ts` (candidate/effort build) + `estimate-run.ts` `estimateSmartModelNode` consume the shared subset+reserve instead of the local `answerMaxOutputTokens` single-cap + `declaredOutputCeiling` MAX-over-full-context.
- **Client**: `apps/web/src/hooks/billing/use-prompt-budget.ts` consumes the shared subset non-emptiness / reserve, not the floor-based `minimumRequiredNanoUsd`.
- **Delete the divergent paths**: the floor-based `affordableSmartModelCandidates` filter, the single worst-rate `answerMaxOutputTokens` cap with its `undefined`→full-context fallback, and the client's headline-min pricing for the affordability decision. (The realistic floor MAY remain as an informational "you'll likely pay ~$X" display, kept strictly separate from the accept/deny gate.)

## Edit sites (to confirm at implementation)
- `packages/shared/src/estimate/smart-model-affordability.ts` — new per-(candidate,effort) affordable-cap + eligibility + reserve; drop floor-based eligibility.
- `packages/shared/src/budget.ts` — `computeSafeMaxTokens` becomes the per-candidate primitive (or is superseded).
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — `answerMaxOutputTokens` replaced by the shared per-candidate cap; effort dimension threads the (model×effort) subset.
- `apps/api/src/slices/models/domain/estimate-run.ts` — `estimateSmartModelNode`/`declaredOutputCeiling` consume the shared cap; the MAX is over the eligible subset (already ≤ balance).
- `apps/web/src/hooks/billing/use-prompt-budget.ts` (+ `packages/shared/src/billing/client-billing.ts`) — client gate on the shared subset.
- Trial path (`trial-smart-model-candidates.ts`) — decide parity separately (out of scope unless a trial test forces it; flag, don't silently diverge).

## TDD (write first)
1. Shared cap math: `(m,e)` with a tight budget → `affordableAnswer` capped, reserve ≤ balance; with a fat budget → unbound (full context), reserve = full context ≤ balance.
2. Eligibility boundary: budget covers exactly `MINIMUM_OUTPUT_TOKENS` (+input+reasoning) → eligible; one nano less → excluded.
3. Effort feasibility via `completionCapTokens` (no cost leg): a higher effort's `reasoningBudget` needs a bigger cap to stay feasible; given a cap, `pickClassifiedEffortPlan` picks a feasible level and its `maxTokens == cap`; a cap too small for any effort runs reasoning-free; high budget (unbound cap) makes every offered effort feasible. Reserve is unchanged by effort (reasoning is inside the cap).
4. **Biconditional contract test** (the missing One-Implementation guard): for randomized `(catalog, balance, effort, prompt)`, assert `clientVerdict == serverAdmits` (the "if these drift, this breaks" test).
5. High-balance concurrency not regressed: a well-funded wallet's reserve ≈ old balance-independent MAX (unbound), so concurrent-run capacity is preserved.
6. E2E: `e2e/chat/smart-model.spec.ts` low-balance case passes with the honest block; add a case where a low-balance user CAN send via a cheaper (model,effort) pair.

## Verification & gates
- 2-auditor money panel: verify no under-reserve, reserve ≤ balance for every admitted config, biconditional holds, high-balance concurrency preserved (concurrent-settlement lens), reasoning/effort priced correctly, one shared implementation (no residual second path).
- Then the targeted e2e for smart-model.

## Resolved (were open questions)
- **Reasoning rate leg** — reasoning is completion/output tokens inside `completionCapTokens` (`max_tokens = B + H`); no separate rate leg, no separate reserve.
- **(model × effort) matrix** — none. One affordable `completionCapTokens` per model; effort feasibility is a comparison against it via the existing `pickClassifiedEffortPlan`.

## Remaining to verify at implementation
- Confirm the admission charge path bills reasoning tokens at the output rate (so pricing the whole cap at the output rate neither under- nor over-reserves).
- Classifier routing stays within the eligible-model set (cap ≥ MINIMUM_OUTPUT_TOKENS) — the candidate list handed to the classifier must be the eligible set, not the full pool.
- `MINIMUM_OUTPUT_TOKENS` is the right eligibility floor vs. a value that also guarantees ≥1 answer token above the *lowest offered* effort's reasoning budget (a zero-effort answer needs no reasoning headroom, so eligibility at zero effort is the floor; efforts above unlock as the cap grows — confirm this matches product intent).
