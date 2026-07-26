# B3 — `getTurnOptions`: one producer, two sets — implementation report 1

## Objective

Build the single mint of `TurnOptions` — one call, one pure core evaluated twice, over the
arithmetic vocabulary `docs/BILLING.md` §Math & Terms defines — and determine the
`estimateTokenCount` finding.

## Files changed

New, all under `packages/shared/src/affordability/`:

| File                                | Why                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `turn-types.ts`                     | The §Data Structures shapes: `FundingSnapshot`, `PromptBasis`, `Selection`, `Availability`, `ModelEntry`, `OptionSet`, `TurnOptions`, `NonEmpty`, `RefusalCode`, `EMPTY_PROMPT_BASIS`, `promptCharsOf`, `refusalPrecedence`. |
| `turn-arithmetic.ts`                | The §Math & Terms vocabulary as one named function per defined quantity.                                                   |
| `turn-core.ts`                      | The pure core: one `(funding, basis)` pair → one `OptionSet` + priced line items. Off every barrel.                        |
| `turn-options.ts`                   | `getTurnOptions` — the producer, and the only place the two substitutions happen.                                          |
| `turn-types.test.ts`                | Derived total, empty basis, closed refusal set, precedence.                                                               |
| `turn-arithmetic.test.ts`           | The vocabulary, pinned by amount.                                                                                        |
| `turn-core.test.ts`                 | Line items, ceilings, reasons, marking, smart slot, eligibility corner.                                                   |
| `turn-options.test.ts`              | The pair, the two evaluations (core spied), floor stability, tier ratios, cache reads, web search.                        |
| `turn-options.property.test.ts`     | `admissible ⊆ affordable` and marked-never-filtered over generated triples.                                               |
| `turn-options.completeness.test.ts` | `presented ⟺ feasible` over a non-degenerate fixture, with the fixture's own non-degeneracy asserted first.               |
| `turn-options.re-partition.test.ts` | The re-partition invariant closed against the PRODUCED ceiling.                                                           |
| `turn-options.purity.test.ts`       | Structural purity + content-freedom over the four sources, plus behavioural determinism.                                 |

Edited:

| File                                            | Why                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `affordability/pricing.ts` + `.test.ts`          | The `estimateTokenCount` finding (below): ratio read from `CHARS_PER_TOKEN_STANDARD`, signature takes a character count, docblock states which question it answers. |
| `affordability/estimate/pre-adapters.ts`         | New `outputStorageRatePerTokenNanoUsd(outputCharsPerToken)` — the ONE home for the per-output-token storage multiplication.              |
| `affordability/estimate/price-request.ts`        | Output-storage item repointed onto that one home.                                                                                       |
| `affordability/estimate/classifier-line-item.ts` | Storage leg repointed onto that one home.                                                                                              |
| `affordability/estimate/smart-model-affordability.ts` | `outputStoragePerTokenNanoUsd` repointed onto that one home (arithmetic identical).                                                |
| `apps/marketing/src/lib/calculate-cost.ts` + `.test.ts` | Pass character counts instead of fabricating padded strings.                                                                    |
| `apps/web/src/lib/tokens.test.ts`               | The re-exported `estimateTokenCount`'s tests follow the count signature.                                                                |

## Tests added

Names abbreviated; 125 new assertions across 8 files.

