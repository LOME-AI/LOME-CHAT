# A2 — Catalog exclusion is a soft delete — implementation report 1

## Objective

A model that becomes inadmissible stops being sellable without losing its row, and a model
that becomes admissible again returns with no human action. Normative clause:
`docs/BILLING.md` §Catalog Admission item 4.

## Files changed

**Schema (`packages/db`)**

- `src/schema/enums.ts` — new `modelExcludeReasonEnum` (`model_exclude_reason`) sourced from
  the shared `EXCLUDE_REASONS` const, matching the eleven existing enums that derive from a
  shared closed set.
- `src/schema/index.ts` — export the new enum.
- `src/schema/model-catalog.ts` — `excluded_reason` (nullable enum), `excluded_at` (nullable
  timestamptz), `last_seen_at` (NOT NULL DEFAULT now()), each with the durable fact that
  explains it (derived-vs-asserted, first-moment preservation, staleness).
- `drizzle/0060_panoramic_steel_serpent.sql` + `drizzle/meta/0060_snapshot.json` +
  `drizzle/meta/_journal.json` — the generated migration, shipping with the schema change.
- `src/schema/shape-enums.test.ts`, `src/schema/shape-tables.test.ts` — the shape-test
  registry entries (`ALL_ENUMS` membership, the derivation pin, three column pins).

**The single authority for the reason set (`packages/shared`)**

- `src/models/exclude-reasons.ts` (new) — `EXCLUDE_REASONS` + `ExcludeReason`, relocated
  verbatim from the models slice. See **Deviations** for why the move was forced.
- `src/models/index.ts` — export both.

**Models slice (`apps/api`)**

- `src/slices/models/ports/catalog-lifecycle.ts` (new) — `CatalogSighting` +
  `RecordCatalogSighting`, the soft-delete write seam.
- `src/slices/models/ports/index.ts` — export the port types.
- `src/slices/models/adapters/catalog-lifecycle.ts` (new) —
  `createCatalogSightingRecorder`: one conditional `UPDATE … WHERE model_id`, wrapped in
  `idempotent.byUpsert` (convergent single-key write). Never inserts, never touches
  `descriptor`, never touches `admin_disabled_at`.
- `src/slices/models/domain/catalog-store.ts` — `StoredDescriptorRow.excludedReason` is read
  and surfaced; `upsertCatalog` now clears `excluded_reason`/`excluded_at` and stamps
  `last_seen_at` on both the insert and the conflict arm (writing a descriptor *is* an
  admission).
- `src/slices/models/domain/refresh.ts` — `recordSighting` on `RefreshCatalogDeps`; the
  persist loop marks, unmarks and re-sights. Extracted `markExcluded` and `persistAdmitted`
  to stay inside the complexity budget.
- `src/slices/models/domain/normalize.ts` — imports the reason set/type from
  `@hushbox/shared` instead of declaring it.
- `src/slices/models/domain/list-descriptors.ts` — **the exposure filter**:
  `adminDisabledAt !== null || excludedReason !== null` → hidden, silently.
- `src/slices/models/domain/index.ts`, `src/slices/models/index.ts` — barrel updates (the
  reason set no longer re-exported; the recorder factory and port types added).

**Call sites of the new dep**

- `src/scheduled.ts` (hourly cron), `src/platform/dev/seed-toolkit.ts` (dev surface),
  `scripts/refresh-catalog.ts` (`pnpm catalog:refresh`), `scripts/refresh-catalog.test.ts`
  (import path only).

**Test wiring / fixtures**

- `src/slices/models/domain/refresh.integration.test.ts` — `depsFor` builds the real
  recorder; ten new lifecycle tests; one pre-existing test renamed for accuracy.
- `src/slices/models/domain/list-descriptors.integration.test.ts` — recorder wiring + the
  exposure pin.
- `src/slices/models/domain/pricing-resolver.integration.test.ts`,
  `src/slices/models/domain/admin-disabled.integration.test.ts`,
  `src/slices/chat/domain/media-turn.integration.test.ts`,
  `src/jobs/poller-entries.integration.test.ts` — recorder wiring only.
