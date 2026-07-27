# A2 — fix cycle 2: three validated Minors from the audits

Continuation of `impl-report-1.md`. Both audits returned PASS; these are the three Minors the
orchestrator validated. Nothing in cycle 1 was reverted or re-litigated.

## Objective

1. Record the no-index decision where a later reader will actually find it.
2. Correct a now-false comment on `admin_disabled_at` — the column ruling 1 rests on.
3. Make the `e2e:prepare` guard see sellability, not merely row presence.

## Files changed

| File | Why |
| --- | --- |
| `packages/db/src/schema/model-catalog.ts` | Finding 1: the no-index decision + measured row count, as a comment heading the three lifecycle columns. Finding 2: the `adminDisabledAt` comment now states the true invariant. Comment-only — no SQL, no migration. |
| `scripts/lib/e2e-models.ts` | Finding 3: `readCatalogDescriptors` → `readSellableDescriptors`, with `WHERE excluded_reason IS NULL AND admin_disabled_at IS NULL` on the select. Failure copy and the guard docstring corrected to match. |
| `scripts/lib/e2e-models-assert.test.ts` | The new filter pin, plus a `fakeDb` chain that now requires `.where(...)`. |

## Finding 1 — the no-index decision is now durable

`packages/db/src/schema/model-catalog.ts:33-39`, heading the `excluded_reason` /
`excluded_at` / `last_seen_at` block:

```
// The three lifecycle columns below carry NO index, measured rather than
// reflexive: every read of this table is a whole-table select folded in
// memory, so no predicate exists for an index to serve, and a live
// OpenRouter refresh persists 182 rows out of 389 discovered ids — a ceiling
// of a few hundred. The one keyed write, the refresh's per-model sighting,
// rides `model_catalog_model_id_unique`. Revisit if a filtered query over
// these columns appears; a staleness auditor would be the first.
```

Placement note: I first put it after `lastSeenAt`, where it read as annotating `createdAt`.
It now heads the block it describes and names the three columns explicitly, so the
attachment is unambiguous. The measured figures (182/389) are the ones from cycle 1's live
`pnpm catalog:refresh`, so the schema file carries the measurement rather than pointing at a
run record.

The orchestrator's arbitration is accepted without reservation: criterion 7's stated purpose
is "so a later reader sees a decision rather than an omission", a later reader reads the
schema, and `docs/plans/runs/` is by the doc-lifecycle rule never cited as current. The run
report was the wrong home.

## Finding 2 — the false comment is corrected, and the true invariant stated

Before (`model-catalog.ts:21-22`) — **false as of cycle 1**:

```
// Admin kill switch (`model.disable`); the catalog refresh upsert
// touches only `descriptor`, so this flag survives refresh.
```

After:

```
// Admin kill switch (`model.disable`). ASSERTED by a person, and what
// protects it is that no refresh write names this column in any set clause —
// not that the refresh writes few columns (it writes `descriptor`,
// `popularity_rank`, `excluded_reason`, `excluded_at` and `last_seen_at`).
// That omission is the whole reason the derived `excluded_reason` below is a
// separate column.
```

The old wording was already weakened before A2 (`popularity_rank` joined the set clause
earlier), and A2 broke it outright by adding three more columns. The replacement states the
property that is actually load-bearing — **absence from every refresh set clause** — and ties
it to ruling 1 so the next reader sees why it matters rather than only what it says.

**Swept for the same claim repo-wide.** Three sibling comments assert the neighbouring fact,
and all three are still true, so none was touched:

| Site | Text | Verdict |
| --- | --- | --- |
| `models/adapters/catalog-admin.ts:16` | "The refresh upsert never writes `admin_disabled_at`, so a set flag survives every catalog refresh" | true — states the invariant, not the column count |
| `models/domain/catalog-store.ts:29-33` | "The refresh upsert's set clause never touches this column, so the flag survives refresh" | true, same reason |
| `admin/domain/operations/model.ts:10-11` | "The catalog refresh upsert never touches `admin_disabled_at`, so a set flag survives every refresh" | true, same reason |

A `grep` for "touches only" / "only \`descriptor\`" across `apps`, `packages` and `scripts`
returns only two unrelated test comments. The false phrasing existed in exactly one place.

## Finding 3 — the guard now filters in the query

`scripts/lib/e2e-models.ts`:

