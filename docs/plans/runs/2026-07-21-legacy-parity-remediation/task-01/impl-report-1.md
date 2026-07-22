# Impl report — T01 (R1): delete-account step-up lock trips on 3rd failure

## Objective
Restore the delete-account 24h hard lock so it engages on the **3rd** consecutive failed
step-up (was 4th — off-by-one), and switch the locked response to `403 DELETE_ACCOUNT_LOCKED`
(keeping `retryAfterSeconds` in `details`), scoped to the delete-account gate only — the shared
lockout gate serving login/2FA/recovery must not shift.

## Parity anchor matched
`legacy/apps/api/src/legacy/lib/rate-limit.ts:180` — `if (isLockoutKey && data.count >= config.maxAttempts)`,
with `data.count` the post-increment value and `maxAttempts: 3` (legacy `redis-registry.ts:85-90`).
Legacy records the failure *after* verifying, so the 3rd failed step-up (count → 3, `3 >= 3`) is
the one that fires the lock, and its own response is `403 DELETE_ACCOUNT_LOCKED` with
`retryAfterSeconds` (`legacy/.../routes/delete-account.ts:104-111,180-183,206-208`).

New code uses **reserve-before-verify**: the atomic increment is the gate and it fires *before*
verification, with the shared `evaluateLockout`/`reserveAttempt` semantics "admit exactly
`maxAttempts`, lock the next" (`count > maxAttempts`). To reproduce legacy's "lock on count 3"
under that shared gate without touching it, the delete-account admission budget becomes
`maxAttempts: 2` — the 3rd reserved attempt (`count === 3`) is the one that locks. This is
behaviorally exact for the guessing sequence: submissions 1–2 answer `AUTH_FAILED`, submission 3
answers `403 DELETE_ACCOUNT_LOCKED` (identical to legacy's observed sequence).

## Files changed
- `apps/api/src/slices/identity/domain/keys.ts` — `deleteAccountLockout.rateLimitConfig.maxAttempts` 3→2; comment now explains the reserve-before-verify budget reproduces legacy's `count >= 3`. (dedicated threshold, scoped to this one key — the shared gate is untouched.)
- `apps/api/src/slices/identity/routes.ts` — the delete-account finish `{ kind: 'locked' }` arm now returns `createErrorResponse(ERROR_CODES.DELETE_ACCOUNT_LOCKED, { retryAfterSeconds })` at **403** instead of `tooManyAttemptsResponse` (429 TOO_MANY_ATTEMPTS). Only this arm changed; the login-2FA (`:518`) and 2fa-disable (`:575`) locked arms still use `tooManyAttemptsResponse`.
- `apps/api/src/slices/identity/domain/keys.test.ts` — updated the config assertion (maxAttempts 3→2) and test name; comment documents the reserve-before-verify parity.
- `apps/api/src/slices/identity/routes.integration.test.ts` — new explicit parity test (`engages the delete-account lock on the 3rd consecutive failed step-up`); updated the three existing delete-account locked-response assertions (429 TOO_MANY_ATTEMPTS → 403 DELETE_ACCOUNT_LOCKED), including the already-tripped-TOTP-lockout path which flows through the same arm.
- `apps/web/src/components/settings/delete-account-modal.tsx` — comment-only: the client keys on `retryAfterSeconds` (not the code), so it already renders the lockout countdown; corrected the stale "no DELETE_ACCOUNT_LOCKED code is ever emitted by the API" note.

**Not changed (deliberate):** `deletion.ts` (its comment already asserted the legacy "3 failures engage the hard lock" semantics — the fix makes the code match it; no logic change needed) and `lockout.ts` (the SHARED gate — must not shift login/2FA/recovery).

## Tests added / updated
- Added: `engages the delete-account lock on the 3rd consecutive failed step-up` — hard-codes 2× `AUTH_FAILED` (401) then a 3rd `403 DELETE_ACCOUNT_LOCKED` with `retryAfterSeconds > 0`. Covers acceptance criterion 1. Watched it fail RED against unchanged production code (3rd attempt returned 401, not 403 — the lock did not engage on the 3rd; right reason).
- Updated: the two existing parameterized "locks out after registry number of failed step-ups" tests (password + wrong-TOTP), the hard-lock test, and the already-tripped-TOTP-lockout test — all now assert `403 DELETE_ACCOUNT_LOCKED`. Covers criterion 2 (wire shape) and the scope guard.

## Self-gate
- `vitest run routes.integration.test.ts -t "3rd consecutive failed step-up"` (pre-fix) — **RED** as expected: `expected 401 to be 403` (3rd attempt admitted, lock not engaged).
- `vitest run routes.integration.test.ts` (full identity route suite, post-fix) — **pass, 158/158**. Proves login/2FA/recovery lockout tests unchanged (no threshold shift) alongside the delete-account fix.
- `vitest run identity/domain/keys.test.ts` — **pass, 13/13**.
- `vitest run identity/domain/{lockout,deletion}.integration.test.ts` — **pass, 14/14** (shared gate intact).
- `vitest run web delete-account-modal.test.tsx + use-delete-account.test.ts` — **pass, 56/56**. The client already tests the `DELETE_ACCOUNT_LOCKED`/403 path (renders the countdown) → client path confirmed (criterion 2/scope-guard).
- `eslint` on the 4 owned api files (from `apps/api`) — **exit 0**.
- `eslint` on the owned web file (from `apps/web`) — **exit 0**.
- Typecheck (`turbo typecheck --filter api --filter web`) — package-level **fail**, but every reported error is in a **concurrent task's** files, none in any file I own (see Concerns). My changes typecheck clean.

## Acceptance criteria
1. **Lock engages on the 3rd failed step-up (reserve-before-verify preserved)** — MET. New test proves 2× 401 then 3rd → 403; watched fail RED first for the right reason. `maxAttempts: 2` makes the 3rd reserved attempt (`count === 3`) the one that locks, reproducing legacy `count >= 3`.
2. **Scope guard: shared login/2FA/recovery thresholds not shifted; response is `403 DELETE_ACCOUNT_LOCKED` keeping `retryAfterSeconds`; client still detects lockout** — MET. `lockout.ts`/`evaluateLockout`/`reserveAttempt` untouched; full identity suite (incl. login/2FA/recovery lockout tests) 158/158 green. Only the delete-account finish arm changed to 403 DELETE_ACCOUNT_LOCKED with `retryAfterSeconds` preserved in `details`. Client keys on `retryAfterSeconds` (`delete-account-modal.tsx` `messageFor`), confirmed by existing passing web tests exercising the 403 path.

## Deviations
None from the acceptance criteria. Implementation chose the "dedicated threshold" arm of the
research's `and/or` (change `maxAttempts` fed to the gate) over the "change the comparison" arm,
because the threshold change is fully scoped to the one key and leaves the shared security-critical
gate byte-identical — provably no shift for the other three flows. Documented in-code so the `2`
is not a mystery.

## Concerns and limitations
- **Out-of-scope doc inaccuracy (raise):** `packages/shared/src/error-codes.ts:111-113` and the
  mirroring comment in `error-codes.test.ts:208-210` describe `DELETE_ACCOUNT_LOCKED` (grouped with
  `STORAGE_READ_FAILED`/`INCORRECT_PASSWORD`) as "surfaced only from the web client … never on the
  wire." As of this change `DELETE_ACCOUNT_LOCKED` IS emitted on the wire (403). No test breaks (the
  classification test only checks copy mapping, which is unchanged) — it is a comment-only
  inaccuracy in `packages/shared`, outside T01's ownership. The constant + friendly message already
  exist, so G4 is satisfied.
