# Account-deletion app defects — e2e-green root-cause

Scope: 2 defects behind ~30 `account-deletion.spec.ts` failures. Read-only diagnosis; no source/test/config edits.
Evidence run: `e2e/report/2026-07-20T07-58-51` (Task-01's 30-failure run).

---

## BUG 1 — post-deletion redirect lands on `/login` instead of `/welcome` (24 failures)

**Verdict: genuine app regression (web).** Introduced by commit `a4b4483d` ("audit remediation fixes").

### Root cause
`delete-account-modal.tsx` post-`/finish` success path:
- `apps/web/src/components/settings/delete-account-modal.tsx:453` — `globalThis.location.href = ROUTES.MARKETING;` (schedules full-doc nav to `/welcome`)
- `apps/web/src/components/settings/delete-account-modal.tsx:454` — `clearLocalAuthState();` (called with default `reload:true`)

`clearLocalAuthState` now ends with an **unconditional** `globalThis.location.reload()`:
- `apps/web/src/lib/auth.ts:557-576` (the `reload=true` default + `if (reload) globalThis.location.reload();`)

Commit `a4b4483d` added `location.reload()` to `clearLocalAuthState` (and the `{reload}` opt-out for the dev persona picker). The modal was written when `clearLocalAuthState` was a synchronous in-memory clear (see the now-stale comment at `delete-account-modal.tsx:451-452` — "Assign before clearLocalAuthState: queryClient.clear() flips the settled indicator…"). After `a4b4483d`, the synchronous `reload()` fires **immediately after** the `href` assignment and reloads the **current** document URL (still `/settings`, since the `/welcome` navigation has not committed), overriding the pending `/welcome` nav.

The reloaded `/settings` re-runs its route guard:
- `apps/web/src/routes/_app/settings.tsx:24-25` — `beforeLoad: async () => { await requireAuth(); }`
- `apps/web/src/lib/auth.ts:687-702` — `requireAuth()` throws `redirect({ to: ROUTES.LOGIN })` when unauthenticated.

Auth was just cleared, so the guard bounces the reloaded page to `/login`. Symptom hits every deletion-completing test (`:202` no-2FA, `:224`/`:247` 2FA, `:319` shared-content owner, double-click `:583`), matching the impl-report.

### Fix (long-term)
In `runFinishSubmit`, call `clearLocalAuthState({ reload: false })` at `delete-account-modal.tsx:454`. The `location.href = ROUTES.MARKETING` assignment (same-origin) is itself a full-document navigation that tears the JS context down — the identical memory-hygiene guarantee `reload()` was added for — so suppressing the redundant `reload()` lets the `/welcome` nav commit. (Alternative, less surgical: give `clearLocalAuthState` a "navigate-instead-of-reload" mode. Prefer the opt-out; it mirrors the existing dev-persona `reload:false` pattern.)

### Closest-layer TDD test
`apps/web/src/components/settings/delete-account-modal.test.tsx`: mock `/finish` → 200, spy `globalThis.location`; assert `location.href` is assigned `ROUTES.MARKETING` and `location.reload` is **not** called after a successful deletion. (Rung 1/2 — jsdom unit; also guards against the reload re-entering.)

### Enforcement rung
Rung 3 (component/contract test on the redirect side-effect) + the existing e2e `expectRedirectedToMarketing` (rung 4). The web unit test is the durable guard.

---

## BUG 2 — deletion rate-limit lockout: e2e sees HTTP 400 ×4, never 429 (6 failures, `:539`)

**Verdict: the wire-status mapping is ALREADY correct in source (429); the reproduced 400×4 is not explained by current source. One genuine, source-confirmed app defect sits in the same flow (modal lockout copy).** Treat the status-code symptom as needing a fresh-build re-run.

### Evidence
`…/failed/…-fourth-failed-attempt-surfaces-lockout-error/api-errors.txt`: four POST `/auth/account/delete/finish` → all `400 {"code":"INVALID_TOTP_CODE"}`. `error.txt`: `Expected: 429  Received: 400` (spec `:567`). The deletion guessing-gate never engaged across 4 attempts.

### Why the mapping is NOT the defect (429 is already wired)
- Domain reserves atomically, then engages the hard lock and returns `locked`:
  `apps/api/src/slices/identity/domain/deletion.ts:176-188` (`reserveAttempt(deleteAccountLockout)` → `decision.lockedOut` → `engageDeleteAccountHardLock` → `{kind:'locked'}`).
- Route maps `locked` → **429 TOO_MANY_ATTEMPTS**:
  `apps/api/src/slices/identity/routes.ts:915` → `tooManyAttemptsResponse` (`routes.ts:183-184`, status 429, `{retryAfterSeconds}` detail).
- Config: `deleteAccountLockout` maxAttempts 3 / window 3600s (`apps/api/src/slices/identity/domain/keys.ts:220-224`); `reserveAttempt` locks when `count > maxAttempts` (`lockout.ts:33-70`). 4 finishes → count 4 → locked on the 4th.
- This is aligned with the other secret-guessing limiters: TOTP-verify and 2FA-disable also use `tooManyAttemptsResponse` 429 (`routes.ts:518`, `:575`). (Login lockout is the outlier — 403 `ACCOUNT_LOCKED`, `routes.ts:380` — the admin lock, not a rate limiter.)
- Proven by the passing bad-proof integration test: `apps/api/src/slices/identity/routes.integration.test.ts:2064-2094` drives `maxAttempts` bad-proof finishes then asserts the next is **429 TOO_MANY_ATTEMPTS**.

Given `redisIncr` accumulates (`lib/redis/operations.ts` incr+expire-NX), `/init` does not clear the counter (`freshHandshake` is a no-op claim, `routes.ts:241`), and no path clears `delete-account:lockout` except `executeAndClear` on a **successful** delete (`deletion.ts:274`), the source cannot produce 400 on the 4th. The 400×4 therefore points to the counter not accumulating **in the running e2e** — most likely a stale Worker build or redis carryover, NOT the mapping. First triage step: re-run against a freshly built API.

### The coverage gap that let this ship
The 2FA path exercised by the e2e (2FA account: valid OPAQUE proof + wrong TOTP → `gateTotpThenExecute` → `verifyStoredTotp` → `invalid-totp`, `deletion.ts:232-260`) has **no** finish-flow integration test. `routes.integration.test.ts:2064` only covers the bad-proof branch (returns before TOTP). `deletion.integration.test.ts` only covers the executor. So the exact e2e path is unproven at the closest layer.

### Genuine source-confirmed app defect in this flow (modal lockout copy)
Even when `/finish` correctly returns 429 `TOO_MANY_ATTEMPTS` + `{retryAfterSeconds}`, the modal renders the **wrong** copy, failing spec `:574` (`formatLockoutMessage(retryAfterSeconds)` visible):
- `apps/web/src/components/settings/delete-account-modal.tsx:53-58` — `messageFor` only calls `formatLockoutMessage` when `code === 'DELETE_ACCOUNT_LOCKED'`; otherwise `friendlyErrorMessage(code)`.
- The API **never** emits `DELETE_ACCOUNT_LOCKED` (grep: absent from `apps/api/src`; it lives only in `@hushbox/shared` + this modal). The route emits `TOO_MANY_ATTEMPTS`, so `messageFor` falls through to the generic "Too many attempts…" string instead of the duration-aware `formatLockoutMessage`.

### Fix (long-term)
1. Modal: make `messageFor` (`delete-account-modal.tsx:54`) format the duration whenever `retryAfterSeconds` is present (key on the detail, not on the dead `DELETE_ACCOUNT_LOCKED` code) — e.g. `if (typeof details?.retryAfterSeconds === 'number') return formatLockoutMessage(details.retryAfterSeconds);`. This aligns with the spec pinning `code === TOO_MANY_ATTEMPTS`.
2. Status: no mapping change needed — it is already 429. If a fresh-build re-run still shows 400×4, escalate to a redis/limiter-runtime investigation (counter reset / key namespacing), not the route.

### Closest-layer TDD tests
- API (new, the missing coverage): `routes.integration.test.ts` — 2FA account, valid proof + wrong TOTP ×`maxAttempts` each 400 `INVALID_TOTP_CODE`, then the next → **429 TOO_MANY_ATTEMPTS** with numeric `retryAfterSeconds`. This is the exact e2e path and reproduces/guards the status.
- Web (modal copy): `delete-account-modal.test.tsx` — `/finish` → 429 `{code:TOO_MANY_ATTEMPTS, details:{retryAfterSeconds:N}}`; assert `formatLockoutMessage(N)` is rendered.

### Enforcement rung
Rung 3 (both contract tests block merge). The API 2FA-lockout integration test is the primary guard closing the coverage gap.

---

## Notes
- Ignored concurrent agents' edits to `apps/web` / `apps/api` per instructions.
- BUG 1 confidence: high (mechanism + regressing commit identified). BUG 2 confidence: high that the source already maps 429 and that the modal copy is a real defect; medium on the 400×4 status symptom's runtime cause (source-inconsistent → fresh-build re-run required).