```ts
async function readSellableDescriptors(db: Database): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ modelId: modelCatalog.modelId, descriptor: modelCatalog.descriptor })
    .from(modelCatalog)
    .where(and(isNull(modelCatalog.excludedReason), isNull(modelCatalog.adminDisabledAt)));
  return new Map(rows.map((row) => [row.modelId, row.descriptor]));
}
```

Both call sites (`assertE2eModelsPresent`, `assertSeededImageModelPresent`) use it, so the
pre-seed and post-seed guards are both fixed. `and` / `isNull` from `drizzle-orm` is
precedented in this package (`scripts/seed.ts` already imports `and`, `eq`); the
adapters-only operator rule is scoped to `apps/api/src/slices/**`.

**The `isExposed` replica was not touched, per the boundary I was given.** The filter is a
query concern, not a predicate concern, and the comment on the new function records why that
is the right seam rather than merely the permitted one:

```
// The two unsellable authorities are filtered in the QUERY, not in `isExposed`:
// both are row columns rather than descriptor fields, so a marked row keeps a
// perfectly valid descriptor — ZDR-reachable, priced, strict-family — and would
// otherwise satisfy every predicate below while `/models` hid it. Filtering here
// also keeps the filter off `isExposed`, which is already a replica.
```

I did not collapse, extend, or deepen the replica, and I did not add the missing
`isRunnableModelShape` leg. That drift stays the duplication-collapse task's to resolve.

**One consequence handled: the failure copy was lying.** A soft-deleted id now takes the
`raw === undefined` branch, whose message said "is not in the live OpenRouter catalog —
update E2E_MODELS, or the catalog refresh failed". For a `too-old` mark that sends a
maintainer hunting a refresh failure, which is the wrong-comment hazard in error copy. Now:

```
e2e model '<id>' is not sellable in the live OpenRouter catalog — either absent,
or soft-deleted (excluded_reason) or admin-disabled — update E2E_MODELS, or the
catalog refresh failed
```

Two existing test assertions were updated to the new substring; no assertion was weakened
(same `rejects.toThrow`, a longer and more specific string). The `assertE2eModelsPresent`
docstring's clause (1) now names the query filter alongside `isExposed`.

## Tests

| Test | Behavior | Finding |
| --- | --- | --- |
| `e2e-models-assert.test.ts` → "reads only sellable rows, so a soft-deleted or kill-switched id cannot pass" | the WHERE clause the guard builds, rendered through `PgDialect().sqlToQuery`, contains `"excluded_reason" is null` and `"admin_disabled_at" is null` | 3 |

**TDD record.** Watched red first, for the right reason: `AssertionError: expected '' to
contain '"excluded_reason" is null'` — the guard built no WHERE clause at all, so the fake's
capture never fired. Green after the filter landed.

**Why the SQL is pinned rather than the row-level consequence.** A fake `db` cannot enforce
SQL semantics, so a test where the fake itself applies the predicate would prove only that
the fake works. Two honest alternatives were rejected: a real-Postgres integration test would
have to insert real `E2E_MODELS` ids with synthetic descriptors into the **shared** dev
`model_catalog`, poisoning the `apps/api` suites that read it (which is why those suites hold
a Redis catalog lock that `scripts` has none of); and asserting the fake's filtered output
would be a tautology. Rendering the actual condition to SQL pins the thing that can silently
regress. The row-level consequence — absent id ⇒ throw — is already pinned by the
pre-existing "throws when an id is absent from the catalog" test, and the two now share a
message.