| Test                                                                             | Behaviour                                                                    | Criterion |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------- |
| `promptCharsOf` derives the total / excludes attachment bytes                    | components in, total derived                                                 | 3         |
| `refusalPrecedence` money-before-length, total on empty                          | §Notices 4 precedence                                                        | reasons   |
| `storageRatePerTokenNanoUsd` 600n paid / 1200n others                            | inverted output-storage ratio, by amount                                     | 10        |
| `variableRateNanoUsd` 2600n / 3200n / 2000n                                      | output rate + storage when persisting, bare when not                         | 8         |
| `inputTokensOf` 250 paid / 500 free / rounds up                                  | tier input ratio, ceil against the user                                      | 8, 10     |
| `inputStorageNanoUsd` 300 000n / 0n                                              | promptChars × 300n, dropped when not persisting                              | 8, 9      |
| `fixedCostsNanoUsd` 58 307 000n; storage once across 1 vs 3 siblings             | the four fixed terms, by amount                                              | 8         |
| `costNanoUsd` 2 850 000n / 2 250 000n                                            | `cost(m, tokens)` with and without storage                                   | 8         |
| `contextHeadroomTokens`, `budgetBuysTokens` 3461, `ceilingTokens` four bounds     | §Model bounds, by amount                                                     | 8         |
| `reasoningBudgetTokens` 12 288 / 0 at `e_min` / 4096 at mandatory `e_min`          | `B(m, e)` and `e_min(m)`, by amount                                          | brief     |
| `feasible` / `eligible` at the ±1 boundary; mandatory corner excluded             | §Predicates on the resolved cheapest corner                                  | brief     |
| core: image modality refused; text priced                                        | modality is an input, per-unit pricing not faked                             | 7         |
| core: storage present on paid; **zero storage items on trial**                    | storage drops on non-persisting turns                                        | 9         |
| core: input storage sums to 300 000n once across three siblings                   | counted once per turn, attributed to the first sibling                       | 9         |
| core: web search 172 500 000n on a three-model turn                              | 10 × $0.005 × 3, billable                                                    | 13        |
| core: classifier absent when pinned, present when open, **never a storage leg**   | §Reserve ⟺ classify; classifier storage on no tier                           | 9         |
| core: classifier engine tie broken on identifier                                 | reserve reproducible from catalog, not row order                             | 8         |
| core: ceiling bound by cap / money / headroom; total = `cost(m, ceiling)` + storage | §Model bounds and the priced basis                                          | 8         |
| core: five reason cases, each in precedence order                                | typed reasons, money-then-length-then-capability                             | 4, 7      |
| core: one entry per catalog model; unavailable option keeps its reason            | marked, never filtered                                                      | 4         |
| core: effort dimension absent for a non-reasoning model                           | `NonEmpty` options stay honest                                              | 1         |
| core: turn dimensions are the union in domain order; no model dimension          | §Story 2.8 union rule                                                        | 6         |
| core: empty basis leaves the whole window and prices no input storage             | the affordable pass's basis                                                  | 7         |
| core: smart slot holds MAX not Σ; only viable candidates presented               | §Smart Model 4, §The hold                                                    | 6         |
| producer: pair + hold 21 350 000n; no hold when unsendable                        | `TurnOptions` shape and hold placement                                       | 1         |
| producer: core ran exactly twice; empty basis first; effectiveBalance vs spendable | one call, two evaluations                                                    | 2         |
| producer: keystroke sweep leaves `affordable` byte-identical; admissible moves     | the floor is prompt-independent                                              | 7         |
| producer: `affordable` identical under a 29 000 000n hold; admissible differs      | the floor is hold-blind                                                      | 7         |
| producer: pin / sibling / modality change each move `affordable`                  | the floor reacts to discrete selections                                      | 7         |
| producer: paid 21 350 000n vs free 26 400 000n at identical char counts           | inverted ratios, by amount                                                   | 10        |
| producer: one extra char costs one token + its storage                            | rounding against the user                                                    | 10        |
| producer: trial hold 16 500 000n                                                  | no storage anywhere on a non-persisting turn                                 | 9         |
| producer: `cachedInputPerToken` is not projected; hold prices the full input rate | cache reads at the full input rate                                           | 11        |
| property: `admissible ⊆ affordable` over 400 triples, both legs moved             | the subset invariant                                                         | 5         |
| property: the basis leg alone is monotone over 200 draws at equal funding         | the basis half of the subset invariant, isolated                             | 5         |
| property: every catalog model and every offered rung present at every balance     | marked, never filtered — no code path removes an entry                       | 4         |
| completeness: fixture is 5 models / 2 dimensions / mandatory / plateau            | non-degeneracy asserted, not assumed                                         | 6         |
| completeness: `presented === feasible` over every model × option, both directions | the biconditional                                                            | 6         |
| completeness: rungs grey top-down (downward-closed prefix)                        | the prefix property a ceiling represents                                     | 6         |
| re-partition: produced ceiling and produced hold identical across pinned rungs    | effort has no marginal money cost, end to end                                | brief     |
| re-partition: pool is `maxB(m)`, fits the produced ceiling, split never enlarges   | the priced ceiling derives from `maxB(m)`                                    | brief     |
| purity: 16 source scans + a scan-can-fail control; determinism; no input mutation | pure, asserted structurally                                                  | 14        |

