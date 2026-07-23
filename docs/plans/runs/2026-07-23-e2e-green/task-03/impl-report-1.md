# Task-03 impl-report-1 — Smart Model legacy affordable-subset pricing

## Objective
Reserve/estimate Smart Model at worst-case over the AFFORDABLE subset (balance-dependent),
with server admission and client affordability agreeing via ONE shared function in
`packages/shared/src/estimate/`, mirroring legacy `findAffordableCandidates`.

## Files changed (path — why)
- `packages/shared/src/estimate/run-ceiling.ts` (NEW) — hoisted `ratesFromPricing`,
  `callManifest`, `estimateRunCeilingNanoUsd` (+ `CallUsage`/`DeclaredCeiling`/`NodeStorage`/
  `NO_STORAGE`/`outputTokensOf`) from apps/api `estimate.ts`; returns the shared
  `EstimateResult` channel (no neverthrow in shared).
- `packages/shared/src/estimate/smart-model-affordability.ts` (NEW) — the ONE affordability
  gate: `classifierReserveLineItems` (moved here), `priceSmartModelPool` (balance-independent
  reserve + per-candidate floors + `minimumRequiredNanoUsd`), `affordableSmartModelCandidates`
  (the balance filter). Preserves the filter(floor)/reserve(worst-case) asymmetry and the
  classifier reserve on both legs; `$0`-block rests on `classifierReserve > 0`.
- `packages/shared/src/estimate/index.ts`, `packages/shared/src/index.ts` — export the new
  modules/types at the barrel + top level.
- `apps/api/src/slices/models/domain/estimate.ts` — now a thin adapter: `estimateRunCeilingNanoUsd`
  / `callBaseNanoUsd` delegate to the shared core and map `EstimateResult → Result`;
  `ratesFromPricing` + the three types re-exported from shared. All external signatures
  unchanged (domain `Result`), so every existing caller/test is untouched.
- `apps/api/src/slices/models/domain/smart-model-candidates.ts` — `buildSmartModelCandidates`
  maps engine-text descriptors → the shared pool shape, calls `priceSmartModelPool` then
  `affordableSmartModelCandidates`; returns `null` on empty subset. `menu.some(...)` binary
  gate → the shared balance filter. `classifierReserveLineItems` re-exported from shared (kept
  for `estimate-run.ts`). Balance-INDEPENDENCE header/comments rewritten to balance-DEPENDENT.
- `apps/api/src/slices/models/domain/estimate-run.ts` — COMMENT ONLY (the stale
  balance-INDEPENDENT block at the old :444–459). No logic change (`estimateSmartModelNode`
  still MAXes over `node.candidates`, which is now the affordable subset).
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — Smart Model now prices at the shared
  gate's `minimumRequiredNanoUsd` (reserve + cheapest floor) in fractional cents, replacing the
  catalog headline-min; `resolveEstimatedCostCents` helper keeps the hook under the complexity
  cap.
- Tests: `run-ceiling.test.ts` (NEW), `smart-model-affordability.test.ts` (NEW),
  `smart-model-candidates.test.ts` (balance-subset + tie + rate-less-sort), `estimate-run.test.ts`
  (end-to-end subset guard), `smart-model-turn.test.ts` (BALANCE-INVARIANT suite rewritten to
  balance-DEPENDENT + high-balance-not-regressed), `use-prompt-budget.test.ts` ($0 free-tier
  Smart Model → `insufficient_free_allowance`).

## Tests added (name — behavior — criterion)
- candidates `keeps only the AFFORDABLE subset ...` / `grows the affordable subset ...` — subset
  = [cheap] at modest balance, full pool at huge — criteria 1,2 (TDD b), replaces the deleted
  balance-independent-menu assertion.
- affordability `client verdict tracks server null-ness` (3 cases + sweep) — client
  `balance ≥ minimumRequiredNanoUsd` ⟺ server subset non-empty — criterion 3 (TDD d).
- estimate-run `reserves only the affordable subset end to end ...` — low-balance build → node
  reserves cheap only, strictly < full-pool — TDD c.
- use-prompt-budget `refuses a $0 free-tier Smart Model send: insufficient_free_allowance` +
  `prices Smart Model at the shared-gate minimum required` — criterion 4 (TDD e).
- smart-model-turn `refuses ... when the wallet cannot fund even the cheapest` / `grows the
  reserve as the balance admits pricier candidates` / `does not regress a well-funded wallet`
  — money-panel: $0-block, balance-dependence, high-balance concurrency intact.

## Self-gate (command — result)
- `pnpm test:shared` — pass (102 files, 2256 tests). run-ceiling.ts / smart-model-affordability.ts
  ≥95% branch.
