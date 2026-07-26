# F2 — implementation report 1

## Objective

Priority 1 of BILLING §Funding Decision Matrix compares the **turn's estimate** against the
group headroom, not merely headroom against zero: a positive remaining balance that cannot
cover this turn is not fundable, and the fall-through it produces carries a typed reason
B7 can wire copy to.

## The boundary pin, by amount

One estimate, two headrooms, one nano apart:

| turn estimate (nano-USD) | group headroom (nano-USD) | verdict                                                    |
| -----------------------: | ------------------------: | ---------------------------------------------------------- |
|           `40_000_000` (4¢) |              `39_999_999` | **not fundable** → sender pays (`payerSwitch` set) / guest refused |
|           `40_000_000` (4¢) |              `40_000_000` | **fundable** → owner pays                                  |

Comparison is `headroom >= turnEstimate` (inclusive), gated behind `headroom > 0n`.
Pinned in three places, at both the core and the client shell:

- `funding-decision.test.ts` — "owner-funds when the headroom exactly equals the turn estimate"
  and "falls through to self funding when the headroom is one nano below the turn estimate".
- `client-billing.test.ts` — the same two amounts through `resolveClientBilling`
  (`40n * NANO_PER_CENT` and `40n * NANO_PER_CENT - 1n`).
- `funding-decision.contract.test.ts` — the same pair as matrix rows exercised by **both**
  legs (see §Client/server parity).

The inclusive boundary was verified to be load-bearing, not incidental: with `>=` mutated to
`>`, exactly the "exactly equals" test fails (`1 failed | 17 passed`); restored, 18 pass.

## The exact typed reason value (for B7)

```ts
export type PayerSwitchReason = 'group_headroom_insufficient';
```

- **Value: `'group_headroom_insufficient'`** — the only member of the union.
- **Where it appears:** `FundingDecision`'s `self` arm as `payerSwitch: PayerSwitchReason | undefined`
  (required property, so the core must state it), and on `ResolveBillingResult`'s **approved** arm
  as `payerSwitch?: PayerSwitchReason`.
- **When it is set:** exactly when a non-solo turn's headroom did not cover the turn and a
  signed-in sender self-funds. One value deliberately covers **both** B7 shapes — an allowance
  that ran out (headroom 0) and one never granted (no budget row, also headroom 0) — plus the
  new case (positive headroom below the estimate), because §Notices 5's disclosure is identical
  in all three: the sender is about to be charged.
- **When it is absent:** a solo self-funded turn (`undefined`), an owner-funded turn (no such
  field on the `owner` arm), and any refusal — a refused send carries its refusal reason
  instead, so `MODEL_TIER_LOCKED` / `insufficient_balance` / `guest_budget_exhausted` never
  carry a switch disclosure.
- Exported from `@hushbox/shared` and the `@hushbox/shared/affordability` barrel via the
  existing `export *` on `billing/funding-decision.js`.

## Files changed