**Watched-red evidence.** Every file was written test-first and watched fail for the expected
reason (missing module, then missing symbol, then wrong amount). Three amounts I had
hand-computed wrong were caught by the red run and corrected against the arithmetic, not the
other way round (`budgetBuys` 941 → 1326 after the funding was raised so the corner stayed
eligible; the three-sibling input-storage assertion changed from "one item" to "sums to
300 000n with exactly one non-zero", which is what §Multi-Model 1 actually says; a
candidate-exclusion fixture that could not separate two models with identical rates was
replaced by one that can).

**Positive controls, watched fail.** A property test that passes first time proves nothing, so
each was run against a deliberately broken producer:

- `affordable` funded from `spendable` instead of `effectiveBalance` → the subset property
  fails (re-verified after the lint refactor).
- `affordable` evaluated against the composed basis → three producer tests fail (the
  empty-basis assertion, the keystroke sweep, and its meaningfulness counterpart). The subset
  property does NOT fail on this one, which is correct and is why the keystroke sweep and the
  isolated basis-leg property both exist.
- The purity scan's own patterns are asserted to match an impure sample.
- The re-partition pin carries the "ceiling priced from the chosen option" control.

## Self-gate

| Command                                                    | Result                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `npx turbo test --filter=@hushbox/shared --force`           | pass — 123 files, 2938 tests, coverage gate green                  |
| `npx turbo test --filter=@hushbox/marketing --force`        | pass — 50 files, 452 tests                                         |
| `pnpm test:web`                                            | pass — 393 files, 6410 tests, `tokens.ts` 100%                     |
| `pnpm test:api`                                            | 1 file / 7 tests fail — **pre-existing, attributed below**          |
| `npx turbo typecheck --force --continue`                    | pass — 16/16, zero cached                                          |
| `eslint` on every changed file, from its package directory   | pass — exit 0, run after the final edit                            |
| `pnpm arch:check`                                          | pass — 11 rules over 2016 files                                    |

Coverage of the new and changed files (lines / branches / functions):

| File                             | %             |
| -------------------------------- | ------------- |
| `turn-types.ts`                  | 100 / 100 / 100 |
| `turn-arithmetic.ts`             | 100 / 100 / 100 |
| `turn-core.ts`                   | 100 / 98.92 / 100 |
| `turn-options.ts`                | 100 / 100 / 100 |
| `pricing.ts`                     | 100 / 100 / 100 |
| `estimate/pre-adapters.ts`       | 100 / 100 / 100 |
| `estimate/price-request.ts`      | 100 / 100 / 100 |

### The one failure, attributed

```
apps/api  src/slices/notifications/domain/templates/template-html.test.ts
          7 snapshot failures   (465 files pass, 1 skipped)
```

Not mine, on three independent grounds: it is §Known Breakage's named `apps/api` entry
("the single `apps/api` failure a scoped run will show"), confirmed there as still failing
after `39a07db0`; `git diff --stat HEAD -- apps/api/src/slices/notifications/domain/templates/`
is empty, so neither the template nor its snapshot has moved; and this task touched no file
under `apps/api` at all. I checked for the second-cause hazard §Known Breakage warns about —
the failure count and the failing file are identical to the entry as written, and nothing I
changed is imported by that template.

The five `model-catalog test lock` timeouts and the `apps/web` markdown-renderer coverage
flake did not appear in these runs.