- `pnpm test:api` — pass (444 files/6042 tests, +1 pre-existing skip). Every changed api file
  ≥95% branch. The ONLY coverage-gate failure is `src/slices/identity/routes.integration.setup.ts`
  (88.09%) — the concurrent agent's file (named in the brief), not mine.
- `pnpm test:web` — all 363 test files pass; `use-prompt-budget.ts` = 95.34% branch. The ONLY
  coverage-gate failure is `src/hooks/models/use-resolve-default-model.ts` (87.09%) — unmodified
  (commit `92785bc4`, pre-session), imports none of my code; pre-existing.
- `turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/api --filter=@hushbox/web` —
  lint: 3/3 pass. typecheck: shared + api pass. web typecheck fails ONLY on
  `apps/api/src/middleware/pipeline-bindings.ts` `Cannot find name 'ExecutionContext'` (a Workers
  global) — reproduced with my web change reverted (shared/api present); file unmodified
  (`92785bc4`); pre-existing cross-project resolution issue, unrelated to the estimator.

## Acceptance criteria (each — evidence)
1. Server `buildSmartModelCandidates` binary gate → subset filter; `null` on empty; estimate-run
   MAXes the subset (no edit) — MET (candidates tests + estimate-run guard).
2. `$0 → null → block`; low-balance cheap-fitting → subset = fitting models — MET (candidates +
   smart-model-turn `$0` test).
3. Gate lives ONCE in `packages/shared/src/estimate/smart-model-affordability.ts`, imported by
   server (`smart-model-candidates.ts`, driven by `smart-model-turn.ts`) AND client
   (`use-prompt-budget.ts`); hoist of `estimateRunCeilingNanoUsd`+`ratesFromPricing` done — MET.
   No client-only copy, no golden cross-check test (the sweep test asserts a PROPERTY of the one
   shared pool, not agreement between two impls).
4. Client stops pricing at headline-min; calls the shared gate; $0 free-tier + Smart Model →
   `insufficient_free_allowance` — MET (use-prompt-budget tests).
5. Stale balance-INDEPENDENCE comments rewritten in `smart-model-candidates.ts` and
   `estimate-run.ts` — MET.
6. `e2e/chat/smart-model.spec.ts:252` UNCHANGED — not touched (e2e is orchestrator-run).
7. No banned sync-contract — MET.

## Deviations / notes (reasons)
- **`estimate-run.ts` touched (comment) + `estimate-run.test.ts` touched (test c)** — named in
  criteria 5 / TDD (c) but NOT in the ownership file list. Changes are comment-only + a new test;
  ZERO logic change to `estimate-run.ts`.
- **Hoist expanded beyond the two plan-named symbols**: `callManifest`, `NO_STORAGE`,
  `outputTokensOf`, the `CallUsage`/`DeclaredCeiling`/`NodeStorage` types, AND
  `classifierReserveLineItems` also moved to shared. Bounded and required: the shared gate must
  reuse the SAME reserve+floor math (One-Impl-Shared) — `estimateRunCeilingNanoUsd` pulls
  `callManifest`+types; the reserve pulls `classifierReserveLineItems` (pure over shared
  primitives). No apps/api-local helpers leaked — media pricing, settlement pricers, and the
  `Result`/`DomainError` channel stayed in apps/api behind unchanged signatures.
- **`smart-model-turn.ts` (source) and `client-billing.ts` NOT changed** (both owned): no change
  was needed. `smart-model-turn.ts` already passes balance + promptInputTokens through to the
  now-gated `buildSmartModelCandidates`; `resolveClientBilling` already denies free-tier when cost
  > allowance — the fix is entirely in feeding it the shared-gate cost.
- **Client vs server `promptInputTokens` basis**: the client passes `budgetResult.estimatedInputTokens`,
  the server passes `promptInputTokensFor(budget)`. The gate FORMULA is identical (shared); the
  stamped input may differ slightly (client preflight vs server-authoritative), inherent to
  client-vs-server estimation. The $0-block e2e case is robust to this.

## Concerns / limitations
- The `$0-rate free text model` edge (a text model with `0` per-token rates) would make
  reserve+floor = 0 on BOTH server and client (consistent, not a divergence). The seeded catalog
  has no such model today (the server currently 402s low-balance Smart Model), so the gate blocks
  as intended; if one is ever added, client and server would agree to admit — still consistent.
- I could not run `pnpm e2e e2e/chat/smart-model.spec.ts` (orchestrator-only). Criterion 6 is
  covered by unit/integration parity; the e2e must be run by the orchestrator.

## Confidence
High — every acceptance criterion has a passing test; full `test:api` (6042), `test:shared`,
`test:web` green; all self-gate failures are attributed to unmodified/concurrent files with
reproduction evidence. The One-Impl-Shared gate is genuinely single-sourced (no cross-check
test), and the money-panel invariants ($0-block, balance-dependence, high-balance concurrency
intact) each have a dedicated test.
