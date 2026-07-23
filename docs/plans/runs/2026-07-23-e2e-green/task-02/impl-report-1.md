# Task-02 impl-report-1 — Update stale account-deletion lockout E2E spec (cluster G)

## Objective
Align `e2e/account-deletion.spec.ts` "Rate-limit lockout" test with the current deliberate
deletion-lockout contract: `maxAttempts:2`, locked → `403 DELETE_ACCOUNT_LOCKED` (with
`retryAfterSeconds` detail), replacing the stale `3×400-then-429 TOO_MANY_ATTEMPTS` shape.

## Files changed
- `e2e/account-deletion.spec.ts` — rewrote the lockout test's comment, name, error
  allowlists, loop, and assertions to the current contract. Only file touched.

## Tests added
None added — this is a stale-test alignment. The existing test
`consecutive failed step-ups surface the deletion lockout` (renamed from
`fourth failed attempt surfaces lockout error`) was updated:
- name/behavior — asserts each wrong-TOTP `/finish` returns `400 INVALID_TOTP_CODE` until the
  gate exhausts, then the next reservation returns `403 DELETE_ACCOUNT_LOCKED` with a numeric
  `retryAfterSeconds`, and the modal renders `formatLockoutMessage(retryAfterSeconds)`.
- criterion covered — Task-02 acceptance criteria (all four bullets).

## Self-gate
- `npx prettier --check account-deletion.spec.ts` — pass (All files formatted correctly).
- `npx eslint account-deletion.spec.ts` — pass (0 problems). First run flagged
  `@typescript-eslint/no-unnecessary-condition` on a redundant `&& locked === null` in the
  loop condition; removed it (the `break` already terminates), re-run clean.
- `npx tsgo --noEmit` (whole e2e package) — pass (exit 0).
- Not run (per brief): `pnpm e2e e2e/account-deletion.spec.ts`.

## Acceptance criteria
1. "loops maxAttempts (DERIVED from config, not a literal), each wrong-TOTP `/finish` →
   `400 INVALID_TOTP_CODE`, then next → `403 DELETE_ACCOUNT_LOCKED` (with `retryAfterSeconds`)"
   — **met with a deviation on the derivation mechanism** (see Deviations). The observable
   sequence is exactly `N×400 INVALID_TOTP_CODE` then `403 DELETE_ACCOUNT_LOCKED`; the count is
   discovered from server behavior (loop continues on 400, stops on 403) rather than a literal
   `2`/`3`. Evidence: spec lines 566-593.
2. "`expectApiErrors`/`expectConsoleErrors` updated: 403 not 429, `DELETE_ACCOUNT_LOCKED` not
   `TOO_MANY_ATTEMPTS`" — **met**. Spec lines 548-557; `grep` confirms zero remaining
   `429`/`TOO_MANY_ATTEMPTS` references in the file.
3. "Test name/comments describe current behavior; no stale 'very first'/'4th → 429' language"
   — **met**. Name is `consecutive failed step-ups surface the deletion lockout`; comments
   rewritten (lines 530-542, 561-565, 583-584).
4. "Does NOT edit any identity integration test/setup file" — **met**. Only
   `e2e/account-deletion.spec.ts` in `git status`.

## Match against the committed integration contract (self-gate a)
Committed `routes-deletion.integration.test.ts` (read via `git show HEAD:...`) pins the lock:
`locked.status === 403`, `code === ERROR_CODES.DELETE_ACCOUNT_LOCKED`,
`details.retryAfterSeconds > 0`, and loops `IDENTITY_KEYS.deleteAccountLockout.rateLimitConfig.maxAttempts`.
My spec asserts `403` + `DELETE_ACCOUNT_LOCKED` + `typeof retryAfterSeconds === 'number'` — the
same lock contract. The pre-lock code legitimately differs by path and is plan-specified: the
integration bad-proof path (`ke3:[0,1,2]`) yields `401 AUTH_FAILED`, whereas the only
UI-reachable failure (correct password + wrong TOTP) yields `400 INVALID_TOTP_CODE`. Frontend
render confirmed: `apps/web/src/components/settings/delete-account-modal.tsx:53-58` keys on the
`retryAfterSeconds` detail (not the code) and renders `formatLockoutMessage(...)` for the 403,
so the modal-message assertion stays valid.

## Deviations
- **Derivation mechanism.** The criterion names deriving `maxAttempts` from
  `IDENTITY_KEYS.deleteAccountLockout` config. That symbol lives in
  `apps/api/src/slices/identity/domain/keys.ts`, which the `@hushbox/e2e` package does not
  depend on; importing it transitively pulls `apps/api/src/lib/context` → `factories.js`
  (Neon/Drizzle + Upstash client modules) into the Playwright spec process — heavy,
  runtime-fragile, and a slice-boundary crossing (e2e specs are barred from DB coupling by
  doctrine; `no-restricted-imports(@hushbox/db)`). No lighter shared source of the value
  exists (`@hushbox/shared` has the error code + message, not the count). To satisfy "not a
  literal" without that coupling, the count is discovered from the server: the loop asserts
  `400` and continues until a `403` arrives (bounded at 10 as a broken-lock safety cap). This
  auto-tracks the registry config exactly as intended, just without importing the object.

## Concerns and limitations
- I could not run the e2e itself (per brief), so the two runtime-observable assumptions were
  verified statically instead: (a) `403`'s reason phrase in the api-error line is `Forbidden`
  (fixture builds `${status} ${response.statusText()} ...` at `e2e/fixtures.ts:210`; consistent
  with existing standard phrases `Bad Request`/`Too Many Requests`); (b) the modal renders
  `formatLockoutMessage(retryAfterSeconds)` for the 403 (confirmed at
  `delete-account-modal.tsx:53-58`, and pinned by `delete-account-modal.test.tsx:374`).
- Coordination: at implementation time, `routes-deletion.integration.test.ts` was ABSENT from
  the working tree (the concurrent `2026-07-22-test-suite-parallelism` agent is mid-rename/split
  of the identity integration suite). I read the committed contract via `git show HEAD:...`
  rather than the working copy. No identity integration file was touched.

## Confidence
Medium — the contract alignment is verified against the committed integration test and the
frontend render path, prettier/eslint/typecheck are green, and the behavioral loop is
deterministic. Not high only because the full e2e was not executed (per brief) and the
derivation deviation is a judgment call worth an auditor's eye.
