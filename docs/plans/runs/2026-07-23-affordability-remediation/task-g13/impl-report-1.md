# G13 — impl report 1

## Objective

Close the branch-coverage shortfall the restored `apps/api` coverage gate exposed:
`apps/api/src/platform/dev/routes.ts` at 94.11% branch against a 95% floor, uncovered at lines 339 and 751.
Attribution first; and no test written merely to raise a number.

## Attribution — pre-existing, newly visible. Not this run's, not another workstream's.

Four pieces of evidence, all taken this session:

1. **The measured file is unmodified.** `git status --porcelain apps/api/src/platform/dev/` at task start listed
   `reads.ts`, `routes.integration.test.ts`, `seed-billing-history.{ts,integration.test.ts}`,
   `seed-public-stats.{ts,integration.test.ts}` — **not `routes.ts`**. `git log --oneline -- .../routes.ts` puts its
   last touch at `f1d99703` ("billing refactor"), a pre-run commit.

2. **The gate's configuration is unmodified.** `git status`/`git diff` on `apps/api/vitest.config.ts` are both empty.
   `src/platform/**/*.ts` already carried `COVERAGE_GATE` (95/95/95/95) with `perFile: true` at `HEAD`. G8 did not
   widen the include set or add a threshold — the file was always gated at 95.