| File                                                              | Why                                                                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/shared/src/affordability/billing/funding-decision.ts`    | `FundingInputs.turnEstimateNanoUsd`; `coversTurn()`; `PayerSwitchReason`; `payerSwitch` on the self arm. |
| `packages/shared/src/affordability/billing/funding-decision.test.ts` | Boundary, unpriced-query, guest-refusal and solo-no-switch pins; two fall-through pins updated.    |
| `packages/shared/src/affordability/billing/funding-decision.contract.test.ts` | Three new matrix rows (priced covered / priced short / guest priced short) run through both legs; existing rows carry the new field. |
| `packages/shared/src/affordability/billing/client-billing.ts`      | `ClientFundingContext.estimatedMinimumCostNanoUsd` crosses into the core; `payerSwitch` surfaced on the approved arm. |
| `packages/shared/src/affordability/billing/client-billing.test.ts` | Client-side boundary pins, guest refusal, denied-fall-through-carries-no-switch, derive pin.        |
| `apps/api/src/slices/chat/domain/turn-context.ts`                  | Contract sweep: the two `FundingDecisionInputs` literals state `turnEstimateNanoUsd: undefined`, with the ordering fact that makes it unavailable. |
| `apps/api/src/slices/billing/domain/spendable.ts`                  | Contract sweep: the served-snapshot query states `turnEstimateNanoUsd: undefined` (no turn priced). |

`turnEstimateNanoUsd` is a **required** property typed `bigint | undefined`, so under
`exactOptionalPropertyTypes` typecheck names every construction site rather than letting one
be forgotten — the precedent F1 set for its own required dependency. `undefined` means *no
turn is being priced* (the caller asks only who **would** pay); it is deliberately not an
amount, so an unpriced query cannot be mistaken for a free turn.

## Client/server parity — the same core, both callers

`funding-decision.contract.test.ts` is the pin: each row supplies **server** primitives and
**client** served numbers independently, then asserts `resolveFundingDecision(serverInputs)`
and `resolveFundingDecision(deriveClientFundingInputs(clientInputs))` both equal the same
expected decision, plus that `resolveClientBilling(clientInputs)` maps it to the expected
funding source. The three rows added exercise the new comparison on both legs:

| row                                        | server `turnEstimateNanoUsd` | client `estimatedMinimumCostNanoUsd` | expected                            |
| ------------------------------------------ | ---------------------------: | -----------------------------------: | ----------------------------------- |
| headroom exactly covering the turn estimate |                       `ONE` |                               `ONE` | `owner` / `owner_balance`            |
| headroom one nano below the turn estimate   |                       `ONE` |                               `ONE` | `self` + `payerSwitch` / `personal_balance` |
| link guest, headroom below the estimate     |                       `ONE` |                               `ONE` | `refuse GROUP_BUDGET_EXHAUSTED` / `denied guest_budget_exhausted` |

(with `memberRemaining = conversationRemaining = ownerBalance = ONE` or `ONE - 1n`.) The
client leg reaches the core only through production code — `deriveClientFundingInputs` maps
`estimatedMinimumCostNanoUsd → turnEstimateNanoUsd` itself, so the test duplicates no mapping.

## Positive evidence that the unchanged outcomes are unchanged

The risk this addresses: a test that passes because both branches now return the same thing.

- **Owner funding still happens.** 7 pre-existing owner-funded assertions pass untouched
  (positive headroom, tightest-conversation, tightest-owner-balance, premium exemption, guest
  with headroom) — all with `turnEstimateNanoUsd: undefined`, plus the new *priced* row where
  headroom exactly equals the estimate. If the comparison had collapsed to "never fundable",
  every one of these would be red.
- **Fall-through still reaches personal funds with the same wallet and premium verdict.** The
  two pre-existing fall-through assertions still assert `self`/`purchased`/`premiumAllowed:true`
  and `self`/`free`/`premiumAllowed:false` respectively; only the new `payerSwitch` field was
  added to them. The new boundary row independently lands on `self`/`purchased`.
- **Guest refusal is still a refusal, and still `GROUP_BUDGET_EXHAUSTED`.** Pre-existing
  exhausted-headroom guest row unchanged; the new priced-short guest row reaches the same code
  and the same wire code. Guests are *not* newly refused when headroom covers the turn (the
  "owner-funds a link guest when group headroom is positive" row still passes).
- **Solo is untouched.** `toStrictEqual` pins the solo decision as
  `{payer:'self', walletKind:'purchased', premiumAllowed:true, payerSwitch: undefined}` — key
  present, value undefined — so a consumer reading `.payerSwitch` sees "no disclosure" rather
  than a missing field, and a future change that leaked the reason onto solo turns fails.
- **A refused fall-through carries no disclosure.** `group headroom below the estimate and no
  personal funds → insufficient_balance` asserts the exact denied object, so `payerSwitch`
  cannot leak onto a refusal arm.
- **The server send path is behaviourally unchanged** (see §Deviations): both api literals pass
  `undefined`, so `resolvePayerWallet` and the premium tier gate resolve exactly as before —
  evidenced by `turn-context.test.ts` (11 funding-decision assertions) and the chat route
  integration tests passing with no edits.

## Tests added

| Test                                                                                     | Behaviour                                                          | Criterion |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------- |
| `funding-decision` — owner-funds when the headroom exactly equals the turn estimate       | inclusive boundary                                                  | 1         |
| `funding-decision` — falls through when the headroom is one nano below the turn estimate  | exclusive boundary + reason emitted                                 | 1, 3      |
| `funding-decision` — refuses a link guest whose headroom is positive but below the estimate | guest refusal extends to insufficient (not just exhausted) headroom | 1, 2      |
| `funding-decision` — owner-funds on positive headroom when no turn is priced              | the unpriced query keeps the payer-identity answer                  | 1         |
| `funding-decision` — never owner-funds exhausted headroom, even against a zero estimate   | the `headroom > 0` clause survives an estimate of `0n`              | 1, 2      |
| `funding-decision` — marks no payer switch on a solo turn                                 | solo carries no disclosure                                          | 3         |
| `client-billing` — group headroom exactly covering the estimate → `owner_balance`          | boundary through the client shell                                   | 1         |
| `client-billing` — one nano below → `personal_balance` with the payer switch               | boundary + reason through the client shell                          | 1, 3      |
| `client-billing` — below the estimate and no personal funds → `insufficient_balance`       | a refusal carries no disclosure                                     | 2, 3      |
| `client-billing` — guest whose headroom is below the estimate → `guest_budget_exhausted`   | guest refusal through the client shell                              | 2         |
| `client-billing` — feeds the served estimate to the core as the turn estimate              | the amount actually crosses into the core                           | 1         |
| `funding-decision.contract` — 3 new matrix rows                                            | client and server reach the identical verdict                       | 1, 2, 3   |

TDD: every one of these was watched red first. Core batch: `6 failed | 12 passed`, failures
reading "expected owner, got self", "missing payerSwitch", "expected refuse, got owner".
Client batch: `5 failed | 31 passed`. The two "already green" boundary rows (exact-equality)
were proved discriminating by the `>=` → `>` mutation described above.

## Self-gate

| Command                                                             | Result                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm typecheck` (repo-wide, 16/16 uncached)                          | **pass** — 16 successful, 0 cached                                 |
| `pnpm test:shared`                                                   | **pass** — 115 files, 2806 tests, coverage gate clean              |
| `pnpm test:api`                                                      | **pass except one pre-existing file** — 465 passed / 1 failed (6391 passed, 7 failed) |
| `pnpm test:web`                                                      | **393 files / 6412 tests pass**; run exits 1 on one pre-existing per-file coverage gate |
| `npx eslint <5 shared files>` from `packages/shared` (after last edit) | **pass** — exit 0                                                  |
| `npx eslint <2 api files>` from `apps/api` (after last edit)          | **pass** — exit 0                                                  |
| billing-scope coverage (`src/affordability/billing/**`)              | **100%** statements / branches / functions / lines                 |

