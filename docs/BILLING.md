# Billing System

How money works in HushBox: tiers, model classification, funding decisions, fees, and
the charge lifecycle. The settlement/admission mechanisms are specified in
`docs/ARCHITECTURE.md` §Money & settlement; this document covers the product-level
billing semantics and where the code lives.

---

## User Tiers

| Tier      | Model Access | Persistence      | Funding                             |
| --------- | ------------ | ---------------- | ----------------------------------- |
| **Trial** | Basic only   | None (ephemeral) | Absorbed — message count limit only |
| **Guest** | Basic only   | Via shared link  | Group budget only, never own funds  |
| **Free**  | Basic only   | Full             | Welcome credit + daily allowance    |
| **Paid**  | All models   | Full             | Prepaid credits loaded via card     |

**Tier derivation** (`getUserTier` in `packages/shared/src/tiers.ts`):

- Unauthenticated → **trial** (or **guest** when arriving through a shared link)
- Authenticated with balance > 0 → **paid**; balance = 0 → **free**
- Premium model access is paid-only

---

## Model Classification

Models are **Basic** or **Premium** (`packages/shared/src/models/premium-check.ts`):

- **Premium**: combined prompt+completion price ≥ the 75th-percentile threshold
  (`PREMIUM_PRICE_PERCENTILE`), OR released within the recency window
  (`PREMIUM_RECENCY_MS`, ~6 months)
- **Basic**: everything else

Classification is computed when models are processed from the catalog, not stored.

---

## Funding Decision Matrix

When a message is sent, `resolveBilling` (`packages/shared/src/resolve-billing.ts` —
the shared frontend + backend gate) decides who pays, in priority order:

| Priority | Condition                                                            | Outcome                                                                                                       |
| :------: | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
|    1     | Group conversation with budget remaining AND owner can use the model | **Conversation owner pays.** Budget exhausted or owner can't use the model ⇒ fall through to personal billing |
|    2     | Premium model, user without premium access                           | Denied — premium requires the paid tier                                                                       |
|    3     | Paid user with sufficient balance (small cushion applies)            | **User's purchased balance**; insufficient ⇒ denied                                                           |
|    4     | Free user, basic model, sufficient daily allowance                   | **Free daily allowance**; insufficient ⇒ denied                                                               |
|    5     | Link guest with no group budget                                      | Denied — guests never pay from their own funds                                                                |
|    6     | Trial, estimated cost within the per-message cap                     | **Absorbed** (no charge); over the cap ⇒ denied                                                               |

---

## Balance Consumption

- Charges land on the payer's **purchased wallet**; each user also has a **free
  wallet** (always balance 0) through which the daily allowance is accounted — a
  charge against it writes a period-keyed allowance-spending row.
- The free allowance applies to **basic models only**, is day-keyed
  (`allowance_spending` unique on user+day, UTC), and never offsets a negative
  purchased balance. There are no midnight reset jobs — a new day is simply a new row.
- Member budgets are month-keyed rows (`member_budgets` unique on member+month)
  snapshotting the budget and the spend; conversation spending is tracked per
  conversation+month.

---

## Billing Flow

One flow for every turn — cost is authoritative at settlement, no reconcile:

1. User sends a message; `resolveBilling` picks the funding source (matrix above).
2. **Admission**: one atomic Redis Lua script checks balance snapshot − Σ holds ≥
   estimate plus budget scopes and the per-wallet concurrent-run cap, then places a
   TTL hold for the run's declared ceiling. Redis down ⇒ paid admission fails closed.
3. The run streams. OpenRouter returns the charged `usage.cost` inline for text and
   video; image is priced by its deterministic catalog estimate.
4. **Settlement**: the single settlement transaction persists the content and calls
   `chargeWithinTx` — unguarded (negative balances are legal), applying the markup,
   writing the usage record + zero-sum ledger leg pair (wallet ↔ house `revenue`),
   advancing the wallet's ledger sequence, and upserting the period spending rows.
   Saved ⟺ billed, by construction.
5. The `done` event carries the final cost per model entry; the hold is released
   (or expires by TTL). A run killed before settlement saves nothing and bills
   nothing; an explicit user stop settles and bills the partial.

Domain code: `apps/api/src/slices/billing/domain/` (admission, charge, wallets,
budget-resolution, auditors) and `apps/api/src/slices/chat/domain/settlement.ts`.

---

## Fee Structure

- **15% markup over base provider cost** — base = what OpenRouter charges us, applied
  at settlement (`applyMarkup`).
