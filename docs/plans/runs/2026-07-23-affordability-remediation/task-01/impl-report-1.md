# Task 01 — impl report 1

Ingest `top_provider.max_completion_tokens` into `descriptor.limits.maxOutputTokens`
for language models. Absent/null upstream ⇒ the key is omitted entirely (never null);
image/video untouched.

## Files changed (all within Task 01's Files list)

- `apps/api/src/slices/models/domain/gateway-metadata.ts`
  - `modelsEntrySchema` gains (verbatim):
    ```ts
    // Aggregate stats of the currently selected top/default provider; its
    // `max_completion_tokens` is the model's output-token ceiling
    // (integer|null upstream, null semantics undocumented).
    top_provider: z
      .looseObject({
        max_completion_tokens: z.number().nullish(),
      })
      .nullish(),
    ```
  - `LanguageMetadata` gains
    `readonly maxCompletionTokens?: number | undefined;` (optional-key pattern,
    same as `popularityRank`, so existing constructors stay valid).
  - New helper `maxCompletionTokensOf(raw)` collapses null/absent to `undefined`;
    `languageMetadata()` maps
    `maxCompletionTokens: maxCompletionTokensOf(entry.top_provider)`.
    (Helper extracted rather than inline `?.`/`??` because inline pushed
    `languageMetadata` past the lint complexity cap of 10.)
- `apps/api/src/slices/models/domain/normalize.ts`
  - `normalizeLanguage` limits line replaced by `limits: languageLimits(model)` with:
    ```ts
    /** `maxOutputTokens` is written only for a positive-integer gateway ceiling;
     * absent/null (or a nonsensical value) omits the key so consumers fall back
     * to `contextLength`. */
    function languageLimits(model: LanguageMetadata): DescriptorContent['limits'] {
      const ceiling = model.maxCompletionTokens;
      return {
        ...(model.contextLength === undefined ? {} : { contextLength: model.contextLength }),
        ...(ceiling !== undefined && Number.isInteger(ceiling) && ceiling > 0
          ? { maxOutputTokens: ceiling }
          : {}),
      };
    }
    ```
    Image/video normalize paths untouched (`limits: {}` as before).
- `apps/api/src/slices/models/domain/gateway-fixtures.ts` — `modelEntryFixture`
  default gains `top_provider: { context_length: 128_000, max_completion_tokens:
  16_384, is_moderated: false }` (the key is required on the upstream model object
  per research/openrouter-max-output-web.md §1; overrides drive null/absent cases).
- `apps/api/src/slices/models/domain/gateway-metadata.test.ts`,
  `normalize.test.ts` — tests below.

No shared-schema edit needed: `packages/shared/src/model-descriptor.ts:100` types
`limits` as `z.record(z.string(), z.number())`, so the new key is additive and rows
without it remain valid (Verified by grep + the full models-slice run).

## Tests (TDD ledger)

| Test | Red observed | Green |
|---|---|---|
| (a) `gateway-metadata.test.ts` › "carries top_provider.max_completion_tokens as maxCompletionTokens" | `expected undefined to be 16384` | schema + seam field + mapping |
| (b) `gateway-metadata.test.ts` › "collapses a null max_completion_tokens to absent" | `expected null to be undefined` (mapping deliberately lacked the null-collapse) | `?? undefined` collapse (now in `maxCompletionTokensOf`) |
| (c) `gateway-metadata.test.ts` › "leaves maxCompletionTokens absent when top_provider is missing entirely" | passed on introduction (optional chain already yields undefined) — a pin, noted honestly | — |
| (a) `normalize.test.ts` › "writes limits.maxOutputTokens from a positive-integer gateway ceiling" | limits diff missing `maxOutputTokens: 16384` | `languageLimits` without guard |
| guard `normalize.test.ts` › "omits maxOutputTokens when the gateway ceiling is not a positive integer" (0, −1, 0.5) | `+ "maxOutputTokens": 0` leaked | positive-integer guard added |
| (b/c) `normalize.test.ts` › "omits maxOutputTokens when the gateway reports no ceiling" | pin (undefined at the seam covers both null and absent upstream — collapse proven at the gateway seam) | — |
| (d) `normalize.test.ts` › "carries no limits — image models have no token-cap concept" / "… video models …" | pins of deliberately unchanged behavior (cannot go red by design) | — |

Also extended the existing "fetches and merges the four catalog endpoints" assertion
with `maxCompletionTokens: 16_384` (rides the new fixture default).

## Checks

- `pnpm test:watch apps/api/src/slices/models --run` — **41 files passed, 754 tests
  passed, 1 skipped** (whole models slice incl. refresh/pricing-resolver/catalog-store
  integration tests that consume the updated fixture). Verified.
- `pnpm test:api` — fails, **all 15 failures outside this task and pre-existing/concurrent**:
  - `src/slices/billing/routes.integration.test.ts` (4) — sibling T07's files
    (`GET /billing/spendable`), also the only source of the 13 `tsc` errors.
  - `src/slices/chat/routes.integration.test.ts` (4) — derived-cap mismatches
    (`expected { maxOutputTokens: 8189 } to deeply equal { maxOutputTokens: 8312 }`),
    sibling T10's prompt/adapter territory. Cannot be mine: nothing anywhere reads
    `limits['maxOutputTokens']` yet (repo-wide grep — sole hit is my test name), so
    my change is unread-additive.
  - `src/slices/notifications/domain/templates/template-html.test.ts` (7) — email
    template snapshot drift, unrelated slice.
- `turbo typecheck lint --filter=@hushbox/api` — typecheck fails **only** on
  `src/slices/billing/*` (T07); `cd apps/api && npx tsc --noEmit` filtered to
  non-billing paths: zero errors. Verified.
- `cd apps/api && npx eslint <5 owned files>` after the final edit — **exit 0**. Verified.
- Coverage (owned production files, full-suite run with include-filtered report):
  see addendum below — recorded after the background run completed.

## Coverage addendum

Full `apps/api` suite (`pnpm test:watch apps/api/src --run --coverage.enabled=true
--coverage.reportOnFailure=true` with `--coverage.include` scoped to the owned
files). Verified:

| File | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| `gateway-metadata.ts` | 100 | 95.65 | 100 | 100 |
| `normalize.ts` | 99.6 | 97.12 | 97.56 | 99.53 |

Both ≥ 95 on every axis; no `does not meet threshold` errors were emitted for any
owned file. (`gateway-fixtures.ts` prints no row — test-support file outside the
coverage report set.) The run's exit 1 is solely the 12 unrelated test failures
(template-html ×7, chat routes ×4, identity routes-timing-store ×1 — the last is a
known-flaky timing integration test that passed in the other full runs this
session). The uncovered remainder in both files (gateway-metadata.ts branches at
332, 390–395; normalize.ts line 656) predates this task and is outside the changed
regions.

## Concerns / notes for the auditor

- The `pnpm test:api` gate cannot go green in this worktree while T07/T10 are
  mid-flight; attribution evidence above. The models slice itself is fully green.
- Task 02 will rewrite `normalize.ts` pricing next; `languageLimits` was kept as a
  self-contained helper to keep that diff orthogonal.
