# F4 — implementation report 2 (fix cycle)

## Objective

Close the seven validated findings from the 3-lens panel (correctness PASS, security PASS,
conventions FAIL). No criterion of the task was reopened: the central deviation the panel
judged legitimate — the served figure entering the funding core as group headroom with the
guest's own balance fixed at `0n` — is untouched, as are the deleted describes.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/billing/domain/spendable.ts` | New `serializeFundingSnapshot` — the single wire encoding of `FundingSnapshot`, typed to `GetSpendableResponse` (finding 6). |
| `apps/api/src/slices/billing/domain/spendable.test.ts` | **New.** Pins the serializer: encoding, pass-through, and field-for-field agreement with the served schema. |
| `apps/api/src/slices/billing/domain/index.ts` | Publishes `serializeFundingSnapshot` to the slice. |
| `apps/api/src/slices/billing/index.ts` | Publishes it across the slice boundary (the conversations door needs it). |
| `apps/api/src/slices/billing/routes.ts` | `/billing/spendable` serializes through the shared function instead of its own object literal (finding 6). |
| `apps/api/src/slices/conversations/domain/guest-funding.ts` | Same serializer at the guest door; member row resolved through `resolveCallerMember` (finding 5); doc comment narrowed to the member-row arm (finding 1). |
| `apps/web/src/hooks/billing/use-turn-options.ts` | Funding gate keys on the ABSENCE of the snapshot, not on the query being pending (finding 7); the `fundingSnapshotOf` note corrected to match. |
| `apps/web/src/hooks/billing/use-turn-options.test.ts` | The failed-read pin; one fixture corrected (below). |
| `apps/web/src/hooks/billing/use-prompt-budget.ts` | `buildBillingResolverInput` JSDoc no longer describes the removed conditional (finding 2). |
| `packages/shared/src/affordability/billing/client-billing.ts` | `ClientFundingContext` header no longer claims to be a subset of `ClientBillingInput` (finding 3). |
| `packages/shared/src/affordability/billing/client-billing.consistency.test.ts` | Header no longer advertises the deleted `group/solo` axis (finding 4). |

## The findings, one by one

### 1 — the copied not-found sentence (`guest-funding.ts`)

Before:

```
 * Authorization is the membership gate every other guest-reachable read uses:
 * the route resolves the credential and refuses a mismatched conversation, and
 * the active member row is re-checked here, so a revoked link, an expired link
 * and a departed guest are each the same indistinguishable not-found. A caller
 * holding a session is refused outright — …
```

After:

```
 * Authorization is the membership gate every other guest-reachable read uses:
 * the route resolves the credential and refuses a mismatched conversation, and
 * the active member row is re-checked here through the shared resolver, so a
 * departed guest holding a live link is the same indistinguishable not-found as
 * a conversation that never existed. A dead credential — revoked or expired —
 * never reaches this function at all: it resolves to no caller at the route and
 * is refused unauthenticated. A caller holding a session is refused outright — …
```

Verified against the route, not inferred: `authorizeCaller` (`conversations/routes.ts:374`)
returns **401** for a `null` caller — which is what a revoked or expired credential resolves
to (`resolveConversationCaller` degrades a dead credential to `null`) — and **404** only for
the conversation mismatch at `:377`. The departed-guest 404 is the arm this function owns.
Both refusals are already pinned by the route matrix in `budgets.integration.test.ts`.

### 2 — `buildBillingResolverInput` JSDoc (`use-prompt-budget.ts`)

Before:

```
 * Construct the input shape `useResolveBilling` expects, conditionally
 * including the optional `group` field. Hoisted out of the hook so the
 * conditional spread doesn't bump the hook's cyclomatic complexity past
 * the lint threshold.
```

After:

```
 * Project the hook's values onto the input shape `useResolveBilling` expects —
 * a rename, with no branch in it. What it does NOT pass is the load-bearing
 * part, and the reason sits at the return below.
```

