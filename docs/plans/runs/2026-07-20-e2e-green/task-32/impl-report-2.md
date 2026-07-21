# Task-32 — impl-report-2: refactor admission cushion to genuine shared logic

Supersedes impl-report-1's shallow version (shared CONSTANT + Lua re-doing `balance + cushion`).
This replaces the two representations of the spendable-funds rule with ONE function.

## What changed vs report-1

Report-1 left two implementations of "spendable funds": the estimate side hand-rolled
`remaining + PAID_CUSHION` (turn-definition.ts) and the admission Lua re-computed
`balance + cushion`. This report collapses both onto one function and makes the Lua a pure
holds subtractor.

### 1. One shared rule (`packages/shared/src/budget.ts`)

- `spendableFundsNanoUsd(balanceNanoUsd: bigint, tier: UserTier): bigint` — the single rule:
  `balance + (tier === 'paid' ? PAID_CUSHION_NANO_USD : 0n)`. nano-USD bigint, no `Number()`.
- `PAID_CUSHION_NANO_USD` — the single source of the $0.50 cushion in nano-USD, derived from
  `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS` (the same constant `getCushionCents` already uses).

**Location rationale (deviation from the literal "billing domain" instruction — RAISED):**
the cushion rule already lives in `packages/shared` (`getCushionCents`,
`MAX_ALLOWED_NEGATIVE_BALANCE_CENTS`), and both callers need it — `admission.ts` (billing
slice) and `turn-definition.ts` (chat slice). Putting it in billing/domain would force a NEW
`chat/domain → billing/domain` cross-slice import (chat/domain imports no billing internals
today; it does already import `@hushbox/shared`), a slice-boundary smell. `packages/shared` is
the boundary-safe single-source home and keeps the nano-USD rule beside its cents sibling.

### 2. Estimate side calls the shared rule (`turn-definition.ts`)

`turnMaxOutputTokens` now does `const effective = spendableFundsNanoUsd(remaining, tier)`;
its local `PAID_CUSHION_NANO_USD` redeclaration and the now-unused
`MAX_ALLOWED_NEGATIVE_BALANCE_CENTS` / `NANO_USD_PER_CENT` imports were removed.

### 3. Admission: TS computes spendable, Lua is a holds-only subtractor

- `admission.ts` resolves the (advisory) snapshot in TS — `readRedisSnapshot` (a `redis.get`),
  falling back to the Postgres-truth `bootstrapSnapshot` on a miss (bootstrap preserved; the
  old `no-snapshot`-from-Lua retry loop is gone because TS now holds the balance). It derives
  `spendableFor(balance, type) → { applyBalanceCheck, effectiveSpendableNanoUsd }` via the
  shared `spendableFundsNanoUsd`, and passes those two numbers to the Lua.
- `admission-scripts.ts`: the Lua no longer reads the snapshot, the type, or the cushion. It
  receives `effectiveSpendable` + `applyBalanceCheck` and gates
  `applyBalanceCheck == 1 and effectiveSpendable − Σholds < estimate`. **Everything that
  reads-and-writes mutable Redis state stays atomic inside the script** — the active-holds sum,
  the concurrent-run cap (`heldCount ≥ cap`), each per-budget-scope check-and-add, and the
  hold `HSET`s. Only the (already-advisory) balance moved to TS. KEYS: `[walletHolds,
  ...scopeHolds]`; ARGV: `holdId, estimate, nowMs, ttlSeconds, cap, effectiveSpendable,
  applyBalanceCheck, ...remainings`.
- `billing/domain/constants.ts`: removed the report-1 `PAID_CUSHION_NANO_USD` (single source is
  now shared).

**Atomicity guarantee — the coordinator's guardrail is met.** No racy check left the atomic
section. The `never over-admits a single wallet under concurrent admission` and `counts racing
holds against a shared budget scope atomically` integration tests (real Redis, `Promise.all`)
still pass, pinning that holds/cap/scope check-and-add remain atomic.

