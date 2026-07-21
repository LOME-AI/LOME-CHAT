# Task-38 — billing-token portal may read its own balance + transactions

## Objective

Admit the `billing-token` principal to read `GET /billing/balance` and
`GET /billing/transactions`, scoped strictly to its own wallet/user, mirroring how
`POST /billing/payments` already admits it. Both read routes were `routeClass('session')`
(403 for a billing-only principal); legacy granted the billing-scoped session read access
to all of `/api/billing`.

## Files changed

- `apps/api/src/slices/billing/routes.ts` — `/balance` and `/transactions` route classes
  changed `session` → `billing-token`; each handler's user derivation changed
  `callerUserId(c.var.principal)` → `payerUserId(c.var.principal)`. `payerUserId` (already
  exported from `domain/payments.ts` and already imported here for `/payments`) accepts a
  `full` OR `billing-only` principal and returns `principal.claims.userId`; `callerUserId`
  throws for anything but `full`. No other route touched; `/payments` region (Task-37)
  untouched.
- `apps/api/src/slices/billing/routes.integration.test.ts` — added a `billingOnlyCookie`
  helper (`billingOnly: true` claim) and two `/billing/balance` tests.
- `apps/api/src/slices/billing/routes-usage.integration.test.ts` — added a
  `billingOnlyCookie` helper and two `/billing/transactions` tests.

## Tests added

- `admits a billing-only session to read its own balance` — a billing-only principal reads
  its own seeded wallet (200, own `purchasedNanoUsd`). Criterion 1 + 3.
- `scopes a billing-only balance read to its own wallet, never another user’s` — two users
  seeded with distinct balances; the billing-only principal for user A reads A's balance
  (111000000), never B's (999000000). Criterion 2 (own-scope, no cross-user exposure).
- `admits a billing-only session to read its own transactions` — billing-only principal for
  the seeded user reads its own ledger page (200, non-empty). Criterion 1 + 3.
- `scopes a billing-only transactions read to its own ledger, never another user’s` — a
  billing-only principal for `otherUserId` (who owns usage rows but NO ledger legs — every
  seeded leg belongs to `userId`'s wallet) reads an empty page, proving `userId`'s ledger
  never leaks to a different principal. Criterion 2.

## Self-gate

- `vitest run` (billing routes + routes-usage, RED before impl) — **fail as expected**: 4
  new tests `expected 403 to be 200` (billing-only refused on session-class route).
- `vitest run` (billing routes + routes-usage, after impl) — **pass**: 69/69.
- `vitest run src/slices/billing src/middleware/edge-middleware.integration.test.ts
  src/middleware/pipeline-authorize.test.ts src/lib/context` — **pass**: 634/634 (no
  regression; anonymous `/billing/balance` still 401 under `billing-token`, since a `none`
  principal maps to 401 for both classes).
- `eslint` (3 edited files) — **pass** (exit 0).
- `prettier --check` (3 edited files) — **pass** (exit 0).
- `tsgo --noEmit` (api package) — **pass** (exit 0).

## Acceptance criteria

1. **Admit billing-token to /balance and /transactions, scoped to own wallet, mirroring
   /payments — met.** Both routes now `routeClass('billing-token')`, the same class
   `/payments` uses (accepts `full` + `billing-only`). No new principal class; no combined
   route class needed (`billing-token` already accepts both). No other route broadened.
2. **Handlers scope to the authenticated principal's own user id, no client-supplied id —
   met.** The user id is derived solely from `payerUserId(c.var.principal)` →
   `principal.claims.userId` (the sealed cookie's claim), never from request body/query/path.
   The query schema for `/transactions` carries only `limit/cursor/offset/type` — no user
   id. `readBalance` / `readLedgerTransactions` filter by that derived id only. The
   cross-user tests prove zero leakage: principal A reads only A's data; a principal for a
   different user reads only that user's (empty) data.
3. **Failing test first — met.** RED captured: all 4 new tests failed with 403 before the
   route-class change; pass after.
4. **No change to /payments or any non-billing route; no new principal class — met.** Only
   the two named read handlers changed. `/payments` (Task-37's region, ~:483+) untouched.

## Coordination note (raised)

- Task-37 landed first in the same `routes.ts` (uncommitted): the `/payments` handler's
  `paymentProvider(c.env, c.var.db, { waitUntil })` 3-param call and executionCtx wiring.
  Left entirely untouched — my edits are confined to the `/balance` (:184) and
  `/transactions` (:446) regions. `git diff --stat` shows a larger delta on `routes.ts` /
  `routes.integration.test.ts` because those files already carried Task-37's uncommitted
  changes; my contribution is the billing-token scoping only.

## Deviations with reasons

- Reused `payerUserId` (defined in `domain/payments.ts`) for the two read handlers rather
  than broadening `callerUserId` (defined in `domain/balance.ts`). Reason: `payerUserId`
  already does exactly what criterion 2 requires (own-user id for `full` OR `billing-only`),
  is already imported here, and keeps the change inside `routes.ts` (the plan's file
  ownership) — broadening `callerUserId` would touch `domain/balance.ts` (outside ownership)
  and change a documented invariant shared by other session-only routes (`/usage`,
  `/usage/models`, `/login-link`), which must stay `full`-only. Minor naming imperfection:
  `payerUserId` reads as payment-specific, but its doc and body are principal-generic ("the
  identity from the pipeline principal … both session kinds are legal"). Flagged for the
  auditor. An alternative (rename to `sessionUserId`) was rejected: it lives in
  `payments.ts` and is used by `/payments`, which Task-37 owns and I must not touch.

## Concerns and limitations

- The pre-existing edge-middleware test comment calls `/billing/balance` an "anonymous
  session route" — now technically a `billing-token` route, but the asserted behavior (401
  for anonymous) is unchanged. Left untouched (outside ownership; a comment-only nit).

## Confidence

High — the mechanism is a single documented route-class matrix; RED→GREEN is clean; own-
scope is derived solely from sealed claims with no client id path; 634 adjacent tests green.
