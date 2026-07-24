# Task 06 — impl report 1

## Objective

Every output-ceiling / reasoning-budget / answer-cap computation bounds by
`descriptor.limits.maxOutputTokens` when present; absent key ⇒ contextLength
fallback (strict tightening, never loosening).

## Files changed

- `packages/shared/src/estimate/reasoning-plan.ts` — `ReasoningPlanModel` gains
  `maxOutputTokens?`; `reasoningPlanModelFrom` maps `limits['maxOutputTokens']`;
  `clampBudget` now clamps B by the tighter of context length and provider cap
  (floor-wins semantics preserved; invalid caps ignored, symmetric with the
  existing contextLength validation).
- `packages/shared/src/estimate/smart-model-affordability.ts` —
  `SmartModelPoolCandidate` gains `maxOutputTokens?`; `candidateBasis.remaining`
  = min(context headroom, cap), bounding `candidateCapTokens` and eligibility;
  `floorNanoUsd`'s output leg bounded by the cap (worst-case floor shrinks).
- `packages/shared/src/budget.ts` — `computeSafeMaxTokens` gains optional
  `modelMaxOutputTokens`; output ceiling = min(remaining context, cap); a budget
  at/past the ceiling still omits the param (provider enforces its own cap;
  admission bounds the hold by the same catalog cap).
- `packages/shared/src/schemas/api/models.ts` — wire `modelSchema` gains
  optional `maxOutputTokens: int positive` (DEVIATION, see below).
- `apps/api/src/slices/models/domain/estimate-run.ts` — `declaredOutputCeiling`
  takes the catalog cap: hard cap = min(contextLength, limits.maxOutputTokens);
  a declared param is bounded by the hard cap; no param ⇒ hard cap.
  `inputTokenCeiling` deliberately unchanged (input leg — the completion cap
  does not bound input; bounding it would under-reserve the hold).
- `apps/api/src/slices/models/domain/list-models.ts` — language wire rows carry
  `maxOutputTokens` when the descriptor limits carry it; media rows and the
  synthetic Smart Model row never carry it (per-candidate caps rule Smart).
- `apps/api/src/slices/chat/domain/turn-definition.ts` (bound lines only) —
  `TurnModelPricing` gains `maxOutputTokens?`; `turnModelPricings` reads it from
  limits; `summedTurnPricing` computes the tightest sibling cap;
  `turnMaxOutputTokens` passes it to `computeSafeMaxTokens`;
  `answerHeadroomTokens` bounds B+H JOINTLY: total output ceiling =
  min(budget, context headroom, tightest cap), H = ceiling − B.

## Tests added (name — behavior — criterion)

- reasoning-plan.test.ts, describe "provider completion cap …": 9 tests —
  budget-native and effort-wire B clamped to the cap; min(context, cap);
  cap-alone clamp; `reasoningPlanModelFrom` mapping; absent-key fallback;
  invalid-cap ignore; sub-floor floor-wins pin; 500-case seeded property (every
  offered wire, planned B, and re-derived B ≤ cap for caps ≥ 1024) →
  criterion "clampBudget bounds by limits.maxOutputTokens".
- smart-model-affordability.test.ts, describe "provider completion cap …":
  8 tests — rich-payer cap(m) ≤ maxOutputTokens; context-tighter case;
  **reservation-shrink** (capped candidate's `reserveNanoUsd` < identical
  uncapped); absent-key fallback; below-minimum cap excluded from eligibility
  and from `smartModelMinimumRequiredNanoUsd`; worst-case floor bounded;
  balance sweep property (cap never exceeded at any balance) → criterion
  "candidateCapTokens bounds".
- budget.test.ts, describe "provider completion cap (modelMaxOutputTokens)":
  4 tests — budget below cap passes through; budget ≥ cap omits; sweep never
  returns > cap; context-tighter unchanged → criterion "computeSafeMaxTokens
  bounds".
- estimate-run.test.ts: 4 tests — catalog cap bounds output leg with no
  declared param (**reservation-shrink example**: 5_500_000n < 12_500_000n
  full-context hold); declared param above cap bounded at cap; declared below
  cap wins (tightest); cap above context bounded at context → criterion
  "declaredOutputCeiling bounds".
- list-models.test.ts: 3 tests — language wire row serves the field; absent
  when uncapped; absent on the synthetic Smart Model row → criterion
  "list-models wire".
- turn-definition.test.ts: 3 `turnMaxOutputTokens` tests (cap-bounded omit,
  looser cap keeps budget ceiling, tightest sibling cap on multi-model),
  2 `turnModelPricings` tests (carries/omits the limit), 4
  `answerHeadroomTokens` tests (B+H ≤ cap jointly; looser cap keeps budget
  bound; cap = B refuses; tightest sibling cap) → criteria
  "answerHeadroomTokens/computeSafeMaxTokens callers bound".

All tests watched red first (wrong-value failures, e.g. 12_500_000n vs
5_500_000n; 65_536 vs 8192), then green with minimal code.

## Self-gate

- `pnpm test:shared` — PASS (2290/2290; coverage gate green;
  `smart-model-affordability.ts` branch coverage now 100% — the A1-noted
  86.02% shortfall this lane was to absorb is closed; reasoning-plan.ts 98.18%
  branch, above the 95 gate).
- `pnpm test:api` — 6106 passed / 7 failed, ALL 7 in
  `notifications/domain/templates/template-html.test.ts` snapshots — the
  A1-documented pre-existing snapshot flake; I touched no notifications code.
  The other A1 pre-existing pair (2 chat routes smart-model cases) did NOT
  fail on this run. No other failures.
