# E1 — impl report 1 (NEEDS_CONTEXT, zero production files changed)

## Objective

Every client surface renders the produced `affordable` / `admissible` sets, premium rows MARKED
rather than removed, and the second verdict engine (the prompt-budget hook's floor computation,
candidate-pool builder and token-pricing builder) deleted.

## Status

**NEEDS_CONTEXT.** No production file changed; no test changed. Three of E1's criteria cannot be
satisfied inside the granted glob (`apps/web/**`), and two of them are load-bearing on E1's
*first* criterion — "all greying derives from `affordable`; the send gate from `admissible`" —
so building against a guess would fix the shape of the adapter hook and of every surface's props
against an answer the orchestrator has not given. Each blocker below is proven by a named input
that flips the assertion, not asserted.

## Method note

The three findings were produced by running `getTurnOptions` directly, not by reading it. A
throwaway probe (`apps/web/src/hooks/billing/scratch-probe.test.ts`) called the barrel export
with hand-built `FundingSnapshot` / `PriceableModel` / `Selection` fixtures and dumped the
returned `OptionSet`s. The probe was **deleted** after the run; `git status` for `apps/web` and
`packages/shared` is byte-identical before and after (see §Working-tree note).

---

## Blocker 1 — a FREE payer has no served funding number, so `affordable` greys every model

`docs/BILLING.md` §Funding defines `effectiveBalance` as "paid: `balance + cushion` · **free:
`allowance`** · trial/guest: a fixed per-message ceiling", and §Funding closes the loop with "Both
funding numbers are derivable from what the wire already serves: `GET /billing/spendable` returns
`spendableNanoUsd` and `heldNanoUsd` … **No additional field and no second request exist for
this.**"

That is not true of the free tier today. `apps/api/src/slices/billing/domain/spendable.ts`
`readSelfFunding` reads the caller's **purchased** wallet and says so in its own comment: "the
free-tier daily allowance is a budget scope, not a balance — it rides the budgets endpoint, never
this number." `tierForBalance` then returns `free` for a zero purchased balance. So the snapshot a
free payer receives is `{ spendableNanoUsd: '0', heldNanoUsd: '0', tier: 'free', payer: 'self' }`.

Probe result for exactly that snapshot (text modality, one priceable model, 1,000-char basis):

```
FREE affordable { "sendable": false, "refusal": "insufficient_funds",
                  "all": [ { kind: "pinned", availability: { available: false,
                                                             reason: "insufficient_funds" } } ],
                  "turnDimensions": [] }
```

The identical call at `tier: 'paid'` with funds returns `sendable: true` and an available row, so
the funding number is the only thing that moves the assertion. Consequence if E1 ships as
specified: **every model greys and every send is refused for every free-tier user.**

The allowance figure does exist client-side — `useBalance()` →
`balanceData.allowance.remainingNanoUsd`, which is what `useUserTierInfo` /
`useBudgetCalculation` read today. Using it is what E1's own third criterion forbids ("No surface
derives funding … from the balance endpoint") and what §Affordability 4 forbids ("`GET
/billing/balance` … is **not** an affordability input"). So the free arm has no legal input.

**Not resolvable in `apps/web/**`.** The fix is in `apps/api/src/slices/billing/domain/spendable.ts`
(+ the shared response schema if a field is added), which is out of my grant and is where C3 is
concurrently working.

**No task owns it.** `plan.md` contains **zero** occurrences of "allowance", "free tier" or
"free-tier" (verified by grep over all 3,271 lines). Per §completeness-contract this is a
normative clause with no owning task — a planning defect to report, not a clause to route around.

Decision needed: either (a) `/billing/spendable` serves the free payer's allowance-derived
hold-aware figure as `spendableNanoUsd` (making the served snapshot mean what §Funding says for
all four tiers, and giving E1 one input), or (b) an explicit ruling that the free arm's
`effectiveBalance` is composed client-side from a second served value, in which case name the
value and the endpoint — because that composition is a second funding authority and E1 exists to
delete the second authority, so it must not be my invention.

## Blocker 2 — `getTurnOptions` refuses every non-text modality with an EMPTY option set

`packages/shared/src/affordability/turn-core.ts` `evaluateTurn` opens with
`if (selection.modality !== 'text') return refused('modality_not_priceable', [], [])`. Probe
result, paid payer with $10 spendable, image modality:

```
IMAGE affordable  { "sendable": false, "refusal": "modality_not_priceable",
                    "all": [], "turnDimensions": [] }
IMAGE admissible  { "sendable": false, "refusal": "modality_not_priceable",
                    "all": [], "turnDimensions": [] }
```