### Failures, attributed

1. **`apps/api` `notifications/domain/templates/template-html.test.ts` — 7 snapshot failures**
   over a removed Google-Fonts `<link>`. This is §Known Breakage verbatim ("belongs to the
   concurrent push/notifications workstream", "a single `apps/api` failure a scoped run will
   show"), and the observed shape matches its note exactly (465 other files green). Nothing in
   my change reaches email templates.

2. **`apps/web` coverage gate on `src/components/chat/message/markdown-renderer.tsx`**
   (branches 75% < 95%) while all 393 files pass. §Known Breakage names this file and instructs
   re-running in isolation before attributing: run alone it reports **100% branch (16/16)**,
   i.e. only the full-suite denominator differs. A file this task never touched.

3. **Transient, resolved during the session: `packages/shared` `dimensions/derive.test.ts`**
   (`reserveContribution` returning `{kind:'money'}` where `moneyPerToken` was expected) failed
   on the first `test:shared` run. Attributed to concurrent B2 work, not this task:
   `derive.ts`, `derive.test.ts` and `dimensions/types.ts` were being rewritten *during* this
   session (mtimes 04:56–04:57, after my last shared edit at 04:50), `derive.ts` imports none
   of the files this task touched, and a funding decision cannot alter a dimension's reserve
   kind. The final `pnpm test:shared` run is fully green (115/115), so B2's fixer landed.

## Acceptance criteria

1. **Priority 1 compares the estimate against headroom; a test pins the boundary (one nano
   below is not fundable, exactly equal is)** — **met.** `coversTurn(headroom, estimate)` in
   `funding-decision.ts`; both amounts pinned at core, client-shell and contract level; the
   inclusive comparison proved load-bearing by mutation.
2. **The fall-through and guest-refusal outcomes are unchanged; pinned** — **met.** See
   §Positive evidence. No pre-existing assertion about payer, wallet kind, premium verdict or
   refusal code changed; the only edits to existing assertions add the new `payerSwitch` field
   to the two fall-through rows.
3. **F2 produces the fall-through outcome and its typed reason (no notice verification)** —
   **met.** `'group_headroom_insufficient'`, documented above, carried on the core decision and
   on the client result; no copy, no notice module touched.

## Deviations

- **Two files outside F2's Files list were edited**: `apps/api/src/slices/chat/domain/turn-context.ts`
  and `apps/api/src/slices/billing/domain/spendable.ts`, one line plus a comment each. Adding a
  required member to `FundingInputs` is exactly the contract change Global Constraint 10
  anticipates; leaving them unedited would have shipped a red repo-wide typecheck (the failure
  mode §Known Breakage records for A1). No behaviour changes there: both pass `undefined`.
- **`ResolveBillingResult.payerSwitch` is an optional property, not required-with-undefined**,
  unlike the core's field. It is an output read by consumers rather than an input every caller
  must state, and making it required would have forced edits to ~20 `toEqual<ResolveBillingResult>`
  literals across shared and web for no added guarantee. Absence means "no payer switch".
- **`selfFunding`'s third parameter is optional** (`payerSwitch?:`) rather than
  required-with-undefined: `unicorn/no-useless-undefined` rejects the trailing `undefined`
  argument at the solo call site. The *property* on the decision stays required.

## Concerns and limitations

1. **The server's send path does not apply priority 1's estimate clause** (raised). It cannot,
   at that point: `resolveTurnContext` freezes the payer wallet *before* the turn is priced,
   because the turn's output ceiling is bounded by what the payer can pay (`budget.funding =
   context.funding` in `chat/routes.ts`), so the estimate depends on the decision. Today a
   member with positive-but-insufficient headroom is still owner-funded server-side and then
   refused by admission's per-scope check — which §Group Funding 6(b) rules a hard refusal, but
   the matrix says a signed-in member should **fall through to personal funds**. Closing that
   needs the catalog read and a minimum-estimate computation hoisted ahead of the payer freeze,
   at the owner's (paid) tier — a chat-slice restructure, outside this task's ownership.
2. **The premium tier gate is estimate-blind for the same reason.** `tierGateRejection` exempts
   any caller the baseline decision calls owner-funded; with insufficient headroom the member
   actually self-funds, so priority 2 should apply. Unchanged by this task, same owner as (1).
3. **The served snapshot's `payer`/`tier` remain estimate-blind** (F1's contract). On a
   fall-through the client is served `payer: 'owner'` / `tier: 'paid'` and sizes the turn at the
   owner's ratios while the member pays. The *verdict* is correct (`useModelFloor` already
   compares the caller's own spendable); only the sizing ratio diverges. F1/E-lane territory.
4. **B7 must not treat `payerSwitch` as "allocation ran out"** — it also fires for a member who
   never had an allocation and for one whose remainder is positive but too small, and §Notices 6
   forbids naming the amount, so one wording must cover all three.

## Confidence

**High.** The change is ~10 lines of decision logic in a pure module with 100% branch coverage
over the touched scope, the boundary is pinned by amount at three levels and proved
discriminating by mutation, both callers of the core are exercised by the contract matrix, and
repo-wide typecheck plus all three scoped suites are green apart from two failures the plan
already documents as belonging to other workstreams.
