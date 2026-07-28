# Task 18 — impl report 2 (implementation pass, DONE_WITH_CONCERNS)

## Objective

Prove the FCM send path against Google with a real, CI-gated, `validate_only`
two-leg call, and make the `push-fcm` service-evidence row honest — written only
after that real call succeeded, never by a mocked seam.

Both blockers from impl-report-1 arrived ruled (Option A on the dead `db`
parameter; corrected F2 for the credential route), so this pass implemented the
shape already recorded there.

## Files changed

- `apps/api/src/slices/notifications/adapters/push-fcm.ts` — added
  `validateOnly` config flag (top-level `validate_only` sibling of `message`);
  removed the evidence write and the now-dead `db`/`isCI` config fields and their
  imports.
- `apps/api/src/slices/notifications/adapters/push-fcm.test.ts` — added the two
  body-shape tests; deleted the three mocked evidence-write tests and the now-unused
  `Database` type import.
- `apps/api/src/slices/notifications/adapters/push-fcm-live.integration.test.ts`
  (new) — the CI-gated real call plus `deriveFcmLiveGate` and its four unit tests.
- `apps/api/src/slices/notifications/adapters/push-fcm.integration.test.ts`
  (deleted) — its only test fabricated an evidence row behind a mocked
  `fetchImpl`; that is exactly the dishonesty F1 forbids.
- `apps/api/src/slices/notifications/adapters/push-sender-factory.ts` — stopped
  passing `db`/`isCI` into the FCM adapter; dropped the trailing `db` parameter
  (Option A) and the `Database` import.
- `apps/api/src/adapters/push-notify.ts` — call site updated to the one-argument
  factory (`db` is still used there for the token and preference stores).
- `apps/api/src/slices/notifications/adapters/push-sender-factory.test.ts`,
  `apps/api/src/slices/notifications/adapters/device-token-retention.integration.test.ts`,
  `apps/api/src/platform/dev/routes.integration.test.ts` — call sites updated;
  `stubDb` deleted where it existed only to feed that parameter.
- `packages/shared/src/env.config.ts` — the two CiVitest-only registry entries +
  their optional Zod lines (corrected F2).
- `.github/workflows/ci.yml` — the generated `vitest-env` block (written by
  `pnpm generate:env`, not by hand) + narrowed the mocked-seam comment to Resend.
- `scripts/generate-env.test.ts` — seeds the two new CiVitest secrets in the
  ciVitest `beforeEach`/`afterEach`, so its "throws when LINEAR_API_KEY_READ is
  missing" test still isolates the variable it names instead of throwing for
  three reasons at once.

`apps/api/src/slices/notifications/index.ts:53` needed no edit: it re-exports the
symbol without restating a signature, so the arity change flows through the type.

## Tests added

- `push-fcm.test.ts` — *asks FCM to validate without delivering when configured
  validate-only*: `validate_only: true` appears as a top-level key in the send
  body (criterion 1, flag-on half).
- `push-fcm.test.ts` — *omits the validate-only key entirely from an ordinary
  send*: `'validate_only' in body === false`, the pin that production stays
  byte-identical (criterion 1, pin half).
- `push-fcm-live.integration.test.ts` — four `deriveFcmLiveGate` unit tests
  (local shell with credentials, CI-E2E, CI-vitest without credentials,
  CI-vitest with credentials) — criterion 4.
- `push-fcm-live.integration.test.ts` — *exchanges a real service-account JWT
  and reaches FCM with a well-formed send*: criteria 2, 3 and 5 (evidence write
  is its last statement).

### TDD sequence actually run

1. RED on the flag-on body test: `AssertionError: expected undefined to be true`
   at `push-fcm.test.ts:154` — the key was absent because the feature did not
   exist. GREEN after adding `validateOnly` to the adapter.
   The absence pin is a characterization/regression test by nature: it asserts
   the behavior that must NOT change, so it passed on first run by construction.
2. RED on the gate tests: `ReferenceError: deriveFcmLiveGate is not defined`
   (4 failed). GREEN after defining the function.
