# Task-23 — impl-report-1

## Objective

Fix two app-side bugs blocking `account-deletion.spec.ts` and close the 2FA deletion-lockout coverage gap:

- **Bug 1 (redirect):** after a successful deletion the modal redirected to `/login` instead of `/welcome`, because `clearLocalAuthState()` (default `reload:true`, since `a4b4483d`) reloads the *current* URL (`/settings`), overriding the pending `/welcome` nav; the reloaded `/settings` re-runs `requireAuth` and bounces to `/login`.
- **Bug 2 (lockout copy):** the modal's `messageFor` only formatted the duration for the dead `DELETE_ACCOUNT_LOCKED` code; the API actually returns `TOO_MANY_ATTEMPTS` + `{retryAfterSeconds}`, so the lockout message fell through to the generic string.
- **Coverage:** the exact e2e 2FA path (valid proof + wrong TOTP ×max → 429) had no integration test.

## Files changed

- `apps/web/src/components/settings/delete-account-modal.tsx` — (a) `runFinishSubmit` now calls `clearLocalAuthState({ reload: false })` (Bug 1); the same-origin `location.href = ROUTES.MARKETING` assignment is itself a full-document navigation that supplies the memory-hygiene guarantee `reload()` provided. (b) `messageFor` now keys the duration-aware `formatLockoutMessage` on the presence of a numeric `retryAfterSeconds` detail rather than on the never-emitted `DELETE_ACCOUNT_LOCKED` code (Bug 2). Comments at both sites updated to record the durable rationale.
- `apps/web/src/components/settings/delete-account-modal.test.tsx` — two new tests (below).
- `apps/api/src/slices/identity/routes.integration.test.ts` — one new 2FA deletion-lockout integration test (coverage gap).

`apps/web/src/lib/auth.ts` was NOT edited — `clearLocalAuthState({ reload })` already supports the opt-out; only the call site changed (per brief).

## Tests added

- `delete-account-modal.test.tsx` — "does not reload the current document after a successful deletion so the /welcome navigation commits": mocks `clearLocalAuthState` to mirror auth.ts's reload semantics; asserts it is called with `{ reload: false }`, `location.href === '/welcome'`, and `location.reload` is NOT called. Covers Bug 1.
- `delete-account-modal.test.tsx` — "formats the lockout countdown when the deletion gate returns TOO_MANY_ATTEMPTS with retryAfterSeconds": `/finish` rejects `TOO_MANY_ATTEMPTS` + `{retryAfterSeconds:600}`; asserts `try again in 10 minutes` renders. Covers Bug 2.
- `routes.integration.test.ts` — "locks out a 2FA account after the registry number of wrong-TOTP deletion attempts": enrolls TOTP, drives `maxAttempts` finishes with valid proof + wrong TOTP (each 400 `INVALID_TOTP_CODE`, since the deletion gate reserves before the TOTP verdict), then the next finish → 429 `TOO_MANY_ATTEMPTS` with numeric positive `retryAfterSeconds`. This is the exact e2e 2FA path; the deletion gate (maxAttempts 3) trips well before the TOTP-verify lockout (maxAttempts 10), verified against `keys.ts`.

## TDD verification

- Bug 1 + Bug 2 modal tests: written first, watched both fail RED for the expected reasons (reload called / clearLocalAuthState not called with `{reload:false}`; generic "please wait" copy instead of "try again in 10 minutes"). Then applied the two source edits → both GREEN.
- API integration test: source already maps `locked → 429 TOO_MANY_ATTEMPTS` (`routes.ts:183-184`, `deletion.ts:176-188`), so this coverage-gap test passed on first run rather than RED→GREEN. Called out explicitly per the brief/research — no source change accompanies it; it closes the missing 2FA-path coverage and guards the wire status.

## Self-gate

- `vitest run delete-account-modal.test.tsx` (apps/web) — pass — 50/50.
- `vitest run routes.integration.test.ts -t "<new 2FA lockout>"` (apps/api) — pass — 1/1.
- `eslint delete-account-modal.tsx delete-account-modal.test.tsx` (from apps/web) — pass — exit 0.
- `eslint routes.integration.test.ts` (from apps/api) — pass — exit 0 (fixed one prettier line-wrap after first run).
- `turbo typecheck --filter=@hushbox/web --filter=@hushbox/api` — pass.
- `jscpd` on the three changed files — 0 clones.
- `pnpm test:web` (full package, coverage gate) — pass — exit 0 (7m17s).
- `vitest run routes.integration.test.ts` (full identity file, apps/api) — pass — 157/157, exit 0.

## Acceptance criteria

1. Bug 1 — redirect lands on `/welcome`: MET. `clearLocalAuthState({ reload: false })` at the call site; unit test pins href=`/welcome` + reload-not-called.
2. Bug 2 — lockout copy on real API shape: MET. `messageFor` keys on `retryAfterSeconds`; unit test asserts formatted lockout copy for `TOO_MANY_ATTEMPTS`.
3. New api integration test (2FA, wrong TOTP ×max → 429 numeric retryAfterSeconds): MET.
4. TDD RED→GREEN at modal + api layers: MET for the two modal source fixes; api test is a coverage-gap test that passes against already-correct source (documented).
5. Proof scoped green; e2e deferred to orchestrator central run: MET (no e2e run performed here).

## Deviations

- The api integration test did not go RED→GREEN because the 429 mapping already exists in source (confirmed by research + `routes.integration.test.ts:2064-2094`). This is the expected shape for a coverage-gap test and is consistent with the brief ("Do NOT invent a status-mapping fix — source already returns 429").

## Concerns and limitations

- Full `pnpm test:api` was not run standalone; instead the full edited identity file (157/157) plus scoped lint/typecheck were run, because ~21 concurrent vitest processes from other agents were competing for local infra. `pnpm test:web` did complete standalone (exit 0). The orchestrator's central run re-gates the whole repo.
- Bug 2's runtime symptom in e2e (400×4 instead of 429) is, per research, a stale-build/redis-carryover artifact — not a source defect. This task fixes the genuine modal-copy defect and adds the missing coverage; the fresh central e2e run is the verification the orchestrator owns.

## Confidence

High — both source fixes are minimal, mechanism-confirmed, and pinned by RED→GREEN unit tests; the api coverage test exercises the exact e2e path and passes against correct source.