So on image / video / audio the produced sets carry **no rows to render and no sendable arm**.
Taken literally, E1's first criterion makes every media turn unsendable and hands the picker zero
rows on a media modality.

There is a plausible narrower reading — that E1 migrates the **text** path only — supported by two
signals: E1's own criterion "**No text-modality surface** renders a pre-send cost figure (§Affordability
11); **media still may**", and the ownership table handing `use-media-cost-estimate.ts` to **G2**
rather than to E1, i.e. the media estimate hook is expected to outlive E1. But that reading
directly weakens E1's second criterion: `resolveEstimatedCostNanoUsd`, `buildMediaRateArrays` and
`buildModelTokenPricing` in `use-prompt-budget.ts` are precisely the "pricing builder" the criterion
says must be **gone**, and they exist to serve the media arm. So under the narrow reading the
pricing builder survives E1, and criterion 2 is met only for text.

Nothing else in the plan closes this either: **E4**'s Files list is
`packages/shared/src/affordability/dimensions/**`, the conversations schema,
`turn-definition.ts` and the modality panel — **not** `turn-core.ts` — so no task currently makes
`evaluateTurn` price a media turn.

Decision needed: is E1 scoped to the text modality, with the media composer left on the estimate
path until E4 (and criterion 2 read as "deleted for text")? If yes, say so explicitly and name
which of the three builders is allowed to survive, because the difference is the difference
between one verdict engine and two.

## Blocker 3 — the remaining trial message count is not on the wire at all

Criterion: "**The remaining trial message count reaches the client and renders before it binds**
(§Trial Usage)" — §Trial Usage: "The remaining message count is presented before it binds. A quota
that is invisible until the send fails is a refusal the user could not have anticipated."

Verified reach of the count: `TRIAL_MESSAGE_LIMIT` (`packages/shared/src/affordability/tiers.ts:18`)
is consumed in exactly one production file, `apps/api/src/slices/chat/domain/trial-quota.ts:79`,
which returns `{ allowed, count }` to `apps/api/src/slices/chat/routes.ts:1339-1346`. The route
uses it only to emit `429 TRIAL_LIMIT_REACHED`. No response schema carries a remaining count, and
no `apps/web` file references one.

So "reaches the client" is a new served field: `apps/api/**` plus a shared Zod schema plus the
typed client, plus Global Constraint 10's repo-wide sweep. All outside `apps/web/**`, and
`apps/api/**` is C3's concurrently.

---

## What IS buildable, recorded so the next cycle does not re-derive it

Verified against the current tree, so a resumed E1 starts here rather than re-reading 23k lines.

**The verdict engine to delete — exact symbols, all in `apps/web/src/hooks/billing/use-prompt-budget.ts`:**

| Plan's name          | Symbol                                                            |
| -------------------- | ----------------------------------------------------------------- |
| floor computation    | `modelFloorNanoUsd` (`:633`) + `useModelFloor` (`:676`), `ModelFloorResult`, `UseModelFloorInput`, `ModelFloorGroupContext` |
| candidate-pool builder | `smartModelPoolFromCatalog` (`:336`), `smartModelMinimumNanoUsd` (`:395`) |
| token-pricing builder  | `buildModelTokenPricing` (`:316`), `buildMediaRateArrays` (`:229`), `resolveEstimatedCostNanoUsd` (`:367`), `reasoningBudgetInput` (`:294`) |

`MODEL_BELOW_FLOOR_REASON` (`model-list-item.tsx:118`) and `EFFORT_DISABLED_REASONS`
(`reasoning-effort-menu.tsx:30`) are the locally-authored copy that must become
`noticeText(reason)`; `ModelItemOverlay` (`model-list-item.tsx:20-51`) is the named third phrasing
("Top up … to unlock" / "Sign up … to access") of `premium_requires_credit` /
`premium_requires_account`.

**Vocabulary grep set for the post-removal sweep** (per §Known-Breakage's standing rule — key on
what changed, not on where the diff is): `useModelFloor`, `isBelowFloor`, `belowFloor`,
`showFloorGrey`, `data-below-floor`, `MODEL_BELOW_FLOOR_REASON`, `EFFORT_DISABLED_REASONS`,
`canAccessPremium`, `maxOutputTokens`, `estimatedInputTokens`, `offeredEffortLabels`,
`serverAcceptsChoice`, `smartModelPool`, `modelFloorNanoUsd`, `floor`.

