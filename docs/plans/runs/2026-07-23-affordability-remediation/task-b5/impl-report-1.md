# B5 — implementation report 1

**The git baseline moved during this task.** `HEAD` was `ada0341c` at dispatch and is
`53daba72` ("billing refactor", 2026-07-26 23:52) now; the founder's commit absorbed this task's
work mid-flight, so B5's code is INSIDE `53daba72` rather than in the working tree. No agent ran
a git write. An auditor diffing "vs the baseline" wants `ada0341c..53daba72`, and must expect
A2's, B4's and the concurrent workstream's changes in the same commit.

## Objective

One premium classifier, outlier exclusion on `maxCallCost`, resolved-corner eligibility, and
trial priced without storage. Plus the two rulings that landed mid-task: the
mandatory-single-rung priceable rung, and the atomic-or-nothing classifier-storage strip.

**Two items are reported rather than shipped** — ruling 5's trial-gate storage strip, and the
classifier-storage fold. Both are money items where the partial change opens a hole; the
evidence for each is below and both need an orchestrator decision.

---

## Files changed

### `packages/shared/src/affordability/`

| File                                 | Why                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constants.ts`                       | `OUTLIER_COST_MULTIPLE = 20n` — the ratio §Smart Model 3 fixes, as a bigint because it multiplies a nano-USD median.                                                                                             |
| `percentile.ts` **(new)**            | `nanoPercentile` — the ONE percentile over a nano-USD sample, used by the premium threshold and the outlier median so the selection rule is not spelled out twice.                                               |
| `turn-arithmetic.ts`                 | `maxCallCostTokens`, `maxCallCostNanoUsd`, `medianMaxCallCostNanoUsd`, `outlierModelIds`, `CallCostBasis`, `callCostBasisForTier`; `siblingLineItems` refactored onto one private `lineItemsFor` builder.        |
| `turn-core.ts`                       | classifier-selectable pool = candidate pool − outliers; `runnable` excludes them; trial per-message cap wired as `trial_message_cap_exceeded`; corrected the "offers no choice" comment ruling 1 invalidated.    |
| `premium.ts`                         | `premiumPriceThresholdNanoUsd` + `MIN_POOL_FOR_PRICE_PERCENTILE`; `priceThresholdNanoUsd` becomes optional (a pool too small has no price leg, recency still decides); `exceedsTrialBudget` param renamed.       |
| `estimate/reasoning-plan.ts`         | **Ruling 1**: deleted the early return that emptied `offeredLevels` for a mandatory single-native-word model.                                                                                                    |
| `estimate/effort-options.ts`         | corrected the `default` resolution docblock, which cited the clause ruling 1 removed.                                                                                                                            |
| `estimate/smart-model-affordability.ts` | pool ordered on `maxCallCost` with an identifier tiebreak; ENGINE kept on the prompt-independent combined rate with an identifier tiebreak; `outlier(m)` removed from the pool; `storage` threaded through.   |

### `apps/api/`

| File                                        | Why                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slices/models/domain/trial-eligibility.ts` | **Ruling 5, first half**: collapsed onto `affordability/premium.ts`; the duplicated percentile, recency window and minimal-exchange leg are gone.                       |
| `slices/models/domain/smart-model-candidates.ts` | identifier tiebreak on the engine order (it was tiebreak-free, so database row order decided which model classified every `auto` turn); docblock records the exclusion. |
| `slices/models/domain/catalog-store.ts`     | the whole-table read folds in `model_id` order, so the same table yields the same list twice.                                                                            |

### Tests

New: `turn-core.outlier.test.ts`, `turn-core.resolved-corner.test.ts`,
`estimate/smart-model-order.test.ts`.
Modified: `turn-arithmetic.test.ts`, `turn-core.test.ts`, `premium.test.ts`,
`estimate/reasoning-plan.test.ts`, `estimate/effort-options.test.ts`,
`models/domain/trial-eligibility.test.ts`, `models/domain/smart-model-candidates.test.ts`,
`models/domain/catalog-store.integration.test.ts`, `chat/domain/turn-reasoning.test.ts`,
`chat/routes.integration.test.ts`.

---

## Measurements against the live catalog

The local catalog was empty, so `pnpm catalog:refresh` was run against the live OpenRouter API:
**389 discovered, 182 written, 207 excluded**. All figures below are over those 182 exposed rows
(176 of which are text), measured through the shipped functions.

### Outlier threshold — `× 20` median rule

