# impl-report-1 — split routes-2fa.integration.test.ts

## Objective

Split the ~160s coverage-pole `apps/api/src/slices/identity/routes-2fa.integration.test.ts`
(20 tests, 5 describes) into 2 cohesive sibling files importing the UNCHANGED
`./routes.integration.setup.ts`, to parallelize. Behavior-preserving; coverage unchanged.

## Files changed

- `apps/api/src/slices/identity/routes-2fa.integration.test.ts` — (name reused) now holds
  file A: "TOTP enrollment and login 2FA" (6) + "TOTP-verify lockout" (2) + "login 2FA
  verify principal gate" (3) = **11 tests**. Removed the two disable/step-up describes and
  pruned the imports they alone used (OPAQUE_SERVER_IDENTIFIER, createOpaqueClient,
  finishLogin, startLogin, DELETE_ACCOUNT_CONFIRMATION_PHRASE, disabledEmailFailure,
  loginInit, sentTwoFactorDisabled, stepUpKe3).
- `apps/api/src/slices/identity/routes-2fa-disable.integration.test.ts` — (new) file B:
  "2FA disable (step-up + code)" (7) + "step-up duplicate and well-formed bad proof" (2)
  = **9 tests**. The `disableInit` helper and the two describes moved verbatim; imports
  scoped to exactly what B uses.

Split axis: 2 balanced files, each describe kept whole. Total 11 + 9 = 20, unchanged.

## email='' isolation fix

The test "disables TOTP without a notification when the account has no email" (writes
`users.email=''`, restores a unique email in a `finally`) lives in the "2FA disable"
describe, so it moved into file B (`routes-2fa-disable.integration.test.ts`) verbatim,
including its `finally` cleanup that restores `account.email`. Cleanup not dropped.

## Self-gate

- `pnpm ensure-stack` — pass.
- `tsx scripts/with-env.ts vitest run --root apps/api <both files>` — **pass, 2 files,
  20 tests** (11 + 9), CLEAN, 16.58s wall (vs ~160s serial original).
- Receiving-file (file B) twice back-to-back — **pass both runs, 9 tests each, no 23505**
  orphan-row poisoning. The email='' finally-restore holds under repeat.
- `pnpm exec eslint <both files>` — pass (exit 0).
- `tsgo --noEmit` (full api package, fresh, no cache) — pass (exit 0, 0 TS errors; none
  in my files).

### turbo typecheck lint --filter=@hushbox/api

- typecheck — pass (cache hit; re-verified fresh via direct `tsgo --noEmit`, 0 errors).
- lint — FAILED with `ENOENT ... routes-deletion.integration.test.ts`. Attributed to
  CONCURRENT sibling work, not this task: `git status` shows `D routes-deletion.integration.test.ts`
  plus new `routes-deletion-execute/-gate`, `routes-revocation`, `routes-timing-store`,
  and mods to `routes-edge`/`routes-login-session` — none of which this task touched.
  ESLint is reading a stale/deleted file from another in-flight split. My two files lint
  clean in isolation (exit 0). Not fixed (out of ownership). The brief's expected
  "pre-existing pipeline-bindings error" did not surface — typecheck was clean.

## Acceptance criteria

- Split into 2 cohesive sibling files, describes intact — met (file A 11, file B 9).
- Each imports the UNCHANGED setup — met (`routes.integration.setup.ts` not modified;
  git status shows no change to it).
- Behavior-preserving, counts sum to 20 — met (20 passed).
- email='' fix + finally moved verbatim, cleanup not dropped — met (in file B).
- Receiving file twice-back-to-back, no 23505 — met.
- Durable cohesive names matching `routes-<topic>.integration.test.ts` — met
  (`routes-2fa` + `routes-2fa-disable`).
- Original removed since name reused; nothing dropped — met (file A is the reused name,
  edited in place; no test lost).
- Clean imports — met (each file imports only what it uses; eslint clean).

## Deviations

None.

## Concerns and limitations

- The package-level `turbo ... lint` gate currently fails due to concurrent sibling
  splits mid-flight in the same identity slice (deleted `routes-deletion.integration.test.ts`).
  This resolves once those siblings land; it is not caused by and cannot be fixed within
  this task. Orchestrator should run the package lint gate after all identity splits
  complete.

## Confidence

high — 20/20 green in parallel, file B clean twice with no 23505, my files pass eslint and
tsgo in isolation; the only red gate is provably concurrent-sibling ENOENT.
