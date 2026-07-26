# F1 — Payer-scoped served numbers · impl-report-2 (fix cycle)

## Objective

Two validated findings from F1's two audits, nothing else:

1. Three comments claim the served figure matches the admission gate **exactly** —
   true of the self arm, inexact for the owner arm (`ownerSnapshot` prices the owner
   dimension from the RAW purchased balance, applying neither the payer's paid-tier
   cushion nor the owner wallet's own holds). State the exception; **do not change the
   math** (raw owner dimension is correct by ruling; BILLING §Group Funding 6(b) makes
   the resulting divergence a hard refusal at admission).
2. `useModelFloor` fed the **payer-scoped** snapshot's `spendableNanoUsd` into
   `resolveClientBilling`, whose parameter is *the caller's own* served spendable.
   Keep `sizingTier` from the scoped read; take `spendableNanoUsd` from an unscoped
   read, mirroring `useResolveBilling`.

## Files changed

### Finding 1 — comments only, no executable change

- `apps/api/src/slices/billing/domain/spendable.ts` — `FundingSnapshot.spendableNanoUsd`'s
  doc no longer says "exactly what admission's gate compares for this payer". It now
  says: exact when the payer is the caller; for an owner-funded turn the owner-balance
  dimension is the raw purchased balance (no cushion, no owner-wallet holds) by ruling,
  so the figure can diverge in either direction, and the spec makes that divergence a
  hard refusal at admission (BILLING §Group Funding 6b).
- `apps/api/src/slices/billing/routes.ts` — the `/spendable` route comment drops
  "matching the admission gate exactly"; it states the self-arm equality, names the raw
  owner dimension, and points at `FundingSnapshot.spendableNanoUsd` rather than
  restating the rule (one place carries it).
- `packages/shared/src/schemas/api/billing.ts` — `getSpendableResponseSchema`'s doc
  qualifies "the number admission would gate with" to *when the payer is the caller*,
  and records the raw owner dimension + the §6(b) refusal.

Not touched, deliberately: `ownerSnapshot`'s own docstring
(`spendable.ts`) already stated the raw-dimension exception explicitly and made no
exactness claim — it was the correct comment the three drifted from. Left byte-identical.

### Finding 2 — `apps/web/src/hooks/billing/use-prompt-budget.ts` (`useModelFloor` only)

- Two `useSpendable` reads, each with one job: `useSpendable(groupScope(input.group))`
  → `payerSpendableData`, which feeds `sizingTier` only (the payer prices the turn);
  `useSpendable()` → `ownSpendableData`, whose `spendableNanoUsd` feeds
  `resolveClientBilling` (the caller's own wallet is what the fall-through arm
  compares). A comment records why the two must not be collapsed.
- `isPending` now also covers the unscoped read's pending state (see the second test
  below).

No other file changed. `useResolveBilling`, `client-billing.ts`, `use-budget-calculation.ts`,
`spendable.ts`'s arithmetic and the wire schema's shape are untouched.

## Tests added

`apps/web/src/hooks/billing/use-prompt-budget.test.ts` (`useModelFloor` describe):

| Test | Behavior | Finding |
| --- | --- | --- |
| `funds a member's fall-through from their OWN wallet when group holds zero the headroom out` | paid-tier non-owner member; durable group headroom positive so the server serves `payer:'owner'` with hold-aware `spendable: 0`; the member's own wallet is funded ⇒ `isBelowFloor === false` | 2 — the reachable state |
| `suppresses greying while the caller's OWN wallet read is still in flight` | payer-scoped read landed, group headroom spent, own-wallet read still pending ⇒ `isPending === true` and no greying | 2 — the same defect inside the load window |

Test-infrastructure change to make the two reads separable: the `use-spendable` mock is
now argument-aware — the argument-free call returns `mockUnscopedSpendable.current` when
a test sets it, otherwise both arms share the one existing `mockSpendable` fixture. Reset
to `undefined` in both `beforeEach` blocks so no test depends on order. Every pre-existing
test keeps its exact fixture and assertions (66 of them unchanged); the solo/no-group
arms resolve both reads to the same fixture, which is why they are unaffected.

Also extracted `FixtureTier` / `SpendableFixture` / `SpendableQueryFixture` type aliases —
required, not cosmetic: the second fixture's inline union tripped
`sonarjs/use-type-alias` at lint.

### TDD sequencing (both tests)

- Test 1: written first, run alone → **red** with `AssertionError: expected true to be
  false` at the `isBelowFloor` assertion. That is the finding's exact symptom: the picker
  greys a model the member can self-fund. Then the two-read fix → green.
- Test 2: written first, run alone → **red** with `expected false to be true` at
  `result.current.isPending`. Then adding `isOwnSpendablePending` to `isPending` → green.
