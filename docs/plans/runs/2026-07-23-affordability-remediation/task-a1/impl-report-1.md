# A1 — impl report 1

## Objective

Restore catalog admission's commercial rules so a model that cannot be sold profitably never
enters the catalog, and the operator summary says how many were excluded and why
(`docs/BILLING.md` §Catalog Admission, rules 1–6).

## Files changed

| File                                                            | Why                                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/affordability/constants.ts`                 | The three new constants: `MIN_PRICE_PER_1K_TOKENS_NANO`, `MAX_MODEL_AGE_MS`, `TOP_CONTEXT_PERCENTILE`.                                        |
| `packages/shared/src/affordability/constants.test.ts`            | Value pins for those three, in the file's established per-constant style.                                                                     |
| `packages/shared/src/affordability/catalog-admission.ts` **new** | The three rules as pure predicates. They live in the module because they are rate arithmetic (Global Constraint 4), which is confined to it.   |
| `packages/shared/src/affordability/catalog-admission.test.ts` **new** | Boundary tests for each predicate.                                                                                                      |
| `packages/shared/src/affordability/index.ts`                     | Publishes the new unit and the three constants on the module barrel.                                                                          |
| `apps/api/src/slices/models/domain/normalize.ts`                 | Three new `EXCLUDE_REASONS` members, the `CatalogAdmission` input type, the language-path gate, and the pool measurement in `normalizeCatalog`. |
| `apps/api/src/slices/models/domain/normalize.test.ts`            | New admission tests; mechanical arg migration for the two signature changes; two fixture-driven test corrections (below).                     |
| `apps/api/src/slices/models/domain/refresh.ts`                   | Passes `deps.now().getTime()` into `normalizeCatalog`; `alertExcluded`'s docblock lists the three new quiet reasons.                          |
| `apps/api/src/slices/models/domain/refresh.integration.test.ts`  | End-to-end pin: quiet, counted by reason, never persisted.                                                                                    |
| `scripts/refresh-catalog.test.ts`                                | The exhaustive `Record<ExcludeReason, number>` gains the three keys (typecheck-forced); new operator-line test.                               |

### Design decisions worth an auditor's attention

**Why the rules live in `packages/shared/src/affordability/catalog-admission.ts` and not in
`normalize.ts`.** The floor is a comparison on a rate. Putting `BigInt(prompt) + BigInt(completion)
< THRESHOLD` in `apps/api` would plant exactly the defect the plan already records as G1 rule 4's
open gap (`isPremiumModel`'s `parseFloat` rate arithmetic outside the module). `normalize.ts` now
does no rate arithmetic: it parses gateway strings to nano (existing `usdRateToNanoUsd`) and calls
`priceFloorVerdict` / `exceedsModelAgeLimit` / `topContextExemptionTokens`. The constants stay in
`affordability/constants.ts` as the criterion requires; the predicates sit beside them in their own
unit.

**Why the exemption threshold is an injected input rather than a per-model computation.** The
percentile is a property of the pool, so no per-model function can derive it. `normalizeCatalog`
measures it once and passes a `CatalogAdmission { contextExemptionTokens, nowMs }` down through
`resolveGroup` → `normalizeModel` → `normalizeLanguage`. That is what forced the two signature
changes.

**Why the gate sits inside `normalizeLanguage`, after the existing checks and before `bakeFees`.**
Two properties fall out for free. (1) *Pre-fee*: it reads `tokenPricing(model.pricing)` — the same
pre-fee nano object that then goes into the descriptor — literally before the `bakeFees` call at the
`normalizeModel` choke point. (2) *Precedence*: `non-zdr`, `non-conversational`, `deprecated`,
`unclassifiable-modality` and `missing-release-date` all already return before it, so a cheap
non-ZDR model still reports `non-zdr` (160 of the live catalog's exclusions), and the age rule never
runs without a release date. Both are pinned by test.

**Rules 1–4 apply to the language path only** (rule 5). Verified legacy behaviour: the deleted
`packages/shared/src/models/process-models.ts` (at `64d4376f^`) applied the floor, age cutoff and
context exemption in `processTextModels` and applied none of them in `processImageModels` /
`processVideoModels`. So the age cutoff is text-only too, not just the floor — pinned by two tests.

**The percentile formula is legacy's, byte for byte**: ascending sort, `index =
min(floor(len × 0.95), len − 1)`, exempt iff `contextLength >= sorted[index]`. Ties are inclusive.
A one-model pool exempts itself (index 0 = the only value) — that degenerate case is pinned
explicitly, because it is why most existing small-fixture tests are unaffected and an auditor
should see it stated rather than discover it.

## Tests added

| Test                                                                                | Behaviour                                                            | Criterion                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `priceFloorVerdict` × 4                                                             | zero; exactly at the floor; one nano under; one nano over            | floor, pre-fee                  |
| `exceedsModelAgeLimit` × 3                                                          | exactly at the cutoff; one second past it; released today            | age cutoff                      |
| `topContextExemptionTokens` × 5                                                     | top 5% of 100; order-independence; single-model pool; empty pool; tie | exemption over the pool         |
| `MIN_PRICE_PER_1K_TOKENS_NANO` × 2, `MAX_MODEL_AGE_MS`, `TOP_CONTEXT_PERCENTILE`     | constant values and the per-token equivalence                        | named + exported constants      |
| `excludes a language model whose combined rate is zero`                             | rule 1                                                               | zero-priced reason              |
| `excludes a language model that states no rate at all`                              | absent pricing is a zero rate                                        | zero-priced reason              |
| `excludes a language model one nano under the price floor`                          | rule 2                                                               | below-price-floor reason        |
| `admits a language model exactly at the price floor` / `one nano over`               | the floor is inclusive                                               | boundary exactness              |
| `tests the floor against the pre-fee rate, not the baked billable rate`             | 199 nano fails even though 229 billable would pass                   | **pre-fee evaluation**          |
| `excludes a language model older than the age limit` / `admits ... exactly at`       | rule 3 and its boundary                                              | age cutoff                      |
| `reports the price floor first when a model fails the floor and the age limit`      | deterministic reason order                                           | **stable counts across runs**   |
| `exempts a top-context model from the price floor` / `from the age limit`            | rule 4, both bypasses                                                | exemption paths                 |
| `does not exempt a model one token below the context threshold`                     | the threshold is inclusive at its own value only                     | exemption boundary              |
| `never exempts a zero-priced model, however large its context`                      | rule 4 never bypasses rule 1                                         | **free + largest context**      |
| `applies no per-token floor or age limit to an image model` / `to a video model`     | rule 5                                                               | text-only scope                 |
| `reports non-zdr ahead of a commercial exclusion`                                   | firm gates win                                                       | reason precedence               |
| `reports a missing release date ahead of a commercial exclusion`                     | age cannot be judged without a date                                  | reason precedence               |
| `measures the context exemption over the pool, not over one model`                  | two-model pool: small excluded, large exempt                         | pool-relative exemption         |
| `leaves a ZDR-unreachable model out of the pool ...`                                | a hidden 1M-context model would otherwise revoke a real exemption    | **ZDR-filtered pool**           |
| `leaves a media model out of the pool ...`                                          | media carries no token context                                       | ZDR-filtered *language* pool    |
| `measures the age cutoff from the clock the caller passes`                          | injected clock, no `Date.now()` in domain                            | age cutoff at the choke point   |
| `excludes commercially unsellable models quietly, counted by reason` (integration)  | all three counted, none persisted, zero warns, zero Sentry codes     | **quiet-expected group**        |
| `reports each commercial exclusion separately, never collapsed` (scripts)           | the three appear in the operator line, in `EXCLUDE_REASONS` order    | **operator summary line**       |

### TDD record, stated exactly

- `priceFloorVerdict`, `exceedsModelAgeLimit`, `topContextExemptionTokens`: each written test-first
  and watched red for the right reason (missing module, then 3 failing, then 5 failing), then minimal
  green. Three separate red→green cycles.
- The 24 `normalize.test.ts` admission tests were written before any `normalize.ts` edit and run:
  **12 failed, 9 passed**. The 12 are every discriminating case. The 9 that passed pre-implementation
  are guard tests asserting *unchanged* outcomes (the `admits …` cases, the two media cases, the two
  precedence cases) — they cannot be red before the rules exist, and their value is regression
  protection.
- Two tests could not be driven red because their subject derives from `EXCLUDE_REASONS`, which the
  `normalize.test.ts` cycle had already forced into existence. Both were therefore verified by
  **positive control** instead, which is disclosed rather than glossed:
  - the operator-line test: removing `'below-price-floor'` from `EXCLUDE_REASONS` made it fail;
    restored, green (`git diff --stat` on `normalize.ts` confirms the file is back).
  - the quietness integration test: adding a `warn` branch for `below-price-floor` in
    `alertExcluded` made it fail; restored, green (`git diff --stat` shows refresh.ts back at its
    intended 6-insert diff).
- The four constant-value pins in `constants.test.ts` passed on first run. They are value
  documentation in that file's established style, not behaviour drivers; the behaviour that consumes
  them was red first.

### Two existing tests corrected, with reasons

1. `leaves pricing empty when the model reports none` → `leaves pricing empty when a media model
   reports none`. A language model with no pricing has a combined rate of zero and is now excluded
   by rule 1, so the language path no longer has that outcome. The `tokenPricing(undefined) → {}`
   behaviour it guarded is retested through the video path, where it is still reachable.
2. `bakes the ceil-rounded markup into a flat language rate` now passes the `EXEMPT` admission. Its
   fixture states 1 nano/token deliberately (to pin `ceil(1 × 1.15) = 2`), which is under the floor.
   `EXEMPT` is `contextExemptionTokens: 0` — a genuine state (the exemption a small pool produces),
   not a disabled rule: the same fixture with a zero rate is still excluded, pinned by
   `never exempts a zero-priced model`.

Everything else in `normalize.test.ts` changed only by gaining `, ADMISSION` / `, NOW_MS` in an
argument list. Verified mechanically: `diff` against the pre-migration copy shows **no added line
that does not carry the new argument**.

## Self-gate

| Command                                                                | Result                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm test:shared`                                                     | **pass** — 110 files / 2674 tests; `catalog-admission.ts` 100/100/100/100, `constants.ts` 100% |
| `pnpm test:api`                                                        | **1 pre-existing file red** — 465 files / 6388 tests pass; the 7 failures are all `notifications/domain/templates/template-html.test.ts` (§Known Breakage, "the single `apps/api` failure a scoped run will show") |
| per-file coverage, `normalize.test.ts` + `refresh.integration.test.ts` | `models/domain/normalize.ts` 99.64 / 97.42 / 97.95 / 99.57; `refresh.ts` 100 / 97.22 / 100 / 100 — both above 95, uncovered lines (786, 90) are pre-existing `??` fallbacks |
| `turbo typecheck --filter=@hushbox/api --filter=@hushbox/shared`       | **pass** — 2 successful, 0 errors                                                            |
| `turbo lint --filter=@hushbox/api --filter=@hushbox/shared`            | **pass** — 2 successful                                                                      |
| `eslint <owned files>` from each package dir, after the final edit     | **exit 0** in `apps/api`, `packages/shared`, `scripts`                                       |
| `pnpm arch:check`                                                      | **pass** — OK, 11 rules over 1992 files                                                      |
| `turbo test --filter=@hushbox/scripts` (courtesy — I edited a scripts test) | `refresh-catalog.test.ts` green (4/4). 3 failures, none mine: the two §Known Breakage collection failures (`refresh-catalog-run.test.ts`, `seed-run.test.ts`) plus `generate-env.test.ts` — see attribution below |