The second sentence of the old text was the one that misstated why the function exists;
the surviving reason (the deliberately omitted GROUP dimension) is already recorded in
full at the return statement, so the header points at it rather than restating it.

### 3 — `ClientFundingContext` is not a subset

Before: `The funding-relevant subset of {@link ClientBillingInput}: … "ClientBillingInput" is
structurally assignable to it.`

After:

```
 * The funding-relevant inputs: who pays depends on the caller's tier, raw
 * balance, model tier and — at priority 1 — the amount the group headroom has
 * to cover, never on the affordability balances. `ClientBillingInput` is
 * structurally assignable to it, but it is NOT a subset of that shape: `group`
 * lives only here, and no production caller supplies it — the client stopped
 * resolving group funding when the served snapshot took over naming the payer,
 * so a guest's group headroom arrives as its served spendable instead.
```

"No production caller supplies it" is measured, not assumed: the only callers of
`deriveClientFundingInputs` outside tests are `payerSizingTier` and `resolveClientBilling`
in the same file, both of which take `ClientBillingInput`-shaped values, and
`ClientBillingInput` has no `group`. The residue itself stays for G2, as instructed.

### 4 — consistency-test header

`Parameterized across: tier × balance × isPremium × group/solo × privilege`
→ `Parameterized across: tier × balance × isPremium × privilege`.

`privilege` was kept deliberately, not by oversight: the file still parameterizes on it
(`describe('with privilege context')`, read/write cases at `:233`–`:256`). Only the
`group/solo` axis has no carrier left.

### 5 — the second spelling of the shared gate

Before:

```ts
return deps.stores.members.activeLinkGuest(conversationId, caller.linkId).andThen((guest) => {
  if (guest === null) { … }
  …  memberId: guest.member.id,
```

After:

```ts
return resolveCallerMember(deps.stores, conversationId, caller).andThen((member) => {
  if (member === null) { … }
  …  memberId: member.id,
```

Behaviour-identical by construction (`resolveCallerMember`'s guest arm is exactly the call
that was here, mapped to its `member`), and the file now inherits any future tightening of
the shared gate. Pinned by the existing departed-guest 404 and active-guest 200 cases,
which pass unchanged.

### 6 — one serializer, two doors

Definition (`billing/domain/spendable.ts`):

```ts
/**
 * The snapshot's wire encoding, typed to the served schema. Both doors call
 * this: a second hand-rolled encoder would be a copy that must agree to be
 * correct, and only one of the two would keep pace with a schema change.
 */
export function serializeFundingSnapshot(snapshot: FundingSnapshot): GetSpendableResponse {
  return {
    spendableNanoUsd: serializeNanoUSD(nanoUSD(snapshot.spendableNanoUsd)),
    heldNanoUsd: serializeNanoUSD(nanoUSD(snapshot.heldNanoUsd)),
    payerTier: snapshot.payerTier,
    payer: snapshot.payer,
  };
}
```

Call site 1 — `billing/routes.ts`, `GET /billing/spendable`:

```ts
return result.match(
  (snapshot) => c.json(serializeFundingSnapshot(snapshot), 200),
  (error) => respondDomainError(c, error)
);
```

Call site 2 — `conversations/domain/guest-funding.ts`:

```ts
).map((snapshot): Outcome<GuestFundingView> => serializeFundingSnapshot(snapshot));
```

Both are now type-pinned to the shared schema (the guest door already was, through
`guestFundingViewSchema`; the billing door is, through the return type). A repo-wide sweep
for the old shape (`heldNanoUsd:` in non-test api/realtime source) leaves exactly one wire
encoding, inside the new function.

### 7 — the failed funding read fell back to the trial ceiling

Before: `hasServedFunding(input.isAuthenticated, conversationId) && isServedPending`.
After: `hasServedFunding(input.isAuthenticated, conversationId) && served === undefined`
(the `isPending` destructure is gone; nothing else read it).

The `fundingSnapshotOf` note above it was falsified by the change and was corrected in the
same edit: "the fallback is reached only with no snapshot in hand" → "the fallback belongs
to the trial alone. A caller that HAS a door is gated until its snapshot is in hand — still
loading and failed alike".

