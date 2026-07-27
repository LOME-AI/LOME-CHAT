# A2 — fix cycle 4: criterion 7's no-index record, under the amended criterion

Continuation of `impl-report-1.md` … `impl-report-3.md`. One edit, one file, comment-only.
Finding 2 is closed and untouched. Nothing else in the task was reworked.

## Objective

Re-read `plan.md` §A2's **Criterion 7 amendment** and satisfy it: record the **decision** and
the **scale**, and delete the query-shape elaboration entirely.

## The edit

`packages/db/src/schema/model-catalog.ts:33-34`, heading the three lifecycle columns:

```
// The three lifecycle columns below carry NO index, deliberately: this table
// holds one row per model, and its row count is in the low hundreds.
```

That is the whole change. Twelve lines of enumeration deleted, two lines kept. Removed, per
the amendment's explicit prohibitions:

- the read inventory (whole-table select / keyed admin read / filtered dev-tooling read),
- the write claim (`every write is keyed on model_id and rides model_catalog_model_id_unique`),
- the call-site and venue counts (`runs only during e2e:prepare`, `off any request path`),
- the revisit trigger phrased over query shapes (`revisit when a REQUEST-PATH query filters
  these columns; a staleness auditor would be the first`),
- the measured pair `182 rows out of 389 discovered ids`, which named an upstream fetch and so
  reached outside this file. The scale survives as "in the low hundreds", the amendment's own
  phrasing.

**Every remaining claim is checkable from this file alone.** "Carry NO index" is visible in
the table definition three lines down. "One row per model" is the `UNIQUE(model_id)` in the
same file. "Row count is in the low hundreds" is the scale the amendment asks for, and it is a
property of the table rather than of any call site. Nothing refers to code elsewhere, so
nothing can be falsified by a change elsewhere.

**I added no revisit sentence of my own.** The amendment says to state the decision and the
scale and then stop, and its rationale already establishes that a failing row-count ceiling is
self-evidently the signal — "which needs no enumeration to notice". Writing my own trigger
clause is the exact reflex that produced three cycles of drift, so I did not, even though a
scale-phrased trigger would not have been prohibited.

## The two disproofs, acknowledged

Both cycle-3 claims were false and I did not catch either, so they are recorded plainly rather
than summarised away.

**"Runs only during `e2e:prepare`" — false.** `assertSeededImageModelPresent` is called
unconditionally from `runSeed`, and `pnpm dev` is
`ensure-stack && catalog:refresh && db:seed && turbo dev`, so the filtered read fires on every
`pnpm dev`. `seed.ts:727-728` names both contexts in a comment, and that file was open in
front of me during cycle 2 — I read it to confirm the guard's call sites and still wrote a
claim it contradicts.

**The revisit trigger's own worked example fell outside the class the same sentence had just
defined.** The sentence scoped the trigger to REQUEST-PATH queries, then offered a staleness
auditor as the first candidate; CODE-RULES puts auditors on cron, which is not a request path.
The example disproved the scoping in the same breath.

## What I take from three cycles on one comment

The orchestrator has taken the fault for the ask, and the amendment is a correction of its own
arbitration rather than of my work. The implementer-side lesson is still mine to record,
because it is the one that generalises past this comment:

Cycle 3 applied the new standing rule — check a durable claim against your own diff — and it
worked as far as it went, catching two overreaches before any gate ran. But I applied it to
the *wording* while leaving the *shape* alone. Every version tried to be a standing proof
about the codebase's query surface, and each pass I tightened a sentence rather than asking
whether a comment can carry that kind of claim at all. Verifying an unbounded claim harder
does not bound it: the next reader's change falsifies it somewhere I did not look. CODE-RULES
already draws the line — *if you cannot state the durable fact precisely, leave it out* — and
the operative test is not "is this sentence true today?" but **"can this sentence be falsified
by a change in a file I am not editing?"** Where the answer is yes, the claim belongs in a
test, a name, or nowhere. Here it belonged nowhere: criterion 7 only ever asked for a record.

## Self-gate

| Command | Result |
| --- | --- |
| `eslint src/schema/model-catalog.ts` (from `packages/db`, after the edit) | exit 0 |
| `pnpm test:db` | pass — 531 tests + `test:workers` 2/2 |
| `pnpm --filter @hushbox/db db:generate` (drift gate) | pass — `No schema changes, nothing to migrate`; a comment-only edit produces no SQL delta, and `packages/db/drizzle/` still carries only cycle 1's migration |
| `npx turbo typecheck --force --continue` | pass — 16/16 successful, zero cached |

Edit scope confirmed by `git diff --stat`: the only files this task has modified since cycle 2
remain `packages/db/src/schema/model-catalog.ts`, `scripts/lib/e2e-models.ts` and
`scripts/lib/e2e-models-assert.test.ts`. This cycle touched only the first, and only its
comments. No test changed, because no behaviour changed. `docs/plans/ADMIN-PLANE.md` remains
untouched by me.

## Concerns and limitations

1. **"In the low hundreds" will need revisiting if OpenRouter's catalog grows an order of
   magnitude.** That is the intended and only revisit signal, and it is now the sole claim in
   the comment that could ever stop holding — which is the amendment's design, not a gap.
2. **Cycle-2 and cycle-3 concerns stand unchanged**: `isExposed` in the e2e guard is a drifted
   replica owned by the duplication-collapse task; the two `scripts` collection failures on
   §Known Breakage mean `refresh-catalog-run.test.ts` still never executes; and the exact-string
   SQL pin is coupled to drizzle's renderer.

## Confidence

**High**, and for a different reason than the previous cycles: the claim is now small enough
that its correctness does not depend on my having swept the codebase. Both surviving facts are
visible within twenty lines of the comment.
