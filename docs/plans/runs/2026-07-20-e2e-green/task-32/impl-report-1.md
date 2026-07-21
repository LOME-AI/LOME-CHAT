# Task-32 — impl-report-1: admission balance gate must honor PAID_CUSHION

## Objective

Make the admission Lua's insufficient-balance gate honor the paid negative-balance
cushion ($0.50) for NON-FREE wallets, so a paid wallet's first turn — whose estimate the
chat build path deliberately sizes to `remaining + PAID_CUSHION` — is admitted instead of
402'd. Free wallets, run-cap, and budget-scope checks unchanged. Money-safe (nano-USD
bigint, no `Number()` coercion), no settlement/ledger change.

## Cushion-semantics confirmation (FIRST, per brief)

- `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS = 50` — the single source
  (`packages/shared/src/constants.ts:151`). `NANO_USD_PER_CENT = 10_000_000n`
  (`packages/shared/src/nano-usd.ts:40`). Cushion = `50 * 10_000_000 = 500_000_000n = $0.50`.
- Estimate side (do-not-touch, Task-15): `turn-definition.ts:123` derives its own
  `PAID_CUSHION_NANO_USD` from the SAME shared constant, and `:202`
  `effective = remaining + (paid ? PAID_CUSHION_NANO_USD : 0n)`. So paid turns are sized to
  spend into a negative balance of up to $0.50. Intent is documented and deliberate — the
  estimate side is correct; the ADMISSION side was the bug.
- Admission caller passes the RAW snapshot balance: `admission.ts` args stamp only
  `estimateNanoUsd`; the Lua reads `snap.balanceNanoUsd` and gated on
  `balance - heldSum < estimate` (no cushion) for non-free wallets
  (`admission-scripts.ts` gate line). Confirmed the divergence.

I fixed the ADMISSION side (not the estimate side): the estimate's cushion sizing is the
documented intent, and admission was inconsistent with it.

## The change (money-precise)

- `constants.ts` — new `PAID_CUSHION_NANO_USD = BigInt(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) *
  NANO_USD_PER_CENT`. Single-sourced from the shared constant — the same origin the estimate
  side uses, so the two cannot drift; no second `$0.50` hardcoded.
- `admission.ts` — pass `PAID_CUSHION_NANO_USD.toString(10)` as `ARGV[6]` (before the
  variable-length budget-remaining args, which shift to `ARGV[7..]`). bigint→base-10 string,
  no `Number()`.
- `admission-scripts.ts` — Lua now computes `cushion` (ARGV[6]) but applies it ONLY for a
  snapshot with a known non-free type; the non-free balance gate becomes
  `balance + cushion - heldSum < estimate`. Budget-remaining read shifts to `ARGV[i + 4]`.
  Doc comment updated for the new ARGV and semantics.

Fail-closed preserved: a snapshot missing `type` still runs the balance check with
`cushion = 0` (guarded by `snap.type ~= nil and snap.type ~= 'free'`), so a stale/untyped
entry can only refuse, never over-admit. Free wallets still skip the balance branch entirely
(allowance rides the budget scope). Run-cap and budget-scope checks unchanged. Max negative
admitted for a paid wallet = exactly `PAID_CUSHION_NANO_USD` = MAX_ALLOWED_NEGATIVE_BALANCE_CENTS.

## Before/after — fresh $100 wallet, smart-model turn

- Balance = `100_000_000_000n` ($100). Cushion = `500_000_000n` ($0.50). Estimate sized
  `remaining + PAID_CUSHION ≈ 100_500_000_000n` ($100.50). Zero prior holds.
- BEFORE: `100_000_000_000 - 0 < 100_500_000_000` → true → `insufficient-balance` → 402 on
  the FIRST send. (This is the chat-402 flood root cause from task-21 impl-report-2.)
- AFTER: `100_000_000_000 + 500_000_000 - 0 = 100_500_000_000 >= 100_500_000_000` → passes →
  admitted. A turn sized `100_600_000_000n` ($100.60 > balance+cushion) STILL refuses.

## Files changed

- `apps/api/src/slices/billing/domain/admission-scripts.ts` — cushion added to the non-free
  balance gate; budget ARGV offset shifted; doc comment updated.
- `apps/api/src/slices/billing/domain/admission.ts` — stamp `PAID_CUSHION_NANO_USD` as ARGV[6].
- `apps/api/src/slices/billing/domain/constants.ts` — export single-sourced `PAID_CUSHION_NANO_USD`.
- `apps/api/src/slices/billing/domain/admission.integration.test.ts` — new cushion tests +
  updated two existing tests that pinned pre-cushion semantics (see below).

