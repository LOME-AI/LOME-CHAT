# F1 — Payer-scoped served numbers · impl-report-1

## Objective

`GET /billing/spendable` serves the funding snapshot of the wallet that will actually
pay — the owner's hold-aware group remaining at the owner's tier in a group
conversation, the caller's own figures everywhere else — plus `tier` and `payer`
(BILLING §Group Funding 1, §Data Structures `FundingSnapshot`). The client's sizing
inputs consume that snapshot instead of re-deriving the payer's tier and balance.

## Files changed

### `packages/shared` (the wire contract)

- `src/schemas/api/billing.ts` — `getSpendableQuerySchema` (optional `conversationId`,
  uuid); `getSpendableResponseSchema` gains `tier` + `payer`; `userTierSchema` derived
  from the shared `UserTier` union via `satisfies Record<UserTier, UserTier>` so a new
  tier fails typecheck here instead of silently narrowing the wire. `UserTier` is
  imported through the affordability **barrel**, not a deep relative path (G1 rule 1
  forward-compatibility).
- `src/schemas/api/billing.test.ts` — schema tests for both.

### `apps/api`

- `src/slices/billing/domain/spendable.ts` — `readSpendable`/`SpendableView` become
  `readFundingSnapshot`/`FundingSnapshot` (the type carries payer identity now, so the
  old name was wrong). Adds `ConversationFundingFacts` +
  `ConversationFundingReader` (the injected conversations-owned read), the group
  readout, and the payer decision through the shared funding core.
- `src/slices/billing/domain/index.ts`, `src/slices/billing/index.ts` — barrel exports.
- `src/slices/billing/routes.ts` — `BillingRouteDeps.conversationFunding` (required,
  db-bound factory, mirroring media's `readers`); the route validates the query with
  `rejectInvalid` and serializes the four fields.
- `src/adapters/conversation-funding.ts` **(new)** — the composition-root adapter that
  composes conversations' stores (owner + durable cap + the caller's membership row);
  `null` for owner/non-member/absent conversation.
- `src/app.ts` — wires it.
- `src/slices/billing/routes.integration.test.ts` — wires the **real** adapter and adds
  the group contract tests; `routes-usage.integration.test.ts`,
  `app-mount.integration.test.ts` — construction sites for the new required dep, with
  throwing readers that pin "this surface resolves no payer".
- `src/slices/billing/domain/spendable.integration.test.ts`,
  `src/adapters/conversation-funding.integration.test.ts` **(new)** — see below.

### `apps/web`

- `src/hooks/billing/billing.ts` — `billingKeys.spendableFor(conversationId)` under the
  existing `billingKeys.spendable()` **prefix**.
- `src/hooks/billing/use-spendable.ts` — optional `conversationId`, scoped key, query param.
- `src/hooks/billing/use-budget-calculation.ts` — takes `conversationId`, and the
  affordability solve + char/token ratios now run at the **served payer tier**
  (`spendableData?.tier ?? tierInfo.tier`) against the payer's spendable.
- `src/hooks/billing/use-prompt-budget.ts` — threads the conversation into the served
  read and the budget core; `sizingTier` (composer + `useModelFloor`) comes from the
  served snapshot, replacing the client-side `payerSizingTier` derivation.
- `apps/web/src/lib/api-client.ts` — **no change needed**: `hc<AppType>()` infers the
  new query and response from the route chain (verified by web typecheck).

## Tests added

Domain (`spendable.integration.test.ts`, 33 total in file):

