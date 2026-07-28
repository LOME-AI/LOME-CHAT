# Task 22 — impl report 1

## Objective

Two independent items:

1. Delete Resend's false CI evidence claim — the `ci.yml` step, the adapter's evidence
   write, its tests, and the `SERVICE_NAMES.RESEND` registry entry.
2. Folded-in one-line fix: `scripts/generate-env.test.ts`'s production-secret expectation
   was missing `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `NOTIFICATION_TAG_SECRET`.

## Files changed

| Path | Why |
| --- | --- |
| `.github/workflows/ci.yml` | Removed the `Verify Resend was called` step and the Resend clause of the comment above it. |
| `apps/api/src/slices/notifications/adapters/email-resend.ts` | Removed `recordEvidence` + both call sites; removed the now-unused `db`/`isCI` config fields, `sendResponseSchema`, and the `@hushbox/db` imports; corrected the stale doc comment. |
| `apps/api/src/slices/notifications/adapters/email-resend.integration.test.ts` | Deleted the evidence-mechanism tests and every construction-site reference to `db`/`isCI`; dropped the now-unused DB harness (`createDb`, `serviceEvidence`, `sql`, `runId`, `evidenceRowsForRun`, `afterAll`). |
| `apps/api/src/slices/notifications/adapters/email-sender-factory.ts` | Stopped passing `db`/`isCI` into `createResendEmailSender`; corrected the doc comment, which claimed CI exercises the evidence path (now false, and it also carried a `Phase 4` plan label — a durable-naming violation). |
| `packages/db/src/evidence.ts` | Removed `SERVICE_NAMES.RESEND` — a registry entry no writer can satisfy, and the source of `verify-evidence.ts`'s `VALID_SERVICES`. |
| `packages/db/src/evidence.integration.test.ts` | Deleted the assertion on the removed constant. |
| `scripts/generate-env.test.ts` | Item 2: added the three notification secrets to the verify-secrets expectation. |

No DB migration is needed: `service_evidence.service` is a plain `text` column
(`packages/db/src/schema/service-evidence.ts`), not a pgEnum, so removing the constant has
no schema consequence.

## Evidence

### `ci.yml` diff (Task 18's additions intact)

```diff
@@ -140,6 +140,8 @@ jobs:
         env:
           OPENROUTER_API_KEY_RESTRICTED: ${{ secrets.OPENROUTER_API_KEY_RESTRICTED }}
           LINEAR_API_KEY_READ: ${{ secrets.LINEAR_API_KEY_READ }}
+          FCM_PROJECT_ID_CI: ${{ secrets.FCM_PROJECT_ID_CI }}
+          FCM_SERVICE_ACCOUNT_JSON_CI: ${{ secrets.FCM_SERVICE_ACCOUNT_JSON_CI }}
         # END GENERATED: vitest-env
@@ -219,11 +221,8 @@ jobs:
         run: pnpm verify:evidence --require=openrouter
       - name: Verify Linear was called
         run: pnpm verify:evidence --require=linear
-      # Resend and FCM have no CI sandbox, so these assert the real adapter
-      # send-and-record code path ran (against a mocked HTTP seam), not a live
-      # provider call. Founder-verify/CI-pending: a real Resend/FCM sandbox call.
-      - name: Verify Resend was called
-        run: pnpm verify:evidence --require=resend
+      # FCM is a real call: the live test authenticates against Google and
+      # posts a validate-only send, and writes the row only after it succeeds.
       - name: Verify FCM push was called
         run: pnpm verify:evidence --require=push-fcm
```

The diff is against HEAD, so it shows Task 18's changes and mine combined. Task 18's two
new secrets in the `# BEGIN GENERATED: vitest-env` block are untouched, and its FCM comment
(the `+` lines) is present verbatim. The deleted Resend step sat **outside** the generated
markers (verified before editing: the block spans `ci.yml:139-145`, the Resend step was at
`:224-228`), so nothing was hand-edited inside the markers.

### `pnpm generate:env` produces a clean tree