Paid persisting turn, 1,250 input tokens (a 5,000-character prompt):

- median `maxCallCost` = **222,962,500n**, threshold = **4,459,250,000n**
- **8 of 176 excluded**: `moonshotai/kimi-k3` (18,699,081,600n), `openai/gpt-5.4-pro`
  (26,615,925,000n), `x-ai/grok-4.20` and `x-ai/grok-4.20-multi-agent` (6,947,453,750n each),
  `thinkingmachines/inkling` (5,508,277,608n), `openai/gpt-5.6-sol`, `openai/gpt-5.5`,
  `openai/gpt-5.6-sol-pro` (4,499,987,500n each)
- At the EMPTY basis: the same 8 ids (median 224,000,000n). The exclusion set does not move
  with the prompt on this catalog, and by signature it cannot move with the balance —
  `outlierModelIds` takes no funding argument.
- Two of the eight (`kimi-k3` at a 1,047,326-token cap, `grok-4.20` at 1,998,750) are excluded
  by CAPACITY rather than rate, which is the second target §Smart Model 3 names.

### Rate order vs `maxCallCost` order — a real disagreeing pair

| model                | combined rate | cap for this prompt | `maxCallCost`  |
| -------------------- | ------------- | ------------------- | -------------- |
| `xiaomi/mimo-v2.5`   | 483n/token    | 131,072             | 121,049,634n   |
| `z-ai/glm-4.7-flash` | 529n/token    | 16,384              | 17,453,290n    |

Rate order puts `mimo-v2.5` first; `maxCallCost` order puts `glm-4.7-flash` first, by
**103,596,344n**. Both models and both numbers are pinned in `smart-model-order.test.ts`, so the
two orders are distinguishable in test and the wrong one cannot survive.

### Engine choice is basis-independent

`priceSmartModelPool` picks the engine on the combined rate with an identifier tiebreak, and the
pin asserts the same engine under an empty basis and under a 1,250-token basis, on the very pair
whose POOL order differs between the two bases. A prompt-weighted engine would let the
`affordable` and `admissible` sets buy different classifiers, hence different reserves, and
`admissible ⊆ affordable` could break.

### Trial eligibility — before and after the storage strip

**Model-leg collapse (shipped) is behaviour-identical**, verified by running the deleted logic and
the module logic over the same 176-model pool: **81 eligible before, 81 after**, threshold 8,050n
both ways, zero set difference in either direction. 0 of 176 text models are text-but-unpriceable,
so moving the pool test to `priceableModelFrom` (which also requires a context length) excludes
nothing today.

**Per-message storage strip (NOT shipped) would change eligibility as follows**, over those 81
trial-eligible models, counting how many pass the 1¢ per-message gate:

| prompt size    | with storage (today) | provider-only (after strip) | change  |
| -------------- | -------------------- | --------------------------- | ------- |
| 0 chars        | 81 / 81              | 81 / 81                     | —       |
| 200 chars      | 81 / 81              | 81 / 81                     | —       |
| 2,000 chars    | 77 / 81              | 81 / 81                     | **+4**  |
| 20,000 chars   | 11 / 81              | 62 / 81                     | **+51** |

The product effect is entirely on long conversations: at 20,000 characters the storage term alone
is 6,000,000n — 60% of the whole 1¢ cap — so today a trial user on a long thread can reach 11
models where the provider cost alone would allow 62.

---

## The added criterion: does the gate still dominate the compiled turn floor?

**It does not, even as shipped, past a measured inversion — and the strip widens that band 26-fold.
So the strip is not shipped.**

The gate (`trialMessageBillableNanoUsd`) prices history + prompt. The compiled trial turn prices
the same characters PLUS the server's system prompt — measured at **1,609 characters = 805 trial
input tokens**, matching the plan's ≈805 figure. The gate's surplus over the turn's floor is
therefore `1,000 × outputRate + storage − 805 × inputRate`.

For a 400-character prompt (pinned by amount in `trial-eligibility.test.ts`):

| gate                     | surplus                                    | domination fails when          |
| ------------------------ | ------------------------------------------ | ------------------------------ |
| as shipped (storage in)  | `1,000 × out + 2,620,000 − 805 × in`       | input ≳ **32.5×** output       |
| storage stripped         | `1,000 × out − 805 × in`                   | input > **1.242×** output      |

