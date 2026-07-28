# Task 22 — impl report 2

Cycle 2 addresses the two rulings the orchestrator returned after cycle 1. Everything
delivered in cycle 1 (the Resend evidence deletion, the `SERVICE_NAMES.RESEND` removal, the
`ci.yml` step removal, and the folded `scripts/generate-env.test.ts` one-liner) is unchanged
and still in place; `impl-report-1.md` remains the record for it. The three deviations
raised in cycle 1 were accepted by the orchestrator and required no action.

## Objective

1. **Ruling 1** — drop the now-dead `db` parameter from `createEmailSenderFromEnv`, remove
   the orphaned `Database` type import, and update every call site. `@hushbox/api`
   typecheck must be green.
2. **Ruling 2** — rename `email-resend.integration.test.ts` → `email-resend.test.ts`, but
   only after proving nothing routes on the `.integration.test.ts` suffix.

## Files changed

| Path | Why |
| --- | --- |
| `apps/api/src/slices/notifications/adapters/email-sender-factory.ts` | Ruling 1: dropped the `db: Database` parameter and the now-unused `import type { Database } from '@hushbox/db'`. |
| `apps/api/src/slices/notifications/adapters/email-sender-factory.test.ts` | Ruling 1: dropped the `db` stub, its `Database` type import, and the explanatory comment above it (the comment described the thread-through that no longer exists); removed the second argument at all 10 call sites; reflowed two of them to satisfy prettier. |
| `apps/api/src/adapters/send-email.ts` | Ruling 1 call site; corrected the doc comment, which listed "the evidence db" among the per-invocation dependencies — my change made that false. |
| `apps/api/src/scheduled.ts` | Ruling 1 call site. |
| `apps/api/src/adapters/dispatcher-job-registry.ts` | Ruling 1 call site. |
| `apps/api/src/adapters/admin-op-bindings.ts` | Ruling 1 call site. |
| `apps/api/src/slices/newsletter/newsletter-lifecycle.integration.test.ts` | Ruling 1 call site (not enumerated in the brief — see Deviations). |
| `apps/api/src/platform/dev/routes.integration.test.ts` | Ruling 1 call site (not enumerated in the brief — see Deviations). |
| `apps/api/src/slices/notifications/adapters/email-resend.integration.test.ts` → `email-resend.test.ts` | Ruling 2: pure rename, no content change. Filesystem `mv`, no git write. |

No other file was touched this cycle.

## Ruling 1 — full list of call sites changed

The brief enumerated four production sites and "six in `email-sender-factory.test.ts`".
The real counts are four production sites, **ten** in `email-sender-factory.test.ts`, and
**two further test files the brief did not name**. All twelve non-production sites had to
change: the parameter removal is a compile error at every one of them, so leaving any
behind would have kept typecheck red.

**Production (4):**

- `apps/api/src/scheduled.ts:143` — `createEmailSenderFromEnv(deps.env, deps.db)` → `(deps.env)`
- `apps/api/src/adapters/send-email.ts:50` — `createEmailSenderFromEnv(c.env, c.var.db)` → `(c.env)`
- `apps/api/src/adapters/dispatcher-job-registry.ts:154` — `createEmailSenderFromEnv(env, db)` → `(env)`
- `apps/api/src/adapters/admin-op-bindings.ts:140` — `createEmailSenderFromEnv(env, db)` → `(env)`

**`email-sender-factory.test.ts` (10):** original lines 16, 20, 26, 32, 38, 47, 48, 67, 68,
86. Plus the `const db = {} as Database` stub, its `import type { Database }`, and the
two-line comment that justified the stub.

**Beyond the brief's list (2):**

- `apps/api/src/slices/newsletter/newsletter-lifecycle.integration.test.ts:116` — `createEmailSenderFromEnv(testEnv, db)` → `(testEnv)`
- `apps/api/src/platform/dev/routes.integration.test.ts:1363` — `createEmailSenderFromEnv({ NODE_ENV: 'development' }, db)` → `({ NODE_ENV: 'development' })`

In both of those files the local `db` binding is still used by other tests in the same
file, so nothing else became orphaned (confirmed by typecheck: `noUnusedLocals` is on and
the run is clean).