- `src/slices/models/domain/admin-disabled.test.ts`,
  `src/slices/models/domain/admin-catalog.test.ts` — `StoredDescriptorRow` fixtures gain
  `excludedReason: null`.

## Tests added

| Test (`refresh.integration.test.ts`, describe `refreshCatalog exclusion lifecycle`) | Behavior | Criterion |
| --- | --- | --- |
| marks an already-persisted model that becomes inadmissible | reason + `excluded_at` + `last_seen_at` written on the existing row | the refresh marks |
| keeps the marked row rather than deleting it | the row survives the mark | soft delete, not hard |
| clears the mark when a marked model becomes admissible again | reason and stamp both null; `last_seen_at` advanced | the refresh unmarks |
| leaves `admin_disabled_at` untouched when it clears the mark | the asserted column survives the unmark | the two-authorities clause |
| leaves `admin_disabled_at` untouched when it marks a row excluded | the asserted column survives the mark | the two-authorities clause |
| writes no row for a model that was never admissible | zero rows for an unsellable, never-seen model | marked, never created |
| writes no row for a model whose descriptor is unbuildable | zero rows for a `missing-release-date` model — no values exist to write | marked, never created |
| keeps the first `excluded_at` across repeat refreshes | the stamp is "excluded since", not "last seen excluded" | `excluded_at` semantics |
| clears the mark on a row whose descriptor is unchanged | the unmark also works on the skip-unchanged path | the refresh unmarks |
| advances `last_seen_at` for a model whose descriptor is unchanged | staleness stays honest without a descriptor rewrite | `last_seen_at` advances |

| fails unavailable when marking an excluded row fails | the sighting write's error reaches the caller as a typed `unavailable` | error channel + coverage |
| fails unavailable when re-sighting an unchanged row fails | same, on the skip-unchanged path | error channel + coverage |

| Test (`list-descriptors.integration.test.ts`) | Behavior | Criterion |
| --- | --- | --- |
| hides a soft-deleted model without alerting (a derived verdict, not corrupt) | the model is exposed, then marked, then absent — with no telemetry error | the pinned exposure path |

| Test (`packages/db`) | Behavior | Criterion |
| --- | --- | --- |
| derives model-exclude-reason values from the single shared EXCLUDE_REASONS source | the pgEnum equals the constant, member for member | one authority, no second list |
| carries the derived exclusion reason as a nullable pgEnum | `excluded_reason` is `model_exclude_reason`, nullable | schema |
| carries a nullable `excluded_at` beside the reason | nullable timestamptz | schema |
| carries a NOT NULL `last_seen_at` defaulted to now | NOT NULL + default | schema |

**TDD record.** Every test above was watched red first. The four `packages/db` shape tests
failed on the missing enum export and three missing columns. Seven of the ten lifecycle
tests failed on assertions (wrong reason/stamp/`last_seen_at`) before the port, adapter and
loop existed. The exposure pin was watched red by temporarily reverting the
`excludedReason` clause in `list-descriptors.ts` and re-running it alone
(`AssertionError: expected true to be false`), then restoring the clause.

The two `fails unavailable …` tests are **coverage-completing error-path pins**, not
red-first behaviour tests: the `Result` channel they exercise was written as part of the
minimal green for the happy path (a dropped `Result` fails lint). They were added because the
per-file coverage gate caught the gap — see **Self-gate**.

**Three tests passed on first run, deliberately.** "keeps the marked row rather than
deleting it", "writes no row for a model that was never admissible" and "writes no row for
a model whose descriptor is unbuildable" pin *preservation* criteria — behaviour A2 must not
break. They are regression pins, not new-behaviour tests; that is disclosed rather than
dressed up as red-green.