- Finding 1 is comment-only and has no test; there is no behavior to pin. The behavior it
  describes (owner arm raw, self arm exact) was already pinned by run 1's domain tests.

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo typecheck --force --continue` (repo-wide) | **pass — 16/16, uncached.** `@hushbox/scripts` is green, as the brief said. |
| `npx turbo test --filter=@hushbox/shared --force` | pass |
| `npx turbo test --filter=@hushbox/web --force` | pass — coverage gate included; the intermittent `markdown-renderer.tsx` per-file flake did not fire this run |
| `npx turbo test --filter=@hushbox/api --force` | 465 files / 6391 tests pass; **1 file fails: `notifications/domain/templates/template-html.test.ts`** — see attribution below |
| `pnpm arch:check` | pass — 11 rules over 1999 files |
| `eslint` on every owned file, from the owning package dir, after the last edit | exit 0 (api, shared, web) |

`use-prompt-budget.test.ts` alone: 68/68 pass. The four billing hook test files together:
121/121.

### The one api failure, attributed

`template-html.test.ts` — 7 snapshot failures over the removed Google-Fonts `<link>`,
which is §Known Breakage's entry verbatim (same file, same count, same cause). Re-verified
rather than assumed: `git status --porcelain -- apps/api/src/slices/notifications/domain/templates/`
is **empty** — neither the test nor its `.snap` is modified relative to HEAD `39a07db0`,
and this fix cycle changed only comments in `apps/api`. No second cause appeared.

Consequence, same as run 1: `pnpm test:api` aborts before emitting its coverage report.
This cycle's api edits are comments, so there is no api coverage delta to observe. The web
change is covered — the full web run's per-file gate passed, which is the ≥95 %
line/branch/function assertion on `use-prompt-budget.ts` itself.

A scoped `npx vitest run src/slices/billing` (bypassing `scripts/with-env.ts`) fails 17
suites on missing `DATABASE_URL`/Redis env — a harness artifact of the raw invocation, not
a product failure. The through-`turbo` run is the one that counts, and there every billing
file passed.

## Acceptance criteria

Only the two findings were in scope this cycle; F1's plan criteria were met in run 1 and
both audit lenses passed on them. Re-checked for regression:

1. **Finding 1 — the three comments state the raw-owner exception, math unchanged** — met.
   `git diff` on `spendable.ts` and `routes.ts` contains comment lines only; the shared
   schema diff is a doc block. `ownerSnapshot`, `groupEffectiveRemainingNanoUsd`, and the
   `resolveFundingDecision` call are byte-identical. Every run-1 domain test still passes
   unchanged, which is the pin that the arithmetic did not move.
2. **Finding 2 — the picker no longer greys a self-fundable model** — met, pinned by the
   two new tests, watched red first.
3. **`useResolveBilling`'s send verdict is unchanged** — confirmed three ways:
   `use-resolve-billing.ts` is not in this cycle's diff (`git status` shows it unmodified
   relative to HEAD); it still takes the argument-free read at `:35`, unchanged; and
   `use-resolve-billing.test.ts` passes untouched. The two hooks now agree on which wallet
   feeds which parameter — payer-scoped → sizing tier, unscoped → the affordability
   compare — which is the property the finding asked for.
4. **The E3 key shape is unaffected** — the added read is `billingKeys.spendableFor(null)`,
   the same solo key the family prefix already reaches. `billingKeys.spendable()` stays the
   argument-free prefix and run 1's prefix-invalidation test still passes.

## Deviations, reasons

1. **The second test (`isPending` covering the unscoped read) is one step beyond the
   literal instruction**, which named only the `spendableNanoUsd` swap. Included because it
   is the same defect inside the load window: with the scoped read warm and the unscoped one
   in flight, `spendableNanoUsd` falls back to `0n` and the picker greys every affordable
   row for a render. Two lines, and it makes `isPending`'s own doc comment ("True while
   funding inputs load; `isBelowFloor` already suppresses then") true of both funding
   inputs rather than one.
2. **Test-file type aliases** (`FixtureTier` etc.) — forced by `sonarjs/use-type-alias`
   once a second fixture repeated the tier union. Not a style preference; lint exit 0 is
   Global Constraint 9.

## Concerns and limitations

- **Two `useSpendable` calls in one hook, deliberately.** The STOP-AND-ASK trigger asked
  whether this is a worse defect than the one being fixed. It is not, and the precedent
  transfers cleanly: `usePromptBudget` already issues exactly this pair (scoped at `:466`
  for sizing, unscoped inside `useResolveBilling` for the verdict), so `useModelFloor` now
  matches the composer it is supposed to agree with. Cost is bounded: in a solo
  conversation both calls resolve to the same query key and TanStack dedupes them into one
  request; only a group member issues two.
- **The divergence finding 1 documents is real, not hypothetical.** When the owner
  dimension binds and the owner's wallet holds exceed the paid cushion, the served figure
  overstates and the composer will present a send that admission refuses. Per the
  amendment, that is settled in the spec's favour (§Group Funding 6(b) = hard refusal) and
  needs no ruling; what remains is refusal copy, which B7 owns. Nothing here tries to
  narrow it.
- **`payerSizingTier` in `client-billing.ts` still has no production consumer** — routed to
  G2 in run 1, unchanged by this cycle (my fix keeps taking the tier from the served
  snapshot, which is what orphaned it).
- **The composed hold-aware group minimum still repeats** between `spendable.ts` and
  `conversations/domain/budgets.ts` — also G2's, out of my ownership, unchanged.
- **E1 is slated to delete `useModelFloor`.** Finding 2's fix is therefore interim by
  design, per the brief's own reasoning. If E1 lands, the two new tests go with the hook;
  the behaviour they pin should be re-pinned on whatever replaces it, because the defect
  class (a payer-scoped figure reaching a caller-scoped parameter) survives the rewrite.

## Confidence

**High.** Both findings are narrow and both are now closed against evidence rather than
inspection: finding 2's reachable state is pinned by a test watched red for exactly the
stated symptom, and finding 1 is comment-only with the arithmetic proven unmoved by run
1's full domain suite still passing. Repo-wide typecheck is 16/16 uncached, web and shared
suites are fully green including web's coverage gate, and the single api failure is
re-verified as the pre-existing notifications-workstream snapshot break on a file this
cycle did not touch.
