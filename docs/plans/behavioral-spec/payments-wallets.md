# Spec family: payments-wallets

**v2 owner:** `billing` slice (wallets, ledger, payments, Helcim, webhooks, free-tier
allowance, wallet provisioning). Token-login session minting is `identity`.

Per BACKEND-REDESIGN §19, **payment idempotency lives in integration tests, not e2e** —
the integration tables below are the primary spec source for it.

## e2e behaviors

### `e2e/billing/billing.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Billing page displays balance and opens the payment modal | `Billing Page » displays balance and opens payment modal` | billing |
| Dev-mode simulated payment succeeds and updates the balance | `Payment Flow (Dev Mode) » simulates successful payment and updates balance` (`@local-only`) | billing |
| Dev-mode failed payment shows an error | `Payment Flow (Dev Mode) » simulates failed payment and shows error` (`@local-only`) | billing |
| Minimum deposit amount is validated | `Payment Flow (Dev Mode) » validates minimum deposit amount` (`@local-only`) | billing |
| Full flow: card → API → **webhook** → balance credited (real Helcim sandbox in CI) | `Payment Flow (Full) » completes full payment flow: card → API → webhook → balance` (`@webhook`) | billing |
| Declined card is handled | `Payment Flow (Full) » handles declined card` (`@webhook`) | billing |
| Real Helcim webhook signature is validated | `Payment Flow (Full) » validates real Helcim webhook signature` (`@webhook`) | billing |
| Unauthenticated user completes payment via a one-time billing token (mobile → web) | `Token-Login Billing Portal » unauthenticated user completes payment via billing token` (`@webhook`) | identity + billing |

### `e2e/billing/wallet-lifecycle.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Tier transitions across the wallet lifecycle: signup grants welcome credit; free-tier message spends allowance; payment flips to paid; paid-tier message charges balance | `signup → free tier message → payment → paid tier message` (`@chromium-only`) | billing + chat |

## Integration behaviors

### Payment idempotency — `apps/api/src/routes/billing.test.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Same `idempotencyKey` on POST /billing/payments returns the existing payment (no duplicate row) | `returns existing payment when same idempotencyKey is used` | billing |
| Already-processed payment cannot be processed again | `rejects processing already processed payment` | billing |
| Completed payment is never overwritten by a late `failed` status | `does not overwrite completed payment with failed status` | billing |
| Completed payment is never overwritten by `expired` (payments expire after 30 min — `PAYMENT_EXPIRATION_MS`, `apps/api/src/routes/billing.ts:194`) | `does not overwrite completed payment with expired status` | billing |
| Client IP forwarding to Helcim: `cf-connecting-ip` first, `x-forwarded-for` fallback, then a fallback IP | `passes client IP from cf-connecting-ip header…`, `…x-forwarded-for…`, `uses fallback IP when no IP headers present` | billing |
| Balance returned as numeric string with decimal precision (never float) | `returns balance as numeric string with decimal precision` | billing |
| Transaction history supports type filters (`deposit`, `usage_charge`), limit, and offset pagination | `filters by type=deposit…`, `filters by type=usage_charge…`, `respects limit parameter`, `supports offset-based pagination with type filter` | billing |
| Billing login link: token returned, userId stored in Redis (60 s TTL), unique per call | `returns a token string on success`, `stores userId in Redis under the token key`, `generates unique tokens on repeated calls` | identity + billing |

### Webhook idempotency — `apps/api/src/routes/webhooks.test.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Webhook matching an `awaiting_webhook` payment credits the balance | `credits balance when webhook matches awaiting_webhook payment` | billing |
| Duplicate webhook does not double-credit | `is idempotent - does not double-credit` | billing |
| Already-completed payment returns 200 immediately on a duplicate webhook | `returns 200 immediately for already-completed payments (duplicate webhook)` | billing |
| Non-`cardTransaction` event types are ignored | `ignores non-cardTransaction event types` | billing |
| Truly unknown transaction IDs return 500 after retries (so Helcim re-delivers) | `returns 500 for truly unknown transaction IDs after retries` | billing |
| Production without `HELCIM_WEBHOOK_VERIFIER` configured returns 500 (fail fast) | `returns 500 in production when HELCIM_WEBHOOK_VERIFIER is not configured` | billing |

### Wallet provisioning & allowance

| Behavior | Source | v2 slice |
| --- | --- | --- |
| New users get a primary wallet with `WELCOME_CREDIT_BALANCE` ($0.20) and a free wallet with `FREE_ALLOWANCE_DOLLARS` ($0.05), each with an initial ledger entry | `apps/api/src/services/billing/wallet-provisioning.ts:25-62` (code Verified; colocated tests exist) | billing (`provisionWalletsWithinTx` in v2) |
| Daily allowance refill is a lazy idempotent `UPDATE … WHERE balance < FREE_ALLOWANCE_DOLLARS` — concurrent refills are safe, no reset job | `apps/api/src/services/billing/balance.ts:145-181` (code Verified) | billing |
| Speculative balance reservation (Redis holds, 180 s TTL) guards concurrent sends | `apps/api/src/lib/speculative-balance.test.ts`, `apps/api/src/lib/billing-reservation.test.ts`; keys at `apps/api/src/lib/redis-registry.ts:314-329` | billing |
| The billing scenario matrix (free F1–F6, paid P1–P6 incl. the 50¢ cushion, TOCTOU race guards R1–R4, 1000-minimum-token boundary M1–M5, budget accuracy B1–B3) | `apps/api/src/routes/chat.billing-integration.test.ts:541-1087` (titles Verified) | billing + chat |

### Related but settled elsewhere

Streaming settlement, billing-mismatch evidence, and cost finalization live in
`apps/api/src/lib/stream-pipeline.test.ts` /
`stream-pipeline.billing-mismatch.test.ts` — captured in `chat-core.md` since v2 reshapes
that path into the single `settle()` transaction.
