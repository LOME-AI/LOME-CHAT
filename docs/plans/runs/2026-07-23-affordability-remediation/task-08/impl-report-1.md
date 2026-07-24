# Task 08 — Budgets endpoint hold-awareness — implementation report 1

Status: COMPLETE (all acceptance criteria met; environment/coverage-phase flake and
unrelated failures attributed below).

## Objective

`GET /conversations/:id/budgets` serves a hold-aware `effectiveRemainingNanoUsd`:
each group dimension (member cap, conversation cap) subtracts its active admission
scope holds before the min, so the shown remaining reflects in-flight runs exactly
as the admission script's per-scope `remaining − scopeSum ≥ estimate` check would.
Redis down fails the read closed (typed 503), matching Task 07.

## What was built

1. **Scope-id derivation shared, not mirrored**
   (`billing/domain/budget-resolution.ts`): `memberBudgetScopeId(memberId)` /
   `conversationBudgetScopeId(conversationId)` extracted from the inline template
   literals; `resolveBudgetScopes` (the admission gate's input) now calls them.
   The display-side reader imports the same functions — display and admission
   address the same Redis hash by construction, never by agreement.

2. **Scope-hold reader** (`billing/domain/spendable.ts`):
   - `BudgetScopeHoldRef` — `{scope:'member', memberId} | {scope:'conversation',
     conversationId}`; callers never build scope-id strings.
   - `readBudgetScopeHolds(redis, scopes, now)` — maps refs through the shared
     scope-id builders + `BILLING_KEYS.scopeHolds.buildKey`, delegates to T07's
     `readActiveHolds` (`HOLDS_READ_SCRIPT`, which embeds the shared
     `ACTIVE_HOLDS_LUA` fragment): ONE script exec for any number of scopes,
     hold values parsed only inside Lua, lazy expiry pruning, typed `unavailable`
     on Redis failure. T07's Lua scripts are untouched.
   - `holdReadoutAt(readouts, index)` — positional pairing accessor (one readout
     per requested ref by construction); a hole throws (defect), never a silent
     `?? 0n` default.

3. **Billing barrel** (`domain/index.ts` + slice `index.ts`): exports
   `readBudgetScopeHolds`, `holdReadoutAt`, and types `BudgetScopeHoldRef`,
   `ActiveHoldsReadout`, `RedisClient` (the reader's client type, previously
   domain-barrel-only). `readActiveHolds` itself stays off the slice barrel
   (consumed via the typed wrapper).

4. **Budgets display** (`conversations/domain/budgets.ts`):
   - `getConversationBudgets(deps, params)` — deps now `BudgetsReadDeps`
     `{stores, billing, db, redis}` (object form forced by the `max-params` lint
     rule once `redis` joined), params gain `now: Date`.
   - `loadBudgetsView` reads `[conversation scope, ...visible member scopes]` in
     ONE `readBudgetScopeHolds` call (M+1 hashes, one script exec, one round
     trip) combined with the existing three DB reads.
   - `buildBudgetsView`: `effectiveRemainingNanoUsd = groupEffectiveRemainingNanoUsd(
     memberCap − memberSpent − memberHeld, conversationCap − conversationSpent −
     conversationHeld, ownerBalance)` — the SAME min/clamp helper the funding
     decision uses, now over hold-net dimensions. Clamping keeps the identity
     with the admission gate (`clamp(cap−spent) − held` and `clamp(cap−spent−held)`
     agree for every non-negative estimate). Owner balance stays the raw
     purchased balance (plan: the hold-aware member/conversation scope hashes
     only; the owner's wallet-hold view is Task 07's endpoint).
   - Response schema unchanged — remaining is backend-computed; the client never
     re-derives it.

5. **Route** (`conversations/routes.ts`, budgets GET only): passes `c.var.redis`
   and `now: new Date()`. A Redis failure flows `unavailable` →
   `respondDomainError` → 503 `{code:'UNAVAILABLE'}` — the exact Task 07 mapping.

## Acceptance-criteria evidence

- **Served remaining under an active scope hold matches what admission would
  allow (behavioral pin):** `budgets.integration.test.ts › serves a remaining
  under an active scope hold that equals exactly what admission would allow` —
  seeds owner ($100 wallet), member (cap $1), conversation (cap $2); places a
  REAL `admitRun` hold ($0.30) over scopes built by `resolveBudgetScopes` (the
  production scope resolution, no hand-built ids); route-level GET serves
  `700000000`; then `admitRun` with `served + 1n` refuses
  `{admitted:false, reason:'budget-exceeded'}` and with exactly `served` admits.
  Billing-level twin: `spendable.integration.test.ts › reads the member and
  conversation scope holds admission places…` pins that the reader sees exactly
  the hashes `ADMISSION_SCRIPT` wrote, keyed via the shared scope-id builders.
- **M+1 reads bounded:** structurally, `loadBudgetsView` makes ONE
  `readBudgetScopeHolds` call per request over conversation + visible member
  scopes. Pinned twice with a counting seam over the real Redis client (external
  seam, no slice mocked): `budgets.integration.test.ts › reads every scope hold
  in one Redis script exec (M+1 hashes, one round trip)` — 2 members + 1
  conversation scope, `execs === 1`; `spendable.integration.test.ts › issues
  exactly one Redis script exec regardless of the number of scopes` (3 scopes).
- **Redis down ⇒ typed failure, endpoint fails closed:**
  `budgets.integration.test.ts › fails closed with a typed 503 when Redis is
  down` — dead-Redis env at the route: 503 `{code:'UNAVAILABLE'}` (same pattern
  as T07's route test). Domain-level: `readBudgetScopeHolds` dead-Redis test →
  typed `unavailable`.
- **Barrel export:** `readBudgetScopeHolds` (+ `holdReadoutAt`, types) on
  `billing/domain/index.ts` and `billing/index.ts`; conversations composes
  billing only through the slice barrel (arch:check OK).
- **Admission behavior untouched:** T07's Lua scripts unmodified; full billing +
  conversations scoped run green (76 files, 1253 tests), including the 29-test
  admission suite and the concurrent-settlement pin.
- **Hold-format parsing stays Lua-only:** no TS parse anywhere; the reader is a
  key-mapping wrapper over `readActiveHolds`.

## Tests added

- `spendable.integration.test.ts`: reader sees admission's scope holds in order ·
  one exec for N scopes · dead-Redis typed unavailable · `holdReadoutAt` returns /
  throws (2 tests).
- `budgets.integration.test.ts`: hold-aware served remaining + behavioral
  admission pin · one exec for M+1 hashes · dead-Redis 503. (`seedPurchasedWallet`
  now returns the wallet id; holds released via `releaseHold` after the pin.)

## TDD

Both test batches written first and watched fail for the right reasons: billing
batch — 5 failures, "is not a function"/missing exports; conversations batch — 3
failures: served `1000000000 ≠ 700000000` (holds ignored), refusal from the old
signature, `200 ≠ 503` on dead Redis. Minimal green each step; no test weakened.

## Self-gate (Verified, this session)

- `pnpm test:api` (full): best complete run **6090 passed | 7 failed** — the 7
  are `notifications/domain/templates/template-html.test.ts` snapshot mismatches,
  pre-existing (file untouched; same failures T07 attributed; notifications is
  git-dirty from work that is not mine). The earlier chat-routes failures seen in
  a first run disappeared as the sibling task's files settled. **Coverage-merge
  phase intermittently crashes** with `ENOENT …coverage/.tmp/coverage-N.json` /
  "Something removed the coverage directory" — reproduced with and without turbo,
  once while a concurrent sibling vitest `--coverage` (PID observed) shared
  `apps/api/coverage/.tmp`; this is the documented pre-existing upstream Vitest
  flake in this repo, not introduced by this task.
- Coverage evidence (isolated run, separate `reportsDirectory`, billing +
  conversations + their tests all green): owned files **100/100/100**
  (`budgets.ts`, `spendable.ts`, `budget-resolution.ts`, `admission-scripts.ts`);
  `conversations/routes.ts` 98.81/98.21/95.74 (≥95). `billing/routes.ts`
  (untouched) showed 94.44 branches under slice-only scoping and reaches **100%**
  once `src/app-mount.integration.test.ts` runs with it — a scoping artifact,
  not a regression.
- `tsc --noEmit` (apps/api): exit 0 after the final source edit.
- `eslint <8 owned files>` from `apps/api`: **exit 0 after the last edit**.
- `pnpm arch:check`: OK (11 rules / 1880 files).
- `pnpm lint:unused` (knip): one finding, `packages/config/vitest.package.config.ts`
  — pre-existing/unrelated (same single finding T07 reported); zero findings on
  this task's exports.

## Files changed

- `apps/api/src/slices/billing/domain/budget-resolution.ts` — scope-id builders extracted and used
- `apps/api/src/slices/billing/domain/spendable.ts` — `BudgetScopeHoldRef`, `readBudgetScopeHolds`, `holdReadoutAt`
- `apps/api/src/slices/billing/domain/spendable.integration.test.ts` — 5 new tests
- `apps/api/src/slices/billing/domain/index.ts` — domain barrel exports
- `apps/api/src/slices/billing/index.ts` — slice barrel exports (incl. `RedisClient` type)
- `apps/api/src/slices/conversations/domain/budgets.ts` — hold-aware view, `BudgetsReadDeps`
- `apps/api/src/slices/conversations/domain/budgets.integration.test.ts` — 3 new tests + wallet-seed helper returns id
- `apps/api/src/slices/conversations/routes.ts` — budgets GET passes `redis` + `now`

## Deviations, with reasons

1. **Two billing domain files edited beyond the literal Files list**
   (`spendable.ts`, `budget-resolution.ts`). The brief's "billing barrel export
   of the scope-hold reader" requires the reader to exist; exporting raw
   `readActiveHolds` would have forced conversations to build
   `member:<id>`/`conversation:<id>` strings itself — a banned mirrored
   implementation. The reader + shared scope-id builders are the minimal
   drift-proof shape. T07's exports were only built on, never semantically changed.
2. **`conversations/routes.ts` edited** (budgets GET handler only): the domain
   read needs the per-request Redis handle and a clock; unavoidable wiring.
3. **`getConversationBudgets` signature restructured** to `(deps, params)` —
   the repo's `max-params` (≤4) lint rule fired once `redis` joined; routes.ts
   is the only production caller, updated in the same change.

## Concerns and limitations

- The full-suite coverage gate could not be observed end-to-end this session due
  to the pre-existing ENOENT coverage-directory flake (plus at least one
  concurrent sibling vitest sharing `apps/api/coverage/.tmp`). Isolated coverage
  evidence above is complete for every file this task touches.
- Owner balance in the display deliberately stays raw (no owner wallet-hold
  subtraction): the plan scopes T08 to the member/conversation scope hashes, and
  the owner's hold-aware number is T07's `/billing/spendable`. If an auditor
  reads "exactly as admission would" to include the owner-wallet dimension,
  that is the one place display and gate can still diverge (an owner-funded
  concurrent run's wallet hold).

## Confidence

High — behavioral pins tie the served number to real `admitRun` outcomes through
the production scope resolution; all owned files at 100% coverage; every scoped
gate green; unrelated failures attributed with git-status + file-history evidence.