## Acceptance criteria

1. **`TurnOptions` returns the pair plus `holdNanoUsd`; `OptionSet` carries `runnable:
   NonEmpty` beside `all` and no hold field** — **met.** `turn-types.ts`; the hold lives on the
   pair, and `OptionSet`'s `sendable: false` arm carries only a refusal, so
   sendable-with-nothing-runnable and an affordable-side hold are both compile errors. Pinned
   behaviourally by "carries both sets and the hold" / "carries no hold when the turn cannot
   start".
2. **One call, two evaluations** — **met.** `turn-options.test.ts` mocks `./turn-core.js`
   transparently (the factory delegates to the real implementation and records inputs) and
   asserts exactly two calls, `EMPTY_PROMPT_BASIS` on the first and the composed basis on the
   second, `effectiveBalance` on the first and `spendable` on the second. No exported signature
   accepts a basis for `affordable`: `getTurnOptions` takes exactly one basis and substitutes
   the empty one itself.
3. **`PromptBasis` carries components with the total derived; `Selection` requires ≥1 answer
   source** — **met.** `promptCharsOf` is the only route to a total; `AnswerSources` is a union
   whose first arm requires `NonEmpty<string>` and whose second requires `smartSlot: true`.
4. **Options are marked, never filtered** — **met.** The property sweep asserts, at 150 random
   balances across four tiers, that `all` contains one entry per catalog model and that each
   entry's presented rungs equal the registry's offered rungs exactly, id for id — so nothing
   can have been dropped — and that every greyed option carries a reason. The control counts
   the greyings, so a sweep in which nothing was ever marked fails.
5. **`admissible ⊆ affordable` across both differing inputs** — **met.** 400 generated triples
   moving spendable, held, tier, all four basis components, sibling count, smart slot, effort
   pin and web search; asserted at set level, per model and per rung. Controls: 20+ sendable
   and 5+ divergent draws required, plus the broken-producer control above. The basis leg is
   additionally isolated in its own 200-draw property at identical funding.
6. **Completeness: `presented == feasible` over every model × option, over `admissible`** —
   **met**, on a fixture whose non-degeneracy is itself asserted: five models; both registered
   dimensions (model open through the smart slot, effort in the menus); a mandatory-reasoning
   model whose lowest rung costs 4096 tokens and whose support excludes `off`; and a
   plateau-collapsed pair (providerCap 1200 clamps low/medium/high to one budget, asserted by
   `new Set(budgets).size < budgets.length`). Both directions of the biconditional are counted
   and required to be non-zero.
7. **The floor is prompt-independent and hold-blind; a pin, a sibling change or a modality
   change alters it** — **met.** Keystroke sweep (0–40 characters in 8-character steps) leaves
   `affordable` deep-equal; a 29 000 000n hold leaves `affordable` deep-equal while `admissible`
   differs; pinning `effort: high`, adding a sibling, and switching to `image` each change
   `affordable`. The meaningfulness counterpart (a much longer prompt moves `admissible` and not
   `affordable`) is pinned beside it.
