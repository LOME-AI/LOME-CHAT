# F3 — impl report 1

## Objective

`GET /billing/spendable` serves one funding number that is correct for every tier the endpoint
can answer for — including the free-tier daily allowance — so no client composes a funding
figure from two endpoints. The remaining-trial-message-count half of the criteria is **not
delivered**; §Criterion 2 below states why, with the evidence, and it needs an orchestrator
decision plus a different owner.

## Files changed

- `apps/api/src/slices/billing/domain/spendable.ts` — the self arm now prices from the wallet
  that would actually pay: one `getUserTier` derivation picks the paid arm (purchased wallet
  through admission's spendable rule) or the free arm (day-keyed allowance minus that scope's
  holds) **and** labels the served `tier`, so figure and label cannot describe different
  wallets.
- `apps/api/src/slices/billing/domain/budget-resolution.ts` — comment only: the served snapshot
  is now a second caller of `resolveBudgetScopes`; the header said the admission hook was the
  caller.
- `packages/shared/src/schemas/api/billing.ts` — comment only on
  `getSpendableResponseSchema`: the served figure is now complete for every tier, and the old
  parenthetical ("may be negative for an overdrawn self-funding wallet") was falsified by the
  change — negative now arises when holds exceed the funds behind the figure.
- `apps/api/src/slices/billing/domain/spendable.integration.test.ts` — the free-tier arm's
  tests; the overdrawn-wallet test re-pointed (see Deviations).
- `apps/api/src/slices/billing/routes.integration.test.ts` — the wire-level free-payer pin.

No schema shape changed, so `apps/web/src/lib/api-client.ts` needed no regeneration
(repo-wide typecheck confirms: 16/16, zero cached).

## Tests added

In `spendable.integration.test.ts`, describe `readFundingSnapshot — the free-tier arm (BILLING
§Funding, §User Tiers)`:

| Test                                                                          | Behavior                                                                                             | Criterion              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| serves the day's remaining allowance as a free payer's spendable              | a zero-balance payer is served the allowance, tier `free`                                            | 1 (free tier non-zero) |
| subtracts the day's spend from the served allowance                           | an `allowance_spending` row moves the figure                                                         | 1                      |
| reports an allowance-scope hold as held, so spendable + held is the remaining | `heldNanoUsd` is the allowance scope's holds; `spendable + held` = effective balance (BILLING §Funding) | 1                      |
| serves the figure admission gates a free-tier turn on                         | `admitRun` on the free wallet with the hook's own scopes: `served` admits, `served + 1` → `budget-exceeded` | 5 (gate pin)     |
| serves an overdrawn purchased wallet the allowance figure … gates its turn on | balance `−$0.60` is free-tier; same two-sided `admitRun` pin                                         | 1, 5                   |
| fails closed with a typed unavailable error when Redis is down                | the new arm keeps §Affordability 1's fail-closed contract                                            | 1                      |
| serves the next UTC day a full allowance, writing nothing to reset it         | day-keyed remaining; asserts the row set is unchanged and no new-day row exists                      | 4 (no reset job)       |

In `routes.integration.test.ts`, `GET /billing/spendable`:

| Test                                                                    | Behavior                                                              | Criterion |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------- |
| serves a free payer the day's remaining allowance, the figure their turn is gated on | the wire body: `tier:'free'`, `spendableNanoUsd:'50000000'`, `heldNanoUsd:'0'` | 1         |

### TDD evidence — each test watched red for the expected reason

1. **First test written before any implementation**, run against the tree as found:
   `AssertionError: expected 500000000n to be 50000000n`. That is the finding below.
