# A2 — fix cycle 3: the re-audit's two findings

Continuation of `impl-report-1.md` and `impl-report-2.md`. Fix cycle 2 of the three-cycle cap
(the orchestrator's numbering). Two findings, both mine, both fixed. Nothing from the earlier
cycles was reverted.

## Objective

1. **[Important]** Make the no-index rationale checkably true — it asserted three things that
   were false, one of them falsified by my own sibling edit in the same cycle.
2. **[Minor]** Make the sellability pin distinguish `and` from `or`, which `toContain` cannot.

## Files changed

| File | Why |
| --- | --- |
| `packages/db/src/schema/model-catalog.ts` | Finding 1: the no-index comment rewritten so every claim holds against the tree as it now stands, with the revisit trigger correctly scoped. Comment-only. |
| `scripts/lib/e2e-models-assert.test.ts` | Finding 2: the pin asserts the rendered WHERE clause whole instead of by two substrings. |

## Finding 1 — the rationale is now true, and its trigger works

**I re-derived the query inventory myself before writing a word**, and it matches the
auditor's exactly. One `grep` over
`from(modelCatalog)|insert(modelCatalog)|update(modelCatalog)|delete(modelCatalog)` across
`apps`, `packages` and `scripts`, excluding tests:

| Query | Shape | Filters a lifecycle column? |
| --- | --- | --- |
| `models/domain/catalog-store.ts:117` (`readLatestDescriptorRows`) | whole-table select, folded in memory | no |
| `models/adapters/catalog-admin.ts:31` (`readRowState`) | select one row `WHERE model_id` | no |
| `scripts/lib/e2e-models.ts:117` (`readSellableDescriptors`) | select `WHERE excluded_reason IS NULL AND admin_disabled_at IS NULL` | **yes** |
| `models/domain/catalog-store.ts:89` | `INSERT … ON CONFLICT (model_id)` | write, keyed on `model_id` |
| `models/adapters/catalog-lifecycle.ts:28` | `UPDATE … WHERE model_id` | write, keyed on `model_id` |
| `models/adapters/catalog-admin.ts:51` (disable) | `UPDATE … WHERE model_id AND admin_disabled_at IS NULL` | write, keyed on `model_id` |
| `models/adapters/catalog-admin.ts:77` (enable) | `UPDATE … WHERE model_id AND admin_disabled_at IS NOT NULL` | write, keyed on `model_id` |

So all three sub-findings were correct: **(a)** three production reads, only one whole-table;
**(b)** the filtered one is the read my own finding-3 edit added, so the comment's revisit
trigger was tripped by the same cycle that wrote "revisit if a filtered query appears";
**(c)** four keyed writes, not one.

**(b) is the finding that matters, and I accept it as stated.** A revisit trigger is how a
future engineer decides whether to index these columns. Declaring the condition unmet at the
moment I made it met does not merely misdescribe the code — it disables the mechanism the
comment exists to provide. That is the same defect class as the `adminDisabledAt` comment
finding 2 of cycle 2 removed, committed in the fix for it.

Replacement (`packages/db/src/schema/model-catalog.ts:33-44`):

```
// The three lifecycle columns below carry NO index, measured rather than
// reflexive. A live OpenRouter refresh persists 182 rows out of 389
// discovered ids, so a few hundred rows is the ceiling. No REQUEST-PATH
// query filters these columns: the slice's descriptor consumers all share
// one whole-table select folded in memory, and the admin kill switch reads a
// single row keyed on `model_id`. Exactly one query does filter them, and it
// is dev tooling — the E2E preparation guard, checking its fixture models
// are still sellable — which runs only during `e2e:prepare`, off any request
// path, where scanning a few hundred rows beats carrying an index.
// Every write is likewise keyed on `model_id` and rides
// `model_catalog_model_id_unique`. Revisit when a REQUEST-PATH query filters
// these columns; a staleness auditor would be the first.
```

Each of the three repairs the finding asked for:

- **Scoped to production reads** — the absolute "every read … so no predicate exists" is gone;
  the claim is now about **request-path** queries, which is the class an index would serve.
- **The dev-tooling filter is named, with why it needs no index** — it exists, it is the E2E
  preparation guard, and it runs only during `e2e:prepare`, off any request path, where a
  few-hundred-row scan is cheaper than an index to maintain.
- **The keyed-write count is gone**, replaced by the property that is actually true of all
  four: every write is keyed on `model_id` and rides `model_catalog_model_id_unique`.
- **The revisit trigger now fires on the right event** — a request-path query filtering these
  columns. It is untripped today, and it will be tripped by exactly the change that would make
  an index worth having.

The decision itself is unchanged, as instructed: no index, 389-id ceiling, one dev-tooling
predicate.

### Applying the new standing rule to this very comment

The rule — *check a durable claim against your own cycle's diff, not the code you started
from* — is what produced this finding, so I ran the replacement against my own diff before
shipping and it caught two more overreaches. Both were fixed before any gate ran:

| Draft claim | Problem found against the tree | Final |
| --- | --- | --- |
| "every slice consumer reaches the table through one whole-table select … **and** the admin kill switch reads a single row" | `catalog-admin.ts` is a models-slice consumer that does **not** go through the whole-table select, so the sentence contradicted its own next clause | "the slice's **descriptor** consumers all share one whole-table select" — true, and the kill switch is then named as the separate case it is |
| "runs **once** per prepare" | the guard runs from **two** call sites during prepare (`assertE2eModelsPresent` after the catalog refresh, `assertSeededImageModelPresent` after the seed) | "runs **only during** `e2e:prepare`" — drops the count, keeps the load-bearing fact (off any request path) |

I also swept my own cycle-2 diff for other durable claims it could have falsified, and found
none outstanding:

- `catalog-store.ts`'s module docstring ("reads are whole-table selects … writes are
  conflict-arbitrated upserts, none of which need query operators") is scoped to that module,
  and remains true of it — the operator-using queries live in adapters.
- `catalog-lifecycle.ts`'s "never inserts / never touches `descriptor` / never touches
  `admin_disabled_at`" — all three still hold.
- My own new comment on `readSellableDescriptors` calls `isExposed` "already a replica", which
  the auditor independently confirmed.

## Finding 2 — the pin now distinguishes the connective

The two `toContain` assertions could not tell a conjunction from a disjunction. I reproduced
the auditor's result before fixing, rendering both clauses through the same dialect the test
uses:

```
AND >>("model_catalog"."excluded_reason" is null and "model_catalog"."admin_disabled_at" is null)<<
OR  >>("model_catalog"."excluded_reason" is null or "model_catalog"."admin_disabled_at" is null)<<
```

Both contain both asserted substrings; only the connective differs. And the failure scenario
is real: under `or`, a row with `excluded_reason='below-price-floor'` and
`admin_disabled_at IS NULL` satisfies the disjunction, so `readSellableDescriptors` returns
it, the guard passes, and the suite dies mid-test on a model `/models` hides — precisely the
regression the guard exists to prevent.

Fix (`scripts/lib/e2e-models-assert.test.ts:79-88`), asserting the clause whole:

```ts
expect(lastWhereSql).toBe(
  '("model_catalog"."excluded_reason" is null and "model_catalog"."admin_disabled_at" is null)'
);
```

with the reason recorded beside it, so a later reader does not "simplify" it back to
substrings:

```
// Asserted whole, not by substring: `or(...)` renders both of these null
// checks too, and a disjunction would admit a soft-deleted row whose kill
// switch happens to be clear — the exact regression this guard exists to
// catch. Only the connective distinguishes them.
```

**Verified by execution, not by argument.** I did what the auditor did: swapped the guard's
`and(...)` for `or(...)` in place and re-ran.

```
× reads only sellable rows, so a soft-deleted or kill-switched id cannot pass
AssertionError: expected … to be … // Object.is equality
Expected: "(… is null and … is null)"
Received: "(… is null or  … is null)"
Tests  1 failed | 11 passed (12)
```

Red on the connective alone, which is what the old assertion could not see. Source restored
to `and(...)` from a pre-swap copy and re-verified green — `grep` confirms
`import { and, isNull }` and `.where(and(isNull(…), isNull(…)))` are back.

No other assertion in the file was touched, and the cycle-2 `fakeDb` that resolves only
through `.where(...)` is unchanged — so the file still has both teeth: delete the filter and
all 12 tests fail; weaken it to `or` and this one does.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run --root scripts lib/e2e-models-assert.test.ts lib/e2e-models.test.ts` | pass — 2 files, 16 tests |
| the same, with `--coverage --coverage.include='lib/e2e-models.ts'` | pass — no threshold error |
| deliberate `and` → `or` swap, then restore | pass — red on the swap (1 failed / 11 passed), green after restoring |
| `pnpm test:db` | pass — 531 tests + `test:workers` 2/2 |
| `pnpm --filter @hushbox/db db:generate` (drift gate) | pass — `No schema changes, nothing to migrate`; `packages/db/drizzle/` still carries only cycle 1's migration, as a comment-only edit must |
| `npx turbo typecheck --force --continue` | **pass — 16/16 successful, zero cached** |
| `eslint src/schema/model-catalog.ts` (from `packages/db`) | exit 0 |
| `eslint lib/e2e-models.ts lib/e2e-models-assert.test.ts` (from `scripts`) | exit 0 |

Both lint runs taken after the last edit, from the owning package directory. Nothing is
attributed away this cycle: repo typecheck is fully green, so the concurrent-task attribution
from cycles 1 and 2 has dissolved exactly as the orchestrator noted.

I did not touch `docs/plans/ADMIN-PLANE.md` — the orchestrator states it fixed that half.

## Concerns and limitations

1. **The exact-string assertion is coupled to drizzle's SQL renderer.** A drizzle upgrade that
   changed quoting or spacing would fail this test with a confusing diff. That is the accepted
   cost of the only assertion that can see the connective, and the failure would be loud and
   trivially diagnosed from the diff. Noted so it is not mistaken for a defect later.
2. **The no-index comment now carries a measured figure (182/389) that will age.** It is
   labelled as a live-refresh measurement rather than an invariant, and the decision does not
   turn on the exact number — only on the order of magnitude, which is bounded by OpenRouter's
   model count. The revisit trigger is the query shape, not the row count, which is the part
   that should drive a future decision.
3. **Cycle-2 concerns 2 and 3 stand unchanged**: `isExposed` in the e2e guard is still a
   drifted replica owned by the duplication-collapse task, and the two `scripts` collection
   failures on §Known Breakage mean `refresh-catalog-run.test.ts` still never executes.

## Confidence

**High.** Finding 1's replacement was verified claim-by-claim against a query inventory I
re-derived myself, then re-checked against my own diff — which caught two further overreaches
before any gate ran. Finding 2 was verified the way the auditor found it, by making the
regression and watching the pin catch it.
