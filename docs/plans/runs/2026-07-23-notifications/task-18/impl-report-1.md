# Task 18 — impl report 1 (NEEDS_CONTEXT, no edits made)

## Objective

Prove the FCM send path against Google (real CI-gated two-leg call, validate-only) and
make the `push-fcm` service-evidence row honest (delete the mocked evidence write and its
test).

## Status

**NEEDS_CONTEXT — zero files edited.** `git status` is byte-identical to the snapshot taken
before I started; the only path I created is this report's directory. Two load-bearing
questions must be answered before any code lands. One is a NEEDS_CONTEXT trigger the brief
named explicitly; the other is a plan criterion that, as literally written, cannot work in
this repo (verified empirically, below).

Everything else in Task 18 is unambiguous and ready to implement the moment these are
ruled; the intended shape is recorded at the end of this report so the follow-up pass is
mechanical.

---

## Blocker 1 (declared trigger) — dropping `db`/`isCI` DOES ripple into the composition root

The criterion: *"remove the evidence write from `push-fcm.ts` itself … Drop the now-unused
`db`/`isCI` config fields if nothing else uses them; if the factory passes them, update
it."*

Measured blast radius (Verified — grep, this session):

- `apps/api/src/slices/notifications/adapters/push-fcm.ts:285-290` — the only evidence
  write; the only reader of `config.db` / `config.isCI`.
- `apps/api/src/slices/notifications/adapters/push-sender-factory.ts:104-109` — the only
  producer, passing `db` and `isCI` into `createFcmPushSender`.
- After that call stops taking `db`, the `db` parameter of
  `createPushSenderFromEnv(env: PushSenderEnv, db: Database)` becomes dead. It is the
  **trailing** parameter and the ESLint config runs
  `unused-imports/no-unused-vars` with `args: 'after-used'`
  (`packages/config/eslint.config.js:207-215`), so a dead trailing param is a **lint error**,
  not a warning. It cannot simply be left in place.

That forces a binary, and both branches hit the brief's stop trigger:

- **Option A — drop the parameter** (`createPushSenderFromEnv(env)`).
  Ripples to: `apps/api/src/adapters/push-notify.ts:44` (composition root, one line — `db`
  stays live there for the store factories, so nothing else changes), plus ~12 call sites
  across `push-sender-factory.test.ts` and
  `device-token-retention.integration.test.ts:164` and their `stubDb`.
  Also changes an **exported barrel signature** —
  `apps/api/src/slices/notifications/index.ts:53` re-exports `createPushSenderFromEnv`
  (consumers are all inside `apps/api`; nothing outside the app imports it).
  This is what AGENT-RULES §Surgical Changes ("remove orphans YOUR changes made unused")
  and CODE-RULES (no dead code) point at, and it is the option I would pick if it were
  mine to pick.
- **Option B — keep the parameter, rename to `_db`.** No ripple at all; ships a knowingly
  dead parameter that an auditor should flag.

Neither is a guess I am willing to make: the brief lists *"ripples beyond
`push-sender-factory.ts` into the composition root or changes a shared factory
signature"* as a stop-and-ask trigger, and Option A does both.

