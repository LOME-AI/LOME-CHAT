# Task 09 — Client served-numbers + nano money cleanup — implementation report 1

Status: COMPLETE (all acceptance criteria met; one interpretation raised, one
non-reproducing coverage flake attributed).

## Objective

The client consumes served spendable/budgets numbers; client money math becomes
nano-USD `bigint` end-to-end (cents only at display formatting). Deletions per
analyst C's double-cushion hazard; keeps per plan (fixed-1¢ trial arm, raw-balance
negative hard block, per-keystroke shared estimator). Freshness: run-started +
run-finished + ws-ready invalidations; budgets `staleTime: Infinity` removed.

## What was built

1. **`useSpendable`** (`apps/web/src/hooks/billing/use-spendable.ts`, new):
   `GET /billing/spendable` (T07's ruled two-field shape `{spendableNanoUsd,
   heldNanoUsd}`) under `billingKeys.spendable()` (added to the `billingKeys`
   factory in `billing.ts`, nested under `['billing']`). Enabled only when
   authenticated — trial/guest have no endpoint. Typed hono client covers the
   route already (`client.billing.spendable.$get()`); no extra api-client wiring
   was needed beyond the call.

2. **Shared money domain → nano bigint**:
   - `packages/shared/src/tiers.ts`: `UserBalanceState`/`UserTierInfo` cents
     fields replaced by `purchasedBalanceNanoUsd`/`freeAllowanceNanoUsd`
     (bigint); tier = `purchasedBalanceNanoUsd > 0n` (a single positive nano is
     paid — no cents truncation).
   - `packages/shared/src/billing/client-billing.ts`: `ClientBillingInput` is
     now `{tier, purchasedBalanceNanoUsd, spendableNanoUsd, freeAllowanceNanoUsd,
     isPremiumModel, estimatedMinimumCostNanoUsd, group?: {effectiveRemainingNanoUsd,
     ownerBalanceNanoUsd}}`. Deleted: `resolveSelfAffordability` (cents),
     `FREE_TIER_FLOAT_TOLERANCE_CENTS` (the 1e-6 float tolerance),
     `centsToSignedNano`. New `resolveSelfFunding` compares exact bigints:
     paid gates on the SERVED spendable with no cushion re-add (the served
     number bakes it once); free gates on the served allowance exactly; trial
     keeps the fixed-1¢ cap (`MAX_TRIAL_MESSAGE_COST_CENTS × NANO_USD_PER_CENT`).
     The negative-balance hard block reads the RAW `purchasedBalanceNanoUsd`
     (owner's for group turns) — kept as a complementary defense, not collapsed
     into the spendable compare. `deriveClientFundingInputs` now passes raw
     bigints straight into the shared core (no ×1e7 sign-preserving scaling).

3. **Hooks re-plumbed** (`apps/web/src/hooks/billing/`):
   - `use-user-tier-info.ts` / `use-tier-info.ts`: build the nano
     `UserBalanceState` via `BigInt(wire string)`; no `nanoUsdToCents`.
   - `use-budget-calculation.ts`: effective balance for the affordability solve
     is now `effectiveBalanceFor(funds)` — trial/guest → shared
     `getEffectiveBalanceNano(tier, 0n, 0n)` (client fixed arm, kept); free →
     served allowance; paid → served spendable (never re-derived, never
     re-cushioned). `useBalance` dropped from this hook; `isBalanceLoading` now
     also covers a pending spendable query (blocks instead of flashing a
     spurious denial). `estimatedMinimumCost` (dollars float) →
     `estimatedMinimumCostNanoUsd` (bigint).
   - `use-resolve-billing.ts`: input is nano (`estimatedMinimumCostNanoUsd`,
     nano group fields); internally feeds tier + raw balance + served spendable
     + served allowance into `resolveClientBilling`. Unloaded spendable = `0n`
     (denies; loading gate handles UX).
   - `use-media-cost-estimate.ts`: result `{estimatedNanoUsd: bigint,
     estimatedDollars}` — the cents intermediary is gone; dollars only at
     display (`modality-config-panel.tsx` consumes `estimatedDollars`,
     unchanged).
   - `use-prompt-budget.ts`: `estimatedCostCents` naming and value deleted →
     `estimatedCostNanoUsd: bigint` end-to-end (`resolveEstimatedCostNanoUsd`,
     `smartModelMinimumNanoUsd`, nano `GroupBillingContext`, bigint
     delegated-budget check). No production component consumed the old field
     (verified by grep); only test mocks re-pinned.
   - `use-conversation-budgets.ts`: `staleTime: Infinity` removed (comment
     records why: the served remaining is hold-aware, an Infinity pin would
     freeze remounted views); doc comment updated to T08's hold-aware +
     raw-owner-balance semantics (A5).

4. **WS freshness** (`apps/web/src/hooks/realtime/use-realtime-sync.ts`): the
   run-frame handler now fires on BOTH `run-started` and `run-finished`,
   invalidating `billingKeys.spendable()` + `budgetKeys.conversation(id)` +
   `billingKeys.balance()` (run-finished additionally invalidates messages);
   the ws-ready catch-up effect adds the same three money keys. The WS
   invalidation surface lives exactly where the plan implied
   (`use-realtime-sync.ts`) — no NEEDS_CONTEXT trigger fired.

## Files changed

- `packages/shared/src/tiers.ts` — nano `UserTierInfo`/`UserBalanceState`, bigint tier compare
- `packages/shared/src/tiers.test.ts` — re-pinned nano; new 1-nano-is-paid exactness pin
- `packages/shared/src/billing/client-billing.ts` — nano contract; deletions above
- `packages/shared/src/billing/client-billing.test.ts` — rewritten nano; no-double-cushion, exact-free-compare, raw-vs-spendable pins
- `packages/shared/src/billing/client-billing.consistency.test.ts` — nano fixtures (mechanical)
- `packages/shared/src/billing/funding-decision.contract.test.ts` — client leg now feeds IDENTICAL bigints as the server leg (stronger contract)
- `apps/web/src/hooks/billing/billing.ts` — `billingKeys.spendable()`
- `apps/web/src/hooks/billing/use-spendable.ts` (+ `.test.ts`) — new hook
- `apps/web/src/hooks/billing/use-user-tier-info.ts` / `use-tier-info.ts` (+ tests) — nano tier state
- `apps/web/src/hooks/billing/use-budget-calculation.ts` (+ test) — served-numbers effective balance, nano min cost
- `apps/web/src/hooks/billing/use-resolve-billing.ts` (+ test) — nano input, spendable consumer
- `apps/web/src/hooks/billing/use-media-cost-estimate.ts` (+ test) — nano estimate
- `apps/web/src/hooks/billing/use-prompt-budget.ts` (+ test) — `estimatedCostNanoUsd`, nano group context
- `apps/web/src/hooks/billing/use-conversation-budgets.ts` (+ test) — staleTime removal, doc fix
- `apps/web/src/hooks/realtime/use-realtime-sync.ts` (+ test) — run-started/run-finished/ws-ready money invalidations
- `apps/web/src/test-utils/balance-fixture.ts` — stale comment fix (`freeAllowanceCents` → `freeAllowanceNanoUsd`)
- `apps/web/src/routes/_app/chat.index.test.tsx`, `components/chat/page/chat-welcome.test.tsx`, `components/chat/input/prompt-input.test.tsx` — mock field rename only

NOT mine (pre-existing dirt from sibling tasks, untouched): everything else in
`git status`, incl. `apps/web/src/hooks/chat/use-authenticated-chat.ts` (T10/T22
lane) and all `apps/api`/`packages/shared/src/estimate` edits (T06/T07/T08 lanes).
HARD BARS respected: `packages/shared/src/budget.ts` and
`packages/shared/src/estimate/*` untouched; `use-prompt-budget.ts` edited only
for the money-domain work the plan names.

## Tests added / re-pinned → criteria

- **No-double-cushion (paid preview)**:
  - shared: `paid tier never re-adds the cushion on top of the served spendable`
    (spendable 10¢, estimate 30¢ → denied; a re-add would pass) and
    `spendable exactly equal to the estimate → personal_balance`.
  - web: `funds exactly the served spendable — the baked cushion is never
    re-added` (maxOutputTokens === shared `affordability` at EXACTLY the served
    figure, and strictly more at served+cushion), plus `gates paid affordability
    on the served spendable, not the raw balance` (raw $10, served 0 → 0 tokens).
- **Exact bigint, no float tolerance**: `free tier compares exact bigint —
  allowance one nano short denies` + equality-boundary twin; tiers: 1-nano paid.
- **Raw-vs-served separation (complementary defenses kept)**: `overdrawn wallet
  denies even when the served spendable is positive` (shared + web resolver
  twin); `feeds the RAW purchased balance to the core` (derive pin).
- **Trial/guest fixed arm kept client-side**: shared trial cap pins; web
  `keeps the client-side fixed arm for unauthenticated users` (exact equality
  with `getEffectiveBalanceNano('trial', 0n, 0n)` solve); `useSpendable`
  disabled-when-unauthenticated pin.
- **WS freshness**: `run-started invalidates spendable, budgets, and balance
  (hold just landed) but not messages`; `run-finished invalidates messages,
  budgets, spendable, and balance`; `ws-ready catch-up also refetches
  spendable, budgets, and balance`; `stream frames do not invalidate`.
- **staleTime**: `does not pin staleTime — WS invalidations must refetch`.
- **Denial parity cases**: full re-pinned matrix green — client-billing.test
  (25), consistency suite (25), funding-decision contract (19, now bit-identical
  inputs on both legs), use-resolve-billing (11 incl. unloaded-spendable branch).

TDD: every batch was written first and watched fail for the right reason
(client-billing 14 red on the old cents reads; tiers 6 red; use-spendable
module-missing red; budget-calculation 10 red incl. served-gating; media 14 red;
resolve-billing 5 red; realtime-sync 2 red; conversation-budgets 1 red). One new
test's initial expectation was corrected (trial fixed arm yields 0 tokens below
the 1000-token minimum at the fixture's rates — replaced a `>0` guess with the
exact shared-solve equality, strictly stronger).

## Self-gate (Verified, this session)

- `pnpm test:shared` (turbo `--force`, cache distrusted): 102 files, **2290
  passed**, coverage gate green; `tiers.ts` and `client-billing.ts` at
  100/100/100.
- `pnpm test:web` (turbo `--force`): 365 files, **6020 passed**, exit 0 with
  the per-file coverage gate. First forced run flagged two branch shortfalls:
  `use-resolve-billing.ts` 75% (mine — fixed by the unloaded-spendable test)
  and `src/components/chat/message/markdown-renderer.tsx` 78.57% (**not mine**:
  file untouched, git-clean, last changed at commit 64d4376f; did NOT reproduce
  on the next full forced run — attribute as a coverage-collection flake, not a
  standing failure). Final combined `--force` run of BOTH suites executed after
  the last edit: shared 102 files / 2290 passed, web 365 files / 6020 passed,
  coverage gates green, exit 0.
- Repo-wide `pnpm typecheck` (A3, shared contract changed): 15/15 tasks green.
- A3 consumer sweep for the changed contracts (`UserTierInfo`,
  `UserBalanceState`, `getUserTier`, `canUseModel`, `ClientBillingInput`):
  repo-wide grep shows consumers only in `apps/web/src/hooks/billing/*` and
  `packages/shared/src/{tiers,billing}/*` — all updated here; no `scripts/`,
  `e2e/`, `apps/api`, or `apps/marketing` consumer exists.
- Deleted-symbol sweep (grep, repo-wide incl. tests, excluding `dist/`):
  `balanceCents` → 0 hits; `estimatedCostCents` → 0 hits;
  `resolveSelfAffordability` → 0 hits; `FREE_TIER_FLOAT_TOLERANCE`/`1e-6` → 0
  live hits (one comment in a test documenting the guard);
  `getEffectiveBalanceNano` in web → only the trial/guest arm inside
  `effectiveBalanceFor` (no authenticated call); `concurrentRunsRemaining` → 0
  hits (A5 two-field shape consumed).
- Lint: `eslint <owned files>` run from `packages/shared` and `apps/web`
  package dirs AFTER the final edit — **exit 0 both** (two fix rounds were
  needed: prettier wraps + unnecessary-type-arg/BigInt-noop autofixes; affected
  suites re-run green after). Package-level `turbo lint --force` for both:
  green.
- A6 honored: `node_modules/.vite` cleared at root/api/web before the first web
  test run against the fresh shared edits.

## Acceptance criteria

- `useSpendable` only affordability balance input for authenticated users;
  `useBalance` for payment polling/settings — **MET with one interpretation
  raised** (see Concerns 1): the affordability *solve/compare* inputs are
  exclusively served numbers (spendable for paid, allowance for free); the raw
  balance is still read (via `useBalance` inside the tier hooks) for tier
  derivation and the plan-kept negative-balance hard block, because no other
  endpoint serves those and the plan explicitly keeps the raw-balance block.
- No cents/float money math in hooks/shared client-billing — **MET** (grep
  evidence above; the only remaining cents touchpoints are display/input
  boundaries: `estimatedDollars` for the media config panel, and
  `centsToNanoUsd(variables.budgetCents)` serializing the budget-edit FORM
  input to the wire in `use-conversation-budgets.ts` mutations — input-boundary
  serialization, not money math; left as-is).
- No-double-cushion pin — **MET** (tests above, both layers).
- WS run-started + run-finished invalidate spendable + budgets (+ balance);
  ws-ready catch-up includes them — **MET** (tests above).
- Affected hook/component tests re-pinned; denial parity green — **MET**.

## Deviations, with reasons

1. **`packages/shared/src/tiers.ts` (+ its test) edited — outside the brief's
   named file list.** The plan orders "useUserTierInfo cents fields" deleted
   and `balanceCents` grep-clean repo-wide; `UserTierInfo.balanceCents` is
   DEFINED in `tiers.ts`. A web-local replacement type would have forked the
   "single source of truth for tier determination" (`getUserTier`) — a banned
   second implementation. Consumers verified web+shared only.
2. **`use-tier-info.ts` edited** (not in the plan's file list, but in the
   `apps/web/src/hooks/billing/*` bound): it constructs the changed shared
   `UserBalanceState` — would not compile otherwise.
3. **Three component test files + `balance-fixture.ts` touched** (mock field
   rename / stale comment only) — consequence of the `PromptBudgetResult`
   rename; no behavior.

## Concerns and limitations

1. **Free-tier affordability input (raised to orchestrator).** The ruled
   two-field spendable response covers only the purchased wallet;
   `readSpendable` explicitly excludes the daily allowance
   (`apps/api/src/slices/billing/domain/spendable.ts:123-130`). The free tier's
   affordability input therefore remains the served
   `allowance.remainingNanoUsd` from `GET /billing/balance` — a served number,
   no client re-derivation and no cushion, but it is NOT hold-aware and it
   rides the balance endpoint that BILLING §Affordability 2 calls "not an
   affordability input". If free-tier allowance holds should be visible
   pre-send, that needs a served figure that does not exist yet (T07/T08 built
   none) — a design gap above this task's pay grade.
2. **`e2e/helpers/budget.ts` keeps a local `freeAllowanceCents`** field (its
   own wire-reading assert helper, labeled legacy) — not a consumer of any
   deleted symbol, compiles clean; flagging for completeness of the cents sweep.
3. **markdown-renderer.tsx coverage flake** (above): one-off, not reproducible,
   file untouched. If the auditor's run hits it, rerun before attributing.
4. `run-started` now also invalidates `billingKeys.balance()` — the balance
   does not change at admission (holds are Redis-only), so this is one
   redundant refetch per run start; done to match the brief's freshness list
   literally. Trivial to drop if the auditor prefers minimal invalidation.

## Confidence

High — every deletion is pinned by an exact-shape or exact-value test, the
no-double-cushion hazard is pinned at both the shared layer and the hook layer
against the shared affordability solve itself, the funding contract now feeds
bit-identical inputs on both legs, and both scoped suites ran green under
`--force` with the coverage gate.
