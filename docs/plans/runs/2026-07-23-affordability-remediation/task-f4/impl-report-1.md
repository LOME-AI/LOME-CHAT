# F4 — impl report 1

## Objective

Serve a link guest its payer's funding truth through a guest-reachable read produced by the
same producer the admission gate uses, and stop the composer refusing sends the server
already accepts.

## Files changed

### apps/api

| Path | Why |
| --- | --- |
| `src/slices/billing/domain/spendable.ts` | `FundingSnapshot.tier` → `payerTier`; new `readGuestFundingSnapshot` (the guest arm, over the existing `ownerSnapshot` producer); new narrowed `GroupFundingDeps` so the conversations slice can call it with the budget-store subset it already composes; corrected the now-false comment claiming a link guest never reaches this file. |
| `src/slices/billing/domain/spendable.integration.test.ts` | Guest-arm tests, including the two-sided `admitRun` pin; `tier` → `payerTier` in existing assertions. |
| `src/slices/billing/domain/index.ts` | Publishes `readGuestFundingSnapshot` + `GroupFundingDeps`. |
| `src/slices/billing/index.ts` | Same two through the slice barrel (plus `FundingSnapshot`, which the conversations slice's caller needs). |
| `src/slices/billing/routes.ts` | One field: `/billing/spendable` serves `payerTier`. |
| `src/slices/billing/routes.integration.test.ts` | Wire-shape and tier assertions renamed to `payerTier`. |
| `src/slices/conversations/domain/guest-funding.ts` | **New.** The guest funding read: authorize, resolve whose facts, delegate the money to billing. Computes no money itself. |
| `src/slices/conversations/domain/index.ts` | Publishes `getGuestFunding` + its view/deps types. |
| `src/slices/conversations/routes.ts` | `GET /:conversationId/funding`, `public`-classed, through the existing `authorizeCaller` seam. |
| `src/slices/conversations/domain/budgets.integration.test.ts` | The route's authorization matrix and the fail-closed domain guard. |
| `src/slices/conversations/routes.integration.test.ts` | `usageRecords.userId` → `payerUserId` in one seed helper (**orchestrator-granted**; F8's column rename, my file). |
| `src/slices/chat/domain/turn-ceiling.clamp-order.test.ts` | `FundingSnapshot` literal renamed (**orchestrator-granted**; my rename reached it, no sibling owns it). |

### packages/shared

| Path | Why |
| --- | --- |
| `src/affordability/turn-types.ts` | `FundingSnapshot.tier` → `payerTier`, with the two-axes reason and the closed-union reason recorded. |
| `src/affordability/turn-options.ts` | Reads `funding.payerTier`. |
| `src/affordability/estimate/pre-adapters.ts` | `getEffectiveBalanceNano` now takes `Exclude<UserTier, 'guest'>` — the guest arm is deleted at the type level, not branched away. |
| `src/affordability/billing/client-billing.ts` | Deleted the tier-keyed guest denial; a guest's served figure now enters the shared core as the group headroom, so its denial arrives as `GROUP_BUDGET_EXHAUSTED`; deleted the dead `group` field from `ClientBillingInput`; `payerSizingTier` now always routes through the core. |
| `src/schemas/api/billing.ts` | Wire field `tier` → `payerTier`; the shape's doc names both doors. |
| `src/schemas/api/billing.test.ts` | Wire assertions renamed. |
| `src/affordability/billing/client-billing.test.ts` | New guest arms; deleted the `resolveClientBilling` group describe (unconstructible after the `group` deletion); re-pointed the sizing-tier agreement pin at the guest. |
| `src/affordability/billing/client-billing.consistency.test.ts` | Guest cases re-expressed through the served figure; group describe deleted; the delegated-budget cases moved onto the guest, the one caller that can still resolve `owner`. |
| `src/affordability/billing/funding-decision.contract.test.ts` | Typed against `ClientFundingContext`; guest rows now carry their headroom in `spendableNanoUsd`. |
| `src/affordability/estimate/pre-adapters.test.ts` | The trial-only ceiling assertion. |
| 10 × `src/affordability/turn-*.test.ts`, `classifier-choice.test.ts` | `FundingSnapshot` literals renamed. |

### apps/web

| Path | Why |
| --- | --- |
| `src/hooks/billing/use-spendable.ts` | Two doors, one shape, one cache entry: a link guest reads the conversation's guest funding route, everyone else `/billing/spendable`. New exported `hasServedFunding` — the single predicate behind `enabled` and every caller's pending gate. |
| `src/hooks/billing/use-turn-options.ts` | Reads `payerTier`; the no-door fallback is trial-only; the pending gate covers a guest; exposes `payerSpendableNanoUsd` off the same snapshot. |
| `src/hooks/billing/use-budget-calculation.ts` | Reads `payerTier`; trial-only client-side ceiling; loading gate covers a guest. |
| `src/hooks/billing/use-resolve-billing.ts` | Takes a required `conversationId` and reads the conversation-scoped snapshot — the second cache entry is gone; `group` deleted. |
| `src/hooks/billing/use-prompt-budget.ts` | A link guest is not a "group member", so the session-only `/budgets` read no longer fires (and no longer holds the composer pending); guest money refusals are re-voiced through `guestMoneyRefusal`; passes the conversation to the resolver. |
| `src/hooks/models/use-model-validation.ts`, `use-resolve-default-model.ts` | Read `payerTier`. |
| 7 web test files | Guest-door / guest-composer pins, `payerTier` fixtures, and the `hasServedFunding` mock export the deeper read now requires. |

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `spendable.integration` — serves the owner as payer, at the owner's tier | The guest's snapshot names `payer: 'owner'` and the owner's tier | guest-reachable read returns the payer snapshot; `payerTier` is the payer's |
| — serves the link's hold-aware remaining as the guest's spendable | The figure is the group's clamped remaining | same producer |
| — serves an unallocated link zero spendable, never unlimited | Absent allowance ⇒ `0n` | fail-closed spend bound |
| — **serves the figure admission gates the guest turn on** | estimate = served ⇒ admitted; +1n ⇒ refused | two-sided `admitRun` pin |
| — reports an active member-scope hold as held | `spendable + held` is the hold-blind remaining | hold-awareness matches admission |
| — fails closed on Redis down | typed `unavailable` | matches admission |
| `budgets.integration` — serves an active guest its payer's snapshot | 200 + exact wire body | `public`-classed guest-reachable read |
| — serves an unallocated link zero spendable, still naming the owner as payer | payer is structural | `payer` union stays closed at two |
| — refuses a guest pointing its credential at another conversation | 404 | wrong conversation refused |
| — refuses a revoked link / an expired link | 401 | existing revocation predicate, not a second one |
| — refuses a departed guest whose link is still live | 404 | active-member gate |
| — refuses an anonymous request | 401 | credential gate |
| — refuses a full session | 403 | one handler, one principal |
| — fails closed when the conversation is gone | domain guard | fail-fast |
| `client-billing` — funded guest ⇒ `owner_balance`, never denied | the denial comes from a comparison, not the tier | tier-keyed denial DELETED |
| — guest on a premium model, funded link, not tier-locked | premium is the payer's | §User Tiers |
| — **guest never takes the trial per-message ceiling** | 50¢ estimate on a 90¢ link approves | no-endpoint fallback is trial-only |
| — guest whose figure cannot cover ⇒ `guest_budget_exhausted` | copy is "ask the owner", no payment path | §Notices 3 |
| `deriveClientFundingInputs` — carries the guest's served figure as group headroom | `isSolo:false`, `isGuest:true`, `callerOwnPurchasedBalanceNanoUsd: 0n` | one number, not a group blob |
| `use-spendable` — guest reads the conversation door, never the billing-token route | + the billing route is not called | different route, not a second derivation |
| — guest does not fetch outside a conversation | no payer without one | no permanent-pending trap |
| `use-turn-options` — sizes the guest from the payer's figure, not the trial ceiling | ceiling > 100k tokens where the trial ceiling buys ~8k | composer's snapshot is the served one |
| — grades premium on the payer's tier | owner-funded guest sees what the owner sees | §Group Funding 1 |
| — withholds the verdict while the guest read is in flight | nothing fabricated | "nothing is fabricated when the query has not resolved" |
| `use-prompt-budget` — **does not block a funded guest from sending** | `hasBlockingError === false` | the shipped regression |
| — never fires the session-only budgets read for a guest | `useConversationBudgets(null)` | dead 403 request gone |
| — unallocated guest ⇒ `guest_no_group_budget` (no "Add credit") | | §Notices 3 |
| — owner cannot cover ⇒ `group_owner_funds_unavailable` (no "Add credit") | | §Notices 3 |
| `use-resolve-billing` — reads the conversation-scoped snapshot | `useSpendable('conversation-1')` | one funding read per composer |
| — guest whose payer covers ⇒ `owner_balance` | | owner funding via the served figure |

## The four required reds, verbatim

**Red 1 — the funding read with no guest arm** (`pnpm test:watch apps/api/src/slices/billing/domain/spendable.integration.test.ts`, exit 1, 6 failed / 40 passed):

```
 FAIL  |api| src/slices/billing/domain/spendable.integration.test.ts > readGuestFundingSnapshot — a link guest is served its payer (BILLING §Group Funding 1, 6) > serves an unallocated link zero spendable, never unlimited
TypeError: readGuestFundingSnapshot is not a function
 ❯ src/slices/billing/domain/spendable.integration.test.ts:665:26
    663|   it('serves an unallocated link zero spendable, never unlimited', asy…
    664|     const seeded = await seedFundedLink({ linkAllowanceNanoUsd: 0n });
    665|     const served = await readGuestFundingSnapshot(deps, {
       |                          ^
```

**Red 2 — the route that does not exist** (`pnpm test:watch apps/api/src/slices/conversations/domain/budgets.integration.test.ts`, exit 1, 6 failed / 23 passed):

```
 FAIL  … > the link guest's funding read (BILLING §Group Funding 1, 6) > serves an active guest its payer's snapshot
AssertionError: expected 404 to be 200 // Object.is equality
 FAIL  … > refuses a revoked link
AssertionError: expected 404 to be 401 // Object.is equality
 FAIL  … > refuses an expired link
AssertionError: expected 404 to be 401 // Object.is equality
 FAIL  … > refuses an anonymous request carrying no credential at all
AssertionError: expected 404 to be 401 // Object.is equality
 FAIL  … > refuses a full session — a caller with a wallet reads its own funding door
AssertionError: expected 404 to be 403 // Object.is equality
```

**Red 3 — `resolveClientBilling` denying on tier alone** (`pnpm test:watch packages/shared/src/affordability/billing/client-billing.test.ts`, exit 1, 3 failed / 37 passed):

```
 FAIL  |shared| … > guest whose served payer figure covers the estimate → owner_balance, never denied
AssertionError: expected { fundingSource: 'denied', …(1) } to deeply equal { fundingSource: 'owner_balance' }
 FAIL  |shared| … > guest selecting a premium model on a funded link is not tier-locked
AssertionError: expected { fundingSource: 'denied', …(1) } to deeply equal { fundingSource: 'owner_balance' }
 FAIL  |shared| … > guest never takes the trial per-message ceiling
AssertionError: expected { fundingSource: 'denied', …(1) } to deeply equal { fundingSource: 'owner_balance' }
```

**Red 4 — the composer's `hasBlockingError`** (`pnpm test:watch apps/web/src/hooks/billing/use-prompt-budget.test.ts`, exit 1, 4 failed / 57 passed):

```
 FAIL  |web| … > link guest — the composer must not refuse a send the server accepts > does not block a funded guest from sending
AssertionError: expected true to be false // Object.is equality
 FAIL  |web| … > never fires the session-only budgets read for a guest
AssertionError: expected "vi.fn()" to be called with arguments: [ null ]
 FAIL  |web| … > refuses an unallocated guest with the ask-the-owner reason, never a payment path
AssertionError: expected 'insufficient_funds' to be 'guest_no_group_budget' // Object.is equality
 FAIL  |web| … > refuses a guest whose payer cannot cover with the owner's-budget reason
AssertionError: expected 'prompt_too_long' to be 'group_owner_funds_unavailable' // Object.is equality
```

### Reds observed by controlled inversion (pins written alongside their implementation)

Three later pins could not be watched red in sequence because the behaviour they name landed
with an earlier pin in the same file. Each was verified by inverting the source with a
byte-exact backup, no background suite in flight, and `diff` confirming exact restoration:

- `use-spendable.ts`, `isLinkGuest` forced `false` ⇒ **"reads the payer's snapshot from the conversation, never the billing-token route"** fails (1 failed / 11 passed). `RESTORED_EXACT`.
- `use-turn-options.ts`, pending gate reverted to `input.isAuthenticated && isServedPending` ⇒ **"withholds the verdict while the guest funding read is in flight"** fails (1 failed / 28 passed). `RESTORED_EXACT`.
- `use-turn-options.ts`, `fundingSnapshotOf` forced onto the fallback ⇒ 9 tests fail including the guest sizing pin. `RESTORED_EXACT`.

## Evidence for the specific items requested

### The two-sided pin against `admitRun`, by file:line

`apps/api/src/slices/billing/domain/spendable.integration.test.ts:671–723`, test
`serves the figure admission gates the guest turn on`:

- `:677` reads the served snapshot through `readGuestFundingSnapshot`;
- `:694` `estimateNanoUsd: served.spendableNanoUsd + 1n` ⇒ `{ admitted: false, reason: 'budget-exceeded' }`;
- `:704` `estimateNanoUsd: served.spendableNanoUsd` ⇒ `admitted === true`.

### One producer, not two derivations

`apps/api/src/slices/billing/domain/spendable.ts:433–439`:

```ts
export function readGuestFundingSnapshot(
  deps: GroupFundingDeps,
  args: { readonly conversation: ConversationFundingFacts; readonly now: Date }
): ResultAsync<FundingSnapshot, DomainError> {
  return readGroupFunding(deps, args.conversation, args.now).map((group) => ownerSnapshot(group));
}
```

`ownerSnapshot` and `readGroupFunding` are the **same** two functions the owner-funded arm of
`readFundingSnapshot` calls (`spendable.ts:497`, inside `readFundingSnapshot`). The guest path
adds no arithmetic: `guest-funding.ts` only serializes what comes back. A different route, the
same derivation.

### Where the tier-keyed guest denial used to live — gone, not bypassed

It was `packages/shared/src/affordability/billing/client-billing.ts`, in `resolveSelfFunding`:

```ts
  if (tier === 'guest') {
    return { fundingSource: 'denied', reason: 'guest_budget_exhausted' };
  }
```

Repo-wide grep for `tier === 'guest'` in `apps/` and `packages/` (excluding `node_modules`,
`dist`) returns **zero hits**. A guest now reaches the core as a non-solo funder
(`deriveClientFundingInputs`, guest branch), so its denial is the core's
`GROUP_BUDGET_EXHAUSTED` — the same value the server's path produces.

### No guest code path can reach the trial `$0.01` ceiling

`getEffectiveBalanceNano(tier: Exclude<UserTier, 'guest'>, …)`. Every production call site,
by grep:

- `apps/web/src/hooks/billing/use-budget-calculation.ts:100` — `getEffectiveBalanceNano('trial', 0n, 0n)`
- `apps/web/src/hooks/billing/use-turn-options.ts` (`trialFunding`) — `getEffectiveBalanceNano('trial', 0n, 0n)`

Both pass the literal `'trial'`. There is no call site taking a tier variable, so no value can
route a guest into it, and a future one would be a compile error rather than a silent
conflation. `TRIAL_FIXED_COST_CAP_NANO_USD` in `client-billing.ts` is guarded by the same
structure: the guest branch returns from the core before `resolveSelfFunding`, and the pin
`guest never takes the trial per-message ceiling` (50¢ estimate, 90¢ link ⇒ `owner_balance`)
goes red the moment that stops being true.

### Before / after for a guest's two refusals

| Condition | Before | After | Offers "Add credit"? |
| --- | --- | --- | --- |
| Composer, any state | `hasBlockingError: true` — no send possible at all | Verdict follows the served figure | — |
| Zero allocation | `insufficient_funds` → *"Your balance can't cover this message. **Add credit**, or choose a more affordable model."* | `guest_no_group_budget` → *"No budget is allocated to you in this conversation. Ask the conversation owner to allocate some."* | **No** (asserted in test) |
| Owner cannot cover | `insufficient_funds` (same "Add credit" copy) | `group_owner_funds_unavailable` → *"The conversation owner's budget can't cover this message. Ask the conversation owner for budget, or try again shortly."* | **No** (asserted in test) |

Both copies existed and were unreachable; both are now reachable and pinned by
`noticeText(...)` assertions that the string does not contain `Add credit`.

### The dead `group` parameter and the dead `/budgets` request

- `ClientBillingInput` no longer declares `group`. Grep for `group:` under
  `apps/web/src/hooks/billing` and `packages/shared/src/affordability/billing` returns hits only
  in `ClientFundingContext` (see Concerns) and its own tests — none on `ClientBillingInput` and
  none in any production call.
- `useResolveBilling` no longer accepts `group`; its input is
  `{ estimatedMinimumCostNanoUsd, isPremiumModel, isAuthenticated, conversationId }`.
- `resolveIsGroupMember` returns `false` for a link guest, so
  `useConversationBudgets(resolveGroupBudgetArgument(...))` receives `null` and the query is
  disabled. Pinned by `never fires the session-only budgets read for a guest`
  (`expect(mockUseConversationBudgets).toHaveBeenCalledWith(null)`), which was red before.

### One funding read per composer

`useResolveBilling` previously called `useSpendable()` with no argument while
`useTurnOptions` and `useBudgetCalculation` passed the conversation — two cache entries for
one payer. `conversationId` is now **required** on `UseResolveBillingInput` (not optional:
omitting it does not ask a simpler question, it asks the wrong one), and
`use-prompt-budget.ts` passes `conversationScope(input.conversationId)` to all three.
Pinned by `reads the funding snapshot scoped to the conversation that names the payer`.

## Self-gate

All gates below were re-run from scratch **after** the stack restart the orchestrator flagged,
and after my last edit. Statuses captured on the command itself, written to their own files.

| Command | Result |
| --- | --- |
| `pnpm test:shared` | **pass** — exit 0, 132 files / 3191 tests |
| `pnpm test:web` | **pass** — exit 0, 396 files / 6459 tests (coverage gate included) |
| `pnpm test:api` | **fail** — exit 1, 7 files / 22 tests. See attribution below. |
| `npx turbo typecheck --force --continue` (repo-wide) | 16/16 at the start of the final sweep; a later run showed 5 errors in `chat/domain/settlement.ts` + its tests (a sibling's in-flight edit, never mine); re-running `--filter=@hushbox/api --force` after that settled returned **exit 0** |
| `eslint` from `apps/api`, over my 12 owned files | **exit 0** (run after the last edit) |
| `eslint` from `apps/web`, over my 17 owned files | **exit 0** (run after the last edit) |
| `eslint` from `packages/shared`, over my 21 owned files | **exit 0** (run after the last edit) |
| Scoped coverage, `guest-funding.ts` (one `--coverage.include`) | **exit 0** after adding the fail-closed guard test; the table listed exactly that file |
| My owned api suites (`slices/conversations`, `spendable.integration`, `turn-ceiling.clamp-order`) | **pass** — exit 0, 44 files / 778 tests |

### `pnpm test:api` failure attribution

I fixed the one that was mine and left the rest:

| File | Cause | Mine? |
| --- | --- | --- |
| `billing/routes.integration.test.ts` | asserted the wire field `tier` | **Yes — fixed.** Re-run: 45 passed, exit 0 |
| `billing/routes-usage.integration.test.ts` | usage-record reads return `[]` / `0` after the `userId` → `payerUserId` rename | No — F8 |
| `chat/domain/runtime.integration.test.ts` | admission decision shape (`admitted: true` vs `false`) | No — F8 (named territory) |
| `chat/domain/settlement.integration.test.ts` | member-budget row expected `null` | No — F8 |
| `chat/routes.integration.test.ts` | `400` vs `201` + `model-catalog test lock: timed out acquiring` | No — F5's file; the lock timeout is also a §Known Breakage entry |
| `identity/routes-email-verification.integration.test.ts` | §Known Breakage (orphan `email=''` row / collection failure) | No |
| `notifications/domain/templates/template-html.test.ts` | §Known Breakage, verbatim entry | No |

Per §Known Breakage I checked my own diff for the inverse case first: I added **no** catalog
rows, no shared counters and no cross-suite state — the only fixtures I seed are per-test
conversations, links, wallets and budget rows, all cleaned up in `afterAll`.

## Acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Guest-reachable funding read returns the payer snapshot from the same producer, pinned two-sidedly against `admitRun` | **met** | `spendable.ts:433–439` + `spendable.integration.test.ts:671–723` |
| `public`-classed, through the existing `authorizeCaller`/`resolveCallerMember` seam; wrong conversation, revoked link, expired link, departed member each refused | **met** | `routes.ts` `GET /:conversationId/funding` reuses `authorizeCaller`; 6 refusal tests in `budgets.integration.test.ts` |
| `FundingSnapshot.tier` → `payerTier` everywhere; the value is the payer's | **met** | type, wire schema, both API routes, 4 web consumers, 15 shared/api/web test files; guest funded by a paid owner is served `paid` (`serves the owner as payer, at the owner's tier`) |
| Tier-keyed guest denial DELETED; denial only from `GROUP_BUDGET_EXHAUSTED`; funded guest not denied | **met** | zero repo hits for `tier === 'guest'`; `guest whose served payer figure covers the estimate → owner_balance, never denied` |
| No-endpoint fallback is trial-only; a guest never takes the `$0.01` ceiling | **met** | `Exclude<UserTier, 'guest'>` + both call sites pass the literal `'trial'` + the 50¢-estimate pin |
| The composer's snapshot for a guest is the served one; nothing fabricated while pending | **met** | `withholds the verdict while the guest funding read is in flight`; `fundingSnapshotOf` fallback reachable only with no snapshot |
| No refusal shown to a guest offers "Add credit"; zero allocation ⇒ `guest_no_group_budget`, owner cannot cover ⇒ `group_owner_funds_unavailable` | **met** | `guestMoneyRefusal` + two composer tests asserting the copy contains no `Add credit` |
| Dead `group` parameter deleted from `ClientBillingInput` and `useResolveBilling`; the dead `/budgets` request stops firing | **met** | see greps above; `never fires the session-only budgets read for a guest` |
| One funding read per composer | **met** | `conversationId` required on `UseResolveBillingInput`; `reads the funding snapshot scoped to the conversation…` |
| Premium and media options for a guest computed from the payer's tier | **met** | `getTurnOptions` consumes `funding.payerTier`; `grades premium access on the payer's tier…` |
| Red first, and these are the reds | **met** | all four captured verbatim above |

## Deviations, with reasons

1. **The guest's client-side funding decision routes through the shared core rather than a
   short-circuit.** The criterion says the guest denial must arrive from
   `GROUP_BUDGET_EXHAUSTED`, which the core reaches only on a non-solo input. Since E1 removed
   the client's `group` field, the only remaining way to satisfy that literally is to feed the
   guest's **served figure** into the three group dimensions — which is exactly the "one
   payer-scoped number rather than a two-field group blob" shape the plan's design context
   describes. `callerOwnPurchasedBalanceNanoUsd` is hard-coded `0n` there: a guest has no
   wallet, and grading one is how the original defect happened.

2. **`payerSizingTier` lost its `input.group === undefined` shortcut.** Kept as a deviation
   rather than a special case: the shortcut returns the caller's own tier without consulting
   the core, which is correct for a solo caller and wrong for a guest (whose headroom is not on
   `group`). Routing every caller through the core gives the same answer for solo and the right
   one for a guest.

3. **Two `resolveClientBilling` describes were deleted rather than adapted**
   (`— group / owner funding`, and the `group paths` consistency block). They construct a
   `ClientBillingInput` with `group`, which no longer exists; production has not supplied it
   since E1. The behaviour they covered is still pinned: the core's group semantics by
   `funding-decision.contract.test.ts` (both legs) and by the `deriveClientFundingInputs`
   describe, which retains `ClientFundingContext.group`.

4. **Two files outside §F4's list, both orchestrator-granted after I reported them**:
   `chat/domain/turn-ceiling.clamp-order.test.ts` (my rename reached it) and
   `conversations/routes.integration.test.ts` (F8's column rename, my file).

5. **`apps/web/src/lib/auth.ts` is unchanged** although §F4 lists it. The guest mask in
   `useSession` is what makes `isAuthenticated` false for a link guest, which every new gate
   relies on; nothing about it needed to move.

6. **`apps/api/src/slices/billing/{index.ts, domain/index.ts, routes.ts}` are outside the
   literal file list.** The two barrels are mechanically required to publish the new producer;
   `routes.ts` changes one field name because the rename reaches the wire. No logic changed.

## Concerns and limitations

1. **`ClientFundingContext.group` and `payerSizingTier` are now production-dead.** The
   criterion named `ClientBillingInput` and `useResolveBilling` specifically, and I did exactly
   that. But `payerSizingTier` has **no production caller** (grep: definition + tests only), and
   `ClientFundingContext.group` survives only to feed it and the contract test. By the
   criterion's own reasoning — "the entry point to the disqualified two-endpoint design;
   leaving it is leaving an invitation" — that pair is the same invitation one level out.
   Deleting an exported function is beyond what I was asked to do, so I am reporting it.

2. **Two of the route tests do not discriminate as strongly as they read.** `refuses a guest
   pointing its credential at a different conversation` and `refuses a departed guest` both
   expect 404, which is also what a non-existent route returns — so they passed vacuously in
   the red run. They discriminate now (the route exists and every sibling case returns
   200/401/403), but a future reader should know the 404 arms are weaker evidence than the
   others.

3. **The guest money-refusal split lives in `sendRefusalOf`, not in `resolveClientBilling`.**
   `resolveClientBilling` returns the coarser `guest_budget_exhausted` for both conditions.
   They are different questions (a media estimate vs. the produced text verdict) and the same
   asymmetry already exists for paid/free (`insufficient_balance` vs `insufficient_funds`), so
   this is not a second implementation of one fact — but it does mean the finer
   zero-vs-insufficient wording exists at exactly one surface.

4. **`resolveClientBilling`'s guest arm is near-unreachable in production.**
   `withServedPayer` replaces the whole result with `owner_balance` whenever the served payer
   is `owner`, which for a guest is always. I still made the arm honest rather than leaving a
   lie behind a shadowing layer, and its behaviour is pinned directly.

5. **The E2E reproduction was not run** (Global Constraint 11 / founder ruling), and I did not
   touch `e2e/sharing/link-guest-chat.spec.ts`. The watched-red evidence is unit and
   integration only; the spec that would have caught the original regression still has not run.

6. **`TIERS` in two shared property tests still includes `'guest'`** as a possible
   `payerTier`. That is now a value the server cannot serve (a payer is never a guest). It is
   harmless — the producer treats it as a non-paid tier — but it is a fixture that outlived its
   meaning, and tightening it was outside this task.

7. **A negative-assertion hazard surfaced during the sweep**: most `use-model-validation`
   tests assert `not.toHaveBeenCalled()`, so the `tier` → `payerTier` fixture break made them
   *greener*, and only the two positive assertions went red. The fixture is fixed, but this is
   the documented "an assertion can pass because the thing it names no longer exists" shape,
   found in a file the rename reached.

## Confidence

**Medium-high.** The server path, the shared money layer and the composer are each pinned by
tests that were watched failing for the right reason, the two-sided `admitRun` pin closes the
drift question directly, and all three scoped suites plus per-package lint and repo typecheck
are green for everything I own. The reservation is not about this diff: `pnpm test:api` is red
on six files owned by two concurrent tasks, so I could not observe a fully green api gate, and
§Known Breakage says a single green api sweep would not have proven much either. The second
reservation is the E2E spec, which remains authored-but-unrun by ruling.