```
$ pnpm generate:env
  Generated .env.development
  Generated .env.scripts
  Generated apps/api/.dev.vars
  Updated apps/api/wrangler.toml [vars]
  Updated .github/workflows/ci.yml
  Updated .github/workflows/release.yml
  Updated .github/workflows/build-android.yml
  Updated .github/workflows/run-ops-script.yml
✓ All environment files generated

$ git status --porcelain .github/workflows/ .env.development .env.example
 M .github/workflows/ci.yml
```

The post-generate `git diff .github/workflows/ci.yml` is byte-identical to the pre-generate
diff quoted above — the generated blocks did not drift, and `ci.yml` is the only workflow
file modified (by my hand-edit outside the markers, plus Task 18's generated-block change).

### Removed `recordEvidence` code and both call sites

Removed helper:

```ts
  function recordEvidence(messageId: string | undefined): ResultAsync<void, DomainError> {
    return fromPromise(
      recordServiceEvidence(
        config.db,
        config.isCI,
        SERVICE_NAMES.RESEND,
        messageId === undefined ? undefined : { messageId }
      ),
      (cause) => unavailableError('service-evidence write failed', cause)
    ).map((): void => undefined);
  }
```

Call site 1 — `send()`, before:

```ts
      return post(RESEND_API_URL, JSON.stringify(serializeMessage(message)), {}).andThen((data) => {
        const parsed = sendResponseSchema.safeParse(data);
        return recordEvidence(parsed.success ? parsed.data.id : undefined);
      });
```

after:

```ts
      return post(RESEND_API_URL, JSON.stringify(serializeMessage(message)), {}).map(
        (): void => undefined
      );
```

Call site 2 — `sendBatch()`, before:

```ts
        const ids = parsed.data.data.map((item) => item.id);
        return recordEvidence(ids[0]).map((): BatchSendResult => ({ ids }));
```

after:

```ts
        const ids = parsed.data.data.map((item) => item.id);
        return okAsync<BatchSendResult, DomainError>({ ids });
```

`sendResponseSchema` existed only to feed `recordEvidence` the message id, so it went with
it (the "tolerates a success response without a message id" test still pins that a
success body without an `id` is not an error).

### Grep proofs

```
$ grep -rn "SERVICE_NAMES.RESEND" --include="*.ts" --include="*.yml" --include="*.md" . | grep -v node_modules | grep -v docs/plans/runs
(no matches)

$ grep -rn -- "--require=resend" . | grep -v node_modules | grep -v docs/plans/runs | grep -v "^\./\.git/"
(no matches)

$ grep -rn "recordServiceEvidence" apps/api/src/slices/notifications/
apps/api/src/slices/notifications/adapters/push-fcm-live.integration.test.ts:4:  recordServiceEvidence,
apps/api/src/slices/notifications/adapters/push-fcm-live.integration.test.ts:199:      await recordServiceEvidence(db, AMBIENT_ENV.isCI, SERVICE_NAMES.PUSH_FCM, {
```

Task 19's FCM evidence writer is the only remaining evidence writer in the notifications
slice, untouched.

### knip (`pnpm lint:unused`)

```
$ pnpm lint:unused
Unused files (1)
packages/config/vitest.package.config.ts
Configuration hints (1)
wrangler  apps/sandbox  knip.jsonc  Remove from ignoreDependencies
 ELIFECYCLE  Command failed with exit code 1.
```

**Zero findings over any file this task touched.** The one unused file is the repo-wide
red the brief names as known and not mine; the `wrangler`/`apps/sandbox` configuration hint
is likewise pre-existing and in a tree I never opened. Every export my change orphaned was
removed in the same edit: `sendResponseSchema` (module-local), the `db`/`isCI` fields on
`ResendEmailSenderConfig`, `SERVICE_NAMES.RESEND`, and the test file's DB harness
(`createDb`/`LOCAL_NEON_DEV_CONFIG`/`serviceEvidence`/`sql` imports, `runId`, `runPattern`,
`evidenceRowsForRun`, `afterAll`). `ResendEmailSenderConfig` itself stays exported and used.

### `scripts/generate-env.test.ts` after the folded fix

Red first, for the expected reason:

```
 FAIL  generate-env.test.ts > updateWorkflows > verify-secrets section > generates for loop with all backend secret keys
AssertionError: expected 'name: CI\n# BEGIN GENERATED: verify-s…' to contain 'for secret in DATABASE_URL UPSTASH_RE…'
- … FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON HELCIM_API_TOKEN …
+ … FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY NOTIFICATION_TAG_SECRET HELCIM_API_TOKEN …
 Test Files  1 failed (1)
      Tests  1 failed | 112 passed (113)
```

Green after:

```
 Test Files  1 passed (1)
      Tests  113 passed (113)
   Duration  1.59s
```

The registry was left alone; only the stale expectation moved, exactly as instructed.
Note this file already carried uncommitted Task 18 edits (the `FCM_*_CI` beforeEach/afterEach
at `:406-417`); my one-line change is additive to them and disturbs nothing.

## Tests

No tests added — this task is a deletion. Tests removed:

| Test | Why removed |
| --- | --- |
| `writes a service-evidence row when isCI is true` | Asserts the deleted mechanism. |
| `writes a batch service-evidence row when isCI is true` | Asserts the deleted mechanism. |
| `writes no service-evidence row when isCI is false` | Asserted the absence of a mechanism that no longer exists — now vacuously true forever. |
| `writes no service-evidence row for a rejected send` | Same; vacuous after the deletion. |
| `fails the send when the evidence write fails` | Asserted the failure mode being deliberately removed; would fail (send now succeeds with a broken db). |
| `packages/db` — `exports the resend email service name` | Asserts the deleted constant. |

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch scripts/generate-env.test.ts` | **pass** — 113/113 |
| `pnpm test:watch …/email-resend.integration.test.ts` | **pass** — 17/17 (was 22; 5 deleted) |
| `pnpm test:db` | **pass** — 27 files / 530 tests, plus 2 workers files / 2 tests; coverage gate green (`evidence.ts` 100/100/100/100) |
| `pnpm test:api` | **fail — 7 known-external failures only**: `1 failed \| 467 passed \| 1 skipped (469)` files, `7 failed \| 6419 passed \| 3 skipped (6429)` tests; see below |
| targeted coverage, `email-*.ts` | **pass** — `email-resend.ts` and `email-sender-factory.ts` both 100% stmts/branch/funcs/lines (only `email-mock.ts` appears below full, because its own test file was outside the subset) |
| `npx eslint` on the 3 touched api files (from `apps/api`) | **pass** — exit 0, run after the final edit |
| `npx eslint` on the 2 touched db files (from `packages/db`) | **pass** — exit 0, run after the final edit |
| `turbo typecheck --filter=@hushbox/api --filter=@hushbox/db --force` | **fail — 1 error, the reserved ripple**, see below |
| `pnpm lint:unused` (knip) | **fail — pre-existing repo-wide red only**, zero findings on touched files |

### typecheck failure — the ripple the plan reserved for the orchestrator

```
src/slices/notifications/adapters/email-sender-factory.ts(63,63): error TS6133: 'db' is declared but its value is never read.
```

This is the exact ripple the plan and my brief reserved: removing `db`/`isCI` from
`ResendEmailSenderConfig` leaves `db` unused in `createEmailSenderFromEnv`'s signature.
I did **not** force it through. The consequence is that `@hushbox/api` typecheck is RED
until the orchestrator rules — TS `noUnusedParameters` makes this a hard error, not a
warning, so there is no state in which the mandated deletion lands and typecheck stays
green without touching the composition root.

The change the ruling would authorize, in full: drop the `db: Database` parameter and the
`import type { Database } from '@hushbox/db'` from `email-sender-factory.ts`, then drop the
argument at these call sites —

- `apps/api/src/scheduled.ts:143` — `createEmailSenderFromEnv(deps.env, deps.db)`
- 3 further production call sites (`send-email`, dispatcher job registry, admin-op bindings)
- `apps/api/src/slices/notifications/adapters/email-sender-factory.test.ts` — 6 call sites

### `pnpm test:api` failure — the known-external red, nothing else

The suite ran to completion on the second attempt:

```
 Test Files  1 failed | 467 passed | 1 skipped (469)
      Tests  7 failed | 6419 passed | 3 skipped (6429)

 ❯  api  src/slices/notifications/domain/templates/template-html.test.ts (7 tests | 7 failed)
```

The single failing file is exactly the known-red snapshot set my brief names as owned
elsewhere — `welcome`, `password-changed`, `two-factor-enabled`, `two-factor-disabled`,
`account-locked`, `account-deleted`, `chargeback-lock` (commit `a0a0f4c6` removed a
`fonts.googleapis` link without updating the snapshot). I did not touch that file or
anything it imports. **Every other file in the api package passes**, including both files I
own: `src/slices/notifications/adapters/email-resend.integration.test.ts (17 tests)` ✓.
The coverage gate ran without a per-file shortfall on anything I changed.

The first attempt at this command aborted early on an infrastructure crash rather than a
test — recorded here because it will look like a failure in any log kept from that run:

```
⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
Error: Something removed the coverage directory ".../apps/api/coverage/.tmp" Vitest
created earlier. Make sure you are not running multiple Vitests with the same
"coverage.reportsDirectory" at the same time.
Caused by: Error: ENOENT: no such file or directory, open '.../coverage/.tmp/coverage-28.json'
```

That is the known unconfirmed Vitest bug, triggered by a concurrent Vitest run sharing the
same `coverage.reportsDirectory` — other agents work in this repo concurrently. It did not
recur on the clean rerun.

## Deviations

1. **Five tests deleted from `email-resend.integration.test.ts`, not two.** The plan said
   "the two evidence-asserting tests". Three more are evidence-mechanism tests: two assert
   the *absence* of a row (vacuous once the mechanism is gone — a test that can never fail
   is worse than none) and `fails the send when the evidence write fails` asserts the exact
   failure mode being removed, so it would have gone red. Listed individually in the Tests
   table above.
2. **The plan's "every other test in that file must still pass untouched" could not hold
   literally.** Dropping `db`/`isCI` from `ResendEmailSenderConfig` (a mandatory criterion)
   makes every `createResendEmailSender({ …, db, isCI: false, … })` literal a TS excess-property
   error. The edits to the surviving tests are purely mechanical — the removal of those two
   dead fields and the run-unique message-id template strings that only the evidence queries
   needed. No assertion, subject, or name of a surviving test changed.
3. **Doc comments corrected in `email-resend.ts` and `email-sender-factory.ts`.** Both
   described the evidence path as live; my change made them wrong, and a wrong comment is
   worse than none. The factory comment additionally carried a `Phase 4` plan-label
   (durable-naming violation), removed with it.

## Concerns and limitations

- **CAVEAT, as the plan requires it stated:** after this change no CI signal asserts
  anything about Resend beyond the mock-backed E2E newsletter flow through `/dev/mailbox`.
  That is the intended, honest state. Recorded re-entry condition: Resend publishes
  test-mode addresses and restricted send-only keys, so a real CI call is buildable later
  on Task 18's exact shape — considered and declined, not overlooked.
- **`email-resend.integration.test.ts` is no longer an integration test.** It now touches no
  database, no Postgres, no external infra — it is a pure unit test on a mocked `fetch` seam,
  still sitting behind an `.integration.test.ts` filename. Renaming it to
  `email-resend.test.ts` was not in scope (the plan's Files list names the current path and
  asks for no rename) and could disturb test-scope allocation, so I left it. Flagging for
  the orchestrator as a cheap follow-up.
- **`@hushbox/api` typecheck is red** until the composition-root ripple is ruled on (above).
  Nothing downstream of this task can go green before then.

## Confidence

**High on the work itself** — every acceptance criterion within my ownership is met and
independently verified: `pnpm test:api` runs to completion with the 7 known-external
snapshot failures as its *only* red (6419 passing), `pnpm test:db` is fully green, lint is
exit-0 on all five touched source files after the final edit, knip finds nothing on them,
and my owned source files are at 100% coverage.

The one thing standing between this task and a green tree is not mine to close:
`@hushbox/api` typecheck is hard-red on the composition-root ripple the plan explicitly
reserved for the orchestrator. Overall status therefore DONE_WITH_CONCERNS, not DONE.