| Test | Behavior | Criterion |
| --- | --- | --- |
| serves the group's hold-aware remaining, not the sender's own wallet | member dimension binds → $0.80 | served figure = group hold-aware remaining |
| serves the PAYER's tier, not the free-tier sender's | `tier: 'paid'` for a zero-balance sender | payer's tier |
| names the owner as the payer of a funded group turn | `payer: 'owner'` | serves `payer` |
| subtracts an active member-scope hold from the served group remaining | hold-aware | hold-aware remaining |
| reports the held amount as exactly what holds took off the group remaining | non-binding hold ⇒ `held: 0` | `spendable + held` = hold-blind |
| reports the binding hold as held, so spendable + held is the hold-blind remaining | identity | same |
| **serves the figure admission gates the group turn on** | `admitRun` at the served figure admits, +1n refuses `budget-exceeded` | contract test |
| falls back to the sender as payer once the group allowance is exhausted | `payer: 'self'` | self-funded unchanged |
| serves the sender's own free-tier figures on fall-through | `tier: 'free'` | same |
| treats a negative owner balance as zero group headroom | §Group Funding 6(e) | same |
| reads an unconfigured member budget as zero headroom, never unlimited | absent cap = deny | branch cover |
| reads an owner with no purchased wallet as zero headroom | no pool | branch cover |
| serves the caller as payer when the conversation has no group funding for them | reader `null` (owner/solo) | self-funded unchanged |
| serves the caller as payer / own tier / free tier with no conversation context | self arm | self-funded unchanged |
| fails closed with a typed unavailable error when Redis is down mid-group-read | 503 parity with admission | fail-closed preserved |

Adapter (`conversation-funding.integration.test.ts`, 4): member → own membership row as
the scope; owner → null; non-member → null; absent conversation → null.

Route (`routes.integration.test.ts`, +3 and one pin extended): the wire shape is now
`held/payer/spendable/tier`; a free-tier member composing in the group receives
`spendableNanoUsd 800000000, payer owner, tier paid`; a non-uuid `conversationId` → 400
`{code:'VALIDATION'}`.