Mid-run typecheck note, recorded because it moved: an earlier typecheck run showed three
`conversationFunding` / `BillingRouteDeps` errors in `app.ts`, `app-mount.integration.test.ts` and
`slices/billing/routes-usage.integration.test.ts`. `conversationFunding` is added by
`apps/api/src/slices/billing/routes.ts:72`, an F1-owned uncommitted file; F1 finished its call sites
during my run and the errors are gone. Nothing of mine was involved.

### `generate-env.test.ts` — re-verified per §Known Breakage's instruction

The plan flags this entry as unverified post-commit. Verified now: it still fails, and the cause is
the notifications/push workstream. The assertion diff is the ci.yml verify-secrets loop gaining
`VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY NOTIFICATION_TAG_SECRET` — present in `env.config.ts`, absent
from the test's expected string. `git status --porcelain` is empty for `scripts/generate-env.ts`,
`packages/shared/src/env.config.ts` and `.github/workflows/`, so it reproduces with inputs
byte-identical to HEAD, on files this task never touched. Needs an owner outside this run.

## Acceptance criteria

**Three new members of the closed exclusion-reason set, in the quiet-expected group** — **met**.
`EXCLUDE_REASONS` gains `zero-priced`, `below-price-floor`, `too-old`, inserted after
`missing-pricing` and before `deprecated` — inside the quiet block, ahead of the fail-closed tail.
`alertExcluded` has no branch for them, so they are counted and never alerted with no new
instrumentation. Pinned end to end by the integration test (zero warns, zero Sentry codes, zero rows
persisted) and by the operator-line test.