**Copy source, correcting the brief.** The brief asks that every user-facing string trace to
`ERROR_MESSAGES` in `packages/shared`. The actual single home for money copy is `NOTICE_COPY` /
`noticeText(reason)` / `notices(reason)` in `packages/shared/src/affordability/notices.ts`;
`ERROR_MESSAGES` (`packages/shared/src/error-codes.ts:228`) itself *derives* from `noticeText`. Since
`REFUSAL_CODES ⊂ NOTICE_REASONS` and `NOTICE_COPY` is a total `Record<NoticeReason, NoticeCopy>`,
every reason a row or option can carry already has copy — **no missing-copy blocker exists**, which
is the other half of the brief's NEEDS_CONTEXT trigger and is hereby cleared.

**The barrel already expresses the rest.** `turnDimensions` (`turn-core.ts:631`) is AND-over-pinned
inside OR-over-candidates, which is criterion 5's existential enable rule and retires
`offeredEffortLabels`' intersection clamp without new arithmetic. `all` covers every catalog model
(`planSiblings`: `candidatePool = catalog − pinned`, plus pinned and unpriceable rows), so the picker
has one row per model. `tierAxisBlock` (`turn-core.ts:384`) produces `premium_requires_account` /
`premium_requires_credit` / `trial_message_cap_exceeded`, so premium marking needs no client
derivation. Confirmed: no client re-derivation of the premium verdict is required or wanted.

**`nowMs` (the served-value contract §B8 routes to E1 by name).** The intended shape, unbuilt: one
session-stable instant captured once per mount (a `React.useRef(Date.now())` / module-level
constant threaded into `CatalogSnapshot`), never `Date.now()` at call time — because
`turn-types.ts` documents `affordable` as keystroke-stable and a per-render instant churns the memo
key of a set whose whole contract is that it does not move while the user types. Nothing was
written, so nothing is claimed as satisfied.

**Out-of-grant threading E1 will hit.** Removing `canAccessPremium` from the picker's prop chain
reaches `components/chat/layout/chat-header.tsx:40,66`,
`components/chat/layout/chat-layout.tsx:293,356`,
`components/chat/layout/chat-layout-helpers.ts:50,68,108`, and
`components/chat/page/chat-welcome.tsx:125,174` — the last of which computes
`canAccessPremium = isAuthenticated && balance > 0` **from the balance endpoint**, exactly what
criterion 3 forbids. None of those four files is in E1's Files list. They need adding to E1's
grant or an owner named.

**Walled-subpath inventory in `apps/web` (for B8b's empty-inventory gate).** Production: 7 in
`use-prompt-budget.ts`, 5 in `use-budget-calculation.ts`, 2 in `use-reasoning-effort.ts`, 2 in
`reasoning-effort-menu.tsx` — all E1's; 3 in `use-media-cost-estimate.ts` — **G2's**. Tests: 7 in
`use-prompt-budget.test.ts`, 5 in `use-budget-calculation.test.ts`, 1 in
`reasoning-effort-menu.test.tsx`. So E1 can clear 16 production + 13 test references and cannot
clear the 3 in G2's file.

## Working-tree note

`git status` before my first action and after the probe's deletion are identical. Four files inside
E1's ownership were **already modified at HEAD** when I arrived, and they are B7/B8 rename fallout,
not mine: `use-resolve-billing.ts` (one comment, `resolveFundingDecision` → `resolveFunding`),
`use-prompt-budget.test.ts`, `budget-messages.test.tsx`, `prompt-input.test.tsx` (notice-copy and
rename updates). Also worth flagging: §git-baseline's claim that "the working tree is nearly clean
of this run's code — one two-line comment in `affordability/turn-core.ts`, plus doc files" is
**stale** — `packages/shared/src/affordability/**` carries B8's uncommitted work across dozens of
files.

## Self-gate

None run. No file changed, so there is nothing to gate; claiming a green suite here would be
claiming a run that proves nothing about work not done.

## Acceptance criteria

Every criterion: **not met** — no code written. The three above are blocked as described; the
remainder are unblocked but were deliberately not started, because the free-tier funding contract
(Blocker 1) and the text/media scope (Blocker 2) fix the shape of the adapter hook and of every
surface's props, and building the surfaces first is what turns one decision into a re-plumbing
cycle.

## Concerns and limitations

- Blocker 1 is the severe one: shipping E1 without it converts a working free tier into a fully
  greyed picker with a refused send. It is also the shape §Known-Breakage warns about — a criterion
  ("all greying derives from `affordable`") that *passes* while the product breaks.
- Blocker 2 is a scope ruling rather than a missing mechanism; a one-line answer unblocks it.
- Blocker 3 blocks one criterion only and could be split to a task owning `apps/api` + the schema.

## Confidence

**High** that the three blockers are real and correctly attributed — each is a probe result or an
exhaustive grep with file:line, not an inference. **High** that stopping was correct: two of the
three change the shape of the work rather than adding to it.