**One-line ruling needed:** Option A (and may I edit `apps/api/src/adapters/push-notify.ts`
+ the three test files, which the plan's Files list does not name) or Option B.

---

## Blocker 2 (plan criterion cannot work as written) — turbo strict env mode strips raw job env vars

The criterion: *"`ci.yml` passes the two credentials as raw job env vars on the `test` job,
alongside `LINEAR_API_KEY_READ`"* + *"Credentials read from `process.env` directly. NO new
`env.config.ts` entry."*

Those two halves are mutually unsatisfiable in this repo as it stands.

**Verified — turbo runs in strict env mode and does not forward undeclared vars.**

- `turbo.json` sets no `envMode`, and `turbo run test --dry=json` reports
  `envMode: strict` with the `test` task's `specified/configured/passthrough` all empty
  except `passThroughEnv: ["HB_TEST_SCOPE"]`.
- `turbo run --help`: *"strict: Filter environment variables to only those that are
  specified in the `env` and `globalEnv` keys in turbo.json"*.
- Empirical probe (this session, no repo files touched):

  ```
  $ HB_PKG_NAME=envprobe HB_TEST_SCOPE=probe npx turbo run test --filter=@hushbox/config --force
  @hushbox/config:test: [config] scope=solo · work-share=solo · workers=24
  ```

  `HB_PKG_NAME` is read by `scripts/run-package-tests.ts:298-300` and printed in that line.
  It printed `[config]` (the cwd-derived fallback), not `envprobe` — the undeclared var
  was stripped by turbo before the task ran. `HB_TEST_SCOPE`, which *is* declared in
  `passThroughEnv`, did reach it.

**Why `LINEAR_API_KEY_READ` is not the precedent the criterion assumes.** It does *not*
reach vitest as a raw job env var. `ci.yml:139-143` passes it to the **`pnpm generate:env`**
step only; it is an `env.config.ts` registry entry with
`[Mode.CiVitest]: secret('LINEAR_API_KEY_READ')` and `to: [Destination.Backend]`
(`packages/shared/src/env.config.ts:473-477`), so `generate-env.ts` writes it into
`apps/api/.dev.vars`, and the api package's own test script re-loads that file
(`apps/api/package.json` → `scripts/with-env.ts`, whose `ENV_FILES` includes
`apps/api/.dev.vars`). The `.dev.vars` route is the *only* reason `process.env` sees it
inside the test process — and that route is exactly the `secret()`-for-CI-mode route F2
forbids for FCM.

**Consequence:** with only the `ci.yml` edit the plan names, the live suite would skip in
CI, no evidence row would be written, and `verify:evidence --require=push-fcm` would fail
the founder's CI run — indistinguishable from a missing credential, which would send the
diagnosis in the wrong direction.

**The minimal fix** (recommended): add the two names to the `test` task's
`passThroughEnv` in `turbo.json`:

```jsonc
"passThroughEnv": ["HB_TEST_SCOPE", "FCM_PROJECT_ID_CI", "FCM_SERVICE_ACCOUNT_JSON_CI"]
```

`passThroughEnv` (not `env`) is right by turbo.json's own documented distinction: the value
supplies the task without entering the cache hash — it determines *whether the real call
runs*, not any build artifact, and CI's test step already sets `TURBO_FORCE: true`.

`turbo.json` is a repo-root config file **not** in the plan's Files list, and it is shared
with every other workstream — so it needs an explicit go-ahead, and the orchestrator may
want to know for concurrency reasons (Tasks 19/20 own `webpush/**` and `e2e/**`; neither
touches `turbo.json`, so I see no collision).

**Ruling needed:** may I add those two names to `turbo.json`'s `test.passThroughEnv`, or
does the orchestrator prefer another route (e.g. accepting a differently-shaped credential
delivery)?

---

## What is unambiguous and ready to write (recorded so the next pass is mechanical)

- `push-fcm.ts`: `validateOnly?: boolean` on `FcmPushSenderConfig`; body becomes
  `{ message: {...}, ...(validateOnly ? { validate_only: true } : {}) }` — top-level
  snake_case sibling of `message` per F3, absent entirely when the flag is off.
  Config-level flag rather than a `PushMessage` field, so the shared `PushSender` port
  (Task 03/04's I4 contract) is not widened.
- `push-fcm.test.ts`: pin "default body has no `validate_only` key" (`expect('validate_only'
  in body).toBe(false)` over the parsed default body); pin the flag-on body shape; delete
  the three evidence-write tests (`push-fcm.test.ts:332-395`), which die with the feature.
- New `push-fcm-live.integration.test.ts`: named pure `deriveFcmLiveGate(envUtilities,
  hasCredentials)` = `isCI && !isE2E && hasCredentials`, four unit tests mirroring
  `linear-real.integration.test.ts:54-87`, `describe.skipIf(!shouldRun)`, credentials read
  from `process.env['FCM_PROJECT_ID_CI'] / ['FCM_SERVICE_ACCOUNT_JSON_CI']`. The real call
  drives the **adapter** (`createFcmPushSender` with `validateOnly: true` and a fabricated
  token) through a capturing `fetchImpl` that delegates to real `fetch` and retains clones
  of both legs' bodies — so the OAuth leg and the send leg are the adapter's own code, and
  `collectFcmErrorCodes` is fed Google's actual error object rather than a fixture the test
  authored. `recordServiceEvidence(db, isCI, SERVICE_NAMES.PUSH_FCM)` as the last statement.
- `push-fcm.integration.test.ts`: the row-fabricating test is the file's only test, so the
  whole file goes (its `beforeAll` keypair setup and db handle exist solely to serve it).
- `ci.yml`: two credentials on the **`Run tests`** step's `env:` block (alongside
  `TURBO_FORCE`), *not* inside the `# BEGIN GENERATED: vitest-env` block at lines 139-143 —
  that block is rewritten by `scripts/generate-env.ts:530` on every `pnpm generate:env`, so
  a hand edit there would be silently reverted by the pre-commit hook. `--require=push-fcm`
  step untouched. Comment at `ci.yml:222-224` narrowed to Resend only, leaving the Resend
  half exactly as-is for Task 22.

## Self-gate

Not run — no edits were made, so there is nothing of mine to gate.

## Acceptance criteria

All — **not met** (no implementation attempted; blocked on the two rulings above).

## Concerns and limitations

- Per founder ruling R-B, the real two-leg call cannot be executed here: the credential
  exists in no agent environment and AGENT-RULES forbids agents touching production
  credentials. The plan already accounts for this — proof arrives in the founder's CI run.
- Blocker 2 means the current plan text would produce a *green implementation with a red
  CI*, which is worse than either a clean skip or a clean pass; it is worth ruling before
  code lands rather than after.

## Confidence

n/a — no implementation to be confident about. Confidence in the two findings themselves is
**high**: both were verified by execution this session (ESLint config read, turbo dry-run
plus the `HB_PKG_NAME` probe), not inferred.