**The fake was then tightened to require `.where(...)`.** During the red step it was a hybrid
(a thenable that also carried `.where`) so only the new test would fail rather than the whole
file. Its final committed form resolves *only* through `.where`, so deleting the filter breaks
all twelve tests in the file, not just the one asserting the clause. Verified green after
tightening.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run --root scripts lib/e2e-models-assert.test.ts lib/e2e-models.test.ts` | pass — 2 files, 16 tests |
| scoped coverage `--coverage.include='lib/e2e-models.ts'` | pass — no threshold error (using the cycle-1 discovery: a red suite never reaches the coverage report, so the gate must be run scoped) |
| `pnpm test:db` | pass — 531 tests + `test:workers` 2/2 |
| `pnpm --filter @hushbox/db db:generate` (drift gate) | pass — `No schema changes, nothing to migrate`; comment-only schema edits produce no SQL delta, and `packages/db/drizzle/` still carries only cycle 1's migration |
| `npx turbo typecheck --force --continue` | 11/16. **Zero TS errors in any file I touched** — filtering out `chat/domain/turn-definition.*` and `chat/domain/smart-model-turn.ts` leaves an empty error list. See **Attribution**. |
| `eslint packages/db/src/schema/model-catalog.ts` (from `packages/db`) | exit 0 |
| `eslint lib/e2e-models.ts lib/e2e-models-assert.test.ts` (from `scripts`) | exit 0 |
| `turbo test --filter=@hushbox/scripts --force` | fail — 1 failed / 1853 passed, 3 failed files, all three pre-existing. See **Attribution**. |

Both lint runs were taken after the last edit, from the owning package directory.

## Attribution of check failures

**`turbo typecheck` — 5 packages red, none of it mine.** Every error is in
`apps/api/src/slices/chat/domain/turn-definition.ts`, `turn-definition.test.ts` or
`smart-model-turn.ts` (`answerHeadroomTokens` / `answerH…` missing exports, `AnswerCapFit`
shape mismatches, two unused declarations). The coordinator states B4 is mid-fix-cycle and
owns `apps/api/src/slices/chat/domain/**`. Two independent proofs it is not mine: the
typecheck immediately before this cycle, with every A2 change already in place, was **16/16
successful**; and this cycle's three edits are two comments in a `packages/db` schema file
plus `scripts/lib/e2e-models.ts` and its test, none of which can reach chat-domain code.
`@hushbox/db` and `@hushbox/shared` — the packages this cycle touched — are among the 11
successful.

**`@hushbox/scripts` test — 3 files, all on §Known Breakage.**

| Failing file | Cause | Evidence |
| --- | --- | --- |
| `generate-env.test.ts` → "generates for loop with all backend secret keys" | §Known Breakage verbatim: "fails on exactly three VAPID/notification secrets present in the generated output and absent from the test's expected string … belongs to the concurrent push/notifications workstream" | I touched no env or notification file |
| `refresh-catalog-run.test.ts` (collection) | §Known Breakage verbatim, including the 2026-07-26 refinement: `Cannot find module '.../deps_ssr/@hushbox_db.js&v=ce1e6bc1'` — the mangled SSR dependency URL under `vi.mock` + `importOriginal`. Reproduces after `rm -rf scripts/node_modules/.vite`, exactly as the refined entry says, and reproduces with the two files run alone | fails on `@hushbox_db`, on `refresh-catalog.ts:18`'s `@hushbox/db` import — a line no cycle of mine changed |
| `seed-run.test.ts` (collection) | same entry, same mangled URL | same |

**The A1 trap, checked deliberately.** §Known Breakage warns that a listed file can acquire a
second, independent cause, and that `refresh-catalog-run.test.ts`'s tests never execute — so
it is gated by typecheck and lint alone, which is how A1 shipped a red repo. Cycle 1 edited
`scripts/refresh-catalog.ts`, so I verified both gates on it explicitly: repo-wide typecheck
reports zero errors anywhere in `scripts/`, and `eslint refresh-catalog.ts
refresh-catalog.test.ts` exits 0. Its executing sibling `refresh-catalog.test.ts` passes. The
file's exhaustive `excludedByReason` map needed no edit because A2 adds no reason.

## Concerns and limitations

1. **The soft-delete filter in the e2e guard is pinned at the SQL level, not against real
   rows.** The reasoning is in **Tests** above and the trade is deliberate, but an auditor
   wanting a row-level pin would need a `model_catalog` lock in `scripts` first — the same
   mechanism `apps/api` already has. Worth noting as a latent gap in the scripts harness
   rather than in this fix.
2. **`isExposed` in `scripts/lib/e2e-models.ts` is still a drifted replica** of the slice's
   predicate, missing the `isRunnableModelShape` leg. Untouched by instruction; it remains the
   duplication-collapse task's item. My change deliberately routes around it rather than
   adding a fourth leg.
3. **The two `scripts` collection failures mean `refresh-catalog-run.test.ts` still never
   executes.** Cycle 1's edit to `scripts/refresh-catalog.ts` is therefore covered by
   typecheck and lint only, and by `refresh-catalog.test.ts` for the summary formatter. That
   is the state §Known Breakage describes and it needs an owner outside this run.

## Confidence

**High.** All three findings are narrow and each is verified by the gate that would catch its
regression: the two comment fixes by reading the resulting file and re-running lint + the
drift gate (comment-only, no SQL delta), and the query filter by a red-then-green test that
renders the actual SQL, plus a fake that now fails the whole file if the filter is removed.
