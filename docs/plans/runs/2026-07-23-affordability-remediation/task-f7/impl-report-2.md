# F7 — impl report 2 — DONE_WITH_CONCERNS

## Objective

Price the turn's `minTurnCost` in the route, above the payer freeze, and pass it into
`resolveTurnContext` as a required argument, so a member whose group headroom is positive but
too small falls through to their own funds instead of being frozen to the owner and then
refused by admission — permanently.

Delivered for **text turns** (single and multi-model, the criterion's shape). **Two turn
shapes ship with the exemption declared in a type and raised**: media (per-unit) and the
Smart Model slot. Both are blocked on ownership, not on design — details below.

## Files changed

| Path                                                                | Why                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/affordability/min-turn-cost.ts` (new)          | The one `minTurnCost` producer, composing §Math & Terms terms; no formula restated.                                  |
| `packages/shared/src/affordability/min-turn-cost.test.ts` (new)     | By-amount pins plus the biconditional.                                                                               |
| `packages/shared/src/affordability/index.ts`, `src/index.ts`        | Publish it on both entry points (the identity pin compares the two barrels' bindings).                              |
| `packages/shared/src/affordability/billing/funding-decision.ts`     | Field rename `turnEstimateNanoUsd` → `minTurnCostNanoUsd`; the violation comment removed, not amended.               |
| `packages/shared/src/affordability/billing/client-billing.ts`       | Header corrected (the two sides no longer disagree; the client passes no group dimension) + the renamed field.       |
| `apps/api/src/slices/chat/domain/turn-context.ts`                   | `TurnMinCost` union + required seam argument; the duplicated violation paragraph removed; `resolvePayerWallet` docs. |
| `apps/api/src/slices/chat/domain/index.ts`                          | Publishes `TurnMinCost` / `UnpricedTurnReason` and re-exports `pickEffortClassifier` for the route.                  |
| `apps/api/src/slices/chat/routes.ts`                                | Hoists the catalog read above the freeze, prices `minTurnCost`, passes it; kill-switch read now conditional.         |
| `apps/api/src/slices/billing/domain/spendable.ts`                   | Renamed field + the paragraph claiming the client applies priority 1 itself.                                         |
| `apps/web/src/hooks/billing/use-resolve-billing.ts`                 | Header corrected (same falsified claim).                                                                             |
| `apps/api/src/slices/chat/domain/runtime.ts`                        | One phrase: "positive headroom froze the OWNER" is no longer true. **Outside the plan's file list — see Deviations.** |
| tests: `turn-context.test.ts`, `turn-context.integration.test.ts`, `turn-definition.integration.test.ts`, `routes.integration.test.ts`, `funding-decision*.test.ts`, `client-billing.test.ts` | New pins, the required argument, the field rename, and two corrected fixtures. |

## Tests added

| Test                                                                                           | Behavior                                                       | Criterion                    |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------- |
| routes: `charges the SENDER when the group headroom is positive but cannot cover the turn`     | Route-level: member with 1 nano of headroom + own wallet sends, run body's payer is the sender | Red first; server passes a real minimum |
| routes: `still charges the OWNER when the headroom covers the turn`                            | The other branch, same seeder                                   | Both branches pinned         |
| routes: `DENIES a guest whose owner headroom is positive but cannot cover the turn`            | 403 `GROUP_BUDGET_EXHAUSTED`                                    | Guest refused on the same boundary |
| turn-context: `falls a member through to their OWN wallet when the headroom cannot cover the turn` | Seam-level payer + wallet + the frozen minimum                | Server passes a real minimum |
| turn-context: `funds the OWNER when the headroom exactly covers the minimum`                   | The boundary is inclusive                                       | Both branches pinned         |
| turn-context: `DENIES a link-guest turn whose headroom is positive but below the minimum`      | Guest never falls through                                       | Guest refused                |
| turn-context: `leaves the comparison inapplicable for a turn shape that carries no minimum`    | An unpriced shape keeps `headroom > 0`                          | The typed exemption is real  |
| min-turn-cost: six by-amount pins                                                              | Input tokens, input storage, non-persisting, non-paid ratios, classifier reserve, web search, mandatory-reasoning floor | Priced at the `eligible` corner |
| min-turn-cost: `the biconditional` × 3 × 6 cases                                               | funding = minTurnCost ⇒ every sibling eligible; −1 nano ⇒ not; the hold it buys ≤ it | The biconditional pin |

## The reds, watched

**Route level** (the criterion's own scenario), before the route priced anything:

```
FAIL  |api| src/slices/chat/routes.integration.test.ts > chat route: the payer freeze compares
      the turn minimum > charges the SENDER when the group headroom is positive but cannot cover the turn
AssertionError: expected '019faf20-ec68-73b6-…' to be '019faf20-ec71-7f8a-…'
 ❯ src/slices/chat/routes.integration.test.ts:2138  expect(captured[0]?.userId).toBe(sender);
```

The received id is the conversation owner: the freeze resolves owner-or-sender and nothing
else, and the same scenario at seam level names it in words —

```
FAIL  |api| src/slices/chat/domain/turn-context.test.ts > falls a member through to their OWN
      wallet when the headroom cannot cover the turn
AssertionError: expected 'owner-9' to be 'u1'
```

**Guest, same boundary:** `AssertionError: expected 201 to be 403` — the guest was admitted as
owner-funded where the doc refuses it.

The seam-level reds were taken by temporarily replacing `comparableNanoUsd(args.minTurnCost)`
with `undefined` in `turn-context.ts` (both call sites), running, then restoring from a
byte-exact copy (`diff` clean, re-run green). No background suite was in flight.

## The biconditional, and one deviation from the doc's literal formula it forced

`headroom ≥ minTurnCost` ⇒ the ceiling solve leaves every sibling eligible ⇒ the hold priced
against those ceilings is ≤ headroom ⇒ admission's group scope passes. `headroom = minTurnCost
− 1n` ⇒ a sibling is ineligible. Both directions are pinned over six shapes, and the middle
step runs the **production** path (`budgetBuysTokens` → `ceilingTokens` → `eligible` →
`costNanoUsd`) rather than restating it.

**§Math & Terms' literal `Σᵢ (B(mᵢ, e_min) + MINIMUM_OUTPUT_TOKENS) × variableRate(mᵢ)` is not
sufficient for a multi-sibling turn, and the producer uses the widest corner instead.** The
siblings share ONE token count `T`, so `T` must reach the WIDEST corner; the per-sibling sum
is a rate-weighted average of the corners, which is below the widest one whenever the corners
differ (a mandatory-reasoning sibling beside an ordinary one). Measured, not argued: a
throwaway probe computed the doc's sum form for `[ordinary, mandatory-reasoning]` and asserted
`everySiblingEligible === false` at exactly that figure — it passed, then was deleted. With one
sibling the two readings are the same number, so nothing else moves. **This is a candidate
`BILLING.md` correction and is raised.**

## Self-gate

| Command                                                                       | Result                                |
| ------------------------------------------------------------------------------ | -------------------------------------- |
| `pnpm test:shared` (the named scoped check, coverage gate included)            | **pass** — 133 files, exit 0          |
| `vitest run src/slices/chat src/slices/billing` (api, isolated — `test:api` is forbidden this run) | **pass** — 76 files / 1440 tests   |
| `vitest run src/slices/chat` + `--coverage.include=src/slices/chat/routes.ts` | **pass** — 821 tests; 97.11 stmts / 95.29 branch / 100 funcs / 100 lines |
| same, `--coverage.include=…/turn-context.ts`                                  | **pass** — 100 / 100 / 100 / 100      |
| shared, `--coverage.include=…/min-turn-cost.ts`                               | **pass** — 100 / 100 / 100 / 100      |
| shared, `--coverage.include=…/billing/funding-decision.ts`                    | **pass** — 100 stmts                  |
| shared, `--coverage.include=…/billing/client-billing.ts`                      | **pass** — 100 / 96.42 (line 205, pre-existing; I changed comments and one field name there) |
| `npx turbo typecheck --force --continue`                                       | **pass** — 16/16, 0 cached            |
| `pnpm arch:check`                                                              | **pass** — 13 rules over 2189 files   |
| `eslint <owned files>` from `packages/shared`, `apps/api`, `apps/web`, after the last edit | **pass** — exit 0 each (two prettier errors found and fixed first) |

Coverage reports were written to a scratch directory outside each package's own `coverage/`.

**Two failures attributed outward, both re-run in isolation:**

- `chat/domain/regenerate.integration.test.ts` — `expected 'failed' to be 'succeeded'` on two
  tests during two coverage-instrumented runs. Passes in isolation (`Tests 2 passed`), and it
  is the named `regenerate succeeded→failed` member of §Known Breakage's moving set.
- `routes.integration.test.ts` — `expected 400 to be 201` for "returns a run handle (201) for a
  member with a purchased wallet" on one run. Also a named member of that set (`POST /chat`
  `201→400`); the same file ran 202/202 twice before and 821/821 after.

Neither reproduces deterministically and neither touches a catalog fixture I added (I added no
catalog row; the two fixtures I changed raise budget amounts on rows they create themselves).

## Acceptance criteria

| Criterion                                                    | Status | Evidence                                                                                                     |
| ------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| Red first: member with too-small headroom sends, charged to self | **met** (text turns) | Both reds above; green at route and seam level.                                                  |
| The server passes a real `minTurnCost` into the shared decision | **met** (text turns) | `routes.ts` prices it above the freeze from the hoisted catalog; the seam takes it as a required argument. |
| No second funding implementation                             | **met** | The producer is one shared function composing existing §Math & Terms terms; `apps/api` composes nothing.       |
| Both branches pinned                                         | **met** | Owner-funded at the inclusive boundary, self-funded one nano below, at both levels.                          |
| Fall-through priced at the sender's tier                     | **met, without a second evaluation** | Verified in code: `tierForFunding(budget.funding)` (`turn-definition.ts:176`) drives every downstream sizing, and `budget.funding` is the wallet the freeze chose. |
| Guest still refused on the same boundary                     | **met** | 403 `GROUP_BUDGET_EXHAUSTED` at route level, `forbidden` + wireCode at seam level.                            |
| `funding-decision.ts` violation comment removed              | **met** | Removed, not amended; the second copy in `client-billing.ts`, the third in `turn-context.ts`, the fourth in `use-resolve-billing.ts`, plus `spendable.ts` and a fifth in `funding-decision.contract.test.ts` found by the vocabulary sweep. |
| Field renamed `turnEstimateNanoUsd` → `minTurnCostNanoUsd`   | **met** | Repo-wide: zero occurrences of the old name outside build artifacts.                                          |
| §Notices 5 disclosure                                        | n/a    | Removed from this task (F13).                                                                                 |
| **Media turns**                                              | **not met — typed exemption** | `{ kind: 'unpriced', reason: 'media-per-unit' }`; see Concerns.                                 |
| **Smart Model turns**                                        | **not met — typed exemption** | `{ kind: 'unpriced', reason: 'smart-slot-pool' }`; see Concerns.                                |

## The catalog read

Before: a paid send made **two** whole-table reads — `findAdminDisabledModel` →
`readLatestDescriptorRows`, and the turn build → `listDescriptors` → `readLatestDescriptorRows`.

After: the hoisted `listDescriptors` serves both the pricing and the kill-switch decision, and
`findAdminDisabledModel` is reached **only when a selected id is absent from the exposed set**
(`selectionFullyExposed`). Exposure filters on `adminDisabledAt IS NULL`, so an id present in
the exposed snapshot cannot be disabled — the raw read can only distinguish an *absent* id's
two causes, which is the only question that gate answers. So a send naming exposed models makes
the same two reads it made before; only a send naming an unexposed id pays a third, and that
send is refused. The `MODEL_DISABLED` route tests (paid, multi-model, guest, regenerate, trial)
are unchanged and green.

## Deviations

1. **The widest-corner form instead of the doc's per-sibling sum** — argued and measured above.
2. **Two files edited outside the plan's list.** `apps/api/src/slices/chat/domain/index.ts`
   (re-export `pickEffortClassifier`, needed by `routes.ts`, which may import only its own
   barrel) and `apps/api/src/slices/chat/domain/runtime.ts` (one phrase whose truth my change
   removed). Neither changes behavior.
3. **Two integration fixtures corrected.** `seedOwnerFundedGroup` and `seedOwnerFunding` seeded
   group caps of `1_000_000n`; the turn they send has a minimum of **1_127_072n** at the paid
   tier (measured for this fixture's prompt: 1,744 chars, rates 2/3 nano). Those fixtures were
   claiming owner funding with an amount that cannot fund the turn, so six tests flipped to
   self-funded/refused. Raised to `10_000_000n` (what `seedPurchasedWallet` already uses) with
   the reason recorded in each seeder's docstring. **This is the defect the task fixes, visible
   in the test data: those sends were being admitted at the route and would have been refused at
   admission.**
4. **A minor ordering change**: the catalog read now precedes the membership/conversation checks
   inside `resolveGatedTurnContext`, so a caller who is both a non-member and hitting a broken
   catalog now gets the catalog's 503 rather than 403. Same errors, same codes, different order
   on one impossible-in-practice overlap.
5. `apps/web` tests were not run (the brief forbids `pnpm test:web`). The only web change is a
   comment; lint and repo-wide typecheck cover it.

## Concerns and limitations

- **Smart Model turns keep the old degenerate comparison.** §Smart Model 5's threshold is
  shipped and published (`smartModelMinimumRequiredNanoUsd`), exactly as the brief says — but
  calling it needs `SmartModelPoolCandidate[]`, and the two functions that build that list from
  catalog descriptors (`isEngineTextModel`, `toPoolCandidate`) are **private to
  `apps/api/src/slices/models/domain/smart-model-candidates.ts` and absent from both models
  barrels**. Re-deriving either in `routes.ts` is the banned second implementation: if the
  projection drifted, the threshold and the candidate set would disagree and the biconditional
  (client refusal ⇔ server refusal) would break. The fix is ~3 lines in a file I do not own —
  one exported `smartModelMinimumNanoUsd(descriptors, promptInputTokens, storage)` plus its two
  barrel entries — after which `turnMinCost`'s smart arm is one call.
- **Media turns keep it too.** A media turn's minimum is its deterministic per-unit estimate, as
  the brief says. `mediaCallUsageFor` is on the models barrel, but the storage leg
  (`estimateMinMediaOutputBytes` / `mediaStorageBytesFor`) lives in
  `models/domain/estimate-run.ts` — **D3's file, explicitly out of bounds** — and is not on the
  barrel either. Composing the byte estimate in `routes.ts` would be the same banned duplicate.
- Both exemptions are `TurnMinCost` union members with their reason in the type, so they are
  visible to the compiler and to the next reader rather than silently `undefined`.
- **The classifier-reserve term rides "may run", not "did run":** it is included exactly when
  `reasoningEffort === 'auto'`, which is the only selection that can buy a pinned-model
  classifier. §Reserve ⟺ classify states the reserve on *may* run, so this follows the doc, but
  it over-states `minTurnCost` by ~0.1¢ on an `auto` turn whose effort ladder collapses to one
  option — a band in which a member could be sent to personal funds where the owner could in
  fact have paid. Small, deliberate, and stated rather than hidden.
- `minTurnCost` prices the **`e_min` corner**, per the doc. A user who pins a high effort can
  therefore clear the comparison and still be refused for that effort — a feasibility refusal
  the option sets already grade, not the permanent-payer refusal this task removes.
- `routes.ts` sits at 95.29% branch coverage: above the gate, with the same thin margin it had
  before. Two of my branches are `v8 ignore`d with reasons (an unreachable non-empty narrowing,
  and a line-item's optional amount).

## Confidence

**High** on the text path: the defect reproduced at both levels, the fix is green at both, the
biconditional is pinned in both directions, and the fixture flip corroborates the diagnosis
independently. **High** on the two exemptions being ownership-blocked rather than design-blocked
(both barrels read directly). **Medium** on the widest-corner deviation being the right
resolution rather than a doc correction someone else should rule — the arithmetic is measured,
but it contradicts a normative formula.
