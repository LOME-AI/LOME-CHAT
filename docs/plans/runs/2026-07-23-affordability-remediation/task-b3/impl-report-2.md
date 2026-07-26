# B3 — `getTurnOptions`: one producer, two sets — implementation report 2

## Objective

Six validated findings against report 1's contract: the non-monotone grading arrangement
(1), the effort-pin refusal on a model with no rung (2), the under-asserted properties (3),
the vocabulary/estimator ruling (4), the refusal enum's missing tier axis (5), and the
`OptionSet` union's entry-less unsendable arm (6). The arithmetic itself was not in question
and no amount moved except where a finding required it.

## Files changed

| File                            | Why                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `turn-core.ts`                  | Findings 1, 2, 4, 6: grading split from hold pricing, empty effort support resolves instead of refusing, predicates called rather than inlined, entries on both union arms. |
| `turn-arithmetic.ts`            | Finding 4: `costNanoUsd` delegates to the estimator; `requiredCeilingTokens` is the one home of `B + MINIMUM`; `feasible`/`eligible` read it. |
| `turn-types.ts`                 | Findings 5, 6: three tier-axis refusal codes; `all` + `turnDimensions` on both arms.                                             |
| `turn-core.test.ts`             | Finding 2's tests, finding 6's tests, the deleted agreement test, refusal assertions through one helper.                          |
| `turn-arithmetic.test.ts`       | `CostContext` gains `inputChars`; the manifest-and-fold pins; `requiredCeilingTokens`.                                            |
| `turn-types.test.ts`            | The tier axis and its precedence.                                                                                               |
| `turn-options.property.test.ts` | Finding 3: option-level and ceiling-level subset, smart-slot draws with counted controls, the exact repro, a funding sweep.        |

No file outside `packages/shared/src/affordability/turn-*` was touched. Nothing in the repo
imports these four modules yet (grep across `apps/`, `packages/`, `scripts/`, `e2e/` finds
only their own tests), so every type change below has zero live consumers.

## Finding 1 — the monotonicity argument

**Chosen arrangement: a pinned sibling is graded on the pinned siblings' own arrangement.**
Every entry is now graded on an arrangement whose **membership is fixed by the selection**:
a pinned sibling on `pinned` alone, every other catalog model on `pinned + itself`. The hold
is unchanged — still the `MAX` over candidate arrangements (worst viable), now read only
after the turn is known sendable.

**The argument.** For an arrangement of fixed membership `S`:

- `fixedCosts(S)` = Σ input legs + `inputStorage` + `classifierReserve` + additive. None of
  its terms reads the funding. `Σ variableRate(S)` reads rates and tier only.
- `sharedTokens(S) = floor((funding − fixedCosts(S)) / Σ variableRate(S))` is therefore
  **non-decreasing in funding** and, because a larger basis raises `inputTokens` (ceil is
  monotone) and `inputStorage`, **non-increasing in basis**.
- `contextHeadroom(m) = max(0, contextLength − inputTokens)` is non-increasing in basis and
  independent of funding. `providerCap(m)` is a constant.
- `ceiling = max(0, min(cap, headroom, sharedTokens))` — a min of monotone terms — is
  non-decreasing in funding and non-increasing in basis.
- The thresholds are funding- and basis-**independent**: `requiredCeilingTokens(m, e) =
B(m, e) + MINIMUM_OUTPUT_TOKENS`. So `feasible` and `eligible` are monotone in the
  ceiling, hence in `(funding, basis)`; entry availability, option availability and
  `sendable` follow. Since `affordable = (effectiveBalance ≥ spendable, empty basis ⊆ real
basis)`, every affordable ceiling ≥ its admissible counterpart and no availability is
  gained — `admissible ⊆ affordable` per model **and** per option.

**Why the two alternatives are not monotone**, both measured, not argued:

