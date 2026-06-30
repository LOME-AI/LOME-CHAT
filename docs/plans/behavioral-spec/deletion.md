# Spec family: deletion

**v2 owner:** `identity` slice (account deletion, Pattern A + GC per BACKEND-REDESIGN §7).
Financial pseudonymization touches `billing`-owned rows via published APIs; R2 reclaim is
a `media.reclaimUser.v1` job in v2.

## e2e behaviors — `e2e/account-deletion.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| A signed-up user (no 2FA) deletes their account and lands on the marketing root | `Happy path: no 2FA » signed-up user deletes account and is redirected to marketing root` | identity |
| A 2FA user must enter TOTP during the deletion flow | `Happy path: with 2FA » user with 2FA enters TOTP then deletes account` | identity |
| Non-zero wallet balance inserts a forfeit step; Continue is gated on an explicit checkbox | `Wallet forfeit step » non-zero balance surfaces forfeit step and gates Continue on the checkbox` | identity + billing |
| Back button steps through previous wizard steps; hidden on intro | `Back button » back navigates through previous steps and is hidden on intro` | identity (web) |
| A shared message link errors once its owner deletes their account | `Shared content after deletion » shared message link returns an error once the owner deletes their account` | identity + conversations |
| Cancel at every step (intro, wallet, password, final) closes the modal and leaves the account intact | `Cancel at each step » cancel from intro, wallet, password, and final closes modal and leaves account intact` | identity |
| Wrong password keeps the modal on the password step with a friendly error | `Wrong password rejected » incorrect password keeps modal on password step with friendly error` | identity |
| Invalid TOTP at final submit routes back to the TOTP step with a friendly error | `Wrong TOTP rejected » invalid TOTP from final-step submit routes back to TOTP step with friendly error` | identity |
| The confirmation phrase gates the final submit: wrong phrase disables, exact phrase enables | `Phrase gating on step 5 » wrong phrase keeps submit disabled; exact phrase enables it` | identity |
| (KNOWN GAP — `test.fixme`) fourth failed attempt should surface the lockout error | `Rate-limit lockout » fourth failed attempt surfaces lockout error` (fixme, not running) | identity |
| Final submit disables on click so a double-click cannot fire twice | `Front-end idempotency » final submit disables on click so double-click cannot fire twice` | identity (web) |

## Integration behaviors

### `apps/api/src/routes/delete-account.test.ts` (titles Verified — the lockout/phrase contract)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| init/finish require a full (non-pending-2FA) session; pending-2FA returns 403 `2FA_REQUIRED` | `returns 403 with 2FA_REQUIRED when the session is pending 2FA` (both init and finish) | identity |
| Locked-out account returns 403 `DELETE_ACCOUNT_LOCKED` on init and finish | `returns 403 with DELETE_ACCOUNT_LOCKED when the account is locked out` | identity |
| Wrong/empty confirmation phrase → `INVALID_CONFIRMATION_PHRASE`; comparison is case-insensitive and whitespace-tolerant | `rejects wrong confirmation phrase…`, `accepts case-insensitive, whitespace-padded confirmation phrase` (phrase = `'delete my account'`, `packages/shared/src/constants.ts:290`) | identity |
| Bad OPAQUE proof → `INCORRECT_PASSWORD` and records a failed attempt; expired OPAQUE state → `NO_PENDING_DELETE_ACCOUNT` **without** incrementing the limiter | `rejects bad OPAQUE proof…`, `rejects expired OPAQUE state… without incrementing rate limit` | identity |
| Missing TOTP code → `TOTP_CODE_REQUIRED` with **no** failed attempt; bad TOTP → `INVALID_TOTP_CODE` with a failed attempt | `returns TOTP_CODE_REQUIRED (not INVALID_TOTP_CODE)…`, `rejects bad TOTP code…` | identity |
| 3rd consecutive failed attempt locks out (24 h — `deleteAccountLockout` TTL); the triggering attempt itself surfaces `DELETE_ACCOUNT_LOCKED` + `retryAfterSeconds` | `locks out on the 3rd consecutive failed attempt…`, `the triggering failed attempt itself surfaces DELETE_ACCOUNT_LOCKED…` | identity |
| TOTP-disabled users do not supply a code | `does NOT require totpCode when the user has TOTP disabled` | identity |
| Concurrent delete: saga reporting user-not-found still returns 204 (success state) | `saga returns user-not-found: still 204 (concurrent delete is success state)` | identity |

### `apps/api/src/services/account-deletion/delete-user.integration.test.ts` (titles Verified — the cascade contract)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Deletion cascades owned conversations, **projects**, device tokens; NULLs financial rows; logs a deletion event; deletes R2 objects; sends the goodbye email | `cascades owned conversations, projects, device tokens; nulls financials; logs event; deletes R2 objects; sends email` | identity (orchestrating) |
| Second run is a no-op: user-not-found, no second event row, no R2/email calls (idempotent saga) | `returns user-not-found on a second run and does not insert another event or call R2/email` | identity |
| Concurrent saga runs serialize — exactly one succeeds (`FOR UPDATE` across distinct connections) | `serializes concurrent saga runs so exactly one succeeds…`, `FOR UPDATE serializes parallel sagas across distinct DB connections` | identity |

Note for v2: the `projects` cascade expectation disappears with the feature
(see `projects-feature.md`). Financial-row pseudonymization (`SET NULL`) maps to the
ARCHITECTURE.md deletion doctrine (hard delete + Art. 17(3)(b) retention).
