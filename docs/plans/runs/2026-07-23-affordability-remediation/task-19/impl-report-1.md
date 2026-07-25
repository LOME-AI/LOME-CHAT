# Task 19 — Group fixes: payer-tier pricing, typed guest denial, budget lifecycle — impl report 1

Status: DONE_WITH_CONCERNS (all four criteria implemented and pinned; one
in-bounds gap raised: the main client sizing solve lives in a file barred by
T04 concurrency — see Deviations 1 / Raised).

## Objective

GB1/GB6 + budget-row lifecycle + edit validation (plan §Task 19): client
prices owner-funded turns at the payer's tier; guest denial gets a typed code
with shared copy; member removal deletes its `member_budgets` row
in-transaction; budget edits below accrued spend are rejected typed.

## What was built

1. **Payer-tier sizing (BILLING §Group Funding 1).** New shared
   `payerSizingTier` (`packages/shared/src/billing/client-billing.ts`):
   routes through the SAME `resolveFundingDecision` core as
   `resolveClientBilling` (isPremiumModel fixed `false` — who-pays is
   tier-agnostic, mirroring the server's `turn-context` derivation) and
   answers `'paid'` exactly when the owner funds the turn, else the caller's
   own tier. `deriveClientFundingInputs` now takes the narrower
   `ClientFundingContext` (funding-relevant subset; `ClientBillingInput`
   remains structurally assignable). `use-prompt-budget.ts` feeds the Smart
   Model storage context (`outputCharsPerTokenForTier`) from
   `resolveSizingTier(...)` instead of the caller's own tier.
2. **Typed guest denial.** New shared code `GROUP_BUDGET_EXHAUSTED`
   (constant + `ERROR_MESSAGES` copy). The denial site
   (`turn-context.ts:423`, previously bare `forbiddenError`) now carries it
   as the DomainError `wireCode`; `respondDomainError` in chat routes already
   projects `wireCode` via `domainWireCode` (`chat/routes.ts:302`,
   lib-pinned), so **no chat/routes.ts edit was needed at all** — the 403
   status is unchanged, only the wire code sharpens. Client copy rides the
   existing `friendlyErrorMessage(error.code)` path in
   `use-authenticated-chat.ts:306` (untouched — T10/T22 lane).
3. **Membership lifecycle owns budget rows.** New billing port/adapter
   `deleteMemberBudgetWithinTx` (single-writer: billing owns
   `member_budgets`); `removeMember`/`leaveConversation` take a
   `MemberBudgetDeleter` bound by the routes to
   `deps.billing.deleteMemberBudgetWithinTx(tx, …)` inside the SAME `byKey`
   transaction; the delete runs in the shared departure seam
   (`rotateOutDeparture`, after `markLeft`), so removal AND voluntary leave
   both reap the row. Owner leave hard-deletes the conversation (FK cascade
   reaps budgets). No orphan-cleanup script (zero users, A-ruled).
4. **Budget edits validate against accrued spend.**
   - Member cap: `setMemberBudgetCapWithinTx` is now a single guarded
     statement — upsert with `setWhere: spent <= new cap` + `RETURNING`;
     zero rows back = `'below-spent'` with the stored row untouched. Atomic
     by construction (guard and write in one statement, no check-then-act).
   - Conversation cap: new billing `lockConversationSpentWithinTx`
     (materialize zero row `ON CONFLICT DO NOTHING`, then `SELECT … FOR
     UPDATE`) — the spending row stays locked for the rest of the edit
     transaction, so a concurrent settlement accrual serializes behind it;
     lock order (spending row → conversations row) matches settlement's, so
     no deadlock. `setConversationBudget` answers authz BEFORE the spend
     validation (a non-owner cannot binary-search spend via cap probes;
     pinned) while the conditional owner UPDATE stays authoritative.
   - New refusal `budget-below-spent` → wire `BUDGET_BELOW_SPENT`, 400
     (`outcomes.ts`); shared copy in `ERROR_MESSAGES`; the budget modal
     surfaces it through `useAsyncAction`→`friendlyErrorMessage` with zero
     component changes (pinned in `budget-settings-modal.test.tsx`).

## Files changed

- `packages/shared/src/error-codes.ts` — `GROUP_BUDGET_EXHAUSTED` + `BUDGET_BELOW_SPENT` constants + copy
- `packages/shared/src/error-codes.test.ts` — pins for both codes (distinct from FORBIDDEN/VALIDATION copy)
- `packages/shared/src/billing/client-billing.ts` — `payerSizingTier`, `ClientFundingContext`
- `packages/shared/src/billing/client-billing.test.ts` — 6 payerSizingTier pins (see below)
- `apps/api/src/slices/chat/domain/turn-context.ts` — guest denial carries the wireCode (one call site)
- `apps/api/src/slices/chat/domain/turn-context.test.ts` — wireCode pin on the guest-denial case
- `apps/api/src/slices/billing/ports/stores.ts` — guarded cap-set return, `deleteMemberBudgetWithinTx`, `lockConversationSpentWithinTx`
- `apps/api/src/slices/billing/adapters/stores.ts` — the three implementations
- `apps/api/src/slices/billing/adapters/stores.integration.test.ts` — 6 new store tests (+ conversation seed/cleanup)
- `apps/api/src/slices/conversations/domain/outcomes.ts` (+ test) — `budget-below-spent` refusal + wire map
- `apps/api/src/slices/conversations/domain/budgets.ts` — below-spent mapping; authz-first + locked-spend conversation-cap flow
- `apps/api/src/slices/conversations/domain/budgets.integration.test.ts` — 5 new route-level tests
- `apps/api/src/slices/conversations/domain/members.ts` — `MemberBudgetDeleter` threaded through removal/leave departure seam
- `apps/api/src/slices/conversations/domain/members.test.ts` — call sites + noop deleter double
- `apps/api/src/slices/conversations/routes.ts` — three `tx`-bound billing bindings (remove, leave, conversation-cap PUT)
- `apps/api/src/slices/conversations/routes.integration.test.ts` — 4 new lifecycle tests
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — `resolveSizingTier` feeding the storage-context tier
- `apps/web/src/hooks/billing/use-prompt-budget.test.ts` — 2 tier-parity pins
- `apps/web/src/components/chat/budget/budget-settings-modal.test.tsx` — BUDGET_BELOW_SPENT inline-copy pin

## Tests added → criteria

- **Tier parity (criterion 1):**
  - shared `payerSizingTier` pins: free member owner-funded → `'paid'`
    (matching the server's wallet-kind derivation: purchased ⇒ paid); guest
    owner-funded → `'paid'`; exhausted headroom → caller tier; negative owner
    balance → caller tier (zero headroom); solo → caller tier; and the
    drift-guard `owner_balance verdict ⇔ paid sizing tier` against
    `resolveClientBilling` on the identical input.
  - web: `sizes a free-tier member's owner-funded preview at the PAYER's
    tier (paid ratios)` — `estimatedCostNanoUsd` equals the shared
    smart-model minimum computed at `outputCharsPerTokenForTier('paid')`,
    with an explicit guard that paid- and free-sized figures differ (the pin
    has teeth); twin test pins fall-through to caller tier on exhaustion.
- **Typed guest denial (criterion 2):** turn-context pin
  `error.wireCode === 'GROUP_BUDGET_EXHAUSTED'` on the existing guest-denial
  case (code stays `forbidden` → 403); shared error-codes pin (constant +
  copy ≠ FORBIDDEN copy); route projection is the existing
  `domainWireCode` path pinned in `apps/api/src/lib/errors/domain-error.test.ts`.
- **Member removal deletes the budget row (criterion 3), integration:**
  `removal deletes the removed member's budget row in the same transaction`;
  `removal leaves the budget rows of remaining members alone`; `a failed
  removal (stale epoch) deletes nothing — the row rides the same
  transaction`; `a voluntary leave also deletes the departing member's
  budget row`. Plus store-level delete + idempotent-no-op test.
- **Budget edit below spend (criterion 4), integration + client:**
  store-level: fresh insert applies; below-spent rejects atomically leaving
  the row untouched; equal-boundary applies. Route-level: member cap 400
  `BUDGET_BELOW_SPENT` with row untouched; boundary 200; conversation cap
  400 with stored cap kept; boundary + no-spending-row 200; non-owner gets
  403 (not a spend probe) even when overspent. Client: modal shows
  `friendlyErrorMessage('BUDGET_BELOW_SPENT')` inline from the shared map.

TDD: every production change had a watched-red first — error-codes (2 red),
payerSizingTier (6 red: missing export), turn-context wireCode (1 red:
undefined — first observed green was a stale-vite-cache artifact, cleared per
A6 and re-red properly), billing stores (6 red: missing methods/void return),
outcomes (1 red: unknown refusal), budget-edit routes (2 red: silent 200s),
lifecycle (3 red: rows survived). The modal-copy test and the two boundary
tests pinned behavior enabled by the shared-copy/guard changes and passed on
first run by design (the red for those contracts was at the shared/store
layer).

## Self-gate (Verified, this session)

- `pnpm test:shared` (turbo `--force`): 2340 passed, coverage gate green
  (`error-codes.ts`, `tiers.ts` 100%; `client-billing.ts` in the green gate).
- `pnpm test:web` (turbo `--force`, run alone): 365 files / 6023 passed,
  coverage gate green — run BEFORE the final complexity-refactor of
  `use-prompt-budget.ts`; the refactor is behavior-identical (51/51
  file-scoped green + lint clean after), and a final full forced web run was
  re-executed after it — result recorded below in the addendum line.
- `pnpm test:api` — full forced runs (2×) abort in the v8 coverage collector
  with the KNOWN environmental `ENOENT …/coverage/.tmp/coverage-N.json`
  crash (unconfirmed upstream vitest bug; also reproduced when another
  agent's vitest ran concurrently). Before the abort, the only failing tests
  across both runs were: `template-html.test.ts` snapshots (7 — A1-listed
  pre-existing snapshot flake, file git-clean), `language-adapter.test.ts`
  canonical-request-shape hash pin (file git-clean; reproduced in isolation;
  the request shape is fed by `turn-definition.ts`, git-dirty from T04's
  in-flight lane — no import path from this task's diff reaches request
  assembly), and `turn-definition.integration.test.ts` cases (T04-dirty
  file). None are attributable to this task. All suites owning this task's
  files ran green scoped: billing stores integration 34/34, conversations
  budgets integration 21/21, conversations routes integration 259/259 (then
  280/280 combined re-run), turn-context 19/19, members 27/27, outcomes
  25/25.
- Repo-wide `pnpm typecheck` (A3): 15/15 green.
- Lint, run from package dirs AFTER the final edit: shared owned files exit
  0; api owned files exit 0 (one fix round: prettier wraps, a nesting-depth
  refactor extracting `writeOwnerConversationCap`, a cleaner void-Result
  double); web owned files exit 0 (one fix round: complexity 11→ green by
  hoisting `resolveSizingTier`).
- A6 honored: `node_modules/.vite` cleared at root/api/web before trusting
  api/web results against the fresh shared edits (and it mattered — see TDD
  note).
- A3 consumer sweep: `GROUP_BUDGET_EXHAUSTED`/`BUDGET_BELOW_SPENT` grep
  repo-wide (apps, packages, e2e, scripts) — producers/consumers are exactly
  the files above; the e2e guest assertion targets the client-side
  `guest_budget_exhausted` budget-message test id (pre-send notification
  path, unchanged); no `scripts/` or `apps/marketing` consumer.
  `payerSizingTier`/`ClientFundingContext` consumers: shared + web hooks
  only. Changed api-internal signatures (`setMemberBudgetCapWithinTx`
  return, `removeMember`/`leaveConversation`/`setConversationBudget` arity)
  have zero consumers outside the conversations slice (grep evidence).

## Deviations, with reasons

1. **Main sizing solve NOT re-tiered (raised as out-of-scope need).** The
   preview's token estimate/affordability solve derives its tier INSIDE
   `use-budget-calculation.ts` (`useUserTierInfo` internally; no tier
   input) — a file the brief bars (T04 concurrent). Within bounds I fixed
   the storage-context tier in `use-prompt-budget.ts` and shipped the shared
   `payerSizingTier` authority; the remaining gap is mechanical once T04
   lands: give `useBudgetCalculation` a sizing-tier input (or have it accept
   the group context) and feed `resolveSizingTier`'s output. Until then an
   owner-funded preview still sizes `estimatedInputTokens`/`maxOutputTokens`
   and the token-minimum at the caller's tier (free = conservative
   over-estimate, so the divergence over-reserves, never under).
2. **`turn-context.ts` edited (not in the Files list).** The typed denial
   must originate where the refusal is decided; the established `wireCode`
   carrier makes it a one-call-site change and leaves `chat/routes.ts`
   untouched entirely (better than the planned "denial mapping" edit — no
   string matching, no route restructuring, no T13 collision).
3. **Billing `ports/stores.ts` + `adapters/stores.ts` (+ its integration
   test) edited (not in the Files list).** Single-writer doctrine: only
   billing may write `member_budgets`/read-lock `conversation_spending`; the
   plan's "compose via billing's barrel" is impossible without the barrel
   members existing. Additive port members + one signature sharpen.
4. **`conversations/routes.ts` edited (Files list says domain/*).** The
   `tx`-bound closures are the established composition pattern
   (`setMemberBudget`'s `writeCap` precedent); three bindings, no logic.
5. **Leave also deletes the budget row.** The criterion names removal; the
   delete lives in the shared departure seam (`rotateOutDeparture`), so
   voluntary leave gets the same lifecycle for free — splitting them would
   have required an artificial second code path against BILLING §Group
   Funding 4 ("membership lifecycle owns budget rows").
6. **`BUDGET_BELOW_SPENT` maps to 400** (plan says "typed 4xx"); chosen over
   409 because the edit is invalid against state the client can already see
   and refreshing alone never makes it valid.

## Concerns and limitations

1. **Removal-vs-settlement lock-order note (raised).** The removal
   transaction holds the conversations row FOR UPDATE from entry and later
   deletes the member's budget row; settlement writes budget rows BEFORE its
   conversations FOR SHARE. If the removed member's own run settles in the
   sub-millisecond window between its budget-row write and its FOR SHARE,
   Postgres resolves the ABBA as a deadlock kill of one side (settlement has
   no retry by doctrine). The window requires the victim member to have an
   in-flight owner-funded run settling at the exact moment of their removal.
   This hazard is inherent to the ruled "delete in the same transaction"
   criterion given removal's existing lock structure; flagged for the
   auditor/orchestrator rather than silently accepted. (The conversation-cap
   edit deliberately locks in settlement's order and has no such window.)
2. **Link-guest revocation does NOT reap the guest's budget row.** Guest
   departure travels `markLeftByLink` in the shares paths (user + admin
   revoke), untouched here (criterion names member removal; the revoke
   functions are consumed by other slices and their signature change would
   ripple). The leftover row is inert (a revoked link's member id never
   funds again) but violates the lifecycle doctrine's spirit — follow-up
   candidate.
3. **Guest-denial route-level wire evidence is by composition** (unit pin on
   the carried wireCode + the lib-pinned `domainWireCode` projection), not a
   new chat-routes integration case — `chat/routes.integration.test.ts` is
   A1-affected and T13 will rework it; adding cases there now invites
   collisions.
4. **Full `pnpm test:api` cannot be brought to a green summary in this
   environment** (coverage-collector ENOENT, reproduced 3×, also present
   with zero concurrent vitest processes). The failing-test set before each
   abort was fully attributed (A1 flake + T04 lane). The auditor should
   re-run once T04 lands and the environment quiets.
5. `use-resolve-billing.ts` needed no change: for owner-funded turns the
   resolver's early `owner_balance` return bypasses the tier-consuming
   self-funding layer, and on fall-through the caller's own tier is correct
   by design. Named in the plan's Files list; recording the considered
   no-op.

## Confidence

High for what shipped — every criterion is pinned at the narrowest layer that
owns it, the atomic guards are single-statement or lock-held, and all
task-owned suites are green with repo-wide typecheck clean. Medium on
criterion 1 taken as a whole, because the main sizing solve's tier input
remains caller-tier until the barred file can be touched (Deviation 1).

## Addendum — final full web run after the complexity refactor

`pnpm test:web` (turbo `--force`, full suite, after the LAST web edit):
368 files / **6073 passed**, coverage gate green, turbo `Tasks: 1
successful, 1 total`, exit 0 (`use-prompt-budget.test.ts` 51/51). One prior
attempt of the same run showed all 6073 tests passing yet `Tasks: 0
successful` — same coverage-collector instability family as the api ENOENT
crashes; the clean rerun above is the standing evidence. File counts grew
365→368 across the session because sibling tasks landed new test files
concurrently.