Both are pinned as executable boundaries (`3,254` inside / `3,255` outside at output 100, and
`125` at output 100 respectively), and the far-inverted case is pinned by amount:
`805 × 4,000 − 1,000 × 100`.

Two consequences:

1. **A pre-existing gap, not one this task created.** An inverted-rate model at ≥ 32.5× would
   escape the shipped gate today. **0 of 176 live models are inverted** (every exposed text model
   prices output at or above input), so nothing is live — but the sweep-over-realistic-shapes
   result the plan quoted proves nothing about this case, exactly as the plan warned.
2. **A gate placement CAN close it, and it is one line outside my ownership.** The gate must price
   the same input the turn prices — `budget.promptCharacterCount`, which
   `apps/api/src/slices/chat/routes.ts` already computes three lines above the gate call
   (`trialTurnDefinitionOrRefusal`, `turnPromptCharacterCount(body, body.prompt, history)`). With
   that basis the gate is `inputTokens × in + 2,000 × out` against a floor of
   `inputTokens × in + 1,000 × out` — domination by construction, every rate shape, storage or no
   storage. That is strictly better than the plan's stated alternative (restoring a funds check on
   the fit's unstamped path, a B4-area change).

**Recommendation:** widen ownership to `chat/routes.ts` for that one call (and the gate's
signature, from `(target, promptText, history)` to `(target, promptChars)`), then strip the
storage in the same change. The strip alone is a money hole; the basis change alone fixes a
pre-existing gap and makes the strip free.

---

## The classifier-storage fold: what I changed, and what I deliberately left

**I touched none of it** — the ruling's second sanctioned option — because the atomic set is
LARGER than the ruling's inventory and spills outside my ownership.

Four sites fold `classifier-storage`, not three:

| site                                                                     | what it folds into                     | owner                     |
| ------------------------------------------------------------------------ | -------------------------------------- | ------------------------- |
| `packages/shared/src/affordability/estimate/classifier-line-item.ts`     | emits the item                         | B6                        |
| `packages/shared/src/affordability/estimate/smart-model-affordability.ts` | the per-candidate caps + the biconditional threshold | mine                      |
| `apps/api/src/slices/models/domain/estimate-run.ts`                      | **the real admission hold**            | mine (added for this)     |
| `apps/api/src/slices/models/domain/trial-smart-model-candidates.ts`      | the trial 1¢ reserve (sums ALL items)  | **NOT in my Files list**  |

Nothing I changed touches any of them. `turn-core.ts`'s own classifier reserve already selects
`kind === 'provider'` positively and is unaffected either way.

Two further facts the next owner needs:

- **Stopping the EMITTER makes all four folds no-ops at once**, so the atomic change is one edit
  plus dead-code removal — not four coordinated ones. But removing `classifierLineItems`'
  now-dead `outputCharsPerToken` parameter breaks `trial-smart-model-candidates.ts`'s call, and
  leaving the parameter in place leaves two knowingly-wrong comments in that same file ("PLUS its
  pass-through storage", "Both classifier line items (tokens + storage)") which I cannot edit.
- **Direction check, done:** for trial, `estimate-run` already passes `storageContext:
undefined`, so the trial HOLD never carried the term while the trial GATE did — removing it
  makes them agree. For paid, caps and hold must fall together, which is the whole point of
  atomicity.

Magnitude of leaving it: the reserve over-charges by roughly 0.2¢ per smart-model turn
(≈6,000 classifier chars × 300n + 512 × ratio × 300n), in the safe direction.

---

## Ruling 1 — the mandatory-single-rung rung

Deleted `offeredLevels`' early return. Consequences, all verified:

- The reproduction is a **rate-identical pair** (`turn-core.resolved-corner.test.ts`): a
  one-native-word mandatory model and a three-word mandatory twin, identical in every rate and
  cap. At a 3,343-token ceiling the single-rung model was SENDABLE while its twin was correctly
  REFUSED; now both refuse, and the single-rung model sends once funding covers
  `B(m, high) + MINIMUM_OUTPUT_TOKENS`.
- Its menu now offers that one rung (`High`) instead of an empty axis.
- A mandatory single-rung model whose provider cap cannot hold its own clamped budget plus a
  minimum answer is now refused as `model_output_cap_too_low` — an honest verdict on a physical
  bound. The fixture in `turn-core.test.ts` (32,000-token cap against a 32,000-token clamped High
  budget) is exactly that shape, and its expectation was rewritten to say so.
- Four expectations inverted, each in a file this task owns: `reasoning-plan.test.ts` (×2, now
  including a companion pinning that an UNOFFERED level still reports `effort-not-supported`),
  `effort-options.test.ts`, `turn-reasoning.test.ts`.

---

## Self-gate

| command                                                                             | result                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm test:shared`                                                                  | **pass — 127 files, 3,017 tests**; coverage 99.9 / 99.46 / 100 / 100                   |
| `pnpm test:web`                                                                     | **pass — 395 files, 6,431 tests**; coverage 99.65 / 98.8 / 99.76 / 99.87               |
| `pnpm test:api`                                                                     | **7 tests red on the third run, all of them the known template-html snapshots**         |
| `npx tsx scripts/with-env.ts npx vitest run --root apps/api src/slices/models`       | pass — 41 files, 796 tests, 1 skipped                                                 |
| `npx tsx scripts/with-env.ts npx vitest run --root apps/api src/slices/chat`         | pass — 34 files, 755 tests                                                            |
| `npx tsx … --root apps/api routes.integration + src/slices/models + src/slices/admin` | pass — 71 files, 1,536 tests (the catalog-pollution combination)                      |
| `npx turbo typecheck --force --continue`                                            | pass — 16/16, zero cached                                                             |
| `npx eslint src/affordability` (from `packages/shared`)                             | exit 0, after the last edit                                                           |
| `npx eslint <owned files>` (from `apps/api`)                                        | exit 0, after the last edit                                                           |
| coverage, `--coverage.include='src/affordability/**'`                               | 99.84 stmts / 99.26 branch / 100 funcs / 100 lines; every file ≥ 95 on every axis      |
| coverage, my three api files                                                        | 100 / 97.72 / 100 / 100; lowest file 96.15 branch                                     |

`pnpm test:web` being fully green is the check that matters most for ruling 1: the effort ladder
feeds `use-prompt-budget` and `use-reasoning-effort`, and neither moved.

**`pnpm test:api` was run three times.** The last one is the state to judge:

| run | red                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------- |
| 1   | 11 tests: 7 template-html snapshots + 3 `runtime.test.ts` + 1 smart-model route — the last four were mine and are fixed |
| 2   | 11 tests: 7 snapshots + 2 trial-route 403s + 2 of my margin tests (see deviation 6)                      |
| 3   | **7 tests: the 7 template-html snapshots, and nothing else** (6,381 passed)                              |

Attributed elsewhere, each reproduced on files this task never touched:

- `notifications/domain/templates/template-html.test.ts` — 7 snapshot failures in all three runs,
  the listed concurrent-workstream entry.
- Run 3 also showed five integration files failing at COLLECTION on
  `deps_ssr/@hushbox_db.js` — the listed stale-pre-bundle entry, triggered by this task adding a
  file to `packages/shared`. `rm -rf apps/api/node_modules/.vite` then re-running those five files
  gives 5 passed / 38 tests. Cache artifact, cured, as the entry says.
- `chat/domain/regenerate.integration.test.ts` — 2 failures in the chat-slice run, passing in
  isolation (the shared-database contention class); absent from run 3.
- **The two `POST /chat/trial` 403s in run 2 are intermittent, not this task's.** They did not
  appear in run 1 or run 3, nor in a deliberately catalog-polluting combination
  (routes.integration + all of `models` + all of `admin`, 1,536 tests green). Mechanism: with a
  small shared catalog the seeded 5-nano model can itself BE the 75th percentile and classify
  premium — a pre-existing property of the percentile over a polluted pool, and one my collapse
  does not change, because every rate-carrying seeded row also carries a context length and so is
  in both the old and the new pool.

**A trap worth adding to §Known Breakage, and a correction to my own first reading of it.**
Running `npx vitest run --root <package>` directly makes ~20 `apps/web` files and
`packages/shared/src/test-polyfills.test.ts` fail at COLLECTION on
`Cannot find module '/@fs/.../scripts/lib/vitest-setup.ts'`. **That file exists**; the failure is
an artifact of bypassing the package's own `test` script (`scripts/with-env.ts` →
`scripts/run-package-tests.ts`), which is what resolves it. `pnpm test:shared` is fully green.
I nearly recorded this as a missing-file breakage — the correct rule is the one already on the
list for `turbo test --filter`: gate through the pnpm script, never through raw vitest.

---

## Acceptance criteria

| criterion                                                              | verdict                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outlier(m)` implemented; balance-independence pinned                  | **met** — `outlierModelIds` takes no funding argument (structural); pinned behaviourally at two balances three orders of magnitude apart, and at three balances on the live path.                     |
| Excluded models remain explicitly selectable; pinned                   | **met** — the row stays in `all` marked available, a pinned selection of the outlier is sendable, and a PINNED model is never excluded however extreme.                                              |
| `eligible(m)` grades on `B(m, e_min(m)) + MINIMUM_OUTPUT_TOKENS`       | **met** — including the mandatory-single-rung shape, which ruling 1 made priceable; pinned by the rate-identical pair.                                                                                |
| Deterministic total order on the catalog read + identifier tiebreak    | **met** — `readLatestDescriptorRows` folds in `model_id` order (integration-pinned by writing out of order); identifier tiebreaks added to both engine orders, pinned by reversed-input equality.     |
| Pool order on `maxCallCost`, pinned disagreeing on a real catalog pair | **met** — the mimo/glm pair above, by amount.                                                                                                                                                        |
| Engine choice basis-independent                                        | **met** — pinned under empty and composed bases on the pair whose pool order differs.                                                                                                                |
| Wire at least one tier refusal reason                                  | **met, partially** — `trial_message_cap_exceeded` is produced by the core. The two PREMIUM codes are NOT: see deviations.                                                                             |
| Ruling 5 — collapse onto `premium.ts`                                  | **met**, behaviour-identical over the live pool (81 = 81).                                                                                                                                            |
| Ruling 5 — stop the trial gate pricing storage                         | **NOT met, reported** — measured before/after above; shipping it alone opens the inverted-shape hole.                                                                                                |
| Classifier-storage fold                                                | **NOT met, reported** — the atomic set includes a file outside ownership.                                                                                                                             |
| Biconditional threshold pinned by a balance sweep                      | **met** — 201-point sweep asserting `admitSmartModel ≠ null ⟺ balance ≥ smartModelMinimumRequiredNanoUsd`, with both arms exercised.                                                                  |
| Fixture with a synthetic outlier                                       | **met, partially** — the outlier is absent from the candidates and the hold falls to the worst surviving candidate; "presented set grows" is asserted only as non-shrinkage. See concerns.            |
| Ruling 1 — mandatory-single-rung priceable                             | **met**.                                                                                                                                                                                              |

---

## Deviations

1. **`runnable` no longer contains every available row.** An outlier candidate's row is in `all`
   and marked available (the picker must keep it) but is NOT in `runnable`. This was forced: B3's
   property pin — hold ≥ the priced total of every arrangement a presented candidate can create —
   is stated over `runnable`, and outlier exclusion would otherwise have made it false (measured:
   hold 89,263,685n against a presented arrangement pricing 117,957,435n, a 32% under-reserve).
   Fixing it by narrowing `runnable` through the SAME derivation (`plan.excludedIds`, produced
   where `classifierPool` is) keeps presented-set and hold-domain one query, which is what that
   pin exists to protect. `OptionSet`'s documented contract permits it (`runnable` members must be
   available; nothing says every available entry is runnable) — but §Data Structures does not
   spell the narrowing out, and a doc line would help. I cannot edit `.md`.
