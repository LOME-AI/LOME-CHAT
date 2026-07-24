# Billing System

How money works in HushBox: tiers, affordability, reservations, reasoning effort,
Smart Model, multi-model turns, group funding, fees, and the charge lifecycle. This
document is the lossless statement of billing principles and mechanics — the single
home for billing semantics. Architectural mechanisms (the settlement transaction's
internals, jobs, Durable Object topology) live in `docs/ARCHITECTURE.md`.

---

## User Tiers

| Tier      | Model Access | Persistence      | Funding                                              |
| --------- | ------------ | ---------------- | ---------------------------------------------------- |
| **Trial** | Basic only   | None (ephemeral) | Absorbed — message count + per-message + daily caps  |
| **Guest** | Basic only   | Via shared link  | Group budget only, never own funds                   |
| **Free**  | Basic only   | Full             | Welcome credit + daily allowance                     |
| **Paid**  | All models   | Full             | Prepaid credits loaded via card                      |

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

## Affordability & Reservation

The verdict-and-sizing system: whether a send may start and at what ceiling.

1. **One verdict, two renderers.** Client and server compute affordability through
   the same shared implementation (`packages/shared/src/estimate/`). Divergence-prone
   inputs are served by the server as numbers, never re-derived client-side:
   `GET /billing/spendable` returns `{spendableNanoUsd (cushion- and hold-aware),
heldNanoUsd}` and fails closed (503) when Redis is down —
   matching admission, which refuses paid runs without Redis; the conversation
   budgets endpoint serves hold-aware remaining. Holds are read by a Lua fragment
   shared with the admission script — the hold format/expiry rule has exactly one
   implementation. Freshness rides existing WS frames (`run-started`, `run-finished`,
   reconnect catch-up); there are zero per-keystroke API calls. The server is
   authoritative; the client preview is the same verdict rendered early.
2. **Staleness contract.** Served numbers are point-in-time snapshots. Bounded,
   accepted divergence: a hold placed from a conversation the client has no socket
   to stays invisible until the next fetch, at most the hold's TTL; admission gates
   on the 30s-TTL Redis balance snapshot, so preview-vs-gate skew ≤ 30s; two sends
   racing for the same funds are decided solely by the atomic admission script.
   `GET /billing/balance` remains ledger truth for payment-confirmation polling and
   display only — it is not an affordability input.
3. **Identical inputs.** Preview and send measure the identical prompt — system
   prompt + custom instructions + history + new input — through the same
   construction code path used to send. Client money math is nano-USD `bigint`
   end-to-end; cents/dollars exist only at display formatting.
4. **The minimum-viable-answer floor is THE minimum.** One constant
   (`MINIMUM_OUTPUT_TOKENS`, 1000): a model is callable iff fixed costs + a minimum
   answer at the model's cheapest configuration (reasoning off where possible, else
   its lowest offered level) is affordable. Below the floor the model greys in the
   picker (tooltip, never hidden) and the server refuses (402). Above it, low
   balance only shrinks the cap — a low-balance user is never blocked from a model
   they can afford within the cap.