## Tests added

| Test | Behaviour | Finding |
| --- | --- | --- |
| `serializeFundingSnapshot` — renders the nano figures as canonical decimal strings | money crosses the wire as `NanoUSD` strings | 6 |
| — carries the payer identity through unchanged | `payerTier`/`payer` are pass-through | 6 |
| — emits exactly the fields the served schema declares | the asymmetry that made two encoders worse than usual: a dropped field leaves the schema's key list longer, an extra one leaves it shorter | 6 |
| `useTurnOptions` — withholds the verdict when the guest funding read FAILED, rather than sizing on the trial ceiling | `isPending: false` + `data: undefined` with a door present ⇒ no verdict, not a trial-sized one | 7 |

**The discriminating input for finding 7's pin, stated plainly:** `isPending: false` with
`data: undefined`. Under the old gate the hook returned `isPending === false` and a full
`options` object sized on `getEffectiveBalanceNano('trial', 0n, 0n)`; under the new gate it
returns `isPending === true` and `options === undefined`. Observed red before the fix
(`AssertionError: expected false to be true`, `use-turn-options.test.ts:568`), green after.

## The reds, verbatim

**Red 1 — the serializer does not exist** (`pnpm test:watch apps/api/src/slices/billing/domain/spendable.test.ts`, exit 1, 3 failed):

```
 FAIL  |api| src/slices/billing/domain/spendable.test.ts > serializeFundingSnapshot > carries the payer identity through unchanged
TypeError: serializeFundingSnapshot is not a function
 ❯ src/slices/billing/domain/spendable.test.ts:29:18
```

**Red 2 — the failed read falls through to the trial ceiling** (`pnpm test:watch apps/web/src/hooks/billing/use-turn-options.test.ts`, exit 1, 1 failed / 29 passed):

```
 FAIL  |web| src/hooks/billing/use-turn-options.test.ts > the link guest — owner-funded, never trial-capped > withholds the verdict when the guest funding read FAILED, rather than sizing on the trial ceiling
AssertionError: expected false to be true // Object.is equality
 ❯ src/hooks/billing/use-turn-options.test.ts:568:38
```

Findings 1–5 are a comment narrowing, three doc corrections and a behaviour-preserving
substitution of the shared resolver — no new behaviour, so no new red; each is covered by
tests that passed before and after (route matrix, consistency suite, contract suite).

## One fixture corrected, and why it is not a weakened test

`names the account reason, not the credit reason, for a payer with no account` went red on
the gate change. Its scenario is a **trial** payer (`isAuthenticated: false`, no
conversation), but it left the mocked `hasServedFunding` at the suite default `true` — a
combination the real predicate cannot produce, and which the old pending-only gate happened
to tolerate. The fixture now sets `mockHasFundingDoor.current = false`, matching what
`hasServedFunding` actually returns for a trial. **No assertion was changed or relaxed**;
the test still asserts `premium_requires_account` on the same row.

## Self-gate

| Check | Result |
| --- | --- |
| `pnpm test:shared` | **pass** — exit 0 (the plan-named scoped check, coverage gate included) |
| `pnpm test:web` | **pass** — exit 0, 396 files / 6460 tests (coverage gate included) |
| `pnpm test:api` | **NOT RUN** — forbidden by the brief (two `apps/api` suites cannot overlap in this worktree). Owned files run in isolation instead. |
| api owned suites in isolation (`spendable.test`, `spendable.integration`, `billing/routes.integration`, `billing/routes-usage.integration`, `conversations/domain/budgets.integration`, `conversations/routes.integration`) | **pass** — exit 0, 6 files / 416 tests |
| Scoped coverage, `guest-funding.ts` + `spendable.ts` | **100%** lines/branches/functions on both (`spendable.ts` 54/54 lines, 20/20 branches; `guest-funding.ts` 12/12, 6/6) |
| Scoped coverage, `billing/routes.ts` | **100%** (123/123 lines, 36/36 branches) over `src/slices/billing` + `src/app-mount.integration.test.ts` |
| `pnpm typecheck` (repo-wide) | **pass** — exit 0, 16 tasks |
| `pnpm arch:check` | **pass** — exit 0, 13 rules over 2186 files |
| `eslint` from `apps/api`, 6 changed files | **exit 0** (after the last edit anywhere) |
| `eslint` from `apps/web`, 3 changed files | **exit 0** (after the last edit anywhere) |
| `eslint` from `packages/shared`, 2 changed files | **exit 0** (after the last edit anywhere) |