1. _Worst viable candidate_ (report 1's behaviour). Viability is a function of funding and
   basis, so the identity of the arrangement changes with them: a richer pass clears a
   costlier candidate into viability and then solves fewer shared tokens.
2. _Worst over ALL candidates_ (the brief's second suggestion). Rejected on measurement: an
   unclamped arrangement's total is `funding − ((funding − fixedCosts) mod Σrate)`, so the
   costliest arrangement is decided by a modulus and its identity flips arbitrarily as the
   funding moves. Running the **final** property file against this variant leaves 5 of 6
   properties red, including the pure funding sweep (`expected 1019 to be greater than or
equal to 3236`).

**The exact repro, before and after.** `pinned=['vendor/a-cheap']`, `smartSlot: true`, basis
`{2000,500,40000,1000,0}`, paid, spendable `93_000_000n`, held `0n`:

| | `affordable` ceiling | `medium` | `admissible` ceiling | `medium` |
| ------------- | -------------------- | -------- | -------------------- | -------- |
| report 1 | 8941 | greyed | 13291 | available |
| now | **64000** | available | **64000** | available |

Pinned as `solves the pinned sibling's own arrangement, not the one the hold is sized for`
and `never greys a rung in the picker that the send gate offers`. 64,000 is the model's
provider cap: at this balance the pinned turn can buy the model's full output capability,
which is what §Model bounds says a payer who can pay for it gets.

**The deliberate consequence, stated in the code.** When the smart slot resolves to a
candidate the shared token count shrinks, so a pinned sibling's delivered ceiling can be
below the one presented. That is visible where §The four notions asks for it — each
candidate entry carries the ceiling of the arrangement it would create (notion 3, "up to
what ceiling each") — and the hold still covers the worst of them. The alternative
(presenting the worst case) is the non-monotone one, and §Affordability 6 forbids a rising
balance from shrinking what is presented.

## Finding 2 — the effort-pin refusal

`effortGate` now returns `resolvable: true` when a model offers no rung, for a pin as well
as for Auto; `reasoningBudgetTokens` already returns 0 there, so nothing about the
arithmetic moved. Justification: the menu is the **union** of the selection's offered rungs
(§Reasoning Effort 4), so refusing a rung the same call marks available violates §Reasoning
Effort 3 outright; per-model resolution onto an empty ladder is the declared mapping of
§Reasoning Effort 10(a), not a substitution of the turn's choice; and §Reasoning Effort 9
already says a model that cannot reason records no level.

`option_not_offered` stays reachable and is **not** dead: resolution is total over the
declared domain (the off rung is offered whenever reasoning exists and is not mandatory; a
mandatory ladder resolves upward to its lowest rung), so the reachable case is a pinned id
**outside the domain** — which fails closed rather than dropping a parameter the caller
asked for. The old test's fixture (a non-reasoning model pinned `high`) was replaced by that
shape; that replacement passed on first run, because it pins behaviour the code already had.

Tests added, all watched red first (`expected false to be true` — the turn was refused):

- a non-reasoning model sends at every one of the six pins;
- a mandatory-reasoning model with one native level (§Reasoning Effort 2's "offers no
  choice") sends at every pin;
- **the heterogeneous pin, as a biconditional:** for a `[3-rung, non-reasoning]` selection,
  `sendable` at a pin equals that rung's availability in the same fixture's Auto menu, with
  both sides of the biconditional required to occur (`high` is genuinely infeasible there —
  its budget clamps to the 32,000 cap and leaves no minimum answer — so the test proves the
  menu and the gate agree rather than that everything sends);
- a pin on a model with no rung reserves nothing: the ceiling equals the Auto ceiling.

## Finding 3 — the strengthened properties, with pre-fix evidence

Three changes, and the evidence that each was needed:

1. `expectSubset` now asserts **option** availability and **ceilings** on every model, not
   just model availability. §Math & Terms states the ceiling half explicitly ("every ceiling
   in the admissible set is therefore ≤ its affordable-set counterpart"), and it is the
   quantity both availability halves derive from.
2. The basis-leg property calls `expectSubset` instead of only `availabilityOf` — the repro
   lands at held `0n`, which is exactly that property's regime.
3. The 400-draw generator now draws a smart slot beside pinned siblings deliberately
   (`rng() > 0.35`) and **counts** two controls that must be non-zero: draws with a smart
   slot beside a pinned sibling (> 20) and draws where the two passes disagree about which
   candidates could fill the slot (> 5) — the observable face of candidate viability
   flipping between the passes.

Plus three new pins: the exact repro, its option-level counterpart, and a 601-step funding
sweep asserting a pinned sibling's ceiling never shrinks as the balance rises
(§Affordability 6 in contrapositive form).

**Red against the pre-fix code.** The final property file, run against report 1's grading
(the only inversion applied — `entriesFor` fed the worst-viable-candidate arrangement):

```
5 failed | 1 passed (6)
× holds over 400 generated funding/prompt/selection triples      expected 6903 to be >= 13706
× never gains availability or ceiling from a longer prompt        expected 49529 to be >= 64000
× solves the pinned sibling's own arrangement                     expected 8941 to be 64000
× never greys a rung in the picker that the send gate offers      expected false to be true
× never shrinks a pinned sibling's ceiling as the balance rises   expected 1132 to be >= 2063
```

The one that still passes is `options are marked, never filtered`, which is orthogonal.
Against the worst-over-all-candidates variant the same file is also 5 failed | 1 passed.

## Finding 4 — the vocabulary and the estimator

- `turn-core` **calls** the predicates. Three inlined copies of `B + MINIMUM ≤ ceiling` are
  gone: `priceArrangement`'s viability test, `siblingBlock`'s entry test and
  `optionAvailability`'s option test all call `feasible(model, option, ceiling)`.
  `gateBudgetTokens` is deleted.
- `eligible(m, ceiling)` is now `feasible(m, cheapestEffortOption(m), ceiling)` — one line,
  no branch of its own. `feasible` accepts an absent option ("no rung applies"), which is
  what let the branch collapse. B5 consumes `eligible(m)` by name and it is live: it is what
  `siblingBlock` evaluates whenever the turn leaves effort open.
- `requiredCeilingTokens(model, option?)` is the single home of `B(m, e) +
MINIMUM_OUTPUT_TOKENS`. `feasible` tests it; `boundReason`'s caller reads the same number to
  name which bound refused, instead of re-adding the sum.
- `costNanoUsd` **delegates**: it folds `siblingLineItems(model, context)` through
  `evaluateManifest`. `siblingLineItems` moved from `turn-core` into the vocabulary and is
  the only construction of a per-sibling manifest, so `priceArrangement`'s per-sibling total
  is now literally `costNanoUsd(sibling, ceiling, costContext)` — the vocabulary term is a
  live production call site, and there is one pricing implementation with two readers (the
  amount and its breakdown).
- The agreement test (`equals cost(m, ceiling(m)) when folded through the canonical
  estimator`) is **deleted**. It is replaced by an amount pin: the same turn's total is
  `21_350_000n`, with the derivation in the comment. A literal is a real constraint; an
  agreement between two implementations of one formula is the artifact CODE-RULES bans.
- `CostContext` gains `inputChars`, so the "prompt storage is carried by the first sibling
  only" rule is expressed in the type the estimator consumes rather than in a boolean
  parameter.

## Finding 5 — the refusal enum's tier axis

Three members added, one per live phrasing B7 must collapse:
`premium_requires_account` (`PREMIUM_REQUIRES_ACCOUNT`), `premium_requires_credit`
(`MODEL_TIER_LOCKED`), `trial_message_cap_exceeded` (`TRIAL_MESSAGE_TOO_EXPENSIVE`). They
sit **ahead of** the feasibility codes in `REFUSAL_CODES`, which is the precedence ladder,
because a tier lock is unconditional: no balance and no shorter prompt unlocks the model, so
a money notice would name an action that cannot help (§Notices & Refusals 3). Pinned by
`refusalPrecedence(['insufficient_funds', 'premium_requires_credit'])`.

I split the premium condition in two rather than collapsing it to one, because the **action**
differs — a payer with no account creates one; a signed-in free-tier payer adds credit — and
§Notices 2 binds one wording per _condition_, not per axis. If B7 finds one wording serves
both, the second member is a one-line deletion.

**No producer emits these yet, and that is a reported gap, not an oversight** (see Concerns).

## Finding 6 — the union's unsendable arm

`OptionSet`'s `sendable: false` arm now carries `all` and `turnDimensions`; only `runnable`
stays exclusive to the sendable arm, so "sendable with nothing runnable" is still
unrepresentable. `refused()` takes the entries and the turn-level lists, and `evaluateTurn`
computes entries **before** deciding the refusal, so a refused turn renders as a fully
greyed picker with a reason per row and per rung. Two consequences worth naming:

- The `reference === undefined` early return is gone. A turn whose smart slot has no
  candidate still refuses with `model_not_priceable` (via the existing precedence path), but
  now with its entries attached.
- `modality_not_priceable` returns empty lists, deliberately: a per-unit modality prices
  nothing token-shaped, so there is no ceiling to grade an entry on. E4 owns that.

The property sweep's `marked, never filtered` and subset checks now bind on **both** arms —
the previous `if (!set.sendable) return 0` was the test-side face of the same defect.

## Self-gate

| Command                                                    | Result                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `npx turbo test --filter=@hushbox/shared --force`            | **pass** — 123 files, 2955 tests, coverage gate green         |
| `npx turbo typecheck --force --continue`                     | **pass** — 16/16, zero cached                                 |
| `pnpm arch:check`                                            | **pass** — 11 rules over 2016 files                           |
| `eslint <7 changed files>` from `packages/shared`, after the last edit | **pass** — exit 0                                  |
| `pnpm test:api`                                              | 1 file / 7 tests fail — pre-existing, attributed below         |

Coverage of the changed files: `src/affordability` reports **100 / 100 / 100** for lines,
branches and functions, including `turn-types.ts`, `turn-arithmetic.ts`, `turn-core.ts` and
`turn-options.ts` individually. Two dead branches my restructure created were removed rather
than ignored (`holdArrangement`'s two `??` fallbacks became unreachable once it is read only
on the sendable path, and its `allCandidates` field went with them); one genuinely
unreachable guard gained a justified `v8 ignore` (`classifierEngine` cannot return
`undefined` when a classifier has been bought).

### The `apps/api` failure, attributed

`src/slices/notifications/domain/templates/template-html.test.ts` — 7 snapshot failures, 465
files passing. It is §Known Breakage's named `apps/api` entry ("the single `apps/api` failure
a scoped run will show"), `git diff --stat HEAD` over that directory is empty, and this task
touched no file under `apps/api`. Nothing in `apps/api` imports the four modules I changed.

**One unresolved observation, reported rather than excused:** an earlier full `pnpm test:api`
run in this session reported **2** failed files / 8 failed tests. I captured only that run's
tail, so the second file's identity was lost, and a clean full re-run showed 1 file / 7
tests. Consistent with §Known Breakage's load-dependent `model-catalog test lock` entry, but
I did not observe the file name and will not claim it.

`pnpm test:web` and the marketing suite were **not** re-run this cycle: no file outside
`packages/shared/src/affordability/turn-*` changed, and repo-wide typecheck is green over all
16 packages.

## Acceptance criteria

Report 1's evidence for criteria 1–14 stands except where a finding moved it; only the deltas
are restated here.

1. **`TurnOptions` pair + `holdNanoUsd`; `runnable: NonEmpty` beside `all`; no hold field on
   `OptionSet`** — **met, amended.** Per the amendment, `all` and `turnDimensions` are on both
   arms and `runnable` alone is exclusive; sendable-with-nothing-runnable and an
   affordable-side hold remain compile errors.
4. **Marked, never filtered** — **met, strengthened.** Now asserted on the unsendable arm
   too, where report 1's implementation filtered everything.
5. **`admissible ⊆ affordable` across both differing inputs** — **met, and now true.**
   Asserted at set, model, **option** and **ceiling** level over 400 draws with four counted
   controls, plus a 200-draw basis-only sweep, plus the exact repro, plus a 601-step funding
   sweep. Pre-fix red evidence above.
6. **Completeness `presented == feasible`** — **met**, unchanged fixture, and the
   biconditional is now also pinned at turn level across an effort pin (finding 2's third
   test).
8. **Vocabulary exists and every call site uses it, pinned by amount** — **met, and now
   literally true for the predicates and `cost`.** `feasible`, `eligible` and `costNanoUsd`
   are all called from `turn-core`; the amount pins are unchanged, with the turn
   total pinned at `21_350_000n` in place of the deleted agreement test.
14. **Pure, asserted structurally** — **met**, unchanged; the purity scans cover the same
    four sources and pass.

New this cycle:

- **`RefusalCode` covers the tier/premium/trial-quota axis** — **met** as an enum extension
  with precedence, pinned. Not produced (see Concerns 1).

## Deviations, with reasons

Report 1's deviations 1–3 and 5–6 stand unchanged (the fourth `catalog` argument, which the
brief confirms is necessary; `Selection.webSearch`; the non-text refusal; the marketing/web
call-site edits; the four `estimate/` repointings). New this cycle:

1. **`siblingLineItems` moved from `turn-core` into `turn-arithmetic`.** The ruling requires
   `costNanoUsd` to delegate to the estimator; keeping the manifest builder in `turn-core`
   would have made that a circular import, and the builder is the §Cost term's own line
   items. It is not on any barrel.
2. **`option_not_offered` kept rather than removed.** Finding 2 makes the empty-support case
   resolve, which leaves only an out-of-domain pin to reach the code. I kept it because that
   case is real (`OptionId` is a string, so an unknown id is representable and must fail
   closed) and pinned it; deleting a refusal reason nothing can emit would have been the
   alternative.
3. **Two premium codes rather than one** — reasoned above; B7 may collapse them.

## Concerns and limitations

Report 1's concerns 1 (live path reserves classifier storage — B5/B6), 2
(`classifierReserveChars` is blind to model descriptions — B6), 3 (engine order must stay
basis-independent — B5), 4 (`MAX_SELECTED_MODELS` unenforced), 7 (`apps/web/src/lib/tokens.ts`
dead) and 8 (no `model` entry in `turnDimensions`) all stand; **1 and 2 remain open by the
orchestrator's instruction.** Concern 6 is closed by finding 1 — and my calling its mechanism
"cosmetic" was wrong: it was the subset invariant breaking.

1. **The three tier-axis refusal codes have no producer, and closing that needs a contract
   change.** `isPremiumModel` needs a pool percentile and a release clock, neither of which
   reaches `PriceableModel` and the second of which the purity rule forbids the core from
   reading — so producing a premium reason needs a `premium` (or `releasedAt`) field on
   `PriceableModel`, a shared-type change under Global Constraint 10. **The trial code is
   cheaper:** `exceedsTrialBudget(model, systemPromptChars)` already computes exactly that
   condition from a `PriceableModel` and a char count the basis carries, so whichever task
   owns trial gating can mark it with no contract change. I did neither, because the
   criterion asked for the enum and marking premium rows changes what the picker shows.
2. **A pinned sibling's presented ceiling is optimistic when a smart slot is unresolved**, by
   the amount the slot's occupant will consume. This is the accepted side of finding 1's
   trade and is documented in `entriesFor`; the conservative alternative is provably
   non-monotone. If a founder prefers the conservative reading, the resolution is not to
   revert this but to change what the ceiling *means* for an unresolved multi-source turn —
   an §Data Structures question.
3. **`turnDimensions` is empty on an unsendable smart-slot-only turn**, because no model
   contributes to the union. Every row still carries its own greyed `dimensions`, so the
   picker renders; only the turn-level effort menu has no rows, which is honest when no model
   could answer. If a surface needs rows there, the contributor rule is the place to change,
   not the union.
4. **`reasoning-plan.ts` carries plan identifiers in comments** (`(G1)`, `(G3)`), which
   §Durable Naming forbids. Pre-existing, outside my ownership, flagged rather than edited.
5. **A mandatory-reasoning model that offers no choice now reserves `B = 0`.** It will reason
   anyway, so the answer headroom presented for it is optimistic — but not the money: total
   completion tokens are capped by the ceiling either way, so `reserve ⊇ bill` is unaffected.
   This is the behaviour the Auto path already had; finding 2 makes the pinned path match it.

## Confidence

**High** on findings 1, 3, 4 and 6. Finding 1's fix has a proof whose every premise is a
property of the code (membership fixed by the selection; funding-independent thresholds), both
rejected alternatives were measured red against the same properties, and the properties that
now guard it were watched red first. Finding 4 is structural and verified by deletion —
the three inlined formulas and the agreement test are gone, and `costNanoUsd` has a live
caller. Coverage is 100/100/100 with no new ignore beyond one justified unreachable guard.

**Medium** on finding 5, which is a judgment about a vocabulary two later tasks consume
(three members, two axes, a precedence position), and on finding 2's ruling for the
**mandatory-single-rung** model specifically: sending it with no reasoning wire is right for
the menu invariant, and the money is safe, but whether the wire should instead carry that
model's single native level is a question the effort resolver (B6) owns, not the producer.
