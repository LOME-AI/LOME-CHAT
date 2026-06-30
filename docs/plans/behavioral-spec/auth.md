# Spec family: auth

**v2 owner:** `identity` slice (OPAQUE auth, sessions, TOTP/step-up, recovery,
token-login, email verification, lockouts, session revocation).

Sources: e2e titles read directly from spec files (Verified); integration titles read
from the cited test files (Verified). Behavior statements paraphrase the titles —
where a statement goes beyond what the title says, it is marked Inferred.

## e2e behaviors

### `e2e/auth/auth-registration.spec.ts`

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Full signup → email-verify → login round trip succeeds | `signup → verify → login succeeds` | identity |
| Weak password is rejected client-side with a validation error | `Signup validation » weak password shows validation error` | identity (+ web) |
| Mismatched passwords are rejected with a validation error | `Signup validation » mismatched passwords shows validation error` | identity (+ web) |
| Verification email can be re-sent from the signup success page | `Email verification resend » resend from signup success page` | identity + notifications |
| Logging in unverified redirects to check-email and auto-resends | `Email verification resend » login unverified redirects to check-email with auto-resend` | identity |

### `e2e/auth/auth-login.spec.ts`

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Login with email navigates to /chat | `Login variants » login with email navigates to /chat` | identity |
| Login with username navigates to /chat (identifier may be email **or** username) | `Login variants » login with username navigates to /chat` | identity |
| Invalid password shows an error (OPAQUE proof failure, not enumeration) | `Login variants » invalid password shows error` | identity |
| Unverified email redirects to check-email; verifying enables login | `Login variants » unverified email redirects to check-email, verifying enables login` | identity |
| Authenticated user visiting /login is redirected to /chat | `Session & route protection » authenticated user visiting /login is redirected to /chat` | identity (+ web) |
| Logout redirects to /login and /chat then loads as trial user | `Session & route protection » logout redirects to /login and /chat loads as trial user` | identity |

### `e2e/auth/auth-2fa.spec.ts`

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Invalid TOTP code on login shows an error | `Login with 2FA (seeded user) » invalid 2FA code shows error` | identity |
| Valid TOTP code completes login to /chat | `Login with 2FA (seeded user) » valid 2FA code navigates to /chat` | identity |
| 2FA setup lifecycle: setup → verify → logout → login challenged for TOTP | `2FA Setup Lifecycle (fresh user) » setup → verify → logout → login with 2FA` | identity |
| 2FA disable lifecycle: enable → disable → login without 2FA | `2FA Disable Lifecycle (fresh user) » enable → disable → login without 2FA` | identity |

### `e2e/auth/auth-password.spec.ts`

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Password change invalidates the old password and enables the new one (key re-wrap implied — Inferred) | `change password → old fails → new succeeds` | identity |

### `e2e/auth/auth-recovery.spec.ts`

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Recovery phrase: view/verify phrase, then forgot-password reset via phrase, then regenerate phrase | `recovery phrase → verify → forgot password → regenerate` | identity |

## Integration behaviors (apps/api)

### `apps/api/src/routes/opaque-auth.test.ts` (selected — enumeration + lockout invariants)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| register/init returns a **valid-looking** response when the email already exists (enumeration-safe) | `returns 200 with valid registration response when email exists (prevents enumeration)` | identity |
| register/finish returns 201 but creates no user when email exists | `returns 201 but does not create user when email already exists` | identity |
| Unique-violation mapping: 409 `USERNAME_TAKEN` / 409 `EMAIL_TAKEN` | `returns 409 USERNAME_TAKEN…`, `returns 409 EMAIL_TAKEN… past /init` | identity |
| login/init returns **fake OPAQUE state** for non-existent email and username (timing/enumeration safety) | `returns 200 with fake OPAQUE state for non-existent email` / `…username` | identity |
| IP rate limiting on register/login init returns 429 | `returns 429 when IP is rate limited` (register), `returns 429 when IP rate limited` (login) | identity |
| OPAQUE pending state lives in Redis keyed by server-issued sessionId | `stores pending registration in Redis` (+ registry comment `apps/api/src/lib/redis-registry.ts:225-234`) | identity |

### `apps/api/src/routes/token-login.test.ts` (billing-only session type)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Valid one-time billing token sets a session cookie | `returns 200 and sets session cookie on valid token` | identity |
| Token is NOT deleted on redemption — reuse allowed within its 60 s TTL (idempotent by design) | `does not delete token after redemption (idempotent via TTL)`, `allows reuse within TTL window (idempotent design)` | identity |
| Session is tracked via `sessionActive` Redis key; retries produce the same key | `tracks session in Redis via sessionActive key`, `retries produce the same sessionActive key (no orphaned sessions)` | identity |
| Missing `IRON_SESSION_SECRET` fails fast before any I/O | `fails fast on missing IRON_SESSION_SECRET before any I/O` | identity |

### Other auth-relevant integration files (titles not exhaustively captured — read at port time)

- `apps/api/src/lib/session.test.ts`, `apps/api/src/middleware/iron-session.test.ts` — session cookie mechanics (30-day TTL, `apps/api/src/lib/session.ts:4`).
- `apps/api/src/lib/totp-step-up.test.ts`, `apps/api/src/lib/opaque-step-up.test.ts` — step-up helpers shared by password-change/2FA-disable/delete-account.
- `apps/api/src/middleware/require-auth.test.ts`, `require-privilege.test.ts`, `resolve-link-guest.test.ts`, `require-link-guest.test.ts` — the default-deny pipeline (identity owns it in v2).
- `apps/api/src/middleware/rate-limit.test.ts`, `rate-limit.routes.test.ts`, `apps/api/src/lib/rate-limit.test.ts` — fixed-window limiter + per-route wiring (see `constants.md` for the full registry).
- `apps/api/src/routes/users.test.ts` — user lookup/search surface (v2: `account` slice for search).

## Constants this family pins

Login/2FA/recovery/registration rate limits and lockout TTLs, session TTL, email-verify
token TTL, OPAQUE state TTLs — all in `constants.md`.