**The floor tests the pre-fee combined rate, evaluated before fee baking at the ingestion choke
point** — **met**. The gate reads `tokenPricing(model.pricing)` inside `normalizeLanguage`; `bakeFees`
runs afterwards, in `normalizeModel`. Pinned by
`tests the floor against the pre-fee rate, not the baked billable rate`: 199 nano/token combined is
excluded even though its billable value (229) clears the floor.

The brief's NEEDS_CONTEXT trigger did not fire: a pre-fee evaluation point exists at the choke point
(`normalizeLanguage` is called by `bakeFees(normalizeLanguage(...))`, so its whole body is pre-fee).

**The top-context exemption is computed over the ZDR-filtered pool and applies to the floor and the
age cutoff only; a free model with the largest context is still excluded** — **met**. The pool is
`zdrLanguageContexts()` — ZDR-reachable language-source entries. Three pool tests discriminate it:
a ZDR-unreachable 1M-context model must not raise the threshold (if it did, `large/ctx` would flip
from admitted to excluded), and neither must a media entry. `never exempts a zero-priced model,
however large its context` uses a 100M-token context with `contextExemptionTokens: 0` and still
gets `zero-priced`, because rule 1 returns before the exemption is consulted.

**Deterministic reason when a model fails both the floor and the age cutoff (price first)** —
**met**. `commercialExclusionReason` returns in the order zero → floor → age, and
`reports the price floor first when a model fails the floor and the age limit` pins it with a fixture
that fails both.

