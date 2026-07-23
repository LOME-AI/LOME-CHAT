# Unknowns log

## Open — research/analysis in flight
- U1: Fee-baking design (catalog stores after-fee rates; single billable seam; raw
  provider cost retention for reconcile; sanity-check re-basing) → analyst A
- U2: Pinned-model auto as classifier-driven smart node; auto-disable rule mechanics
  → analyst B
- U3: Input-divergence elimination (server-supplied spendable/budget numbers;
  realtime invalidation replacing staleTime:Infinity) → analyst C
- U4: Does OpenRouter publish max output tokens we can ingest (text/image/video)?
  → explorer D (code/fixtures) + researcher E (web docs)
- U5: Does the monthly OpenRouter reconcile auditor exist in code, or only in
  ARCHITECTURE.md? (Principle 9's raw-cost retention rationale depends on it)
  → explorer H
- U6: How does group billing actually work end-to-end (guest on owner's balance,
  tier inheritance, sender-vs-payer recording, member/conversation budgets,
  admission scopes, settlement attribution)? → explorer F
- U7: How does multi-model turn math work (estimate, admission, settlement,
  group-budget interaction, client preview)? → explorer G

## For the human (single AskUserQuestion round after research lands)
- H1: Raw-provider-cost storage is a DB schema change (needs approval per AGENT-RULES)
- H2: "Auto enabled iff 2+ effort options" — offered options or enabled(affordable)?
- H3: Model-picker greying UX for unaffordable-minimum models (grey + tooltip?)
- H5: Run scope — all 8 remediation items in this run, or split (fee baking and
  auto-smart-node are each sizable)? Scope GREW 2026-07-23: group billing folded in.

## Resolved
- H4 (2026-07-23, human): one combined doc, merged into docs/BILLING.md — the
  affordability principles + new group-billing principles live there.
- U5 (2026-07-23, explorer H): the monthly OpenRouter reconcile auditor does NOT
  exist — documentation-only, explicitly deferred in apps/api/src/scheduled.ts:46-49.
  HUMAN RULING: remove the monthly reconcile from the docs completely — delete the
  ARCHITECTURE.md §Money & settlement line claiming it, and the deferred-reconcile
  mention in the scheduled.ts docstring. Plan task added (doc/comment deletion only).
  IMPLICATION for principle 9 (to confirm in the question round): with the reconcile
  gone, no stated consumer of raw provider cost remains — the "retain raw cost for
  reconcile" clause presumably drops and only billable prices exist anywhere.

## Ruled task additions (human, 2026-07-23)
- T-add-1: Delete the monthly reconcile from docs entirely (ARCHITECTURE.md §Money &
  settlement line + scheduled.ts docstring mention). Doc/comment deletion only.
- T-add-2: Frontend money-domain cleanup — client tier/affordability plumbing uses
  cents/floats instead of nano-USD bigints (e.g. useUserTierInfo returns
  balanceCents/freeAllowanceCents; resolveSelfAffordability compares cents with a
  1e-6 float tolerance; usePromptBudget carries estimatedCostCents). Correct to
  nano-USD end-to-end, cents/dollars only at display formatting. Dovetails with the
  input-divergence design (analyst C), whose deletion list already reworks
  resolveSelfAffordability/client-billing.ts — fold into that task set.