- Repo-wide `pnpm typecheck` (A3) — 13/15 packages pass incl. shared+api;
  @hushbox/web FAILS on `use-resolve-billing.ts` / `use-prompt-budget*`
  cents→nano symbols — those files are T09's declared concurrent ownership and
  are mid-edit in the working tree (verified via git status); not attributable
  to this task (my web-visible change is one additive optional schema field).
- eslint owned files, run from package dirs AFTER the final edit — exit 0 for
  both packages (shared: reasoning-plan(.test), smart-model-affordability(.test),
  budget(.test), schemas/api/models.ts; api: estimate-run(.test),
  list-models(.test), turn-definition(.test)). Full `apps/api` package lint
  exit 0. Full `packages/shared` package lint fails only on
  `src/billing/client-billing*` (7 prettier errors) — T09's in-flight files.
- Vite caches (`node_modules/.vite` at root/api/web/shared) cleared before the
  api/web-affecting runs per A6.

## Acceptance criteria

1. **Each named consumer bounds by limits.maxOutputTokens; property pinned per
   consumer** — MET for: `declaredOutputCeiling` (estimate-run), `clampBudget`
   (reasoning-plan), `answerHeadroomTokens` + `computeSafeMaxTokens` callers
   (turn-definition/budget.ts), `candidateCapTokens`
   (smart-model-affordability), list-models wire. Evidence: tests above.
   `inputTokenCeiling` reviewed and deliberately NOT bounded (input leg;
   bounding would under-reserve — loosening, the NEEDS_CONTEXT trigger's
   direction). PARTIAL at integration level: the server's smart-model pool
   producer `toPoolCandidate` (smart-model-candidates.ts) is outside my Files
   list and does not yet copy `limits.maxOutputTokens` into the candidate —
   one-line spread needed (out-of-scope need, raised).
2. **Reservation shrinks for a capped model** — MET; pinned twice
   (estimate-run 5_500_000n < 12_500_000n; admitSmartModel reserve strictly
   smaller).
3. **Client sizing inherits the bound purely via shared fns, zero client-local
   bound math** — MET for the shared surface: grep shows no
   `limits['maxOutputTokens']` / provider-cap min-math anywhere in `apps/web`;
   the wire field + shared fn params are the only carriers. Grep found exactly
   two PRE-EXISTING client-local `Math.min(input.maxOutputTokens,
   contextHeadroom)` lines in
   `apps/web/src/components/chat/input/reasoning-effort-menu.tsx:70,93` — a
   budget/context headroom mirror that predates this task (its
   `maxOutputTokens` input is the affordability output, not the provider cap).
   Its `planReasoning` probes inherit the B-clamp at runtime through the wire
   rows, but its H mirror lacks the cap term; the T11/T12 lane replaces this
   component's math with shared `turnEffortOptions` — raised as a coordination
   fact, not fixed here (out of bounds).

## Deviations

- **Edited `packages/shared/src/schemas/api/models.ts` (not in the Files
  list):** the "list-models wire" consumer is unimplementable without it —
  `modelSchema.safeParse` strips unknown keys, so serving the field from
  list-models.ts alone would be silently dropped. Minimal additive optional
  field; every existing producer remains valid. A3 sweep run: modelSchema
  consumers are list-models(.test), routes.integration.test, schema's own
  test — no hand-built producer breaks (optional field). Note the brief's A3
  note said "changes no shared contract shape (limits is an open record)" —
  true for `limits`, but the wire field IS a (backward-compatible) contract
  addition; repo-wide typecheck run as required.
- **B+H reading (named per brief):** BILLING §Affordability 5 "wire cap =
  reasoning budget + answer headroom, output ceiling bounds together" read as
  JOINT bounding — implemented as total output ceiling = min(budget, context
  headroom, cap) with H = ceiling − B, so B + H ≤ cap whenever a plan is
  feasible. Additionally B alone is clamped by the cap in `clampBudget`
  (mirroring the existing contextLength clamp).
- **Floor-vs-cap edge:** for a (pathological) cap < 1024 the protocol floor
  still wins in `clampBudget` (B = 1024 > cap), exactly as it already did for
  tiny contextLength — upstream raises sub-floor budgets regardless, and the
  joint bound in `answerHeadroomTokens` refuses such levels (H < 1). Pinned by
  test; the per-consumer ≤-cap property is asserted for caps ≥ the floor.

## Concerns and limitations

- Out-of-scope needs (one-liners, files outside my list):
  1. `apps/api/src/slices/models/domain/smart-model-candidates.ts`
     `toPoolCandidate` must spread `limits['maxOutputTokens']` into the pool
     candidate for the server Smart Model path to carry the bound end-to-end.
  2. `apps/api/src/slices/chat/domain/smart-model-turn.ts`
     `answerMaxOutputTokens` builds a hand-rolled worst-case
     `TurnModelPricing` without `maxOutputTokens` (and its fallback computes a
     raw context remainder); T13/T14 rework this path — whoever lands first
     should thread the tightest candidate cap.
  3. Client producers (`smartModelPoolFromCatalog` in use-prompt-budget.ts —
     T09's file) must copy the new wire `maxOutputTokens` into
     `SmartModelPoolCandidate`s for client Smart Model preview parity.
- The synthetic Smart Model wire row deliberately carries no
  `maxOutputTokens` (candidates differ; per-candidate caps are authoritative).
- `packages/shared/dist/` is stale build output (exports point at src); not
  regenerated.

## Confidence

high — every consumer change is pinned by a red-first test including two
property sweeps; both scoped suites green outside documented pre-existing /
concurrent-task failures; the only unbounded residues are enumerated above
with exact locations.
