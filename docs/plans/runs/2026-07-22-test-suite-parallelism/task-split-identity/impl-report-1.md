# impl-report-1 — SPLIT-IDENTITY

## Objective
Split `apps/api/src/slices/identity/routes.integration.test.ts` (158 tests, 28 top-level
describes) into 8 sibling `*.integration.test.ts` files + 1 shared
`routes.integration.setup.ts`, with ZERO behavior change and identical coverage, and fold in
the approved `email=''` test-isolation fix. Refactor, not new behavior.

## Files changed
- `apps/api/src/slices/identity/routes.integration.setup.ts` — NEW. Shared setup extracted
  once: env guard, `db`/`redis`/`testEnv`/`SECRET`, all email/eviction port doubles + their
  `sent*` arrays, `billingStores`, `PREFIX`/`uniqueAccount`, `reclaimRegistry`,
  `deletionPurge`, `manifestDeps`, `createApp`, `post/get/expectStatus`, `KEY_BYTES/KEY_BLOBS`,
  `registerInit/registerAccount`, and every interleaved helper (`loginInit`, `sessionCookieOf`,
  `markVerified`, `loginRoundTrip`, `login`, `fullSessionCookie`, `pendingSessionCookie`,
  `billingSessionCookie`, `unsealClaims`, `NEW_WRAPPED_KEY`, `registerLoginFull`,
  `enrolledFullCookie`, `enrollTotp`, `wrongCode`, `stepUpKe3`). Registers a top-level
  `afterAll` that reclaims identity-owned rows (`users`, `accountDeletionEvents`) + closes the
  per-file db client.
- `routes-registration.integration.test.ts` — NEW (20 tests): registration · input hardening ·
  registration provisioning · registration verification email (D2).
- `routes-login-session.integration.test.ts` — NEW (37 tests): login · logout · billing-only
  session lifecycle · revocation `it.each` matrix (9) · /me bootstrap · principal guards ·
  billing-portal token login.
- `routes-2fa.integration.test.ts` — NEW (20 tests): TOTP enrollment · 2FA disable · TOTP-verify
  lockout · step-up duplicate · login-2FA verify principal gate.
- `routes-recovery-password.integration.test.ts` — NEW (16 tests): password change · recovery ·
  recovery/save.
- `routes-deletion.integration.test.ts` — NEW (17 tests): account-deletion request. Also owns a
  local `afterAll` reclaiming `conversations` (see Deviations).
- `routes-email-verification.integration.test.ts` — NEW (12 tests): email verification ·
  email-verify login gate (D1) · security notification emails (D3). Carries the folded-in
  `email=''` fix.
- `routes-edge.integration.test.ts` — NEW (27 tests): enumeration timing · edge states · more
  edge states · store-outcome and decode edges.
- `routes-redis-unavailable.integration.test.ts` — NEW (9 tests): "Redis unavailability fails
  closed". The `DEAD_REDIS` Proxy / `deadApp()` / `postDead` / `expectUnavailable` helpers
  (Class-2 work) stay inline here, NOT in shared setup, per the brief.
- Original `routes.integration.test.ts` — REMOVED (fully relocated; no stub, no v2 name).

## Two-step self-verification (as briefed)
- **Checkpoint 1 (extraction).** Rewrote the original file to import all shared machinery from
  the new setup module (deleting the moved in-file definitions), then ran it: **158/158 green**
  (~323s). Proves the extraction + the `let`→holder flag change is behavior-preserving before
  fan-out.
- **Checkpoint 2 (fan-out).** Distributed the 28 describes into the 8 files, deleted the
  original, and ran all 8: **158/158 green**. Per-file runtime counts (JSON reporter):
  registration 20, login-session 37, 2fa 20, recovery-password 16, deletion 17,
  email-verification 12, edge 27, redis-unavailable 9 → **sum 158**.

## Mutable-flag adaptation
Two module-scoped `let` toggles (`emailPortShouldFail`, `disabledEmailShouldFail`) cannot be
reassigned across an ES-module import boundary once the ports live in setup. Converted each to a
one-field holder object (`emailPortFailure.shouldFail`, `disabledEmailFailure.shouldFail`) — the
ports read the field; the ~6 test-body assignments were rewritten to set it. Behavior identical
(same `errAsync`/`okAsync` branch).