3. Deletions (evidence write, mocked evidence tests, `db` parameter) are
   removals, not new behavior — verified by the suites staying green and by
   typecheck finding every call site.

## Self-gate

| command | result |
| --- | --- |
| `pnpm test:api` (runs under `--coverage`) | fail — 467 files passed, 1 failed, 6427 tests passed, 7 failed. The single failing file is `src/slices/notifications/domain/templates/template-html.test.ts` (email-template HTML snapshots). Not mine — attribution below. No coverage-threshold failure. |
| `apps/api`: `npx eslint <all owned files>` after the LAST edit | pass (exit 0) |
| `apps/api`: `npx tsgo --noEmit` | fail — only `src/slices/models/domain/trial-smart-model-candidates.test.ts` (4× `TS2554: Expected 2 arguments, but got 3`). Concurrent workstream — attribution below. Clean run at 00:1x, before that workstream's edit landed. |
| `packages/shared`: `npx tsgo --noEmit` | pass |
| `scripts`: `npx tsgo --noEmit`, `npx eslint generate-env.test.ts` | pass |
| `pnpm test:watch scripts/generate-env.test.ts` | fail — 112 passed, 1 failed: `updateWorkflows > verify-secrets section > generates for loop with all backend secret keys`. Pre-existing at HEAD — attribution below. |
| `pnpm test:watch` on push-fcm / push-sender-factory / push-fcm-live | pass — 39 passed, 1 skipped |
| `pnpm test:watch` device-token-retention.integration | pass — 4 passed |
| `pnpm test:watch` platform/dev/routes.integration | pass — 68 passed |
| `pnpm prettier --check .github/workflows/ci.yml` | pass |
| `pnpm gitleaks detect --no-git` over my five owned adapter files | pass — 0 findings |

### Failure attribution

**`template-html.test.ts` (7 snapshot failures) — not mine.** Reproduces in
isolation (`npx vitest run src/slices/notifications/domain/templates/template-html.test.ts`
→ 7 failed) on files I never opened. `git status` reports both the test and its
`__snapshots__/template-html.test.ts.snap` unmodified against HEAD, so the
mismatch exists at HEAD. Nothing in my diff is in that file's import graph
(email templates; my changes are push adapters, env registry, CI workflow).

**`trial-smart-model-candidates.test.ts` (4 typecheck errors) — concurrent
workstream.** `apps/api` typechecked clean earlier in this session, after all my
`apps/api` edits were already in place. The errors are arity mismatches against
`trial-smart-model-candidates.ts`, which `git status` shows as modified by
another agent (alongside `packages/shared/src/affordability/**`) while I worked.

**`generate-env.test.ts` verify-secrets failure — pre-existing, and a real
CI-blocking red belonging to this run.** The test's expected production
secret list omits `VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY NOTIFICATION_TAG_SECRET`,
which an earlier notifications task added to `env.config.ts` as `Mode.Production`
secrets. `git diff packages/shared/src/env.config.ts` shows my hunks are the
only working-tree change to that file, so those entries are at HEAD and the
stale expectation is at HEAD too. My own entries are provably not implicated:
they carry no `Mode.Production` value, and the received string in the failure
diff contains no `FCM_*_CI` name. Fix is a one-line expected-string update in
`scripts/generate-env.test.ts:760`; I did not make it — it is another task's
regression to own.

**gitleaks over the whole notifications adapters directory reports 6 findings,
all in Task 19 / webpush files** (`webpush/__tests__/rfc8291-decryptor.test.ts`,
`webpush/send.test.ts`, `webpush/encrypt.test.ts`, `webpush/vapid.test.ts`,
`push-webpush.test.ts`) — untouched by me, flagged for Task 19's allowlist work.

## Acceptance criteria

**1. `push-fcm.ts` supports validate-only send; production byte-identical; the
default body contains no `validate_only` key — met.**
Both bodies captured by driving the real adapter through a stub `fetchImpl`:

```
DEFAULT:  {"message":{"token":"tok","notification":{"title":"New message","body":"You have a new message."},"data":{"category":"message","conversationId":"018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60"},"android":{"collapse_key":"alias-abc","notification":{"tag":"018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60"}},"apns":{"headers":{"apns-collapse-id":"alias-abc"}}}}
VALIDATE: {"message":{"token":"tok","notification":{"title":"New message","body":"You have a new message."},"data":{"category":"message","conversationId":"018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60"},"android":{"collapse_key":"alias-abc","notification":{"tag":"018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60"}},"apns":{"headers":{"apns-collapse-id":"alias-abc"}}},"validate_only":true}
```

The default body is the same bytes it was before this task; the flag adds one
top-level snake_case key and nothing else. Implementation:

```ts
...(config.validateOnly === true ? { validate_only: true } : {}),
```

**2. One CI-gated integration test makes the real two-leg call with the required
assertions — met in code, unexecutable here (ruling R-B).**
OAuth leg: `expect(leg?.url).toBe('https://oauth2.googleapis.com/token')` and
`expect(typeof accessToken).toBe('string')` — the token value is never printed
or asserted on. Send leg: URL pinned to
`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
`expect(sendLeg?.status).not.toBe(401)`, then EITHER a non-empty `name` string
OR a `details[]` carrying an `@type` ending in `google.firebase.fcm.v1.FcmError`
or `google.rpc.BadRequest`. No specific status, errorCode, or success
placeholder is asserted (F3).

**3. The classifier is asserted against Google's real error body — met.**
The capturing `fetchImpl` delegates to the real `fetch` and clones each
response, so the body handed to `collectFcmErrorCodes(body?.error)` is
literally Google's, not a fixture this test authored:

```ts
expect(collectFcmErrorCodes(body?.error).length).toBeGreaterThan(0);
```

**4. Gating follows `deriveLinearGate` exactly — met.** One
`createEnvUtilities()` derivation for the harness, a named pure function, four
unit tests, `describe.skipIf`:

```ts
/** CI-vitest (CI, not E2E) with the credentials — the only shell that calls Google. */
function deriveFcmLiveGate(envUtilities: EnvUtilities, hasCredentials: boolean): boolean {
  return envUtilities.isCI && !envUtilities.isE2E && hasCredentials;
}

const projectId = process.env['FCM_PROJECT_ID_CI'];
const serviceAccountJson = process.env['FCM_SERVICE_ACCOUNT_JSON_CI'];
const HAS_CREDENTIALS =
  projectId !== undefined &&
  projectId.length > 0 &&
  serviceAccountJson !== undefined &&
  serviceAccountJson.length > 0;

const AMBIENT_ENV = createEnvUtilities(readEnv());
const shouldRun = deriveFcmLiveGate(AMBIENT_ENV, HAS_CREDENTIALS);
```

with

```ts
describe('deriveFcmLiveGate', () => {
  it('refuses a local vitest shell even with the credentials present', () => {
    expect(
      deriveFcmLiveGate(createEnvUtilities({ NODE_ENV: 'development', VITEST: 'true' }), true)
    ).toBe(false);
  });

  it('refuses a CI-E2E shell', () => {
    expect(
      deriveFcmLiveGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', E2E: 'true', VITEST: 'true' }),
        true
      )
    ).toBe(false);
  });

  it('refuses CI-vitest without the credentials (skip — verify:evidence is the loud guard)', () => {
    expect(
      deriveFcmLiveGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' }),
        false
      )
    ).toBe(false);
  });

  it('admits only CI-vitest with the credentials', () => {
    expect(
      deriveFcmLiveGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' }),
        true
      )
    ).toBe(true);
  });
});
```

Skip proven twice, both without the credential — locally, and in a CI-shaped
shell (`CI=true npx vitest run …`), which is the case that matters because it is
the one that must not fail the CI job:

```
 RUN  v4.1.8 /workspace/popper-mobile/.superset/projects/HushBox/apps/api

 Test Files  1 passed (1)
      Tests  4 passed | 1 skipped (5)
   Start at  00:14:18
   Duration  1.29s
