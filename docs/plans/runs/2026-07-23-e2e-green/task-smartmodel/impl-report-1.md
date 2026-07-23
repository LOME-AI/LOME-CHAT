# impl-report-1 — Smart Model affordability (per-candidate caps, Option A)

**STATUS: DONE_WITH_CONCERNS.** Implemented the full per-candidate `cap(m)` design
(coordinator's final Option-A ruling), authorized to expand into the workflow node schema,
builder, execution node, and estimator. Each eligible candidate carries its OWN affordable
answer cap; the classifier routes only among the eligible set; the admission reserve is the
MAX over that set and is `≤ effBalance` by construction. The cushion fix and the exact
biconditional (client == server) are in and tested.

## Design implemented
For each priceable candidate m, against the tier-EFFECTIVE (cushion-inclusive) balance and a
persisting-turn storage context:
`cap(m) = max cap in [0, remainingContext(m)]` whose cost fits `affordableBudget = effBalance
− fixedReserve`, where the per-candidate cost is priced **exactly as the admission estimator**
(subtotal markup on input+output legs + unmarked output storage). Eligible iff `cap(m) ≥
MINIMUM_OUTPUT_TOKENS`. `fixedReserve = markedup classifier provider + classifier storage +
one-off prompt input storage`. `R = MAX over eligible (fixedReserve + cost(m, cap(m)))`.
Because each `cap(m)` is sized so `cost ≤ affordableBudget`, `R ≤ effBalance`; and because the
per-candidate cost identity equals `estimateRunCeilingNanoUsd`, the admission estimator's hold
equals R — an admitted subset is never refused at admission (the free-tier storage keystone).

## Files changed (mine)
- `packages/shared/src/estimate/smart-model-affordability.ts` — replaced the floor-based
  `affordableSmartModelCandidates` / `smartModelAnswerCap` with `admitSmartModel` (per-candidate
  caps + eligible subset + reserve R) and `smartModelMinimumRequiredNanoUsd` (the
  balance-independent, storage-inclusive biconditional threshold); `SmartModelStorageContext`,
  `SmartModelCappedCandidate`, `SmartModelAdmission` types; binary-search cap sized by
  `candidateCost` (subtotal markup + storage, identical to the estimator). `priceSmartModelPool`
  kept as the internal classifier/sort/priceable-set pricer.
- `packages/shared/src/index.ts` — export the new symbols; drop the removed ones.
- `packages/shared/src/workflow.ts` — `smartModel` node candidates gain optional
  `maxOutputTokens` (server-derived, hash-safe).
- `apps/api/src/slices/workflows/builder/smart-model.ts` — `SmartModelCandidate` carries the cap.
- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` — the answer call applies the
  RESOLVED candidate's own `cap(m)` (and feeds it to `pickClassifiedEffortPlan`), not a single
  node cap.
- `apps/api/src/slices/models/domain/estimate-run.ts` — `estimateSmartModelNode` prices each
  candidate at its OWN `maxOutputTokens`; stale doc rewritten.
- `apps/api/src/slices/models/domain/smart-model-candidates.ts` — `buildSmartModelCandidates`
  calls `admitSmartModel` with the storage context and returns per-candidate caps + reserve;
  `SmartModelCandidateEntry` carries the cap; stale doc rewritten.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — the CUSHION fix
  (`smartModelEffectiveBalanceNanoUsd` → `payerSpendableNanoUsd`, was raw `remainingNanoUsd`);
  per-candidate caps flow straight to the node (no single-cap `answerMaxOutputTokens`/reconcile
  for the paid path; trial keeps the single-cap path).
- `apps/api/src/slices/chat/domain/turn-definition.ts` — `turnStorageContext(budget)` helper
  (tier output ratio + prompt chars), single-sourcing the tier mapping.
- `apps/web/src/hooks/billing/use-prompt-budget.ts` (+ its test's tier mock) — the client prices
  Smart Model through `smartModelMinimumRequiredNanoUsd` with the SAME storage context (payer
  tier via `useUserTierInfo`), so client and server agree exactly.
- Colocated tests for all of the above.

## Tests added / updated
- shared `admitSmartModel`: $0 refuse; boundary (admit at threshold, refuse one nano below);
  per-candidate caps (cheap > pricey, each ≥ MINIMUM, reserve ≤ balance); classifier-only-eligible
  exclusion (unaffordable candidate absent from the set); balance-independent reserve for a rich
  wallet (concurrency); description passthrough; the biconditional balance sweep.
- api `smart-model-turn`: the cushion helper (paid cushion / free none / no-budget fallback);
  per-candidate caps stamped on candidates with no node-level cap; the storage-inclusive reserve
  ≤ balance; free-tier: the storage-folded cap fits the 50M allowance AND (control) ignoring
  storage over-reserves past it.
- api `smart-model-candidates`: per-candidate cap returned (budget-bound when tight, full context
  when rich); boundary and subset tests updated to the cap-based eligibility.
- web `use-prompt-budget`: prices through the shared storage-inclusive threshold.

## Self-gate (coverage-free / DB-free, per instruction)
- `turbo typecheck --filter shared,api,web` — pass (3/3).
- lint — shared clean; changed api files clean; changed web files clean.
- shared `src/estimate` + `src/smart-model` + `src/workflow.test.ts` — pass (16 files, 282).
- api `smart-model-candidates` + `smart-model-turn` + `estimate-run` + `smart-model-execution`
  + `workflows/builder` + `workflows/compile` — pass (232).
- web `use-prompt-budget` — pass (47).

## Acceptance criteria
- Per-candidate caps, classifier picks only eligible — MET (schema+builder+execution+estimator
  carry/apply/price per-candidate `cap(m)`; `node.candidates` is exactly the eligible set).
- Reserve ≤ balance, no under-reserve — MET by construction and by the exact estimator-identity
  (verified: free-tier fits allowance; rich-wallet reserve balance-independent).
- Biconditional across tiers — MET: both sides use `smartModelMinimumRequiredNanoUsd` with the
  same tier-effective balance (`spendableFundsNanoUsd`, incl. the $0.50 paid cushion — the fixed
  raw-remainder bug) and the same storage context; the shared balance sweep pins it.
- High-balance concurrency not regressed — MET (unbound candidates reach full context; R is the
  full-context MAX, balance-independent).
- Effort inside cap, no cost leg — MET (`pickClassifiedEffortPlan` fed `cap(m)` at runtime).

## Deviations / concerns (RAISED)
1. **Trial path left on the single-cap `answerMaxOutputTokens` + reconcile** (per the
   coordinator's standing "leave trial untouched"): trial candidates carry no per-candidate cap,
   so `compileSmartModelBuild` detects that and keeps the old single-cap guess+reconcile for
   trial only. `answerMaxOutputTokens` is thus retained (trial-only) — not banned duplication
   (independent quota authority).
2. **Storage context must match on both sides for an EXACT biconditional.** Server tier =
   `tierForFunding(payer funding)`; client tier = `useUserTierInfo`. These map identically
   (purchased/paid → 2 chars/token; else → 4) and prompt-char bases match, so the thresholds are
   equal. If the client's tier ever diverges from the server's payer tier for a send, the
   threshold would differ by the storage delta — flagging for the panel.
3. **`priceSmartModelPool.minimumRequiredNanoUsd` is now internal-only** (no external consumer);
   kept because `priceSmartModelPool` is reused internally. `knip` (not in my self-gate) may flag
   the export — leaving as-is per minimal-churn.
4. **`estimate-run.ts` / `use-prompt-budget.ts` also show pre-existing uncommitted changes** from
   before this session — those are NOT mine beyond the edits described here.
5. Integration/e2e (`smart-model.spec.ts`, admission integration) are the orchestrator's to run
   (DB/shared-catalog); I ran only DB-free units.

## Confidence
Medium-high. The money core is exact (per-candidate cost identity == estimator; reserve ≤
balance and no-under-reserve proven and test-pinned; free-tier storage keystone verified;
biconditional swept). Breadth is large (schema + engine + estimator + shared + client) — the
2-auditor panel should re-verify the estimator-identity claim and the client/server tier-storage
equivalence in particular.