## Folded-in email='' fix
- `routes-email-verification` › "does not gate an account with no email (guest-origin)" set
  `users.email = ''` with **no** cleanup. Wrapped it in `try/finally` restoring the account's
  unique email, so no orphan `email=''` (globally unique) row survives to poison a concurrent
  file or later run with a 23505.
- The sibling `email=''` test in `routes-2fa` ("disables TOTP without a notification…")
  **already** had the finally-restore (moved verbatim); left unchanged. Reported here so the
  auditor knows only one of the two named tests needed the edit.
- **Proof:** ran each receiving file TWICE back-to-back — `routes-email-verification` 12/12 both
  runs, `routes-2fa` 20/20 both runs; zero `23505` / duplicate-key.

## Self-gate
- `tsc --noEmit -p apps/api/tsconfig.json` — **pass** (no identity errors; no other errors; the
  briefed pipeline-bindings noise did not surface in this run).
- `eslint` (the 8 files + setup) — **pass** (exit 0; two auto/iterated fixes: `PostOptions`,
  `RegisterInitBody`, `SECRET` made module-local to satisfy knip unused-exports; a nested
  template literal hoisted to a local).
- `pnpm arch:check` — **pass** (exit 0, "OK — 11 rules over 1867 files") after moving the
  cross-slice `conversations` cleanup (see Deviations).
- Clean (no-coverage) 8-file run — **158/158**, 40.3s wall (down from ~315s single-file ≈ 7.8×).
- Coverage on production `apps/api/src/slices/identity/routes.ts`, before (reconstructed
  single-file monolith of the same 158 tests) vs after (8 files) — **identical**:
  lines 99.48% (193/194), statements 99.12% (227/229), functions 99.21% (127/128), branches
  98.48% (65/66). Stable across three separate coverage runs.
- Production `routes.ts` / `index.ts` — `git diff` empty (untouched).

## Deviations (with reasons)
1. **Cross-slice `conversations` cleanup relocated.** The original `afterAll` deleted
   `conversations` (owned by the `conversations` slice). In a `*.test.ts` file the
   single-writer-per-table arch rule exempts it; the new shared `routes.integration.setup.ts` is
   NOT a `*.test.ts` file, so the rule flagged the write. Since only `routes-deletion` seeds
   `conversations`, its cleanup now lives in a **local `afterAll` in `routes-deletion`**
   (arch-exempt) while identity-owned cleanup stays shared in setup. Verified vitest runs
   `afterAll` **LIFO** (empirical throwaway test), so the file-local hook (registered later) runs
   BEFORE the setup hook — clearing the membership FK dependents before the `users` delete and
   before the db client closes. `routes-deletion` passes twice back-to-back (17/17). This keeps
   One-Implementation-Shared intact: the conversations cleanup is needed by exactly one file, so
   it belongs there, not in the shared module.
2. **Checkpoint 1 implemented as a scripted, throwaway transform of the original file**, not a
   hand-written one, to avoid transcription error on a 3.3k-line file. It ran 158/158 before I
   fanned out (the briefed checkpoint intent), then was superseded by the 8 files.

## Concerns / limitations
- **Coverage-instrumented 8-file runs flake** (2–21 timeouts across runs; all `Test timed out
  in 15000ms`, zero 23505/assertion failures). This is the plan's documented, out-of-scope
  coverage-JIT + `sequence.concurrent` contention (status item #5, "LANDED but NOT SAFE"). It is
  NOT introduced by this split: the reconstructed single-file monolith ran 158/158 under
  coverage, and the clean (no-coverage) 8-file run is 158/158. `routes.ts` coverage is identical
  regardless (each handler is covered by multiple tests). Raised for the orchestrator because a
  bare `pnpm test:api` (coverage on) may show these pre-existing flaky timeouts.
- The 8 new files + setup appeared already `git add`-staged when I checked `git ls-files`; I
  never ran a state-mutating git command. Working tree on disk is the verified version. Flagged
  as a coordination observation only.

## Confidence
High — extraction proven behavior-preserving at a checkpoint, all 158 tests survive with
identical names/counts, `routes.ts` coverage byte-for-byte unchanged, arch/lint/typecheck green,
the email='' fix proven, and the cross-slice cleanup relocation verified against real vitest
ordering.