- **Concurrent-work typecheck failures (raise):** package typecheck fails only on files owned by
  other in-flight tasks — `chat/domain/user-message.integration.test.ts` (`forkId` not on
  `SaveUserOnlyMessageArgs`, T08/R7), `slices/media/domain/gc.ts` (arg-count, T14/R16-area), and
  `middleware/pipeline-bindings.ts` (`ExecutionContext`). Zero errors in any identity file or the
  web modal. Not mine to fix.
- **Local test-DB debris (raise, already handled):** the full identity suite initially showed 2
  failures in unrelated login/2FA-disable "no email" tests (`:1357`, `:3245`) — a `users_email_unique`
  (23505) collision from a persistent leftover `email = ''` user (an interrupted prior run's
  `afterAll` never cleaned it; cleanup is by username-prefix, per-run-random). Confirmed orphaned
  debris (1 row), removed it, and the suite went 158/158. No causal link to the delete-account
  change; flagged because the auditor's full-suite run may re-accumulate this pre-existing
  isolation weakness (a `pnpm db:reset` clears it).

## Confidence
High — behaviorally exact to the legacy guessing sequence, RED-then-GREEN on the new parity test,
full identity suite 158/158 proving no shared-gate shift, and the client path confirmed by existing
web tests. The one judgment call (threshold vs comparison) is the more conservative, provably-scoped
option and is documented in-code.