**Fail-closed preserved.** `spendableFor` maps a missing/unknown type to `tier = 'free'` (no
cushion) with `applyBalanceCheck = true` → effective = raw balance; a stale/untyped snapshot
can only refuse. `type === 'free'` → `applyBalanceCheck = false` (allowance rides a budget
scope). `type === 'purchased'` → paid cushion. Pinned by the `fails closed … no wallet type`
and `free-tier admission` tests.

## Tests (TDD, RED→GREEN)

- `packages/shared/src/budget.test.ts` — NEW `spendableFundsNanoUsd` suite asserts the ONE
  rule (paid adds cushion; free/trial/guest add nothing; negative paid balance offset by
  cushion; `PAID_CUSHION_NANO_USD` equals the shared derivation). Watched RED (function
  undefined), then GREEN.
- `admission.integration.test.ts` — cushion tests now express expectations via
  `spendableFundsNanoUsd(BALANCE, 'paid')` (no second `balance + cushion` representation):
  admits within spendable, refuses beyond spendable, admits at exactly spendable, and pins
  `SPENDABLE − BALANCE === PAID_CUSHION_NANO_USD`. The two `fakeRedis` defect tests updated for
  the new flow (one now supplies a `get`; the obsolete `bootstrap does not stick` test — that
  failure mode no longer exists — replaced with `fails closed when the snapshot read is
  unavailable`).
- `runtime.integration.test.ts` — fixed the two cushion-induced breaks (now in my ownership):
  `refuses admission when the estimate exceeds the balance plus the paid cushion`
  (`admit(500n, 600_000_000n)`), and the hold-release test's estimates bumped $0.60→$0.80 so
  two holds still exceed balance+cushion (intent unchanged: only the release lets the next turn
  in).

## Self-gate (all FOREGROUND)

- `pnpm test:api` scoped to touched files — all pass:
  - `billing/domain/admission.integration.test.ts` — 29/29
  - `chat/domain/runtime.integration.test.ts` — 28/28
  - `chat/domain/turn-definition{,.integration}.test.ts` + `smart-model-turn{,.integration}` — 70/70
  - `workflows/engine/smart-model.integration` + `chat/domain/settlement.integration` — 57 pass / 2 pre-existing skips
  - `models/domain/estimate-run` + `smart-model-candidates` + `trial-smart-model-candidates` — 81/81
  - `chat/routes.integration` — 156/156
  - engine `interpreter`/`failures`/`hooks`, `trial`, `trial-settlement`, `app-mount`,
    `realtime-do`, `live-run`, `executor-construction` — 175/175 (admission consumers, all mocked or unaffected)
- `packages/shared` `budget.test.ts` — 211/211.
- `turbo typecheck lint --filter=@hushbox/api --filter=@hushbox/shared` — 4/4 successful
  (eslint + tsgo, both packages).

## Acceptance criteria (updated criterion 5 — genuine shared logic)

1. Single `spendableFundsNanoUsd` in shared; `PAID_CUSHION_NANO_USD` single-sourced;
   turn-definition's local redeclaration removed — MET.
2. Estimate side calls the function — MET.
3. `admission.ts` computes `effectiveSpendable` and passes it; the Lua is a pure atomic
   holds subtractor; racy checks stay atomic; bootstrap + fail-closed preserved — MET.
4. Tests assert the ONE function's rule, not a two-representation contract — MET.
5. Cross-task breaks fixed (runtime.integration.test.ts) — MET.

Money doctrine: nano-USD bigint throughout, no `Number()` coercion on money; no
settlement/ledger change.

## Deviation (RAISED)

- Shared function placed in `packages/shared/src/budget.ts` rather than the billing domain, to
  avoid a new chat→billing cross-slice import and to sit beside the existing cushion rule. This
  is the single-source home; both slices already import `@hushbox/shared`.

## Confidence

high — the spendable rule is genuinely single-sourced and behavior-preserving vs report-1's
cushion fix; the atomic holds/cap/scope guarantee is intact (concurrency tests green); the
full set of admission consumers and the estimate/settlement suites pass; typecheck + lint green
for both packages.