**New constants named and exported from the constants module** — **met**.
`MIN_PRICE_PER_1K_TOKENS_NANO = 200_000n`, `MAX_MODEL_AGE_MS = 2 × 365 days`,
`TOP_CONTEXT_PERCENTILE = 0.95`, all in `affordability/constants.ts` and on the
`@hushbox/shared/affordability` barrel.

**Fixture-level tests for each rule and each exemption path, plus a summary-formatting test** —
**met**; see the table above.

**The seeded catalog survives** — **met, by positive evidence, no fixture change needed.** Details
below.

## The catalog-survival evidence

Run against the live OpenRouter catalog on 2026-07-26 through the real `refreshCatalog` job
(`pnpm catalog:refresh`, the same job the hourly cron runs).

**Before** (HEAD code):

```
catalog:refresh: 391 discovered, 207 written, 0 unchanged, 184 excluded (2 token-priced-image,
2 token-priced-video, 3 missing-pricing, 5 deprecated, 160 non-zdr, 6 non-conversational,
6 non-runnable-shape).
```

**After**:

```
catalog:refresh: 391 discovered, 18 written, 164 unchanged, 209 excluded (2 token-priced-image,
2 token-priced-video, 3 missing-pricing, 1 zero-priced, 12 below-price-floor, 12 too-old,
5 deprecated, 160 non-zdr, 6 non-conversational, 6 non-runnable-shape).
```

Per new reason: **1 zero-priced, 12 below-price-floor, 12 too-old** = 25 newly excluded. Arithmetic
closes both ways: 184 + 25 = 209 excluded, and 207 − 25 = 182 admitted = 18 written + 164 unchanged.
Every pre-existing reason's count is unchanged, which is the evidence that precedence did not
re-attribute anything.