Web: `use-spendable.test.ts` (+6) — scoped key shape, the family-prefix property, no
query outside a conversation, the scoped query, separate cache slots, and
**invalidating `billingKeys.spendable()` refetches a conversation-scoped read** (the E3
guarantee). `use-budget-calculation.test.ts` (+4) — scope threading, payer-tier input
ratios, affordability against the payer's remaining, fall-through keeps the sender's
tier. `use-prompt-budget.test.ts` (+2, 2 rewired) — scope threading to both the served
read and the budget core; the two existing owner-priced sizing pins now drive the
served snapshot.

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo test --filter=@hushbox/shared --force` | pass — 110 files, 2674 tests |
| `npx turbo test --filter=@hushbox/api --force` (final run) | **fail — only** `notifications/domain/templates/template-html.test.ts` (7 snapshot failures); 465 files / 6391 tests pass, 1 file skipped. Exactly §Known Breakage's "single `apps/api` failure a scoped run will show". An earlier `pnpm test:api` run (through `with-env`, stack up) showed the identical single failure. |
| `pnpm test:web` | pass — exit 0, 393 files, 6410 tests. No coverage failure observed (see Concerns re the intermittent entry). |
| `apps/api` typecheck (`tsgo --noEmit`) | pass |
| `apps/web` typecheck (`tsgo --noEmit` ×2 projects) | pass |
| `npx turbo typecheck --continue` (repo-wide) | 15/16 pass; `@hushbox/scripts` fails on `refresh-catalog-run.test.ts` missing `below-price-floor` / `too-old` / `zero-priced` reasons — **A1's** concurrent work (its own owned fixture; `models/domain/normalize.ts` + `refresh.ts` are modified in the tree). |
| `pnpm arch:check` | pass — 11 rules over 1992 files |
| `eslint` on every owned file, from each package dir, after the last edit | pass (api, web, shared) |

Scoped coverage for the new/changed api money files (json-summary, their own tests
only — a lower bound for the full-suite figure): `domain/spendable.ts` **100/100/100/100**,
`adapters/conversation-funding.ts` **100/100/100/100**.

## Acceptance criteria

1. **Endpoint accepts conversation context and serves the payer's numbers plus `tier`
   and `payer`; contract test shows the served figure equals the group's hold-aware
   remaining at the payer's tier** — met. The domain test asserts the value
   (`800000000` = member cap − spent, the binding dimension), the tier (`paid` for a
   zero-balance sender) and the payer (`owner`); the route test asserts the same three
   over HTTP through the real adapter; and "serves the figure admission gates the group
   turn on" proves the number *is* the gate (equal admits, +1 nano refuses
   `budget-exceeded`).
2. **Shared schema and typed client updated together; repo-wide typecheck green** —
   met for the contract (`getSpendableQuerySchema`/`getSpendableResponseSchema` +
   `hc<AppType>()` inference; web and api typecheck clean). Repo-wide typecheck has one
   failure, attributed to A1 above.
3. **Key shape reconciled with E3** — met. See the coordination fact below.
4. **Client sizing inputs take the payer's tier** — met.
   `useBudgetCalculation` now runs `estimateTokensForTier` /
   `outputCharsPerTokenForTier` and the affordability solve at the served payer tier
   (previously the sender's), and `usePromptBudget`/`useModelFloor` take `sizingTier`
   from the same snapshot.
5. **Guests and self-funded turns unchanged; pinned** — met.
   - Guests: unreachable by construction — the endpoint is `billing-token`-classed and
     the pipeline refuses link-guest and trial principals for **every** route class
     (`apps/api/CLAUDE.md` §Routes); `useSpendable` stays disabled for unauthenticated
     callers (existing test kept), and the trial/guest fixed-1¢ arm still resolves
     client-side (`effectiveBalanceFor`, unchanged, plus the "keeps the client-side
     fixed arm for unauthenticated users" test). The server never constructs
     `isGuest: true` for this read, and the funding core's guest refusal therefore
     cannot be reached from it (documented at the call site).
   - Self-funded: the no-conversation path is byte-equivalent in behavior (same wallet
     resolve, same `resolveEffectiveSpendable`, same hold subtraction, same
     `not_found` for a missing purchased wallet, same 503 on Redis down) — all
     pre-existing tests kept and passing, with `tier`/`payer` added; the fall-through
     and owner/non-member paths serve exactly those self figures.

## Deviations, with reasons

1. **Renamed `readSpendable`/`SpendableView` → `readFundingSnapshot`/`FundingSnapshot`.**
   The type now carries payer identity; `BILLING.md` §Data Structures names it
   `FundingSnapshot`, and durable naming forbids leaving a wrong name in place. The
   HTTP path (`/billing/spendable`) and the query keys are unchanged, so E3 and every
   client reference still address the same endpoint.
2. **Files beyond the plan's F1 list:** `apps/api/src/adapters/conversation-funding.{ts,integration.test.ts}`
   (new), `apps/api/src/app.ts`, and two manifest construction sites
   (`routes-usage.integration.test.ts`, `app-mount.integration.test.ts`). The facts that
   name a group turn's payer live on conversations-owned rows that billing may not read
   (single-writer-per-table), so they are composed at the root exactly as media's
   `PresignReaders` are (`src/adapters/presign-readers.ts` is the precedent, and its
   comment states the same reason). Making the dep **required** rather than optional is
   deliberate: a silently-absent reader would serve the sender's wallet in production,
   which is the bug this task exists to remove — so typecheck names every construction
   site instead.
3. **`payerSizingTier` (packages/shared) now has no production consumer.** Replacing the
   client-side payer-tier derivation with the served value is criterion 4 and BILLING
   Principle 1 ("divergence-prone inputs are served as numbers, never re-derived");
   keeping both would leave two derivations of one fact (Global Constraint 5). Deleting
   it is outside my ownership — raised, not done.
4. **`use-resolve-billing.ts` deliberately keeps the unscoped `useSpendable()`.** The
   who-pays core needs the **caller's** own balance and tier (that is what decides
   fall-through and premium); the payer-scoped figure would be the wrong input there. Cost:
   a group composer issues two spendable reads (scoped + unscoped). Left as is because
   collapsing them would change the funding decision's inputs — F2/E1 territory.
5. **Three pre-existing `use-budget-calculation` fixtures corrected, assertions untouched.**
   They paired a trial/free caller with a snapshot fixture claiming `tier: 'paid'`, which
   the wire cannot produce. The trial case now returns no snapshot (the query is disabled
   for unauthenticated callers) and the zero-balance case returns `tier: 'free'`. No
   assertion was weakened.

## TDD notes (honest sequencing)

- Shared schema, domain group arm, adapter, route query, web key shape and web budget
  ratios: failing test first, watched red for the expected reason, then green.
- Three tests were written **after** the code they cover, so each was verified by
  mutation instead: the `conversation === null` branch (mutated the branch → 1 red,
  restored → green); `usePromptBudget`'s sizing tier (replaced with the caller's tier →
  the owner-priced test went red); the conversation threading into the budget core
  (removed the field → its test went red). The two branch-coverage tests
  (absent member budget, ownerless wallet) assert `payer: 'self'`, which is exactly what
  the mutated branch would break.
- The "invalidating the family prefix refetches a scoped read" test passed on first run —
  it pins TanStack's prefix semantics against my key shape rather than new logic. Its
  structural sibling (`slice(0, prefix.length)`) was red before implementation.

## Concerns and limitations

- **The api coverage gate could not be observed.** `pnpm test:api` aborts before the
  coverage report because of the pre-existing `template-html` failure, so the per-file
  numbers above come from a scoped run (100% on both new money files, which the full
  suite can only raise).
- **`pnpm test:web` was green this run** (exit 0, 393 files). Per §Known Breakage that
  neither proves nor disproves the intermittent `markdown-renderer.tsx` coverage entry; I
  saw no coverage failure at all, and I touched none of those files.
- **Two implementations of the clamp-then-min group headroom already exist**
  (`apps/api/src/slices/billing/domain/group-budget.ts:groupEffectiveRemainingNanoUsd` and
  the private `groupHeadroom` inside
  `packages/shared/src/affordability/billing/funding-decision.ts`). Pre-existing, not
  introduced here; I use the shared core for the *decision* and the billing helper for the
  *number*, so both sites are exercised together by the new tests. Worth G2's attention.
- **The hold-aware min itself is now computed in two files:**
  `spendable.ts:ownerSnapshot` and `conversations/domain/budgets.ts:buildBudgetsView`.
  Both call the same `groupEffectiveRemainingNanoUsd` with the same per-dimension
  `cap − spent − held` expression, so the formula is shared; the composition is not.
  Collapsing them means editing the conversations slice — out of my ownership, raised.
- **The owner-balance dimension stays raw in both the hold-aware and hold-blind figures**,
  so `heldNanoUsd` reflects only this conversation's own scope holds. That is deliberate:
  the existing ruling recorded in `conversations/domain/budgets.ts` (and
  `use-conversation-budgets.ts`) is that members must not be able to infer the owner's
  activity elsewhere. It also means no new privacy boundary is crossed — every figure the
  endpoint now serves a member (`effectiveRemaining`-shaped value, and the holds implicit
  in it) is already served to that same member by `GET /conversations/:id/budgets`
  (`budgets.ts:274` `effectiveRemainingNanoUsd`, `:261` `ownerBalanceNanoUsd`). No
  NEEDS_CONTEXT was needed on the privacy trigger.
- **Payer resolution is hold-blind, spendable is hold-aware.** `resolveFundingDecision`
  receives the durable dimensions (matching the send path's `resolvePayerWallet`, which
  reads rows only), so a fully-held group still reports `payer: 'owner'` with a small
  spendable rather than flipping the payer. A hold is a transient reservation, not
  poverty (BILLING §The four notions).

## Confidence

**High** for the server contract and the client sizing inputs: the served figure is
pinned against `admitRun` itself, both new money files are at 100% coverage, and every
scoped suite is green apart from one pre-existing failure and one concurrent-task
typecheck failure, both attributed with evidence.

**Medium** on one judgment: making the served snapshot the single source of the payer's
tier orphans `payerSizingTier` and moves `useModelFloor`/`usePromptBudget` off a
client-side derivation. It is what criterion 4 and BILLING Principle 1 ask for, but E1
owns those surfaces next and may want the shape stated differently.