2. **One B3 money pin moved, deliberately, by a measured amount.** `turn-core.test.ts` "withholds
   a candidate whose arrangement starves a pinned sibling": 89,263,685n → **89,231,250n**. The
   fixture's `v/dear` is 60× the pool median's `maxCallCost`, so it leaves the classifier-selectable
   set; that leaves ONE selectable candidate, and one candidate beside a pinned effort buys no
   classifier (§Reserve ⟺ classify is decided on pool size). The delta, 32,435n, is exactly the
   `classifier-tokens` reserve — measured, and the test now also asserts the reserve is 0n. This is
   a hold FALLING for the reason the criteria predict.
3. **Two out-of-ownership test edits**, both single assertions invalidated by behaviour this task
   owns, both left red otherwise:
   - `chat/routes.integration.test.ts` — asserted `classifierModelId === candidateIds[0]`. The
     engine and the pool now ride different orders, and the engine may not be a candidate at all
     (the cheapest model per token can be an enormous-capacity outlier). Verified safe: the
     classifier's own fallback resolves within `node.candidates`
     (`smart-model-execution.ts:231`), and `node-registry.ts:80` resolves the engine separately.
     The assertion is now `classifierModelId !== SMART_MODEL_ID`.
   - `chat/domain/turn-reasoning.test.ts` — named in the coordinator's ruling-1 message.