Also measured live, through the real predicates on the same fetch: the ZDR language pool is **218
models** and the top-context exemption threshold is **1,050,000 tokens**; **0** models are currently
rescued by the exemption (nothing at or above 1.05M context is also below-floor or too old). The
exemption is live and measured, but inert on today's catalog — worth knowing before someone reads a
green exemption test as evidence it fires in production.

**The 25 newly excluded ids** (enumerated by running the real `normalizeCatalog` over the same live
fetch; the per-reason counts reproduce the refresh line exactly, which is what makes the id list
trustworthy):

- `zero-priced` (1): `inclusionai/ling-3.0-flash:free`
- `below-price-floor` (12): `mistralai/mistral-nemo`, `inclusionai/ling-2.6-flash`,
  `openai/gpt-oss-20b`, `meta-llama/llama-3.1-8b-instruct`, `qwen/qwen-2.5-7b-instruct`,
  `amazon/nova-micro-v1`, `google/gemma-3-4b-it`, `mistralai/mistral-small-24b-instruct-2501`,
  `sao10k/l3-lunaris-8b`, `ibm-granite/granite-4.1-8b`, `google/gemma-3n-e4b-it`,
  `gryphe/mythomax-l2-13b`
- `too-old` (12): `openai/gpt-4o-mini`, `openai/gpt-4o`, `meta-llama/llama-3.1-70b-instruct`,
  `anthropic/claude-3-haiku`, `microsoft/wizardlm-2-8x22b`, `google/gemma-2-27b-it`,
  `openai/gpt-4o-2024-05-13`, `undi95/remm-slerp-l2-13b`, `openai/gpt-4`,
  `openai/gpt-3.5-turbo-0613`, `openai/gpt-3.5-turbo-16k`, `mancer/weaver`

**Every id the seed and E2E depend on is still admitted**, checked against the same live evaluation:

| Id                                          | Where it is depended on                                                              | Verdict      |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| `anthropic/claude-opus-4.6`                 | `E2E_MODELS.text[0]`, `scripts/seed.ts` `SEED_MODEL_ID`, `e2e/chat/smart-model.spec.ts`, `e2e/usage/usage.spec.ts` | **ADMITTED** |
| `anthropic/claude-sonnet-4.6`               | `E2E_MODELS.text[1]`, `e2e/chat/smart-model.spec.ts`                                 | **ADMITTED** |
| `bytedance-seed/seedream-4.5`               | `E2E_MODELS.image`, three image specs                                                | **ADMITTED** |
| `google/veo-3.1-lite`, `kwaivgi/kling-video-o1` | `E2E_MODELS.video`, video specs                                                  | **ADMITTED** |

Plus the derived dependencies: `E2E_SEEDED_IMAGE_MODEL_ID` is a synthetic image row inserted into
`model_catalog` directly after the refresh, so no admission rule touches it; `pickSeedTextModels`
picks from exposed descriptors at seed time and 182 remain.

**Reverse sweep**: each of the 25 excluded ids grepped repo-wide (`apps`, `packages`, `scripts`,
`e2e`; excluding `node_modules`, `dist`, `legacy/` and the generated `e2e/report/` Playwright trace
artifacts). Two non-test hits, both dispositioned without an edit:

1. `apps/api/src/slices/models/adapters/integration-setup.ts` — `REAL_MODEL_IDS.language =
   'openai/gpt-4o'` and `REASONING_MODEL_IDS.effortNative = 'openai/gpt-oss-20b'`, both now
   catalog-excluded. **Not a break**: these cassette integration tests never read the catalog —
   `descriptorFor` hand-builds the descriptor (`zdrReachable: true` hardcoded, per its own docblock)
   and calls OpenRouter directly, where both models still exist. Raised as an observation, not
   changed: swapping an id invalidates its cassette and forces a real recorded call, which is the
   cassette workstream's call to make.
2. `scripts/lib/seed-fixtures.ts` — `openai/gpt-4o` appears in `USAGE_MODELS` and
   `PUBLIC_TEXT_MODELS`. **Not a break**: these are historical usage/stats rows, and nothing joins
   them to `model_catalog` (`seed-billing-history.ts` carries `modelId` as a plain string). The
   leaderboard spec's own docblock states it deliberately pins no model names. Leaving them also
   avoids touching `scripts/.cache/seed-crypto.json`, which the brief flags as dirty from another
   workstream.