## Tests added / updated (TDD)

New `describe('admitRun PAID_CUSHION …')`:
- admits a paid turn whose estimate exceeds raw balance but fits within `balance + cushion`
  — the core 402→admit fix (criterion 4a).
- still refuses a paid turn whose estimate exceeds `balance + cushion` — the gate still
  works (criterion 4b).
- admits a turn sized exactly `remaining + cushion` on exactly `remaining` balance — the
  admission↔estimate cushion-consistency enforcement rung (criterion 5). Uses
  `BigInt(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) * NANO_USD_PER_CENT`, the same single source as
  production, so the two sides can't drift again.

RED verified: the two "admit" cushion tests failed with `expected false to be true` (raw-balance
gate refused a within-cushion turn); the "still refuses" test passed (correctly refuses beyond
cushion). After the fix all three pass.

Updated (encoded pre-cushion semantics — corrected to the authoritative cushion contract, not
weakened): `refuses when the balance plus cushion minus active holds cannot cover the estimate`
(re-sized to $1.20 balance / $1 estimates so two holds still exceed balance+cushion);
`never over-admits a single wallet under concurrent admission` ($3 balance / $1 estimates keep
the count at 3, cushion non-interfering); `blocks paid admission when the negative balance sits
below the cushion floor` (-$0.60 balance, beyond the -$0.50 floor, still refuses).

## Self-gate

- `pnpm test:watch src/slices/billing/domain/admission.integration.test.ts` — pass (28/28).
- eslint (from `apps/api`, all 4 edited files) — pass (exit 0).
- `turbo typecheck --filter=@hushbox/api` — pass.
- Full-coverage `pnpm test:api` not run one-shot (coverage suite is heavy/OOM-prone per brief);
  proved at the closest layer with the scoped file above.

## Acceptance criteria

1. Cushion semantics confirmed from code — MET (above; fixed admission, not estimate).
2. Non-free gate now `balance + PAID_CUSHION − heldSum ≥ estimate`; free/run-cap/budget
   unchanged — MET.
3. Money doctrine: nano-USD bigint, no `Number()` on money, no settlement/ledger change;
   cushion single-sourced; max negative = MAX_ALLOWED_NEGATIVE_BALANCE_CENTS — MET.
4. TDD failing test first (402→admit; over-cushion still refused), RED watched — MET.
5. Enforcement rung: admission↔estimate cushion-consistency test — MET.
6. `pnpm test:api` scoped green — MET at closest layer; e2e is the orchestrator's central run.

## Cross-task side effect (RAISED)

My correct loosening flips ONE test that pinned pre-cushion semantics, and it is OUTSIDE my
file ownership so I did not edit it:

- `apps/api/src/slices/chat/domain/runtime.integration.test.ts:365` —
  `refuses admission when the estimate exceeds the balance` seeds a PURCHASED wallet at
  `500n` and asserts a `10_000n` estimate refuses. Under the corrected cushion contract a
  paid wallet at 500n IS admissible for a 10_000n estimate (both far within the $0.50
  cushion), so the test now fails (confirmed: `admitted: true` returned). This test belongs to
  the chat-runtime owner (Task-21/Task-30 fence runtime.ts out of my scope). Fix: raise its
  estimate beyond `balance + cushion`, e.g. `admit(500n, 600_000_000n)`, keeping the
  refusal-on-over-cushion intent. I scanned every api test asserting balance refusal; all
  others are either mocked-admission, free-tier allowance (budget-scope) refusals, or
  budget/member-scope refusals — none affected by the cushion. This is the only real break.

## Deviations / concerns

- Cushion is granted only to a typed non-free snapshot (guard `snap.type ~= nil and
  snap.type ~= 'free'`); a missing-type stale snapshot keeps cushion 0 to preserve the
  fail-closed invariant the existing test pins. WalletType is only `purchased | free`
  (verified `packages/db/src/schema/enums.ts:63`), so "typed non-free" == purchased == the
  paid tier that earns the cushion.
- No settlement/ledger/estimate change. The fix is loosening-only for paid wallets: it can
  never turn a previously-admitted decision into a refusal.

## Confidence

high — the gate change is a minimal, single-sourced, money-safe loosening exactly matching the
documented estimate-side cushion; RED→GREEN verified; the one cross-task break is identified,
confirmed, and raised with the precise fix.