The barrel re-export at `apps/api/src/slices/notifications/index.ts:43` is untyped
pass-through and needed no edit.

### Typecheck, pasted GREEN

```
$ npx turbo typecheck --filter=@hushbox/api --filter=@hushbox/db --force
• Packages in scope: @hushbox/api, @hushbox/db
• Running typecheck in 2 packages
@hushbox/api:typecheck: cache bypass, force executing 8e9489ecb0bbd128
@hushbox/db:typecheck:  cache bypass, force executing 3515fbd6ffcb8659
@hushbox/api:typecheck: > tsgo --noEmit
@hushbox/db:typecheck:  > tsgo --noEmit

 Tasks:    2 successful, 2 total
Cached:    0 cached, 2 total
```

Run again as the final gate after the last edit (the prettier reflow) — still
`2 successful, 2 total`. The `TS6133: 'db' is declared but its value is never read` error
that made cycle 1 DONE_WITH_CONCERNS is gone.

The parameter was **deleted, not renamed to `_db`**, as ruled.

## Ruling 2 — suffix-routing investigation, then the rename

I searched every place the brief named plus the full config surface. Findings verbatim:

**`apps/api/vitest.config.ts` — no suffix routing.** It defines three projects. Their
selection keys are:
- `api`: no `include` at all (inherits the root config's default `**/*.test.ts` glob); its
  `exclude` is `['**/dist/**', '**/node_modules/**', '**/src/smoke/**', ...OPTIMIZER_OFF_FILES]`.
- `smoke`: `include: ['src/smoke/**/*.smoke.test.ts']`.
- `api-noopt`: `include: OPTIMIZER_OFF_FILES`, a two-entry literal list
  (`src/lib/resilience/policies.test.ts`, `src/slices/models/adapters/video-adapter.test.ts`).

The string `integration` does not appear anywhere in that file. `email-resend.*.test.ts`
matches the `api` project's default glob under either name, and no other project's
selector under either name.

**`scripts/run-package-tests.ts` — no suffix routing.** Its only file-path logic is the
pole gate, which reads wall times out of vitest's JSON report and compares them to
`POLE_MIN_MS = 15_000` / `POLE_MAJORITY_SHARE = 0.5` (`:130-207`). It never inspects the
filename. Its weight cache is **per package**, not per file (`weightsByPkg`,
`writeWeight(weightsDir, packageName, …)` at `:346`), so a filename change cannot
invalidate or misdirect it. Grepping `integration` in that file returns only unrelated
comment text about poles.

**The two places in the repo that DO key on the suffix, neither of which routes tests:**

1. `packages/config/eslint.config.js:337-343` —
   ```js
   {
     // Integration tests may need CI debug output
     files: ['**/*.integration.test.ts'],
     rules: {
       'no-console': 'off',
     },
   }
   ```
   A lint relaxation, not test routing. The renamed file contains **no `console` usage at
   all** (`grep -n "console" …` → no matches), so losing the relaxation changes nothing.
   Confirmed empirically: eslint over the renamed file exits 0.
2. `packages/config/arch/rules/jobs-test-shard-isolation.rule.ts:35-41` — matches
   `filePath.includes('apps/api/src/lib/jobs/') && filePath.endsWith('.integration.test.ts')`.
   Scoped to the jobs tree; this file lives in
   `apps/api/src/slices/notifications/adapters/`, so the rule never applied before or
   after. `pnpm arch:check` → `OK — 11 rule(s) over 2031 file(s)`.

**CI (`.github/workflows/ci.yml`), `turbo.json`, `knip.jsonc`, root/package `package.json`
scripts, `packages/config/vitest.config.ts`** — a repo-wide grep for `integration.test` /
`integration'` across `*.json`, `*.jsonc`, `*.yml`, `*.js`, `*.mjs` returns exactly two
hits: the eslint override above, and a string literal inside a rule's own unit test
(`packages/config/eslint-extensions/rules/fee-seams.test.mjs:128`). No workflow, script, or
config splits, shards, or filters tests by the suffix. Nothing imports the file by path
either (grep for `email-resend.integration` outside `node_modules`/`dist`/`coverage`/run
dirs → no matches).

**Verdict: I renamed it.** No routing keys on the suffix, so the rename cannot change where
or whether the file runs — and the api suite proves it empirically: total test-file count is
**469 before and 469 after**, with `email-resend.test.ts` accounted for among the passes.
The rename also matches the precedent already in this run: Task 18 renamed
`push-fcm.integration.test.ts` → `push-fcm.test.ts` for the same reason (visible in
`git status`), and it audited clean.

## Tests

No tests added or removed this cycle. The parameter removal changes no behavior, so there
is no new behavior to drive test-first; `email-sender-factory.test.ts`'s nine existing tests
are the regression net and all nine still pass. Edits to that file are purely mechanical
argument removal — no assertion, subject, or test name changed.

## Self-gate

| Command | Result |
| --- | --- |
| `turbo typecheck --filter=@hushbox/api --filter=@hushbox/db --force` | **pass** — 2 successful, 2 total (pasted above) |
| `pnpm test:db` (`turbo test --filter=@hushbox/db --force`) | **pass** — 27 files / 530 tests + 2 workers files / 2 tests |
| `pnpm test:api` (`turbo test --filter=@hushbox/api --force`) | **fail — external only**, see attribution below |
| `pnpm test:watch …/email-sender-factory.test.ts` | **pass** — 9/9, re-run after the final edit |
| `pnpm test:watch …/email-resend.test.ts` | **pass** — 17/17 under the new filename |
| `npx eslint` × 10 api files, from `apps/api` | **pass** — exit 0, after the last edit |
| `npx eslint` × 2 db files, from `packages/db` | **pass** — exit 0, after the last edit |
| `npx eslint generate-env.test.ts`, from `scripts` | **pass** — exit 0, after the last edit |
| `pnpm arch:check` | **pass** — OK, 11 rules over 2031 files |
| `pnpm lint:unused` (knip) | **fail — pre-existing repo-wide red only**, zero findings on touched files |

### `pnpm test:db` — green

```
@hushbox/db:test:  Test Files  27 passed (27)
@hushbox/db:test:       Tests  530 passed (530)
@hushbox/db:test:  Test Files  2 passed (2)      # db-workers project
@hushbox/db:test:       Tests  2 passed (2)
 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
```

Run with `--force` so no turbo cache hit could mask a failure.

### `pnpm test:api` — the failures and their attribution

Run twice back to back, both forced.

Run A:
```
 Test Files  1 failed | 467 passed | 1 skipped (469)
      Tests  7 failed | 6419 passed | 3 skipped (6429)
 ❯  api  src/slices/notifications/domain/templates/template-html.test.ts (7 tests | 7 failed)
```

Run B:
```
 Test Files  2 failed | 466 passed | 1 skipped (469)
      Tests  8 failed | 6418 passed | 3 skipped (6429)
```

**`template-html.test.ts` — 7 failures, NOT mine (founder-owned, named in my brief).**
Identical in both runs and identical to cycle 1: seven `toMatchSnapshot` mismatches whose
sole diff is one removed line,
`- <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&display=swap" rel="stylesheet">`
— commit `a0a0f4c6` removed the font link without updating the snapshots. I never opened
that file or anything it imports.

**`chat/routes.integration.test.ts` — 1 failure in run B only, a cross-file flake, NOT
mine.** `POST /chat/trial > starts a trial run (201) echoing the supplied session id`
asserted `expected 403 to be 201` at `:3703`. Attribution evidence:
- It **passed in run A**, the immediately preceding identical forced run, and passed in
  cycle 1's run.
- Re-run in isolation right after: `Test Files 1 passed (1) / Tests 188 passed (188)`.
- 403 on a trial start is trial-quota/eligibility refusal — day-keyed shared allowance
  state. Nothing in my change touches chat, trial, quota, or authorization; my diff is
  confined to email-sender construction and its call sites.
- `apps/api/src/slices/chat/routes.ts` and `src/slices/models/domain/trial-eligibility.ts`
  are both dirty in `git status` from concurrent work I did not do and must not touch.

Every other api test file passes, including both files I own:
`email-resend.test.ts` (17) and `email-sender-factory.test.ts` (9). No pole warning and no
per-file coverage-threshold error appeared in either run.

### knip

```
$ pnpm lint:unused
Unused files (1)
packages/config/vitest.package.config.ts
Configuration hints (1)
wrangler  apps/sandbox  knip.jsonc  Remove from ignoreDependencies
 ELIFECYCLE  Command failed with exit code 1.
```

Byte-identical to cycle 1's output — the pre-existing repo-wide red my brief names as not
mine. Zero findings on any file this task touched, including every export the parameter
removal could have orphaned.

## Acceptance criteria

Cycle-1 criteria (unchanged, evidence in `impl-report-1.md`): `ci.yml` step and comment
removed — **met**; `recordEvidence` + both call sites removed from `email-resend.ts` —
**met**; evidence-asserting tests deleted — **met**; `SERVICE_NAMES.RESEND` and its
assertion removed — **met**; `scripts/generate-env.test.ts` expectation corrected — **met**.

The criterion cycle 1 deliberately stopped at:

- *"Orphans YOUR change creates are removed: … If that makes `db` unused in
  `createEmailSenderFromEnv`'s signature, REPORT the ripple rather than forcing it
  through."* — **met this cycle under Ruling 1.** Reported in cycle 1, ruled by the
  orchestrator, executed here: parameter and type import deleted, all 16 call sites
  updated, typecheck green.
- *Ruling 2 (orchestrator-added)* — **met.** Suffix-routing investigation completed and
  came back negative on every routing surface; file renamed to `email-resend.test.ts`.

## Deviations

1. **Two call sites beyond the brief's enumeration.** The brief listed four production sites
   and six in `email-sender-factory.test.ts`. The actual set is four production, ten in
   `email-sender-factory.test.ts`, and two more files —
   `newsletter-lifecycle.integration.test.ts:116` and
   `platform/dev/routes.integration.test.ts:1363`. These were not optional: with the
   parameter gone, each is a hard compile error, and Ruling 1 requires typecheck green.
   `routes.integration.test.ts` already carried uncommitted edits from earlier work in this
   run; my change to it is one argument on one line and disturbs nothing else.
2. **One doc comment corrected in `send-email.ts`.** It listed "the evidence db" among the
   per-invocation dependencies the function resolves; the parameter removal made that
   false. Same reasoning the orchestrator accepted for cycle 1's two comment fixes — a
   wrong comment is worse than none. No behavior change.
3. **Two call sites reflowed for prettier.** Removing an argument changed line lengths, so
   `prettier/prettier` demanded a reflow at the multi-line production-sender construction
   and at the `toThrow(/RESEND_API_KEY/)` assertion. Purely formatting; caught by the
   post-final-edit eslint run and fixed, then eslint re-run to exit 0.

## Concerns and limitations

- **`pnpm test:api` is not green**, but nothing red in it is mine: 7 founder-owned snapshot
  failures that are identical across every run, plus one cross-file trial-quota flake that
  passes in isolation and passed in the adjacent identical run. Attribution evidence is
  above. The flake is worth the orchestrator's attention independently of this task — it is
  order/shared-state dependent, so it can surface in any run of the api suite.
- **The `.integration.test.ts` suffix carries a real (if minor) meaning the codebase does
  not enforce**: `packages/config/eslint.config.js` grants those files `no-console`. Nothing
  makes a file that talks to Postgres actually carry the suffix, so the naming is
  convention-only. Out of scope here; noted because the rename is only correct as long as
  that stays true.
- The cycle-1 CAVEAT stands unchanged: after this task, no CI signal asserts anything about
  Resend beyond the mock-backed E2E newsletter flow through `/dev/mailbox`. That is the
  intended, honest state, with the recorded re-entry condition (Resend test-mode addresses
  + restricted send-only keys would make a real CI call buildable on Task 18's shape).

## Confidence

**High.** Both rulings are executed exactly as written and independently verified:
`@hushbox/api` + `@hushbox/db` typecheck is forced-green (the one thing cycle 1 could not
close), every eslint invocation exits 0 from its own package directory after the final edit,
`arch:check` passes, knip finds nothing on my files, `pnpm test:db` is fully green, and the
api suite's only reds are attributed to sources outside my ownership with reproduction
evidence for each. The rename is backed by a negative result on every routing surface the
brief named plus the full config sweep, and corroborated by an identical 469-file count
before and after.