**A fixture correction worth recording.** The lifecycle tests first used a below-price-floor
rate and did not exclude anything: the top-context exemption is a percentile over the pool,
and a single-model fixture **is** its own top percentile, so it is exempt from the floor and
the age cutoff. Only an unconditional reason (zero-priced, or non-ZDR) is reachable from a
one-model gateway fixture. The tests now use a zero combined rate and say why in a comment.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:db` | pass — 531 tests + `test:workers` 2/2, coverage gate included |
| owned api scope (`src/slices/models` + `src/jobs/poller-entries.integration.test.ts`) | pass — 43 files, 800 tests, 1 skipped |
| `pnpm test:shared` | pass — 124 files, 2962 tests |
| `pnpm test:api` | fail — 9 failed / 6342 passed / 468 files. All 9 attributed away; see **Attribution** below |
| scoped coverage on every owned api file (`vitest run --coverage --coverage.include=…`) | pass after two error-path tests were added; details below |
| `npx turbo typecheck --force --continue` (Global Constraint 10) | **pass — 16/16 successful, zero cached.** Taken after the final edit. An earlier run was red repo-wide on a concurrent workstream's in-flight move of `VALUE_STORE_BYTE_BUDGET_BYTES` into `@hushbox/shared`; that landed, and the tree is now clean. My own contract change (relocating `EXCLUDE_REASONS`) is therefore verified across all sixteen packages, including `scripts/`, `e2e/`, `apps/marketing`, `apps/admin`. |
| `pnpm --filter @hushbox/db db:generate` (drift gate) | pass — `No schema changes, nothing to migrate`; the only `packages/db/drizzle/` delta is my own migration + journal entry |
| `pnpm arch:check` | pass — OK, 11 rules over 2021 files |
| `eslint` on every owned file, from each package dir, after the final edit | exit 0 in `packages/db`, `packages/shared`, `apps/api`, `scripts` |

**The per-file coverage gate caught a real gap in my own files**, and it is worth recording
how: the full `pnpm test:api` run prints **no** threshold errors when tests fail — vitest
never reaches the coverage report — so a red suite silently hides the gate. A scoped
`vitest run --coverage --coverage.include=<my files>` exposed
`adapters/catalog-lifecycle.ts` at 66.7% lines / 75% functions (its `unavailableError`
mapper never invoked) and `domain/refresh.ts` at 91.3% branches (three untested error arms of
`recordSighting`). Two error-path tests fixed both:

| File | Before | After |
| --- | --- | --- |
| `adapters/catalog-lifecycle.ts` | 66.7% lines, 75% funcs, 75% stmts — **below gate** | passes (no threshold error) |
| `domain/refresh.ts` | 91.3% branches — **below gate** | 100% stmts / 97.8% branches / 100% funcs / 100% lines (the one residual partial branch, line 96, is pre-existing `shouldSkipWrite` code I did not change) |
| `domain/normalize.ts` | — | 99.6% / 97.4% / 98.0% / 99.6% (unchanged behaviour; import-only edit) |
| models slice overall | — | 99.5% stmts / 97.8% branches |

`domain/admin-catalog.ts` reports below-gate in a models-slice-only scoped run because its
caller is an admin route test outside that scope; it is green in the full suite and untouched
by this task.

The first `eslint` run on `apps/api` failed with `complexity 11 > 10` and
`sonarjs/cognitive-complexity 16 > 10` on `persistCatalog`. Fixed by extracting `markExcluded`
and `persistAdmitted` — not suppressed. The refresh suite was re-run green after the
refactor (37/37).

## Acceptance criteria

**1. New pgEnum `model_exclude_reason` over A1's existing `EXCLUDE_REASONS` — sourced from
that constant, never retyped.** — **met**, with a forced relocation.
`packages/db/src/schema/enums.ts` calls `pgEnum('model_exclude_reason', EXCLUDE_REASONS)`.
Drizzle's tuple requirement was **not** a blocker: `EXCLUDE_REASONS` is an `as const` tuple,
which is exactly what the eleven existing derived enums pass. The blocker was the package
boundary — `packages/db` cannot import `apps/api` — so the constant moved to
`packages/shared/src/models/exclude-reasons.ts`. Pinned by
`modelExcludeReasonEnum.enumValues` equalling the constant member for member.

**2. `excluded_reason` (nullable), `excluded_at`, `last_seen_at NOT NULL DEFAULT now()`;
migration generated and committed with the schema change; the `packages/db` shape-test
registry updated.** — **met**. Migration:
`packages/db/drizzle/0060_panoramic_steel_serpent.sql` (one `CREATE TYPE` + three
`ADD COLUMN`), applied locally (`pnpm db:migrate` → `migrations applied successfully`).
Drift gate output above. Registry: `ALL_ENUMS` in `shape-enums.test.ts` plus the three
column pins in `shape-tables.test.ts`.

**3. The refresh marks AND unmarks; the unmark does not touch `adminDisabledAt`. Pin both
directions.** — **met**. Both directions are pinned, and the unmark's independence from
`admin_disabled_at` is pinned by its own test that seeds a kill-switch timestamp and asserts
it survives. The mark direction has the mirror test. Two write paths carry the unmark, and
both are pinned: `upsertCatalog` (descriptor rewritten ⇒ mark cleared) and
`recordCatalogSighting` with a null reason (descriptor unchanged ⇒ mark still cleared).
Neither ever names `adminDisabledAt` in a set clause.

**4. Every exposure path filters `excluded_reason IS NULL AND admin_disabled_at IS NULL`;
enumerate the paths repo-wide and pin one.** — **met**. Enumeration below; the pinned path
is `listDescriptors`.

| Path | Disposition |
| --- | --- |
| `models/domain/list-descriptors.ts:113` (`listDescriptors`) | **FILTERED and PINNED.** The single product chokepoint. |
| `models/domain/list-models.ts` (`GET /models`) | derives from `listDescriptors` — covered |
| `models/domain/pricing-resolver.ts` (`createModelPricingResolver` → `snapshotResolver`) | derives — covered; turn-time resolution of an excluded id now fails closed as unknown |
| `chat/domain/smart-model-turn.ts` (3 call sites) | derives — covered; excluded models leave the candidate pool |
| `chat/routes.ts` (turn build) | derives — covered |
| `jobs/public-stats-snapshot-entry.ts` | derives — covered |
| `platform/dev/factories.ts` | derives — covered (dev-only) |
| `models/domain/catalog-store.ts` (`readLatestDescriptorRows`) | **deliberately unfiltered.** It is the raw whole-table read; the refresh needs excluded rows in order to unmark them, and filtering here would make the return path impossible. |
| `models/domain/admin-catalog.ts` (`listAdminCatalog`) | **deliberately unfiltered** — the admin Models screen already documents that it includes kill-switched and exposure-gate-hidden rows. See **Concerns** for the operator-visibility gap this leaves. |
| `models/domain/admin-disabled.ts` (`findAdminDisabledModel`) | not an exposure gate: it names an admin-disabled model so the route can answer `MODEL_DISABLED` instead of "unknown". An excluded model is refused earlier by the resolver. Unchanged. |
| `models/adapters/catalog-admin.ts` (`disable`/`enable`) | admin write path over the *asserted* column. Unchanged by design — the two authorities stay separate. |
| `scripts/lib/e2e-models.ts` (`assertE2eModelsPresent`) | not an exposure path — a fail-loud dev/E2E presence guard. Unchanged; see **Concerns**. |

**5. Rows are marked, never created — nothing is written for a model that was never
admissible.** — **met, structurally**. `RecordCatalogSighting` is only ever an
`UPDATE … WHERE model_id`, so no code path through this seam can insert. The domain also
skips the call entirely when `latest.has(modelId)` is false. Pinned twice: once for a
commercially unsellable never-seen model, and once for a model whose **descriptor is
unbuildable** (`missing-release-date`) — the case the criterion exists for, since there are
no values to write. Both assert zero rows. Every reason still reaches the column, because
the mark path takes the reason from the same `CatalogEntry` union the summary counts.

**6. `last_seen_at` advances for every model in the live fetch.** — **met, and measured
against the live OpenRouter catalog.** Three dispositions cover every discovered id that has
a row: descriptor rewritten (`upsertCatalog` stamps `last_seen_at`), descriptor unchanged
(`recordSighting` stamps it), excluded-with-a-row (`recordSighting` stamps it). The fourth —
excluded-with-no-row — has no row to advance, which is criterion 5. Pinned by "advances
`last_seen_at` for a model whose descriptor is unchanged" (the case that would otherwise be
skipped) and by the two mark tests, which assert the advanced stamp alongside the reason.

**Live measurement (`pnpm catalog:refresh`, twice, 2026-07-26).** First pass:
`389 discovered, 182 written, 0 unchanged, 207 excluded`. Second pass:
`389 discovered, 0 written, 182 unchanged, 207 excluded` — the skip-unchanged path for every
admitted model. Comparing `(model_id, last_seen_at)` for all 182 rows across the two passes:

```
rows whose last_seen_at is UNCHANGED between the two refreshes: 0
```

Every live-fetched row advanced, on the path that previously wrote nothing at all. The same
run is the live evidence for criterion 5: **207 exclusions produced 0 rows**
(`count(excluded_reason)` = 0 over a table built from scratch by these refreshes — nothing
was created for a model that was never admissible).

Acting on staleness is out of scope and not implemented.

**7. No index, deliberately — state the row count.** — **met, stated as a decision, with the
count measured**. Live `pnpm catalog:refresh` against OpenRouter on 2026-07-26:
**389 discovered upstream ids, 182 rows in `model_catalog`, 207 excluded** (matching A1's
389/182/207-class measurement). `model_catalog` holds one row per model id OpenRouter has
ever advertised **and** admitted, so its ceiling is a few hundred rows and it grows only when
OpenRouter ships a model that passes admission. (The table read 0 rows at the moment I first
checked — concurrent test runs wipe it, as the brief warned — so the count above comes from a
refresh I ran myself, not from a stale local table.)

**Decision: no index on `excluded_reason`, `excluded_at` or `last_seen_at`.** Two reasons,
both structural rather than a guess: every read of this table is already a whole-table select
folded in memory (`readLatestDescriptorRows`), so there is no predicate for an index to
serve; and at 182 rows an index would be reflex rather than measurement. The one new
predicate this task introduces — `WHERE model_id = $1` in the sighting write — is served by
the existing `model_catalog_model_id_unique`. Revisit only if the table grows an order of
magnitude or a filtered query on these columns appears (a staleness auditor would be the
first candidate).

## Deviations, with reasons

**1. `EXCLUDE_REASONS` moved from `apps/api/src/slices/models/domain/normalize.ts` to
`packages/shared/src/models/exclude-reasons.ts`.** Criterion 1 requires the pgEnum to source
the constant. `packages/db` cannot import `apps/api`, so the constant had to reach a package
both can see. `packages/shared` is where the repo already keeps this exact shape: eleven
pgEnums derive from shared closed sets (`MODALITIES`, `PAYMENT_STATUSES`,
`NEWSLETTER_STATUSES`, …). The alternatives were all worse: retyping the list is the defect
the criterion forbids; a `text()` column violates the shape-test rule that closed sets are
pgEnums; re-exporting the shared constant back through the models barrel would create two
import paths for one symbol. The constant's declaration text is unchanged; only its doc
comment was edited, to drop two now-wrong relative file references and to record the third
consumer. The re-export chain
(`models/domain/index.ts` → `models/index.ts` → `platform/dev/seed-toolkit.ts` →
`scripts/refresh-catalog.ts`) was deleted rather than repointed, so there is exactly one
import path.

**2. A new port + adapter (`RecordCatalogSighting` / `createCatalogSightingRecorder`) rather
than a write in the existing domain store.** The mark/unmark/touch write is an
`UPDATE … WHERE model_id`, and query operators live only in adapters (lint-enforced;
`@hushbox/db` deliberately does not re-export them), while `refresh.ts` is domain. Three
alternatives were considered and rejected:
- *Domain upsert with the stored descriptor re-supplied* (`INSERT … ON CONFLICT DO UPDATE`,
  which needs no operators): it would rewrite the full descriptor jsonb for **every** model
  on **every** hourly refresh, since criterion 6 forces a write per sighted row. That is a
  real operational regression (row bloat and WAL volume, ~200 × 24/day full-jsonb rewrites)
  and it leaves an INSERT arm that can create a row.
- *Dropping skip-unchanged* and always calling `upsertCatalog`: same jsonb cost, and it
  reverses a documented architectural property.
- *Batching the touches into one `UPDATE … WHERE model_id IN (…)`*: cheaper still, but it
  restructures the per-entry summary/telemetry loop for a gain that an hourly cron does not
  need. Recorded as a future option, not taken.

The cost of the chosen shape is one required dep on `RefreshCatalogDeps`, threaded through
two production call sites and six test files — one line each.

**3. One pre-existing test renamed.** `writes nothing when a second refresh sees identical
metadata` → `rewrites no descriptor when a second refresh sees identical metadata`. The
summary contract it pins (`written: 0, unchanged: 1`) is unchanged, but a `last_seen_at`
touch now happens, so the old name had become a wrong comment.

**4. `excluded_at` preserves the first moment** across repeat refreshes reaching the same
verdict (`coalesce` in the adapter's set clause), mirroring `admin_disabled_at`'s documented
"the first disable's moment is the audit-relevant fact". BILLING.md does not specify this
either way; re-stamping hourly would have made the column a duplicate of `last_seen_at`.
Pinned by test. Clearing the reason clears the stamp, so a model that leaves and later
re-enters exclusion is stamped afresh.

No `BILLING.md` statement was invalidated, so no doc correction was owed under ruling 6.
§Catalog Admission 4's wording — `excludedReason`, `excludedAt`, `lastSeenAt`, and
"Exposure filters on `excludedReason IS NULL AND adminDisabledAt IS NULL`" — is now
literally true of the code.

## Attribution of check failures

`pnpm test:api` is red, and none of it is attributable to this task on the evidence below.
`git status` was captured before the first edit; the working tree carries a concurrent
workstream's files (B4's affordability/turn-definition work, plus the notifications/sandbox
workstream).

- **Transient typecheck reds, now cleared.** Mid-session, `turbo typecheck` went red across
  five packages on `VALUE_STORE_BYTE_BUDGET_BYTES` (a concurrent in-flight move of that
  constant into `@hushbox/shared`) and on missing `turn-definition.js` /
  `smart-model-turn.js` exports (`turnMaxOutputTokens`, `answerMaxOutputTokens`,
  `candidateAnswerCeiling`) — all B4's files, named as such in the brief. Those failures
  appeared and disappeared between runs with no edit of mine, and the final run is 16/16.
  Recorded only so a reader of an intermediate log is not misled.
**`pnpm test:api` — every failure, with its cause.** Two full runs were taken. The persistent
set is identical in both: 3 files / 9 tests. A third category (4 files) appeared in one run
only and is environmental.

| Failing file | Tests | Cause | Not mine because |
| --- | --- | --- | --- |
| `notifications/domain/templates/template-html.test.ts` | 7 (snapshot: `welcome`, `account-deleted`, `account-locked`, `chargeback-lock`, `password-changed`, `two-factor-enabled`, `two-factor-disabled`) | §Known Breakage, verbatim: "fails at HEAD — 7 snapshot failures over a removed Google-Fonts `<link>`, with both the template source and the `.snap` unmodified relative to HEAD". Confirmed: `git diff --stat HEAD -- .../templates/` is empty. | I touched no notifications file; the entry predates this task and names the same 7 |
| `chat/domain/turn-definition.integration.test.ts` | 1 — "omits the ceiling for a rich payer whose budget covers the context window": `expected { maxOutputTokens: 127997 } to deeply equal {}` | B4's in-flight output-ceiling rework. `git diff --stat HEAD -- apps/api/src/slices/chat/domain/turn-definition.ts` = **135 lines changed** by another agent | the brief assigns `turn-definition.ts` to B4 and forbids me editing it; the assertion is purely about `maxOutputTokens`, a quantity no catalog column touches. Reproduces in isolation, so it is not load-dependent flake either |
| `chat/routes.integration.test.ts` | 1 — "caps a trial single-model answer at the 1¢-derived output ceiling": `expected { maxOutputTokens: 999194 } to deeply equal { maxOutputTokens: 7909 }` | the same B4 ceiling rework, reached through the trial route | identical quantity and cause as the row above; the surrounding 30 trial-route tests (including "refuses an unknown model", which is the catalog-facing one) all pass |
| `jobs/access-log-audit-entry.test.ts`, `billing/domain/webhook-verify.test.ts`, `chat/domain/turn-ceiling.property.test.ts`, `newsletter/domain/webhook-verify.test.ts` | 0 tests — **collection** failures, one run only | `Error: Cannot find module '.../node_modules/.vite/vitest/<hash>/deps_ssr/@hushbox_shared.js'` — the §Known Breakage "Environment gotcha": the bundler pre-bundles `@hushbox/shared`, and this task adds a file to it, so the optimizer re-hashed mid-run | **verified**: after `rm -rf apps/api/node_modules/.vite`, all four run **4 files / 61 tests passed**. They did not appear in the other full run at all |

The last row is the one category this task can be said to have aggravated — adding a file to
`packages/shared` invalidates the pre-bundle. It is an environmental cache race, not a code
defect, and the documented remedy (clear `node_modules/.vite`) resolves it; a re-gate should
clear the cache first.

## Concerns and limitations

1. **The admin Models screen cannot see the soft delete.** `listAdminCatalog` /
   `AdminCatalogModel` carry `adminDisabledAt` but not `excludedReason`, so an operator sees
   a model as enabled while it is unsellable. Correct per A2's criteria (the admin read is
   deliberately unfiltered), but the *reason* is now invisible to the only human-facing
   surface that shows every row. Surfacing it means a wire-schema change reaching
   `packages/shared/src/admin/wire.ts` and the admin SPA — out of A2's ownership. Worth an
   owner.
2. **`scripts/lib/e2e-models.ts` asserts row presence, not sellability.** An `E2E_MODELS` id
   that becomes inadmissible keeps its row and passes the guard while being hidden from the
   product, so E2E would fail later and confusingly instead of at the guard. A one-line
   strengthening (`excluded_reason IS NULL`) would fix it; not done, because the guard is not
   an exposure path and `scripts/lib/` is outside this task's file list. Related: A1's
   accepted disclosure that `openai/gpt-4o` is now `too-old` and still referenced by seed
   fixtures.
3. **Nothing acts on `last_seen_at`.** Explicitly out of scope per the criterion. A model
   that vanishes from OpenRouter is now *detectable* by staleness but is still exposed
   forever, because a vanished model produces no `CatalogEntry` at all and therefore no
   verdict. That is the residual half of ruling 1's "hides a model that has vanished from
   OpenRouter" — the column is the enabler, the auditor is not built.
4. **One extra round trip per sighted model per refresh.** The hourly refresh now issues one
   small `UPDATE` for each unchanged or excluded-with-a-row model (~200 statements at
   today's catalog size) on top of the descriptor upserts it already issued. It is three
   columns, never the jsonb, and the batching option is recorded in **Deviations**.
5. **`refresh.integration.test.ts` grew by ten tests** and is already on §Known Breakage for
   load-dependent `model-catalog test lock` timeouts. It passes in isolation (37/37, twice).
   Anyone re-gating should run it alone.

## Confidence

**High** on the schema, the exposure filter, and both mark/unmark directions — each is
pinned by a test watched red, and the exposure pin was verified red by reverting only the
filter clause.

**Medium** on two judgement calls that an auditor may want to re-litigate: relocating
`EXCLUDE_REASONS` to `packages/shared` (forced by the package boundary, but it widens the
diff into two packages the plan's Files list did not name), and adding a required dep to
`RefreshCatalogDeps` rather than taking the operator-free upsert route.