3. **The run-era edit to the driving suite cannot have removed coverage.** The entire working-tree diff of
   `routes.integration.test.ts` is two lines: `userId:` → `payerUserId:` inside two `usageRecords` insert
   `.values({…})` objects (F8's payer rename). It changes a column key in a DB insert, not which route handlers
   execute. Confirmed against the branch counters below: both `??` **left** operands still execute (2 and 6 hits),
   so no previously-exercised path was lost.

4. **What actually changed is visibility.** Per §Known Breakage, vitest suppresses the coverage report whenever any
   test fails, so the standing `template-html` failure meant `pnpm test:api` printed no table at all. G8 fixed that
   failure; the first table it printed surfaced a shortfall that had been sitting under the gate the whole time.

**Conclusion: pre-existing, and merely newly visible.** It is neither this run's doing nor a concurrent
workstream's.

## Reachability of the two uncovered branches — both unreachable

Measured, not inferred. Scoped instrumented run over the file's only driving suites
(`vitest run --project api src/platform/dev --coverage --coverage.include=src/platform/dev/routes.ts`) reproduced
the gate figure exactly — `100 | 94.11 | 100 | 100`, uncovered `339,751`, `Branches: 94.11% ( 32/34 )` — and the
v8 `coverage-final.json` branch map named the exact operands:

```
branch  9  binary-expr  line 339  [2,0]   loc1 = cols 45–47   (the `0`    in `deleted.rowCount ?? 0`)
branch 16  binary-expr  line 751  [6,0]   loc1 = col 40+      (the `null` in `message.collapseKey ?? null`)
```

So in both cases it is the **fallback operand of a `??`** that is never taken, and in both cases the left operand
cannot be nullish on any path that reaches it:

- **Line 339 — `deleted.rowCount ?? 0`.** `Database` is `NeonDatabase` (`packages/db/src/client.ts:42`), whose
  delete result is the pg-shaped `QueryResult`; `@types/pg` declares `rowCount: number | null` (index.d.ts:90,353).
  Postgres always reports a row count in a `DELETE` command tag, so the `null` case is a **type obligation with no
  runtime instance**. Both reachable behaviours are already tested — `rowsAffected: 1`
  (routes.integration.test.ts:979) and `rowsAffected: 0` for an unknown share id (:990) — and both go through the
  left operand, which is exactly what the `[2,0]` counter shows.

- **Line 751 — `message.collapseKey ?? null`.** The capture wrap `withPushCapture`
  (`slices/notifications/adapters/push-sender-factory.ts:42-51`) is installed on the **mock partitions the composite
  dispatches to**, and the composite stamps the collapse alias on its way down
  (`push-composite.ts:45-47`: `.andThen((collapseKey) => fanOut(deps, { ...message, collapseKey }))`). Nothing else
  can push into `capturedPushes` — the wrapped mocks are module-private and constructed inside
  `createPushSenderFromEnv`. So **every entry `listCapturedPushes()` returns already carries an alias**, and the
  `undefined` case is unreachable. (`notify-event.test.ts:133` asserting `collapseKey` undefined is a *domain-level*
  fake sender that never reaches the capture wrap — it is not a counterexample.)

Per the acceptance criterion, that is the finding: **the code loses the branches rather than gaining tests for
them.** No test was added; a test for either fallback would have had to fabricate a state the construction forbids,
which is the vacuity class this run keeps finding.

## Files changed

- `apps/api/src/platform/dev/routes.ts` — `revokeShareWork` now deletes with `.returning({ id })` and reports
  `deleted.length`, so the count is an array length with no nullable to guard; the `/dev/push` viewer reads
  `message.collapseKey` directly, since a captured push always carries it.
- `apps/api/src/platform/dev/routes.integration.test.ts` — the test-local `CapturedPushView.tag` type was
  `string | null`, describing a shape the route no longer (and never actually could) produce; now `string`. No
  assertion changed.

Both are behaviour-preserving: the JSON `rowsAffected` value is identical, and `tag` carries the same alias string
on every reachable input.

## Tests added

**None, deliberately.** Both criteria-relevant behaviours were already pinned by existing tests, and the two
uncovered operands were unreachable. The existing tests discriminate the changes rather than merely coexisting with
them:

- `reports zero rows for an unknown share id` / the revoke happy path — if `.returning()` counted wrongly, they read
  `rowsAffected` and go red.
- `lists captured mock pushes with platform, category, alias tag and payload` — asserts `tag` is truthy and is not
  the raw conversation id, so if the alias stopped reaching the viewer, `tag` would be `undefined` and the
  assertion fails. That is a positive assertion over rendered state, not a negative one.
- The comment added at line 751 states a cross-file guarantee, and it is **bounded**: `push-sender-factory.test.ts`
  `captures every mock-delivered send with the composite-derived collapse alias` (:87-102) asserts the captured
  message's `collapseKey` equals the derived alias, so moving the capture wrap above the stamp reddens a gate
  before a reader could be misled.

## Self-gate

| command | exit | result |
| --- | --- | --- |
| scoped coverage, before edits (`vitest run --project api src/platform/dev --coverage --coverage.include=src/platform/dev/routes.ts`) | 1 | 11 files / 134 tests passed; `routes.ts` `100 \| 94.11 \| 100 \| 100`, uncovered `339,751`; `Branches: 94.11% ( 32/34 )` |
| scoped coverage, after edits (same command) | 0 | 11 files / 134 tests passed; `Statements 100% (162/162) · Branches 100% (30/30) · Functions 100% (97/97) · Lines 100% (144/144)`; zero rows in the uncovered table |
| `npx eslint src/platform/dev/routes.ts src/platform/dev/routes.integration.test.ts` (from `apps/api`, after the final edit) | 0 | clean |
| `pnpm arch:check` | 0 | `OK — 13 rule(s) over 2189 file(s)` |
| `npx turbo typecheck --force --continue` (repo-wide) | 2 | red, **attributed outward** — see below |
| `pnpm test:api` (baseline, before edits) | 1 | see below |
| `pnpm test:api` (final) | see below | see below |

A single `--coverage.include` was used per run (never stacked), and the scoped selection was the whole
`src/platform/dev` directory: `routes.ts` is reached only from there — the only files in `apps/api/src` containing a
`'/dev/…'` request path are `platform/dev/routes.integration.test.ts` and `platform/dev/admin-token.test.ts`. The
scoped figure matching the full-gate figure (94.11%, same two lines) confirms the selection was not narrow.

### Repo-wide typecheck (exit 2) — not mine

All 71 errors across the 12 red packages resolve to exactly three files, all F7-owned and mid-flight:
`packages/shared/src/affordability/billing/client-billing.ts` (+ its two test files),
`apps/api/src/slices/billing/domain/spendable.ts`, `apps/api/src/slices/chat/domain/turn-context.ts` — a
`turnEstimateNanoUsd` / `minTurnCostNanoUsd` `FundingInputs` mismatch. **Zero errors mention `platform/dev`**
(`grep -c "platform/dev"` over the log = 0). `tsgo` reports all errors rather than aborting on the first, so its
silence on my two files is positive evidence they typecheck.

### `pnpm test:api` — the FAIL count, and why the gate table is blocked

**Baseline run (before any edit of mine), own captured status `TESTAPI_EXIT=1`:**

```
Test Files  4 failed | 471 passed | 1 skipped (476)
     Tests  6 failed | 6502 passed | 34 skipped (6542)
```

The harness notification for that run said *"completed (exit code 0)"* — the documented trap; the command's own
`echo "TESTAPI_EXIT=$?"` into its own file said **1**. The 6 failures sit in
`slices/chat/domain/runtime.test.ts`, `slices/chat/routes.integration.test.ts`,
`slices/admin/domain/operations/model.integration.test.ts` and `slices/admin/routes-reads.integration.test.ts` —
F7 / D3 / C5 territory, mid-flight, attributed outward and not chased. Every `src/platform/dev/*` suite passed,
including `routes.integration.test.ts` (68 tests).

**Because those tests fail, vitest never reaches the coverage report** — that baseline run printed no threshold
table at all, which is the same §Known Breakage mechanism that hid this shortfall in the first place.

**Final run (after my edits), own captured status `TESTAPI_EXIT=1`:**

```
Test Files  8 failed | 466 passed | 1 skipped (475)
     Tests  114 failed | 6401 passed | 3 skipped (6518)
```

**FAIL count: 114 failed tests across 8 files — none in `platform/dev`.** Distribution of the 230 `FAIL` lines:

```
194  src/slices/chat/routes.integration.test.ts
 12  src/slices/chat/domain/turn-context.test.ts
  8  src/slices/conversations/routes.integration.test.ts
  8  src/app-mount.integration.test.ts
  4  src/slices/chat/domain/turn-definition.integration.test.ts
  2  src/slices/identity/routes-email-verification.integration.test.ts
  2  src/slices/admin/routes-reads.integration.test.ts
  2  src/slices/admin/domain/operations/model.integration.test.ts
```

`chat/routes.ts` + `turn-context.ts` are F7's, `turn-definition.ts` is D3's, and the email-verification entry is
already in §Known Breakage. The suite got **worse** between my baseline (6 failed) and my final run (114 failed)
while my only edits were inside `platform/dev` — the two files I changed and every other `src/platform/dev/*` suite
passed in both runs, `routes.integration.test.ts` at 68/68 both times. The harness again announced this run as
*"completed (exit code 0)"* against a real `TESTAPI_EXIT=1`; that is the third instance this session.

**So no coverage table printed on either full run, and none can print until F7/D3/C5 land.** Vitest suppresses the
coverage report on a red suite, which is precisely the mechanism §Known Breakage documents and precisely what hid
this shortfall until G8. The brief's requested artefact — a `pnpm test:api` table showing the file at or above the
floor — is therefore **blocked on other agents, not on this task**, and needs a re-run once the suite is green.
What stands in its place is the instrumented scoped run above, which is not a weaker proxy for a narrow reason:
running it **before** the edits reproduced the gate's figure *exactly* (94.11%, uncovered `339,751`), so its
denominator and numerator are the gate's, and after the edits the same command reads `100% (30/30)`.

## Acceptance criteria

| criterion | verdict | evidence |
| --- | --- | --- |
| the shortfall is attributed before it is closed, with the evidence stated | met | §Attribution — pre-existing and newly visible; four independent checks (file unmodified, gate config unmodified, the driving suite's only edit is a two-line column rename that leaves both `??` left operands executing, and G8 restored the report rather than the threshold) |
| if it is this run's, the uncovered branches are covered by a test that names its behaviour | n/a | it is not this run's |
| no test written merely to raise a number; if unreachable, that is the finding and the code loses them | met | zero tests added; both fallback operands proved unreachable from the branch map plus the driver type and the capture-seam ordering, and both were deleted |
| the gate passes at the file level afterwards | met | `Branches: 100% ( 30/30 )` on the instrumented run over the file's driving suites; `routes.ts` no longer appears in the uncovered table |

## Deviations

- **No TDD red-first cycle**, and it was not applicable: the change is a behaviour-preserving refactor of
  unreachable defensive code (AGENT-RULES' refactor path — tests exist and pass before and after). Writing a red
  test first would have required fabricating a state the construction forbids, which the task explicitly forbids.
- **The full-gate coverage table could not be obtained on a fully green suite** while F7/D3/C5 are mid-flight; the
  file-level evidence is the instrumented scoped run over the file's complete driving-suite set. See the final-run
  section for what the last full run actually showed.

## Concerns and limitations

- `tag` on `GET /dev/push` is now typed `string | undefined` rather than `string | null`, so an absent value would
  omit the key rather than send `null`. There is **no in-repo consumer** of that field outside the integration test
  — a repo-wide sweep for `dev/push` (binary-inclusive `grep -a`, no piped stages) found only
  `platform/dev/routes.{ts,integration.test.ts}` and two arch-rule doc mentions; `apps/web`, `apps/admin`, `e2e`
  and `scripts` contain none. Any out-of-repo dev tooling reading the field would see the key omitted instead of
  `null`.
- The two deleted fallbacks were unreachable *by construction of their callers*, not by type. If a future change
  ever exposed the wrapped mock senders outside `createPushSenderFromEnv`, or routed a captured message around the
  composite, `tag` would become `undefined` — and `push-sender-factory.test.ts:87-102` plus the `/dev/push` viewer
  test both go red at that point, so the gate holds it.
- The baseline and final `pnpm test:api` runs were taken under concurrency with three live agents; per §Known
  Breakage no single api sweep is evidence of suite health in either direction. The claims made here about
  `routes.ts` rest on the instrumented scoped runs, which reproduced the gate figure exactly and are stable across
  the before/after pair.

## Confidence

**High** on the attribution, the reachability analysis and the file-level result — each rests on something measured
(git state, the v8 branch map's per-operand hit counts, the capture-seam construction, and a before/after pair of
instrumented runs where the "before" reproduced the gate figure exactly).

**Medium** on one thing only: the gate table itself was never observed on a full `pnpm test:api`, because the suite
is red for reasons outside this task. If the orchestrator wants that artefact, it needs one re-run after F7/D3/C5
go green — no further change to `platform/dev` is expected to be required.