8. **The arithmetic vocabulary exists as named exports and every call site uses it, pinned by
   amount** — **met.** `turn-arithmetic.ts` exports `storageRatePerTokenNanoUsd`,
   `variableRateNanoUsd`, `inputTokensOf`, `inputStorageNanoUsd`, `fixedCostsNanoUsd`,
   `costNanoUsd`, `contextHeadroomTokens`, `budgetBuysTokens`, `ceilingTokens`,
   `reasoningBudgetTokens`, `feasible`, `eligible`; `e_min(m)` is B2's existing
   `cheapestEffortOption`, imported rather than re-derived. The amounts asserted:

   | Term                            | Amount                                                                  |
   | ------------------------------- | ----------------------------------------------------------------------- |
   | `storageRatePerToken('paid')`   | `600n` = 2 chars/token × 300n                                           |
   | `storageRatePerToken(other)`    | `1200n` = 4 chars/token × 300n                                          |
   | `variableRate(m)` paid, persists | `2600n` = 2000n output + 600n storage                                   |
   | `variableRate(m)` free, persists | `3200n` = 2000n + 1200n                                                 |
   | `variableRate(m)` non-persisting | `2000n` — bare output rate                                              |
   | `inputTokens` (1000 chars)      | 250 paid, 500 other; 1001 chars → 251 / 501                             |
   | `inputStorage` (1000 chars)     | `300_000n`; `0n` when the turn does not persist                          |
   | `fixedCosts` (2 siblings)       | `58_307_000n` = 500 000 input legs + 300 000 storage + 7000 classifier + 57 500 000 additive |
   | `cost(m, 1000)` paid            | `2_850_000n`; non-persisting `2_250_000n`                                |
   | `budgetBuys(10M, 1M, 2600)`     | `3461` (floored)                                                        |
   | `ceiling(m)`                    | 8000 cap-bound / 500 headroom-bound / 1200 money-bound / 100 000 uncapped fallback |
   | `B(m, medium)`                  | `12_288`                                                                |
   | `e_min(m)` disableable          | `off`, `B = 0`                                                          |
   | `e_min(m)` mandatory            | `low`, `B = 4096`                                                       |
   | whole-turn hold, paid           | `21_350_000n`; free `26_400_000n`; trial `16_500_000n`                   |

   Every producer call site prices through these; `turn-core.ts` contains no rate expression of
   its own.
9. **Storage drops on non-persisting turns; the classifier leg carries none on any tier** —
   **met.** A trial result's line items contain zero items of `kind: 'storage'` in both legs
   (the drop is an explicit filter in `siblingLineItems`, plus `inputStorageNanoUsd` returning
   `0n`), and `classifier-storage` is absent from the produced items on paid, free, trial and
   guest — the classifier reserve is folded provider-leg-only. See the concern below about the
   live admission path, which still adds it.
10. **Inverted output-storage ratios, every division rounding against the user** — **met**, by
    amount on a paid/free pair at identical character counts (21 350 000n vs 26 400 000n: the
    free turn pays for twice the input tokens AND twice the output-storage rate), plus the
    one-extra-character test showing the input division rounds up.
11. **Cache reads price at the full input rate** — **met.** `ratesFromPricing` on a `Pricing`
    carrying `cachedInputPerToken: 1n` yields only `inputPerToken`/`outputPerToken`, so the
    cheaper rate is never projected into `PriceableModel` at all — the shape has no field for
    it — and the produced hold prices the input leg at the full 1000n rate.
12. **The `estimateTokenCount` finding** — **determined and acted on**; see its own section.
13. **Web search reserves 10 × $0.005 × model count** — **met**, by amount: the line item on a
    three-model turn is `172_500_000n`, and the produced hold rises by exactly that when the
    toggle flips. That is `10 × usdToNanoUsd(0.005) = 50_000_000n`, markup baked once at
    definition (ceil) = `57_500_000n` per model × 3.
14. **Pure: no clock, no I/O, no randomness — asserted structurally** — **met.** Sixteen source
    scans over the four production files for a clock, randomness, network/filesystem I/O and the
    ambient environment, plus two content-shape scans per file, plus a control asserting the
    patterns do match an impure sample. Behavioural half: identical inputs give deep-equal
    output, and no input object is mutated.

## The `estimateTokenCount` finding

**It is a second implementation of the ratio constant, but not of the question.** Stated
precisely, because the plan's framing is half right:

- **`estimateTokensForTier(tier, chars)`** sizes a **reservation**. It is tier-skewed (paid 4
  chars/token, every other tier 2), rounds against the user, and decides what a payer may send.
  It is on the money path.
- **`estimateTokenCount`** sized an **illustration**: `apps/marketing`'s "what would 50
  messages a day cost" chart, which has no payer, no tier and no send. This is the same kind of
  quantity as `computePromptCapacity`'s deliberately tier-independent 4-chars/token ratio, which
  the code already documents as "NOT a money figure".