```

**5. Evidence recorded as the last statement, only if every assertion passed —
met.**

```ts
await recordServiceEvidence(db, AMBIENT_ENV.isCI, SERVICE_NAMES.PUSH_FCM, {
  sendStatus: sendLeg?.status ?? 0,
  validateOnly: true,
});
```

**6. Evidence write removed from `push-fcm.ts`; dead config fields dropped —
met.** Removed code:

```ts
    if (config.db !== undefined && successCount > 0) {
      await recordServiceEvidence(config.db, config.isCI ?? false, SERVICE_NAMES.PUSH_FCM, {
        successCount,
        failureCount,
      });
    }
```

and the config fields it read:

```ts
  /** Evidence writes go through `recordServiceEvidence` (CI-only inside). */
  readonly db?: Database;
  readonly isCI?: boolean;
```

The mocked evidence test in `push-fcm.integration.test.ts` is deleted — the
whole file is gone, because that test ("lands a real push-fcm evidence row after
a successful CI send", with `fetchImpl` mocked) was its only test. The three
mocked evidence unit tests in `push-fcm.test.ts` are deleted too. Dead-token
behavior that the third of them incidentally covered stays pinned by "reports an
UNREGISTERED token as dead and leaves a delivered one alone" and by the
`collectFcmErrorCodes` string-form test.

**7. Credentials reach the test process through registry entries; no
`turbo.json` change; no hand-edited `ci.yml` env — met.** Registry entries:

```ts
  // FCM credentials for the CI-only live send test, deliberately SEPARATE from
  // the production FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT_JSON so the production
  // credential is never something CI reads. The service account behind these
  // holds exactly `cloudmessaging.messages.create`, and the test it feeds sends
  // `validate_only`, so nothing reaches a device. CiVitest only: no Development
  // entry (local dev never calls Google), and production has its own vars.
  FCM_PROJECT_ID_CI: {
    to: [Destination.Backend],
    [Mode.CiVitest]: secret('FCM_PROJECT_ID_CI'),
  },

  FCM_SERVICE_ACCOUNT_JSON_CI: {
    to: [Destination.Backend],
    [Mode.CiVitest]: secret('FCM_SERVICE_ACCOUNT_JSON_CI'),
  },
```

Zod lines:

```ts
  FCM_PROJECT_ID_CI: z.string().min(1).optional(),
  FCM_SERVICE_ACCOUNT_JSON_CI: z.string().min(1).optional(),
```

`pnpm generate:env` then produced exactly this `ci.yml` diff and nothing else
(`git diff --stat` shows `.github/workflows/ci.yml | 2 +`; the other three
workflow files it rewrote came out identical):

```diff
@@ -140,6 +140,8 @@ jobs:
         env:
           OPENROUTER_API_KEY_RESTRICTED: ${{ secrets.OPENROUTER_API_KEY_RESTRICTED }}
           LINEAR_API_KEY_READ: ${{ secrets.LINEAR_API_KEY_READ }}
+          FCM_PROJECT_ID_CI: ${{ secrets.FCM_PROJECT_ID_CI }}
+          FCM_SERVICE_ACCOUNT_JSON_CI: ${{ secrets.FCM_SERVICE_ACCOUNT_JSON_CI }}
         # END GENERATED: vitest-env
```

`turbo.json` untouched. The `--require=push-fcm` step is unchanged.

Local dev unaffected, as the ruling required:

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

$ grep -c 'FCM_PROJECT_ID_CI\|FCM_SERVICE_ACCOUNT_JSON_CI' .env.development apps/api/.dev.vars apps/api/wrangler.toml
.env.development:0
apps/api/wrangler.toml:0
apps/api/.dev.vars:0

$ pnpm verify:env --mode=development
✓ All environment verifications passed
```

And the intended loud failure, unsoftened:

```
$ pnpm generate:env --mode=ciVitest
Error: Missing required secrets in process.env: OPENROUTER_API_KEY_RESTRICTED, LINEAR_API_KEY_READ, FCM_PROJECT_ID_CI, FCM_SERVICE_ACCOUNT_JSON_CI
```

(That command already failed on the first two before this task — the new names
join an existing failure mode rather than creating one.)

**8. The `ci.yml:222-224` comment narrowed, not deleted — met.** The Resend step
and the Resend half of the comment are untouched for Task 22:

```yaml
      # Resend has no CI sandbox, so this asserts the real adapter
      # send-and-record code path ran (against a mocked HTTP seam), not a live
      # provider call. Founder-verify/CI-pending: a real Resend sandbox call.
      - name: Verify Resend was called
        run: pnpm verify:evidence --require=resend
      # FCM is a real call: the live test authenticates against Google and
      # posts a validate-only send, and writes the row only after it succeeds.
      - name: Verify FCM push was called
        run: pnpm verify:evidence --require=push-fcm
```

**9. Not on the hot test path — met.** The live call lives in
`*.integration.test.ts` and its `describe` is `skipIf`-gated; locally only the
four gate unit tests execute (proven above: 4 passed, 1 skipped).

## Deviations with reasons

- **`apps/api/src/platform/dev/routes.integration.test.ts` (3 call sites) and
  `scripts/generate-env.test.ts` are edited although the plan's Files list names
  neither.** Both are orphans my change created: the first would not compile
  against the one-argument factory; the second would have kept passing for the
  wrong reason (its named variable was no longer the only missing secret).
  Neither is owned by Task 19 (`webpush/**`) or Task 20 (`e2e/**`), so the
  declared NEEDS_CONTEXT trigger did not fire.
- **The live test's assertions are split into two helper functions**
  (`expectOAuthAccepted`, `expectFcmVerdict`) rather than living inline. Inline,
  the `it` body tripped `complexity 16 > 10`; splitting was the fix that did not
  weaken an assertion.
- **`requestUrl()` instead of `String(input)`** in the capturing fetch —
  `@typescript-eslint/no-base-to-string` correctly rejects stringifying
  `RequestInfo | URL`.

## Concerns and limitations

- **The real call has still never executed** (ruling R-B): no agent may hold the
  credential. What is proven here is that the gate skips cleanly without it and
  that the request shape is what F3 documents. The OAuth/JWT/scope/project-id
  proof arrives in the founder's first CI run after the two GitHub secrets exist.
- **Until those secrets exist, the CI `test` job fails at the "Generate
  environment files" step**, before tests run — earlier and louder than the old
  silent-skip failure mode, and exactly what F2 called the accepted consequence.
  It is not a regression introduced by a bug.
- **What this proves and does not:** OAuth exchange with a real RSA key, scope,
  project id, request shape, and our error classifier against a real Google
  error body. NOT delivery to a device — `validate_only` stops short of that by
  design, and nothing in this repo can prove device delivery.
- **A single genuine branch in the live test** (200-with-`name` vs error body)
  is unavoidable: F3 explicitly forbids asserting which one FCM returns for a
  fabricated token.
- The `generate-env.test.ts` verify-secrets red is a real CI-DAG blocker for
  this run that nobody currently owns; see attribution above.

## Confidence

**High** on everything executable here: every claim above was run this session
(RED and GREEN observed per behavior, bodies captured from the real adapter,
generate:env run in both modes, skip proven in a CI-shaped shell, lint/typecheck
run from the package directories after the last edit).

**Medium** on the one thing that cannot be executed: whether Google's live
response satisfies the shape assertions on the first CI run. The risk is
concentrated in the error-detail assertion — if FCM returns an error body whose
`details[]` is absent or carries only an unlisted `@type`, the test fails on a
real, successful call. That is F3's documented taxonomy and it is asserted
loosely (suffix match, either type, no status), but it is the assertion most
likely to need one adjustment after the founder's first run.
