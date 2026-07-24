# Task 09 — impl-report-2 (fix round)

## Objective

Fix the two validated audit findings on Task 09: (1) the ws-ready catch-up test did not pin the three money-key invalidations; (2) `nanoUsdToCents` doc comment described a dead cents-domain world.

## Files changed

- `apps/web/src/hooks/realtime/use-realtime-sync.test.ts` — extended the existing `runs the catch-up refetch when the socket is ready with a conversation` test with three assertions: `billingKeys.spendable()`, `budgetKeys.conversation(CONV_ID)`, `billingKeys.balance()`. No new test; the acceptance criterion is a strict extension of the existing catch-up pin.
- `packages/shared/src/nano-usd.ts` — comment-only: reworded the `nanoUsdToCents` doc to its surviving role (display and test-assertion conversion; all billing math is exact nano bigint). Removed the false references to `resolveClientBilling` cent arithmetic and the deleted `effectiveBudgetCents`.
- `apps/web/src/hooks/realtime/use-realtime-sync.ts` — net-zero: temporarily removed the `billingKeys.spendable()` catch-up invalidation for the discrimination check, then restored it verbatim. Final content identical to pre-fix state (verified: the surviving diff vs HEAD is Task 09's original uncommitted work).

## Tests added

- Three assertions appended to `runs the catch-up refetch when the socket is ready with a conversation` — behavior: ws-ready catch-up invalidates spendable, conversation budgets, and balance — covers the criterion "ws-ready catch-up includes them (tests)".

## Discrimination check (red→green)

Per the TDD note: with the assertions in place, I deliberately removed the `billingKeys.spendable()` invalidation from the catch-up effect in `use-realtime-sync.ts` and ran the file — 1 failed / 17 passed, failing at exactly the new `billingKeys.spendable()` assertion (line 160, "Number of calls: 4"). Restored the line; re-run: 18/18 passed. The pin provably catches a regression dropping a money key from catch-up.

## Self-gate

- `pnpm test:watch apps/web/src/hooks/realtime/use-realtime-sync.test.ts --run` — pass (18/18)
- `pnpm test:watch packages/shared/src/nano-usd.test.ts --run` — pass (55/55; comment-only change, behavior unchanged)
- `npx eslint src/hooks/realtime/use-realtime-sync.test.ts` from `apps/web` — exit 0
- `npx eslint src/nano-usd.ts` from `packages/shared` — exit 0
- `tsc --noEmit` in `packages/shared` — clean

## Acceptance criteria (the two findings)

1. Catch-up money-key pin — **met**: three assertions added, discrimination proven red→green above.
2. `nanoUsdToCents` comment — **met**: now reads "Display and test-assertion conversion only — all billing math is exact nano-USD bigint"; no reference to `resolveClientBilling` cent math or `effectiveBudgetCents`.

## Why impl-report-1 claimed a test that did not exist

Inferred (I am a fresh fixer context; I cannot observe the prior implementer's session). impl-report-1 listed `ws-ready catch-up also refetches spendable, budgets, balance` as a distinct test name alongside the separately-listed run-started/run-finished tests — so it was not a mis-label of the run-frame tests. The catch-up test in the file asserted only chat + member keys, i.e. the pre-existing pin untouched. Most plausible reading: the implementer wrote the implementation's catch-up invalidations, intended the matching test extension, and reported it as done while the edit was never made (a dropped edit), the report enumerating intended rather than actual coverage.

## Deviations

None. No source files outside the two owned files changed (the impl file's temporary break was fully restored).

## Concerns and limitations

None. The change is additive assertions plus a comment; no behavior changed.

## Confidence

High — both fixes are exactly the finding text, the new pin was watched fail for the diagnosed regression class, and all scoped checks are green.
