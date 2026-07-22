# T02 — R10: restore 1024-element cap on OPAQUE KE arrays — impl report 1

## Objective
Cap the OPAQUE KE arrays (`ke1`/`ke3`) at 1024 elements to bound parse cost. Delete-account
is legacy-parity; login, password-change, and 2FA-disable are approved consistent hardening.

## Files changed (path — why)
- `apps/api/src/slices/identity/domain/deletion.ts` — `.max(1024)` on `ke1` (:32) and `ke3` (:36). **Parity.**
- `apps/api/src/slices/identity/domain/login.ts` — `.max(1024)` on `ke1` (:35) and `ke3` (:40). **Hardening.**
- `apps/api/src/slices/identity/domain/two-factor-disable.ts` — `.max(1024)` on `ke1` (:24) and `ke3` (:28). **Hardening.**
- `apps/api/src/slices/identity/domain/password-change.ts` — `.max(1024)` on `ke1` (:20) and `ke3` (:25 → line 25 `ke3`). **Hardening.** Only `ke1`/`ke3` capped; the `newRegistrationRequest`/`newRegistrationRecord` arrays left untouched (out of scope per brief: "KE-array schema definitions only").
- `apps/api/src/slices/identity/domain/deletion.test.ts` — added the `delete-account KE-array cap` suite (parity anchor quoted in the docstring).
- `apps/api/src/slices/identity/domain/login.test.ts` — added the `login KE-array cap` suite.
- `apps/api/src/slices/identity/domain/two-factor-disable.test.ts` — new file; `2FA-disable KE-array cap` suite (no prior colocated test).
- `apps/api/src/slices/identity/domain/password-change.test.ts` — new file; `password-change KE-array cap` suite (no prior colocated test).

## Parity vs hardening
- **Parity (legacy-restoring):** delete-account only. Legacy source
  `legacy/apps/api/src/legacy/routes/delete-account.ts:33-41`:
  ```ts
  const MAX_KE_ARRAY_LENGTH = 1024;
  const initSchema = z.object({ ke1: z.array(z.number()).min(1).max(MAX_KE_ARRAY_LENGTH) });
  const finishSchema = z.object({ ke3: z.array(z.number()).min(1).max(MAX_KE_ARRAY_LENGTH), ... });
  ```
  Confirmed by reading the legacy file directly (lines 33, 34, 37, 41). Value = 1024.
- **Hardening (NOT legacy parity):** login, password-change, 2FA-disable. Legacy left these
  uncapped (`legacy/apps/api/src/legacy/routes/opaque-auth.ts:359-427`, no `.max()` anywhere);
  applying the same 1024 cap is founder-ratified DoS-hardening under fail-fast doctrine, per the
  brief's APPROVED SCOPE. Each test docstring states this explicitly so no future reader mistakes
  it for a parity claim.

## NEEDS_CONTEXT trigger check
All four schemas are plain `z.array(z.number()).min(1)` — no transforms, no prior `.max()`.
The trigger ("KE array is not a plain array schema") did not fire; `.max(1024)` applies cleanly.

## TDD (RED → GREEN)
- **RED:** ran all four test files before implementing. Exactly the 8 "rejects 1025" cases failed
  (`expected true to be false` — arrays currently uncapped, so 1025 elements were accepted). The 8
  "accepts 1024" cases and 3 pre-existing tests passed. Failures were for the right reason (missing
  cap), not typos.
- **GREEN:** added `.max(1024)` to the 8 `ke1`/`ke3` definitions; all 19 tests pass.

## Tests added (name — behavior — coverage)
Per schema (delete-account / login / 2FA-disable / password-change), 4 cases each:
- `accepts a ke1 array of exactly 1024 elements` — boundary accept.
- `rejects a ke1 array of 1025 elements` — over-cap reject (the parity/hardening assertion).
- `accepts a ke3 array of exactly 1024 elements` — boundary accept.
- `rejects a ke3 array of 1025 elements` — over-cap reject.

## Self-gate
- `pnpm exec vitest run <4 files>` (from `apps/api`) — pass — 19 passed (4 files).
- `pnpm exec eslint <8 owned files>` (from `apps/api`, after last edit) — pass — exit 0 (one prettier import-wrap error found and fixed in `password-change.test.ts`, then re-run clean).
- `pnpm typecheck` (from `apps/api`) — pass — exit 0.
- Full `pnpm test:api` not run: per plan T18 note, full-coverage `test:api` OOMs (exit 137) in this sandbox; scoped coverage-free run used as evidence instead.

## Acceptance criteria
1. **Delete-account KE schemas capped at 1024 (parity), test rejecting 1025** — MET.
   `deletion.ts:32,36` carry `.max(1024)`; RED-then-GREEN reject-1025 + accept-1024 tests pass.
2. **Same 1024 cap added to login, password-change, 2FA-disable as hardening, each with a rejection test** — MET (approval-gated assumption; founder ratified per brief). Each schema capped; each has reject-1025 + accept-1024 tests.

## Deviations
None. Scope kept to `ke1`/`ke3` only (brief: "KE-array schema definitions only"); password-change's
registration arrays deliberately left uncapped.

## Concerns and limitations
- `keys.ts`/`keys.test.ts` show as modified in `git status` — those are T01's changes (per the
  coordination note), not mine. I edited only the four schema files and their four test files.
- 2FA-disable and password-change had no prior colocated unit test; the new files are additive
  (coverage can only rise). Their non-schema logic is covered by integration tests.

## Confidence
High — mechanical schema cap with the legacy anchor read directly (1024 confirmed), RED-then-GREEN
verified for all 8 reject cases, self-gate green.