Applying CODE-RULES' own test — _if these two drift, does something break?_ — the **questions**
do not have to agree (marketing's chart is not a verdict), but the **standard approximation**
did: `estimateTokenCount` wrote `/ 4` as a literal while `CHARS_PER_TOKEN_STANDARD = 4` sits one
import away. A mirrored constant is the banned artifact, so that is what was collapsed: the
function now reads the constant, and its docblock states which question it answers and why it is
not the money conversion. Both questions survive; the second copy of the number does not.

Two further facts found while checking, both corrections to the plan's premise:

1. **The stated client hazard is not live.** `apps/web/src/lib/tokens.ts:13` re-exports
   `estimateTokenCount`, but a repo-wide grep shows **nothing in `apps/web` imports
   `lib/tokens` at all** — not `estimateTokenCount`, not `formatTokenCount`, not
   `formatContextLength`. The file's only consumer is its own test. The client's real turn sizing
   goes through `estimateTokensForTier` (`apps/web/src/hooks/billing/use-budget-calculation.ts:112`).
   So "a paid user's client could size at `/4` while the server sizes at `/2`" cannot happen
   today — and note the direction: for a **paid** user both are 4, and it is the free/trial tiers
   where they differ, with the server sizing *more* conservatively.
2. **The signature was a content-freedom breach.** `estimateTokenCount(text: string)` accepted
   content inside a module documented as content-free, and its one live caller was building a
   padded string of N spaces purely to have `.length` read back off it
   (`estimateTokenCount(inputChars.toString().padEnd(inputChars, ' '))`). It now takes the count.
   Numerically identical — `ceil(N/4)` either way — so no client-visible number moved, which is
   why this did not need to become a product question.

## Deviations, with reasons

1. **`getTurnOptions` takes a fourth argument, `catalog`.** §Where the Code Lives writes
   `getTurnOptions(funding, basis, selection)`, but `Selection` names models by identifier
   (§Data Structures fixes its three fields) and §Smart Model requires the candidate pool and
   the outlier median to be derivable from the catalog, so the priceable pool must arrive from
   somewhere. The documented three stay first, in their documented order, so the documented call
   is a prefix of the real one. B8 owns the naming/signature ruling.
2. **`Selection` carries a `webSearch: boolean`.** §The Dimension Framework lists web search as
   a dimension (pinned when toggled), but the registry has no `search` entry and no task claims
   one — see the gap below. It sits on `Selection` rather than in a context argument because it
   is something the **user fixed**, and that is the type that carries those; when search becomes
   a registered dimension it collapses into `pinned`, and the docblock says so.
3. **A non-text modality returns `sendable: false, refusal: 'modality_not_priceable'`.** A token
   ceiling is inert against per-unit pricing (§Extending → Add a modality says exactly that), and
   E4 owns media dimensions. Refusing is honest; pricing a per-image turn against a token ceiling
   would not be, and nothing consumes the producer yet, so nothing regresses.
4. **I implemented the shared-token solve, which is B4's task.** The vocabulary cannot be
   coherent without it: `budgetBuys(m)` and §Sharing's `T` are the same equation at one sibling
   and N, criterion 13 requires a three-model hold, and pricing each sibling's ceiling
   independently would over-commit — knowingly wrong arithmetic that B4 would then have to
   rewrite. The priced basis is `Σᵢ cost(mᵢ, ceiling(mᵢ))` with per-model physical clamps, never
   `T × Σrates`. B4's own criteria remain undone: the heterogeneous-pair pin, the
   `createEstimateRun ≤ funding` cross-verification, and deleting the summed-rate answer-cap
   guess in `turn-definition.ts`.
5. **Out-of-ownership edits, three files.** `apps/marketing/src/lib/calculate-cost.{ts,test.ts}`
   and `apps/web/src/lib/tokens.test.ts` — forced by criterion 12, which names those call sites
   explicitly as B3's concern. No task owns the marketing file; `lib/tokens.ts` itself was left
   alone (see the dead-code note).
6. **Four edits inside `estimate/`** (`pre-adapters.ts`, `price-request.ts`,
   `classifier-line-item.ts`, `smart-model-affordability.ts`). The per-output-token storage rate
   (`outputCharsPerToken × 300n`) was already written out three times; adding
   `variableRate(m)` would have made a fourth. Collapsed into
   `outputStorageRatePerTokenNanoUsd(outputCharsPerToken)` in `pre-adapters.ts` (not on any
   barrel — `estimate/index.ts` re-exports pre-adapters by name only), with the three existing
   sites repointed. Arithmetic unchanged; all three files' suites pass unmodified, as do
   `apps/api`'s 465 green files.

## Concerns and limitations

1. **The live admission path still reserves classifier storage, contradicting §Cost.**
   `estimate/classifier-line-item.ts` emits a `classifier-storage` item and
   `estimate/smart-model-affordability.ts` adds it into the fixed reserve, while §Cost and
   §Reasoning Effort 7 both say the classifier's prompt and output never rest so no storage is
   reserved or charged for them. My producer drops it (criterion 9); the shipped admission path
   does not. `smart-model-affordability.ts` is B5's file and changing the reserve changes live
   hold amounts in `apps/api`, so I did not touch it.
2. **The classifier reserve cannot see model descriptions, and may therefore under-reserve.**
   `classifierReserveChars` prices the prompt overhead from `{id, description}`, but
   `PriceableModel` carries no description, so the producer passes ids alone and the overhead is
   understated by however many characters the descriptions add. `reserve ⊇ bill` is binary, not
   approximate. This is the same defect shape as B6's own criterion ("pin the reserve against
   what the truncator emits, not against the cap constant"); closing it may need a character
   count on `PriceableModel`, which is a shared-type contract change.
3. **The classifier engine order must stay basis-independent.** I order it on
   `combinedRateNanoUsd` with an identifier tiebreak, and the code carries a comment saying why:
   `maxCallCost` is prompt-weighted, so a cost-ranked engine choice can differ between the two
   passes, and a cheaper engine on the `spendable` pass would let an admissible ceiling exceed
   its affordable counterpart — breaking `admissible ⊆ affordable`. B5 is about to move the
   **pool** order onto `maxCallCost`; if it moves the **engine** choice too, that invariant needs
   re-deriving.
4. **`MAX_SELECTED_MODELS` (≤ 5 siblings) is not enforced by the producer.** No criterion asked
   for it and inventing it would be speculative, but §Multi-Model 1 states it and a picker
   rendering `all` will want a sixth model greyed rather than available.
5. **`RefusalCode`'s membership is B3's guess at what B7 will need.** Six codes, each reachable
   and each pinned by a test. B7 owns copy derivation and may need to add or rename members.
6. **The reference arrangement for pinned siblings.** With a smart slot present, a pinned
   sibling's presented ceiling is read off the arrangement the hold is sized for (the costliest
   viable candidate's), which is also the tightest shared-token solve. That is the conservative
   reading and it is what the hold covers, but it means a pinned sibling's displayed ceiling can
   be smaller than what it will actually get if the classifier picks a cheap candidate.
7. **Dead code noticed, not deleted.** `apps/web/src/lib/tokens.ts` has no production consumer
   for any of its three exports. Flagging rather than removing, per the surgical-changes rule.
8. **`turnDimensions` carries no `model` entry**, deliberately: the model dimension's options
   are the `all`/`runnable` entries themselves, and duplicating them as a `DimensionAvailability`
   would give a surface two sources for one list. Pinned by test.

## Confidence

**High** on the arithmetic and the two-set contract: every amount in the vocabulary is pinned by
number rather than by structure, the subset and re-partition invariants each have a watched
positive control, and the whole repo typechecks and lints clean with the shared coverage gate
green.

**Medium** on the shapes at the seams — the fourth `catalog` argument, `Selection.webSearch`, the
`RefusalCode` membership, and the non-text refusal. Each is a judgment about a contract that B7,
B8 and E4 will consume, and each is recorded above so those tasks can overrule it rather than
discover it.