2. The remaining six domain tests were written after the arm landed, so their red was produced
   by a controlled inversion (the arm selection forced to the paid arm), run, then the file
   restored from a byte-exact backup (`diff -q` clean). All six failed, each on its own
   assertion: `expected 'paid' to be 'free'` (×2), `expected 500000000n to be 20000000n`,
   `expected 0n to be 20000000n` (holds not read from the allowance scope), `expected false to
   be true` (the gate pin's admit-at-served leg), `expected 500000000n to be 0n`.
3. The route test's red was produced by a **faithful** reproduction of the old served amount
   (tier kept `free`, figure forced to the old `500_000_000n`), because the arm inversion also
   moved `tier` and would have failed on the wrong assertion:
   `AssertionError: expected '500000000' to be '50000000'`. Restored byte-exact.

## Self-gate

| Command                                                                                        | Result                                                    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| scoped vitest: `spendable.integration.test.ts` + `routes.integration.test.ts`, `--coverage.include=src/slices/billing/domain/spendable.ts` (one include) | pass — 85 tests; `spendable.ts` 100% stmts/branch/funcs/lines |
| `pnpm test:api`                                                                                | fail — 469 passed / 1 failed file / 1 skipped (471). The only failing file is `notifications/domain/templates/template-html.test.ts`, 7 snapshot failures. Not mine: §Known Breakage records it at HEAD, my brief names it, and it is a different slice with no import path to anything I touched. |
| `pnpm test:shared`                                                                             | pass — 132 files                                          |
| `npx turbo typecheck --force --continue` (repo)                                                | pass — 16/16, zero cached                                 |
| `npx turbo typecheck --force --filter=@hushbox/api --filter=@hushbox/shared` (after the last edit) | pass — 2/2                                            |
| `npx eslint <4 owned files>` from `apps/api`                                                   | exit 0 (after the last edit)                              |
| `npx eslint src/schemas/api/billing.ts` from `packages/shared`                                 | exit 0 (after the last edit)                              |

One lint error was found and fixed on the first pass (`unicorn/no-await-expression-member` in
the new day-keying test); both packages were re-linted after the final comment edits.

**What the api sweep does and does not establish.** §Known Breakage: a single green api sweep
is not evidence of health because the chat-integration failing set moves. This run showed zero
chat-integration failures, which I am recording as one draw, not as a clean bill. The coverage
gate was taken from the scoped run, because a red `test:api` never prints a coverage table.

**Fixture-caused-load check** (§Known Breakage's inverse case): my fixtures add `users`,
`wallets` and `allowance_spending` rows plus per-user Redis hold hashes, all keyed to
freshly-minted uuid users. Nothing I seed enters a shared pool that another suite ranks or
aggregates over — in particular no `model_catalog` row — so the catalog-percentile hazard that
entry describes does not apply here.

## Acceptance criteria

1. **The genuine spendable figure including the free-tier daily allowance, non-zero for a free
   payer with allowance remaining — met.** Served figure = the allowance scope's remaining minus
   that scope's active holds; wire-pinned at `50000000`. "Pinned at all four tiers" — see
   Deviations: **paid and free are pinned** (each two-sidedly against `admitRun`), and
   **trial/guest are unreachable at this endpoint by construction**, so there is no served
   figure to pin for them.
2. **The remaining trial message count served in the same response — NOT MET.** Evidence, in
   order:
   - `/billing/spendable` declares `routeClass('billing-token')`, which `authorizeAccess`
     admits only for `full` and `billing-only` principals; an unauthenticated caller gets 401
     (pinned by the pre-existing test "rejects an unauthenticated caller").
   - A trial user is unauthenticated. `route-class.ts:76` refuses a `trial-session` principal on
     **every** route class, by design ("their authorization happens at the realtime/media
     seams"), pinned in `lib/context/route-class.test.ts:136-147`. `chat/routes.ts`'s trial
     routes are `public` and refuse any authenticated caller.
   - So the trial count served here would reach only users who are not on trial, and never the
     audience §Trial Usage is about.
   - The counters are chat-owned (`chat/domain/trial-quota.ts`), keyed by the `x-trial-token`
     session id and the hashed client IP — neither is visible to a billing route — and the only
     existing reader (`consumeTrialQuota`) increments. A read-only peek plus a public surface
     would be new chat-slice code, which is C3's concurrent grant.
   Delivering it therefore needs (a) an architectural decision on the route class or a new
   public chat-side read, and (b) an owner outside this task. Reported rather than guessed.
3. **No client composes a funding figure from two endpoints — server half met, client half is
   E1's.** The server now serves one complete number, so nothing has to be composed. The
   composition still exists client-side: `apps/web/src/hooks/billing/use-user-tier-info.ts` /
   `use-tier-info.ts` take `freeAllowanceNanoUsd` from `GET /billing/balance` and feed it to
   `use-prompt-budget.ts` beside the spendable read. Those files are E1's Files list and E1
   already has the criterion forbidding balance-derived funding; F3 makes that removal possible
   rather than performing it.
4. **Day-keying preserved, no reset job — met.** The figure is resolved through
   `resolveBudgetScopes`, whose day key comes from the request's `now`; a new day resolves a new
   scope id with no row behind it. Pinned: after exhausting the allowance on day *d* the next
   UTC day serves the full allowance while the row set is asserted to still contain exactly the
   old day's exhausted row. Grep confirms no scheduler/cron/job touches allowance rows: the only
   writes are the settlement-time upsert in `billing/adapters/stores.ts`.
5. **Pinned against `admitRun` itself — met, and deliberately not against a re-derivation.** The
   free-arm gate pins call `admitRun` with budgets built by the same `resolveBudgetScopes` call
   the chat admission hook makes, and assert admit at exactly the served figure and
   `budget-exceeded` one nano above. The served figure and the gate share one derivation
   (`resolveBudgetScopes`) and one holds implementation (the shared `activeHolds` Lua), so this
   is a behavioural pin, not a golden cross-check of two arithmetics (Global Constraint 5).

## Deviations, with reasons

- **The plan's stated symptom is wrong in direction, and the correction matters.** F3 says a
  free payer's snapshot is `{spendable:'0', held:'0', tier:'free'}`. Verified by execution
  against the tree as found: the endpoint served **`{spendable: 500000000n, held: 0n, tier:
'free'}`** — the *paid* $0.50 cushion, because the self arm resolved the purchased wallet and
  `spendableFor` maps wallet type `purchased` → tier `paid` → `balance + cushion`. So today's
  defect is a **10× overstatement** against a 50,000,000n gate (the composer offers sends
  admission refuses), not universal greying. E1's `spendable: '0'` came from somewhere other
  than this endpoint's own output. The fix is the same either way, and the criterion stands.
- **An existing pinned expectation changed: "serves a negative spendable for an overdrawn wallet
  instead of clamping".** A purchased balance ≤ 0 is free-tier and the send path funds such a
  turn from the free wallet, so the gate for that user is the allowance, not the negative
  balance; the old test pinned served ≠ gate. It is re-pointed to
  "serves a negative spendable when holds exceed the cushion instead of clamping" (a paid
  wallet with a hold past `balance + cushion`), which keeps the no-clamping property pinned on a
  state that is still reachable, and the overdrawn case is now covered by its own free-arm test
  with a two-sided `admitRun` pin.
- **`readSelfFunding` was restructured** so the arms return unlabelled `FundingFigures` and the
  single tier derivation attaches the label. This is not required by the criteria; it removes
  the possibility of an arm returning a tier that disagrees with the arm that was chosen — the
  structural-agreement shape the plan asks for elsewhere.

## Concerns and limitations

- **Out-of-scope One-Implementation finding (not fixed, not mine):** the tier boundary exists
  twice — `getUserTier`'s `purchasedBalanceNanoUsd > 0n` (the documented single derivation,
  which my arm selection uses) and a literal `purchased.balanceNanoUsd > 0n` in
  `chat/domain/turn-context.ts:275`, which chooses the payer wallet. They agree today; if they
  ever diverge this endpoint serves figures for a wallet that will not pay. I could not collapse
  it (chat is C3's grant, and billing may not import chat). Recorded as a hidden-coupling
  comment on `readSelfFunding`, and raised.
- **Pre-existing prose defect I deliberately left alone:** `getBalanceResponseSchema`'s doc says
  "The frontend derives display and **gate** values" from `/billing/balance`, which §Affordability
  4 forbids. It is falsified by the spec, not by my change, and belongs with E1's removal of the
  balance-derived funding path.
- **`docs/BILLING.md` needs no correction for this change** — §Funding already defines free
  `effectiveBalance` as `allowance`, and §Affordability 1 already says `GET /billing/spendable`
  serves the payer's numbers. The doc was right; the code was not. (§Trial Usage's "the
  remaining message count is presented before it binds" remains unimplemented, per criterion 2.)
- The free arm reads Postgres for the allowance and Redis for its scope holds; the paid arm's
  Redis snapshot bootstrap is skipped for free payers, so a free payer's read no longer
  write-throughs their purchased-wallet snapshot. Nothing depends on that side effect (admission
  bootstraps its own snapshot on miss), but it is a behaviour change worth naming.

## What E1 must call, and what it gets back

Unchanged call, unchanged types — only the value is now correct:

```ts
useSpendable(conversationId?)  →  GET /billing/spendable?conversationId=<uuid>
// GetSpendableResponse (packages/shared/src/schemas/api/billing.ts), unchanged shape:
{ spendableNanoUsd: NanoUSD-string, heldNanoUsd: NanoUSD-string,
  tier: 'trial'|'guest'|'free'|'paid', payer: 'self'|'owner' }
```

- `spendableNanoUsd` is the payer's whole hold-aware funding number **at every tier this
  endpoint serves**: paid → purchased balance + $0.50 cushion − wallet holds; free (a purchased
  balance ≤ 0) → the day's remaining allowance − that scope's holds; owner-funded group →
  unchanged from F1. E1 must **not** branch on `tier` to assemble it, and must not read
  `GET /billing/balance` for `freeAllowanceNanoUsd` — that is now the second source the
  criterion forbids.
- `effectiveBalance = spendableNanoUsd + heldNanoUsd` remains the identity for the `affordable`
  set at every tier, including free (§Funding).
- `tier` is the payer's and is authoritative — a free payer's response now carries a free-tier
  figure with the free-tier label, so `getTurnOptions` sized from it returns a real
  `sendable: true` for a free user with allowance remaining.
- The value may be negative (holds exceeding the funds behind it); it is never clamped.
- Trial and guest are **not** served by this endpoint (401 for an unauthenticated caller): E1's
  existing client-side fixed-ceiling arm for those tiers is unchanged, and the remaining trial
  message count still reaches no client — E1's third blocker is **not** cleared.

## Confidence

**High** on the free-tier funding number: red observed first against the real code, the served
figure pinned two-sidedly against `admitRun` at both reachable tiers, 100% coverage on the
changed file, repo typecheck and both scoped suites green, and the one red file is the
documented foreign one.

**Not applicable / blocked** on the trial-count criterion: not attempted, evidence for why in
§Criterion 2.
