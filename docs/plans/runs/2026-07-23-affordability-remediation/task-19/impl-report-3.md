# Task 19 — fix cycle 2 (A9 residual): impl report 3

## Objective

Wire the shared `payerSizingTier` into the main preview solve
(`apps/web/src/hooks/billing/use-budget-calculation.ts`) so owner-funded
turns size at the payer's tier, closing the criterion-1 residual recorded
in Amendment A9.

## Outcome: NEEDS_CONTEXT — bounds STOP condition triggered, no edits made

The brief's bounds state: "if use-prompt-budget.ts is the only viable
threading path, STOP and report for sequencing." It is. Verified this
session:

1. **Sole consumer.** `use-budget-calculation` is imported from exactly one
   non-test file: `apps/web/src/hooks/billing/use-prompt-budget.ts:31`
   (repo-wide grep over `apps/web/src` and `packages`, tests excluded).
   There is no other direct consumer through which anything can be
   threaded.
2. **The group context lives only inside the T12-owned file.** Everything
   the sizing-tier input needs is defined and computed inside
   `use-prompt-budget.ts` itself: the `GroupBillingContext` interface
   (line 138), `useGroupBillingContext` (line 172, fed by
   `useConversationBudgets` at line 451), and the existing
   `resolveSizingTier` → `payerSizingTier` composition (lines 151/508).
   No provider, store, or sibling hook exposes the group figures — the
   `conversationId`/privilege inputs enter the tree at `usePromptBudget`.
3. **Every viable design edits use-prompt-budget.ts.** Whether the new
   `useBudgetCalculation` input is `sizingTier: UserTier` (pass the
   already-computed `resolveSizingTier` result) or
   `group?: GroupBillingContext` (derive via `payerSizingTier` internally —
   `useUserTierInfo` already supplies `purchasedBalanceNanoUsd`), the call
   site at `use-prompt-budget.ts:476` must change, and in both designs the
   group-context hooks must move above that call (they currently run after
   it, lines 484/451 vs 476 — a hook-order reshuffle, not a one-liner).
   Deriving the context inside `use-budget-calculation.ts` without a caller
   edit would require new plumbing for `conversationId`/privilege, which
   the bounds ban ("no new context plumbing").
4. **T12 owns that file** (bounds + A11): editing it here risks exactly the
   collision the bounds warn about.

Per hard rules, an out-of-scope-need is reported for sequencing, never
made.

## Recommended sequencing (for the orchestrator)

Once T12's ownership of `use-prompt-budget.ts` releases, the fix is small
and two-sided:

- `use-budget-calculation.ts`: accept the sizing tier (or the group
  context) as an input; use it in `buildRequest` (`estimateTokensForTier`,
  `outputCharsPerTokenForTier`) while `effectiveBalanceFor` keeps gating on
  the caller's own served funds — the tier input affects sizing only, not
  whose balance is compared (the payer's headroom is `useResolveBilling`'s
  job). Pin: free-tier member + owner-funded group context produces sizing
  inputs identical to `tier: 'paid'` (mirror
  `use-prompt-budget.test.ts:1203-1249`).
- `use-prompt-budget.ts`: hoist `useConversationBudgets` +
  `useGroupBillingContext` + `resolveSizingTier` above the
  `useBudgetCalculation` call and pass the result. Preferably pass the
  already-derived `sizingTier` value so `payerSizingTier` keeps a single
  call site in the web layer (cleanest read of "no third layer").

## Files changed

None (report file only).

## Tests added

None — TDD's first pin would itself have forced the barred edit (the pin
exercises the new input, whose only real producer is the T12-owned file).

## Self-gate

Not applicable — no source edits; no checks run beyond read-only greps.

## Acceptance criteria

All three: **not met — blocked on sequencing** (see Outcome). Interim
behavior remains the A9-documented safe divergence: owner-funded previews
size at the caller's tier, which over-reserves only.

## Deviations

None (stopping IS the instructed behavior for this situation).

## Concerns and limitations

- The reshuffle moves `useConversationBudgets` (a query hook) above the
  budget calculation; loading-state handling (`isGroupBudgetPending`)
  already exists downstream and should be re-checked when the fix lands so
  a pending group context doesn't flash a free-tier-sized preview for
  members.

## Confidence

High — the sole-consumer and context-locality facts are Verified by grep
and file reads this session; the STOP condition is unambiguous.