All remaining hits are unit tests using `openai/gpt-4o` / `openai/gpt-4o-mini` as an arbitrary id
string over hand-built descriptors or mock stores — never through catalog admission. (Several are
substring artifacts: `openai/gpt-4` matches inside `openai/gpt-4o`.)

## Deviations

1. **Two files edited beyond the plan's Files list, both forced.**
   `apps/api/src/slices/models/domain/refresh.ts` is the only caller of `normalizeCatalog`, so the
   new `nowMs` argument has to be passed there; the same edit updates `alertExcluded`'s docblock,
   which enumerates the quiet reasons and would otherwise be a wrong comment. `scripts/refresh-catalog.test.ts`
   holds an exhaustive `Record<ExcludeReason, number>` literal that fails typecheck with three new
   union members, and it is where the operator-line criterion is testable. Also
   `refresh.integration.test.ts`, for the quietness pin.
2. **A new file inside the affordability module** (`catalog-admission.ts`) rather than putting the
   predicates in `normalize.ts`. Reason in Design decisions above: Global Constraint 4.
3. **The floor constant is named `MIN_PRICE_PER_1K_TOKENS_NANO`, not `MIN_PRICE_PER_1K_TOKENS`** as
   `BILLING.md` §Catalog Admission 2 writes it. Same quantity, stated in nano-USD bigint instead of
   a USD float, because Global Constraint 3 forbids a `Number`-valued money comparison. `_NANO` is
   the codebase's existing convention (`STORAGE_COST_PER_CHARACTER_NANO`,
   `WEB_SEARCH_RESERVATION_NANO_PER_MODEL`). Flagged for the doc sweep, not changed here — `.md`
   files are read-only to me.
4. **The three constants are published on the `@hushbox/shared/affordability` barrel** (not the root
   barrel, which is untouched). They are not on §Where the Code Lives' not-exported list, and
   `index.test.ts`'s wall assertions still pass, but B8's future "barrel is exactly the documented
   surface" criterion will have to rule on them.

## Concerns and limitations

- **Nothing deletes a catalog row that a later rule excludes.** `catalog-store.ts` has no delete or
  prune path, so the 25 models this change newly excludes keep their previously-persisted rows and
  stay exposed. That is pre-existing architecture, true of every exclusion reason, but A1 is the
  first change that newly excludes already-persisted models, so it is the first time it matters —
  and the local dev database is in exactly that state right now (182 admitted, 25 stale rows still
  present from the "before" refresh). Raised; out of my ownership.
- **The exemption is inert on today's live catalog** (threshold 1.05M tokens, 0 models rescued).
  Correct per spec and legacy, but a reader should not take the green exemption tests as evidence
  the path fires in production.
- **A single-model ZDR language pool exempts itself** (percentile index 0 on a one-element array).
  That is legacy behaviour and it is pinned deliberately, but it means a fixture with one language
  model silently bypasses the floor and the cutoff. It is why most existing tests were unaffected,
  and why my pool tests all use ≥2 models with distinct context lengths.
- **The `pnpm test:api` coverage gate could not be observed passing** end to end, because the gate
  reports after the run and the run is red on the pre-existing `template-html.test.ts`. The per-file
  numbers for both files I changed were measured directly and are above 95.
- **Not run** (outside my scoped checks): `pnpm test:web`, `pnpm lint:duplication`,
  `pnpm lint:unused`, and any E2E (Global Constraint 11 forbids E2E execution).

## Confidence

**High.** Every rule is pinned at both the unit and the pool level with inclusive/exclusive
boundaries taken one nano and one second either side; the behaviour was verified against the real
live catalog and the before/after arithmetic closes exactly; the two tests that could not be driven
red were verified by positive control instead of assertion; and the seeded/E2E survival is positive
evidence from the same live evaluation rather than an argument. The residual risk is not in the rules
but in the two items raised above: the absence of a purge path for newly-excluded rows, and the
cassette models that are now unsellable.