4. **`catalog-store.ts` sorts in memory rather than with `.orderBy()`.** The query form broke a
   `db` test double in `chat/domain/runtime.test.ts` (a file outside ownership) that stubs
   `.select().from()` without `.orderBy`. In-memory sorting gives the identical contract on a
   read the file already documents as "whole-table selects folded in memory", and touches nothing
   else.
5. **`exceedsTrialBudget`'s parameter renamed** `systemPromptChars` → `promptChars`, because
   `turn-core` passes the whole prompt basis while the classification leg passes a fixed
   representative count. The old name would have been wrong at one of the two call sites.
6. **The margin tests derive their boundary instead of hard-coding it.** First written with the
   measured constants (`805` system-prompt tokens, boundary input `3,255`), they then failed in a
   full `apps/api` run reporting **1,740** system-prompt characters where an isolated run reports
   **1,609** — the same assertion, the same pinned date, a different loaded copy of
   `@hushbox/shared` (`packages/shared/src/prompt/` is unmodified vs `HEAD` and clean in the
   working tree, so the preamble itself did not change; this is the pre-bundle entry on §Known
   Breakage). Both amounts are now computed from `SYSTEM_PROMPT_CHARS` at run time, which is the
   shape the run has already paid for twice: a priced quantity must be computed from the thing
   priced, never from a constant copy of it.

## Not done, and why (needs a ruling)

- **Premium marking (`premium_requires_account` / `premium_requires_credit`) is still unproduced.**
  Naming the field set rather than widening speculatively, per the brief: it needs
  (a) `releasedAtMs: number` on `PriceableModel`, and (b) a `nowMs: number` input on the producer
  — `getTurnOptions`/`CoreInput` — because the module reads no clock and premium recency needs
  one. (b) changes a signature §Where the Code Lives documents, so it is wider than
  "premium/`releasedAt`" and I stopped. The pool percentile itself needs nothing new:
  `premiumPriceThresholdNanoUsd(catalog)` is computable inside the core today.
- **Ruling 5's trial-gate storage strip** and **the classifier-storage fold** — both above.

## Concerns and limitations

- **"Presented set grows" is asserted as non-shrinkage, not as growth.** In the producer, each
  candidate arrangement is solved independently, so excluding an outlier does not enlarge another
  candidate's ceiling; the growth mechanism §Smart Model 3 describes runs through the classifier
  reserve, which `turn-core` sizes over the whole catalog rather than over the classifier pool. I
  deliberately did NOT change that basis: it would move B3's pinned hold amounts for a reason
  unrelated to this task's criteria. On the live path the reserve IS sized over the pool, so
  exclusion does free budget there. Worth a decision: `classifierReserveNanoUsd(catalog, tier)` in
  `turn-core.ts` arguably ought to price the classifier pool, since that is the list the prompt
  actually renders.
- **A trial row's cap check now runs in the producer as well as in the api gate.** They are not a
  duplicated implementation — both call `exceedsTrialBudget` — but they price different bases (the
  producer passes the real `promptChars`, the api classification leg a fixed 1,000). Once the
  producer is wired (B8), the api model-leg gate is the one to delete.
- **`AFFORDABILITY_OUTPUT_TOKENS = 2000` now sits in `trial-eligibility.ts` beside
  `TRIAL_AFFORDABILITY_MULTIPLIER × MINIMUM_OUTPUT_TOKENS` in the module.** They are the same
  number for the same reason but need not agree to be correct (two different gates), so I left
  them separate rather than exporting a derived constant through the wall. If the trial gate moves
  onto a char-count basis (above), it should take the module's figure instead.
- **The 8 excluded outliers include three models a user may well want** (`gpt-5.4-pro`,
  `grok-4.20`, `kimi-k3`). They remain explicitly selectable, which is the ruled behaviour, but
  the Smart Model slot will never route to them.
- **Measurements are against a catalog refreshed today.** The exclusion set is reproducible from
  the catalog, so it will move as the catalog does; the ids above are a snapshot, not a contract.

## Confidence

**Medium-high.** High on everything shipped: each behaviour is pinned by amount, the two orders
are pinned as distinguishable on real models, and the collapse is verified behaviour-identical
over the live pool rather than argued. Medium overall because two ruled items are reported rather
than delivered, and because the `runnable` narrowing (deviation 1) is a semantic change to a
produced shape whose specification does not name it.