- Fees apply to model usage cost only; storage fees are separate and not marked up.

Fee constants: `packages/shared/src/constants.ts`; application functions:
`packages/shared/src/pricing.ts`.

---

## Storage Fees

Messages are charged a per-character storage fee covering long-term retention,
derived in `packages/shared/src/constants.ts`:

```
STORAGE_COST_PER_CHARACTER =
  (MONTHLY_COST_PER_GB × MONTHS_PER_YEAR × STORAGE_YEARS)
  ÷ (CHARACTERS_PER_KILOBYTE × KILOBYTES_PER_GIGABYTE)
```

Media has the analogous `MEDIA_STORAGE_COST_PER_BYTE`. Both are added to message
cost in `packages/shared/src/pricing.ts`.

---

## Trial Usage

Trial users (unauthenticated) can chat with limits:

- **Basic models only**, `TRIAL_MESSAGE_LIMIT` messages per day, no persistence
- Per-message cost cap: `MAX_TRIAL_MESSAGE_COST_CENTS` — a message estimated above
  it is denied

Identity and quota tracking (`apps/api/src/slices/chat/domain/trial-quota.ts`,
`apps/api/src/slices/identity/domain/trial-session.ts`):

- The client sends an `x-trial-token` (uuid kept in localStorage), resolved to an
  ephemeral **trial-session principal** — never persisted server-side
- **Dual-identity quota**: a per-session counter and a per-IP counter (SHA-256 IP
  hash) both increment in Redis; the **higher** of the two is compared against the
  limit, so clearing localStorage doesn't reset the quota
- Counters expire at the next UTC midnight; Redis down fails closed
- A **global day-keyed trial budget** is reserved at admission
  (`TRIAL_GLOBAL_BUDGET_NANO_USD`), bounding aggregate trial provider spend — the
  Sybil backstop
- Trial settlement is a no-op: nothing saved, nothing billed

---

## New User Bonus

Account creation provisions both wallets and grants a welcome credit
(`WELCOME_CREDIT_CENTS` in `packages/shared/src/tiers.ts`) to the purchased wallet as
a zero-sum promo ledger pair, idempotency-keyed per user
(`provisionWalletsWithinTx` in `apps/api/src/slices/billing/domain/wallets.ts`).
Hard deletion means a re-registered email receives it again — accepted, bounded by
the global trial/welcome budget.

---

## Payments (Helcim)

Card charges are Pattern D (pre-claim then reconcile): a durable `payments` row is
written before the charge, finalized by webhook, and verified by a delayed
`payment.verify.v1` job that can also recover an orphaned capture by searching
Helcim by the payment reference. Webhook signature verification fails closed.

Payment states (`payment_status` enum):
`pending → awaiting_webhook → completed | failed`, plus `expired` for pre-claims the
verify job gives up on.

A chargeback/reversal posts a `byEventId` clawback pair and auto-locks the account
with session revocation (reversible); inquiries/retrievals only notify. Locally,
Helcim is mocked; CI's e2e lane uses the Helcim sandbox.

---

## Configuration Reference

| Configuration           | Location                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Fee rates               | `packages/shared/src/constants.ts`                                                          |
| Storage costs           | `packages/shared/src/constants.ts`                                                          |
| Pricing functions       | `packages/shared/src/pricing.ts`                                                            |
| Tier logic & constants  | `packages/shared/src/tiers.ts`                                                              |
| Funding decision        | `packages/shared/src/resolve-billing.ts`                                                    |
| Model classification    | `packages/shared/src/models/premium-check.ts`                                               |
| Welcome credit          | `packages/shared/src/tiers.ts` (granted in `apps/api/src/slices/billing/domain/wallets.ts`) |
| Trial limits            | `packages/shared/src/tiers.ts`, `packages/shared/src/constants.ts`                          |
| Trial global budget     | `apps/api/src/slices/billing/domain/constants.ts`                                           |
| Budget scopes           | `apps/api/src/slices/billing/domain/budget-resolution.ts`                                   |
| Payment schema & states | `packages/db/src/schema/payments.ts`, `packages/db/src/schema/enums.ts`                     |
| Wallets                 | `packages/db/src/schema/wallets.ts`                                                         |
| Ledger entries          | `packages/db/src/schema/ledger-entries.ts`                                                  |
| Allowance spending      | `packages/db/src/schema/allowance-spending.ts`                                              |
| Member budgets          | `packages/db/src/schema/member-budgets.ts`                                                  |
| Conversation spending   | `packages/db/src/schema/conversation-spending.ts`                                           |