**A coverage number that needs its scope stated, because the narrow reading is misleading.**
Measured over `billing/routes.integration.test.ts` + `routes-usage.integration.test.ts`
alone, `billing/routes.ts` reports 94.44% branches and fails the per-file threshold. The two
uncovered branches are at `:553` and `:575` — the mock-provider `waitUntil` closure and the
`deps.wakeDispatcher !== undefined` nudge in `POST /payments`, both far from the
`/spendable` hunk and both covered by `src/app-mount.integration.test.ts`. With that file in
scope the same measurement is **100%**. Nothing here is attributable to this change: the
lines removed from `/spendable` were four property assignments carrying zero branches.

## Deviations

None from the brief. The residue explicitly assigned elsewhere was left alone:
`payerSizingTier` / `ClientFundingContext.group` and the plan-identifier leaks in the web
billing files (G2), and the two surfaces reading the unscoped `useSpendable(null)` door
(F10).

## A claim from report 1 that was false, corrected

Report 1 stated that a repo-wide grep for `tier === 'guest'` "returns **zero hits**". It
returns **two**:

```
apps/web/src/hooks/billing/use-prompt-budget.ts:526:  const isLinkGuest = useUserTierInfo(isAuthenticated).tier === 'guest';
packages/shared/src/affordability/billing/client-billing.ts:120:  const isGuest = input.tier === 'guest';
```

Re-checked this cycle. The conclusion report 1 drew from it still holds — neither hit is a
denial: `:526` derives a UI flag, and `:120` is the funding-context guest branch that routes
the served figure into the core. But the stated evidence was wrong, and "the artifact exists,
therefore the property holds" is exactly the shape this run has been burned by. The accurate
statement is: **two hits exist, both were read, neither denies on tier.**

## Concerns and limitations

- **`use-budget-calculation.ts` has the same shape but not the same defect, and I did not
  touch it.** Its gate is also pending-only (`:202`–`:204`), so a failed read leaves it with
  `spendableNanoUsd = 0n` and `payerTier = tierInfo.tier`. That is a *poverty* reading, not
  the trial-ceiling conflation finding 7 names, and the finding scoped itself to
  `use-turn-options`. Flagged rather than fixed — for a link guest it would read the
  **sender's** tier where the payer's is required, which is a verdict-moving change outside
  the finding I was given.
- The failed-read gate leaves a caller whose funding query errors in the neutral pending
  state indefinitely (until a refetch succeeds). That is the behaviour the criteria ask for
  — nothing fabricated, no money decision from an absent figure — but it is a *silent* wait
  rather than an error surface. No notice copy exists for "we could not read your funding",
  and inventing one is outside this task.
- `pnpm test:api` was not run, by instruction; the api evidence above is isolated-file runs
  plus scoped coverage. The standing `template-html` failure would have suppressed the
  package coverage report anyway.

## Confidence

**High.** Every finding is closed by a change whose effect is directly observable: two reds
watched fail for the stated reason and pass after, three doc corrections checked against the
code they describe (the 401/404 split read out of the route, the `privilege` axis read out
of the test file, the `group` supplier set read out of the call graph), one behaviour-
preserving substitution covered by unchanged route tests, and one serializer with both call
sites and a field-agreement pin. Gates green: repo-wide typecheck, arch:check, three eslint
runs at exit 0 after the final edit, `test:shared` and `test:web` in full.
