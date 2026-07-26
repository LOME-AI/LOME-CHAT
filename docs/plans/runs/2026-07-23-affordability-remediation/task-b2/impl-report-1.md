# B2 — The dimension registry · impl-report-1

## Objective

One registry entry describes a cost-affecting dimension completely; everything a dimension
author could get wrong about money is derived rather than declared. Plus the three riders
plan.md §B2 attaches: the one-vocabulary-per-rung collapse, the executable re-partition pin,
and the `premium-check.ts` move that `PriceableModel` dissolves the cycle for.

## Files changed

### Inside the plan's Files list (`affordability/dimensions/**`, `reasoning-effort.ts`, tests)

| Path | Why |
| --- | --- |
| `packages/shared/src/affordability/dimensions/types.ts` | NEW. `DimensionSpec`, `DimensionSupport`, `DimensionOption`, `ProviderParams`, `OpenDimension`, `ReserveContribution`, and the four closed sets (`DIMENSION_IDS`, resources, cost classes, resolutions). |
| `packages/shared/src/affordability/dimensions/registry.ts` | NEW. `defineDimension` (per-declaration validation), `defineDimensions` (exactly one entry per closed id), `DIMENSIONS`, `dimensionFor`, `openDimension`, `DimensionRegistrationError`. |
| `packages/shared/src/affordability/dimensions/effort.ts` | NEW. The effort entry, plus `maxReasoningBudgetTokens` (`maxB(m)`), `cheapestEffortOption` (`e_min(m)`), `offeredEffortOptionIds`, `EFFORT_OPTION_IDS`. |
| `packages/shared/src/affordability/dimensions/model.ts` | NEW. The model entry. |
| `packages/shared/src/affordability/dimensions/derive.ts` | NEW. Every derivation: `optionDomain`, `dimensionSupportFor`, `reserveContribution`, `deliveredCeilingTokens`, `partitionPoolTokens`, `partitionCeiling`, `renderDimensionSection`, `parseDimensionAnswer`, `cheapestPresentedOption`, `chooseDimensionOption`, `classifierIsBought`, `resolveOption`. |
| `packages/shared/src/affordability/dimensions/index.ts` | NEW. A **published surface**, not a directory barrel (B1b's structural choice): registry + types only; the derivations are absent here, so neither package entry point can reach them. |
| `packages/shared/src/affordability/dimensions/{registry,effort,derive,re-partition}.test.ts` | NEW. 98 tests. |
| `packages/shared/src/affordability/priceable-model.ts` (+ test) | NEW. `PriceableModel` per §Data Structures, `priceableModelFrom` (fail-closed on an unpriceable descriptor), `reasoningPlanModelOf`. Lives at the module root, not under `dimensions/`: it is the money layer's projection, not a dimension concept. |
| `packages/shared/src/affordability/premium.ts` (+ test) | NEW. `premium-check.ts` re-signed off `PriceableModel`. |
| `packages/shared/src/affordability/reasoning-effort.ts` (+ test) | Vocabulary collapse: `REASONING_OFF = 'off'` added as the rung's single token; `REASONING_EFFORT_SELECTIONS` loses `'none'`; `REASONING_EFFORT_LABELS` keyed off the constant. |
| `packages/shared/src/affordability/estimate/effort-options.ts` (+ test) | `EffortChoice` is now `CanonicalReasoningEffort | ReasoningOff`; the three `'none'` sites read the constant. |
| `packages/shared/src/affordability/index.ts` | Publishes `premium.js`, `priceable-model.js` and `dimensions/index.js` — three of §Where the Code Lives' named structural seams. |

### Outside the plan's Files list — forced, enumerated

The plan's Files list named only `dimensions/**` + `reasoning-effort.ts` + tests. Criteria 6, 7
and 9 cannot be satisfied inside that list: criterion 9 says the file moves (it lives in
`models/`), and criterion 6 removes a member from a Zod enum the request schema, the client
store and the chat slice all consume. Global Constraint 10 requires the repo-wide sweep and a
green repo-wide `pnpm typecheck`, so the sweep edits were made rather than left red. Every one
is a mechanical `'none'` → `'off'` repoint or the premium move; none changes logic.

| Path | Edit | Forcing reason |
| --- | --- | --- |
| `packages/shared/src/models/premium-check.ts` | DELETED | Criterion 9: the file moves inside the module. |
| `packages/shared/src/models/premium-check.test.ts` | DELETED | Its subject moved; `premium.test.ts` replaces and extends it. |
| `packages/shared/src/models/index.ts` | dropped the premium re-export line | The file it re-exported no longer exists. |
| `packages/shared/src/index.ts` | added three unit re-exports | The root barrel published `isPremiumModel` / `PREMIUM_*` through `models/index.ts`; it now publishes them from their new home. |
| `apps/api/src/slices/chat/domain/turn-definition.ts` | 3 lines (2 comparisons + 1 comment) | `ReasoningEffortSelection` lost `'none'`; TS2367. |
| `apps/api/src/slices/chat/domain/turn-reasoning.ts` | 6 lines + one `ReasoningOff` type import | Same; `TurnReasoningEntry.effort` was typed `… | 'none'`. |
| `apps/api/src/slices/chat/routes.ts` | 3 comparisons | Same. |
| `apps/api/src/slices/chat/domain/{turn-definition,turn-reasoning}.test.ts`, `turn-definition.integration.test.ts`, `routes.integration.test.ts` | line-targeted `'none'` → `'off'` | Same. Every remaining `'none'` in these files is OpenRouter's native `supportedEfforts` token and was left alone. |
| `apps/web/src/hooks/chat/use-reasoning-effort.ts` (+ test) | 2 comparisons, `offersEffortNone` → `offersEffortOff`, 3 stale comments | Same; the exported predicate's name named the dead token. |
| `apps/web/src/components/chat/input/reasoning-effort-menu.tsx` (+ test) | 2 comparisons; one stale test comment | Same. |
| **`apps/web/src/hooks/billing/use-prompt-budget.ts`** | **1 line** (`selection === 'none'` → `'off'`, line 299) | **F1-owned. RAISED.** TS2367 otherwise, which would leave repo-wide typecheck red. |
| **`apps/web/src/hooks/billing/use-prompt-budget.test.ts`** | **2 lines** (one `it` title, one fixture value) | **F1-owned. RAISED.** |

## Tests added

| Test | Behaviour | Criterion |
| --- | --- | --- |
| `priceable-model.test.ts` (8) | the six-field projection; reasoning carried verbatim; fail-closed on a missing rate or context length; the projection does not widen when the catalog gains a field | 1 |
| `premium.test.ts` — `combinedRateNanoUsd` (2) | exact bigint sum, exact at magnitudes a float rounds | 9 |
| `premium.test.ts` — price leg (4) | rate **equal** to the threshold ⇒ premium; one nano above ⇒ premium; one nano below ⇒ basic; a beyond-2^53 pair where the float path reads equal and the bigint path reads below | 9 (threshold boundary) |
| `premium.test.ts` — recency leg (3) | cheap-and-recent ⇒ premium; cheap-and-old ⇒ basic; the clock is an argument, so the same inputs always classify alike | 9 |
| `premium.test.ts` — `exceedsTrialBudget` (5) | refuses/admits at the 1¢ cap; charges the input leg; prices already-billable rates without re-applying the fee; rejects a negative prompt length | 9 |
| `registry.test.ts` (18) | `DIMENSIONS` is exactly one entry per closed id, frozen; enum domain with no values, `none`/`free` mismatch, empty description and a multiplicative dimension claiming hold-ceiling delivery are all rejected; duplicate and missing ids rejected; **`openDimension` rejects a non-enumerable dimension and names it** | 2 |
| `effort.test.ts` (15) | the declaration itself (partition / completionTokens / ordered / enumerable / `lowestOfferedWhenMandatory` / `deliversAtHoldCeiling` / the ParamSpec domain); `maxB(m)` incl. the protocol-floor collapse and the tighter-of-two-caps clamp; `e_min(m)` incl. the mandatory case | 3, 5, 8 |
| `derive.test.ts` — support (7) | reads options off the catalog row; **grows when the model's catalog spec gains a value with no registry edit**; mandatory model has no off rung; refuses support that invents an out-of-domain option | 1 |
| `derive.test.ts` — `reserveContribution` (7) | partition ⇒ none; additive+money ⇒ worst in nano-USD; additive+tokens ⇒ worst in tokens; multiplicative ⇒ ceiling multiplier; free ⇒ none; empty ⇒ none | 4 |
| `derive.test.ts` — `deliveredCeilingTokens` (5) | `true` ⇒ the whole held ceiling; `false` ⇒ the worst option's share; **shrinks by the worst option even though the cheapest costs 1×**; flipping the flag to `true` is what changes the number | 3 |
| `derive.test.ts` — `renderDimensionSection` (5) | carries the declared sentence; lists every option by label; **emits no option id whose label differs from it**; labels its answer line with the dimension; refuses an empty presented set | 4, 7 |
| `derive.test.ts` — `parseDimensionAnswer` (7) | reads its own labelled line out of a two-dimension answer; whole answer on a single-dimension call; resolves the off rung from `Min`, never from `off`; case tolerance; nothing for an outside answer, an empty answer, or an option the model does not offer | 4 |
| `derive.test.ts` — fallback (4) + `chooseDimensionOption` (2) | cheapest by requirement; the reachable corner on a mandatory model; **identifier tiebreak on a plateau**; refuses an empty set; answer wins, else fallback | 4 |
| `derive.test.ts` — `classifierIsBought` (4) | bought on distinct requirements; **not bought when every label clamps to the same budget**; not bought on one option or none | 4 |
| `derive.test.ts` — `resolveOption` (9) | identity; nearest-below; falls to off; **rises only under the carve-out**; `nearestBelow` refuses instead of rising; nothing offered / outside the domain / unordered domain; **property test over 8 model shapes × the whole domain asserting no upward move except the carve-out, with `carveOuts > 0` so it cannot pass vacuously** | 5 |
| `derive.test.ts` — requirement/wire contract (4) | both throw on an unoffered option; the minted provider fragments; rogue requirement types reported, not mis-priced | 4 |
| `re-partition.test.ts` (10) | see below | 8 |
| `reasoning-effort.test.ts` (+4, 2 rewritten) | `REASONING_OFF` is `'off'`; the selection set is `auto`+ladder+`off` and contains neither `none` nor `min`; no selection is labelled with its own id | 6, 7 |

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:shared` | **pass** — 115 files, 2789 tests, coverage gate green (no per-file ERROR lines; `dimensions/` 99.39 stmt / 96.93 branch / 100 fn / 100 line, `premium.ts` 100 across the board) |
| `npx turbo typecheck --force --continue` (repo-wide) | **pass** — 16/16, zero cached |
| `npx eslint …` from `packages/shared`, over `src/affordability src/models/index.ts src/index.ts` | **pass** (exit 0), run after the last edit |
| `npx eslint …` from `apps/api`, over the 7 touched chat files | **pass** (exit 0) |
| `npx eslint …` from `apps/web`, over the 6 touched files | **pass** (exit 0) |
| `apps/web` targeted: `use-reasoning-effort.test.ts`, `reasoning-effort-menu.test.tsx`, `use-prompt-budget.test.ts` | **pass** — 130 tests |
| `apps/api` targeted: `turn-reasoning.test.ts`, `turn-definition.test.ts` | **pass** — 127 tests |
| `pnpm test:api` (full — not a B2 scoped check, run because the sweep touched the chat slice) | **7 failed / 6391 passed / 2 skipped, 1 failed file — all pre-existing.** Every failure is `src/slices/notifications/domain/templates/template-html.test.ts` (7 snapshot mismatches, each the removed `fonts.googleapis.com` `<link>`), which is Known Breakage verbatim. Attribution evidence: `git status --short apps/api/src/slices/notifications/domain/templates/` is **empty** — template source and `.snap` are byte-identical to HEAD — and nothing in my change set is in that file's import graph. All four integration/unit test files I repointed pass. |
| `pnpm test:web` (full — same reason) | **pass** — 393 files, 6412 tests, 0 failures. The Known-Breakage intermittent coverage failure did not reproduce this run. |

The first `pnpm test:api` attempt reported 19 failed / 3 failed files; that run raced the
`pnpm test:web` start and the numbers were pre-retry. The clean re-run above is the one to read.

## Acceptance criteria

**1. `DimensionSpec` and `PriceableModel` exist per §Data Structures; `DimensionSpec` reads its
option values from the model's `ParamSpec`; a test pins that adding a value to the catalog spec
changes the offered options with no registry edit.** — **Met.**
`dimensions/types.ts` carries `DimensionSpec` field-for-field as §Data Structures declares it
(`id`, `param`, `resource`, `costClass`, `ordered`, `enumerable`, `support`, `requirement`,
`wire`, `resolution`, `promptDescription`, `deliversAtHoldCeiling`).
`priceable-model.ts` carries `PriceableModel` with exactly the six declared fields, pinned by
`priceable-model.test.ts` "does not widen when the catalog grows a field".
`param` is the **declared option domain in the closed `ParamSpec` language** — consumed, never
extended, exactly as the design context requires — and `derive.ts:dimensionSupportFor` enforces
that no model's `support` may yield an option outside it. Per-model option **values** come from
the model's own catalog row: `derive.test.ts` "grows the offered options when the catalog spec
gains a value, with no registry edit" adds `'medium'` to a model's `supportedEfforts` and
watches the offered set go `['off','low','high']` → `['off','low','medium','high']` while
asserting the same `EFFORT_DIMENSION` object serviced both calls.

**2. `DIMENSIONS` contains the model and effort entries; a non-enumerable dimension declared
open is rejected at registration; pinned.** — **Met, with the interpretation stated.**
`registry.test.ts` pins both entries and that `DIMENSIONS` is frozen. Openness is **not** a
declared field — §Pinned or open says a dimension is pinned or open purely according to whether
the user fixed it — so there is no field on `DimensionSpec` for `defineDimension` to reject.
The guard therefore sits on the constructor of the open form: `openDimension(spec)` throws
`DimensionRegistrationError` naming the dimension, and `OpenDimension` is obtainable nowhere
else, so a non-enumerable dimension cannot reach a classifier by any route. That is the
structural property the criterion is after; the word "registration" is discharged as
*registration of the open form*. Raised so the auditor judges the interpretation rather than
discovering it.

**3. `deliversAtHoldCeiling: false` has a measurable effect.** — **Met.**
`derive.ts:deliveredCeilingTokens` returns the held ceiling when the flag is `true` and
`floor(held / worstFactor)` when it is `false` — the same answer whichever option is chosen,
which is the consequence the declaration exists to surface. Four assertions carry it:
`false` on a 1×/4× dimension turns a 40 000-token held ceiling into 10 000; the cheapest
presented option is verified to cost `1` and the ceiling still shrinks; flipping the same spec's
flag to `true` restores 40 000. The field is additionally **non-inert by construction**:
`defineDimension` rejects `costClass: 'multiplicative'` with `deliversAtHoldCeiling: true`, so a
multiplicative dimension cannot be declared as delivering at the hold ceiling at all.

**4. Derived, with a test each.** — **Met.** Five derivations, five test blocks (table above):
reserve contribution from `resource` + `costClass` (a pure table, no per-dimension code);
prompt section from `promptDescription` + labels; answer parsing from the labelled line + the
existing closed-set matcher; the failure fallback as `cheapestPresentedOption`; and
`classifierIsBought` measured on **resolved requirements** — the plateau test uses a model whose
catalog cap forces every ladder tier through the 1024-token protocol floor, so five distinct
labels collapse to one requirement and buy nothing.

**5. `resolution` is a two-value enum, not a callback; property test that no resolution moves
upward except the mandatory-reasoning carve-out.** — **Met.**
`DIMENSION_RESOLUTIONS = ['nearestBelow', 'lowestOfferedWhenMandatory']`; `DimensionSpec` has no
resolver function field. The property test walks 8 model shapes × the whole option domain,
asserts every upward move satisfies `support.mandatory === true` **and** lands on the lowest
offered option, and then asserts `carveOuts > 0` so the property cannot pass by never firing. A
companion test flips the same spec to `nearestBelow` and shows it refuses rather than rising.

**6. One vocabulary per rung.** — **Met.** Result, stated as the report requires:

| token | before | after |
| --- | --- | --- |
| `none` | the option id, labelled Min | **gone.** Absent from `REASONING_EFFORT_SELECTIONS`, `EffortChoice`, `EFFORT_OPTION_IDS` and every consumer. Two tests assert its absence from the selection set. |
| `Min` | the label | **survives as the label, and only as the label** — the single entry `REASONING_EFFORT_LABELS[REASONING_OFF] = 'Min'`. |
| `off` | the persistence design's value | **survives as the id AND the persisted value AND the wire selection** — one token for all three, minted once as `REASONING_OFF` in `reasoning-effort.ts` and referenced from `EFFORT_OPTION_IDS`, `EffortChoice` and `REASONING_EFFORT_LABELS`. |

D1 can now write the column without a translation step. OpenRouter's native `"none"` inside
`supportedEfforts` is untouched — it is upstream vocabulary describing that a model accepts
reasoning-off, and `REASONING_OFF`'s docblock records the distinction so the next sweep does not
eat it.

**7. The `medium` ↔ `Mid` mapping is single-sourced; no user-facing surface or classifier prompt
emits an id.** — **Met for the mapping and for this task's producers; one residual, owned by B6.**
- Single-sourced: `REASONING_EFFORT_LABELS` is the only mapping in the repo. Verified by grep —
  the only production occurrences of `'Mid'` / `'Min'` are that map's two entries; every other
  hit is a test expectation or an e2e locator word, not a second mapping. `reasoning-effort-menu.tsx`
  reads the map (lines 163, 237, 239) rather than re-typing words.
- Producers: `renderDimensionSection` emits labels only, pinned generally — for every dimension
  and every presented option the section contains the label, and for every option whose label
  differs from its id the section does **not** contain the id (this is what fails if `medium` or
  `off` leaks). `parseDimensionAnswer` matches on labels and maps back to ids.
- **Residual:** the *live* classifier prompt still emits ids —
  `affordability/smart-model/prompts.ts:72,74,84,88` prints `low, medium, high`, fed by the
  hardcoded `CLASSIFIER_EFFORT_LEVELS = ['low','medium','high']` in
  `smart-model/effort-dimension.ts:18`. Deleting that triple and sourcing the classifier's effort
  options from the registry entry is **B6's own named criterion** ("The classifier's effort options
  come from the registry entry with user-facing labels including Min, Lite and Max. The hardcoded
  level triple is deleted"), and `renderDimensionSection` is the producer it consumes. Left in
  place rather than pre-empted; raised.

**8. The re-partition invariant is pinned executably.** — **Met.**
`re-partition.test.ts`, 10 assertions over 8 model shapes (budget-native, effort-native,
mandatory, >5-rung vocabulary, single-rung ±mandatory, a cap-collapsed plateau, a non-reasoner):
- `partitionPoolTokens(EFFORT_DIMENSION, m) === maxReasoningBudgetTokens(m)` — the generic
  derivation and `maxB(m)` are the same number, so the pool is a constant of the model.
- The pool does not move when the presented set is narrowed: it is read off what the **model**
  offers, which affordability never edits.
- **The invariant proper:** for every model and every presented option,
  `partitionCeiling(...).ceilingTokens` is one value — asserted as a `Set` of size 1 equal to the
  held ceiling.
- `reservedTokens + answerTokens === ceilingTokens`: redistribution, never enlargement.
- `reserveContribution` is `{kind:'none'}` on **every** presented subset (not just the full set),
  which is the zero-marginal-money half.
- The priced floor fits the worst option plus a minimum answer.

**What it would catch, and the control that proves it can fail.** The invariant replaced a
composition rule measured to be false, so a vacuous pin would be worse than none. Two controls
run alongside it: a `ceilingFromChosen` implementation — a ceiling sized from `B(m, chosen)`
rather than `maxB(m)`, which is precisely the mistake the invariant forbids — is shown to
produce **different** values across the presented options on the very same fixtures; and the
first presenting model is shown to carry `> 1` distinct requirements while its
`reserveContribution` is still `none`. So the pin fails if anyone (a) makes `partitionCeiling`
return an option-dependent ceiling, (b) makes a partition dimension contribute to the reserve,
(c) sizes `partitionPoolTokens` off the presented subset instead of the model's own support, or
(d) breaks `reserved + answer == ceiling`. A separate guard asserts the fixture set is
non-degenerate (≥ 6 presenting models, at least one with > 1 option), so the properties cannot
pass by having nothing to range over.

**9. `premium-check.ts` moves into the module, re-signed off `PriceableModel`, and its float
arithmetic dies with the move; threshold boundary pinned.** — **Met.**
- **The cycle is genuinely dissolved, not routed around.** B1's blocker was
  `premium-check → models/types.ts → schemas/api/models.ts → model-descriptor.ts` — admitting the
  file would have required putting `models/types.ts` on the **inbound** allowlist. The new
  `premium.ts` imports `constants.js`, `estimate/pre-adapters.js`, `estimate/price-request.js`,
  `estimate/reducers.js`, `nano-usd.js` and `priceable-model.js` — **all in-module** — and imports
  `RawModel` from nowhere. The `models/types.ts` edge is deleted, not redirected: `models/` no
  longer appears anywhere in `premium.ts`'s import graph, and the module's inbound allowlist is
  unchanged (production imports into the module still reduce to `zod` alone; `premium.ts` adds no
  external import at all). The direction of the remaining edge is `models/` → nothing, and
  `affordability/index.ts` → `premium.js`. Evidence: repo-wide `pnpm typecheck` is green 16/16,
  which is what a residual directory cycle through a non-money module would not be silent about
  at the module-resolution layer, and `grep` shows no `../models/` specifier in the module.
- **`bigint` end to end, `parseFloat` gone.** The comparison is now
  `combinedRateNanoUsd(model) >= BigInt(priceThresholdNanoUsd)`, over the projection's exact
  nano-USD rates. `Number.parseFloat` appears nowhere in `premium.ts`; `exceedsTrialBudget` feeds
  the estimator `BigInt(model.inputRateNanoUsd)` / `BigInt(model.outputRateNanoUsd)` instead of
  `usdToNanoUsd(Number.parseFloat(...))`. The root cause the plan named is what disappeared:
  outside the module the function received raw catalog rate **strings** and had to parse them; a
  `PriceableModel` carries bigints, so there is nothing left to parse.
- **Threshold boundary, pinned exactly.** Combined rate 3000n against thresholds 3000n / 2999n /
  3001n classifies premium / premium / basic — equal, one nano either side, deterministic. A
  fourth test picks a pair beyond 2^53 where the sum is one nano *below* the threshold and
  asserts `false`, then asserts in the same test that the float path reads the two as **equal** —
  so the test distinguishes the bigint implementation from the float one it replaced rather than
  merely agreeing with it.
- **No G1 carve-out was written**, per the plan's explicit instruction.

## Deviations, with reasons

1. **Files edited outside the plan's Files list.** Enumerated in the table above with a forcing
   reason each. Two of them are **F1-owned** (`use-prompt-budget.{ts,test.ts}`, 3 lines total).
   The alternative was shipping a red repo-wide `pnpm typecheck`, which the brief names as the
   specific failure an earlier task committed. Raised.
2. **`PriceableModel.reasoning` is typed `ModelReasoning | undefined`, not
   `ReasoningMetadata | undefined`.** §Data Structures writes `ReasoningMetadata`; no such type
   exists — the catalog's type is `ModelReasoning` (`model-descriptor.ts:84`). Renaming the
   catalog type to match prose would touch the persisted descriptor's vocabulary for no gain, so
   the existing name is used. `BILLING.md` §Data Structures should read `ModelReasoning`.
3. **`resolveOption` takes no model.** Every model-dependent fact it needs is already in the
   support (the offered options and `mandatory`); a `model` parameter was unused and would have
   invited a second, disagreeing source for the same facts.
4. **`exceedsTrialBudget` now prices provider cost only.** The old implementation passed
   `inputChars: systemPromptChars` and the tier output-storage ratio into `reservationCeiling`,
   i.e. it charged **storage** for a turn that never persists (§Cost: "Trial never persists";
   §Trial Usage: trial settlement persists nothing). The new one strips the storage line items.
   This makes the function stricter, not looser, and it has no production consumer today.
5. **`param` for the model dimension declares no `values`.** The model dimension's domain is the
   catalog, which is finite per turn but not a literal list. It is still `enumerable` (a turn
   presents a closed candidate set), and `dimensionSupportFor`'s domain-membership guard is
   skipped for it. Documented in both the type and the entry.
6. **Two `eslint-disable-next-line sonarjs/redundant-type-aliases`** on `OptionId` and
   `OptionLabel`, each with a written reason: they are the specification's two distinct
   vocabularies for one rung and every signature has to say which it takes; collapsing either to
   `string` erases exactly the distinction criterion 7 enforces, and branding would force casts
   at every catalog and label-map boundary. Precedent: `apps/api/src/lib/telemetry/port.ts:26`.

## Concerns and limitations

1. **`exceedsTrialBudget` had a live-looking bug and no live consumer.** Its docblock claimed
   "the core applies markup" and fed the estimator **raw pre-fee** rates. `priceRequest` applies
   no fee math (rates arrive billable — `price-request.ts:8`), so the function under-priced every
   model by the 15% markup. The move fixes it as a side effect. Nothing consumed it, so there was
   no user-visible impact; recorded because the stale comment is what made it survive.
2. **`isPremiumModel` read `Date.now()` inside a module documented as clock-free** (§Where the
   Code Lives: "no database, no cache, no clock, no randomness, no network"). The new signature
   takes `nowMs`, so a classification is reproducible from its inputs. Pinned by a test that
   classifies the same model both ways across the recency boundary.
3. **A second implementation of premium classification exists, and I did not touch it.**
   `apps/api/src/slices/models/domain/trial-eligibility.ts` carries its own price-quartile
   threshold (line 33), its own recency window (line 42) and its own trial-affordability leg
   (`exceedsMinimalAffordability`), and `tier-gate.ts` derives the paid premium gate from it.
   That is the **live** classifier; the file I moved had no production consumer at all. Two
   implementations of "what premium means" is a One-Implementation-Shared question, not something
   to collapse silently inside B2 — B5 owns eligibility grading and B8 owns landing the seam.
   Raised for the orchestrator to route.
4. **`PriceableModel` has no `parameters` field, which E4 will need.** Media dimensions
   (resolution, duration, aspect ratio) live in `ModelDescriptor.parameters` as per-model
   `ParamSpec`s. The effort dimension reads its per-model domain from `reasoning` instead, so B2
   needs none; E4 either extends the projection (a §Data-Structures change) or passes the spec
   alongside. Flagged now so E4 does not discover it as a blocker.
5. **`exceedsTrialBudget` / `TRIAL_AFFORDABILITY_MULTIPLIER` are newly published on both
   barrels.** They were previously reachable from neither (only their own deleted test imported
   them). §Where the Code Lives names "tier and premium classification" a structural seam, so
   publishing them is defensible, but B8's set-equality-against-the-documented-list criterion is
   where it gets ruled — same class as B1b's `estimateOk` / `estimateErr` note.
6. **`dimensions/index.ts` publishes registry + types only.** The derivations
   (`reserveContribution`, `renderDimensionSection`, `parseDimensionAnswer`,
   `cheapestPresentedOption`, `chooseDimensionOption`, `classifierIsBought`, `resolveOption`,
   `partitionCeiling`, `deliveredCeilingTokens`) are deliberately absent from both package entry
   points — they are reducers and ceiling machinery, which §Where the Code Lives keeps unexported.
   In-module consumers (B3, B6, C1) import `./dimensions/derive.js` directly. B8 should confirm
   this split against the documented surface rather than assume the whole directory publishes.
7. **The model dimension's `requirement` is a per-token rate, not a turn cost.** It returns the
   model's combined billable input+output nano-USD per token — the balance- and prompt-independent
   total order §Smart Model 1 mandates, and the quantity B3's `T` solve sums. The turn-cost basis
   (`Σᵢ cost(mᵢ, ceiling(mᵢ))`) is deliberately not the registry's business; B3 must not read
   `reserveContribution(MODEL_DIMENSION, …)` as a hold amount. Stated in the entry's docblock.
8. **`pnpm test:api` and `pnpm test:web` are not this task's scoped checks** (plan.md §B2 scopes
   `pnpm test:shared` + shared typecheck/lint), but the sweep touched both apps, so both were run
   in full. Results and attribution are in the self-gate table; the only failures are the seven
   pre-existing `template-html` snapshots, whose directory is byte-identical to HEAD in this
   working tree.
9. **`resolveOption` orders by the declared domain, not by the support's enumeration order.**
   Both registry entries emit ascending options, so the two agree today; reading the order off
   `optionDomain` rather than off `support.options` means a future `support` that lists options in
   another order cannot silently turn "nearest below" into "last enumerated". Its consequence:
   a dimension whose `param` declares no `values` (the model dimension) has no order and therefore
   resolves to `undefined` — the caller applies the cheapest-presented fallback instead, which is
   the correct §Reasoning Effort 8 path for a model answer outside the candidate set.

## Confidence

**Medium-high.** High on the registry, the derivations, the re-partition pin and the
`premium-check` move: each is pure, locally tested, and the pins carry controls that fail if the
implementation regresses. Medium overall for two reasons that are about blast radius rather than
correctness — the vocabulary collapse reached 16 files across three workspaces including two
F1-owned lines, and criterion 2's "rejected at registration" was discharged by interpretation
(the guard sits on `openDimension`, because openness is not a declared field) rather than
literally.