5. **Worst-case reservation, triply bounded.** Output ceiling = min(budget-affordable
   tokens, the model's max output tokens, context headroom). Max output tokens is a
   catalog field ingested from the provider (`top_provider.max_completion_tokens`);
   absent ⇒ context length. Reasoning tokens are output tokens: a model's reasoning
   budget and its answer share the same `maxTokens` pool and the same output rate —
   wire cap = reasoning budget + answer headroom, and the output ceiling bounds both
   together. Never reserve beyond what the model can physically emit or the user can
   pay.
6. **Cushion is spendable-side.** Paid: +$0.50 spendable everywhere
   (`MAX_ALLOWED_NEGATIVE_BALANCE_CENTS` — balance may go $0.50 negative). Free:
   daily allowance only. Trial/guest: fixed $0.01 effective balance, quota gates,
   no holds.
7. **Tier ratios.** Input estimation: paid 1 token per 4 chars, all other tiers
   1 per 2. Output-storage estimation is inverted (paid 2, others 4) so the tier
   that over-reserves input also over-reserves output storage. Always round against
   the user (ceil).
8. **Reservation ⊇ bill.** Every billable component is priced in the reservation
   through the same shared folding; estimates only over-reserve (cache reads priced
   at full input rate, reasoning folded into output, worst-case web-search
   reservation).
9. Estimated cost drives decisions and notifications only — it is not displayed.

**Reservation mechanics.** An estimate is a manifest of line items in two classes:
provider items (input tokens, output tokens, media generation, classifier tokens —
billable rates) and storage items (input chars, output chars, media bytes —
pass-through, never fee-bearing; dropped on non-persisting turns). Per-node worst
case = fixed items + output-ceiling × variable rate; a node's reservation = per-node
worst case × declared fan-out width × max steps × max iterations; the run's hold =
Σ nodes + prompt input-storage once. Web search reserves worst case: max tool calls
(10) × per-call rate ($0.005) × model count. Media: image reserves its deterministic
per-unit price (billed exactly as estimated, `isEstimated`, no reconcile); video
per-second × resolution; storage via fixed byte estimates. Inline provider cost is
billing truth for text/video; a missing or implausible (sanity-multiple) inline cost
falls back to the billable catalog estimate, flagged `isEstimated` + one Sentry
alert. Charges are idempotent per `${runId}:${nodeKey}`. A zero-value hold is a
defect, rejected at estimation.

**Admission invariants.** Admission is the only balance gate; one atomic Redis
script checks the concurrent-run cap (5 per wallet), spendable − Σ active holds ≥
estimate, and every budget scope, then writes the hold (TTL = run deadline +
margin). Settlement is unguarded — negative balances are legal states. Saved ⟺
billed: content and every charge commit in one settlement transaction; an
involuntary kill bills nothing; an explicit user stop settles the billable partial
(the sole saved⟺billed carve-out); a cost-circuit trip (observed accrual >
hold × 5) bills nothing — absorbed platform loss, one Sentry event. Redis down ⇒
paid admission refuses; no degraded mode.

---

## Reasoning Effort & the Classifier

1. **Vocabulary.** Canonical ladder lite < low < medium < high < max, positionally
   normalized per model (`offeredLevels` is the single authority). User-facing
   **Min = reasoning off** (sent when the model supports disabling); **Lite = the
   lowest reasoning level**. There is no separate "None".
2. **Ladder assignment.** Per-level reasoning-budget targets are founder-tunable
   data (currently lite 2048 / low 4096 / medium 12288 / high 32768 / max 65536
   tokens), clamped to the model's cap with a 1024 protocol floor. A model's native
   effort vocabulary maps positionally onto the canonical ladder by count:
   1→[high], 2→[low, high], 3→[low, medium, high], 4→[low, medium, high, max],
   ≥5→strongest five. Budget-native models (no enumerated efforts) offer the full
   ladder as clamped token tiers; a mandatory-reasoning model with one level offers
   no choice. One function is the sole normalization authority for menu, server
   validation, and classifier options alike.
3. **Sizing.** Wire `maxTokens` = reasoning budget + answer headroom, derived per
   turn, bounded per Affordability 5. A level is enabled iff fixed + (budget +
   minimum answer) × rate is affordable and it fits the model's limits. Disabled
   levels grey with a reason — never hidden — for every tier including trial.
4. **One effort per turn.** The user (or classifier) picks a single effort.
   Multi-model option set = the **union** of all selected models' offered levels
   (+ Min if any model can disable). Per-model resolution: a model lacking the
   chosen level falls to its nearest offered level, **only downward**; a
   mandatory-reasoning model whose whole ladder sits above the chosen level runs at
   its lowest offered level (the one upward exception — down is impossible). An
   explicitly chosen level on a single-model turn runs as asked or refuses — never
   silently substituted.
5. **Auto is a smart node.** Auto is always selectable. With ≥ 2 real choices
   (offered rungs + Min counts), one classifier call chooses; with exactly 1, the
   choice is deterministic — no call, no reserve. No static effort-preference order
   exists anywhere: every auto resolution is classifier-driven or the deterministic
   single-choice pick — on single-model, multi-model, web-search, and trial turns
   alike. If no classifier can be built (no priceable engine in the catalog), the
   send fails with a typed error — never a silent static fallback; explicit levels
   remain usable.
6. **One classifier call per turn.** All decisions ride one call on the cheapest
   priceable text model: a model dimension (when Smart Model is selected) + one
   effort dimension (when any model is on auto), sharing one truncated context
   (4,000-char cap). The classifier is presented exactly the options the user saw.
   Worst-case cost ≈ 0.1¢ — trial turns support it inside the 1¢ cap. The
   classifier itself carries no tools; the chosen answer model carries web search
   when active.
7. **Reserve ⟺ classify.** The classifier reserve is held exactly when the turn
   will run a classifier — one predicate shared by estimator and executor.
8. **Ruled edge cases.** (a) Chosen effort below a model's entire ladder, reasoning
   disableable → Min. (b) Below the ladder, reasoning mandatory → the model's
   lowest offered rung — the sole upward resolution, because downward is
   impossible. (c) Exactly one real choice → deterministic pick: no classifier
   call, no reserve, auto still selectable. (d) No priceable classifier engine →
   typed error; explicit levels remain usable. (e) A persisted auto preference
   never clamps away — auto is valid for every model. (f) A Smart-Model-resolved
   model lacking the turn's effort → the same downgrade rule as (a)/(b).

---

## Smart Model

1. **Pool pricing.** Candidates sort by combined base price; the cheapest priceable
   model is the classifier engine. Fixed reserve = classifier worst case (capped
   context + capped output) + its storage + one-off input storage.
2. **Per-candidate caps.** Each candidate's cap = the largest output-token count its
   cost fits inside (balance − fixed reserve), bounded by its remaining context —
   solved against the same per-model math as a direct pick. Candidates survive iff
   cap ≥ the minimum-answer floor (1000).
3. **The hold is MAX, never Σ**, over eligible candidates' costs — exactly one
   candidate answers; the hold is ≤ effective balance by construction.
4. **The biconditional threshold.** A balance-independent minimum
   (`smartModelMinimumRequiredNanoUsd` = classifier reserve + cheapest candidate
   floor) below which admission returns empty — one shared function, so client
   refusal ⇔ server refusal, pinned by a balance-sweep parity test.
5. Trial Smart Model substitutes the fixed 1¢ ceiling for a wallet and runs the
   same math, classifier included.
6. **Equivalence.** Smart Model composes as a multi-model sibling; its resolved
   model is sized exactly as a direct pick minus the classifier cost from the
   available budget (pinned by an invariant test).

---

## Multi-Model Turns

1. A multi-model turn (≤ 5 models) is **N direct picks sharing one prompt**: N
   sibling calls, each priced, reserved, billed, and persisted per its own model
   under one `runId`. Prompt input-storage counts once — attributed to the first
   successful charge, mirroring the estimate side. Smart Model is composable as one
   sibling among regular models.
2. **One formula.** Affordability and reservation use only the authoritative
   per-model math summed across siblings — the same implementation client and
   server. No summed-rate approximation exists.
3. **Per-model caps.** Sibling wire caps are fully per-model: each model's resolved
   effort budget + its own answer headroom against its own context and max-output
   bounds — no shared cap, no tightest-model coupling.
4. Partial success bills the successful subset; all-siblings-fail bills nothing and
   persists nothing; an explicit user stop settles the partial.
5. Group/member/conversation scopes gate the single summed ceiling atomically at
   admission.
6. All ≤ 5 siblings execute concurrently under the platform's 6-connection level
   cap; each successful sibling persists as its own assistant message under one
   parent (the last becomes the fork tip).

---

## Funding Decision Matrix

When a message is sent, the shared funding decision
(`packages/shared/src/billing/funding-decision.ts`, wrapped for the client by
`billing/client-billing.ts`) decides who pays, in priority order:

| Priority | Condition                                                                                                     | Outcome                                                                                                             |
| :------: | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
|    1     | Group conversation with headroom remaining (min of member allowance, conversation allowance, owner balance ≥ 0) | **Conversation owner pays**, premium allowed. Headroom exhausted ⇒ signed-in members fall through to personal billing; guests are refused |
|    2     | Premium model, user without premium access                                                                     | Denied — premium requires the paid tier                                                                              |
|    3     | Paid user with sufficient spendable funds (cushion applies)                                                    | **User's purchased balance**; insufficient ⇒ denied                                                                  |
|    4     | Free user, basic model, sufficient daily allowance                                                             | **Free daily allowance**; insufficient ⇒ denied                                                                      |
|    5     | Link guest with no group budget                                                                                | Denied — guests never pay from their own funds                                                                       |
|    6     | Trial, estimated cost within the per-message cap                                                               | **Absorbed** (no charge); over the cap ⇒ denied                                                                      |

---

## Group Funding

1. **Owner-funded means owner-priced.** An owner-funded turn is estimated,
   reserved, and billed exactly as if the owner sent it — the payer's tier drives
   every input (ratios, cushion, premium) on client and server alike. The sender's
   own tier applies only when the sender pays.
2. **One fall-through decision.** Headroom → owner pays; exhausted → signed-in
   members fall through to personal funds; guests are always refused (no wallet,
   ever — a typed error code with shared copy).
3. **Sender and payer are first-class on every billed row** — `usage_records`
   records both, independently queryable.
4. **Membership lifecycle owns budget rows**: removing a member removes its budget
   row; owner deletion cascades conversations and budgets.
5. Owner state (tier, balance) is read fresh per turn; negative owner balance =
   zero headroom.
6. **Ruled edge cases.** (a) Pre-send exhaustion → members fall through to personal
   funds, guests refused. (b) Exhaustion discovered only at admission (race) → hard
   402, no in-admission re-resolve; the client's retry re-resolves. (c) A budget
   edit below accrued spend is validated/rejected at the edit. (d) Member removal
   deletes the member's budget row; owner deletion cascades. (e) Negative owner
   balance → zero headroom (clamped, not an error). (f) Owner tier/balance are read
   fresh per turn — never cached across turns.

---

## Balance Consumption

- Charges land on the payer's **purchased wallet**; each user also has a **free
  wallet** (always balance 0) through which the daily allowance is accounted — a
  charge against it writes a day-keyed allowance-spending row.
- The free allowance applies to **basic models only**, is day-keyed
  (`allowance_spending` unique on user+day, UTC), and never offsets a negative
  purchased balance. There are no midnight reset jobs — a new day is simply a new
  row.
- Member budgets and conversation spending are **lifetime cumulative** rows, unique
  per member / per conversation: budget = a total allowance, remaining = allowance −
  accrued spend, accrual keyed by the **sender**. Budget edits validate against
  accrued spend. No period keying, no reset jobs.

---

## Billing Flow

One flow for every turn — cost is authoritative at settlement:

1. User sends a message; the funding decision picks the funding source (matrix
   above).
2. **Admission**: one atomic Redis Lua script checks spendable snapshot − Σ holds ≥
   estimate plus budget scopes and the per-wallet concurrent-run cap, then places a
   TTL hold for the run's declared ceiling. For a persisting turn that ceiling
   includes storage — the input prompt's char-storage once at the definition level,
   plus per-node output and media storage — so admission never under-reserves
   relative to settlement. Reasoning turns reserve an effort-aware output ceiling
   (thinking budget + answer cap); the classifier reserve is held exactly when the
   turn will run a classifier (any classifier dimension: Smart Model or auto
   effort). Redis down ⇒ paid admission fails closed.
3. The run streams. OpenRouter returns the charged `usage.cost` inline for text and
   video; **the ModelProvider port converts it to billable — the only markup
   application on the money path**; image is priced by its deterministic billable
   catalog estimate.
4. **Settlement**: the single settlement transaction persists the content and calls
   `chargeWithinTx` — unguarded (negative balances are legal), charging the
   already-billable amount plus storage, writing the usage record (payer wallet
   **and sender**) + zero-sum ledger leg pair (wallet ↔ house `revenue`), advancing
   the wallet's ledger sequence, and upserting the spending rows. Saved ⟺ billed,
   by construction.
5. The `done` event carries the final cost per model entry; the hold is released
   (or expires by TTL). A run killed before settlement saves nothing and bills
   nothing; an explicit user stop settles and bills the partial.

**Reserve ≥ charge:** if a term is charged at settlement, admission reserves a
best-guess for it — media byte-storage and prompt char-storage are held because
settlement bills them — so the hold is never smaller than the eventual charge.

Domain code: `apps/api/src/slices/billing/domain/` (admission, charge, wallets,
budget-resolution, auditors) and `apps/api/src/slices/chat/domain/settlement.ts`.

---

## Fee Structure

- **Fees are baked once, at the seam.** The 15% markup exists at exactly two
  places: (1) **catalog ingestion** — normalize applies it to every provider rate
  before persisting, so the catalog stores billable (after-fee) rates only
  (descriptor `version: '2'`; readers fail fast on unbaked v1 rows); (2) **the
  ModelProvider port** — the provider's inline `usage.cost` converts to billable
  exactly once, before the cost decision. No other code applies, removes, or
  reasons about fees; an arch rule confines `applyMarkup` imports to these seams.
- Rate baking rounds **ceil** (against the user); the port's charge conversion
  rounds half-even. Raw provider cost is not retained anywhere.
- Storage fees are separate, never marked up, and already final at their defining
  constants.

Fee constants: `packages/shared/src/constants.ts`; the markup function is
`applyMarkup` in `packages/shared/src/money.ts` (exact bigint nano-USD).
`packages/shared/src/pricing.ts` retains only float display helpers for the
marketing fee breakdown.

---

## Storage Fees

Messages are charged a per-character storage fee covering long-term retention. The
money-path rates are single-sourced as exact integer nano-USD in
`packages/shared/src/estimate/storage-rate.ts` — `STORAGE_COST_PER_CHARACTER_NANO`
(300n per char) and `MEDIA_STORAGE_COST_PER_BYTE_NANO` (18n per byte). Storage is
pass-through: the estimator folds it as never-fee-bearing line items, and settlement
adds the same nano rate to the charge without markup.

The float `STORAGE_COST_PER_CHARACTER` (`packages/shared/src/constants.ts`), derived as

```
STORAGE_COST_PER_CHARACTER =
  (MONTHLY_COST_PER_GB × MONTHS_PER_YEAR × STORAGE_YEARS)
  ÷ (CHARACTERS_PER_KILOBYTE × KILOBYTES_PER_GIGABYTE)
```

is display-only; the nano rate is the billing truth.

---

## Trial Usage

Trial users (unauthenticated) can chat with limits:

- **Basic models only**, `TRIAL_MESSAGE_LIMIT` messages per day, no persistence
- Per-message cost cap: `MAX_TRIAL_MESSAGE_COST_CENTS` (1¢) — a message estimated
  above it is denied. Trial turns support the effort classifier: its ~0.1¢
  worst-case reserve fits inside the cap, priced by the same math as paid turns.

Identity and quota tracking (`apps/api/src/slices/chat/domain/trial-quota.ts`,
`apps/api/src/slices/identity/domain/trial-session.ts`):

- The client sends an `x-trial-token` (uuid kept in localStorage), resolved to an
  ephemeral **trial-session principal** — never persisted server-side
- **Dual-identity quota**: a per-session counter and a per-IP counter (SHA-256 IP
  hash) both increment in Redis; the **higher** of the two is compared against the
  limit, so clearing localStorage doesn't reset the quota
- Counters expire at the next UTC midnight; Redis down fails closed
- A **global day-keyed trial spend cap** (`TRIAL_DAILY_SPEND_CAP_NANO_USD`, $50/day)
  bounds aggregate trial provider spend — the Sybil backstop. It is a
  read-and-compare admission gate over one Redis counter fed with actual cost at
  settlement; there is no reservation (a small burst can overshoot, bounded by the
  per-message cap — deliberate). The single increment that crosses the cap fires
  one Sentry alert. Redis down fails closed
- Trial settlement persists and bills nothing; only the global spend counter is fed

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
| Fee rate & money math   | `packages/shared/src/constants.ts`, `packages/shared/src/money.ts`                          |
| Canonical estimator     | `packages/shared/src/estimate/`                                                             |
| Storage costs           | `packages/shared/src/estimate/storage-rate.ts`, `packages/shared/src/constants.ts`          |
| Tier logic & constants  | `packages/shared/src/tiers.ts`                                                              |
| Funding decision        | `packages/shared/src/billing/funding-decision.ts` (client wrapper: `billing/client-billing.ts`) |
| Model classification    | `packages/shared/src/models/premium-check.ts`                                               |
| Effort ladder & budgets | `packages/shared/src/reasoning-effort.ts`, `packages/shared/src/estimate/reasoning-plan.ts` |
| Welcome credit          | `packages/shared/src/tiers.ts` (granted in `apps/api/src/slices/billing/domain/wallets.ts`) |
| Trial limits            | `packages/shared/src/tiers.ts`, `packages/shared/src/constants.ts`                          |
| Trial global spend cap  | `apps/api/src/slices/billing/domain/constants.ts`                                           |
| Budget scopes           | `apps/api/src/slices/billing/domain/budget-resolution.ts`                                   |
| Payment schema & states | `packages/db/src/schema/payments.ts`, `packages/db/src/schema/enums.ts`                     |
| Wallets                 | `packages/db/src/schema/wallets.ts`                                                         |
| Ledger entries          | `packages/db/src/schema/ledger-entries.ts`                                                  |
| Allowance spending      | `packages/db/src/schema/allowance-spending.ts`                                              |
| Member budgets          | `packages/db/src/schema/member-budgets.ts`                                                  |
| Conversation spending   | `packages/db/src/schema/conversation-spending.ts`                                           |
